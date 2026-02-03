// =====================
// CONFIG API (Apps Script Web App)
// =====================
const API_BASE = "https://script.google.com/macros/s/AKfycbz3QTKuXXdx2KcNT2eRZ3-QtPAzivzVTmbWUawSa5Vm8HY1etdzOk8b_0_na5DFagjk/exec"; // termina en /exec

const LS_ID = "comidas_identity_v1";
const LS_STATE = "comidas_state_v1";

const syncEl = document.getElementById("sync");
const displayNameEl = document.getElementById("displayName");
const btnSaveIdentity = document.getElementById("btnSaveIdentity");

const searchEl = document.getElementById("search");
const btnReload = document.getElementById("btnReload");

const mealsEl = document.getElementById("meals");
const podiumEl = document.getElementById("podium");

const btnSubmitTop = document.getElementById("btnSubmitTop");
const btnSubmitPodium = document.getElementById("btnSubmitPodium");
const btnResults = document.getElementById("btnResults");
const btnResults2 = document.getElementById("btnResults2");
const btnResetVotes = document.getElementById("btnResetVotes");

const resultsEl = document.getElementById("results");
const resultsCard = document.getElementById("resultsCard");

const toastRoot = document.getElementById("toast-root");

// Guard simple: si falta algo crítico, avisar
if (!mealsEl || !podiumEl || !resultsEl || !syncEl) {
  alert("Faltan elementos en el HTML (ids). Revisá que existan: meals, podium, results, sync.");
}

let allMeals = [];                 // ahora: [{name,type}]
let selected = new Map();          // name -> score
let touched = new Set();           // name -> el usuario editó el puntaje (para no mostrar 8 gris)

// ===== Render scheduler (debounce) =====
let _mealsRenderTimer = null;
let _podiumRenderTimer = null;

function scheduleRenderMeals() {
  clearTimeout(_mealsRenderTimer);
  _mealsRenderTimer = setTimeout(() => {
    requestAnimationFrame(renderMeals);
  }, 60);
}

function scheduleRenderPodium() {
  clearTimeout(_podiumRenderTimer);
  _podiumRenderTimer = setTimeout(() => {
    requestAnimationFrame(renderPodium);
  }, 60);
}

let identity = { userId: "", displayName: "" };

// ===== UI helpers =====
function setSync(state, text) {
  syncEl.classList.remove("ok", "saving", "warn", "err");
  if (state) syncEl.classList.add(state);
  syncEl.querySelector(".txt").textContent = text;
}
function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function toast(msg, type="ok", small="") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `${escapeHtml(msg)}${small ? `<div class="small">${escapeHtml(small)}</div>` : ""}`;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "all .2s ease";
  }, 2400);
  setTimeout(() => el.remove(), 2700);
}

// ===== score =====
function parseScore(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // acepta coma o punto
  s = s.replace(",", ".");
  const n = Number(s);

  // 0..10, hasta 2 decimales (8.3, 9.75, etc)
  if (Number.isNaN(n) || n < 0 || n > 10) return null;

  return Math.round(n * 100) / 100;
}

// ===== JSONP GET =====
function apiGetJSONP(paramsObj) {
  return new Promise((resolve, reject) => {
    const cbName = "jsonp_cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);

    window[cbName] = (data) => { cleanup(); resolve(data); };

    const cleanup = () => {
      try { delete window[cbName]; } catch {}
      if (script && script.parentNode) script.parentNode.removeChild(script);
      clearTimeout(timer);
    };

    const qs = new URLSearchParams(paramsObj);
    qs.set("callback", cbName);
    qs.set("_", String(Date.now()));

    const url = `${API_BASE}?${qs.toString()}`;
    const script = document.createElement("script");
    script.src = url;
    script.onerror = () => { cleanup(); reject(new Error("JSONP error")); };

    const timer = setTimeout(() => { cleanup(); reject(new Error("JSONP timeout")); }, 12000);
    document.body.appendChild(script);
  });
}

// ===== POST submit =====
async function apiPostSubmitVotes(payload) {
  const url = `${API_BASE}?action=submitVotes`;
  await fetch(url, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
}

async function apiPostResetVotes() {
  // 1) intento ideal: JSONP (si el backend está actualizado)
  try {
    const resp = await apiGetJSONP({ action: "resetVotes" });
    if (resp?.ok) return resp;
    // si no ok, caemos al fallback
  } catch {}

  // 2) fallback: POST (puede funcionar aunque tu doGet sea viejo)
  //    OJO: no-cors => no podemos leer respuesta, pero igual dispara el borrado.
  const url = `${API_BASE}?action=resetVotes`;
  await fetch(url, {
    method: "POST",
    mode: "no-cors",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: "{}"
  });

  // 3) esperar un toque para que el sheet se actualice
  await new Promise(r => setTimeout(r, 600));

  return { ok: true, cleared: true, via: "post_fallback" };
}

async function loadStatus() {
  try {
    const resp = await apiGetJSONP({ action: "status" });
    if (!resp?.ok) return;
    const st = resp.status || {};

    if (st.hasVotes) {
      // más visible + info mínima útil
      setSync("ok", `Hay votos (${st.participants})`);
    } else {
      setSync("warn", "No hay votos (vacío)");
    }
  } catch {
    // si falla status, no rompas la app
  }
}

// ===== local storage =====
function persistIdentity() { localStorage.setItem(LS_ID, JSON.stringify(identity)); }
function loadIdentity() {
  try {
    const raw = localStorage.getItem(LS_ID);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p && p.userId) identity = p;
  } catch {}
}
function ensureUserId() {
  if (!identity.userId) identity.userId = "u_" + Math.random().toString(16).slice(2) + "_" + Date.now();
}
function persistState() {
  try { localStorage.setItem(LS_STATE, JSON.stringify({ selected: Array.from(selected.entries()) })); } catch {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (Array.isArray(p?.selected)) selected = new Map(p.selected);
  } catch {}
}

// ===== render =====
function normType(t) {
  const s = (t || "").toString().trim().toLowerCase();
  if (!s) return { key: "otro", label: "OTRO" };

  // ✅ Sheet: "saludable"
  if (s.includes("salud")) return { key: "saludable", label: "SALUDABLE" };

  // ✅ Sheet: "chatarra" -> lo tratamos como antojo
  if (s.includes("chatarr")) return { key: "antojo", label: "ANTOJO" };

  // ✅ por si en el futuro ponés "antojo"
  if (s.includes("anto")) return { key: "antojo", label: "ANTOJO" };

  // ✅ futuro: "merienda"
  if (s.includes("meri")) return { key: "merienda", label: "MERIENDA" };

  // fallback: muestra el texto original como etiqueta
  return { key: "otro", label: s.toUpperCase() };
}

function renderMeals() {
  const q = (searchEl.value || "").toLowerCase().trim();
  mealsEl.innerHTML = "";

  const list = !q
    ? allMeals
    : allMeals.filter(m => m.name.toLowerCase().includes(q));

  const groups = { saludable: [], antojo: [], merienda: [], otro: [] };

  for (const m of list) {
    const typeInfo = normType(m.type);
    const key = (typeInfo.key in groups) ? typeInfo.key : "otro";
    groups[key].push(m);
  }

  // ordenar alfabético dentro de cada grupo
  for (const k of Object.keys(groups)) {
    groups[k].sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  const order = [
    ["saludable", "SALUDABLES"],
    ["antojo", "ANTOJOS"],
    ["merienda", "MERIENDAS"],
    ["otro", "OTROS"]
  ];

  const totalCount = list.length;

  const addSectionHeader = (key, title, count) => {
    const sec = document.createElement("div");
    sec.className = `meals-section ${key}`;
    sec.innerHTML = `
      <div class="ttl">${escapeHtml(title)}</div>
      <div class="sub">${count} / ${totalCount}</div>
    `;
    mealsEl.appendChild(sec);
  };

  const buildMealRow = (m) => {
    const row = document.createElement("div");
    row.className = "meal";

    const typeInfo = normType(m.type);
    row.classList.add(`t-${typeInfo.key}`);

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = selected.has(m.name);

    chk.addEventListener("change", () => {
    if (chk.checked) {
        selected.set(m.name, selected.get(m.name) ?? 8);
        touched.delete(m.name);
    } else {
        selected.delete(m.name);
        touched.delete(m.name);
    }

    persistState();

    // ✅ En vez de re-render inmediato total, lo debounced
    scheduleRenderPodium();
    scheduleRenderMeals();
    });

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = m.name;

    const tag = document.createElement("span");
    tag.className = `tag ${typeInfo.key}`;
    tag.textContent = typeInfo.label;

    const mini = document.createElement("div");
    mini.className = "mini";
    mini.textContent = selected.has(m.name) ? `Puntaje: ${selected.get(m.name)}` : "—";

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.flexDirection = "column";
    right.style.alignItems = "flex-end";
    right.style.gap = "6px";
    right.appendChild(tag);
    right.appendChild(mini);

    row.append(chk, name, right);
    return row;
  };

  // render por secciones, con 2 columnas internas (orden vertical)
  let any = false;

  for (const [key, title] of order) {
    const arr = groups[key];
    if (!arr.length) continue;
    any = true;

    addSectionHeader(key, title, arr.length);

    // ✅ dividir alfabético en dos mitades:
    // primera mitad => columna izquierda (de arriba hacia abajo)
    // segunda mitad => columna derecha
    const half = Math.ceil(arr.length / 2);
    const leftArr = arr.slice(0, half);
    const rightArr = arr.slice(half);

    const wrap = document.createElement("div");
    wrap.className = "meals-two";

    const left = document.createElement("div");
    left.className = "meals-col";

    const right = document.createElement("div");
    right.className = "meals-col";

    for (const m of leftArr) left.appendChild(buildMealRow(m));
    for (const m of rightArr) right.appendChild(buildMealRow(m));

    wrap.append(left, right);
    mealsEl.appendChild(wrap);
  }

  if (!any) {
    mealsEl.innerHTML = `<div class="muted">No hay comidas para mostrar.</div>`;
  }
}

function renderPodium() {
  podiumEl.innerHTML = "";

  const arr = Array.from(selected.entries()).map(([meal, score]) => ({ meal, score }));
  arr.sort((a,b) => (b.score - a.score) || a.meal.toLowerCase().localeCompare(b.meal.toLowerCase()));

  if (!arr.length) {
    podiumEl.innerHTML = `<div class="muted">Todavía no seleccionaste comidas.</div>`;
    return;
  }

  arr.forEach((it, idx) => {
    const row = document.createElement("div");
    row.className = "pitem";

    const rank = document.createElement("div");
    rank.className = "rank";
    rank.textContent = String(idx + 1);

    const mealname = document.createElement("div");
    mealname.className = "mealname";
    mealname.textContent = it.meal;

    const inp = document.createElement("input");

    // ✅ teclado numérico + decimales
    inp.type = "number";
    inp.min = "0";
    inp.max = "10";
    inp.step = "0.01";       // ✅ decimales libres
    inp.inputMode = "decimal";

    inp.value = String(it.score);

    // 8 gris hasta que toque el input
    const isUntouchedDefault = (it.score === 8 && !touched.has(it.meal));
    inp.style.opacity = isUntouchedDefault ? "0.55" : "1";

    // al tocar: seleccionar todo (no tener que borrar)
    inp.addEventListener("focus", () => {
      try { inp.select(); } catch {}
      touched.add(it.meal);
      inp.style.opacity = "1";
    });

    inp.addEventListener("change", () => {
    const parsed = parseScore(inp.value);
    if (parsed === null) {
        toast("Puntaje inválido", "warn", "Usá 0–10 (ej: 8.3 o 7,25)");
        inp.value = String(it.score);
        return;
    }
    touched.add(it.meal);
    selected.set(it.meal, parsed);
    persistState();

    // ✅ Debounced
    scheduleRenderPodium();
    scheduleRenderMeals();
    });

    const btnX = document.createElement("button");
    btnX.className = "ghost";
    btnX.textContent = "Quitar";
    btnX.addEventListener("click", () => {
    selected.delete(it.meal);
    touched.delete(it.meal);
    persistState();

    // ✅ Debounced
    scheduleRenderPodium();
    scheduleRenderMeals();
    });

    row.append(rank, mealname, inp, btnX);
    podiumEl.appendChild(row);
  });
}

// ===== api flows =====
async function loadMeals() {
  setSync("saving", "Cargando comidas…");
  try {
    const resp = await apiGetJSONP({ action: "getMeals" });
    if (!resp?.ok) throw new Error(resp?.error || resp?.message || "getMeals failed");

    const raw = Array.isArray(resp.meals) ? resp.meals : [];

    // ✅ Compatibilidad:
    // - backend nuevo: [{name,type}, ...]
    // - backend viejo: ["Pizza", "Empanadas", ...]
    allMeals = raw
      .map((m) => {
        if (typeof m === "string") {
          return { name: m.trim(), type: "" };
        }
        // objeto
        const name = (m?.name ?? m?.meal ?? "").toString().trim();
        const type = (m?.type ?? "").toString().trim();
        return { name, type };
      })
      .filter(x => x.name);

    // dedupe por nombre (case-insensitive)
    const seen = new Set();
    allMeals = allMeals.filter(x => {
      const k = x.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // ordenar por nombre
    allMeals.sort((a,b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    setSync("ok", `Listo ✅ (${allMeals.length})`);
    renderMeals();

    if (allMeals.length === 0) {
      toast("No llegaron comidas", "warn", "Tu WebApp puede estar en versión vieja. Igual revisá hoja 'comidas'.");
    }
  } catch (err) {
    setSync("err", "No se pudo cargar");
    const msg = String(err?.message || err);
    toast("Error cargando comidas", "err", msg);
    console.error("loadMeals error:", err);
  }
}

async function submitOrShowResults() {
  // Si no hay votos locales, igual queremos ver resultados (si existen en el sheet)
  if (selected.size === 0) {
    setSync("saving", "Cargando resultado…");
    try {
      await loadResults();  // loadResults ya maneja "No hay votos" sin romper
    } catch {}
    return;
  }

  // Si hay votos locales, enviamos y después mostramos resultado (lo hace submitMyVotes)
  await submitMyVotes();
}

async function submitMyVotes() {
  const displayName = (displayNameEl.value || "").trim() || identity.userId;

  if (selected.size === 0) {
    toast("No hay votos", "warn", "Seleccioná al menos una comida");
    return;
  }

  identity.displayName = displayName;
  ensureUserId();
  persistIdentity();

  const votes = Array.from(selected.entries()).map(([meal, score]) => ({ meal, score }));

  setSync("saving", "Enviando votos…");
  try {
    await apiPostSubmitVotes({ userId: identity.userId, displayName, votes });

    toast("Votos enviados ✅", "ok", `Usuario: ${displayName}`);

    await Promise.all([
    loadStatus(),
    loadResults()
    ]);

  } catch (err) {
    setSync("err", "No se pudo enviar");
    toast("Error enviando votos", "err", String(err?.message || err));
  }
}

function medalClass(i) {
  if (i === 0) return { cls: "gold", icon: "🏆" };
  if (i === 1) return { cls: "silver", icon: "🥈" };
  if (i === 2) return { cls: "bronze", icon: "🥉" };
  return { cls: "", icon: String(i + 1) };
}

function renderResultsUI(data) {
  const participants = Array.isArray(data.participants) ? data.participants : [];
  const names = participants.length
    ? participants.map(p => p.name || p.displayName || p.userId).join(", ")
    : "—";

  const hasVotes = (data.hasVotes === true);
  if (!hasVotes) {
    resultsEl.innerHTML = `<div class="muted">No hay votos.</div>`;
    return;
  }

  const shared = Array.isArray(data.sharedRanking) ? data.sharedRanking : [];
  const solo   = Array.isArray(data.soloRanking) ? data.soloRanking : [];
  let winners  = Array.isArray(data.winners) ? data.winners : [];

  // =========================
  // Helpers: breakdown compacto (sin abrumar)
  // Ej: "Mauri 8 · Agus 10" o "Mauri 8 · Agus 10 · +2"
  // =========================
  const formatBreakdownCompact = (arr, maxPeople = 2) => {
    const b = Array.isArray(arr) ? arr : [];
    if (!b.length) return "";

    const parts = b.slice(0, maxPeople).map(x => `${x.name} ${x.score}`);
    const rest = b.length - maxPeople;

    return rest > 0
      ? `${parts.join(" · ")} · +${rest}`
      : parts.join(" · ");
  };

  // =========================
  // Fallback: si por algún motivo winners viene vacío,
  // lo calculamos acá (para que SIEMPRE salga ganador arriba)
  // Regla: si hay comunes -> ganan comunes (empatados); sino -> ganan individuales (empatados)
  // =========================
  if (!winners.length) {
    const pool = shared.length ? shared : solo;
    const bestSum = pool.length ? pool[0].sum : null;
    if (bestSum !== null && bestSum !== undefined) {
      winners = pool
        .filter(x => x.sum === bestSum)
        .map(x => ({
          meal: x.meal,
          sum: x.sum,
          breakdown: x.breakdown || [],
          isShared: !!x.isShared
        }));
    }
  }

  // Texto modo
  const modeText = shared.length
    ? "Gana una en común"
    : "No hay comunes";

  // =========================
  // Ranking con empates: mostramos números (1,1,3...)
  // ✅ IMPORTANTE: sacamos emojis 🏆🥈🥉 del listado.
  //    Los emojis quedan SOLO en el “Ganador grande”.
  // =========================
  const badgeClassByRank = (rankNum) => {
    if (rankNum === 1) return { cls: "gold", txt: "1" };
    if (rankNum === 2) return { cls: "silver", txt: "2" };
    if (rankNum === 3) return { cls: "bronze", txt: "3" };
    return { cls: "", txt: String(rankNum) };
  };

  const renderListWithTies = (arr) => {
    if (!arr.length) return `<div class="muted">—</div>`;

    let html = "";
    let prevSum = null;
    let rank = 0;   // rank real (1..)
    let idx = 0;    // índice visual (1..)

    for (const r of arr) {
      idx += 1;

      const curSum = Number(r.sum);
      // si cambia el sum => rank = idx, si empata => rank se mantiene
      if (prevSum === null || curSum !== prevSum) rank = idx;
      prevSum = curSum;

      const m = badgeClassByRank(rank);
      const breakdownLine = formatBreakdownCompact(r.breakdown, 2);

      html += `
        <div class="ritem compact">
          <div class="rank-badge ${m.cls}">${escapeHtml(m.txt)}</div>

          <div class="rname">
            ${escapeHtml(r.meal)}
            ${breakdownLine ? `
              <div class="muted" style="font-size:.82rem;margin-top:3px;">
                ${escapeHtml(breakdownLine)}
              </div>` : ``}
          </div>

          <div class="rmeta"><b>${escapeHtml(String(r.sum ?? ""))}</b></div>
        </div>
      `;
    }

    return html;
  };

  // =========================
  // Construcción HTML
  // =========================
  let html = `
    <div class="head">
      <div class="participants">Participantes: <b>${escapeHtml(names)}</b></div>
      <div class="mode">${escapeHtml(modeText)}</div>
    </div>
  `;

  // ✅ Ganador grande SIEMPRE que haya winners
  if (winners.length) {
    const isTie = winners.length > 1;
    const title = isTie ? "Ganadoras (empate)" : "Ganadora";

    const winnerNames = winners.map(w => escapeHtml(w.meal)).join(" / ");
    const scoreWin = winners[0]?.sum ?? "";

    // mostramos breakdown compacto del primer winner (no abrumar)
    const winBreakdown = formatBreakdownCompact(winners[0]?.breakdown, 3);

    html += `
      <div class="winner-card">
        <div class="winner-left"><div class="winner-icon">🏆</div></div>

        <div class="winner-mid">
          <div class="winner-title">${escapeHtml(title)}</div>
          <div class="winner-meal">${winnerNames}</div>

          ${winBreakdown ? `
            <div class="muted" style="font-size:.85rem;margin-top:4px;">
              ${escapeHtml(winBreakdown)}
            </div>` : ``}
        </div>

        <div class="winner-right">
          <div class="winner-score">${escapeHtml(String(scoreWin))}</div>
          <div class="winner-score-label">puntaje</div>
        </div>
      </div>
    `;
  } else {
    // si por algún caso extremo no hay winners, al menos no “se rompe”
    html += `<div class="muted">No se pudo determinar ganadora.</div>`;
  }

  html += `<div class="rlist">`;

  html += `<div class="rsection-title">En común</div>`;
  html += renderListWithTies(shared);

  html += `<div class="rsection-title">Individuales</div>`;
  html += renderListWithTies(solo);

  html += `</div>`;

  resultsEl.innerHTML = html;
}

async function loadResults() {
  setSync("saving", "Calculando…");
  try {
    const resp = await apiGetJSONP({ action: "getResults" });
    if (!resp?.ok) throw new Error(resp?.error || resp?.message || "getResults failed");

    renderResultsUI(resp);

    setSync("ok", "Listo ✅");
    if (resultsCard) resultsCard.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    setSync("err", "No se pudo calcular");
    const msg = String(err?.message || err);
    toast("Error cargando resultado", "err", msg);
    resultsEl.innerHTML = `<div class="muted">Error cargando resultado: ${escapeHtml(msg)}</div>`;
    console.error("loadResults error:", err);
  }
}

// ===== events =====
if (btnSaveIdentity) {
  btnSaveIdentity.addEventListener("click", () => {
    identity.displayName = (displayNameEl.value || "").trim();
    ensureUserId();
    persistIdentity();
    toast("Nombre guardado", "ok", "Queda en este navegador");
  });
}

if (btnReload) btnReload.addEventListener("click", loadMeals);
if (searchEl) searchEl.addEventListener("input", renderMeals);

if (btnSubmitTop) btnSubmitTop.addEventListener("click", submitOrShowResults);
if (btnSubmitPodium) btnSubmitPodium.addEventListener("click", submitOrShowResults);

if (btnResults) btnResults.addEventListener("click", loadResults);
if (btnResults2) btnResults2.addEventListener("click", loadResults);

if (btnResetVotes) {
  btnResetVotes.addEventListener("click", async () => {
    const ok = confirm("¿Vaciar TODOS los votos? (se borra para todos)");
    if (!ok) return;

    setSync("saving", "Vaciando…");
    try {
      await apiPostResetVotes();
      toast("Votos vaciados ✅", "ok");
      await loadStatus();
      resultsEl.innerHTML = `<div class="muted">No hay votos activos.</div>`;
      if (resultsCard) resultsCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setSync("err", "No se pudo vaciar");
      toast("Error vaciando", "err", String(err?.message || err));
    }
  });
}

// ===== init =====
window.addEventListener("load", async () => {
  loadIdentity();
  ensureUserId();
  displayNameEl.value = identity.displayName || "";

  loadState();
  renderPodium();

  // ✅ texto fijo de ambos botones (arriba y podio)
  if (btnSubmitTop) btnSubmitTop.textContent = "Enviar votos y ver resultado";
  if (btnSubmitPodium) btnSubmitPodium.textContent = "Enviar votos y ver resultado";

  // ✅ si todavía existieran botones viejos, afuera
  try { if (btnResults) btnResults.remove(); } catch {}
  try { if (btnResults2) btnResults2.remove(); } catch {}

  await loadMeals();
  await loadStatus();
});
