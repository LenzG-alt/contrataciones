"""
Panel Único de Control Integrado (PUCI) - API Backend
======================================================
Reescritura orientada a cumplir la "Especificación de Interactividad y
Funcionalidad Detallada v3.0" de la CGR.

Cambios principales respecto a la versión anterior (ver comentarios inline
marcados con [NUEVO] o [FIX]):

  [FIX]   apply_filters ahora soporta lógica OR para el perfil "Papeles
          Incompletos" y un parámetro `profile` que aplica los 3 botones
          de acceso rápido de la barra de filtros (sección 2.1).
  [FIX]   build_graph ya no referencia una columna "riesgo_score" inexistente;
          usa la columna real `risk_score` (IRC a nivel de contrato) generada
          en categorizar.py.
  [NUEVO] /api/search/suggest      -> autocompletado de la barra de búsqueda.
  [NUEVO] /api/map                 -> ahora devuelve el IRC compuesto y su
                                       desglose (sin competencia / sobrecostos
                                       / fin de año) para el tooltip (2.2).
  [NUEVO] /api/treemap              -> jerarquía Región > Entidad > Tipo de
                                       procedimiento con drill-down (2.3).
  [NUEVO] /api/temporal             -> serie mensual monto vs ahorro,
                                       soporta el "brush" temporal (2.4).
  [NUEVO] /api/graph  (ampliado)    -> parámetro `focus` (ego-network),
                                       `min_edge_amount` (slider de monto,
                                       independiente del filtro global).
  [NUEVO] /api/contract/{id}        -> ficha completa + alertas disparadas
                                       para el panel lateral (2.7).
  [NUEVO] /api/group  (POST)        -> "Agrupar seleccionados" de la tabla (2.6).
  [NUEVO] /api/export/report (POST) -> genera el PDF de evidencia preliminar.
  [NUEVO] /api/filters/options      -> incluye regiones y metadatos de los
                                       3 perfiles de riesgo (evita hardcodear
                                       umbrales en el frontend).
"""

import base64
import hashlib
import json
import os
import uuid
from collections import defaultdict
from datetime import datetime
from typing import List, Optional

import numpy as np
import pandas as pd
import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from fastapi.responses import FileResponse

from graph_engine import GraphEngine

# [ARQUITECTURA] networkx/community-louvain ya NO se usan en el request path.
# El layout y las comunidades se precalculan UNA sola vez con
# `python batch_layout.py` (usa igraph, ver ese archivo) y se cargan aquí
# como cache de solo lectura. graph_engine.py agrega en vivo (pandas,
# rápido) los montos/aristas del subconjunto filtrado y les pega encima
# la posición/comunidad ya calculada. Ver sección 6 más abajo.

# =============================================================================
# 1. CARGAR DATOS AL INICIAR (en memoria)
# =============================================================================

print("Cargando dataset...")
df = pd.read_parquet("parquet/adjudicaciones_2025_efficiency.parquet")
print(f"Dataset cargado: {len(df):,} filas, {len(df.columns)} columnas")

for date_col in ["award_date", "tender_date_published", "date_signed"]:
    if date_col in df.columns:
        df[date_col] = pd.to_datetime(df[date_col], errors="coerce")

# risk_score es requerido por /api/map y /api/graph. Si el parquet todavía
# no fue regenerado con el categorizar.py corregido, lo calculamos al vuelo
# para que el backend no truene (pero lo ideal es re-correr el pipeline).
if "risk_score" not in df.columns:
    print("[WARN] 'risk_score' no está en el parquet. Calculándolo al vuelo. "
          "Recomendado: re-ejecutar categorizar.py actualizado.")
    df["risk_score"] = (
        35 * (df["competition_level"] == 0).astype(int)
        + 30 * (df["saving_class"] == 0).astype(int)
        + 20 * df["is_end_of_year"].fillna(0).astype(int)
        + 15 * (((df["has_signed"] == 0) | (df["has_item_detail"] == 0)).astype(int))
    ).astype(float)

# Identificador único de fila estable para usar en la tabla / panel lateral
# (contract_id puede tener nulos; garantizamos una clave siempre disponible).
if "contract_id" in df.columns:
    df["row_uid"] = np.where(
        df["contract_id"].notna(),
        df["contract_id"].astype(str),
        "row_" + df.index.astype(str),
    )
else:
    df["row_uid"] = "row_" + df.index.astype(str)

graph_engine = GraphEngine(cache_dir=os.environ.get("GRAPH_CACHE_DIR", "graph_cache"))
if not graph_engine.ready:
    print("[WARN] /api/graph estará deshabilitado (503) hasta correr batch_layout.py")

# =============================================================================
# 2. CONFIGURAR APLICACIÓN FASTAPI
# =============================================================================

app = FastAPI(title="Panel Único de Control - API", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

os.makedirs("static/reports", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/public", StaticFiles(directory="public"), name="public")

# =============================================================================
# 3. CACHÉ PARA GRAFOS
# =============================================================================

graph_cache = {}
MAX_CACHE_SIZE = 100


def get_cache_key(filters: dict) -> str:
    items = sorted(filters.items())
    key_str = json.dumps(items, sort_keys=True, default=str)
    return hashlib.md5(key_str.encode()).hexdigest()


def clean_nan_recursive(obj):
    """Reemplaza np.nan / pd.NA / NaT por None para que sea serializable en JSON."""
    if isinstance(obj, dict):
        return {k: clean_nan_recursive(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_nan_recursive(item) for item in obj]
    elif isinstance(obj, (np.floating, float)) and np.isnan(obj):
        return None
    elif isinstance(obj, (np.integer,)):
        return int(obj)
    elif isinstance(obj, (pd.Timestamp,)):
        return None if pd.isna(obj) else obj.isoformat()
    try:
        if pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    return obj


def get_cached_graph(filters: dict):
    return graph_cache.get(get_cache_key(filters))


def set_cached_graph(filters: dict, graph_data):
    key = get_cache_key(filters)
    graph_data_clean = clean_nan_recursive(graph_data)
    if len(graph_cache) >= MAX_CACHE_SIZE:
        first_key = next(iter(graph_cache))
        del graph_cache[first_key]
    graph_cache[key] = graph_data_clean
    return graph_data_clean


# =============================================================================
# 4. PERFILES DE RIESGO (botones de acceso rápido - sección 2.1)
# =============================================================================
# Se centralizan aquí para que /api/filters/options pueda exponer los
# umbrales al frontend (evita "números mágicos" duplicados en el cliente).

RISK_PROFILES = {
    "obras_criticas": {
        "label": "🏗️ Obras Críticas",
        "description": "cat_Works=1 + is_end_of_year=1",
    },
    "monopolio_regional": {
        "label": "🎯 Monopolio Regional",
        "description": "competition_level=0 + is_large_procurement=1",
    },
    "papeles_incompletos": {
        "label": "📄 Papeles Incompletos",
        "description": "(has_signed=0 OR has_item_detail=0) AND tender_amount > 500000",
        "min_amount": 500_000,
    },
}


# =============================================================================
# 5. FILTRADO GLOBAL
# =============================================================================

def apply_filters(base_df: pd.DataFrame, filters: dict) -> pd.DataFrame:
    """Aplica los filtros globales. Todos los filtros se combinan con AND,
    excepto el perfil 'papeles_incompletos' que internamente usa OR
    (has_signed=0 OR has_item_detail=0), tal como pide la sección 2.1.
    """
    filtered = base_df

    mask = pd.Series(True, index=filtered.index)

    if filters.get("dept"):
        mask &= filtered["department"].str.upper() == filters["dept"].upper()

    if filters.get("region"):
        mask &= filtered["region"].str.upper() == filters["region"].upper()

    if filters.get("proc_type"):
        mask &= filtered["procurement_type"] == filters["proc_type"]

    if filters.get("cat"):
        mask &= filtered["category"] == filters["cat"]

    if filters.get("is_end_of_year") is not None:
        mask &= filtered["is_end_of_year"] == int(filters["is_end_of_year"])

    if filters.get("competition_level") is not None:
        mask &= filtered["competition_level"] == int(filters["competition_level"])

    if filters.get("has_signed") is not None:
        mask &= filtered["has_signed"] == int(filters["has_signed"])

    if filters.get("has_item_detail") is not None:
        mask &= filtered["has_item_detail"] == int(filters["has_item_detail"])

    if filters.get("has_project") is not None:
        mask &= filtered["has_project"] == int(filters["has_project"])

    if filters.get("is_large_procurement") is not None:
        mask &= filtered["is_large_procurement"] == int(filters["is_large_procurement"])

    if filters.get("min_amount") is not None:
        mask &= filtered["tender_amount"] >= float(filters["min_amount"])
    if filters.get("max_amount") is not None:
        mask &= filtered["tender_amount"] <= float(filters["max_amount"])

    if filters.get("months"):
        months_list = [int(m) for m in str(filters["months"]).split(",")]
        mask &= filtered["month"].isin(months_list)

    # [NUEVO] Búsqueda de texto libre (barra global, sección 2.1). Busca en
    # entidad compradora, proveedor, departamento y región (OR entre columnas).
    if filters.get("q"):
        q = str(filters["q"]).strip().upper()
        if q:
            text_cols = [c for c in ["buyer_name", "supplier_name", "department", "region"]
                         if c in filtered.columns]
            text_mask = pd.Series(False, index=filtered.index)
            for col in text_cols:
                text_mask |= filtered[col].astype(str).str.upper().str.contains(q, na=False)
            mask &= text_mask

    # [NUEVO] Perfiles de riesgo (botones rápidos, sección 2.1)
    profile = filters.get("profile")
    if profile == "obras_criticas":
        works_col = "cat_Works"
        if works_col in filtered.columns:
            mask &= filtered[works_col] == 1
        mask &= filtered["is_end_of_year"] == 1
    elif profile == "monopolio_regional":
        mask &= filtered["competition_level"] == 0
        mask &= filtered["is_large_procurement"] == 1
    elif profile == "papeles_incompletos":
        or_mask = (filtered["has_signed"] == 0) | (filtered["has_item_detail"] == 0)
        mask &= or_mask
        mask &= filtered["tender_amount"] > RISK_PROFILES["papeles_incompletos"]["min_amount"]

    return filtered[mask]


def contract_alerts(row: pd.Series) -> List[dict]:
    """Calcula las alertas disparadas por un contrato (pestaña 'Alertas
    Disparadas' del panel lateral, sección 2.7)."""
    alerts = []
    if row.get("competition_level") == 0:
        alerts.append({"code": "unico_postor", "label": "Único postor (sin competencia)"})
    if row.get("has_signed") == 0:
        alerts.append({"code": "sin_firma", "label": "Sin fecha de firma registrada"})
    if row.get("has_item_detail") == 0:
        alerts.append({"code": "sin_detalle", "label": "Sin detalle de ítem"})
    if row.get("is_end_of_year") == 1:
        alerts.append({"code": "fin_de_anio", "label": "Adjudicado en cierre de año (nov-dic)"})
    if row.get("saving_class") == 0:
        alerts.append({"code": "sobrecosto", "label": "Sobrecosto respecto al presupuesto"})
    if row.get("is_large_procurement") == 1 and row.get("competition_level") == 0:
        alerts.append({"code": "gran_monto_sin_competencia",
                        "label": "Contrato de gran monto sin competencia"})
    return alerts


# =============================================================================
# 6. GRAFO DE RELACIONES (seccion 2.5)
# =============================================================================
# [ARQUITECTURA] La construccion del grafo (layout + comunidades) ya NO
# ocurre aqui. Ver graph_engine.py: usa el cache precalculado por
# batch_layout.py (posiciones y comunidades estables) y agrega EN VIVO
# (pandas, vectorizado) solo los montos del subconjunto ya filtrado.
# Los metodos live_edge_stats / macro_view / micro_view / ego_network
# viven en graph_engine.GraphEngine (instanciado arriba como graph_engine).


# =============================================================================
# 7. HELPER: parsear filtros comunes desde query params (evita repetir 14
#    parámetros idénticos en cada endpoint)
# =============================================================================

def common_filter_params(
    dept: Optional[str] = Query(None),
    region: Optional[str] = Query(None),
    proc_type: Optional[str] = Query(None),
    cat: Optional[str] = Query(None),
    is_end_of_year: Optional[int] = Query(None),
    competition_level: Optional[int] = Query(None),
    has_signed: Optional[int] = Query(None),
    has_item_detail: Optional[int] = Query(None),
    has_project: Optional[int] = Query(None),
    is_large_procurement: Optional[int] = Query(None),
    min_amount: Optional[float] = Query(None),
    max_amount: Optional[float] = Query(None),
    months: Optional[str] = Query(None),
    q: Optional[str] = Query(None, description="Búsqueda de texto libre (entidad, proveedor, depto, región)"),
    profile: Optional[str] = Query(None, description="obras_criticas | monopolio_regional | papeles_incompletos"),
) -> dict:
    return {
        "dept": dept, "region": region, "proc_type": proc_type, "cat": cat,
        "is_end_of_year": is_end_of_year, "competition_level": competition_level,
        "has_signed": has_signed, "has_item_detail": has_item_detail, "has_project": has_project,
        "is_large_procurement": is_large_procurement, "min_amount": min_amount, "max_amount": max_amount,
        "months": months, "q": q, "profile": profile,
    }


# =============================================================================
# 8. ENDPOINTS
# =============================================================================

@app.get("/api/health")
async def health_check():
    return {"status": "ok", "rows": len(df), "columns": len(df.columns)}


@app.get("/api/filters/options")
async def get_filter_options():
    """Poblado de selectores + metadatos de los perfiles de riesgo (2.1)."""
    return {
        "departments": sorted(df["department"].dropna().unique().tolist()),
        "regions": sorted(df["region"].dropna().unique().tolist()) if "region" in df.columns else [],
        "procurement_types": sorted(df["procurement_type"].dropna().unique().tolist()),
        "categories": sorted(df["category"].dropna().unique().tolist()),
        "risk_profiles": RISK_PROFILES,
    }


@app.get("/api/search/suggest")
async def search_suggest(q: str = Query(..., min_length=1), limit: int = Query(10, ge=1, le=50)):
    """[NUEVO] Autocompletado para la barra de búsqueda global (2.1).
    Busca coincidencias en entidad compradora, proveedor, departamento y
    región, y devuelve top resultados por frecuencia."""
    q_upper = q.strip().upper()
    if not q_upper:
        return {"results": []}

    candidates = []
    sources = [
        ("buyer_name", "entidad"),
        ("supplier_name", "proveedor"),
        ("department", "departamento"),
        ("region", "region"),
    ]
    for col, tipo in sources:
        if col not in df.columns:
            continue
        matches = df[col].dropna().astype(str)
        matches = matches[matches.str.upper().str.contains(q_upper, na=False)]
        if matches.empty:
            continue
        counts = matches.value_counts().head(limit)
        for value, count in counts.items():
            candidates.append({"value": value, "type": tipo, "count": int(count)})

    candidates.sort(key=lambda x: -x["count"])
    return {"results": candidates[:limit]}


@app.get("/api/data")
async def get_data(
    filters: dict = Depends(common_filter_params),
    limit: int = Query(50, ge=1, le=100000, description="50 por defecto: paginación de la tabla (2.6)"),
    offset: int = Query(0, ge=0),
    sort_by: Optional[str] = Query(None, description="Columna para ordenar al hacer clic en encabezado (2.6)"),
    sort_dir: str = Query("desc", pattern="^(asc|desc)$"),
):
    """Tabla de Alertas (2.6): filtrado, ordenamiento por columna y paginación
    de 50 filas. Cada fila incluye row_uid y n_alertas para que el frontend
    pueda resaltarla si coincide con el elemento activo del Treemap/Grafo."""
    try:
        filtered_df = apply_filters(df, filters)
        total = len(filtered_df)

        if sort_by and sort_by in filtered_df.columns:
            filtered_df = filtered_df.sort_values(sort_by, ascending=(sort_dir == "asc"), na_position="last")

        page = filtered_df.iloc[offset:offset + limit].copy()
        page["n_alertas"] = page.apply(lambda r: len(contract_alerts(r)), axis=1)

        records = clean_nan_recursive(page.replace({np.nan: None}).to_dict(orient="records"))
        return {"data": records, "total": total, "limit": limit, "offset": offset}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats")
async def get_stats(filters: dict = Depends(common_filter_params)):
    try:
        filtered_df = apply_filters(df, filters)
        if len(filtered_df) == 0:
            return {
                "count": 0, "total_amount": 0, "avg_saving_pct": 0, "pct_overcost": 0,
                "avg_tenderers": 0, "avg_irc": 0, "top_procurement_types": {}, "top_departments": {},
            }
        stats = {
            "count": int(len(filtered_df)),
            "total_amount": float(filtered_df["tender_amount"].sum()),
            "avg_saving_pct": float(filtered_df["saving_pct"].mean()),
            "pct_overcost": float((filtered_df["saving_class"] == 0).mean() * 100),
            "avg_tenderers": float(filtered_df["number_of_tenderers"].mean()),
            "avg_irc": float(filtered_df["risk_score"].mean()),
            "top_procurement_types": filtered_df["procurement_type"].value_counts().head(5).to_dict(),
            "top_departments": filtered_df["department"].value_counts().head(5).to_dict(),
        }
        return clean_nan_recursive(stats)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/map")
async def get_map_data(filters: dict = Depends(common_filter_params)):
    """[NUEVO] Mapa de Riesgo (2.2): IRC compuesto por departamento + desglose
    para el tooltip ('Sin competencia: 45%', 'Sobrecostos: 30%', 'Nov-Dic: 70%').
    Los filtros globales SÍ aplican aquí (excepto, típicamente, el propio
    filtro de departamento, para no colapsar el mapa a una sola región al
    hacer clic en ella; el frontend puede omitir `dept` al llamar a este
    endpoint tras un clic en el mapa si desea mantenerlo visible)."""
    try:
        base = apply_filters(df, filters)
        if len(base) == 0:
            return {"data": []}

        grouped = base.groupby("department").agg(
            count=("department", "size"),
            total_amount=("tender_amount", "sum"),
            pct_overcost=("saving_class", lambda x: (x == 0).mean() * 100),
            pct_sin_competencia=("competition_level", lambda x: (x == 0).mean() * 100),
            pct_fin_de_anio=("is_end_of_year", lambda x: (x == 1).mean() * 100),
            irc=("risk_score", "mean"),
        ).reset_index()
        grouped = grouped.fillna(0)

        result = []
        for _, row in grouped.iterrows():
            result.append({
                "department": row["department"],
                "count": int(row["count"]),
                "total_amount": float(row["total_amount"]),
                "irc": round(float(row["irc"]), 1),
                "breakdown": {
                    "sin_competencia_pct": round(float(row["pct_sin_competencia"]), 1),
                    "sobrecostos_pct": round(float(row["pct_overcost"]), 1),
                    "fin_de_anio_pct": round(float(row["pct_fin_de_anio"]), 1),
                },
            })
        return {"data": clean_nan_recursive(result)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _bucket_color(avg_postores: float) -> str:
    """Codificación de color fija del Treemap (sección 2.3):
    Rojo=1 postor, Naranja=2-3, Amarillo=4-6, Verde>=7."""
    if avg_postores <= 1:
        return "rojo"
    if avg_postores <= 3:
        return "naranja"
    if avg_postores <= 6:
        return "amarillo"
    return "verde"


@app.get("/api/treemap")
async def get_treemap(
    filters: dict = Depends(common_filter_params),
    entity: Optional[str] = Query(None, description="buyer_name para drill-down al 3er nivel (tipo de procedimiento)"),
):
    """[NUEVO] Treemap de Concentración de Grandes Contratos (2.3).
    Jerarquía: Región/Departamento -> Entidad -> Tipo de procedimiento.
    - Si filters.dept no viene: nivel 0, agrupa por departamento.
    - Si filters.dept viene y `entity` no: nivel 1, agrupa por entidad (buyer_name) dentro del depto.
    - Si filters.dept y `entity` vienen: nivel 2, agrupa por procurement_type dentro de esa entidad.
    El breadcrumb lo arma el frontend concatenando dept/entity ya conocidos."""
    try:
        base = apply_filters(df, filters)
        if entity:
            base = base[base["buyer_name"] == entity]

        if filters.get("dept") and entity:
            group_col = "procurement_type"
            level = "procedimiento"
        elif filters.get("dept"):
            group_col = "buyer_name"
            level = "entidad"
        else:
            group_col = "department"
            level = "departamento"

        if group_col not in base.columns or base.empty:
            return {"level": level, "children": []}

        grouped = base.groupby(group_col).agg(
            value=("tender_amount", "sum"),
            n=("tender_amount", "size"),
            avg_postores=("number_of_tenderers", "mean"),
            saving_pct=("saving_pct", "mean"),
        ).reset_index().rename(columns={group_col: "name"})

        children = []
        for _, row in grouped.iterrows():
            children.append({
                "name": row["name"],
                "value": float(row["value"]),
                "n_contratos": int(row["n"]),
                "avg_postores": round(float(row["avg_postores"]), 1) if pd.notna(row["avg_postores"]) else 0,
                "saving_pct": round(float(row["saving_pct"]), 4) if pd.notna(row["saving_pct"]) else 0,
                "color": _bucket_color(row["avg_postores"] if pd.notna(row["avg_postores"]) else 0),
            })
        children.sort(key=lambda c: -c["value"])
        return {"level": level, "children": clean_nan_recursive(children)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/temporal")
async def get_temporal(filters: dict = Depends(common_filter_params)):
    """[NUEVO] Gráfico Temporal Dual (2.4): monto adjudicado vs. saving_pct
    promedio por mes. El "brush" temporal del frontend simplemente vuelve a
    llamar a /api/data (u otros endpoints) con `months` acotado al rango
    seleccionado; este endpoint siempre devuelve los 12 meses del subconjunto
    filtrado (sin aplicar `months`) para que la línea de tiempo completa sea
    visible y el área roja nov-dic sea comparable contra el resto del año.
    """
    try:
        filters_no_month = {k: v for k, v in filters.items() if k != "months"}
        base = apply_filters(df, filters_no_month)
        if base.empty or "month" not in base.columns:
            return {"data": []}

        grouped = base.groupby("month").agg(
            total_amount=("tender_amount", "sum"),
            avg_saving_pct=("saving_pct", "mean"),
            count=("tender_amount", "size"),
        ).reindex(range(1, 13)).fillna(0).reset_index()

        result = [{
            "month": int(row["month"]),
            "total_amount": float(row["total_amount"]),
            "avg_saving_pct": float(row["avg_saving_pct"]),
            "count": int(row["count"]),
            "is_end_of_year": int(row["month"]) in (11, 12),
        } for _, row in grouped.iterrows()]
        return {"data": clean_nan_recursive(result)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/graph")
async def get_graph(
    filters: dict = Depends(common_filter_params),
    focus: Optional[str] = Query(None, description="id o nombre de nodo para centrar ego-network (2.5)"),
    focus_depth: int = Query(1, ge=1, le=3, description="Grados de vecindad a mostrar en el ego-network"),
    min_edge_amount: float = Query(
        0.0, ge=0,
        description="Filtro de respaldo en servidor. El slider de la UI filtra en el "
                     "cliente (GPU) sin volver a pedir datos; este parámetro solo importa "
                     "para acotar el payload inicial si hace falta."),
    lod: str = Query("macro", pattern="^(macro|micro)$",
                      description="'macro' = nodos agregados por celda×comunidad (vista general). "
                                  "'micro' = nodos/aristas reales, requiere bbox."),
    bbox: Optional[str] = Query(
        None, description="'xmin,ymin,xmax,ymax' en el espacio de coordenadas del layout "
                           "(no píxeles de pantalla). Requerido cuando lod=micro."),
    community: Optional[int] = Query(
        None, description="Filtra la vista micro a una sola comunidad Louvain "
                           "(drill-down al hacer clic en un macronodo de la vista general)."),
):
    """[REESCRITO - arquitectura híbrida] Ya NO recalcula layout ni Louvain
    aquí (eso vive precalculado en graph_engine / batch_layout.py). Solo:
      1. aplica los filtros globales al DataFrame de contratos (rápido, pandas),
      2. agrega en vivo los montos por par comprador-proveedor del subconjunto,
      3. le pega encima la posición/comunidad ya calculada, y
      4. según `lod`, devuelve la vista macro (agregada) o micro (bbox real).
    Sin el límite artificial de muestreo a 5.000 filas: el costo ya no
    depende del número de contratos sino del tamaño del subconjunto de
    ENTIDADES visibles, que es varios órdenes de magnitud menor.
    """
    if not graph_engine.ready:
        raise HTTPException(
            status_code=503,
            detail="El cache del grafo no está generado. Corré 'python batch_layout.py' primero.")

    try:
        cache_key = get_cache_key({**filters, "focus": focus, "focus_depth": focus_depth,
                                    "lod": lod, "bbox": bbox, "community": community,
                                    "min_edge_amount": min_edge_amount})
        cached = get_cached_graph({"_k": cache_key})
        if cached is not None:
            return cached

        filtered_df = apply_filters(df, filters)
        active_ids = graph_engine.active_entity_ids(filtered_df)
        edge_stats = graph_engine.live_edge_stats(filtered_df, min_edge_amount=min_edge_amount)

        if focus:
            graph_data = graph_engine.ego_network(focus, active_ids, edge_stats, depth=focus_depth)
        elif lod == "micro":
            parsed_bbox = None
            if bbox:
                try:
                    xmin, ymin, xmax, ymax = (float(v) for v in bbox.split(","))
                    parsed_bbox = (xmin, ymin, xmax, ymax)
                except ValueError:
                    raise HTTPException(status_code=400, detail="bbox inválido, formato esperado 'xmin,ymin,xmax,ymax'")
            graph_data = graph_engine.micro_view(active_ids, edge_stats, bbox=parsed_bbox, community=community)
        else:
            graph_data = graph_engine.macro_view(active_ids, edge_stats)

        graph_data["grid_bounds"] = graph_engine.grid_bounds()
        return set_cached_graph({"_k": cache_key}, graph_data)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/contract/{row_uid}")
async def get_contract(row_uid: str):
    """[NUEVO] Ficha Detallada del Contrato (2.7). Devuelve el registro
    completo organizado en las 3 pestañas del panel lateral, más la lista
    de alertas disparadas."""
    match = df[df["row_uid"] == row_uid]
    if match.empty:
        raise HTTPException(status_code=404, detail="Contrato no encontrado")

    row = match.iloc[0]
    resumen = {k: row.get(k) for k in [
        "row_uid", "contract_id", "buyer_name", "supplier_name", "department", "region",
        "category", "procurement_type", "tender_amount", "number_of_tenderers", "saving_pct",
    ] if k in row.index}

    integridad = {k: row.get(k) for k in [
        "has_signed", "has_item_detail", "has_project", "has_contract",
        "tender_date_published", "award_date", "date_signed",
    ] if k in row.index}

    alertas = contract_alerts(row)

    payload = {
        "resumen_ejecutivo": resumen,
        "integridad_y_plazos": integridad,
        "alertas_disparadas": alertas,
    }
    return clean_nan_recursive(payload)


class GroupRequest(BaseModel):
    row_uids: List[str]


@app.post("/api/group")
async def group_selected(body: GroupRequest):
    """[NUEVO] 'Agrupar seleccionados' (2.6): recibe los row_uid marcados en
    la tabla y devuelve estadísticas + desglose agregado solo de ese subconjunto,
    para que el frontend genere una vista comparativa temporal en los gráficos."""
    if not body.row_uids:
        raise HTTPException(status_code=400, detail="row_uids vacío")

    subset = df[df["row_uid"].isin(body.row_uids)]
    if subset.empty:
        raise HTTPException(status_code=404, detail="Ninguno de los contratos existe")

    stats = {
        "count": int(len(subset)),
        "total_amount": float(subset["tender_amount"].sum()),
        "avg_saving_pct": float(subset["saving_pct"].mean()),
        "avg_irc": float(subset["risk_score"].mean()),
        "departments": subset["department"].value_counts().to_dict(),
        "procurement_types": subset["procurement_type"].value_counts().to_dict(),
    }
    graph_data = {"nodes": [], "edges": [], "meta": {}}
    if graph_engine.ready:
        active_ids = graph_engine.active_entity_ids(subset)
        edge_stats = graph_engine.live_edge_stats(subset)
        # el subconjunto "agrupado" suele ser chico (selección manual de la
        # tabla), así que la vista micro sin bbox (todo lo activo) es la
        # comparación 1:1 más fiel a lo que hacía el build_graph anterior.
        graph_data = graph_engine.micro_view(active_ids, edge_stats, bbox=None)
    return clean_nan_recursive({"stats": stats, "graph": graph_data})


class ReportRequest(BaseModel):
    filters: dict = {}
    contract_row_uid: Optional[str] = None
    # Capturas ya renderizadas por el frontend (html2canvas / dom-to-image en
    # base64 PNG). El backend NO puede re-renderizar React/D3, así que el
    # "estado actual de todos los gráficos" debe llegar como imagen desde el
    # cliente; el backend solo las embebe en el PDF junto con los datos.
    map_image_b64: Optional[str] = None
    treemap_image_b64: Optional[str] = None
    graph_image_b64: Optional[str] = None
    table_image_b64: Optional[str] = None


@app.post("/api/export/report")
async def export_report(body: ReportRequest):
    """[NUEVO] Genera el PDF de 'Evidencia Preliminar' (2.7).

    IMPORTANTE (arquitectura): el backend no tiene forma de re-dibujar el
    mapa/treemap/grafo de React tal como se ven en pantalla en ese instante
    (con zoom, hover, selección, etc.) — eso vive en el DOM del navegador.
    El patrón estándar es que el frontend capture cada panel con
    html2canvas/dom-to-image al presionar el botón rojo, y envíe esas
    imágenes en base64 aquí. Este endpoint arma el PDF final combinando esas
    imágenes con la ficha del contrato y los filtros activos.
    """
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib import colors
    import io

    styles = getSampleStyleSheet()
    story = []

    story.append(Paragraph("Evidencia Preliminar de Auditoría - PUCI", styles["Title"]))
    story.append(Paragraph(f"Generado: {datetime.now().strftime('%Y-%m-%d %H:%M')}", styles["Normal"]))
    story.append(Spacer(1, 0.5 * cm))

    story.append(Paragraph("Filtros activos", styles["Heading2"]))
    filtros_txt = ", ".join(f"{k}={v}" for k, v in body.filters.items() if v not in (None, "")) or "Sin filtros (vista nacional)"
    story.append(Paragraph(filtros_txt, styles["Normal"]))
    story.append(Spacer(1, 0.3 * cm))

    filtered_df = apply_filters(df, body.filters)
    stats = {
        "Contratos": len(filtered_df),
        "Monto total (S/)": f"{filtered_df['tender_amount'].sum():,.2f}" if not filtered_df.empty else "0",
        "IRC promedio": f"{filtered_df['risk_score'].mean():.1f}" if not filtered_df.empty else "0",
    }
    table_data = [["Métrica", "Valor"]] + [[k, v] for k, v in stats.items()]
    t = Table(table_data, colWidths=[8 * cm, 8 * cm])
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                           ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#2c3e50")),
                           ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]))
    story.append(t)
    story.append(Spacer(1, 0.5 * cm))

    for label, b64img in [("Mapa de Riesgo", body.map_image_b64), ("Treemap", body.treemap_image_b64),
                           ("Grafo de Relaciones", body.graph_image_b64), ("Tabla de Alertas", body.table_image_b64)]:
        if not b64img:
            continue
        try:
            img_bytes = base64.b64decode(b64img.split(",")[-1])
            story.append(Paragraph(label, styles["Heading2"]))
            story.append(Image(io.BytesIO(img_bytes), width=16 * cm, height=9 * cm))
            story.append(Spacer(1, 0.4 * cm))
        except Exception as e:
            story.append(Paragraph(f"[No se pudo incrustar imagen de {label}: {e}]", styles["Normal"]))

    if body.contract_row_uid:
        match = df[df["row_uid"] == body.contract_row_uid]
        if not match.empty:
            row = match.iloc[0]
            story.append(Paragraph("Ficha del contrato", styles["Heading2"]))
            for alert in contract_alerts(row):
                story.append(Paragraph(f"• {alert['label']}", styles["Normal"]))

    filename = f"reports/evidencia_{uuid.uuid4().hex[:10]}.pdf"
    filepath = os.path.join("static", filename)
    doc = SimpleDocTemplate(filepath, pagesize=A4)
    doc.build(story)

    return {"message": "PDF generado", "url": f"/static/{filename}"}

@app.get("/")
async def home():
    return FileResponse("public/index.html")

# =============================================================================
# 9. EJECUTAR SERVIDOR
# =============================================================================

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)