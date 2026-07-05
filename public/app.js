"use strict";
/* =================================================================
 * PUCI — Panel Único de Control Integrado
 * Frontend de interactividad (spec CGR v3.0)
 * ================================================================= */

// -----------------------------------------------------------------
// 0. CONFIGURACIÓN
// -----------------------------------------------------------------
const CONFIG = {
  // Cambia esto por la URL donde corre tu backend FastAPI (backend.py)
  //API_BASE: "http://localhost:8000",
  API_BASE: "",
  GEOJSON_URL: "https://raw.githubusercontent.com/juaneladio/peru-geojson/master/peru_departamental_simple.geojson",
};

const COMP_COLOR = "#3b82f6";
const PROV_COLOR = "#f97316";
const RISK_COLORS = ["#d1d5db", "#fde068", "#fb923c", "#ef4444"];
const RISK_LABELS = ["Sin riesgo", "Riesgo leve", "Riesgo medio", "Riesgo alto"];
const SEL_COLOR = "#ec4899";
const BUCKET_HEX = { rojo: "#ef4444", naranja: "#f97316", amarillo: "#facc15", verde: "#22c55e" };
const COMMUNITY_COLORS = [
  "#e6194B", "#3cb44b", "#4363d8", "#f58231", "#911eb4",
  "#46f0f0", "#f032e6", "#bcf60c", "#008080", "#9a6324",
  "#800000", "#808000", "#000075", "#e6beff", "#fabebe",
];
function communityColor(idx) { return idx < 0 ? "#cbd5e1" : COMMUNITY_COLORS[idx % COMMUNITY_COLORS.length]; }

// -----------------------------------------------------------------
// 1. ESTADO GLOBAL
// -----------------------------------------------------------------
const state = {
  filters: {
    dept: null, region: null, proc_type: null, cat: null,
    is_end_of_year: null, competition_level: null, has_signed: null,
    has_item_detail: null, has_project: null, is_large_procurement: null,
    min_amount: null, max_amount: null, months: null, q: null, profile: null,
  },
  qLabel: null, // texto legible de la búsqueda/entidad activa (para chips)
  treemap: { entity: null },
  table: { sort_by: "risk_score", sort_dir: "desc", offset: 0, limit: 50, total: 0, selected: new Set(), rows: [] },
  graph: { min_edge_amount: 0, colorMode: "comunidad", sim: null, physicsOn: false, focusMode: null,
           nodesArr: [], edgesArr: [], meta: {}, lod: "macro", drillCommunity: null, gridBounds: {} },
  side: { pinned: false, mode: null, data: null, tab: "resumen" },
  mapLocked: null,
  filterOptions: null,
  geo: null,
};

// -----------------------------------------------------------------
// 2. HELPERS
// -----------------------------------------------------------------
function qs(params) {
  const p = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== "") p.append(k, v); });
  return p.toString();
}
async function api(path, params = {}) {
  const query = qs(params);
  const url = `${CONFIG.API_BASE}${path}${query ? "?" + query : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}
async function apiPost(path, body) {
  const res = await fetch(`${CONFIG.API_BASE}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}
function activeFilters() { return { ...state.filters }; }
function fmtS(n) {
  n = n || 0;
  if (Math.abs(n) >= 1e9) return "S/ " + (n / 1e9).toFixed(2) + " B";
  if (Math.abs(n) >= 1e6) return "S/ " + (n / 1e6).toFixed(1) + " M";
  if (Math.abs(n) >= 1e3) return "S/ " + (n / 1e3).toFixed(0) + " K";
  return "S/ " + n.toFixed(0);
}
function fmtPct(p) { return ((p || 0) * 100).toFixed(1) + "%"; }
function fmtNum(n) { return (n || 0).toLocaleString("es-PE"); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function debounce(fn, wait) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); }; }
function normalize(s) { return String(s || "").toUpperCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function riskPill(r) { r = Math.max(0, Math.min(3, Math.round(r || 0))); return `<span class="pill" style="background:${RISK_COLORS[r]}22;color:${RISK_COLORS[r]};border:1.5px solid ${RISK_COLORS[r]}">${RISK_LABELS[r]}</span>`; }

// -----------------------------------------------------------------
// 3. INICIALIZACIÓN
// -----------------------------------------------------------------
(async function init() {
  try {
    await Promise.all([loadFilterOptions(), loadGeo()]);
    setupHeaderEvents();
    setupMapEvents();
    setupTreemapEvents();
    setupTemporalEvents();
    setupGraphEvents();
    setupTableEvents();
    setupSidePanelEvents();
    await refreshAll();
  } catch (e) {
    console.error(e);
    document.getElementById("loaderErr").textContent =
      "No se pudo conectar con el backend en " + CONFIG.API_BASE + ". Verifica que esté corriendo y que CORS esté habilitado. Detalle: " + e.message;
    return;
  }
  document.getElementById("loader").style.display = "none";
})();

async function loadGeo() {
  const res = await fetch(CONFIG.GEOJSON_URL);
  state.geo = await res.json();
}

async function loadFilterOptions() {
  const opts = await api("/api/filters/options");
  state.filterOptions = opts;
  const fill = (id, list) => {
    const sel = document.getElementById(id);
    list.forEach(v => { const o = document.createElement("option"); o.value = v; o.textContent = v; sel.appendChild(o); });
  };
  fill("selDept", opts.departments || []);
  fill("selRegion", opts.regions || []);
  fill("selProcType", opts.procurement_types || []);
  fill("selCat", opts.categories || []);

  const wrap = document.getElementById("profileBtns");
  Object.entries(opts.risk_profiles || {}).forEach(([key, meta]) => {
    const b = document.createElement("button");
    b.className = "pbtn"; b.dataset.profile = key; b.textContent = meta.label;
    b.title = meta.description;
    b.addEventListener("click", () => toggleProfile(key));
    wrap.appendChild(b);
  });
}

// -----------------------------------------------------------------
// 4. ORQUESTACIÓN — ACTUALIZACIÓN EN CASCADA
// -----------------------------------------------------------------
async function refreshAll({ keepTablePage = false } = {}) {
  if (!keepTablePage) state.table.offset = 0;
  renderChips();
  syncFilterControls();
  await Promise.allSettled([
    fetchStats(), fetchMap(), fetchTreemap(), fetchTemporal(), fetchGraph(), fetchTable(),
  ]);
}

function setFilter(key, value) {
  state.filters[key] = (value === undefined || value === "") ? null : value;
  refreshAll();
}

function syncFilterControls() {
  document.getElementById("selDept").value = state.filters.dept || "";
  document.getElementById("selRegion").value = state.filters.region || "";
  document.getElementById("selProcType").value = state.filters.proc_type || "";
  document.getElementById("selCat").value = state.filters.cat || "";
  document.querySelectorAll(".pbtn").forEach(b => b.classList.toggle("active", b.dataset.profile === state.filters.profile));
}

function renderChips() {
  const row = document.getElementById("chipsRow");
  const labels = {
    dept: "Departamento", region: "Región", proc_type: "Procedimiento", cat: "Categoría",
    is_end_of_year: "Fin de año", competition_level: "Nivel competencia", has_signed: "Firma",
    has_item_detail: "Detalle ítem", has_project: "Proyecto", is_large_procurement: "Gran monto",
    min_amount: "Monto mín.", max_amount: "Monto máx.", months: "Meses", q: "Búsqueda", profile: "Perfil",
  };
  const chips = [];
  Object.entries(state.filters).forEach(([k, v]) => {
    if (v === null || v === undefined || v === "") return;
    let display = v;
    if (k === "profile") display = (state.filterOptions?.risk_profiles?.[v]?.label) || v;
    if (k === "q" && state.qLabel) display = state.qLabel;
    chips.push({ key: k, text: `${labels[k] || k}: ${display}` });
  });
  if (state.treemap.entity) chips.push({ key: "__tm_entity", text: `Entidad (treemap): ${state.treemap.entity}` });

  row.innerHTML = chips.map(c => `
    <span class="chip">${escapeHtml(c.text)}<button data-k="${c.key}">✕</button></span>
  `).join("") || `<span style="font-size:11px;color:var(--muted);">Sin filtros activos — vista nacional completa</span>`;

  row.querySelectorAll("button[data-k]").forEach(btn => btn.addEventListener("click", () => {
    const k = btn.dataset.k;
    if (k === "__tm_entity") { state.treemap.entity = null; refreshAll(); return; }
    if (k === "q") state.qLabel = null;
    if (k === "dept") state.mapLocked = null;
    state.filters[k] = null;
    refreshAll();
  }));
}

function resetAllFilters() {
  Object.keys(state.filters).forEach(k => state.filters[k] = null);
  state.qLabel = null;
  state.treemap.entity = null;
  state.mapLocked = null;
  document.getElementById("globalSearch").value = "";
  state.graph.lod = "macro";
  state.graph.drillCommunity = null;
  exitGraphFocus();
  refreshAll();
}

// -----------------------------------------------------------------
// 5. BARRA DE FILTROS GLOBALES (2.1)
// -----------------------------------------------------------------
function setupHeaderEvents() {
  document.getElementById("btnResetAll").addEventListener("click", resetAllFilters);
  document.getElementById("selDept").addEventListener("change", e => { state.mapLocked = e.target.value || null; setFilter("dept", e.target.value); });
  document.getElementById("selRegion").addEventListener("change", e => setFilter("region", e.target.value));
  document.getElementById("selProcType").addEventListener("change", e => setFilter("proc_type", e.target.value));
  document.getElementById("selCat").addEventListener("change", e => setFilter("cat", e.target.value));

  const input = document.getElementById("globalSearch");
  const suggestBox = document.getElementById("searchSuggest");
  const doSearch = debounce(async (q) => {
    if (!q || q.trim().length < 1) { suggestBox.classList.remove("open"); return; }
    try {
      const res = await api("/api/search/suggest", { q, limit: 10 });
      const results = res.results || [];
      if (!results.length) { suggestBox.innerHTML = `<div class="sg-item" style="color:var(--muted)">Sin coincidencias</div>`; suggestBox.classList.add("open"); return; }
      suggestBox.innerHTML = results.map(r => `
        <div class="sg-item" data-val="${escapeHtml(r.value)}">
          <span>${escapeHtml(r.value)}</span>
          <span class="sg-tag">${escapeHtml(r.type)} · ${r.count}</span>
        </div>`).join("");
      suggestBox.classList.add("open");
      suggestBox.querySelectorAll(".sg-item[data-val]").forEach(el => el.addEventListener("click", () => {
        input.value = el.dataset.val;
        state.qLabel = el.dataset.val;
        suggestBox.classList.remove("open");
        setFilter("q", el.dataset.val);
      }));
    } catch (e) { console.warn("search/suggest falló", e); }
  }, 300);
  input.addEventListener("input", e => doSearch(e.target.value));
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { state.qLabel = input.value; suggestBox.classList.remove("open"); setFilter("q", input.value); }
  });
  document.addEventListener("click", e => { if (!e.target.closest(".search-wrap")) suggestBox.classList.remove("open"); });
}

function toggleProfile(key) {
  state.filters.profile = (state.filters.profile === key) ? null : key;
  refreshAll();
}

// -----------------------------------------------------------------
// 6. STATS GLOBALES (encabezado)
// -----------------------------------------------------------------
async function fetchStats() {
  try {
    const s = await api("/api/stats", activeFilters());
    document.getElementById("globalStats").innerHTML = `
      <div class="gstat">Contratos<b>${fmtNum(s.count)}</b></div>
      <div class="gstat">Monto total<b>${fmtS(s.total_amount)}</b></div>
      <div class="gstat">Ahorro prom.<b>${fmtPct(s.avg_saving_pct)}</b></div>
      <div class="gstat">IRC prom.<b>${(s.avg_irc || 0).toFixed(1)}</b></div>
    `;
  } catch (e) { console.warn("stats falló", e); }
}

// -----------------------------------------------------------------
// 7. MAPA DE RIESGO (2.2)
// -----------------------------------------------------------------
let mapProjection = null, mapPathGen = null, mapZoom = null;

function setupMapEvents() {
  document.getElementById("btnMapReset").addEventListener("click", () => {
    state.mapLocked = null;
    setFilter("dept", null);
  });
}

async function fetchMap() {
  try {
    // Se omite `dept` para que el mapa no colapse a una sola región al hacer clic en ella.
    const f = activeFilters();
    const mapFilters = { ...f, dept: null };
    const res = await api("/api/map", mapFilters);
    renderMap(res.data || []);
  } catch (e) { console.warn("map falló", e); }
}

function renderMap(rows) {
  const byDept = new Map(rows.map(r => [normalize(r.department), r]));
  const container = document.getElementById("mapContainer");
  const svg = d3.select("#map-svg");
  const W = container.clientWidth || 800, H = container.clientHeight || 520;
  svg.attr("viewBox", `0 0 ${W} ${H}`);

  const maxIrc = d3.max(rows, r => r.irc) || 100;
  const colorScale = d3.scaleSequential(d3.interpolateYlOrRd).domain([0, Math.max(40, maxIrc)]);

  if (!mapProjection) {
    mapProjection = d3.geoMercator().fitSize([W - 20, H - 20], state.geo);
    mapProjection.translate([mapProjection.translate()[0] + 10, mapProjection.translate()[1] + 10]);
    mapPathGen = d3.geoPath().projection(mapProjection);
  }

  let gAll = svg.select("g.map-root");
  if (gAll.empty()) {
    gAll = svg.append("g").attr("class", "map-root");
    mapZoom = d3.zoom().scaleExtent([1, 8]).on("zoom", e => gAll.attr("transform", e.transform));
    svg.call(mapZoom);
    svg.on("dblclick.zoom", null);
    svg.on("dblclick", () => { state.mapLocked = null; setFilter("dept", null); });
  }

  const tt = document.getElementById("mapTooltip");
  const paths = gAll.selectAll("path.dept-path").data(state.geo.features, d => d.properties.NOMBDEP);
  paths.join(
    enter => enter.append("path").attr("class", "dept-path").attr("d", mapPathGen),
    update => update,
    exit => exit.remove()
  )
    .attr("d", mapPathGen)
    .attr("fill", d => {
      const row = byDept.get(normalize(d.properties.NOMBDEP));
      return row ? colorScale(row.irc) : "#eef0f5";
    })
    .classed("locked", d => state.mapLocked && normalize(d.properties.NOMBDEP) === normalize(state.mapLocked))
    .on("mousemove", (e, d) => {
      const row = byDept.get(normalize(d.properties.NOMBDEP));
      const b = container.getBoundingClientRect();
      let x = e.clientX - b.left + 14, y = e.clientY - b.top - 8;
      if (x + 250 > b.width) x = e.clientX - b.left - 254;
      tt.style.left = x + "px"; tt.style.top = y + "px";
      if (!row) { tt.innerHTML = `<b>${d.properties.NOMBDEP}</b><div class="dim">Sin contratos en el filtro actual</div>`; }
      else {
        tt.innerHTML = `
          <b>${d.properties.NOMBDEP}</b>
          <div>IRC compuesto: <b>${row.irc}</b> / 100</div>
          <div class="dim">${fmtNum(row.count)} contratos · ${fmtS(row.total_amount)}</div>
          <div style="margin-top:6px;">
            <div class="dim">Sin competencia: ${row.breakdown.sin_competencia_pct}%</div>
            <div class="tt-bar"><div style="width:${row.breakdown.sin_competencia_pct}%;background:${COMP_COLOR}"></div></div>
            <div class="dim" style="margin-top:4px;">Sobrecostos: ${row.breakdown.sobrecostos_pct}%</div>
            <div class="tt-bar"><div style="width:${row.breakdown.sobrecostos_pct}%;background:${RISK_COLORS[3]}"></div></div>
            <div class="dim" style="margin-top:4px;">Fin de año (nov-dic): ${row.breakdown.fin_de_anio_pct}%</div>
            <div class="tt-bar"><div style="width:${row.breakdown.fin_de_anio_pct}%;background:${PROV_COLOR}"></div></div>
          </div>`;
      }
      tt.style.display = "block";
    })
    .on("mouseleave", () => { tt.style.display = "none"; })
    .on("click", (e, d) => {
      e.stopPropagation();
      const name = d.properties.NOMBDEP;
      state.mapLocked = name;
      setFilter("dept", name);
    });

  renderMapLegend(colorScale);
}

function renderMapLegend(colorScale) {
  const leg = document.getElementById("map-legend");
  const stops = 6;
  const domain = colorScale.domain();
  let bars = "";
  for (let i = 0; i < stops; i++) bars += `<div style="background:${colorScale(domain[0] + (domain[1] - domain[0]) * i / (stops - 1))}"></div>`;
  leg.innerHTML = `
    <div class="leg-title">Índice de Riesgo Compuesto (IRC)</div>
    <div class="legend-scale">${bars}</div>
    <div style="display:flex;justify-content:space-between;color:var(--muted);font-size:10px;width:160px;">
      <span>Bajo</span><span>Alto</span>
    </div>
    <div style="margin-top:6px;color:var(--muted);font-size:10px;">Clic: fija región · Doble clic: vista nacional</div>
  `;
}

// -----------------------------------------------------------------
// 8. TREEMAP DE CONCENTRACIÓN (2.3)
// -----------------------------------------------------------------
function setupTreemapEvents() { /* la interacción vive en las celdas, ver renderTreemap */ }

async function fetchTreemap() {
  try {
    const f = activeFilters();
    const res = await api("/api/treemap", { ...f, entity: state.treemap.entity });
    renderTreemap(res);
    renderBreadcrumb(res.level);
  } catch (e) { console.warn("treemap falló", e); }
}

function renderBreadcrumb(level) {
  const el = document.getElementById("tmBreadcrumb");
  const parts = [`<span data-reset="all">Perú</span>`];
  if (state.filters.dept) parts.push(`<span class="sep">›</span>`, `<span data-reset="dept">${escapeHtml(state.filters.dept)}</span>`);
  if (state.treemap.entity) parts.push(`<span class="sep">›</span>`, `<span data-reset="entity">${escapeHtml(state.treemap.entity)}</span>`);
  el.innerHTML = parts.join(" ");
  el.querySelectorAll("span[data-reset]").forEach(s => s.addEventListener("click", () => {
    const k = s.dataset.reset;
    if (k === "all") { state.treemap.entity = null; setFilter("dept", null); }
    else if (k === "dept") { state.treemap.entity = null; refreshAll(); }
  }));
}

function renderTreemap(payload) {
  const children = payload.children || [];
  const container = document.getElementById("treemapContainer");
  const svg = d3.select("#treemap-svg");
  const W = container.clientWidth || 700, H = container.clientHeight || 520;
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  if (!children.length) {
    svg.append("text").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle")
      .attr("fill", "#9ca3af").attr("font-size", 13).text("Sin datos para este filtro");
    return;
  }

  const root = d3.hierarchy({ children }).sum(d => d.value || 0).sort((a, b) => b.value - a.value);
  d3.treemap().size([W, H]).paddingInner(2).paddingOuter(2).round(true)(root);

  const tt = document.getElementById("tmTooltip");
  const level = payload.level;

  const cell = svg.selectAll("g.tm-cell").data(root.leaves(), d => d.data.name).join("g")
    .attr("class", "tm-cell")
    .attr("transform", d => `translate(${d.x0},${d.y0})`)
    .style("cursor", "pointer");

  cell.append("rect")
    .attr("width", d => Math.max(0, d.x1 - d.x0))
    .attr("height", d => Math.max(0, d.y1 - d.y0))
    .attr("fill", d => BUCKET_HEX[d.data.color] || "#a3a3a3")
    .attr("rx", 4);

  cell.append("text").attr("x", 8).attr("y", 18).attr("font-size", 12)
    .text(d => (d.x1 - d.x0) > 60 ? truncateLabel(d.data.name, d.x1 - d.x0) : "");
  cell.append("text").attr("class", "tm-sub").attr("x", 8).attr("y", 34).attr("font-size", 10)
    .text(d => (d.x1 - d.x0) > 90 && (d.y1 - d.y0) > 40 ? fmtS(d.data.value) : "");

  cell.on("mousemove", (e, d) => {
    const b = container.getBoundingClientRect();
    let x = e.clientX - b.left + 14, y = e.clientY - b.top - 8;
    if (x + 260 > b.width) x = e.clientX - b.left - 264;
    tt.style.left = x + "px"; tt.style.top = y + "px";
    tt.innerHTML = `
      <b>${escapeHtml(d.data.name)}</b>
      <div>${fmtS(d.data.value)} · ${d.data.n_contratos} contrato${d.data.n_contratos !== 1 ? "s" : ""}</div>
      <div class="dim">Ahorro promedio: ${fmtPct(d.data.saving_pct)}</div>
      <div class="dim">Postores promedio: ${d.data.avg_postores}</div>
      <div style="margin-top:4px;"><span class="pill" style="background:${BUCKET_HEX[d.data.color]}22;color:${BUCKET_HEX[d.data.color]};border:1.5px solid ${BUCKET_HEX[d.data.color]}">${d.data.color}</span></div>
    `;
    tt.style.display = "block";
  }).on("mouseleave", () => tt.style.display = "none");

  cell.on("click", (e, d) => {
    e.stopPropagation();
    openSidePanel("treemap", d.data);
    if (level === "departamento") { state.mapLocked = d.data.name; setFilter("dept", d.data.name); }
    else if (level === "entidad") { state.treemap.entity = d.data.name; state.qLabel = d.data.name; setFilter("q", d.data.name); }
    else { setFilter("proc_type", d.data.name); }
  });
}

function truncateLabel(name, widthPx) {
  const maxChars = Math.floor(widthPx / 7);
  return name.length > maxChars ? name.slice(0, maxChars - 1) + "…" : name;
}

// -----------------------------------------------------------------
// 9. GRÁFICO TEMPORAL DUAL (2.4)
// -----------------------------------------------------------------
const MONTH_LABELS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
let temporalXScale = null;

function setupTemporalEvents() { /* brush se configura en cada render (necesita la escala actualizada) */ }

async function fetchTemporal() {
  try {
    const f = activeFilters();
    const res = await api("/api/temporal", f);
    renderTemporal(res.data || []);
  } catch (e) { console.warn("temporal falló", e); }
}

function renderTemporal(rows) {
  const container = document.getElementById("temporalContainer");
  const svg = d3.select("#temporal-svg");
  const W = container.clientWidth || 900, H = container.clientHeight || 280;
  const margin = { top: 16, right: 46, bottom: 26, left: 56 };
  svg.attr("viewBox", `0 0 ${W} ${H}`);
  svg.selectAll("*").remove();

  const iw = W - margin.left - margin.right, ih = H - margin.top - margin.bottom;
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleBand().domain(d3.range(1, 13)).range([0, iw]).padding(0.28);
  temporalXScale = x;
  const yAmount = d3.scaleLinear().domain([0, d3.max(rows, r => r.total_amount) || 1]).nice().range([ih, 0]);
  const ySaving = d3.scaleLinear().domain(d3.extent(rows, r => r.avg_saving_pct).map((v, i) => i === 0 ? Math.min(v, 0) : Math.max(v, 0.01))).nice().range([ih, 0]);

  // Banda roja = rango actualmente resaltado (por defecto nov-dic; se ajusta con la selección)
  const activeMonths = state.filters.months ? String(state.filters.months).split(",").map(Number) : [11, 12];
  activeMonths.forEach(m => {
    if (!x(m) && x(m) !== 0) return;
    g.append("rect").attr("class", "eoy-band")
      .attr("x", x(m)).attr("width", x.bandwidth()).attr("y", 0).attr("height", ih);
  });

  // Ejes
  g.append("g").attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).tickFormat(m => MONTH_LABELS[m - 1]))
    .call(sel => sel.selectAll("text").attr("font-size", 10).attr("fill", "#6b7280"))
    .call(sel => sel.select(".domain").attr("stroke", "#e4e7f0"));
  g.append("g").call(d3.axisLeft(yAmount).ticks(5).tickFormat(v => fmtS(v)))
    .call(sel => sel.selectAll("text").attr("font-size", 9.5).attr("fill", "#6b7280"))
    .call(sel => sel.select(".domain").remove())
    .call(sel => sel.selectAll(".tick line").attr("stroke", "#f0f2f5"));
  g.append("g").attr("transform", `translate(${iw},0)`).call(d3.axisRight(ySaving).ticks(5).tickFormat(v => (v * 100).toFixed(0) + "%"))
    .call(sel => sel.selectAll("text").attr("font-size", 9.5).attr("fill", RISK_COLORS[3]))
    .call(sel => sel.select(".domain").remove());

  // Barras de monto
  const bars = g.selectAll("rect.bar").data(rows, d => d.month).join("rect").attr("class", "bar")
    .attr("x", d => x(d.month)).attr("width", x.bandwidth())
    .attr("y", d => yAmount(d.total_amount)).attr("height", d => ih - yAmount(d.total_amount))
    .attr("rx", 3)
    .attr("fill", d => (String(state.filters.months || "").split(",").map(Number).includes(d.month)) ? "var(--accent)" : (d.is_end_of_year ? "#fca5a5" : "#c4b5fd"))
    .style("cursor", "pointer");

  // Línea de ahorro promedio
  const line = d3.line().x(d => x(d.month) + x.bandwidth() / 2).y(d => ySaving(d.avg_saving_pct)).curve(d3.curveMonotoneX);
  g.append("path").datum(rows).attr("fill", "none").attr("stroke", RISK_COLORS[3]).attr("stroke-width", 2.5).attr("d", line);
  g.selectAll("circle.dot").data(rows, d => d.month).join("circle").attr("class", "dot")
    .attr("cx", d => x(d.month) + x.bandwidth() / 2).attr("cy", d => ySaving(d.avg_saving_pct)).attr("r", 3.5)
    .attr("fill", RISK_COLORS[3]).attr("stroke", "white").attr("stroke-width", 1.2);

  const tt = document.getElementById("temporalTooltip");
  function showTT(e, d) {
    const b = container.getBoundingClientRect();
    let px = e.clientX - b.left + 14, py = e.clientY - b.top - 8;
    if (px + 230 > b.width) px = e.clientX - b.left - 234;
    tt.style.left = px + "px"; tt.style.top = py + "px";
    tt.innerHTML = `
      <b>${MONTH_LABELS[d.month - 1]}</b>
      <div>${fmtS(d.total_amount)} adjudicados</div>
      <div class="dim">${fmtNum(d.count)} contratos</div>
      <div class="dim">Ahorro promedio: <b style="color:${RISK_COLORS[3]}">${fmtPct(d.avg_saving_pct)}</b></div>
      ${d.is_end_of_year ? `<div class="dim" style="color:${RISK_COLORS[3]}">⚠ Temporada de cierre de año</div>` : ""}
    `;
    tt.style.display = "block";
  }
  bars.on("mousemove", showTT).on("mouseleave", () => tt.style.display = "none")
    .on("click", (e, d) => {
      e.stopPropagation();
      openSidePanel("treemap", { name: MONTH_LABELS[d.month - 1], value: d.total_amount, n_contratos: d.count, avg_postores: "—", saving_pct: d.avg_saving_pct });
      const cur = state.filters.months;
      setFilter("months", cur === String(d.month) ? null : String(d.month));
    });
  g.selectAll("circle.dot").on("mousemove", showTT).on("mouseleave", () => tt.style.display = "none");

  // Brush temporal (arrastrar para seleccionar rango de meses)
  const brush = d3.brushX().extent([[0, 0], [iw, ih]]).on("end", (e) => {
    if (!e.selection) return;
    const [x0, x1] = e.selection;
    const months = d3.range(1, 13).filter(m => {
      const bx = x(m) + x.bandwidth() / 2;
      return bx >= x0 && bx <= x1;
    });
    if (months.length) setFilter("months", months.join(","));
    gBrush.call(brush.move, null); // limpiar el rectángulo visual; el resaltado real es la banda roja
  });
  const gBrush = g.append("g").attr("class", "brush").call(brush);
}

// -----------------------------------------------------------------
// 10. GRAFO DE RELACIONES ENTIDAD-PROVEEDOR (2.5)
//     Estilo visual replicado del dashboard de referencia del cliente.
// -----------------------------------------------------------------
// =====================================================================
// [REESCRITO] Grafo de Relaciones con Sigma.js (WebGL) sobre graphology
// =====================================================================
// Por qué se dejó de usar D3+SVG: cada nodo/arista era un elemento <circle>/
// <line> del DOM. Eso escala mal pasado unos pocos miles de elementos
// (reflow/repaint). Sigma.js dibuja todo en un único <canvas> WebGL, así
// que aguanta decenas de miles de nodos/aristas sin que el navegador sufra.
//
// Estrategia de nivel de detalle (LOD) elegida: en vez de sincronizar la
// cámara de Sigma con bounding-boxes del backend en tiempo real (frágil de
// verificar sin poder probar WebGL real en el entorno de desarrollo), se
// usa el mismo patrón de "drill-down" que ya tiene el Treemap (sección 2.3):
//   - Vista general (macro): un nodo por comunidad Louvain (islas).
//   - Clic en un macronodo -> profundiza a las entidades reales de esa
//     comunidad (vista micro filtrada por `community` en el backend).
//   - Botón "‹ Volver a vista general" -> vuelve a macro.
//   - Doble clic en cualquier nodo -> ego-network (sección 2.5), como antes.
// Esto mantiene la interacción "selecciona para filtrar, clic para
// profundizar" de la especificación sin depender de matemática de cámara
// que no se puede validar end-to-end en este sandbox (sin acceso de red a
// los CDN de sigma/graphology desde las herramientas de este entorno).

let sigmaInstance = null;
let graphologyGraph = null;
let sizeScale = null, edgeWidthScale = null;
let graphSelected = null; // {type:'node'|'edge', data}

function setupGraphEvents() {
  document.getElementById("btn-comunidad").addEventListener("click", () => setGraphColorMode("comunidad"));
  document.getElementById("btn-tipo").addEventListener("click", () => setGraphColorMode("tipo"));
  document.getElementById("btn-riesgo").addEventListener("click", () => setGraphColorMode("riesgo"));
  document.getElementById("btnGraphReset").addEventListener("click", () => { clearGraphSelection(); });

  document.getElementById("graphSearch").addEventListener("input", debounce(e => {
    const q = normalize(e.target.value);
    if (!q) { clearGraphSelection(); return; }
    const match = state.graph.nodesArr.find(n => !n.is_macro && normalize(n.label || "").includes(q));
    if (match) { selectGraphNode(match, { pan: true }); return; }
    // La entidad buscada puede no estar entre los nodos ya cargados (p.ej.
    // estamos en la vista macro, donde solo hay 36 burbujas de comunidad).
    // El backend sabe buscar por nombre sobre TODAS las entidades activas
    // y devolver directamente su ego-network (misma ruta que el doble clic).
    state.graph.focusMode = { id: e.target.value.trim(), label: e.target.value.trim() };
    fetchGraph();
  }, 250));

  // [NUEVO] El slider filtra en el CLIENTE (oculta aristas vía reducer de
  // Sigma) sin volver a pedir datos al backend, tal como recomienda la
  // arquitectura híbrida: "el slider... se gestiona completamente en el
  // cliente... sin requerir nuevas consultas al servidor".
  const slider = document.getElementById("edgeSlider");
  slider.addEventListener("input", () => {
    document.getElementById("edgeSliderVal").textContent = fmtS(+slider.value);
    state.graph.min_edge_amount = +slider.value;
    if (sigmaInstance) sigmaInstance.refresh();
  });

  document.getElementById("btnPhysicsToggle").addEventListener("click", togglePhysics);
  document.getElementById("btnPhysicsReset").addEventListener("click", resetGraphLayout);
  document.getElementById("btnExitFocus").addEventListener("click", exitGraphFocus);
  document.getElementById("btnBackToMacro").addEventListener("click", backToMacroView);
}

async function fetchGraph() {
  document.getElementById("graph-loading").style.display = "flex";
  try {
    const f = activeFilters();
    const params = { ...f };
    if (state.graph.focusMode) {
      params.focus = state.graph.focusMode.id;
      params.focus_depth = 1;
    } else {
      params.lod = state.graph.lod;
      if (state.graph.lod === "micro" && state.graph.drillCommunity !== null) {
        params.community = state.graph.drillCommunity;
      }
    }
    const res = await api("/api/graph", params);
    renderGraph(res);
  } catch (e) {
    console.warn("graph falló", e);
  } finally {
    document.getElementById("graph-loading").style.display = "none";
  }
}

function updateLodBadge() {
  const badge = document.getElementById("lodBadge");
  if (state.graph.focusMode) {
    badge.textContent = "ego-network";
    badge.classList.add("micro");
  } else if (state.graph.lod === "micro") {
    badge.textContent = `comunidad ${state.graph.drillCommunity + 1} · clic para volver`;
    badge.classList.add("micro");
  } else {
    badge.textContent = "vista general (36 comunidades)";
    badge.classList.remove("micro");
  }
}

function renderGraph(G) {
  stopPhysics(true);
  const nodes = G.nodes || [], edges = G.edges || [], meta = G.meta || {};
  state.graph.meta = meta;
  state.graph.gridBounds = G.grid_bounds || {};
  const nodeById = new Map(nodes.map(d => [d.id, d]));
  const simEdges = edges.map(d => ({ ...d, source: nodeById.get(d.source), target: nodeById.get(d.target) }))
    .filter(d => d.source && d.target);
  state.graph.nodesArr = nodes;
  state.graph.edgesArr = simEdges;

  const maxEdgeAmt = d3.max(edges, e => e.total_monto) || 100000;
  const slider = document.getElementById("edgeSlider");
  if (+slider.max < maxEdgeAmt) slider.max = Math.ceil(maxEdgeAmt / 50000) * 50000;

  updateLodBadge();

  if (state.graph.focusMode) {
    document.getElementById("focusBanner").style.display = "flex";
    document.getElementById("focusBannerText").textContent = `Modo foco: ${state.graph.focusMode.label} (vecinos directos)`;
  } else {
    document.getElementById("focusBanner").style.display = "none";
  }

  if (!nodes.length) {
    if (graphologyGraph) graphologyGraph.clear();
    document.getElementById("graph-legend").innerHTML = "";
    return;
  }

  const montos = nodes.map(n => n.total_monto || 0);
  sizeScale = d3.scaleSqrt().domain([0, d3.quantile(montos.slice().sort(d3.ascending), 0.95) || 1]).range([4, 18]).clamp(true);
  const edgeMontos = simEdges.map(e => e.total_monto || 0);
  edgeWidthScale = d3.scaleSqrt().domain([0, d3.quantile(edgeMontos.slice().sort(d3.ascending), 0.9) || 1]).range([0.8, 4]).clamp(true);

  ensureSigmaInstance();
  graphologyGraph.clear();

  nodes.forEach(d => {
    graphologyGraph.addNode(d.id, {
      x: d.x, y: d.y,
      size: sizeScale(d.total_monto || 0) * (d.is_macro ? 1.6 : 1), // macronodos un poco más grandes, resumen visual
      color: nodeColorFn(d),
      label: d.is_macro ? d.label : d.label,
      raw: d,
    });
  });
  simEdges.forEach((e, i) => {
    if (!graphologyGraph.hasNode(e.source.id) || !graphologyGraph.hasNode(e.target.id)) return;
    const key = `e${i}_${e.source.id}_${e.target.id}`;
    if (graphologyGraph.hasEdge(e.source.id, e.target.id)) return; // evita aristas paralelas duplicadas visualmente
    graphologyGraph.addEdgeWithKey(key, e.source.id, e.target.id, {
      size: edgeWidthScale(e.total_monto || 0),
      color: "#94a3b8",
      raw: e,
    });
  });

  renderGraphLegend();
  sigmaInstance.refresh();
}

function ensureSigmaInstance() {
  if (sigmaInstance) return;
  graphologyGraph = new graphology.Graph();
  const container = document.getElementById("graph-sigma");
  sigmaInstance = new Sigma(graphologyGraph, container, {
    renderLabels: false, // se usa el tooltip propio (mismo look&feel que el resto del dashboard)
    enableEdgeClickEvents: true,
    enableEdgeHoverEvents: true,
    defaultEdgeColor: "#94a3b8",
    minEdgeThickness: 0.6,
    zIndex: true,
    nodeReducer: (id, attrs) => {
      const res = { ...attrs };
      const raw = attrs.raw;
      if (graphSelected) {
        const inHighlight = graphSelected.type === "node"
          ? (raw === graphSelected.data || state.graph.edgesArr.some(l => (l.source === graphSelected.data || l.target === graphSelected.data) && (l.source === raw || l.target === raw)))
          : (raw === graphSelected.data.source || raw === graphSelected.data.target);
        if (!inHighlight) res.color = fadeColor(attrs.color);
        if (raw === (graphSelected.type === "node" ? graphSelected.data : null)) {
          res.highlighted = true;
        }
      }
      return res;
    },
    edgeReducer: (id, attrs) => {
      const res = { ...attrs };
      const raw = attrs.raw;
      if ((raw.total_monto || 0) < state.graph.min_edge_amount) { res.hidden = true; return res; }
      if (graphSelected) {
        const keep = graphSelected.type === "edge" ? raw === graphSelected.data
          : (raw.source === graphSelected.data || raw.target === graphSelected.data);
        if (!keep) res.color = "#e5e7eb";
      }
      return res;
    },
  });

  let clickTimer = null;
  sigmaInstance.on("clickNode", ({ node }) => {
    const d = graphologyGraph.getNodeAttribute(node, "raw");
    if (d.is_macro) { drillIntoCommunity(d.comunidad); return; }
    // [FIX] Un clic simple dispara un filtro global en cascada
    // (selectGraphNode -> setFilter). Sin este pequeño margen, ese filtro
    // podía resolverse DESPUÉS del ego-network del doble clic y pisar el
    // modo foco (condición de carrera real, detectada probando con
    // Playwright: el primer clic de un doble clic ya dispara este handler).
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => selectGraphNode(d), 220);
  });
  sigmaInstance.on("doubleClickNode", ({ node, event }) => {
    clearTimeout(clickTimer);
    event.preventSigmaDefault?.();
    const d = graphologyGraph.getNodeAttribute(node, "raw");
    if (!d.is_macro) enterGraphFocus(d);
  });
  sigmaInstance.on("clickEdge", ({ edge }) => {
    const d = graphologyGraph.getEdgeAttribute(edge, "raw");
    if (!d.is_macro) selectGraphEdge(d);
  });
  sigmaInstance.on("clickStage", () => clearGraphSelection());

  const tt = document.getElementById("graphTooltip");
  const tooltipContainer = document.getElementById("plotGraph");
  function positionTT(event) {
    const b = tooltipContainer.getBoundingClientRect();
    let x = event.clientX - b.left + 14, y = event.clientY - b.top - 8;
    if (x + 260 > b.width) x = event.clientX - b.left - 264;
    if (y + 140 > b.height) y = event.clientY - b.top - 150;
    tt.style.left = x + "px"; tt.style.top = y + "px";
  }
  sigmaInstance.on("enterNode", ({ node, event }) => {
    const d = graphologyGraph.getNodeAttribute(node, "raw");
    if (d.is_macro) {
      tt.innerHTML = `
        <b>${escapeHtml(d.label)}</b><br><span class="dim">Clic para profundizar</span>
        <div><b>${fmtS(d.total_monto)}</b> <span class="dim">total en esta comunidad</span></div>
        <div class="dim">${d.n_contratos} contratos · ${d.n_entidades} entidades</div>
      `;
    } else {
      const r = Math.min(3, Math.round(d.avg_riesgo || 0));
      const tag = d.tipo === "comprador" ? "Comprador" : "Proveedor";
      tt.innerHTML = `
        <b>${escapeHtml(d.label)}</b><br><span class="dim">${tag}</span>
        <div><b>${fmtS(d.total_monto)}</b> <span class="dim">total</span></div>
        <div class="dim">${d.n_contratos} contrato${d.n_contratos !== 1 ? "s" : ""}</div>
        ${d.dept ? `<div class="dim">${d.dept}</div>` : ""}
        <div class="dim">Riesgo: <b>${RISK_LABELS[r]}</b></div>
      `;
    }
    positionTT(event); tt.style.display = "block";
  });
  sigmaInstance.on("leaveNode", () => tt.style.display = "none");
  sigmaInstance.on("enterEdge", ({ edge, event }) => {
    const d = graphologyGraph.getEdgeAttribute(edge, "raw");
    tt.innerHTML = `
      <b style="font-size:12px">${escapeHtml(d.source.label)} → ${escapeHtml(d.target.label)}</b>
      <div><b>${fmtS(d.total_monto)}</b> · ${d.n_contratos} contratos</div>
      ${d.metodo ? `<div class="dim">Método: ${escapeHtml(d.metodo)}</div>` : ""}
      ${d.max_riesgo !== undefined ? `<div class="dim">Riesgo máx: ${riskPill(d.max_riesgo)}</div>` : ""}
    `;
    positionTT(event); tt.style.display = "block";
  });
  sigmaInstance.on("leaveEdge", () => tt.style.display = "none");
}

function fadeColor(hex) {
  // atenúa un color hex a un gris muy claro para el "resto del grafo" al
  // resaltar un ego-network (equivalente a opacity:0.08 en la versión SVG)
  return "#e9eaee";
}

function nodeColorFn(d) {
  if (d.is_focus) return SEL_COLOR;
  if (state.graph.colorMode === "tipo") return d.tipo === "comprador" ? COMP_COLOR : PROV_COLOR;
  if (state.graph.colorMode === "riesgo") return RISK_COLORS[Math.min(3, Math.round(d.avg_riesgo || 0))];
  return communityColor(d.comunidad ?? -1);
}

function renderGraphLegend() {
  const leg = document.getElementById("graph-legend");
  const mode = state.graph.colorMode;
  if (mode === "tipo") {
    leg.innerHTML = `<div class="leg-title">Tipo</div>
      <div class="leg-row"><div class="leg-dot" style="background:${COMP_COLOR}"></div>Comprador</div>
      <div class="leg-row"><div class="leg-dot" style="background:${PROV_COLOR}"></div>Proveedor</div>`;
  } else if (mode === "riesgo") {
    leg.innerHTML = `<div class="leg-title">Riesgo promedio</div>` +
      RISK_LABELS.map((l, i) => `<div class="leg-row"><div class="leg-dot" style="background:${RISK_COLORS[i]}"></div>${l}</div>`).join("");
  } else {
    const n = state.graph.meta.n_comunidades || 0;
    const maxShow = Math.min(8, n);
    let html = `<div class="leg-title">Comunidades (Louvain)</div>`;
    for (let i = 0; i < maxShow; i++) html += `<div class="leg-row"><div class="leg-dot" style="background:${communityColor(i)}"></div>Comunidad ${i + 1}</div>`;
    if (n > maxShow) html += `<div class="leg-row" style="font-size:10px;color:var(--muted)">… y ${n - maxShow} más</div>`;
    leg.innerHTML = html;
  }
}
function setGraphColorMode(mode) {
  state.graph.colorMode = mode;
  document.querySelectorAll("#btn-comunidad,#btn-tipo,#btn-riesgo").forEach(b => b.classList.remove("active"));
  document.getElementById("btn-" + mode).classList.add("active");
  if (graphologyGraph) {
    graphologyGraph.forEachNode((id, attrs) => {
      graphologyGraph.setNodeAttribute(id, "color", nodeColorFn(attrs.raw));
    });
    sigmaInstance.refresh();
  }
  renderGraphLegend();
}

// ---- Drill-down macro -> comunidad (reemplaza el hover/clic de hulls) ----
function drillIntoCommunity(communityId) {
  state.graph.lod = "micro";
  state.graph.drillCommunity = communityId;
  fetchGraph();
}
function backToMacroView() {
  state.graph.lod = "macro";
  state.graph.drillCommunity = null;
  fetchGraph();
}

// ---- Selección / resaltado (ego-network visual, vía reducers de Sigma) ----
function selectGraphNode(d, { pan = false, cascade = true } = {}) {
  graphSelected = { type: "node", data: d };
  sigmaInstance.refresh();
  openSidePanel("node", d);
  if (cascade) { state.qLabel = d.label; setFilter("q", d.label); }
  refreshTableHighlight();
}
function selectGraphEdge(d) {
  graphSelected = { type: "edge", data: d };
  sigmaInstance.refresh();
  openSidePanel("edge", d);
}
function clearGraphSelection() {
  graphSelected = null;
  if (sigmaInstance) sigmaInstance.refresh();
}

// ---- Ego-network (foco) via backend focus= (doble clic) ----
function enterGraphFocus(d) {
  state.graph.focusMode = { id: d.id, label: d.label };
  fetchGraph();
}
function exitGraphFocus() {
  if (!state.graph.focusMode) return;
  state.graph.focusMode = null;
  document.getElementById("focusBanner").style.display = "none";
  fetchGraph();
}

// ---- Controles de física (d3-force sobre las posiciones ya calculadas) ----
// [NOTA ARQUITECTURA] Se sigue usando d3-force (ya cargado en la página)
// en vez de sumar graphology-layout-forceatlas2 vía CDN: ese paquete se
// distribuye como CommonJS puro sin build UMD para <script> plano, así que
// cargarlo con una etiqueta <script> directa es frágil. d3-force ya hace
// el mismo trabajo (relajar el layout) y aquí solo hace falta empujar los
// x,y resultantes al grafo de graphology en cada tick.
function togglePhysics() {
  state.graph.physicsOn ? stopPhysics() : startPhysics();
}
function startPhysics() {
  if (!graphologyGraph || !state.graph.nodesArr.length) return;
  state.graph.physicsOn = true;
  document.getElementById("btnPhysicsToggle").textContent = "⏸ Pausar física";
  document.getElementById("btnPhysicsToggle").classList.add("on");
  const nodes = state.graph.nodesArr, edges = state.graph.edgesArr;
  const simNodes = nodes.map(n => ({ id: n.id, x: n.x, y: n.y }));
  const sim = d3.forceSimulation(simNodes)
    .force("link", d3.forceLink(edges.map(e => ({ source: e.source.id, target: e.target.id }))).id(d => d.id).distance(0.12).strength(0.15))
    .force("charge", d3.forceManyBody().strength(-0.02))
    .force("collide", d3.forceCollide(d => 0.01 + sizeScale(nodeById_(d.id)?.total_monto || 0) * 0.0015))
    .alpha(0.9).alphaDecay(0.02)
    .on("tick", () => {
      simNodes.forEach(n => {
        if (graphologyGraph.hasNode(n.id)) graphologyGraph.mergeNodeAttributes(n.id, { x: n.x, y: n.y });
      });
      sigmaInstance.refresh();
    });
  state.graph.sim = sim;
}
function nodeById_(id) { return state.graph.nodesArr.find(n => n.id === id); }
function stopPhysics(silent) {
  if (state.graph.sim) { state.graph.sim.stop(); state.graph.sim = null; }
  state.graph.physicsOn = false;
  if (!silent) {
    const btn = document.getElementById("btnPhysicsToggle");
    if (btn) { btn.textContent = "▶ Reanudar física"; btn.classList.remove("on"); }
  }
}
function resetGraphLayout() {
  stopPhysics(true);
  const btn = document.getElementById("btnPhysicsToggle");
  if (btn) { btn.textContent = "▶ Reanudar física"; btn.classList.remove("on"); }
  fetchGraph(); // vuelve a proyectar las posiciones precalculadas por batch_layout.py
}

function selectNodeByLabel(label) {
  const match = state.graph.nodesArr.find(n => !n.is_macro && n.label === label);
  if (match) { selectGraphNode(match, { pan: true, cascade: false }); return; }
  // No está entre los nodos ya cargados (p.ej. estamos en vista macro):
  // pedimos su ego-network directamente al backend, igual que la búsqueda.
  state.graph.focusMode = { id: label, label };
  fetchGraph();
}
window.selectNodeByLabel = selectNodeByLabel;
window.backToMacroView = backToMacroView;

// -----------------------------------------------------------------
// 11. TABLA DE ALERTAS (2.6)
// -----------------------------------------------------------------
const TABLE_COLUMNS = [
  { key: "award_date", label: "Fecha" },
  { key: "department", label: "Depto." },
  { key: "buyer_name", label: "Entidad" },
  { key: "supplier_name", label: "Proveedor" },
  { key: "tender_amount", label: "Monto" },
  { key: "number_of_tenderers", label: "Postores" },
  { key: "saving_pct", label: "Ahorro" },
  { key: "risk_score", label: "IRC" },
  { key: "n_alertas", label: "Alertas" },
];

function setupTableEvents() {
  const head = document.getElementById("tableHead");
  head.innerHTML = `<th style="width:24px;"></th>` + TABLE_COLUMNS.map(c => `<th data-col="${c.key}">${c.label}<span class="arrow"></span></th>`).join("");
  head.querySelectorAll("th[data-col]").forEach(th => th.addEventListener("click", () => {
    const col = th.dataset.col;
    if (state.table.sort_by === col) state.table.sort_dir = state.table.sort_dir === "asc" ? "desc" : "asc";
    else { state.table.sort_by = col; state.table.sort_dir = "desc"; }
    state.table.offset = 0;
    fetchTable();
  }));

  document.getElementById("btnPrevPage").addEventListener("click", () => { state.table.offset = Math.max(0, state.table.offset - state.table.limit); fetchTable(); });
  document.getElementById("btnNextPage").addEventListener("click", () => { state.table.offset += state.table.limit; fetchTable(); });
  document.getElementById("btnClearSelection").addEventListener("click", () => { state.table.selected.clear(); renderGroupBar(); renderTableRows(state.table.rows); });
  document.getElementById("btnGroupSelected").addEventListener("click", groupSelectedRows);
}

async function fetchTable() {
  try {
    const f = activeFilters();
    const res = await api("/api/data", { ...f, sort_by: state.table.sort_by, sort_dir: state.table.sort_dir, limit: state.table.limit, offset: state.table.offset });
    state.table.total = res.total || 0;
    state.table.rows = res.data || [];
    renderTableRows(state.table.rows);
    updateSortArrows();
    updatePagination();
    document.getElementById("tableCount").textContent = `${fmtNum(state.table.total)} contratos en riesgo`;
  } catch (e) { console.warn("data falló", e); }
}

function updateSortArrows() {
  document.querySelectorAll("#tableHead th[data-col]").forEach(th => {
    const arrow = th.querySelector(".arrow");
    if (th.dataset.col === state.table.sort_by) arrow.textContent = state.table.sort_dir === "asc" ? "▲" : "▼";
    else arrow.textContent = "";
  });
}

function updatePagination() {
  const { offset, limit, total } = state.table;
  document.getElementById("pageInfo").textContent = total === 0 ? "Sin resultados" :
    `Mostrando ${offset + 1}–${Math.min(offset + limit, total)} de ${fmtNum(total)}`;
  document.getElementById("btnPrevPage").disabled = offset <= 0;
  document.getElementById("btnNextPage").disabled = offset + limit >= total;
}

function renderTableRows(rows) {
  const tbody = document.getElementById("tableBody");
  const activeLabel = graphSelected?.type === "node" ? graphSelected.data.label : null;
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:24px;">Sin contratos para este filtro</td></tr>`; return; }

  tbody.innerHTML = rows.map(r => {
    const highlighted = activeLabel && (r.buyer_name === activeLabel || r.supplier_name === activeLabel);
    const nAl = r.n_alertas || 0;
    const badgeClass = nAl === 0 ? "badge-0" : nAl <= 1 ? "badge-1" : nAl <= 3 ? "badge-2" : "badge-3";
    const saveClass = (r.saving_pct || 0) < 0 ? "save-neg" : "save-pos";
    return `
      <tr class="data-row ${highlighted ? "highlighted" : ""}" data-uid="${escapeHtml(r.row_uid)}">
        <td><input type="checkbox" data-check="${escapeHtml(r.row_uid)}" ${state.table.selected.has(r.row_uid) ? "checked" : ""} /></td>
        <td>${r.award_date ? new Date(r.award_date).toLocaleDateString("es-PE") : "—"}</td>
        <td>${escapeHtml(r.department || "—")}</td>
        <td title="${escapeHtml(r.buyer_name)}">${truncateLabel(r.buyer_name || "—", 140)}</td>
        <td title="${escapeHtml(r.supplier_name)}">${truncateLabel(r.supplier_name || "—", 140)}</td>
        <td class="amount-cell">${fmtS(r.tender_amount)}</td>
        <td>${r.number_of_tenderers ?? "—"}</td>
        <td class="${saveClass}">${fmtPct(r.saving_pct)}</td>
        <td>${(r.risk_score ?? 0).toFixed(0)}</td>
        <td><span class="badge-n ${badgeClass}">${nAl}</span></td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll('input[data-check]').forEach(chk => chk.addEventListener("click", e => e.stopPropagation()));
  tbody.querySelectorAll('input[data-check]').forEach(chk => chk.addEventListener("change", e => {
    const uid = chk.dataset.check;
    if (chk.checked) state.table.selected.add(uid); else state.table.selected.delete(uid);
    renderGroupBar();
  }));
  tbody.querySelectorAll("tr.data-row").forEach(tr => tr.addEventListener("click", () => openContractPanel(tr.dataset.uid)));
}

function refreshTableHighlight() { renderTableRows(state.table.rows); }

function renderGroupBar() {
  const bar = document.getElementById("groupBar");
  const n = state.table.selected.size;
  bar.classList.toggle("show", n > 0);
  document.getElementById("groupBarText").textContent = `${n} contrato${n !== 1 ? "s" : ""} seleccionado${n !== 1 ? "s" : ""}`;
}

async function groupSelectedRows() {
  if (!state.table.selected.size) return;
  try {
    const res = await apiPost("/api/group", { row_uids: Array.from(state.table.selected) });
    renderGroupSummary(res.stats);
    if (res.graph) renderGraph(res.graph); // vista temporal en el grafo, como pide la spec 2.6
  } catch (e) { alert("No se pudo agrupar la selección: " + e.message); }
}

function renderGroupSummary(stats) {
  const el = document.getElementById("groupSummary");
  el.classList.add("show");
  const depts = Object.entries(stats.departments || {}).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(", ");
  const types = Object.entries(stats.procurement_types || {}).slice(0, 5).map(([k, v]) => `${k} (${v})`).join(", ");
  el.innerHTML = `
    <div style="font-weight:800;font-size:12.5px;margin-bottom:8px;">📊 Vista agrupada de la selección</div>
    <div class="metrics-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
      <div class="d-card"><div class="d-card-title">Contratos</div><div style="font-size:16px;font-weight:800;">${fmtNum(stats.count)}</div></div>
      <div class="d-card"><div class="d-card-title">Monto total</div><div style="font-size:16px;font-weight:800;">${fmtS(stats.total_amount)}</div></div>
      <div class="d-card"><div class="d-card-title">Ahorro prom.</div><div style="font-size:16px;font-weight:800;">${fmtPct(stats.avg_saving_pct)}</div></div>
      <div class="d-card"><div class="d-card-title">IRC prom.</div><div style="font-size:16px;font-weight:800;">${(stats.avg_irc || 0).toFixed(1)}</div></div>
    </div>
    <div style="font-size:11.5px;color:var(--muted);margin-top:8px;">Departamentos: ${depts || "—"}</div>
    <div style="font-size:11.5px;color:var(--muted);">Procedimientos: ${types || "—"}</div>
    <button class="ghost-sm" style="margin-top:8px;" id="btnCloseGroupSummary">Cerrar vista agrupada</button>
  `;
  document.getElementById("btnCloseGroupSummary").addEventListener("click", () => {
    el.classList.remove("show"); el.innerHTML = "";
    fetchGraph();
  });
}

// -----------------------------------------------------------------
// 12. PANEL LATERAL — FICHA DEL CONTRATO (2.7)
// -----------------------------------------------------------------
function setupSidePanelEvents() {
  document.getElementById("btnCloseSide").addEventListener("click", closeSidePanel);
  document.getElementById("sideOverlay").addEventListener("click", closeSidePanel);
  document.getElementById("btnPin").addEventListener("click", togglePin);
  document.getElementById("spTabs").addEventListener("click", e => {
    const btn = e.target.closest(".sp-tab"); if (!btn) return;
    state.side.tab = btn.dataset.tab;
    document.querySelectorAll(".sp-tab").forEach(b => b.classList.toggle("active", b === btn));
    renderSideBody();
  });
  document.getElementById("btnGenReport").addEventListener("click", generateReport);
}

function togglePin() {
  state.side.pinned = !state.side.pinned;
  document.getElementById("btnPin").classList.toggle("pinned", state.side.pinned);
}

function openSidePanel(mode, data) {
  if (state.side.pinned) return; // el panel fijado ignora nuevas selecciones hasta despinar
  state.side.mode = mode; state.side.data = data; state.side.tab = "resumen";
  document.getElementById("sidePanel").classList.add("open");
  document.getElementById("sideOverlay").classList.add("open");
  const tabs = document.getElementById("spTabs");
  tabs.style.display = mode === "contract" ? "flex" : "none";
  tabs.querySelectorAll(".sp-tab").forEach((b, i) => b.classList.toggle("active", i === 0));
  renderSideHead();
  renderSideBody();
}
function closeSidePanel() {
  document.getElementById("sidePanel").classList.remove("open");
  document.getElementById("sideOverlay").classList.remove("open");
}

function renderSideHead() {
  const { mode, data } = state.side;
  const title = document.getElementById("spTitle"), sub = document.getElementById("spSubtitle");
  if (mode === "contract") {
    title.textContent = data.resumen_ejecutivo.buyer_name || "Contrato";
    sub.textContent = `Ficha del contrato · ${data.resumen_ejecutivo.contract_id || data.resumen_ejecutivo.row_uid}`;
  } else if (mode === "node") {
    title.textContent = data.label;
    sub.textContent = data.tipo === "comprador" ? "Entidad compradora" : "Proveedor";
  } else if (mode === "edge") {
    title.textContent = "Relación comprador–proveedor";
    sub.textContent = `${data.source.label} → ${data.target.label}`;
  } else if (mode === "dept") {
    title.textContent = data.department;
    sub.textContent = "Departamento — resumen de riesgo";
  } else if (mode === "treemap") {
    title.textContent = data.name;
    sub.textContent = "Concentración de contratos";
  }
}

function renderSideBody() {
  const body = document.getElementById("spBody");
  const { mode, data } = state.side;
  if (mode === "contract") { body.innerHTML = renderContractTab(data, state.side.tab); return; }
  if (mode === "node") { body.innerHTML = renderNodeCard(data); return; }
  if (mode === "edge") { body.innerHTML = renderEdgeCard(data); return; }
  if (mode === "dept") { body.innerHTML = renderDeptCard(data); return; }
  if (mode === "treemap") { body.innerHTML = renderTreemapCard(data); return; }
  body.innerHTML = `<div class="empty-st"><div class="ico">🔍</div><p>Sin selección.</p></div>`;
}

function renderContractTab(data, tab) {
  if (tab === "resumen") {
    const r = data.resumen_ejecutivo;
    return `
      <div class="d-card">
        <div class="d-card-title">Datos generales</div>
        <div class="d-row"><span class="d-k">Entidad</span><span class="d-v">${escapeHtml(r.buyer_name || "—")}</span></div>
        <div class="d-row"><span class="d-k">Proveedor</span><span class="d-v">${escapeHtml(r.supplier_name || "—")}</span></div>
        <div class="d-row"><span class="d-k">Departamento</span><span class="d-v">${escapeHtml(r.department || "—")}</span></div>
        <div class="d-row"><span class="d-k">Categoría</span><span class="d-v">${escapeHtml(r.category || "—")}</span></div>
        <div class="d-row"><span class="d-k">Procedimiento</span><span class="d-v">${escapeHtml(r.procurement_type || "—")}</span></div>
      </div>
      <div class="d-card">
        <div class="d-card-title">Montos y competencia</div>
        <div class="d-row"><span class="d-k">Monto</span><span class="d-v">${fmtS(r.tender_amount)}</span></div>
        <div class="d-row"><span class="d-k">N° postores</span><span class="d-v">${r.number_of_tenderers ?? "—"}</span></div>
        <div class="d-row"><span class="d-k">Ahorro (%)</span><span class="d-v">${fmtPct(r.saving_pct)}</span></div>
      </div>
      <button class="ghost-sm" style="width:100%;" onclick="selectNodeByLabel('${escapeHtml(r.buyer_name || "").replace(/'/g, "\\'")}')">Ver entidad en el grafo</button>
    `;
  }
  if (tab === "integridad") {
    const i = data.integridad_y_plazos;
    const flag = (v) => v === 1 ? `<span class="pill pill-ok">Completo</span>` : v === 0 ? `<span class="pill pill-bad">Falta</span>` : `<span class="pill pill-warn">N/D</span>`;
    return `
      <div class="d-card">
        <div class="d-card-title">Semáforo documental</div>
        <div class="d-row"><span class="d-k">Firma registrada</span><span class="d-v">${flag(i.has_signed)}</span></div>
        <div class="d-row"><span class="d-k">Detalle de ítem</span><span class="d-v">${flag(i.has_item_detail)}</span></div>
        <div class="d-row"><span class="d-k">Proyecto</span><span class="d-v">${flag(i.has_project)}</span></div>
        <div class="d-row"><span class="d-k">Contrato</span><span class="d-v">${flag(i.has_contract)}</span></div>
      </div>
      <div class="d-card">
        <div class="d-card-title">Plazos</div>
        <div class="d-row"><span class="d-k">Convocatoria</span><span class="d-v">${i.tender_date_published ? new Date(i.tender_date_published).toLocaleDateString("es-PE") : "—"}</span></div>
        <div class="d-row"><span class="d-k">Adjudicación</span><span class="d-v">${i.award_date ? new Date(i.award_date).toLocaleDateString("es-PE") : "—"}</span></div>
        <div class="d-row"><span class="d-k">Firma</span><span class="d-v">${i.date_signed ? new Date(i.date_signed).toLocaleDateString("es-PE") : "—"}</span></div>
      </div>
    `;
  }
  const alerts = data.alertas_disparadas || [];
  return alerts.length
    ? alerts.map(a => `<div class="alert-item">⚠ ${escapeHtml(a.label)}</div>`).join("")
    : `<div class="empty-st"><div class="ico">✅</div><p>Este contrato no disparó alertas de riesgo.</p></div>`;
}

function renderNodeCard(d) {
  const r = Math.min(3, Math.round(d.avg_riesgo || 0));
  const tag = d.tipo === "comprador" ? `<span class="pill pill-comp">🏛 Comprador</span>` : `<span class="pill pill-prov">🏢 Proveedor</span>`;
  const comm = (d.comunidad ?? -1) >= 0 ? d.comunidad + 1 : "—";
  const pairs = state.graph.edgesArr.filter(l => l.source === d || l.target === d)
    .map(l => ({ node: l.source === d ? l.target : l.source, edge: l })).sort((a, b) => b.edge.total_monto - a.edge.total_monto).slice(0, 10);
  return `
    <div style="margin-bottom:10px;">${tag} <span class="pill" style="background:${communityColor(d.comunidad ?? -1)}33;color:${communityColor(d.comunidad ?? -1)}">Comunidad ${comm}</span></div>
    <div class="d-card">
      <div class="d-card-title">Resumen</div>
      <div class="d-row"><span class="d-k">Monto total</span><span class="d-v">${fmtS(d.total_monto)}</span></div>
      <div class="d-row"><span class="d-k">Contratos</span><span class="d-v">${d.n_contratos}</span></div>
      <div class="d-row"><span class="d-k">Riesgo prom.</span><span class="d-v">${riskPill(r)}</span></div>
      <div class="d-row"><span class="d-k">Conexiones</span><span class="d-v">${pairs.length}</span></div>
      ${d.dept ? `<div class="d-row"><span class="d-k">Departamento</span><span class="d-v">${escapeHtml(d.dept)}</span></div>` : ""}
    </div>
    ${pairs.length ? `<div class="d-card">
      <div class="d-card-title">${d.tipo === "comprador" ? "Proveedores" : "Entidades"} principales</div>
      ${pairs.map(({ node: n, edge: l }) => `
        <div class="d-row"><span class="d-k" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(n.label)}</span><span class="d-v">${fmtS(l.total_monto)}</span></div>`).join("")}
    </div>` : ""}
  `;
}
function renderEdgeCard(d) {
  return `
    <div style="margin-bottom:10px;"><span class="pill pill-edge">📄 Relación</span></div>
    <div class="d-card">
      <div class="d-card-title">Resumen</div>
      <div class="d-row"><span class="d-k">Monto total</span><span class="d-v">${fmtS(d.total_monto)}</span></div>
      <div class="d-row"><span class="d-k">Contratos</span><span class="d-v">${d.n_contratos}</span></div>
      <div class="d-row"><span class="d-k">Método</span><span class="d-v">${escapeHtml(d.metodo || "—")}</span></div>
    </div>
    <div class="d-card">
      <div class="d-card-title">Riesgo</div>
      <div class="d-row"><span class="d-k">Máximo</span><span class="d-v">${riskPill(d.max_riesgo)}</span></div>
      <div class="d-row"><span class="d-k">Promedio</span><span class="d-v">${(d.avg_riesgo || 0).toFixed(2)}</span></div>
    </div>
    <button class="ghost-sm" style="width:100%;margin-bottom:6px;" onclick="selectNodeByLabel('${escapeHtml(d.source.label).replace(/'/g, "\\'")}')">Ver comprador</button>
    <button class="ghost-sm" style="width:100%;" onclick="selectNodeByLabel('${escapeHtml(d.target.label).replace(/'/g, "\\'")}')">Ver proveedor</button>
  `;
}
function renderDeptCard(row) {
  return `
    <div class="d-card">
      <div class="d-card-title">Índice de Riesgo Compuesto</div>
      <div class="d-row"><span class="d-k">IRC</span><span class="d-v">${row.irc}</span></div>
      <div class="d-row"><span class="d-k">Contratos</span><span class="d-v">${fmtNum(row.count)}</span></div>
      <div class="d-row"><span class="d-k">Monto total</span><span class="d-v">${fmtS(row.total_amount)}</span></div>
    </div>
    <div class="d-card">
      <div class="d-card-title">Desglose de riesgo</div>
      <div class="d-row"><span class="d-k">Sin competencia</span><span class="d-v">${row.breakdown.sin_competencia_pct}%</span></div>
      <div class="d-row"><span class="d-k">Sobrecostos</span><span class="d-v">${row.breakdown.sobrecostos_pct}%</span></div>
      <div class="d-row"><span class="d-k">Fin de año</span><span class="d-v">${row.breakdown.fin_de_anio_pct}%</span></div>
    </div>
  `;
}
function renderTreemapCard(d) {
  return `
    <div class="d-card">
      <div class="d-card-title">Concentración</div>
      <div class="d-row"><span class="d-k">Monto</span><span class="d-v">${fmtS(d.value)}</span></div>
      <div class="d-row"><span class="d-k">Contratos</span><span class="d-v">${d.n_contratos}</span></div>
      <div class="d-row"><span class="d-k">Postores prom.</span><span class="d-v">${d.avg_postores}</span></div>
      <div class="d-row"><span class="d-k">Ahorro prom.</span><span class="d-v">${fmtPct(d.saving_pct)}</span></div>
    </div>
  `;
}

async function openContractPanel(rowUid) {
  try {
    const data = await api(`/api/contract/${encodeURIComponent(rowUid)}`);
    openSidePanel("contract", data);
  } catch (e) { console.warn("contract falló", e); }
}

// -----------------------------------------------------------------
// 13. GENERAR EVIDENCIA PRELIMINAR (PDF) — 2.7 botón rojo
// -----------------------------------------------------------------
async function captureB64(elId) {
  try {
    const el = document.getElementById(elId);
    const canvas = await html2canvas(el, { backgroundColor: "#ffffff", scale: 1.4, logging: false });
    return canvas.toDataURL("image/png");
  } catch (e) { console.warn("No se pudo capturar " + elId, e); return null; }
}

async function generateReport() {
  const btn = document.getElementById("btnGenReport");
  btn.disabled = true; const original = btn.textContent; btn.textContent = "Generando evidencia…";
  try {
    const [mapImg, tmImg, graphImg, tableImg] = await Promise.all([
      captureB64("mapContainer"), captureB64("treemapContainer"), captureB64("plotGraph"), captureB64("tablePanel"),
    ]);
    const body = {
      filters: activeFilters(),
      contract_row_uid: state.side.mode === "contract" ? state.side.data.resumen_ejecutivo.row_uid : null,
      map_image_b64: mapImg, treemap_image_b64: tmImg, graph_image_b64: graphImg, table_image_b64: tableImg,
    };
    const res = await apiPost("/api/export/report", body);
    if (res.url) window.open(CONFIG.API_BASE + res.url, "_blank");
  } catch (e) {
    alert("No se pudo generar el PDF: " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = original;
  }
}