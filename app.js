const ALL_TAGS = [
  'Backen', 'Früchte', 'Schokolade', 'Schnell', 'Vegan', 'Vegetarisch',
  'Fleisch', 'Pasta', 'Suppe', 'Dessert', 'Frühstück', 'Sommer', 'Winter',
];

const CONFIG_KEY = 'recipe_gh_config';
const CACHE_KEY  = 'recipe_cache_v2';

let recipes          = [];
let activeFilters    = [];
let currentRecipeId  = null;
let cookingSteps     = [], cookingIndex = 0;
let currentServings  = 4, baseServings = 4;
let ingredientCount  = 0, instructionCount = 0;
let selectedTags     = [];
let ghApi            = null;

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
  s.style.display = 'none';
  s.className = 'cfg-status';
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
  if (!owner || !repo || !token) {
    showCfgStatus('Bitte alle Felder ausfüllen.', 'err');
    return;
  }
  saveConfigToStorage({ owner, repo, token });
  ghApi = new GithubAPI(owner, repo, token);
  closeSettings();
  showToast('Einstellungen gespeichert');
}

async function testConnection() {
  const owner = document.getElementById('cfg-owner').value.trim();
  const repo  = document.getElementById('cfg-repo').value.trim();
  const token = document.getElementById('cfg-token').value.trim();
  if (!owner || !repo || !token) {
    showCfgStatus('Bitte alle Felder ausfüllen.', 'err');
    return;
  }
  showCfgStatus('Verbindung wird getestet…', 'info');
  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' },
    });
    if (res.ok)                            showCfgStatus('✓ Verbindung erfolgreich!', 'ok');
    else if (res.status === 401 || res.status === 403) showCfgStatus('✗ Token ungültig oder fehlende Rechte.', 'err');
    else if (res.status === 404)           showCfgStatus('✗ Repository nicht gefunden.', 'err');
    else                                   showCfgStatus(`✗ Fehler: HTTP ${res.status}`, 'err');
  } catch {
    showCfgStatus('✗ Netzwerkfehler', 'err');
  }
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
    const sha = await this.getFileSha(path);
    const body = { message, content: toBase64(content), ...(sha ? { sha } : {}) };
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method: 'PUT',
        headers: this._headers,
        body: JSON.stringify(body),
      });
      return res.ok;
    } catch { return false; }
  }

  async deleteFile(path, message) {
    const sha = await this.getFileSha(path);
    if (!sha) return true;
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method: 'DELETE',
        headers: this._headers,
        body: JSON.stringify({ message, sha }),
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
      const ids = await idxRes.json();
      const results = await Promise.allSettled(
        ids.map(id => fetch(`./recipes/${id}.json`).then(r => r.json()))
      );
      const loaded = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (loaded.length > 0) {
        recipes = loaded;
        updateLocalCache();
        return;
      }
    }
  } catch { /* fall through to cache */ }

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) { recipes = JSON.parse(cached); return; }
  } catch { /* fall through to samples */ }

  recipes = getSamples();
  updateLocalCache();
}

async function persistRecipe(recipe) {
  if (!ghApi) { updateLocalCache(); return false; }
  const ok1 = await ghApi.createOrUpdateFile(
    `recipes/${recipe.id}.json`,
    JSON.stringify(recipe, null, 2),
    `Rezept hinzufügen: ${recipe.title}`
  );
  if (!ok1) return false;

  const newIds = recipes.map(r => r.id);
  const ok2 = await ghApi.createOrUpdateFile(
    'recipes/index.json',
    JSON.stringify(newIds, null, 2),
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
  const ok = await ghApi.createOrUpdateFile(
    'recipes/index.json',
    JSON.stringify(recipes.map(r => r.id), null, 2),
    'Rezeptindex aktualisieren'
  );
  return ok;
}

// ─── SAMPLE DATA ──────────────────────────────────────────────

function getSamples() {
  return [
    {
      id: 's1',
      title: 'Maulwurfkuchen mit Banane',
      description: 'Der klassische Maulwurfkuchen — saftiger Schokoboden, cremige Bananenschichten und fluffige Sahne. Ein Genuss für die ganze Familie!',
      image: '', prepTime: 30, cookTime: 25, servings: 12,
      tags: ['Backen', 'Schokolade', 'Früchte', 'Dessert'],
      ingredients: [
        { amount: '4',   unit: 'Stk', name: 'Eier' },
        { amount: '200', unit: 'g',   name: 'Zucker' },
        { amount: '150', unit: 'g',   name: 'Butter' },
        { amount: '200', unit: 'g',   name: 'Mehl' },
        { amount: '3',   unit: 'EL',  name: 'Kakao' },
        { amount: '1',   unit: 'Pck', name: 'Backpulver' },
        { amount: '3',   unit: 'Stk', name: 'Bananen' },
        { amount: '600', unit: 'ml',  name: 'Sahne' },
        { amount: '3',   unit: 'Pck', name: 'Sahnesteif' },
        { amount: '100', unit: 'g',   name: 'Schokoraspeln' },
      ],
      instructions: [
        'Backofen auf 180 °C Ober-/Unterhitze vorheizen. Eine Springform (26 cm) einfetten und bemehlen.',
        'Butter und Zucker cremig rühren. Eier einzeln unterrühren, bis eine helle Masse entsteht.',
        'Mehl, Kakao und Backpulver sieben und unter die Masse rühren. Teig in die Springform füllen.',
        '25 Minuten backen. Stäbchenprobe machen. Den Boden vollständig abkühlen lassen.',
        'Bananen schälen und in Scheiben schneiden. Gleichmäßig auf dem Boden verteilen.',
        'Sahne mit Sahnesteif steif schlagen und auf die Bananen streichen und glattziehen.',
        'Mit Schokoraspeln bestreuen. Mindestens 2 Stunden (besser über Nacht) kalt stellen.',
        'Vor dem Servieren mit einem Löffel kleine „Maulwurfhügel" aus Schokoraspeln auf der Sahne formen.',
      ],
    },
    {
      id: 's2',
      title: 'Schnelles Bananenbrot',
      description: 'Saftiges Bananenbrot aus überreifen Bananen — in unter einer Stunde fertig und perfekt zum Frühstück!',
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
        'Backofen auf 175 °C vorheizen. Eine Kastenform (25 cm) einfetten und bemehlen.',
        'Bananen in einer großen Schüssel mit einer Gabel fein zerdrücken.',
        'Geschmolzene Butter, Eier, Zucker und Vanilleextrakt einrühren.',
        'Mehl, Backpulver und Salz dazugeben und nur kurz verrühren — der Teig darf klumpig bleiben!',
        'Teig in die Kastenform füllen und 50–55 Minuten backen. Stäbchenprobe!',
        '10 Minuten in der Form abkühlen lassen, dann auf ein Gitter stürzen.',
      ],
    },
    {
      id: 's3',
      title: 'Schokoladen-Mousse au Chocolat',
      description: 'Cremiges, luftiges Schokoladenmousse ohne Backen — in 20 Minuten zubereitet, dann nur noch kühlen.',
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
        'Schokolade grob hacken und über einem Wasserbad unter Rühren schmelzen. Leicht abkühlen lassen.',
        'Eigelbe mit Zucker schaumig-hell aufschlagen (ca. 3 Minuten). Unter die Schokolade rühren.',
        'Schlagsahne steif schlagen und beiseitestellen.',
        'Eiweiß mit einer Prise Salz zu festem Schnee schlagen.',
        'Erst die Sahne, dann den Eischnee in zwei Portionen vorsichtig unter die Schokoladenmasse heben.',
        'In Gläser oder Schüsseln füllen. Mindestens 2–3 Stunden im Kühlschrank fest werden lassen.',
      ],
    },
  ];
}

// ─── ROUTING ──────────────────────────────────────────────────

function navigate(hash) {
  window.location.hash = hash;
}

function router() {
  const hash = window.location.hash || '#';
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  if (hash === '#' || hash === '') {
    document.getElementById('view-overview').classList.add('active');
    renderOverview();
  } else if (hash === '#add') {
    document.getElementById('view-add').classList.add('active');
    initAddForm();
  } else if (hash.startsWith('#recipe/')) {
    document.getElementById('view-detail').classList.add('active');
    renderDetail(hash.slice(8));
  }
  window.scrollTo(0, 0);
}

// ─── OVERVIEW ─────────────────────────────────────────────────

function renderOverview() {
  renderFilterTags();
  filterRecipes();
}

function renderFilterTags() {
  document.getElementById('filter-tags').innerHTML = ALL_TAGS.map(t =>
    `<button class="filter-tag${activeFilters.includes(t) ? ' active' : ''}" onclick="toggleFilter('${t}')">${t}</button>`
  ).join('');
}

function toggleFilter(tag) {
  activeFilters = activeFilters.includes(tag)
    ? activeFilters.filter(t => t !== tag)
    : [...activeFilters, tag];
  renderFilterTags();
  filterRecipes();
}

function filterRecipes() {
  const q = (document.getElementById('search-input')?.value || '').toLowerCase();
  let list = recipes;
  if (q) list = list.filter(r =>
    r.title.toLowerCase().includes(q) ||
    (r.description || '').toLowerCase().includes(q) ||
    (r.tags || []).some(t => t.toLowerCase().includes(q))
  );
  if (activeFilters.length) list = list.filter(r =>
    activeFilters.every(f => (r.tags || []).includes(f))
  );
  renderGrid(list);
}

function renderGrid(list) {
  const g = document.getElementById('recipe-grid');
  if (!list.length) {
    g.innerHTML = `<div class="empty-state">
      <div style="font-size:3rem;margin-bottom:1rem">🍽️</div>
      <h3>Keine Rezepte gefunden</h3>
      <p style="margin-top:.5rem">Füge dein erstes Rezept hinzu!</p>
    </div>`;
    return;
  }
  g.innerHTML = list.map(r => {
    const tot = (r.prepTime || 0) + (r.cookTime || 0);
    const img = r.image
      ? `<img src="${r.image}" alt="${esc(r.title)}" loading="lazy">`
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
  if (!tags) return '🍽️';
  if (tags.includes('Backen'))     return '🎂';
  if (tags.includes('Schokolade')) return '🍫';
  if (tags.includes('Früchte'))    return '🍓';
  if (tags.includes('Pasta'))      return '🍝';
  if (tags.includes('Suppe'))      return '🍲';
  if (tags.includes('Fleisch'))    return '🥩';
  if (tags.includes('Vegan'))      return '🥗';
  if (tags.includes('Frühstück'))  return '🥐';
  if (tags.includes('Dessert'))    return '🍮';
  return '🍽️';
}

// ─── DETAIL ───────────────────────────────────────────────────

function renderDetail(id) {
  currentRecipeId = id;
  const r = recipes.find(x => x.id === id);
  if (!r) { navigate('#'); return; }
  baseServings = r.servings || 4;
  currentServings = baseServings;
  const tot = (r.prepTime || 0) + (r.cookTime || 0);
  const heroImg = r.image
    ? `<img src="${r.image}" alt="${esc(r.title)}">`
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
      <div class="instructions-panel">
        <h3>Zubereitung</h3>
        ${(r.instructions || []).map((s, i) => `
          <div class="step-item">
            <div class="step-number">${i + 1}</div>
            <div class="step-text">${esc(s)}</div>
          </div>`).join('')}
      </div>
    </div>`;
  renderIngredients(r);
}

function renderIngredients(r) {
  const ratio = currentServings / baseServings;
  const el = document.getElementById('ing-display');
  if (!el) return;
  el.innerHTML = (r.ingredients || []).map((ing, i) => {
    const raw = parseFloat(ing.amount);
    const scaled = isNaN(raw) ? ing.amount :
      (raw * ratio) % 1 === 0 ? raw * ratio : (raw * ratio).toFixed(1);
    return `<div class="ingredient-item" id="ii-${i}" onclick="togIng(${i})">
      <div class="ingredient-check" id="ic-${i}"></div>
      <span class="ingredient-amount">${scaled} ${ing.unit || ''}</span>
      <span class="ingredient-name">${esc(ing.name)}</span>
    </div>`;
  }).join('');
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
  cookingSteps = r.instructions;
  cookingIndex = 0;
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
  const tot = cookingSteps.length, i = cookingIndex;
  document.getElementById('cooking-step-count').textContent = `Schritt ${i + 1} von ${tot}`;
  document.getElementById('cooking-step-num').textContent   = i + 1;
  document.getElementById('cooking-step-text').textContent  = cookingSteps[i];
  document.getElementById('cooking-progress-bar').style.width = `${((i + 1) / tot) * 100}%`;
  document.getElementById('btn-prev').disabled = i === 0;
  document.getElementById('btn-next').textContent = i === tot - 1 ? '✓ Fertig!' : 'Weiter →';
}

function cookStep(d) {
  if (d === 1 && cookingIndex === cookingSteps.length - 1) {
    closeCookingMode();
    showToast('Guten Appetit! 🎉');
    return;
  }
  cookingIndex = Math.max(0, Math.min(cookingSteps.length - 1, cookingIndex + d));
  updCooking();
}

// ─── ADD FORM ─────────────────────────────────────────────────

function initAddForm() {
  ingredientCount = 0; instructionCount = 0; selectedTags = [];
  ['f-title', 'f-desc', 'f-prep', 'f-cook', 'f-servings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const prev = document.getElementById('image-preview');
  if (prev) { prev.style.display = 'none'; prev.src = ''; }
  document.getElementById('upload-placeholder').style.display = 'block';
  document.getElementById('ingredients-list').innerHTML = '';
  document.getElementById('instructions-list').innerHTML = '';
  addIngredient(); addIngredient(); addIngredient();
  addInstruction(); addInstruction();
  renderTagSelector();
}

function renderTagSelector() {
  document.getElementById('tag-selector').innerHTML = ALL_TAGS.map(t =>
    `<button class="tag-option${selectedTags.includes(t) ? ' selected' : ''}" onclick="togTag('${t}')">${t}</button>`
  ).join('');
}

function togTag(tag) {
  selectedTags = selectedTags.includes(tag)
    ? selectedTags.filter(t => t !== tag)
    : [...selectedTags, tag];
  renderTagSelector();
}

function addIngredient() {
  const i = ingredientCount++;
  const row = document.createElement('div');
  row.className = 'ingredient-row';
  row.id = 'ir-' + i;
  row.innerHTML = `
    <input type="text" placeholder="200"   id="ia-${i}">
    <input type="text" placeholder="g"     id="iu-${i}">
    <input type="text" placeholder="Zutat" id="in-${i}">
    <button class="remove-btn" onclick="document.getElementById('ir-${i}').remove()">×</button>`;
  document.getElementById('ingredients-list').appendChild(row);
}

function addInstruction() {
  const i = instructionCount++;
  const list = document.getElementById('instructions-list');
  const n = list.children.length + 1;
  const row = document.createElement('div');
  row.className = 'instruction-row';
  row.id = 'instr-' + i;
  row.innerHTML = `
    <div class="step-badge">${n}</div>
    <textarea placeholder="Schritt ${n}: …" id="it-${i}"></textarea>
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
    const img = document.getElementById('image-preview');
    img.src = ev.target.result;
    img.style.display = 'block';
    document.getElementById('upload-placeholder').style.display = 'none';
  };
  reader.readAsDataURL(file);
}

async function saveRecipe() {
  const title = (document.getElementById('f-title').value || '').trim();
  if (!title) { showToast('Bitte gib dem Rezept einen Namen!'); return; }

  const ings = [];
  document.querySelectorAll('#ingredients-list .ingredient-row').forEach(row => {
    const id   = row.id.replace('ir-', '');
    const name = (document.getElementById('in-' + id)?.value || '').trim();
    if (name) ings.push({
      amount: (document.getElementById('ia-' + id)?.value || '').trim(),
      unit:   (document.getElementById('iu-' + id)?.value || '').trim(),
      name,
    });
  });

  const instrs = [];
  document.querySelectorAll('#instructions-list .instruction-row').forEach(row => {
    const id = row.id.replace('instr-', '');
    const t  = (document.getElementById('it-' + id)?.value || '').trim();
    if (t) instrs.push(t);
  });

  const imgEl = document.getElementById('image-preview');
  const image = imgEl?.style.display !== 'none' ? imgEl.src : '';

  const recipe = {
    id: uid(), title,
    description: (document.getElementById('f-desc').value || '').trim(),
    image,
    prepTime:  parseInt(document.getElementById('f-prep').value)     || 0,
    cookTime:  parseInt(document.getElementById('f-cook').value)     || 0,
    servings:  parseInt(document.getElementById('f-servings').value) || 4,
    tags: [...selectedTags],
    ingredients: ings,
    instructions: instrs,
  };

  recipes.unshift(recipe);
  updateLocalCache();
  navigate('#recipe/' + recipe.id);

  const btn = document.getElementById('save-btn');
  if (btn) btn.disabled = true;

  if (ghApi) {
    showToast('Wird gespeichert…');
    const ok = await persistRecipe(recipe);
    showToast(ok ? 'Rezept gespeichert! 🎉' : 'Lokal gespeichert. GitHub-Sync fehlgeschlagen.');
  } else {
    showToast('Rezept gespeichert! (GitHub nicht konfiguriert)');
  }

  if (btn) btn.disabled = false;
}

// ─── TOAST ────────────────────────────────────────────────────

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
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
