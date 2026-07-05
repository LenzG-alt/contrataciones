"""
batch_layout.py
================
Job OFFLINE que precalcula todo lo "pesado" del Grafo de Relaciones
(sección 2.5 de la especificación PUCI) para que el backend jamás tenga
que recalcular layout ni comunidades en un request HTTP.

Por qué igraph y no NetworKit/graph-tool
-----------------------------------------
NetworKit y graph-tool son excelentes pero requieren compilación nativa
pesada (o conda) que no siempre es viable en todos los entornos de
despliegue. `python-igraph` instala con wheel binario precompilado en
Linux/Mac/Windows (sin compilar nada) y da:
  - community_multilevel()  -> Louvain, en C, muy rápido.
  - layout_drl()            -> "Distributed Recursive Layout", diseñado
                                específicamente por su autor (Martin) para
                                grafos de decenas/cientos de miles de nodos,
                                mucho más estable que spring_layout de
                                networkx a esa escala.
Si más adelante el volumen de ENTIDADES (no de contratos) supera varios
cientos de miles de nodos, sí conviene migrar a NetworKit con Louvain
paralelo (PLM) + ForceAtlas2 en GPU. Con contratos en el orden de 60.000,
el número de entidades únicas (compradores + proveedores) suele ser un
orden de magnitud menor, así que igraph alcanza sobrado.

Qué NO se precalcula aquí (a propósito)
----------------------------------------
Los montos/aristas agregados que ve el auditor SÍ deben reflejar los
filtros globales activos (departamento, rango de fechas, perfil de riesgo,
etc.). Precalcular esos agregados una sola vez congelaría el dashboard a
la vista "sin filtros". Por eso este batch guarda SOLO lo que es estable
sin importar el filtro:
  - Posición (x, y) de cada entidad.
  - Comunidad (Louvain) de cada entidad.
  - Celda de grilla (índice espacial) de cada entidad.
  - La estructura de adyacencia (quién puede conectar con quién), usada
    para el ego-network de doble clic.
Los montos/aristas agregados se recalculan en el backend con un
groupby de pandas sobre el subconjunto YA filtrado (rápido incluso a
60.000 filas, del orden de milisegundos) y luego se les pega encima la
posición/comunidad ya calculada aquí. Ver backend.py -> get_graph().

Salida (graph_cache/):
  nodes.parquet    id, tipo, dept, x, y, cell_row, cell_col, community
  edges.parquet    source, target   (estructura, SIN montos: los montos
                                      se recalculan en vivo)
  meta.json        grid config, nº comunidades, timestamp, etc.

Uso:
    python batch_layout.py --input parquet/adjudicaciones_2025_efficiency.parquet
    python batch_layout.py --synthetic 60000   # genera datos de prueba
"""

import argparse
import json
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

try:
    import igraph as ig
except ImportError as e:
    raise SystemExit(
        "Falta python-igraph. Instalar con: pip install python-igraph"
    ) from e

GRID_SIZE = 48  # nº de celdas por eje del índice espacial (48x48 = 2304 celdas)


# =============================================================================
# 1. Generación de datos sintéticos (solo para poder probar el pipeline
#    sin el parquet real de producción)
# =============================================================================

def generate_synthetic(n_contracts: int, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    n_buyers = max(50, n_contracts // 40)
    n_suppliers = max(80, n_contracts // 25)
    departments = [
        "LIMA", "AREQUIPA", "CUSCO", "LORETO", "PUNO", "LA LIBERTAD",
        "PIURA", "JUNIN", "ANCASH", "CAJAMARCA", "SAN MARTIN", "UCAYALI",
    ]
    buyer_dept = rng.choice(departments, size=n_buyers)
    buyer_ids = [f"B{i:06d}" for i in range(n_buyers)]
    supplier_ids = [f"S{i:06d}" for i in range(n_suppliers)]

    # Estructura de mercado no uniforme: unos pocos proveedores concentran
    # muchísimos contratos con pocos compradores (para que el grafo tenga
    # comunidades / "islas" reales y no sea ruido puro).
    supplier_weights = rng.pareto(a=1.5, size=n_suppliers) + 0.1
    supplier_weights /= supplier_weights.sum()

    buyer_idx = rng.integers(0, n_buyers, size=n_contracts)
    supplier_idx = rng.choice(n_suppliers, size=n_contracts, p=supplier_weights)

    tender_amount = np.round(rng.lognormal(mean=11.5, sigma=1.3, size=n_contracts), 2)
    n_tenderers = rng.choice([1, 1, 1, 2, 3, 4, 5, 6, 8, 12], size=n_contracts)
    month = rng.integers(1, 13, size=n_contracts)

    df = pd.DataFrame({
        "contract_id": [f"C{i:07d}" for i in range(n_contracts)],
        "buyer_id": np.array(buyer_ids)[buyer_idx],
        "buyer_name": [f"Municipalidad {b}" for b in np.array(buyer_ids)[buyer_idx]],
        "department": buyer_dept[buyer_idx],
        "supplier_id": np.array(supplier_ids)[supplier_idx],
        "supplier_name": [f"Proveedor {s}" for s in np.array(supplier_ids)[supplier_idx]],
        "tender_amount": tender_amount,
        "number_of_tenderers": n_tenderers,
        "competition_level": np.where(n_tenderers == 1, 0, 1),
        "procurement_type": rng.choice(["AS", "LP", "CD", "SUB"], size=n_contracts),
        "saving_class": rng.choice([0, 1], size=n_contracts, p=[0.35, 0.65]),
        "saving_pct": rng.normal(0.08, 0.15, size=n_contracts),
        "is_end_of_year": (month >= 11).astype(int),
        "month": month,
        "has_signed": rng.choice([0, 1], size=n_contracts, p=[0.12, 0.88]),
        "has_item_detail": rng.choice([0, 1], size=n_contracts, p=[0.1, 0.9]),
        "is_large_procurement": (tender_amount > np.quantile(tender_amount, 0.85)).astype(int),
    })
    return df


# =============================================================================
# 2. Construcción del grafo global (SIN muestreo: todas las filas)
# =============================================================================

def build_entity_edges(df: pd.DataFrame) -> pd.DataFrame:
    """Agrega TODOS los contratos por par (comprador, proveedor). Esta
    agregación es SOLO para dar peso a la comunidad/layout; los montos
    reales que ve el auditor se recalculan en vivo en el backend."""
    clean = df.dropna(subset=["buyer_id", "supplier_id"])
    clean = clean[clean["buyer_id"] != clean["supplier_id"]]
    agg = clean.groupby(["buyer_id", "supplier_id"], as_index=False).agg(
        total_monto=("tender_amount", "sum"),
        n_contratos=("tender_amount", "size"),
    )
    return agg


def build_node_table(df: pd.DataFrame) -> pd.DataFrame:
    buyers = df[["buyer_id", "buyer_name", "department"]].dropna(subset=["buyer_id"]).drop_duplicates("buyer_id")
    buyers = buyers.rename(columns={"buyer_id": "id", "buyer_name": "label"})
    buyers["tipo"] = "comprador"
    buyers["dept"] = buyers["department"]

    suppliers = df[["supplier_id", "supplier_name"]].dropna(subset=["supplier_id"]).drop_duplicates("supplier_id")
    suppliers = suppliers.rename(columns={"supplier_id": "id", "supplier_name": "label"})
    suppliers["tipo"] = "proveedor"
    suppliers["dept"] = ""

    nodes = pd.concat([
        buyers[["id", "label", "tipo", "dept"]],
        suppliers[["id", "label", "tipo", "dept"]],
    ], ignore_index=True).drop_duplicates("id")
    return nodes


# =============================================================================
# 3. Layout + comunidades con igraph
# =============================================================================

def compute_layout_and_communities(nodes: pd.DataFrame, edges: pd.DataFrame):
    id_to_idx = {nid: i for i, nid in enumerate(nodes["id"])}
    edge_tuples = [(id_to_idx[u], id_to_idx[v]) for u, v in zip(edges["buyer_id"], edges["supplier_id"])]

    g = ig.Graph(n=len(nodes), edges=edge_tuples, directed=False)
    g.es["weight"] = edges["total_monto"].clip(lower=1.0).tolist()

    t0 = time.time()
    n_nodes = g.vcount()
    print(f"  Grafo: {n_nodes:,} nodos, {g.ecount():,} aristas (estructura única, sin duplicar por contrato)")

    # --- Comunidades (Louvain) ---
    partition = g.community_multilevel(weights="weight")
    membership = partition.membership
    print(f"  Louvain: {len(partition)} comunidades, modularidad={partition.modularity:.4f} "
          f"({time.time() - t0:.1f}s)")

    # --- Layout ---
    t1 = time.time()
    if n_nodes > 1500:
        # DRL: pensado por igraph para grafos grandes; con >1500 nodos
        # spring/FR empieza a degradar mucho más que DRL.
        layout = g.layout_drl(weights="weight")
        layout_name = "drl"
    else:
        layout = g.layout_fruchterman_reingold(weights="weight")
        layout_name = "fruchterman_reingold"
    coords = np.array(layout.coords)
    print(f"  Layout '{layout_name}' calculado en {time.time() - t1:.1f}s")

    return membership, coords


# =============================================================================
# 4. Índice espacial de grilla (más simple y liviano que un R-tree para
#    este caso de uso: bounding-box queries de viewport en un dashboard)
# =============================================================================

def assign_grid_cells(x: np.ndarray, y: np.ndarray, grid_size: int = GRID_SIZE):
    xmin, xmax = float(x.min()), float(x.max())
    ymin, ymax = float(y.min()), float(y.max())
    xr = (xmax - xmin) or 1.0
    yr = (ymax - ymin) or 1.0
    col = np.clip(((x - xmin) / xr * grid_size).astype(int), 0, grid_size - 1)
    row = np.clip(((y - ymin) / yr * grid_size).astype(int), 0, grid_size - 1)
    bounds = {"xmin": xmin, "xmax": xmax, "ymin": ymin, "ymax": ymax, "grid_size": grid_size}
    return row, col, bounds


# =============================================================================
# 5. Main
# =============================================================================

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="parquet/adjudicaciones_2025_efficiency.parquet")
    ap.add_argument("--output-dir", default="graph_cache")
    ap.add_argument("--synthetic", type=int, default=0,
                     help="Si se pasa un N > 0, ignora --input y genera N contratos sintéticos (para pruebas)")
    args = ap.parse_args()

    import os
    os.makedirs(args.output_dir, exist_ok=True)

    print("=" * 70)
    if args.synthetic:
        print(f"[SINTÉTICO] Generando {args.synthetic:,} contratos de prueba...")
        df = generate_synthetic(args.synthetic)
    else:
        print(f"Cargando dataset real: {args.input}")
        df = pd.read_parquet(args.input)
    print(f"Dataset: {len(df):,} contratos")

    print("-" * 70)
    print("1/4 Construyendo tabla de nodos (entidades únicas)...")
    nodes = build_node_table(df)
    print(f"    {len(nodes):,} entidades únicas ({(nodes['tipo'] == 'comprador').sum():,} compradoras, "
          f"{(nodes['tipo'] == 'proveedor').sum():,} proveedoras)")

    print("2/4 Agregando aristas comprador-proveedor (estructura global)...")
    edge_agg = build_entity_edges(df)
    print(f"    {len(edge_agg):,} pares únicos comprador-proveedor")

    # Nodos sin ninguna arista no aportan al grafo relacional; se excluyen
    # (igual que antes con G.remove_nodes_from(nx.isolates(G))).
    connected_ids = set(edge_agg["buyer_id"]) | set(edge_agg["supplier_id"])
    nodes = nodes[nodes["id"].isin(connected_ids)].reset_index(drop=True)
    print(f"    {len(nodes):,} entidades quedan tras remover nodos aislados")

    print("3/4 Calculando comunidades (Louvain) y layout (igraph)...")
    membership, coords = compute_layout_and_communities(nodes, edge_agg)
    nodes["community"] = membership
    nodes["x"] = coords[:, 0]
    nodes["y"] = coords[:, 1]

    print("4/4 Construyendo índice espacial de grilla...")
    row, col, bounds = assign_grid_cells(nodes["x"].to_numpy(), nodes["y"].to_numpy())
    nodes["cell_row"] = row
    nodes["cell_col"] = col
    nodes["cell_id"] = [f"{r}_{c}" for r, c in zip(row, col)]

    # La tabla de aristas que se persiste es SOLO estructura (source,
    # target) + comunidad de cada extremo, para que el backend pueda
    # decidir rápidamente si una arista es intra-comunidad o cruza
    # comunidades sin tener que hacer joins pesados en cada request.
    comm_by_id = dict(zip(nodes["id"], nodes["community"]))
    cell_by_id = dict(zip(nodes["id"], nodes["cell_id"]))
    edges_out = edge_agg[["buyer_id", "supplier_id"]].rename(
        columns={"buyer_id": "source", "supplier_id": "target"})
    edges_out = edges_out[edges_out["source"].isin(comm_by_id) & edges_out["target"].isin(comm_by_id)]
    edges_out["community_source"] = edges_out["source"].map(comm_by_id)
    edges_out["community_target"] = edges_out["target"].map(comm_by_id)
    edges_out["cell_source"] = edges_out["source"].map(cell_by_id)
    edges_out["cell_target"] = edges_out["target"].map(cell_by_id)

    out_nodes_path = f"{args.output_dir}/nodes.parquet"
    out_edges_path = f"{args.output_dir}/edges.parquet"
    out_meta_path = f"{args.output_dir}/meta.json"

    nodes.to_parquet(out_nodes_path, index=False)
    edges_out.to_parquet(out_edges_path, index=False)

    meta = {
        "computed_at": datetime.now(timezone.utc).isoformat(),
        "n_contracts_source": int(len(df)),
        "n_nodes": int(len(nodes)),
        "n_edges": int(len(edges_out)),
        "n_communities": int(nodes["community"].nunique()),
        "grid_bounds": bounds,
        "layout_engine": "igraph",
    }
    with open(out_meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    print("-" * 70)
    print(f"OK -> {out_nodes_path}, {out_edges_path}, {out_meta_path}")
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()