const ALL_TAGS = [
  'Backen', 'Früchte', 'Schokolade', 'Schnell', 'Vegan', 'Vegetarisch',
  'Fleisch', 'Pasta', 'Suppe', 'Dessert', 'Frühstück', 'Sommer', 'Winter',
];

const CONFIG_KEY = 'recipe_gh_config';
const CACHE_KEY  = 'recipe_cache_v2';

let recipes             = [];
let activeFilters       = [];
let currentRecipeId     = null;
let cookingSteps        = [], cookingIndex = 0;
let cookingServingsRatio = 1;
let currentServings     = 4, baseServings = 4;
let ingredientCount     = 0, instructionCount = 0, sectionCount = 0;
let selectedTags        = [];
let ghApi               = null;
let editingRecipeId     = null;
let newImageDataUrl     = '';

// ─── UTILS ────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

// ─── STEP VARIABLE PARSING ────────────────────────────────────
// Syntax: {150g Butter}, {600 ml Sahne}, {3 Stk Eier}, {2 Eier}
// Pattern captures: number, optional attached unit, rest (may start with unit)

function parseStepVars(text, ratio) {
  return text.replace(/\{(\d+(?:[.,]\d+)?)([a-zA-ZäöüÄÖÜß]{0,6})\s+(.*?)\}/g,
    (_, num, attachedUnit, rest) => {
      const base   = parseFloat(num.replace(',', '.'));
      const scaled = isNaN(base) ? num :
        (base * ratio) % 1 === 0 ? String(base * ratio) : (base * ratio).toFixed(1);
      let unit = attachedUnit, name = rest;
      if (!unit) {
        const m = rest.match(/^([a-zA-ZäöüÄÖÜß]{1,6})\s+(.+)$/);
        if (m) { unit = m[1]; name = m[2]; }
      }
      const label = unit ? `${scaled} ${esc(unit)} ${esc(name)}` : `${scaled} ${esc(name)}`;
      return `<span class="step-var">${label}</span>`;
    }
  );
}

function extractStepVars(text, ratio) {
  const re = /\{(\d+(?:[.,]\d+)?)([a-zA-ZäöüÄÖÜß]{0,6})\s+(.*?)\}/g;
  const vars = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const base   = parseFloat(m[1].replace(',', '.'));
    const scaled = isNaN(base) ? m[1] :
      (base * ratio) % 1 === 0 ? String(base * ratio) : (base * ratio).toFixed(1);
    let unit = m[2], name = m[3];
    if (!unit) {
      const um = name.match(/^([a-zA-ZäöüÄÖÜß]{1,6})\s+(.+)$/);
      if (um) { unit = um[1]; name = um[2]; }
    }
    vars.push({ scaled, unit, name });
  }
  return vars;
}

// ─── GITHUB CONFIG ────────────────────────────────────────────

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); } catch { return null; }
}
function saveConfigToStorage(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

function openSettings() {
  const cfg = loadConfig();
  if (cfg) {
    document.getElementById('cfg-owner').value = cfg.owner || '';
    document.getElementById('cfg-repo').value  = cfg.repo  || '';
    document.getElementById('cfg-token').value = cfg.token || '';
  }
  const s = document.getElementById('cfg-status');
  s.style.display = 'none'; s.className = 'cfg-status';
  document.getElementById('settings-modal').classList.add('open');
}
function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}
function overlayClick(e) {
  if (e.target === e.currentTarget) closeSettings();
}
function saveSettings() {
  const owner = document.getElementById('cfg-owner').value.trim();
  const repo  = document.getElementById('cfg-repo').value.trim();
  const token = document.getElementById('cfg-token').value.trim();
  if (!owner || !repo || !token) { showCfgStatus('Bitte alle Felder ausfüllen.', 'err'); return; }
  saveConfigToStorage({ owner, repo, token });
  ghApi = new GithubAPI(owner, repo, token);
  closeSettings();
  showToast('Einstellungen gespeichert');
}
async function testConnection() {
  const owner = document.getElementById('cfg-owner').value.trim();
  const repo  = document.getElementById('cfg-repo').value.trim();
  const token = document.getElementById('cfg-token').value.trim();
  if (!owner || !repo || !token) { showCfgStatus('Bitte alle Felder ausfüllen.', 'err'); return; }
  showCfgStatus('Verbindung wird getestet…', 'info');
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if      (res.ok)                              showCfgStatus('✓ Verbindung erfolgreich!', 'ok');
    else if (res.status === 401 || res.status === 403) showCfgStatus('✗ Token ungültig oder fehlende Rechte.', 'err');
    else if (res.status === 404)                  showCfgStatus('✗ Repository nicht gefunden.', 'err');
    else                                          showCfgStatus(`✗ Fehler: HTTP ${res.status}`, 'err');
  } catch { showCfgStatus('✗ Netzwerkfehler', 'err'); }
}
function showCfgStatus(msg, type) {
  const el = document.getElementById('cfg-status');
  el.textContent = msg;
  el.className = 'cfg-status' + (type ? ' ' + type : '');
  el.style.display = 'block';
}

// ─── GITHUB API ───────────────────────────────────────────────

class GithubAPI {
  constructor(owner, repo, token) {
    this.base = `https://api.github.com/repos/${owner}/${repo}/contents`;
    this.auth = `token ${token}`;
  }
  get _headers() {
    return {
      Authorization: this.auth,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };
  }
  async getFileSha(path) {
    try {
      const res = await fetch(`${this.base}/${path}`, { headers: this._headers });
      if (!res.ok) return null;
      return (await res.json()).sha || null;
    } catch { return null; }
  }
  async createOrUpdateFile(path, content, message) {
    const sha  = await this.getFileSha(path);
    const body = { message, content: toBase64(content), ...(sha ? { sha } : {}) };
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method: 'PUT', headers: this._headers, body: JSON.stringify(body),
      });
      return res.ok;
    } catch { return false; }
  }
  async uploadImage(recipeId, dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    const base64    = dataUrl.split(',')[1];
    if (!base64) return null;
    const mimeMatch = dataUrl.match(/data:([^;]+);/);
    const mime      = mimeMatch?.[1] || 'image/jpeg';
    const extMap    = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
    const ext       = extMap[mime] || 'jpg';
    const path      = `recipes/images/${recipeId}.${ext}`;
    const sha       = await this.getFileSha(path);
    const body      = { message: `Bild speichern: ${recipeId}`, content: base64, ...(sha ? { sha } : {}) };
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method: 'PUT', headers: this._headers, body: JSON.stringify(body),
      });
      return res.ok ? path : null;
    } catch { return null; }
  }
  async deleteFile(path, message) {
    const sha = await this.getFileSha(path);
    if (!sha) return true;
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method: 'DELETE', headers: this._headers, body: JSON.stringify({ message, sha }),
      });
      return res.ok;
    } catch { return false; }
  }
}

// ─── STORAGE ──────────────────────────────────────────────────

function updateLocalCache() {
  localStorage.setItem(CACHE_KEY, JSON.stringify(recipes));
}

async function loadRecipes() {
  try {
    const idxRes = await fetch('./recipes/index.json');
    if (idxRes.ok) {
      const ids     = await idxRes.json();
      const results = await Promise.allSettled(
        ids.map(id => fetch(`./recipes/${id}.json`).then(r => r.json()))
      );
      const loaded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (loaded.length > 0) { recipes = loaded; updateLocalCache(); return; }
    }
  } catch { /* fall through */ }
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) { recipes = JSON.parse(cached); return; }
  } catch { /* fall through */ }
  recipes = getSamples();
  updateLocalCache();
}

async function persistRecipe(recipe) {
  if (!ghApi) { updateLocalCache(); return false; }
  const ok1 = await ghApi.createOrUpdateFile(
    `recipes/${recipe.id}.json`,
    JSON.stringify(recipe, null, 2),
    `Rezept: ${recipe.title}`
  );
  if (!ok1) return false;
  const ok2 = await ghApi.createOrUpdateFile(
    'recipes/index.json',
    JSON.stringify(recipes.map(r => r.id), null, 2),
    'Rezeptindex aktualisieren'
  );
  updateLocalCache();
  return ok2;
}

async function removeRecipe(id) {
  const recipe = recipes.find(r => r.id === id);
  recipes = recipes.filter(r => r.id !== id);
  updateLocalCache();
  if (!ghApi) return false;
  await ghApi.deleteFile(`recipes/${id}.json`, `Rezept löschen: ${recipe?.title || id}`);
  return ghApi.createOrUpdateFile(
    'recipes/index.json',
    JSON.stringify(recipes.map(r => r.id), null, 2),
    'Rezeptindex aktualisieren'
  );
}

// ─── SECTION HELPERS ──────────────────────────────────────────

function getAllSections() {
  const seen = new Set();
  recipes.forEach(r => (r.ingredients || []).forEach(ing => { if (ing.section) seen.add(ing.section); }));
  return [...seen].sort();
}

// ─── SAMPLE DATA ──────────────────────────────────────────────

function getSamples() {
  return [
    {
      id: 's1', title: 'Maulwurfkuchen mit Banane',
      description: 'Der klassische Maulwurfkuchen — saftiger Schokoboden, cremige Bananenschichten und fluffige Sahne.',
      image: '', prepTime: 30, cookTime: 25, servings: 12,
      tags: ['Backen', 'Schokolade', 'Früchte', 'Dessert'],
      ingredients: [
        { section: 'Boden' },
        { amount: '4',   unit: 'Stk', name: 'Eier' },
        { amount: '200', unit: 'g',   name: 'Zucker' },
        { amount: '150', unit: 'g',   name: 'Butter' },
        { amount: '200', unit: 'g',   name: 'Mehl' },
        { amount: '3',   unit: 'EL',  name: 'Kakao' },
        { amount: '1',   unit: 'Pck', name: 'Backpulver' },
        { section: 'Belag' },
        { amount: '3',   unit: 'Stk', name: 'Bananen' },
        { amount: '600', unit: 'ml',  name: 'Sahne' },
        { amount: '3',   unit: 'Pck', name: 'Sahnesteif' },
        { amount: '100', unit: 'g',   name: 'Schokoraspeln' },
      ],
      instructions: [
        'Backofen auf 180 °C vorheizen. Springform (26 cm) einfetten.',
        '{150g Butter} und {200g Zucker} cremig rühren. {4 Stk Eier} einzeln unterrühren.',
        '{200g Mehl}, {3 EL Kakao} und {1 Pck Backpulver} sieben und unterrühren. Teig in Form füllen.',
        '25 Minuten backen. Stäbchenprobe. Vollständig abkühlen lassen.',
        '{3 Stk Bananen} in Scheiben schneiden und auf dem Boden verteilen.',
        '{600 ml Sahne} mit {3 Pck Sahnesteif} steif schlagen und auf die Bananen streichen.',
        'Mit {100g Schokoraspeln} bestreuen. Mindestens 2 Stunden kalt stellen.',
        'Vor dem Servieren Maulwurfhügel aus Schokoraspeln formen.',
      ],
    },
    {
      id: 's2', title: 'Schnelles Bananenbrot',
      description: 'Saftiges Bananenbrot aus überreifen Bananen — in unter einer Stunde fertig.',
      image: '', prepTime: 10, cookTime: 55, servings: 8,
      tags: ['Backen', 'Früchte', 'Schnell', 'Frühstück'],
      ingredients: [
        { amount: '3',   unit: 'Stk',   name: 'überreife Bananen' },
        { amount: '2',   unit: 'Stk',   name: 'Eier' },
        { amount: '80',  unit: 'g',     name: 'Butter, geschmolzen' },
        { amount: '120', unit: 'g',     name: 'Zucker' },
        { amount: '200', unit: 'g',     name: 'Mehl' },
        { amount: '1',   unit: 'TL',    name: 'Backpulver' },
        { amount: '1',   unit: 'Prise', name: 'Salz' },
        { amount: '1',   unit: 'TL',    name: 'Vanilleextrakt' },
      ],
      instructions: [
        'Backofen auf 175 °C vorheizen. Kastenform (25 cm) einfetten.',
        '{3 Stk überreife Bananen} mit einer Gabel fein zerdrücken.',
        '{80g Butter}, {2 Stk Eier}, {120g Zucker} und {1 TL Vanilleextrakt} einrühren.',
        '{200g Mehl}, {1 TL Backpulver} und {1 Prise Salz} kurz unterrühren — Teig darf klumpig bleiben!',
        'Teig in die Kastenform füllen und 50–55 Minuten backen. Stäbchenprobe!',
        '10 Minuten in der Form abkühlen lassen, dann auf ein Gitter stürzen.',
      ],
    },
    {
      id: 's3', title: 'Schokoladen-Mousse au Chocolat',
      description: 'Cremiges, luftiges Schokoladenmousse ohne Backen — in 20 Minuten zubereitet.',
      image: '', prepTime: 20, cookTime: 0, servings: 4,
      tags: ['Dessert', 'Schokolade', 'Schnell', 'Vegetarisch'],
      ingredients: [
        { amount: '200', unit: 'g',     name: 'Zartbitterschokolade (70 %)' },
        { amount: '4',   unit: 'Stk',   name: 'Eier (getrennt)' },
        { amount: '2',   unit: 'EL',    name: 'Zucker' },
        { amount: '200', unit: 'ml',    name: 'Schlagsahne' },
        { amount: '1',   unit: 'Prise', name: 'Salz' },
      ],
      instructions: [
        '{200g Zartbitterschokolade (70 %)} hacken und im Wasserbad schmelzen. Abkühlen lassen.',
        'Eigelbe mit {2 EL Zucker} schaumig aufschlagen. Unter die Schokolade rühren.',
        '{200 ml Schlagsahne} steif schlagen und beiseitestellen.',
        'Eiweiß mit {1 Prise Salz} zu festem Schnee schlagen.',
        'Erst Sahne, dann Eischnee vorsichtig unter die Schokoladenmasse heben.',
        'In Gläser füllen. Mindestens 2–3 Stunden im Kühlschrank fest werden lassen.',
      ],
    },
  ];
}

// ─── ROUTING ──────────────────────────────────────────────────

function navigate(hash) { window.location.hash = hash; }

function router() {
  const hash = window.location.hash || '#';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  if (hash === '#' || hash === '') {
    document.getElementById('view-overview').classList.add('active');
    renderOverview();
  } else if (hash === '#add') {
    document.getElementById('view-add').classList.add('active');
    initAddForm();
  } else if (hash.startsWith('#edit/')) {
    document.getElementById('view-add').classList.add('active');
    initEditForm(hash.slice(6));
  } else if (hash.startsWith('#recipe/')) {
    document.getElementById('view-detail').classList.add('active');
    renderDetail(hash.slice(8));
  }
  window.scrollTo(0, 0);
}

// ─── OVERVIEW ─────────────────────────────────────────────────

function renderOverview() { renderFilterTags(); filterRecipes(); }

function renderFilterTags() {
  const sections = getAllSections();
  let html = ALL_TAGS.map(t =>
    `<button class="filter-tag${activeFilters.includes(t) ? ' active' : ''}" onclick="toggleFilter('${t}')">${t}</button>`
  ).join('');
  if (sections.length) {
    html += `<span class="filter-label" style="margin-left:.75rem">Abschnitte:</span>`;
    html += sections.map(s =>
      `<button class="filter-tag section-tag${activeFilters.includes(s) ? ' active' : ''}" data-f="${esc(s)}" onclick="toggleFilter(this.dataset.f)">${esc(s)}</button>`
    ).join('');
  }
  document.getElementById('filter-tags').innerHTML = html;
}

function toggleFilter(tag) {
  activeFilters = activeFilters.includes(tag)
    ? activeFilters.filter(t => t !== tag) : [...activeFilters, tag];
  renderFilterTags(); filterRecipes();
}

function filterRecipes() {
  const q = (document.getElementById('search-input')?.value || '').toLowerCase();
  let list = recipes;
  if (q) list = list.filter(r =>
    r.title.toLowerCase().includes(q) ||
    (r.description || '').toLowerCase().includes(q) ||
    (r.tags || []).some(t => t.toLowerCase().includes(q))
  );
  const tagFilters     = activeFilters.filter(f => ALL_TAGS.includes(f));
  const sectionFilters = activeFilters.filter(f => !ALL_TAGS.includes(f));
  if (tagFilters.length)     list = list.filter(r => tagFilters.every(f => (r.tags || []).includes(f)));
  if (sectionFilters.length) list = list.filter(r =>
    sectionFilters.every(s => (r.ingredients || []).some(ing => ing.section === s))
  );
  renderGrid(list);
}

function renderGrid(list) {
  const g = document.getElementById('recipe-grid');
  if (!list.length) {
    g.innerHTML = `<div class="empty-state"><div style="font-size:3rem;margin-bottom:1rem">🍽️</div><h3>Keine Rezepte gefunden</h3><p style="margin-top:.5rem">Füge dein erstes Rezept hinzu!</p></div>`;
    return;
  }
  g.innerHTML = list.map(r => {
    const tot = (r.prepTime || 0) + (r.cookTime || 0);
    const img = r.image
      ? `<img src="${esc(r.image)}" alt="${esc(r.title)}" loading="lazy">`
      : `<div class="card-placeholder">${emoji(r.tags)}</div>`;
    return `<div class="recipe-card" onclick="navigate('#recipe/${r.id}')">
      <div class="card-image">${img}</div>
      <div class="card-body">
        <h3>${esc(r.title)}</h3>
        <div class="card-meta">
          ${tot ? `<span>⏱ ${tot} Min</span>` : ''}
          ${r.servings ? `<span>🍽 ${r.servings} Port.</span>` : ''}
        </div>
        <div class="card-tags">${(r.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}</div>
      </div>
    </div>`;
  }).join('');
}

function emoji(tags) {
  if (!tags)                     return '🍽️';
  if (tags.includes('Backen'))   return '🎂';
  if (tags.includes('Schokolade')) return '🍫';
  if (tags.includes('Früchte'))  return '🍓';
  if (tags.includes('Pasta'))    return '🍝';
  if (tags.includes('Suppe'))    return '🍲';
  if (tags.includes('Fleisch'))  return '🥩';
  if (tags.includes('Vegan'))    return '🥗';
  if (tags.includes('Frühstück')) return '🥐';
  if (tags.includes('Dessert'))  return '🍮';
  return '🍽️';
}

// ─── DETAIL ───────────────────────────────────────────────────

function renderDetail(id) {
  currentRecipeId = id;
  const r = recipes.find(x => x.id === id);
  if (!r) { navigate('#'); return; }
  baseServings    = r.servings || 4;
  currentServings = baseServings;
  const tot = (r.prepTime || 0) + (r.cookTime || 0);
  const heroImg = r.image
    ? `<img src="${esc(r.image)}" alt="${esc(r.title)}">`
    : `<div class="hero-placeholder">${emoji(r.tags)}</div>`;

  document.getElementById('recipe-detail-content').innerHTML = `
    <div class="detail-hero">${heroImg}</div>
    <div class="detail-header">
      <button class="back-btn" onclick="navigate('#')">← Zurück zur Übersicht</button>
      <h2>${esc(r.title)}</h2>
      ${r.description ? `<p class="description">${esc(r.description)}</p>` : ''}
      <div class="detail-meta-row">
        ${r.prepTime ? `<div class="meta-item"><span class="label">Vorbereitung</span><span class="value">${r.prepTime} Min</span></div>` : ''}
        ${r.cookTime ? `<div class="meta-item"><span class="label">Back-/Kochzeit</span><span class="value">${r.cookTime} Min</span></div>` : ''}
        ${tot ? `<div class="meta-item"><span class="label">Gesamt</span><span class="value">${tot} Min</span></div>` : ''}
        ${r.servings ? `<div class="meta-item"><span class="label">Portionen</span><span class="value">${r.servings}</span></div>` : ''}
        <div style="margin-left:auto;display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
          ${(r.tags || []).map(t => `<span class="detail-tag">${t}</span>`).join('')}
          <button class="cook-mode-btn" onclick="startCooking('${r.id}')">👨‍🍳 Kochmodus</button>
          <button class="edit-btn" onclick="navigate('#edit/${r.id}')">✏️ Bearbeiten</button>
          <button class="delete-btn" onclick="confirmDelete('${r.id}')">Löschen</button>
        </div>
      </div>
    </div>
    <div class="detail-content">
      <div class="ingredients-panel">
        <h3>Zutaten</h3>
        <div class="servings-control">
          <button onclick="chgServ(-1)">−</button>
          <span class="count" id="serv-count">${currentServings}</span>
          <button onclick="chgServ(1)">+</button>
          <span>Portionen</span>
        </div>
        <div id="ing-display"></div>
      </div>
      <div class="instructions-panel" id="instructions-panel"></div>
    </div>`;

  renderIngredients(r);
  renderInstructions(r, 1);
}

function renderIngredients(r) {
  const ratio = currentServings / baseServings;
  const el    = document.getElementById('ing-display');
  if (!el) return;
  let ingIdx = 0;
  el.innerHTML = (r.ingredients || []).map(ing => {
    if (ing.section !== undefined) {
      return `<div class="ing-section-header">${esc(ing.section)}</div>`;
    }
    const i      = ingIdx++;
    const raw    = parseFloat(ing.amount);
    const scaled = isNaN(raw) ? ing.amount :
      (raw * ratio) % 1 === 0 ? String(raw * ratio) : (raw * ratio).toFixed(1);
    return `<div class="ingredient-item" id="ii-${i}" onclick="togIng(${i})">
      <div class="ingredient-check" id="ic-${i}"></div>
      <span class="ingredient-amount">${scaled} ${ing.unit || ''}</span>
      <span class="ingredient-name">${esc(ing.name)}</span>
    </div>`;
  }).join('');
}

function renderInstructions(r, ratio) {
  const panel = document.getElementById('instructions-panel');
  if (!panel) return;
  panel.innerHTML = '<h3>Zubereitung</h3>' +
    (r.instructions || []).map((s, i) => `
      <div class="step-item">
        <div class="step-number">${i + 1}</div>
        <div class="step-text">${parseStepVars(s, ratio)}</div>
      </div>`).join('');
}

function togIng(i) {
  const item = document.getElementById('ii-' + i);
  const chk  = document.getElementById('ic-' + i);
  item.classList.toggle('checked');
  chk.textContent = item.classList.contains('checked') ? '✓' : '';
}

function chgServ(d) {
  const r = recipes.find(x => x.id === currentRecipeId);
  if (!r) return;
  currentServings = Math.max(1, currentServings + d);
  document.getElementById('serv-count').textContent = currentServings;
  renderIngredients(r);
  renderInstructions(r, currentServings / baseServings);
}

async function confirmDelete(id) {
  if (!confirm('Dieses Rezept wirklich löschen?')) return;
  navigate('#');
  showToast('Rezept gelöscht');
  const ok = await removeRecipe(id);
  if (ghApi && !ok) showToast('GitHub-Sync fehlgeschlagen');
}

// ─── COOKING MODE ─────────────────────────────────────────────

function startCooking(id) {
  const r = recipes.find(x => x.id === id);
  if (!r || !r.instructions?.length) { showToast('Keine Schritte vorhanden'); return; }
  cookingSteps         = r.instructions;
  cookingIndex         = 0;
  cookingServingsRatio = baseServings > 0 ? currentServings / baseServings : 1;
  document.getElementById('cooking-recipe-title').textContent = r.title;
  document.getElementById('cooking-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
  updCooking();
}

function closeCookingMode() {
  document.getElementById('cooking-overlay').classList.remove('active');
  document.body.style.overflow = '';
}

function updCooking() {
  const tot  = cookingSteps.length, i = cookingIndex;
  const raw  = cookingSteps[i];
  const ratio = cookingServingsRatio;

  document.getElementById('cooking-step-count').textContent = `Schritt ${i + 1} von ${tot}`;
  document.getElementById('cooking-step-num').textContent   = i + 1;
  document.getElementById('cooking-step-text').innerHTML    = parseStepVars(raw, ratio);

  // Show ingredients mentioned in this step
  const vars  = extractStepVars(raw, ratio);
  const ingEl = document.getElementById('cooking-step-ingredients');
  if (vars.length) {
    ingEl.innerHTML = vars.map(v => {
      const label = v.unit ? `${v.scaled} ${esc(v.unit)} ${esc(v.name)}` : `${v.scaled} ${esc(v.name)}`;
      return `<span class="cooking-ing-chip">${label}</span>`;
    }).join('');
    ingEl.style.display = 'flex';
  } else {
    ingEl.innerHTML = '';
    ingEl.style.display = 'none';
  }

  document.getElementById('cooking-progress-bar').style.width = `${((i + 1) / tot) * 100}%`;
  document.getElementById('btn-prev').disabled    = i === 0;
  document.getElementById('btn-next').textContent = i === tot - 1 ? '✓ Fertig!' : 'Weiter →';
}

function cookStep(d) {
  if (d === 1 && cookingIndex === cookingSteps.length - 1) {
    closeCookingMode(); showToast('Guten Appetit! 🎉'); return;
  }
  cookingIndex = Math.max(0, Math.min(cookingSteps.length - 1, cookingIndex + d));
  updCooking();
}

// ─── ADD / EDIT FORM ──────────────────────────────────────────

function initAddForm() {
  editingRecipeId = null;
  newImageDataUrl = '';
  ingredientCount = 0; instructionCount = 0; sectionCount = 0; selectedTags = [];
  document.getElementById('form-title').textContent    = 'Neues Rezept';
  document.getElementById('form-subtitle').textContent = 'Halte dein Lieblingsrezept für immer fest 🍽️';
  ['f-title', 'f-desc', 'f-prep', 'f-cook', 'f-servings'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  resetImagePreview();
  document.getElementById('ingredients-list').innerHTML  = '';
  document.getElementById('instructions-list').innerHTML = '';
  addIngredient(); addIngredient(); addIngredient();
  addInstruction(); addInstruction();
  renderTagSelector();
}

function initEditForm(id) {
  const r = recipes.find(x => x.id === id);
  if (!r) { navigate('#'); return; }
  editingRecipeId = id;
  newImageDataUrl = '';
  ingredientCount = 0; instructionCount = 0; sectionCount = 0; selectedTags = [...(r.tags || [])];
  document.getElementById('form-title').textContent    = 'Rezept bearbeiten';
  document.getElementById('form-subtitle').textContent = 'Änderungen werden beim Speichern synchronisiert.';
  document.getElementById('f-title').value    = r.title    || '';
  document.getElementById('f-desc').value     = r.description || '';
  document.getElementById('f-prep').value     = r.prepTime || '';
  document.getElementById('f-cook').value     = r.cookTime || '';
  document.getElementById('f-servings').value = r.servings || '';

  // Image
  if (r.image) {
    const img = document.getElementById('image-preview');
    img.src = r.image; img.style.display = 'block';
    document.getElementById('upload-placeholder').style.display = 'none';
  } else {
    resetImagePreview();
  }

  // Ingredients (with sections)
  document.getElementById('ingredients-list').innerHTML = '';
  (r.ingredients || []).forEach(ing => {
    if (ing.section !== undefined) {
      addSection(ing.section);
    } else {
      addIngredient(ing.amount, ing.unit, ing.name);
    }
  });

  // Instructions
  document.getElementById('instructions-list').innerHTML = '';
  (r.instructions || []).forEach(text => addInstruction(text));
  if (!(r.instructions || []).length) { addInstruction(); addInstruction(); }

  renderTagSelector();
}

function resetImagePreview() {
  const prev = document.getElementById('image-preview');
  if (prev) { prev.style.display = 'none'; prev.src = ''; }
  document.getElementById('upload-placeholder').style.display = 'block';
  const fi = document.getElementById('f-image');
  if (fi) fi.value = '';
}

function renderTagSelector() {
  document.getElementById('tag-selector').innerHTML = ALL_TAGS.map(t =>
    `<button class="tag-option${selectedTags.includes(t) ? ' selected' : ''}" onclick="togTag('${t}')">${t}</button>`
  ).join('');
}

function togTag(tag) {
  selectedTags = selectedTags.includes(tag)
    ? selectedTags.filter(t => t !== tag) : [...selectedTags, tag];
  renderTagSelector();
}

function addIngredient(amount = '', unit = '', name = '') {
  const i   = ingredientCount++;
  const row = document.createElement('div');
  row.className = 'ingredient-row'; row.id = 'ir-' + i;
  row.innerHTML = `
    <input type="text" placeholder="200"   id="ia-${i}" value="${esc(amount)}">
    <input type="text" placeholder="g"     id="iu-${i}" value="${esc(unit)}">
    <input type="text" placeholder="Zutat" id="in-${i}" value="${esc(name)}">
    <button class="remove-btn" onclick="document.getElementById('ir-${i}').remove()">×</button>`;
  document.getElementById('ingredients-list').appendChild(row);
}

function addSection(name = '') {
  const n   = sectionCount++;
  const row = document.createElement('div');
  row.className = 'section-row'; row.id = 'sr-' + n;
  row.innerHTML = `
    <input type="text" class="section-name-input" id="sn-${n}"
      placeholder="Abschnittsname (z.B. Boden, Belag, Füllung)"
      value="${esc(name)}" />
    <button class="remove-btn" onclick="document.getElementById('sr-${n}').remove()">×</button>`;
  document.getElementById('ingredients-list').appendChild(row);
}

function addInstruction(text = '') {
  const i    = instructionCount++;
  const list = document.getElementById('instructions-list');
  const n    = list.children.length + 1;
  const row  = document.createElement('div');
  row.className = 'instruction-row'; row.id = 'instr-' + i;
  row.innerHTML = `
    <div class="step-badge">${n}</div>
    <textarea placeholder="Schritt ${n}: … Mengen mit {150g Butter} einbetten" id="it-${i}">${esc(text)}</textarea>
    <button class="remove-btn" onclick="rmInstr('instr-${i}')">×</button>`;
  list.appendChild(row);
}

function rmInstr(id) {
  document.getElementById(id).remove();
  document.querySelectorAll('#instructions-list .step-badge').forEach((b, i) => b.textContent = i + 1);
}

function previewImage(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    newImageDataUrl = ev.target.result;
    const img = document.getElementById('image-preview');
    img.src = newImageDataUrl; img.style.display = 'block';
    document.getElementById('upload-placeholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

async function saveRecipe() {
  const title = (document.getElementById('f-title').value || '').trim();
  if (!title) { showToast('Bitte gib dem Rezept einen Namen!'); return; }

  // Collect ingredients + sections in DOM order
  const ings = [];
  document.querySelectorAll('#ingredients-list > *').forEach(row => {
    if (row.classList.contains('section-row')) {
      const n = (row.querySelector('.section-name-input')?.value || '').trim();
      if (n) ings.push({ section: n });
    } else if (row.classList.contains('ingredient-row')) {
      const id   = row.id.replace('ir-', '');
      const name = (document.getElementById('in-' + id)?.value || '').trim();
      if (name) ings.push({
        amount: (document.getElementById('ia-' + id)?.value || '').trim(),
        unit:   (document.getElementById('iu-' + id)?.value || '').trim(),
        name,
      });
    }
  });

  const instrs = [];
  document.querySelectorAll('#instructions-list .instruction-row').forEach(row => {
    const id = row.id.replace('instr-', '');
    const t  = (document.getElementById('it-' + id)?.value || '').trim();
    if (t) instrs.push(t);
  });

  // Determine image source
  const imgEl = document.getElementById('image-preview');
  let image = newImageDataUrl ||
    (imgEl?.style.display !== 'none' && imgEl?.src && !imgEl.src.endsWith(window.location.href)
      ? imgEl.src : '');

  const recipe = {
    id:          editingRecipeId || uid(),
    title,
    description: (document.getElementById('f-desc').value || '').trim(),
    image,
    prepTime:    parseInt(document.getElementById('f-prep').value)     || 0,
    cookTime:    parseInt(document.getElementById('f-cook').value)     || 0,
    servings:    parseInt(document.getElementById('f-servings').value) || 4,
    tags:        [...selectedTags],
    ingredients: ings,
    instructions: instrs,
  };

  // Update local array
  if (editingRecipeId) {
    const idx = recipes.findIndex(r => r.id === editingRecipeId);
    if (idx !== -1) recipes[idx] = recipe; else recipes.unshift(recipe);
  } else {
    recipes.unshift(recipe);
  }
  updateLocalCache();
  navigate('#recipe/' + recipe.id);

  const btn = document.getElementById('save-btn');
  if (btn) btn.disabled = true;

  if (ghApi) {
    showToast('Wird gespeichert…');
    // Upload image to GitHub images folder if new image was selected
    if (newImageDataUrl) {
      const imgPath = await ghApi.uploadImage(recipe.id, newImageDataUrl);
      if (imgPath) {
        recipe.image = imgPath;
        const idx = recipes.findIndex(r => r.id === recipe.id);
        if (idx !== -1) recipes[idx].image = imgPath;
        updateLocalCache();
      }
    }
    const ok = await persistRecipe(recipe);
    showToast(ok ? 'Rezept gespeichert! 🎉' : 'Lokal gespeichert. GitHub-Sync fehlgeschlagen.');
  } else {
    showToast(editingRecipeId ? 'Änderungen gespeichert!' : 'Rezept gespeichert! (GitHub nicht konfiguriert)');
  }

  editingRecipeId = null;
  newImageDataUrl = '';
  if (btn) btn.disabled = false;
}

// ─── TOAST ────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── INIT ─────────────────────────────────────────────────────

async function init() {
  const cfg = loadConfig();
  if (cfg) ghApi = new GithubAPI(cfg.owner, cfg.repo, cfg.token);
  await loadRecipes();
  window.addEventListener('hashchange', router);
  router();
}

init();
