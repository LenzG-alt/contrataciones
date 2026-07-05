"""
graph_engine.py
================
Motor de consulta EN VIVO para el Grafo de Relaciones (sección 2.5).

Separación de responsabilidades (la recomendación central de la
arquitectura híbrida):

  ESTABLE / PRECALCULADO por batch_layout.py (no cambia con los filtros):
    - Posición (x, y) de cada entidad.
    - Comunidad Louvain de cada entidad.
    - Celda de grilla (índice espacial) de cada entidad.
    - Estructura de adyacencia (para ego-network).

  EN VIVO / recalculado en cada request (SÍ cambia con los filtros,
  porque el auditor necesita que los montos reflejen su filtro activo):
    - Montos y nº de contratos agregados por arista/nodo.
    - Riesgo promedio/máximo, método de contratación dominante.
    - Qué nodos/aristas están "activos" según el filtro global.

Esto es lo que permite tener latencia baja (nunca se recalcula layout
en un request) sin sacrificar exactitud (los números que ve el auditor
sí son los del subconjunto filtrado, no un agregado congelado).
"""

import json
import os
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

import numpy as np
import pandas as pd


class GraphCacheMissing(Exception):
    pass


class GraphEngine:
    def __init__(self, cache_dir: str = "graph_cache"):
        self.cache_dir = cache_dir
        self.ready = False
        self.nodes_df: Optional[pd.DataFrame] = None
        self.edges_df: Optional[pd.DataFrame] = None
        self.meta: dict = {}
        self.adjacency: Dict[str, Set[str]] = defaultdict(set)
        self._load()

    # -------------------------------------------------------------------
    def _load(self):
        nodes_path = os.path.join(self.cache_dir, "nodes.parquet")
        edges_path = os.path.join(self.cache_dir, "edges.parquet")
        meta_path = os.path.join(self.cache_dir, "meta.json")

        if not (os.path.exists(nodes_path) and os.path.exists(edges_path)):
            print(f"[graph_engine] No se encontró cache en '{self.cache_dir}/'. "
                  f"Corré 'python batch_layout.py' antes de levantar el backend. "
                  f"El endpoint /api/graph devolverá 503 hasta entonces.")
            return

        self.nodes_df = pd.read_parquet(nodes_path).set_index("id", drop=False)
        self.edges_df = pd.read_parquet(edges_path)
        if os.path.exists(meta_path):
            with open(meta_path, "r", encoding="utf-8") as f:
                self.meta = json.load(f)

        for u, v in zip(self.edges_df["source"], self.edges_df["target"]):
            self.adjacency[u].add(v)
            self.adjacency[v].add(u)

        self.ready = True
        print(f"[graph_engine] Cache cargado: {len(self.nodes_df):,} nodos, "
              f"{len(self.edges_df):,} aristas, {self.meta.get('n_communities', '?')} comunidades "
              f"(calculado {self.meta.get('computed_at', '?')})")

    def reload(self):
        """Permite recargar el cache sin reiniciar el proceso, por si se
        vuelve a correr batch_layout.py con datos nuevos."""
        self.adjacency = defaultdict(set)
        self._load()

    # -------------------------------------------------------------------
    # Utilidades de filtrado en vivo
    # -------------------------------------------------------------------

    @staticmethod
    def active_entity_ids(filtered_df: pd.DataFrame) -> Set[str]:
        """IDs de entidades (comprador o proveedor) presentes en el
        subconjunto YA filtrado por los filtros globales."""
        ids = set()
        if "buyer_id" in filtered_df.columns:
            ids |= set(filtered_df["buyer_id"].dropna().astype(str))
        if "supplier_id" in filtered_df.columns:
            ids |= set(filtered_df["supplier_id"].dropna().astype(str))
        return ids

    @staticmethod
    def live_edge_stats(filtered_df: pd.DataFrame, min_edge_amount: float = 0.0) -> pd.DataFrame:
        """Agrega SOLO el subconjunto ya filtrado por par (comprador,
        proveedor). Esto es lo que reemplaza al loop Python del
        build_graph() anterior; con pandas vectorizado, agregar 60.000
        filas toma milisegundos, muy lejos de ser el cuello de botella
        (el cuello de botella era el layout, que ya no se recalcula)."""
        clean = filtered_df.dropna(subset=["buyer_id", "supplier_id"])
        clean = clean[clean["buyer_id"] != clean["supplier_id"]]
        if clean.empty:
            return pd.DataFrame(columns=[
                "source", "target", "total_monto", "n_contratos",
                "metodo", "avg_riesgo", "max_riesgo", "saving_class",
            ])

        grouped = clean.groupby(["buyer_id", "supplier_id"]).agg(
            total_monto=("tender_amount", "sum"),
            n_contratos=("tender_amount", "size"),
            avg_riesgo=("risk_score", "mean"),
            max_riesgo=("risk_score", "max"),
            saving_class=("saving_class", "max"),
        ).reset_index()

        # [PERF] Método de contratación dominante por par, vectorizado.
        # ANTES: groupby(...).apply(lambda s: s.value_counts().index[0]) —
        # esto ejecuta una función Python + un value_counts() POR CADA grupo
        # (~3.900 grupos con 60.000 contratos reales), lo que tardaba del
        # orden de 10+ segundos en la primera consulta sin filtros. Un
        # groupby.size() + sort + drop_duplicates logra lo mismo íntegramente
        # con operaciones vectorizadas de pandas (decenas de milisegundos).
        metodo_counts = (
            clean.groupby(["buyer_id", "supplier_id", "procurement_type"])
            .size()
            .reset_index(name="cnt")
            .sort_values("cnt", ascending=False)
            .drop_duplicates(["buyer_id", "supplier_id"])
        )
        metodo_map = metodo_counts.rename(columns={"procurement_type": "metodo"})[
            ["buyer_id", "supplier_id", "metodo"]
        ]
        grouped = grouped.merge(metodo_map, on=["buyer_id", "supplier_id"], how="left")
        grouped["metodo"] = grouped["metodo"].fillna("N/D")
        grouped = grouped.rename(columns={"buyer_id": "source", "supplier_id": "target"})
        grouped = grouped[grouped["total_monto"] >= min_edge_amount]
        return grouped

    # -------------------------------------------------------------------
    # Ensamblado: pega los agregados en vivo sobre la posición/comunidad
    # precalculada
    # -------------------------------------------------------------------

    def _nodes_with_live_stats(self, active_ids: Set[str], edge_stats: pd.DataFrame) -> pd.DataFrame:
        # [PERF] Vectorizado con pandas en vez de un loop Python (itertuples)
        # acumulando en diccionarios: con hasta ~50.000 aristas ese loop es
        # el tipo de operación que en Python puro empieza a notarse. Apilar
        # (source,...) y (target,...) y hacer un solo groupby por "id" logra
        # lo mismo sin loop explícito.
        if edge_stats.empty:
            base = self.nodes_df[self.nodes_df["id"].isin(active_ids)].copy()
            base["total_monto"] = 0.0
            base["n_contratos"] = 0
            base["avg_riesgo"] = 0.0
            return base.iloc[0:0]  # sin aristas, no hay nodos "activos" que mostrar

        side_a = edge_stats.rename(columns={"source": "id"})[["id", "total_monto", "n_contratos", "avg_riesgo"]]
        side_b = edge_stats.rename(columns={"target": "id"})[["id", "total_monto", "n_contratos", "avg_riesgo"]]
        stacked = pd.concat([side_a, side_b], ignore_index=True)
        per_node = stacked.groupby("id").agg(
            total_monto=("total_monto", "sum"),
            n_contratos=("n_contratos", "sum"),
            avg_riesgo=("avg_riesgo", "mean"),
        ).reset_index()

        base = self.nodes_df[self.nodes_df["id"].isin(active_ids)].reset_index(drop=True)
        base = base.merge(per_node, on="id", how="inner")  # inner: descarta nodos sin ninguna arista sobreviviente
        return base

    # -------------------------------------------------------------------
    # Vista MACRO: agrega por (celda espacial × comunidad)
    # -------------------------------------------------------------------

    # [DECISIÓN DE DISEÑO] La vista macro agrupa SOLO por comunidad Louvain,
    # no por celda espacial. Se probó celda×comunidad (más "fiel" a la
    # posición 2D) y con ~3.800 entidades y 36 comunidades el cruce con una
    # grilla, incluso gruesa, generaba ~1.000 grupos: no resumía nada, casi
    # 1 a 1 con las entidades. La comunidad SOLA sí es la unidad de resumen
    # correcta: son las "islas" que pide la sección 2.1 de la especificación,
    # y coincide con el color que el auditor ya usa para leer el grafo.
    # Si en producción una comunidad resulta gigantesca y muy dispersa
    # espacialmente (raro, pero posible con datasets reales grandes), el
    # siguiente paso natural es sub-dividir esa comunidad en particular por
    # celda; no hace falta esa complejidad para el volumen actual.
    def macro_view(self, active_ids: Set[str], edge_stats: pd.DataFrame) -> dict:
        nodes = self._nodes_with_live_stats(active_ids, edge_stats)
        if nodes.empty:
            return {"lod": "macro", "nodes": [], "edges": [], "meta": {}}

        group_key = ["community"]
        macro = nodes.groupby(group_key).agg(
            x=("x", "mean"), y=("y", "mean"),
            total_monto=("total_monto", "sum"), n_contratos=("n_contratos", "sum"),
            avg_riesgo=("avg_riesgo", "mean"), n_entidades=("id", "size"),
        ).reset_index()
        # tipo/dept dominante por macronodo (para poder colorear por "tipo")
        dom = nodes.groupby(group_key).agg(
            tipo_dominante=("tipo", lambda s: s.value_counts().index[0]),
            dept_dominante=("dept", lambda s: s[s != ""].value_counts().index[0] if (s != "").any() else ""),
        ).reset_index()
        macro = macro.merge(dom, on=group_key)
        macro["macro_id"] = "comm_" + macro["community"].astype(str)

        # mapa id_entidad -> macro_id, para poder agregar aristas entre macronodos
        node_to_macro = dict(zip(nodes["id"], "comm_" + nodes["community"].astype(str)))

        edges_mapped = edge_stats.copy()
        edges_mapped["macro_source"] = edges_mapped["source"].map(node_to_macro)
        edges_mapped["macro_target"] = edges_mapped["target"].map(node_to_macro)
        edges_mapped = edges_mapped.dropna(subset=["macro_source", "macro_target"])
        edges_mapped = edges_mapped[edges_mapped["macro_source"] != edges_mapped["macro_target"]]

        if not edges_mapped.empty:
            # normalizar el par para no duplicar A-B / B-A
            pair = edges_mapped.apply(
                lambda r: tuple(sorted((r["macro_source"], r["macro_target"]))), axis=1)
            edges_mapped["pair"] = pair
            macro_edges = edges_mapped.groupby("pair").agg(
                total_monto=("total_monto", "sum"), n_contratos=("n_contratos", "sum"),
            ).reset_index()
            macro_edges["source"] = macro_edges["pair"].apply(lambda p: p[0])
            macro_edges["target"] = macro_edges["pair"].apply(lambda p: p[1])
        else:
            macro_edges = pd.DataFrame(columns=["source", "target", "total_monto", "n_contratos"])

        nodes_out = [{
            "id": row["macro_id"], "is_macro": True, "n_entidades": int(row["n_entidades"]),
            "tipo": row["tipo_dominante"], "dept": row["dept_dominante"],
            "x": float(row["x"]), "y": float(row["y"]),
            "comunidad": int(row["community"]),
            "total_monto": float(row["total_monto"]), "n_contratos": int(row["n_contratos"]),
            "avg_riesgo": float(row["avg_riesgo"]),
            "label": f"{int(row['n_entidades'])} entidades ({row['dept_dominante'] or row['tipo_dominante']})",
        } for _, row in macro.iterrows()]

        node_xy = {row["macro_id"]: (row["x"], row["y"]) for _, row in macro.iterrows()}
        edges_out = [{
            "source": row["source"], "target": row["target"],
            "source_x": node_xy[row["source"]][0], "source_y": node_xy[row["source"]][1],
            "target_x": node_xy[row["target"]][0], "target_y": node_xy[row["target"]][1],
            "total_monto": float(row["total_monto"]), "n_contratos": int(row["n_contratos"]),
            "is_macro": True,
        } for _, row in macro_edges.iterrows() if row["source"] in node_xy and row["target"] in node_xy]

        return {
            "lod": "macro",
            "nodes": nodes_out,
            "edges": edges_out,
            "meta": self._basic_meta(nodes, edge_stats),
        }

    # -------------------------------------------------------------------
    # Vista MICRO: nodos/aristas reales dentro de un bounding box
    # -------------------------------------------------------------------

    def micro_view(self, active_ids: Set[str], edge_stats: pd.DataFrame,
                    bbox: Optional[Tuple[float, float, float, float]] = None,
                    community: Optional[int] = None) -> dict:
        nodes = self._nodes_with_live_stats(active_ids, edge_stats)
        if community is not None:
            nodes = nodes[nodes["community"] == community]
        if bbox is not None:
            xmin, ymin, xmax, ymax = bbox
            nodes = nodes[(nodes["x"] >= xmin) & (nodes["x"] <= xmax) &
                          (nodes["y"] >= ymin) & (nodes["y"] <= ymax)]
        if nodes.empty:
            return {"lod": "micro", "nodes": [], "edges": [], "meta": {}}

        visible_ids = set(nodes["id"])
        edges_visible = edge_stats[edge_stats["source"].isin(visible_ids) & edge_stats["target"].isin(visible_ids)]

        node_xy = dict(zip(nodes["id"], zip(nodes["x"], nodes["y"])))
        nodes_out = [{
            "id": row["id"], "is_macro": False, "label": row["label"], "tipo": row["tipo"], "dept": row["dept"],
            "x": float(row["x"]), "y": float(row["y"]), "comunidad": int(row["community"]),
            "total_monto": float(row["total_monto"]), "n_contratos": int(row["n_contratos"]),
            "avg_riesgo": float(row["avg_riesgo"]),
        } for _, row in nodes.iterrows()]

        edges_out = [{
            "source": row.source, "target": row.target,
            "source_x": node_xy[row.source][0], "source_y": node_xy[row.source][1],
            "target_x": node_xy[row.target][0], "target_y": node_xy[row.target][1],
            "total_monto": float(row.total_monto), "n_contratos": int(row.n_contratos),
            "metodo": row.metodo, "avg_riesgo": float(row.avg_riesgo), "max_riesgo": float(row.max_riesgo),
            "saving_class": int(row.saving_class), "is_macro": False,
        } for row in edges_visible.itertuples()]

        return {
            "lod": "micro",
            "nodes": nodes_out,
            "edges": edges_out,
            "meta": self._basic_meta(nodes, edges_visible),
        }

    # -------------------------------------------------------------------
    # Ego-network (búsqueda de nodo + doble clic, sección 2.5)
    # -------------------------------------------------------------------

    def ego_network(self, focus_label_or_id: str, active_ids: Set[str],
                     edge_stats: pd.DataFrame, depth: int = 1) -> dict:
        focus_upper = focus_label_or_id.strip().upper()
        candidates = self.nodes_df[self.nodes_df["id"].isin(active_ids)]
        match = candidates[
            (candidates["id"].str.upper() == focus_upper) |
            (candidates["label"].str.upper() == focus_upper)
        ]
        if match.empty:
            # búsqueda parcial como respaldo
            match = candidates[candidates["label"].str.upper().str.contains(focus_upper, na=False)]
        if match.empty:
            return {"lod": "micro", "nodes": [], "edges": [], "meta": {}, "focus_node_id": None}

        focus_id = match.iloc[0]["id"]
        keep = {focus_id}
        frontier = {focus_id}
        for _ in range(max(1, depth)):
            next_frontier = set()
            for n in frontier:
                next_frontier |= (self.adjacency.get(n, set()) & active_ids)
            keep |= next_frontier
            frontier = next_frontier

        result = self.micro_view(keep, edge_stats, bbox=None)
        result["focus_node_id"] = focus_id
        for n in result["nodes"]:
            n["is_focus"] = (n["id"] == focus_id)
        return result

    # -------------------------------------------------------------------
    def _basic_meta(self, nodes: pd.DataFrame, edges: pd.DataFrame) -> dict:
        n_compradores = int((nodes["tipo"] == "comprador").sum()) if "tipo" in nodes.columns else 0
        n_proveedores = int((nodes["tipo"] == "proveedor").sum()) if "tipo" in nodes.columns else 0
        n_comunidades = int(nodes["community"].nunique()) if "community" in nodes.columns and len(nodes) else 0
        return {
            "n_compradores": n_compradores,
            "n_proveedores": n_proveedores,
            "n_aristas": int(len(edges)),
            "n_comunidades": n_comunidades,
            "monto_total": float(edges["total_monto"].sum()) if "total_monto" in edges.columns and len(edges) else 0.0,
            "cache_meta": {
                "n_nodes_global": self.meta.get("n_nodes"),
                "n_edges_global": self.meta.get("n_edges"),
                "n_communities_global": self.meta.get("n_communities"),
                "computed_at": self.meta.get("computed_at"),
            },
        }

    # -------------------------------------------------------------------
    def grid_bounds(self) -> dict:
        return self.meta.get("grid_bounds", {})