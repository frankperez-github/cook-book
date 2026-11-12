import * as api from './api.js';
import { YIELD_UNITS, YIELD_LABEL, YIELD_ONE, YIELD_STEP, fmtQty, UNITS, UNIT_LABEL, FAMILY_UNITS, FAMILY_DEFAULT, family, itemCost, analyze, fmtNum, fmtMoney, matchIngredient } from './calc.js';

const $app = document.getElementById('app');
const $ov = document.getElementById('overlay');
const $toast = document.getElementById('toast');

const S = { recipes: [], ings: [], set: { currency: '$', geminiReady: false } };
let draft = null; // recipe being edited
let pendingDraft = null; // draft coming from a photo scan
let scanFile = null;
let scanBusy = false;
let scanError = '';
let detailTab = 'ing';
let searchQ = '';
let urls = [];

/* ---------- helpers ---------- */
const uid = api.uid;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => fmtMoney(n, S.set.currency);
const ingMap = () => new Map(S.ings.map((i) => [i.id, i]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (m) => (m == null ? '' : `${Math.round(m * 100)}%`);

function imgUrl(x) {
  if (typeof x === 'string') return `/api/photos/${x}`; // already stored on the server
  const u = URL.createObjectURL(x);
  urls.push(u);
  return u;
}
function begin() {
  urls.forEach((u) => URL.revokeObjectURL(u));
  urls = [];
}
let toastT;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => ($toast.hidden = true), 2600);
}

async function resizeImage(file, max = 1280, q = 0.82) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bmp = await createImageBitmap(file);
  }
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', q));
}

function pickPhoto(cb, { capture = false } = {}) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  if (capture) inp.capture = 'environment';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      cb(await resizeImage(f, capture === 'scan' ? 1600 : 1280));
    } catch {
      toast('No pude abrir esa foto');
    }
  };
  inp.click();
}

function sheet(html, mount) {
  $ov.innerHTML = `<div class="sheet">${html}</div>`;
  $ov.hidden = false;
  const el = $ov.firstElementChild;
  mount?.(el);
  return el;
}
function closeSheet() {
  $ov.hidden = true;
  $ov.innerHTML = '';
}
$ov.addEventListener('click', (e) => {
  if (e.target === $ov) closeSheet();
});

async function load() {
  const d = await api.loadAll();
  S.recipes = d.recipes;
  S.ings = d.ings;
  S.set = d.set;
  loadedOnce = true;
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message);
  }
}

function viewLogin(msg = '') {
  begin();
  draft = null;
  $app.classList.remove('has-bar');
  $app.innerHTML = `<div class="page login">
    <img src="icons/logo.svg" alt="" width="112" height="112">
    <h1>Recetario</h1>
    <label class="field" style="width:100%"><span>Contraseña</span><input id="l-pass" type="password" autocomplete="current-password" autofocus></label>
    ${msg ? `<div class="err" style="width:100%">${esc(msg)}</div>` : ''}
    <button class="btn block" id="l-go">Entrar</button></div>`;
  const go = async () => {
    try {
      await api.login(document.getElementById('l-pass').value);
      await load();
      route();
    } catch (e) {
      viewLogin(e.message);
    }
  };
  document.getElementById('l-go').onclick = go;
  document.getElementById('l-pass').onkeydown = (e) => e.key === 'Enter' && go();
}
let loadedOnce = false;
api.setAuthHandler(() => viewLogin(loadedOnce ? 'Tu sesión expiró. Entra de nuevo.' : ''));

const nav = (on) => `
<nav class="nav"><div class="nav-in">
  <button data-go="#/" class="${on === 'home' ? 'on' : ''}"><span>🍰</span>Recetas</button>
  <button data-go="#/ing" class="${on === 'ing' ? 'on' : ''}"><span>🧂</span>Ingredientes</button>
  <button data-go="#/set" class="${on === 'set' ? 'on' : ''}"><span>⚙️</span>Ajustes</button>
</div></nav>`;

const topBar = (title, { back, right = '' } = {}) => `
<div class="top">
  ${back ? `<button class="icon-btn" data-go="${back}" aria-label="Volver">←</button>` : ''}
  <h1>${esc(title)}</h1>${right}
</div>`;

/* ---------- router ---------- */
function route() {
  closeSheet();
  window.scrollTo(0, 0);
  $app.classList.remove('has-bar');
  const [, a, b] = (location.hash.slice(1) || '/').split('/');
  if (a === 'r') return viewRecipe(b);
  if (a === 'e') return viewEdit(b);
  if (a === 'ing') return viewIngs();
  if (a === 'set') return viewSettings();
  if (a === 'scan') return viewScan();
  return viewHome();
}
window.addEventListener('hashchange', route);

/* ---------- home ---------- */
function listHtml() {
  const map = ingMap();
  const q = searchQ.trim().toLowerCase();
  const rs = S.recipes.filter((r) => !q || r.name.toLowerCase().includes(q)).sort((a, b) => b.updated - a.updated);
  if (!S.recipes.length) {
    return `<div class="empty"><div class="big">🍰</div><h2>Aún no tienes recetas</h2>
      <p>Toca el botón <b>＋</b> para crear la primera.</p></div>`;
  }
  if (!rs.length) return `<div class="empty"><p>No encontré «${esc(searchQ)}»</p></div>`;
  return rs
    .map((r) => {
      const a = analyze(r, map);
      const chip =
        a.sale <= 0 ? `<span class="chip warn">Sin precio</span>` : `<span class="chip ${a.profit < 0 ? 'bad' : ''}">${pct(a.margin)}</span>`;
      const sub = a.missing ? `⚠ Faltan precios de ingredientes` : `Costo ${money(a.per)} · Venta ${money(a.sale)}`;
      return `<button class="card" data-go="#/r/${r.id}">
        <div class="thumb">${r.cover ? `<img src="${imgUrl(r.cover)}" alt="">` : '🍰'}</div>
        <div class="info"><div class="name">${esc(r.name)}</div><div class="sub">${sub}</div></div>${chip}</button>`;
    })
    .join('');
}

function viewHome() {
  begin();
  $app.innerHTML = `${topBar('Mis recetas')}
  <div class="page">
    ${S.recipes.length >= 4 ? `<input class="search" id="search" type="search" placeholder="Buscar receta…" value="${esc(searchQ)}">` : ''}
    <div class="list" id="list">${listHtml()}</div>
  </div>
  <button class="fab" data-act="new" aria-label="Nueva receta">＋</button>${nav('home')}`;
}

function newSheet() {
  sheet(
    `<h2>Nueva receta</h2>
    <button class="opt" data-go="#/scan"><span class="e">📷</span><span><b>Foto de receta a mano</b><small>La leo con IA y la lleno por ti</small></span></button>
    <button class="opt" data-go="#/e/new"><span class="e">✍️</span><span><b>Escribirla yo</b><small>Desde cero</small></span></button>`
  );
}

/* ---------- recipe detail ---------- */
let scale = { id: null, want: 0 }; // how much the user wants to prepare (not saved)
const round2 = (n) => Math.round(n * 100) / 100;

// Everything that depends on the amount to prepare. Per-unit numbers never change; quantities and totals scale.
function scaledHtml(r, want) {
  const map = ingMap();
  const a = analyze(r, map);
  const f = want / a.y;
  const yu = r.yieldUnit || 'porciones';
  const one = YIELD_ONE[yu];
  const neg = a.profit < 0 ? 'neg' : '';
  const batchCost = a.total * f;
  const batchSale = a.sale * want;

  const ings = r.items
    .map((it) => {
      const ing = map.get(it.ingId);
      const c = itemCost(it, ing);
      return `<div class="ing-line"><div class="n">${esc(ing?.name || '¿?')}</div>
        <div class="q">${fmtQty(it.qty * f, it.unit)}</div>
        <div class="c ${c.ok ? '' : 'miss'}">${c.ok ? money(c.cost * f) : '—'}</div></div>`;
    })
    .join('');
  const steps = r.steps
    .map(
      (st, i) => `<div class="step"><div class="head"><div class="num">${i + 1}</div><p>${esc(st.text)}</p></div>
      ${st.photo ? `<img src="${imgUrl(st.photo)}" alt="Paso ${i + 1}">` : ''}</div>`
    )
    .join('');

  return `
    ${want !== a.y ? `<button class="text-btn" style="align-self:center" data-act="scale-reset">Volver a la receta original (${fmtNum(a.y)} ${YIELD_LABEL[yu]})</button>` : ''}
    <div class="stats">
      <div class="stat"><small>Costo</small><b>${money(a.per)}</b><em>por ${one}</em></div>
      <div class="stat"><small>Venta</small><b>${money(a.sale)}</b><em>por ${one}</em></div>
      <div class="stat profit ${neg}"><small>Ganancia</small><b>${a.sale > 0 ? money(a.profit) : '—'}</b><em>${a.sale > 0 ? pct(a.margin) : 'sin precio'}</em></div>
    </div>
    <p class="hint" style="text-align:center">Para ${fmtNum(want)} ${YIELD_LABEL[yu]}: costo <b>${money(batchCost)}</b>${a.sale > 0 ? ` · venta <b>${money(batchSale)}</b> · ganancia <b>${money(batchSale - batchCost)}</b>` : ''}</p>
    ${a.missing ? `<button class="note" style="border:0;text-align:left" data-go="#/ing">⚠ Faltan precios en ${a.missing} ingrediente(s). Toca para completarlos.</button>` : ''}
    <div class="seg">
      <button data-act="tab" data-tab="ing" class="${detailTab === 'ing' ? 'on' : ''}">Ingredientes</button>
      <button data-act="tab" data-tab="steps" class="${detailTab === 'steps' ? 'on' : ''}">Preparación</button>
    </div>
    ${
      detailTab === 'ing'
        ? `<div class="ing-list">${ings || '<p class="hint" style="padding:14px">Sin ingredientes</p>'}</div>`
        : steps || '<p class="hint" style="text-align:center;padding:14px">Esta receta no tiene pasos.</p>'
    }`;
}

function viewRecipe(id) {
  begin();
  const r = S.recipes.find((x) => x.id === id);
  if (!r) return (location.hash = '#/');
  if (scale.id !== id) scale = { id, want: r.yield };
  const yu = r.yieldUnit || 'porciones';
  $app.innerHTML = `${topBar(r.name, { back: '#/', right: `<button class="icon-btn" data-go="#/e/${r.id}" aria-label="Editar">✏️</button>` })}
  <div class="hero">${r.cover ? `<img src="${imgUrl(r.cover)}" alt="">` : '🍰'}</div>
  <div class="page">
    <div class="scale">
      <span>Preparar</span>
      <div class="stepper">
        <button data-act="scale-dec" aria-label="Menos">−</button>
        <input id="want" type="number" inputmode="decimal" step="any" min="0" value="${scale.want}">
        <button data-act="scale-inc" aria-label="Más">+</button>
      </div>
      <span class="unit">${YIELD_LABEL[yu]}</span>
    </div>
    <div id="scaled" class="page" style="padding:0">${scaledHtml(r, scale.want)}</div>
  </div>`;
  $app.dataset.rid = id;
}

function setWant(n) {
  const r = S.recipes.find((x) => x.id === scale.id);
  if (!r) return;
  scale.want = Math.max(0, n);
  document.getElementById('scaled').innerHTML = scaledHtml(r, scale.want);
}

/* ---------- recipe editor ---------- */
const blankDraft = () => ({ name: '', cover: null, yield: '', yieldUnit: 'porciones', salePrice: '', other: '', items: [], steps: [] });

function viewEdit(id) {
  if (id === 'new') {
    draft = pendingDraft || blankDraft();
    pendingDraft = null;
  } else {
    const r = S.recipes.find((x) => x.id === id);
    if (!r) return (location.hash = '#/');
    draft = structuredClone(r);
  }
  scale.id = null; // recompute the amount-to-prepare after editing
  renderEdit();
}

function renderEdit() {
  begin();
  const y = scrollY;
  const d = draft;
  const map = ingMap();
  const rows = d.items
    .map((it, i) => {
      const ing = map.get(it.ingId);
      const name = ing?.name || it.newName || '';
      const units = FAMILY_UNITS[family(it.unit)]
        .map((u) => `<option value="${u}" ${u === it.unit ? 'selected' : ''}>${UNIT_LABEL[u]}</option>`)
        .join('');
      return `<div class="edit-ing">
        <button class="pick ${name ? '' : 'empty-pick'} ${!ing && it.newName ? 'warn' : ''}" data-act="pick" data-i="${i}">${esc(name || 'Elegir ingrediente')}</button>
        <input type="number" inputmode="decimal" step="any" min="0" placeholder="0" value="${it.qty ?? ''}" data-item="qty" data-i="${i}" aria-label="Cantidad">
        <select data-item="unit" data-i="${i}" aria-label="Unidad">${units}</select>
        <button class="x" data-act="del-item" data-i="${i}" aria-label="Quitar">✕</button></div>`;
    })
    .join('');
  const steps = d.steps
    .map(
      (s, i) => `<div class="step-edit">
      <div class="acts"><span class="grow">Paso ${i + 1}</span>
        <button class="mini" data-act="step-photo" data-i="${i}">📷 ${s.photo ? 'Cambiar' : 'Foto'}</button>
        ${s.photo ? `<button class="mini danger" data-act="rm-step-photo" data-i="${i}">Quitar</button>` : ''}
        <button class="x" style="height:40px" data-act="del-step" data-i="${i}" aria-label="Quitar paso">✕</button></div>
      <textarea data-step="text" data-i="${i}" placeholder="Describe este paso…">${esc(s.text)}</textarea>
      ${s.photo ? `<img src="${imgUrl(s.photo)}" alt="">` : ''}</div>`
    )
    .join('');

  $app.classList.add('has-bar');
  $app.innerHTML = `${topBar(d.id ? 'Editar receta' : 'Nueva receta', { back: d.id ? `#/r/${d.id}` : '#/' })}
  <div class="page">
    <button class="cover-pick" data-act="cover">${d.cover ? `<img src="${imgUrl(d.cover)}" alt="">` : '📷 Foto de la receta'}</button>
    <label class="field"><span>Nombre</span><input data-f="name" value="${esc(d.name)}" placeholder="Ej: Tarta de frutilla" autocomplete="off"></label>
    <div class="row">
      <label class="field"><span>Rinde</span><input type="number" inputmode="decimal" step="any" min="0" data-f="yield" value="${d.yield ?? ''}" placeholder="12"></label>
      <label class="field"><span>Medido en</span><select data-f="yieldUnit">${YIELD_UNITS.map((u) => `<option value="${u}" ${u === (d.yieldUnit || 'porciones') ? 'selected' : ''}>${YIELD_LABEL[u]}</option>`).join('')}</select></label>
    </div>
    <div class="row">
      <label class="field"><span id="price-label">Precio de venta por ${YIELD_ONE[d.yieldUnit || 'porciones']}</span><input type="number" inputmode="decimal" step="any" min="0" data-f="salePrice" value="${d.salePrice ?? ''}" placeholder="0"></label>
    </div>
    <h2 class="section-title">Ingredientes</h2>
    ${rows}
    <button class="add" data-act="add-item">＋ Agregar ingrediente</button>
    <h2 class="section-title">Preparación</h2>
    ${steps}
    <button class="add" data-act="add-step">＋ Agregar paso</button>
    <details class="more"><summary>Más opciones</summary>
      <label class="field"><span>Otros costos de toda la receta (empaque, gas…)</span><input type="number" inputmode="decimal" step="any" min="0" data-f="other" value="${d.other ?? ''}" placeholder="0"></label>
    </details>
    ${d.id ? `<button class="btn danger block" data-act="delete">Eliminar receta</button>` : ''}
  </div>
  <div class="bar"><div class="bar-in"><div class="sum" id="sum"></div><button class="btn" data-act="save">Guardar</button></div></div>`;
  $app.querySelectorAll('textarea').forEach(grow);
  refreshSummary();
  window.scrollTo(0, y);
}

function grow(t) {
  t.style.height = 'auto';
  t.style.height = Math.max(64, t.scrollHeight) + 'px';
}

function refreshSummary() {
  const el = document.getElementById('sum');
  if (!el) return;
  const a = analyze(
    { items: draft.items.filter((i) => i.ingId), yield: draft.yield, salePrice: draft.salePrice, other: draft.other },
    ingMap()
  );
  if (a.sale > 0) {
    el.innerHTML = `Costo <b>${money(a.per)}</b> por ${YIELD_ONE[draft.yieldUnit || 'porciones']}<br>Ganancia <span class="profit ${a.profit < 0 ? 'neg' : ''}">${money(a.profit)} (${pct(a.margin)})</span>`;
  } else {
    el.innerHTML = `Costo <b>${money(a.per)}</b> por ${YIELD_ONE[draft.yieldUnit || 'porciones']}<br>Falta el precio de venta`;
  }
}

function ingredientPicker(i) {
  sheet(
    `<h2>Ingrediente</h2>
    <input class="search" id="pq" placeholder="Buscar o escribir uno nuevo…" autocomplete="off">
    <div class="list" id="pl"></div>`,
    (el) => {
      const inp = el.querySelector('#pq');
      const out = el.querySelector('#pl');
      const draw = () => {
        const q = inp.value.trim();
        const ql = q.toLowerCase();
        const found = S.ings.filter((x) => !ql || x.name.toLowerCase().includes(ql)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        let h = found
          .map((x) => `<button class="pick-item" data-pick="${x.id}">${esc(x.name)} ${x.price > 0 ? '' : '<small>· sin precio</small>'}</button>`)
          .join('');
        const exact = found.some((x) => x.name.toLowerCase() === ql);
        if (q && !exact) h += `<button class="pick-item new" data-create="${esc(q)}">＋ Crear «${esc(q)}»</button>`;
        if (!h) h = `<p class="hint" style="text-align:center;padding:14px">Escribe el nombre del ingrediente para crearlo.</p>`;
        out.innerHTML = h;
      };
      inp.addEventListener('input', draw);
      out.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const it = draft.items[i];
        if (b.dataset.pick) {
          const ing = S.ings.find((x) => x.id === b.dataset.pick);
          it.ingId = ing.id;
          it.newName = '';
          it.unit = FAMILY_DEFAULT[family(ing.unit)];
          closeSheet();
          renderEdit();
        } else if (b.dataset.create) {
          ingredientSheet({ name: b.dataset.create }, (ing) => {
            it.ingId = ing.id;
            it.newName = '';
            it.unit = FAMILY_DEFAULT[family(ing.unit)];
            renderEdit();
          });
        }
      });
      draw();
      if (!draft.items[i].ingId) setTimeout(() => inp.focus(), 50);
    }
  );
}

function findIng(name, fam) {
  return matchIngredient(name, S.ings.filter((i) => family(i.unit) === fam));
}

async function saveDraft(btn) {
  const d = draft;
  if (!d.name.trim()) {
    toast('Ponle un nombre a la receta');
    $app.querySelector('[data-f="name"]')?.focus();
    return;
  }
  btn.disabled = true;
  try {
  for (const it of d.items) {
    if (it.ingId || !it.newName?.trim()) continue;
    let ing = findIng(it.newName, family(it.unit));
    if (!ing) {
      const f = family(it.unit);
      ing = { id: uid(), name: cap(it.newName.trim()), price: 0, qty: 1, unit: f === 'g' ? 'kg' : f === 'ml' ? 'l' : 'u' };
      await api.putIngredient(ing);
      S.ings.push(ing);
    }
    it.ingId = ing.id;
  }
  const photoId = async (x) => (x instanceof Blob ? api.uploadPhoto(x) : x || null);
  const rec = {
    id: d.id || uid(),
    name: d.name.trim(),
    cover: await photoId(d.cover),
    yield: +d.yield > 0 ? +d.yield : 1,
    yieldUnit: d.yieldUnit || 'porciones',
    salePrice: +d.salePrice || 0,
    other: +d.other || 0,
    items: d.items.filter((i) => i.ingId).map((i) => ({ ingId: i.ingId, qty: +i.qty || 0, unit: i.unit })),
    steps: await Promise.all(d.steps.filter((s) => s.text.trim() || s.photo).map(async (s) => ({ text: s.text.trim(), photo: await photoId(s.photo) }))),
  };
  const saved = await api.putRecipe(rec);
  const idx = S.recipes.findIndex((r) => r.id === saved.id);
  if (idx >= 0) S.recipes[idx] = saved;
  else S.recipes.push(saved);
  draft = null;
  toast('Receta guardada ✓');
  location.hash = `#/r/${saved.id}`;
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- ingredients ---------- */
function viewIngs() {
  begin();
  const list = S.ings.slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const rows = list
    .map(
      (i) => `<button class="ing-row" data-act="edit-ing" data-id="${i.id}"><span class="n">${esc(i.name)}</span>
      ${i.price > 0 ? `<span class="p">${money(i.price)} / ${fmtNum(i.qty)} ${UNIT_LABEL[i.unit]}</span>` : `<span class="chip warn">Sin precio</span>`}</button>`
    )
    .join('');
  $app.innerHTML = `${topBar('Ingredientes', { right: `<button class="icon-btn" data-act="add-ing" aria-label="Agregar" style="color:var(--accent);font-size:28px">＋</button>` })}
  <div class="page">
    <p class="hint">Aquí guardas lo que pagas por cada ingrediente. Si el precio cambia, todas tus recetas se actualizan solas.</p>
    <div class="list">${rows || `<div class="empty"><div class="big">🧂</div><p>Aún no hay ingredientes.<br>Se crean al armar una receta, o toca ＋.</p></div>`}</div>
  </div>${nav('ing')}`;
}

function ingredientSheet(ing, onSaved) {
  const isNew = !ing.id;
  const cur = { name: ing.name || '', price: ing.price ?? '', qty: ing.qty ?? 1, unit: ing.unit || 'kg' };
  sheet(
    `<h2>${isNew ? 'Nuevo ingrediente' : 'Ingrediente'}</h2>
    <label class="field"><span>Nombre</span><input id="i-name" value="${esc(cur.name)}" placeholder="Ej: Harina" autocomplete="off"></label>
    <div class="row">
      <label class="field"><span>Precio que pagas</span><input id="i-price" type="number" inputmode="decimal" step="any" min="0" value="${cur.price}" placeholder="0"></label>
      <label class="field"><span>Por cuánto</span><input id="i-qty" type="number" inputmode="decimal" step="any" min="0" value="${cur.qty}"></label>
      <label class="field" style="max-width:96px"><span>Unidad</span><select id="i-unit">${Object.keys(UNITS)
        .map((u) => `<option value="${u}" ${u === cur.unit ? 'selected' : ''}>${UNIT_LABEL[u]}</option>`)
        .join('')}</select></label>
    </div>
    <p class="hint">Ejemplo: harina, $2.500 por 1 kg.</p>
    <button class="btn block" id="i-save">Guardar</button>
    ${isNew ? '' : '<button class="btn danger block" id="i-del">Eliminar</button>'}`,
    (el) => {
      el.querySelector('#i-save').onclick = async () => {
        const name = el.querySelector('#i-name').value.trim();
        if (!name) return toast('Escribe el nombre');
        const rec = {
          id: ing.id || uid(),
          name,
          price: +el.querySelector('#i-price').value || 0,
          qty: +el.querySelector('#i-qty').value || 1,
          unit: el.querySelector('#i-unit').value,
        };
        const saved = await guard(() => api.putIngredient(rec));
        if (!saved) return;
        const idx = S.ings.findIndex((x) => x.id === saved.id);
        if (idx >= 0) S.ings[idx] = saved;
        else S.ings.push(saved);
        closeSheet();
        onSaved ? onSaved(saved) : route();
      };
      const del = el.querySelector('#i-del');
      if (del)
        del.onclick = async () => {
          const used = S.recipes.filter((r) => r.items.some((i) => i.ingId === ing.id));
          if (used.length) return toast(`Está en uso en ${used.length} receta(s)`);
          if (!confirm(`¿Eliminar ${ing.name}?`)) return;
          if ((await guard(() => api.delIngredient(ing.id))) === undefined) return;
          S.ings = S.ings.filter((x) => x.id !== ing.id);
          closeSheet();
          route();
        };
    }
  );
}

/* ---------- scan with Gemini ---------- */
function viewScan() {
  begin();
  const noKey = !S.set.geminiReady;
  const body = scanFile
    ? `<div class="scan-box"><img src="${imgUrl(scanFile)}" alt="Foto de la receta">
        <button class="btn block" data-act="read" ${scanBusy ? 'disabled' : ''}>${scanBusy ? '<span class="spin"></span> Leyendo receta…' : '✨ Leer receta'}</button>
        <button class="text-btn" data-act="scan-photo" ${scanBusy ? 'disabled' : ''}>Cambiar foto</button></div>`
    : `<div class="scan-box"><div style="font-size:48px">📝</div>
        <p>Toma una foto de tu receta escrita a mano. Procura buena luz y que se vea toda la hoja.</p>
        <button class="btn block" data-act="scan-photo">📷 Tomar foto</button>
        <button class="btn ghost block" data-act="scan-gallery">🖼 Elegir de la galería</button></div>`;
  $app.innerHTML = `${topBar('Receta desde foto', { back: '#/' })}
  <div class="page">
    ${noKey ? `<div class="note">La lectura con IA aún no está configurada en el servidor (falta GEMINI_API_KEY).</div>` : ''}
    ${scanError ? `<div class="err">${esc(scanError)}</div>` : ''}
    ${body}
    ${scanFile ? '<p class="hint" style="text-align:center">Después podrás revisar y corregir todo antes de guardar.</p>' : ''}
  </div>${nav('home')}`;
}

async function readScan() {
  if (!S.set.geminiReady) return;
  scanBusy = true;
  scanError = '';
  viewScan();
  try {
    const r = await api.scan(scanFile);
    const items = (r.ingredients || []).map((x) => {
      const unit = UNITS[x.unit] ? x.unit : 'g';
      const m = findIng(x.name, family(unit));
      return { ingId: m?.id || null, newName: m ? '' : String(x.name || '').trim(), qty: x.quantity || '', unit };
    });
    pendingDraft = {
      ...blankDraft(),
      name: r.name || '',
      yield: r.yield > 0 ? r.yield : '',
      yieldUnit: YIELD_UNITS.includes(r.yieldUnit) ? r.yieldUnit : 'porciones',
      items,
      steps: (r.steps || []).map((t) => ({ text: t, photo: null })),
    };
    scanFile = null;
    scanBusy = false;
    toast('Receta leída. Revísala antes de guardar');
    location.hash = '#/e/new';
  } catch (e) {
    scanBusy = false;
    scanError = e.message;
    viewScan();
  }
}

/* ---------- settings ---------- */
function viewSettings() {
  begin();
  $app.innerHTML = `${topBar('Ajustes')}
  <div class="page">
    <label class="field"><span>Símbolo de moneda</span><input id="s-cur" value="${esc(S.set.currency)}" maxlength="4" style="max-width:120px"></label>
    <button class="btn block" data-act="save-settings">Guardar</button>
    <p class="hint" style="margin-top:12px">Tus recetas se guardan en el servidor, así que las ves igual desde cualquier teléfono.</p>
    ${S.set.authRequired ? '<button class="btn ghost block" data-act="logout">Cerrar sesión</button>' : ''}
  </div>${nav('set')}`;
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go]');
  if (go) {
    const h = go.dataset.go;
    if (location.hash === h) route();
    else location.hash = h;
    return;
  }
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const i = +el.dataset.i;
  switch (el.dataset.act) {
    case 'new': return newSheet();
    case 'scale-inc':
    case 'scale-dec': {
      const r = S.recipes.find((x) => x.id === scale.id);
      const step = YIELD_STEP[r.yieldUnit || 'porciones'];
      setWant(round2(scale.want + (el.dataset.act === 'scale-inc' ? step : -step)));
      document.getElementById('want').value = scale.want;
      return;
    }
    case 'scale-reset': scale.id = null; return viewRecipe($app.dataset.rid);
    case 'tab': detailTab = el.dataset.tab; return viewRecipe($app.dataset.rid);
    case 'cover': return pickPhoto((b) => { draft.cover = b; renderEdit(); });
    case 'add-item':
      draft.items.push({ ingId: null, newName: '', qty: '', unit: 'g' });
      renderEdit();
      return ingredientPicker(draft.items.length - 1);
    case 'pick': return ingredientPicker(i);
    case 'del-item': draft.items.splice(i, 1); return renderEdit();
    case 'add-step': draft.steps.push({ text: '', photo: null }); renderEdit(); return $app.querySelectorAll('textarea')[draft.steps.length - 1]?.focus();
    case 'del-step': draft.steps.splice(i, 1); return renderEdit();
    case 'step-photo': return pickPhoto((b) => { draft.steps[i].photo = b; renderEdit(); });
    case 'rm-step-photo': draft.steps[i].photo = null; return renderEdit();
    case 'save': return saveDraft(el);
    case 'delete':
      if (!confirm('¿Eliminar esta receta para siempre?')) return;
      if ((await guard(() => api.delRecipe(draft.id))) === undefined) return;
      S.recipes = S.recipes.filter((r) => r.id !== draft.id);
      draft = null;
      location.hash = '#/';
      return;
    case 'add-ing': return ingredientSheet({});
    case 'edit-ing': return ingredientSheet(S.ings.find((x) => x.id === el.dataset.id));
    case 'scan-photo': return pickPhoto((b) => { scanFile = b; scanError = ''; viewScan(); }, { capture: 'scan' });
    case 'scan-gallery': return pickPhoto((b) => { scanFile = b; scanError = ''; viewScan(); });
    case 'read': return readScan();
    case 'save-settings': {
      const saved = await guard(() => api.saveSettings({ currency: document.getElementById('s-cur').value.trim() || '$' }));
      if (saved) { S.set = { ...S.set, ...saved }; toast('Ajustes guardados ✓'); }
      return;
    }
    case 'logout': await api.logout().catch(() => {}); return viewLogin();
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'search') {
    searchQ = t.value;
    begin();
    document.getElementById('list').innerHTML = listHtml();
    return;
  }
  if (t.id === 'want') return setWant(parseFloat(t.value) || 0);
  if (!draft) return;
  if (t.dataset.f) {
    draft[t.dataset.f] = t.value;
    if (t.dataset.f === 'yieldUnit') document.getElementById('price-label').textContent = `Precio de venta por ${YIELD_ONE[t.value]}`;
  }
  else if (t.dataset.item) draft.items[+t.dataset.i][t.dataset.item] = t.value;
  else if (t.dataset.step) {
    draft.steps[+t.dataset.i][t.dataset.step] = t.value;
    grow(t);
  } else return;
  refreshSummary();
});

/* ---------- init ---------- */
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  try {
    await load();
    route();
  } catch (e) {
    if (e.message !== 'Sesión expirada') {
      $app.innerHTML = `<div class="empty"><div class="big">📡</div><p>${esc(e.message)}</p><button class="btn" onclick="location.reload()">Reintentar</button></div>`;
    }
  }
})();
