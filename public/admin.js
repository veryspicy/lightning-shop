/* Lightning Shop 管理后台逻辑：登录鉴权、RBAC 账号管理、产品增删改、图片上传 */
const API = '/api';
const TOKEN_KEY = 'ls_admin_token';
const ROLE_LABELS = { admin: '管理员', ops: '运营', supplier: '供应商' };
let ROLE_OPTIONS = []; // 角色下拉缓存（来自 /api/admin/roles）
let PERM_META = {};    // 权限点元数据缓存（key -> {label, desc}）
let USERS_CACHE = [];  // 用户全量缓存（供搜索过滤）

function hasPerm(u, perm) {
  const perms = (u && (u.permissions || [])) || [];
  return perms.includes('*') || perms.includes(perm);
}

const $ = (id) => document.getElementById(id);
let products = [];
let currentUser = null;
const selected = new Set();

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2200);
}

function authHeaders(extra = {}) {
  const token = sessionStorage.getItem(TOKEN_KEY) || '';
  return Object.assign({ 'Content-Type': 'application/json', 'x-admin-token': token }, extra);
}

async function api(path, options = {}) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    logout();
    throw new Error('登录已失效，请重新登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || `请求失败(${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function login() {
  const username = $('login-user').value.trim() || 'admin';
  const pass = $('login-pass').value.trim();
  if (!pass) return toast('请输入密码', true);
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: pass }),
    });
    sessionStorage.setItem(TOKEN_KEY, data.token);
    $('login-error').classList.add('hidden');
    await load();
  } catch (err) {
    const errEl = $('login-error');
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
  }
}

async function logout() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-admin-token': token } });
    } catch { /* 忽略登出接口异常 */ }
  }
  sessionStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  lastPermSync = 0;
  stopPermWatch();
  $('login-pass').value = '';
  $('login-panel').classList.remove('hidden');
  $('admin-main').classList.add('hidden');
  $('user-dropdown').classList.add('hidden');
}

function renderUserMenu(user) {
  const u = (user && user.user) || user || {};
  currentUser = u;
  const initial = (u.name || u.username || '管').trim().charAt(0).toUpperCase();
  $('user-avatar-btn').textContent = initial;
  $('user-name').textContent = u.name || u.username;
  $('user-role').textContent = u.roleName || ROLE_LABELS[u.role] || u.role;
  const brandEl = $('user-brand');
  if (u.role === 'supplier' && u.supplierBrand) {
    brandEl.textContent = '品牌：' + u.supplierBrand;
    brandEl.hidden = false;
  } else {
    brandEl.hidden = true;
  }
  applyMenuPerms(u);
}

/* ---- 权限上下文自动生效 ---- */

// 菜单权限点：优先取侧栏按钮上的 data-perm，缺省按 tab 名同名权限点判断
function tabPerm(tab) {
  const btn = document.querySelector(`#admin-tabs .tab-btn[data-tab="${tab}"]`);
  return (btn && btn.dataset.perm) || tab;
}

function canAccessTab(u, tab) {
  return hasPerm(u, tabPerm(tab));
}

// 按当前权限重绘侧栏菜单，并回收/回退越权标签页（保存角色后无需手动刷新）
function applyMenuPerms(u) {
  document.querySelectorAll('#admin-tabs .tab-btn[data-tab]').forEach((btn) => {
    btn.hidden = !hasPerm(u, btn.dataset.perm || btn.dataset.tab);
  });
  [...openTabs].forEach((t) => { if (!canAccessTab(u, t)) closeTab(t); });
  const activePanel = document.querySelector('.tab-panel.active');
  const active = activePanel ? activePanel.id.replace(/^tab-/, '') : '';
  if (active && !canAccessTab(u, active)) {
    const first = [...document.querySelectorAll('#admin-tabs .tab-btn[data-tab]')].find((b) => !b.hidden);
    // 角色一个菜单都没分配时保底留在看板，避免整页空白（接口层仍会 403 拦截）
    openTab(first ? first.dataset.tab : 'dashboard', !first);
  }
}

function permSig(u) {
  const perms = (u && u.permissions) || [];
  return `${(u && u.role) || ''}:${perms.slice().sort().join(',')}`;
}

// 重新拉取 /api/auth/me：后端每次实时按角色表计算权限，故无需重新登录
async function refreshMe() {
  let me;
  try {
    me = await api('/api/auth/me', { headers: authHeaders() });
  } catch (err) {
    if (/登录已失效/.test(err.message)) throw err;
    return { user: currentUser, changed: false };
  }
  const u = me.user || me;
  const changed = permSig(u) !== permSig(currentUser);
  renderUserMenu(me);
  if (changed) {
    if (hasPerm(u, 'users')) loadUsers();
    if (hasPerm(u, 'roles')) loadRoles();
  }
  return { user: u, changed };
}

let permWatchTimer = null;
let lastPermSync = 0;

// 静默同步：定时/切回页面/聚焦时校验，别的账号改了角色权限也能自动生效
async function syncPermsQuiet() {
  if (!sessionStorage.getItem(TOKEN_KEY)) return;
  const main = $('admin-main');
  if (main && main.classList.contains('hidden')) return;
  const now = Date.now();
  if (now - lastPermSync < 5000) return;
  lastPermSync = now;
  try {
    const r = await refreshMe();
    if (r.changed) toast('权限已更新，菜单已同步');
  } catch { /* 静默同步失败不打扰用户 */ }
}

function startPermWatch() {
  if (permWatchTimer) return;
  permWatchTimer = setInterval(() => {
    if (document.visibilityState === 'visible') syncPermsQuiet();
  }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncPermsQuiet();
  });
  window.addEventListener('focus', () => syncPermsQuiet());
}

function stopPermWatch() {
  if (permWatchTimer) clearInterval(permWatchTimer);
  permWatchTimer = null;
}

function toggleUserDropdown(force) {
  const dd = $('user-dropdown');
  const show = typeof force === 'boolean' ? force : dd.classList.contains('hidden');
  dd.classList.toggle('hidden', !show);
  $('user-avatar-btn').setAttribute('aria-expanded', show ? 'true' : 'false');
}

async function load() {
  // 获取当前登录用户（校验 token 并取得角色）
  let me;
  try {
    me = await api('/api/auth/me', { headers: authHeaders() });
  } catch (err) {
    if (/登录已失效/.test(err.message)) throw err;
    // 老版本仅密码登录：无用户表时 auth/me 不可用，回退为 token 即密码
    me = { username: 'admin', name: '管理员', role: 'admin' };
  }
  renderUserMenu(me);
  const me2 = me.user || me;
  if (hasPerm(me2, 'users')) loadUsers();
  if (hasPerm(me2, 'roles')) loadRoles();

  const data = await api('/api/admin/products', { headers: authHeaders() });
  products = data;
  renderList();
  $('login-panel').classList.add('hidden');
  $('admin-main').classList.remove('hidden');
  $('login-error').classList.add('hidden');
  loadCategoryOptions();
  loadConfigCategories();
  loadHero();
  loadQr();
  loadPrice();
  renderDashboard();
  const firstAllowed = [...document.querySelectorAll('#admin-tabs .tab-btn[data-tab]')].find((b) => !b.hidden);
  openTab(firstAllowed ? firstAllowed.dataset.tab : 'dashboard', !firstAllowed);
  startPermWatch();
}

async function reload() {
  const data = await api('/api/admin/products', { headers: authHeaders() });
  products = data;
  renderList();
  loadCategoryOptions();
  renderDashboard();
}

/* ---- 分类管理 ---- */

async function loadConfigCategories() {
  try {
    const data = await api('/api/admin/categories', { headers: authHeaders() });
    const chips = $('cat-chips');
    const configured = data.configured || [];
    const extra = data.extra || [];
    if (configured.length === 0 && extra.length === 0) {
      chips.innerHTML = '<span class="muted">暂无分类</span>';
      return;
    }
    chips.innerHTML =
      configured
        .map((c) => `<span class="chip" data-name="${esc(c.name)}"><span class="cat-name" data-name="${esc(c.name)}" title="点击修改分类名">${esc(c.name)}</span><span class="chip-count">${c.count}</span><button class="chip-del" title="删除分类">✕</button></span>`)
        .join('') +
      extra
        .map((c) => `<span class="chip chip-extra" data-name="${esc(c.name)}"><span class="cat-name" data-name="${esc(c.name)}" title="点击修改分类名（产品自动发现，改名后自动纳入配置分类）">${esc(c.name)}</span><span class="chip-count">${c.count}</span><button class="chip-del" title="删除分类（产品分类将置为未分类）">✕</button></span>`)
        .join('');
  } catch (err) {
    toast(err.message, true);
  }
}

async function addCategory() {
  const name = $('cat-new-name').value.trim();
  if (!name) return toast('请输入分类名称', true);
  try {
    await api('/api/admin/categories', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });
    $('cat-new-name').value = '';
    toast(`分类「${name}」已新增`);
    await Promise.all([loadConfigCategories(), loadCategoryOptions()]);
  } catch (err) {
    toast(err.message, true);
  }
}

function startEditCategory() {
  const chip = this.closest('.chip');
  const nameEl = chip.querySelector('.cat-name');
  const old = nameEl.dataset.name;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cat-input';
  input.value = old;
  input.maxLength = 20;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); input.value = old; input.blur(); }
  });
  input.addEventListener('blur', () => {
    const val = input.value.trim();
    input.replaceWith(makeCatName(old, val || old));
    if (val && val !== old) {
      api('/api/admin/categories', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ old, name: val }),
      })
        .then((data) => {
          toast(`分类已重命名，同步更新 ${data.renamed || 0} 个产品`);
          return Promise.all([loadConfigCategories(), loadCategoryOptions()]);
        })
        .catch((err) => { toast(err.message, true); loadConfigCategories(); });
    } else if (!val) {
      toast('分类名称不能为空', true);
      loadConfigCategories();
    }
  });
}

function makeCatName(name, display) {
  const span = document.createElement('span');
  span.className = 'cat-name';
  span.dataset.name = name;
  span.title = '点击修改分类名';
  span.textContent = display;
  return span;
}

async function deleteCategory() {
  const chip = this.closest('.chip');
  const name = chip.dataset.name;
  const isExtra = chip.classList.contains('chip-extra');
  const hint = isExtra
    ? `该分类为产品自动发现分类，删除后 ${chip.querySelector('.chip-count').textContent} 个产品的分类将置为「未分类」。`
    : '仅从分类配置移除，产品数据不受影响。';
  if (!await askConfirm('删除分类', `确定删除分类「${name}」？\n${hint}`, '删除')) return;
  try {
    await api('/api/admin/categories', {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ name }),
    });
    toast(`分类「${name}」已删除`);
    await Promise.all([loadConfigCategories(), loadCategoryOptions()]);
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadCategoryOptions() {
  // 编辑产品/批量筛选的分类选项与「分类管理」同源：配置分类 + 自动发现分类
  const data = await api('/api/admin/categories', { headers: authHeaders() });
  const all = [];
  const seen = new Set();
  for (const c of [...(data.configured || []), ...(data.extra || [])]) {
    if (!seen.has(c.name)) { seen.add(c.name); all.push(c); }
  }
  const opts = (suffix) => all.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}${suffix ? `（${c.count}）` : ''}</option>`).join('');
  const fcat = $('f-category');
  const cur = fcat.value;
  fcat.innerHTML = '<option value="">— 未设置 —</option>' + opts(false);
  fcat.value = cur;
  const sel = $('batch-cat-select');
  const selCur = sel.value;
  sel.innerHTML = '<option value="">— 选择分类 —</option>' + opts(true);
  sel.value = selCur;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 图片地址白名单：站内 /img/{安全文件名} 或 http(s) 绝对地址。
   商品图/订单图来源于供应商与匿名下单，直接拼进 src 会让后台成为提权跳板。 */
function imgUrl(u) {
  const s = String(u ?? '').trim();
  if (!s || s.length > 300) return '';
  if (/[\u0000-\u001f"'<>\\]/.test(s)) return '';
  if (/^\/img\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')) return s;
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  return '';
}

/* 多标签渲染：badge 字符串按逗号/顿号/竖线拆分，逐个输出小标签 */
function badgeChips(raw) {
  const list = String(raw || '').split(/[,，|]/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return '';
  return `<span class="badge-chips">${list.map((b) => `<span class="badge-chip${b.includes('低GI') ? ' gi' : ''}">${esc(b)}</span>`).join('')}</span>`;
}

/* ---- 表头筛选（品牌 / 标签 / 分类 / 状态） ---- */
function filterState(key) {
  const el = document.querySelector(`.th-filter[data-filter="${key}"]`);
  return el ? el.value : '';
}

/* 标签列可能是逗号/顿号/竖线分隔的多标签，命中任意一个即通过 */
function tagHits(raw, val) {
  if (!val) return true;
  return String(raw || '').split(/[,，|]/).map((s) => s.trim()).filter(Boolean).includes(val);
}

let filtersFilled = false;
function fillFilters() {
  const sets = { brand: new Set(), badge: new Set(), category: new Set() };
  for (const p of products) {
    if (p.brand) sets.brand.add(String(p.brand).trim());
    String(p.badge || '').split(/[,，|]/).map((s) => s.trim()).filter(Boolean).forEach((t) => sets.badge.add(t));
    sets.category.add(p.category || '未分类');
  }
  for (const key of ['brand', 'badge', 'category']) {
    const sel = document.querySelector(`.th-filter[data-filter="${key}"]`);
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部</option>' + [...sets[key]].sort().map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = cur;
  }
  filtersFilled = true;
}

/* 搜索关键词 + 四个表头筛选共同作用，返回当前可见产品 */
function visibleProducts() {
  const q = ($('list-search').value || '').trim().toLowerCase();
  const fBrand = filterState('brand');
  const fBadge = filterState('badge');
  const fCat = filterState('category');
  const fStatus = filterState('status');
  return products.filter((p) => {
    if (q && !((p.name || '').toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q))) return false;
    if (fBrand && (p.brand || '').trim() !== fBrand) return false;
    if (fBadge && !tagHits(p.badge, fBadge)) return false;
    if (fCat && (p.category || '未分类') !== fCat) return false;
    if (fStatus && (p.status || '上架') !== fStatus) return false;
    return true;
  });
}

function renderList() {
  if (!filtersFilled) fillFilters();
  const list = visibleProducts();
  $('list-count').textContent = `共 ${list.length} 个`;
  $('list-body').innerHTML = list
    .map(
      (p) => `<tr>
        <td><input type="checkbox" class="row-check" data-id="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''} /></td>
        <td>${p.image ? `<span class="thumb-wrap"><img src="${esc(imgUrl(p.image))}" alt="" data-lightbox="${esc(p.id)}" /><i class="thumb-zoom" title="点击查看大图"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="10" height="10"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></i></span>` : '<div class="ph">无图</div>'}</td>
        <td>${esc(p.id)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.brand || '—')}</td>
        <td>${badgeChips(p.badge)}</td>
        <td>${esc(p.category)}</td>
        <td>${esc(p.spec)}</td>
        <td>${esc(p.wholesale_price)}</td>
        <td class="${p.status === '下架' ? 'status-off' : 'status-on'}">${esc(p.status || '上架')}</td>
        <td class="ops">
          <button class="btn-mini" data-action="edit" data-id="${esc(p.id)}">编辑</button>
          <button class="btn-mini" data-action="toggle" data-id="${esc(p.id)}">${p.status === '下架' ? '上架' : '下架'}</button>
          <button class="btn-mini danger" data-action="delete" data-id="${esc(p.id)}">删除</button>
        </td>
      </tr>`
    )
    .join('');
  updateBatchCount();
}

function updateBatchCount() {
  $('batch-count').textContent = selected.size;
}

/* ---- 产品编辑抽屉 ---- */
let imgUploading = false;

function setImgUploading(on) {
  imgUploading = !!on;
  const btn = $('form-submit');
  if (btn) {
    btn.disabled = on;
    btn.textContent = on ? '图片上传中…' : '保存产品';
  }
  const tip = $('img-upload-tip');
  if (tip) tip.hidden = !on;
}

function openDrawer() {
  $('drawer-mask').classList.add('show');
  $('product-drawer').classList.add('open');
}

function closeDrawer() {
  $('drawer-mask').classList.remove('show');
  $('product-drawer').classList.remove('open');
}

function fillForm(p) {
  $('form-title').textContent = '编辑产品';
  $('f-id').value = p.id;
  $('f-name').value = p.name || '';
  $('f-brand').value = p.brand || '';
  $('f-badge').value = p.badge || '';
  $('f-category').value = p.category || '';
  $('f-spec').value = p.spec || '';
  $('f-wholesale').value = p.wholesale_price || '';
  $('f-retail').value = p.retail_price || '';
  $('f-price-note').value = p.price_note || '';
  $('f-moq').value = p.moq || '';
  $('f-highlights').value = p.highlights || '';
  $('f-storage').value = p.storage || '';
  $('f-shelf-life').value = p.shelf_life || '';
  $('f-cert').value = p.cert || '';
  $('f-status').value = p.status === '下架' ? '下架' : '上架';
  $('f-img').value = p.image || '';
  const prev = $('img-preview');
  if (p.image) { prev.src = p.image; prev.hidden = false; } else { prev.hidden = true; }
  openDrawer();
}

function resetForm() {
  $('form-title').textContent = '新增产品';
  $('product-form').reset();
  $('f-id').value = '';
  $('f-status').value = '上架';
  $('f-img').value = '';
  $('img-preview').hidden = true;
}

function collectForm() {
  return {
    name: $('f-name').value.trim(),
    brand: $('f-brand').value.trim(),
    badge: $('f-badge').value.trim(),
    category: $('f-category').value.trim(),
    spec: $('f-spec').value.trim(),
    wholesale_price: $('f-wholesale').value.trim(),
    retail_price: $('f-retail').value.trim(),
    price_note: $('f-price-note').value.trim(),
    moq: $('f-moq').value.trim(),
    highlights: $('f-highlights').value.trim(),
    storage: $('f-storage').value.trim(),
    shelf_life: $('f-shelf-life').value.trim(),
    cert: $('f-cert').value.trim(),
    image: $('f-img').value.trim(),
    status: $('f-status').value,
  };
}

/* 图片压缩/缩放/裁切：统一转 JPEG。
 * opts.maxSize  最长边（或正方形边长）上限，默认 1200
 * opts.square   是否中心裁切为正方形（产品卡片 1:1），默认 false
 * opts.quality  质量 0-1（WebP 优先，不支持时回退 JPEG），默认 0.85 */
function fileToImageBase64(file, opts = {}) {
  const MAX = opts.maxSize || 1200;
  const QUALITY = typeof opts.quality === 'number' ? opts.quality : 0.85;
  const SQUARE = !!opts.square;
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (SQUARE) {
        // 中心裁切正方形：取短边，居中裁剪，再缩放到 MAX×MAX
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        const size = Math.min(side, MAX);
        canvas.width = size;
        canvas.height = size;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      } else {
        // 等比缩放：最长边不超过 MAX
        let { width, height } = img;
        if (width > MAX) { height = Math.round((height * MAX) / width); width = MAX; }
        if (height > MAX) { width = Math.round((width * MAX) / height); height = MAX; }
        canvas.width = width;
        canvas.height = height;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
      }
      // WebP 优先（编码 Safari 17+ / Chromium 均支持），不支持时回退 JPEG
      const webp = canvas.toDataURL('image/webp', QUALITY);
      resolve(webp.startsWith('data:image/webp')
        ? { dataUrl: webp, ext: 'webp' }
        : { dataUrl: canvas.toDataURL('image/jpeg', QUALITY), ext: 'jpg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

async function handleUpload() {
  const file = $('f-img-file').files[0];
  if (!file) return toast('请选择图片文件', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return toast('仅支持 JPG / PNG / WebP', true);
  setImgUploading(true);
  try {
    const { dataUrl, ext } = await fileToImageBase64(file, { square: $('f-img-crop')?.checked, maxSize: 1000, quality: 0.82 });
    const filename = `${file.name.replace(/\.[^.]+$/, '')}-${Date.now().toString(36)}.${ext}`;
    const r = await api('/api/upload', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ filename, base64: dataUrl }),
    });
    $('f-img').value = r.url;
    const prev = $('img-preview');
    prev.src = r.url + '?t=' + Date.now();
    prev.hidden = false;
    toast('图片上传成功');
  } finally {
    setImgUploading(false);
  }
}

/* ---- Hero 站点配置 ---- */

async function loadHero() {
  try {
    const hero = await api('/api/site/hero');
    $('f-hero-title').value = hero.title || '';
    $('f-hero-eyebrow').value = hero.eyebrow || '';
    $('f-hero-bg').value = hero.bgImage || '';
    const prev = $('hero-img-preview');
    if (hero.bgImage) { prev.src = hero.bgImage; prev.hidden = false; } else { prev.hidden = true; }
  } catch {
    /* Hero 配置读取失败不阻塞主流程 */
  }
}

async function saveHero() {
  const body = {
    title: $('f-hero-title').value.trim(),
    eyebrow: $('f-hero-eyebrow').value.trim(),
    bgImage: $('f-hero-bg').value.trim(),
  };
  try {
    await api('/api/site/hero', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    toast('Hero 配置已保存');
  } catch (err) { toast(err.message, true); }
}

async function handleHeroUpload() {
  const file = $('f-hero-img-file').files[0];
  if (!file) return toast('请选择背景图', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return toast('仅支持 JPG / PNG / WebP', true);
  const { dataUrl, ext } = await fileToImageBase64(file, { maxSize: 1600, quality: 0.8 });
  const filename = `hero-${Date.now()}.${ext}`;
  const r = await api('/api/upload', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filename, base64: dataUrl }),
  });
  $('f-hero-bg').value = r.url;
  const prev = $('hero-img-preview');
  prev.src = r.url;
  prev.hidden = false;
  toast('背景图上传成功');
}

/* ---- 二维码与链接配置 ---- */

function styleQrGradient(box) {
  const canvas = box && box.querySelector('canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const from = [11, 45, 107];   // 深蓝 #0B2D6B
  const to = [124, 77, 255];    // 浅紫 #7C4DFF
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (d[i + 3] < 128) continue;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum >= 128) continue;
      const t = (x + y) / (w + h - 2);
      d[i] = Math.round(from[0] + (to[0] - from[0]) * t);
      d[i + 1] = Math.round(from[1] + (to[1] - from[1]) * t);
      d[i + 2] = Math.round(from[2] + (to[2] - from[2]) * t);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function renderQrUrlPreview() {
  const box = $('qr-url-preview');
  if (!box) return;
  const v = $('f-qr-url').value.trim();
  box.innerHTML = '';
  if (!v) {
    box.innerHTML = '<span class="qr-preview-empty">输入链接后生成预览</span>';
    return;
  }
  if (typeof QRCode === 'undefined') return;
  try {
    new QRCode(box, {
      text: v,
      width: 132,
      height: 132,
      colorDark: '#111111',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
    styleQrGradient(box);
  } catch {
    box.innerHTML = '<span class="qr-preview-empty">链接无效</span>';
  }
}

function syncQrPreviewText() {
  const qt = $('preview-quote-title');
  const st = $('preview-shop-title');
  if (qt) qt.textContent = $('f-qr-quote-title').value.trim() || '获取完整报价单';
  if (st) st.textContent = $('f-qr-shop-title').value.trim() || '扫码直达商城';
}

async function loadQr() {
  try {
    const qr = await api('/api/site/qr');
    $('f-qr-url').value = qr.url || '';
    $('f-qr-quote-image').value = qr.quoteImage || '';
    $('f-qr-quote-title').value = qr.quoteTitle || '';
    $('f-qr-shop-title').value = qr.shopTitle || '';
    const prev = $('qr-img-preview');
    if (qr.quoteImage) { prev.src = qr.quoteImage; prev.hidden = false; } else { prev.hidden = true; }
    renderQrUrlPreview();
    syncQrPreviewText();
  } catch {
    /* 二维码配置读取失败不阻塞主流程 */
  }
}

async function saveQr() {
  const body = {
    url: $('f-qr-url').value.trim(),
    quoteImage: $('f-qr-quote-image').value.trim(),
    quoteTitle: $('f-qr-quote-title').value.trim(),
    shopTitle: $('f-qr-shop-title').value.trim(),
  };
  try {
    await api('/api/site/qr', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
    toast('二维码配置已保存');
  } catch (err) { toast(err.message, true); }
}

async function handleQrUpload() {
  const file = $('f-qr-img-file').files[0];
  if (!file) return toast('请选择报价单二维码图片', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return toast('仅支持 JPG / PNG / WebP', true);
  const { dataUrl, ext } = await fileToImageBase64(file, { maxSize: 800, quality: 0.85 });
  const filename = `quote-qr-${Date.now()}.${ext}`;
  const r = await api('/api/upload', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filename, base64: dataUrl }),
  });
  $('f-qr-quote-image').value = r.url;
  const prev = $('qr-img-preview');
  prev.src = r.url;
  prev.hidden = false;
  toast('报价单二维码上传成功');
}

/* ---- 价格策略 ---- */

async function loadPrice() {
  try {
    const price = await api('/api/site/price');
    $('f-price-enabled').checked = !!price.enabled;
    $('f-price-margin').value = price.margin ?? 0;
  } catch {
    /* 价格策略读取失败不阻塞主流程 */
  }
}

async function savePrice() {
  const body = {
    enabled: $('f-price-enabled').checked,
    margin: Number($('f-price-margin').value),
  };
  try {
    const r = await api('/api/site/price', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    toast(`价格策略已保存：${r.price.enabled ? `启用，利润率 ${r.price.margin}%` : '已关闭（展示出厂价）'}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function submitForm(e) {
  e.preventDefault();
  if (imgUploading) return toast('图片上传中，请稍候再保存', true);
  const id = $('f-id').value;
  const body = collectForm();
  try {
    if (id) {
      await api(`/api/products/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
      toast('产品已更新');
    } else {
      await api('/api/products', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
      toast('产品已上架');
    }
    resetForm();
    closeDrawer();
    await reload();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onTableClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const p = products.find((x) => x.id === id);
  if (!p) return;

  if (btn.dataset.action === 'edit') {
    fillForm(p);
  } else if (btn.dataset.action === 'toggle') {
    const next = p.status === '下架' ? '上架' : '下架';
    try {
      await api(`/api/products/${id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ status: next }) });
      toast(next === '上架' ? '已上架' : '已下架');
      await reload();
    } catch (err) { toast(err.message, true); }
  } else if (btn.dataset.action === 'delete') {
    if (!await askConfirm('删除产品', `确认删除「${p.name}」？关联图片也会一并删除。`, '删除')) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE', headers: authHeaders() });
      toast('已删除');
      await reload();
    } catch (err) { toast(err.message, true); }
  }
}

/* ---- 账号管理（RBAC） ---- */

async function loadUsers() {
  try {
    const data = await api('/api/admin/users', { headers: authHeaders() });
    USERS_CACHE = Array.isArray(data) ? data : (data.users || []);
    renderUsers(USERS_CACHE);
  } catch (err) {
    toast(err.message, true);
  }
}

function userRoleBadge(roleKey) {
  const cls = { admin: 'badge-dark', ops: 'badge-blue', supplier: 'badge-amber' }[roleKey] || 'badge-slate';
  const label = ROLE_OPTIONS.find((r) => r.key === roleKey)?.name || ROLE_LABELS[roleKey] || roleKey;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function renderUsers(users) {
  const body = $('users-body');
  const q = ($('u-search')?.value || '').trim().toLowerCase();
  const list = q ? users.filter((u) => (u.username || '').toLowerCase().includes(q) || (u.name || '').toLowerCase().includes(q)) : users;
  if (!list.length) {
    body.innerHTML = `<tr class="empty-row"><td colspan="7" class="empty-cell">${q ? '未找到匹配的账号' : '暂无账号，点击右上角「新增账号」创建'}</td></tr>`;
    return;
  }
  body.innerHTML = list
    .map((u) => {
      const brand = u.role === 'supplier' ? esc(u.supplierBrand || '-') : '-';
      const status = u.status === 'disabled'
        ? '<span class="badge badge-red">已停用</span>'
        : '<span class="badge badge-green">正常</span>';
      const created = (u.createdAt || '').slice(0, 10);
      const isMe = u.id === currentUser?.id;
      const actions = [
        `<button type="button" class="btn btn-outline btn-xs" data-user-id="${esc(u.id)}" data-user-act="password">改密</button>`,
        `<button type="button" class="btn btn-outline btn-xs" data-user-id="${esc(u.id)}" data-user-act="edit">编辑</button>`,
        u.status === 'disabled'
          ? `<button type="button" class="btn btn-outline btn-xs" data-user-id="${esc(u.id)}" data-user-act="enable">启用</button>`
          : `<button type="button" class="btn btn-outline btn-xs" data-user-id="${esc(u.id)}" data-user-act="disable">停用</button>`,
        isMe ? '' : `<button type="button" class="btn btn-outline btn-xs danger" data-user-id="${esc(u.id)}" data-user-act="delete">删除</button>`,
      ].join('');
      return `<tr>
        <td><strong>${esc(u.username)}</strong>${isMe ? ' <span class="badge badge-green" style="font-size:.66rem;padding:1px 8px">我</span>' : ''}</td>
        <td>${esc(u.name || '-')}</td>
        <td>${userRoleBadge(u.role)}</td>
        <td>${brand}</td>
        <td>${status}</td>
        <td class="num">${created}</td>
        <td><div class="row-actions">${actions}</div></td>
      </tr>`;
    })
    .join('');
}

async function addUser() {
  const username = $('u-username').value.trim();
  const password = $('u-password').value.trim();
  const name = $('u-name').value.trim();
  const role = $('u-role').value;
  const supplierBrand = $('u-brand').value.trim();
  if (!username || !password) return toast('用户名与密码必填', true);
  if (role === 'supplier' && !supplierBrand) return toast('供应商账号需绑定品牌', true);
  try {
    await api('/api/admin/users', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username, password, name, role, supplierBrand }),
    });
    $('u-username').value = '';
    $('u-password').value = '';
    $('u-name').value = '';
    $('u-brand').value = '';
    toast('账号已创建');
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateUser(id, payload) {
  try {
    await api(`/api/admin/users/${id}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    toast('已保存');
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteUser(id) {
  if (!await askConfirm('删除账号', '确认删除该账号？此操作不可恢复。', '删除')) return;
  try {
    await api(`/api/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() });
    toast('账号已删除');
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function onUsersAction(e) {
  const btn = e.target.closest('[data-user-act]');
  if (!btn) return;
  const id = btn.dataset.userId;
  const act = btn.dataset.userAct;
  if (act === 'password') {
    const pwd = await askText({ title: '设置新密码', label: '新密码（至少 6 位）', placeholder: '请输入新密码', okText: '保存' });
    if (!pwd) return;
    if (pwd.length < 6) return toast('密码至少 6 位', true);
    await updateUser(id, { password: pwd });
  } else if (act === 'edit') {
    if (!ROLE_OPTIONS.length) return toast('角色列表未加载，请先打开角色管理', true);
    const hint = ROLE_OPTIONS.map((r) => `${r.key}:${r.name}`).join(' / ');
    const cur = (USERS_CACHE || []).find((u) => String(u.id) === String(id)) || {};
    const role = await askText({ title: '设置角色', label: `角色标识（可选：${hint}）`, value: cur.role || '', okText: '下一步' });
    if (!role) return;
    if (!ROLE_OPTIONS.some((r) => r.key === role)) return toast('无效的角色标识', true);
    const payload = { role };
    if (role === 'supplier') {
      const brand = await askText({ title: '绑定供应商品牌', label: '品牌名称（与产品品牌一致）', okText: '保存' });
      if (!brand) return toast('供应商需绑定品牌', true);
      payload.supplierBrand = brand;
    }
    await updateUser(id, payload);
  } else if (act === 'enable') {
    await updateUser(id, { status: 'enabled' });
  } else if (act === 'disable') {
    await updateUser(id, { status: 'disabled' });
  } else if (act === 'delete') {
    await deleteUser(id);
  }
}

/* ---- 角色管理（RBAC，可配置角色访问权限） ---- */

async function loadRoles() {
  try {
    const data = await api('/api/admin/roles', { headers: authHeaders() });
    PERM_META = data.perms || {};
    ROLE_OPTIONS = (data.roles || []).map((r) => ({ key: r.key, name: r.name }));
    renderRoleOptions();
    renderRoles(data.roles || []);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderRoleOptions() {
  const sel = $('u-role');
  if (!sel) return;
  sel.innerHTML = ROLE_OPTIONS.map((r) => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join('');
}

function permLabel(key, short) {
  if (key === '*') return '全部权限';
  const meta = PERM_META[key];
  return meta ? (short ? meta.label : meta.desc) : key;
}

function renderRoles(roles) {
  const body = $('roles-body');
  if (!roles.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6" class="empty-cell">暂无角色，点击右上角「新增角色」创建</td></tr>';
    return;
  }
  body.innerHTML = roles
    .map((r) => {
      const type = r.builtin ? '<span class="badge badge-amber">内置</span>' : '<span class="badge badge-blue">自定义</span>';
      const perms = r.permissions.includes('*')
        ? '<span class="perm-tag all">全部权限</span>'
        : (r.permissions.length
          ? `<div class="perm-tags">${r.permissions.map((p) => `<span class="perm-tag">${esc(permLabel(p, true))}</span>`).join('')}</div>`
          : '<span class="empty-cell">无</span>');
      const delBtn = r.builtin || r.userCount > 0
        ? ''
        : `<button type="button" class="btn btn-outline btn-xs danger" data-role-key="${esc(r.key)}" data-role-act="delete">删除</button>`;
      return `<tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td><code>${esc(r.key)}</code></td>
        <td>${type}</td>
        <td>${perms}</td>
        <td class="num">${r.userCount}</td>
        <td>
          <div class="row-actions">
            <button type="button" class="btn btn-outline btn-xs" data-role-key="${esc(r.key)}" data-role-act="edit">编辑权限</button>
            ${delBtn}
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

function openRoleEditor(key) {
  const modal = $('role-modal');
  const mask = $('role-mask');
  $('role-modal-title').textContent = key ? '编辑角色' : '新增角色';
  const rKey = $('r-key');
  const rName = $('r-name');
  const rPerms = $('r-perms');
  if (key) {
    // 编辑：异步请求角色详情（含权限）
    api('/api/admin/roles', { headers: authHeaders() }).then((data) => {
      const role = (data.roles || []).find((r) => r.key === key);
      if (!role) return toast('未找到该角色', true);
      rKey.value = role.key;
      rName.value = role.name || '';
      renderPermCheckboxes(role.permissions || []);
    });
  } else {
    rKey.value = '';
    rKey.disabled = false;
    rName.value = '';
    renderPermCheckboxes([]);
  }
  mask.hidden = false;
  modal.hidden = false;
}

function renderPermCheckboxes(selected) {
  const wrap = $('r-perms');
  const hasAll = selected.includes('*');
  // 记录「全部权限」态：该态下只有一个 disabled 且无 value 的复选框，
  // 若保存时按勾选项收集会得到空数组，等于把管理员角色权限清空（自锁）。
  wrap.dataset.allPerm = hasAll ? '1' : '0';
  if (hasAll) {
    wrap.innerHTML = '<div class="role-perm-item"><input type="checkbox" checked disabled /><div><b>全部权限</b><span>该角色拥有所有菜单与接口访问权限（内置管理员）</span></div></div>';
    $('r-key').disabled = true;
    return;
  }
  $('r-key').disabled = false;
  const keys = Object.keys(PERM_META);
  if (!keys.length) {
    wrap.innerHTML = '<span class="muted">权限定义加载失败，请刷新后重试</span>';
    return;
  }
  wrap.innerHTML = keys
    .map((k) => {
      const m = PERM_META[k];
      const checked = selected.includes(k) ? 'checked' : '';
      return `<label class="role-perm-item"><input type="checkbox" value="${esc(k)}" ${checked} /><span><b>${esc(m.label)}</b><span>${esc(m.desc)}</span></span></label>`;
    })
    .join('');
}

function closeRoleEditor() {
  $('role-mask').hidden = true;
  $('role-modal').hidden = true;
}

async function saveRole() {
  const key = $('r-key').value.trim().toLowerCase();
  const name = $('r-name').value.trim();
  if (!/^[a-z0-9_]{2,20}$/.test(key)) return toast('角色标识需 2-20 位小写字母/数字/下划线', true);
  if (!name) return toast('角色名称必填', true);
  let permissions;
  const permsWrap = $('r-perms');
  const allBox = document.querySelector('#r-perms input[value="*"]');
  if ((allBox && allBox.checked) || (permsWrap && permsWrap.dataset.allPerm === '1')) {
    permissions = ['*'];
  } else {
    permissions = Array.from(document.querySelectorAll('#r-perms input[type="checkbox"]:checked')).map((el) => el.value);
  }
  const isEdit = $('role-modal-title').textContent === '编辑角色';
  try {
    let data;
    if (isEdit) {
      data = await api(`/api/admin/roles/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ name, permissions }),
      });
    } else {
      data = await api('/api/admin/roles', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ key, name, permissions }),
      });
    }
    // 权限已落库：改的若正是当前账号的角色，直接用响应里的角色权限就近刷新菜单。
    // 不等 /api/auth/me 回包——首屏数据请求并发时会把它挤到后面，菜单会晚好几秒才变。
    const saved = data && data.role;
    if (saved && currentUser && saved.key === currentUser.role && Array.isArray(saved.permissions)) {
      renderUserMenu({ user: Object.assign({}, currentUser, {
        permissions: saved.permissions,
        roleName: saved.name || currentUser.roleName,
      }) });
    }
    toast(isEdit ? '角色已保存，权限已即时生效' : '角色已创建，权限已即时生效');
    closeRoleEditor();
    // 再拉一次 /api/auth/me 做权威校正（别的会话改了同一角色时以服务端为准），并按新权限重载角色列表
    await refreshMe();
    if (hasPerm(currentUser, 'roles')) loadRoles();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteRole(key) {
  if (!await askConfirm('删除角色', '确认删除该角色？删除后不可恢复。', '删除')) return;
  try {
    await api(`/api/admin/roles/${encodeURIComponent(key)}`, { method: 'DELETE', headers: authHeaders() });
    toast('角色已删除');
    await refreshMe();
    if (hasPerm(currentUser, 'roles')) loadRoles();
  } catch (err) {
    toast(err.message, true);
  }
}

function onRolesAction(e) {
  const btn = e.target.closest('[data-role-act]');
  if (!btn) return;
  const key = btn.dataset.roleKey;
  if (btn.dataset.roleAct === 'edit') openRoleEditor(key);
  else if (btn.dataset.roleAct === 'delete') deleteRole(key);
}

/* ---- 我的资料 ---- */

function openProfile() {
  if (!currentUser) return;
  $('p-username').value = currentUser.username || '';
  $('p-name').value = currentUser.name || '';
  $('p-role').value = currentUser.roleName || ROLE_LABELS[currentUser.role] || currentUser.role;
  $('p-brand').value = currentUser.role === 'supplier' ? (currentUser.supplierBrand || '') : '';
  $('p-password').value = '';
  $('profile-mask').hidden = false;
  $('profile-modal').hidden = false;
  toggleUserDropdown(false);
}

function closeProfile() {
  $('profile-mask').hidden = true;
  $('profile-modal').hidden = true;
}

async function saveProfile() {
  if (!currentUser) return;
  const payload = { name: $('p-name').value.trim() };
  const pwd = $('p-password').value;
  if (pwd) {
    if (pwd.length < 6) return toast('密码至少 6 位', true);
    payload.password = pwd;
  }
  try {
    const data = await api('/api/auth/me', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) });
    renderUserMenu(data.user || currentUser);
    closeProfile();
    toast('资料已更新');
  } catch (err) {
    toast(err.message, true);
  }
}

/* 事件绑定 */
$('login-btn').addEventListener('click', login);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('login-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout-btn').addEventListener('click', logout);
$('user-avatar-btn').addEventListener('click', (e) => { e.stopPropagation(); toggleUserDropdown(); });
$('user-profile-btn').addEventListener('click', openProfile);
document.addEventListener('click', (e) => {
  if (!$('user-menu').contains(e.target)) toggleUserDropdown(false);
});
$('profile-close').addEventListener('click', closeProfile);
$('profile-mask').addEventListener('click', closeProfile);
$('profile-save').addEventListener('click', saveProfile);
$('u-add-btn').addEventListener('click', () => {
  const card = $('u-add-card');
  card.hidden = !card.hidden;
  $('u-add-btn').textContent = card.hidden ? '新增账号' : '收起表单';
});
$('u-create-btn').addEventListener('click', addUser);
$('u-search').addEventListener('input', () => renderUsers(USERS_CACHE));
$('u-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') addUser(); });
$('users-body').addEventListener('click', onUsersAction);
$('role-add-btn').addEventListener('click', () => openRoleEditor(null));
$('role-save').addEventListener('click', saveRole);
$('role-cancel').addEventListener('click', closeRoleEditor);
$('role-close').addEventListener('click', closeRoleEditor);
$('role-mask').addEventListener('click', closeRoleEditor);
$('roles-body').addEventListener('click', onRolesAction);
$('product-form').addEventListener('submit', submitForm);
$('form-reset').addEventListener('click', resetForm);
$('f-img-file').addEventListener('change', () => handleUpload().catch((err) => { toast(err.message, true); $('f-img-file').value = ''; }));
$('hero-save').addEventListener('click', saveHero);
$('cat-add-btn').addEventListener('click', addCategory);
$('cat-new-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCategory(); });
$('cat-chips').addEventListener('click', (e) => {
  if (e.target.classList.contains('cat-name')) startEditCategory.call(e.target);
  else if (e.target.classList.contains('chip-del')) deleteCategory.call(e.target);
});
$('hero-reset').addEventListener('click', () => {
  $('f-hero-title').value = '';
  $('f-hero-eyebrow').value = '';
  $('f-hero-bg').value = '';
  $('hero-img-preview').hidden = true;
  saveHero();
});
$('f-hero-img-file').addEventListener('change', () => handleHeroUpload().catch((err) => toast(err.message, true)));
$('qr-save').addEventListener('click', saveQr);
$('qr-reset').addEventListener('click', () => {
  $('f-qr-url').value = 'https://lightning-shop.gora.dpdns.org';
  $('f-qr-quote-image').value = '/wechat-qr.jpg';
  $('f-qr-quote-title').value = '获取完整报价单';
  $('f-qr-shop-title').value = '扫码直达商城';
  const prev = $('qr-img-preview');
  prev.src = '/wechat-qr.jpg';
  prev.hidden = false;
  renderQrUrlPreview();
  syncQrPreviewText();
  saveQr();
});
$('f-qr-img-file').addEventListener('change', () => handleQrUpload().catch((err) => toast(err.message, true)));
$('f-qr-quote-image').addEventListener('input', () => {
  const prev = $('qr-img-preview');
  const v = $('f-qr-quote-image').value.trim();
  if (v) { prev.src = v; prev.hidden = false; } else { prev.hidden = true; }
});
$('f-qr-url').addEventListener('input', renderQrUrlPreview);
$('f-qr-quote-title').addEventListener('input', syncQrPreviewText);
$('f-qr-shop-title').addEventListener('input', syncQrPreviewText);
$('price-save').addEventListener('click', savePrice);
$('price-reset').addEventListener('click', () => {
  $('f-price-enabled').checked = true;
  $('f-price-margin').value = 10;
  savePrice();
});
$('f-hero-bg').addEventListener('input', () => {
  const prev = $('hero-img-preview');
  const v = $('f-hero-bg').value.trim();
  if (v) { prev.src = v; prev.hidden = false; } else { prev.hidden = true; }
});
$('f-img').addEventListener('input', () => {
  const prev = $('img-preview');
  const v = $('f-img').value.trim();
  if (v) { prev.src = v; prev.hidden = false; } else { prev.hidden = true; }
});
$('list-body').addEventListener('click', onTableClick);

/* ---- 产品图片大图预览（lightbox） ---- */
function openLightbox(src) {
  const mask = $('lightbox-mask');
  const img = $('lightbox-img');
  if (!mask || !img || !src) return;
  img.src = src;
  mask.hidden = false;
  const box = mask.querySelector('.lightbox');
  if (box) box.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  const mask = $('lightbox-mask');
  if (!mask || mask.hidden) return;
  mask.hidden = true;
  const box = mask.querySelector('.lightbox');
  if (box) box.classList.remove('open');
  $('lightbox-img').removeAttribute('src');
  document.body.style.overflow = '';
}
$('list-body').addEventListener('click', (e) => {
  const img = e.target.closest('img[data-lightbox]');
  if (img) openLightbox(img.getAttribute('src'));
});
$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-mask').addEventListener('click', (e) => {
  if (e.target === $('lightbox-mask')) closeLightbox();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });

$('list-search').addEventListener('input', renderList);
document.querySelectorAll('.th-filter').forEach((sel) => sel.addEventListener('change', renderList));

/* ---- 产品编辑抽屉 / 侧边栏 ---- */
$('add-product-btn').addEventListener('click', () => { resetForm(); openDrawer(); });
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-mask').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('sidebar-collapse').addEventListener('click', () => {
  const sb = document.querySelector('.sidebar');
  sb.classList.toggle('collapsed');
  const label = document.querySelector('#sidebar-collapse .menu-label');
  if (label) label.textContent = sb.classList.contains('collapsed') ? '展开菜单' : '收起菜单';
});

/* ---- 批量修改 ---- */
$('check-all').addEventListener('change', (e) => {
  const visible = visibleProducts();
  for (const p of visible) {
    if (e.target.checked) selected.add(p.id);
    else selected.delete(p.id);
  }
  renderList();
});
$('list-body').addEventListener('change', (e) => {
  const cb = e.target.closest('input.row-check');
  if (!cb) return;
  if (cb.checked) selected.add(cb.dataset.id);
  else selected.delete(cb.dataset.id);
  updateBatchCount();
});
$('batch-clear').addEventListener('click', () => {
  selected.clear();
  renderList();
});
$('batch-cat-btn').addEventListener('click', () => {
  const cat = $('batch-cat-select').value;
  if (!cat) return toast('请先选择分类', true);
  let hit = 0;
  for (const p of products) {
    if ((p.category || '未分类') === cat) {
      selected.add(p.id);
      hit++;
    }
  }
  renderList();
  toast(`已勾选分类「${cat}」的 ${hit} 个产品`);
});
$('batch-field').addEventListener('change', () => {
  const isStatus = $('batch-field').value === 'status';
  const isCat = $('batch-field').value === 'category';
  $('batch-value').classList.toggle('hidden', isStatus);
  $('batch-status-value').classList.toggle('hidden', !isStatus);
  if (isCat) $('batch-value').setAttribute('list', 'category-list');
  else $('batch-value').removeAttribute('list');
});
$('batch-apply').addEventListener('click', async () => {
  const ids = [...selected];
  if (ids.length === 0) return toast('请先勾选要修改的产品', true);
  const field = $('batch-field').value;
  const value = field === 'status' ? $('batch-status-value').value : $('batch-value').value;
  const fieldLabel = $('batch-field').selectedOptions[0]?.textContent || field;
  if (!await askConfirm('批量修改', `确认将「${fieldLabel}」批量修改为「${value || '(清空)'}」？将影响 ${ids.length} 个产品。`, '确认修改')) return;
  try {
    const r = await api('/api/products/batch', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ ids, patch: { [field]: value } }),
    });
    toast(`批量更新成功：${r.updated} 个产品已生效`);
    await reload();
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---- Tab 切换（菜单 → 标签栏联动） ---- */
const MENU_TITLES = { dashboard: '看板', hero: '首页配置', qr: '二维码配置', categories: '分类管理', price: '价格策略', products: '产品管理', users: '账号管理', roles: '角色管理', orders: '订单管理', customers: '客户档案', brands: '品牌档案', seller: '服务方主体' };
const openTabs = new Set();

function activateNavTag(tab) {
  document.querySelectorAll('.nav-tag').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
}

function ensureTab(tab) {
  if (openTabs.has(tab) || !MENU_TITLES[tab]) return;
  openTabs.add(tab);
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'nav-tag';
  el.dataset.tab = tab;
  el.setAttribute('role', 'tab');
  el.innerHTML = `<span>${MENU_TITLES[tab]}</span><i class="nav-tag-close" title="关闭">×</i>`;
  el.addEventListener('click', () => openTab(tab));
  el.querySelector('.nav-tag-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  $('nav-tabs').appendChild(el);
}

function closeTab(tab) {
  if (tab === 'dashboard') return; // 看板为固定标签，不可关闭
  if (!openTabs.has(tab)) return;
  openTabs.delete(tab);
  const el = document.querySelector(`.nav-tag[data-tab="${tab}"]`);
  if (el) el.remove();
  const wasActive = document.querySelector('.tab-panel.active')?.id === 'tab-' + tab;
  if (wasActive) {
    const rest = [...openTabs];
    openTab(rest.length ? rest[rest.length - 1] : 'dashboard');
  }
}

function openTab(tab, force) {
  if (!MENU_TITLES[tab]) return;
  if (!force && currentUser && !canAccessTab(currentUser, tab)) {
    if (tab !== 'dashboard') toast('当前角色无此菜单权限', true);
    return;
  }
  document.querySelectorAll('#admin-tabs .tab-btn').forEach((b) => {
    const active = b.dataset.tab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'tab-' + tab);
  });
  const cur = $('current-menu');
  if (cur) cur.textContent = MENU_TITLES[tab];
  ensureTab(tab);
  activateNavTag(tab);
  if (tab === 'orders') loadOrdersPanel();
  else if (tab === 'customers') loadCustomersPanel();
  else if (tab === 'brands') loadBrandsPanel();
  else if (tab === 'seller') loadSellerPanel();
}

$('admin-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  openTab(btn.dataset.tab);
});

/* ---- 看板 ---- */
const CHART_COLORS = ['#059669', '#7C4DFF', '#f59e0b', '#0ea5e9', '#ef4444', '#14b8a6', '#8b5cf6', '#f97316', '#64748b'];

/* 图表空态：数据为空时不能留一块白 canvas，必须显式写「暂无数据」，
   否则和「库没加载」无法区分（历史踩坑：外链 Chart.js 被墙导致图表静默空白） */
function setChartPlaceholder(id, text) {
  const canvas = $(id);
  if (!canvas || !canvas.parentElement) return;
  const card = canvas.parentElement;
  let tip = card.querySelector('.chart-placeholder');
  if (!tip) {
    tip = document.createElement('p');
    tip.className = 'chart-placeholder';
    tip.style.cssText = 'margin:8px 0 0;font-size:.82rem;color:#94a3b8;text-align:center';
    card.appendChild(tip);
  }
  tip.textContent = text;
  canvas.style.display = 'none';
  if (canvas._chart) { canvas._chart.destroy(); canvas._chart = null; }
}

function clearChartPlaceholder(canvas) {
  const card = canvas && canvas.parentElement;
  if (!card) return;
  const tip = card.querySelector('.chart-placeholder');
  if (tip) tip.remove();
  canvas.style.display = '';
}

function fmtNum(v) {
  const n = Number(v || 0);
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function drawChart(id, type, labels, data, opts = {}) {
  const canvas = $(id);
  if (!canvas) return;
  clearChartPlaceholder(canvas);
  // 图表库缺失必须出可见提示：此前直接 return 会让看板图表静默空白，无法区分「无数据」与「库没加载」
  if (typeof Chart === 'undefined') {
    const card = canvas.parentElement;
    if (card && !card.querySelector('.chart-fallback')) {
      const tip = document.createElement('p');
      tip.className = 'chart-fallback';
      tip.textContent = '图表组件加载失败，请刷新页面重试';
      tip.style.cssText = 'margin:8px 0 0;font-size:.82rem;color:#b45309;text-align:center';
      card.appendChild(tip);
    }
    console.error('[dashboard] Chart.js 未加载，图表无法渲染');
    return;
  }
  const staleTip = canvas.parentElement && canvas.parentElement.querySelector('.chart-fallback');
  if (staleTip) staleTip.remove();
  if (canvas._chart) canvas._chart.destroy();
  const isPie = type === 'pie' || type === 'doughnut';
  const isLine = type === 'line';
  const horizontal = !!opts.horizontal;
  const unit = opts.unit || '';
  const palette = (opts.colors && opts.colors.length ? opts.colors : CHART_COLORS);
  const dataset = {
    label: opts.label || '',
    data,
    backgroundColor: isPie ? palette.slice(0, labels.length) : (isLine ? 'rgba(5,150,105,.12)' : palette[0]),
    borderColor: isPie ? '#fff' : palette[0],
    borderWidth: isPie ? 2 : (isLine ? 2 : 1),
    borderRadius: isPie || isLine ? 0 : 6,
    tension: isLine ? 0.3 : 0,
    pointRadius: isLine ? 2 : 0,
    fill: isLine,
  };
  /* 多序列（如 PV + UV 同图）：调用方通过 opts.datasets 追加，不改变原有单序列调用方式 */
  const datasets = [dataset];
  (Array.isArray(opts.datasets) ? opts.datasets : []).forEach((ds, i) => {
    const color = ds.color || palette[(i + 1) % palette.length];
    datasets.push({
      label: ds.label || '',
      data: ds.data || [],
      borderColor: color,
      backgroundColor: `${color}1f`,
      borderWidth: 2,
      tension: 0.3,
      pointRadius: 2,
      fill: false,
    });
  });
  canvas._chart = new Chart(canvas, {
    type,
    data: {
      labels,
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: horizontal ? 'y' : 'x',
      plugins: {
        legend: (isPie || datasets.length > 1) ? { position: 'bottom', labels: { boxWidth: 12, padding: 12, font: { size: 12 } } } : { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const raw = isPie ? ctx.parsed : (horizontal ? ctx.parsed.x : ctx.parsed.y);
              return `${ctx.label ? ctx.label + '：' : ''}${fmtNum(raw)}${unit}`;
            },
          },
        },
      },
      scales: isPie ? {} : (horizontal ? {
        x: { beginAtZero: true, ticks: { precision: 0, font: { size: 11 } }, grid: { color: '#eef3ef' } },
        y: { ticks: { font: { size: 11 } }, grid: { display: false } },
      } : {
        x: { ticks: { maxRotation: 45, font: { size: 11 } }, grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#eef3ef' } },
      }),
    },
  });
}

/* ---- 销售统计（数据源 /api/admin/stats/sales，聚合在 D1 内完成） ---- */
const ORDER_STATUS_LABEL = {
  inquiry: '待报价', quoted: '已报价', confirmed: '客户已确认', forwarded: '已转厂',
  shipped: '工厂已发货', done: '已完成', cancelled: '已取消',
};
const ORDER_STATUS_COLOR = {
  inquiry: '#f59e0b', quoted: '#0ea5e9', confirmed: '#6366f1', forwarded: '#a855f7',
  shipped: '#7C4DFF', done: '#059669', cancelled: '#94a3b8',
};
// 服务费状态（纯居间口径）：平台只收服务费，货款由客户直付工厂，故与订单状态各走各的
const FEE_STATUS_LABEL = {
  unbilled: '待开账', quoted: '已报价待收', invoiced: '已开票待收', paid: '已到账', waived: '已减免',
};
// 渠道 slug → 中文名（未收录的 slug 原样展示，避免新来源被吞掉）
const CHANNEL_LABEL = {
  direct: '直接访问', wechat: '微信', douyin: '抖音', xiaohongshu: '小红书',
  weibo: '微博', zhihu: '知乎', baidu: '百度', bing: '必应', google: '谷歌',
  alibaba: '1688/淘宝', referral: '其他外链',
};

// 订单详情里的来源渠道文案：老订单（采集上线前）无 channel，明确标注而非显示空白
function orderChannelText(o) {
  const slug = (o.channel || '').trim();
  if (!slug) return '未标注（渠道采集上线前的订单）';
  const name = CHANNEL_LABEL[slug] || slug;
  const label = name === slug ? slug : `${name}（${slug}）`;
  const ref = (o.referrer || '').trim();
  if (!ref) return label;
  let host = ref;
  try { host = new URL(ref).hostname || ref; } catch (_) { /* 非法 URL 原样展示 */ }
  return `${label} · 来源页 ${host}`;
}
let SALES_DAYS = 30;
let SALES_LOADING = false;

function fmtMoney(v) {
  return Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(v) {
  return Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function bindSalesRange() {
  const sel = $('dash-sales-days');
  if (!sel || sel._bound) return;
  sel._bound = true;
  sel.value = String(SALES_DAYS);
  sel.addEventListener('change', () => loadSalesStats(Number(sel.value)));
}

async function loadSalesStats(days) {
  const span = Math.min(180, Math.max(7, Number(days) || SALES_DAYS || 30));
  SALES_DAYS = span;
  if (SALES_LOADING) return;
  SALES_LOADING = true;
  try {
    const data = await api(`${API}/admin/stats/sales?days=${span}`, { headers: authHeaders() });
    renderSalesSection(data);
  } catch (err) {
    toast(err.message, true);
    ['chart-sales-trend', 'chart-order-status', 'chart-channel-sales', 'chart-top-products', 'chart-brand-sales']
      .forEach((id) => setChartPlaceholder(id, '销售统计加载失败，请刷新重试'));
  } finally {
    SALES_LOADING = false;
  }
}

/* 环比文案：上期无数据（pct 为 null）时必须说「上期无数据」，
 * 不能显示 0%，否则「新开的店」会被误读成「业务零增长」。 */
function fmtChange(pct, prevText) {
  const tail = prevText ? `（上期 ${prevText}）` : '';
  if (pct === null || pct === undefined) return `环比 —${tail || '，上期无数据'}`;
  const n = Number(pct);
  const arrow = n > 0 ? '↑' : (n < 0 ? '↓' : '→');
  return `环比 ${arrow} ${Math.abs(n).toFixed(1)}%${tail}`;
}

// dash-sub 需要「环比 + 累计」两行，用 innerHTML 分行；内容均为本地格式化后的数字，无外部字符串
function setSub(id, lines) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = lines.filter(Boolean).map((t) => `<div>${t}</div>`).join('');
}

function renderSalesSection(d) {
  if (!d || !d.summary) return;
  const label = `近 ${d.days} 天`;
  const recent = d.recent || {};
  const summary = d.summary || {};
  const cmp = (d.compare && d.compare.change) || {};
  const prev = (d.compare && d.compare.previous) || {};
  const repeat = d.repeat || {};
  $('sale-amount-label').textContent = `${label}销售额（元）`;
  $('sale-orders-label').textContent = `${label}订单数`;
  $('sale-aov-label').textContent = `${label}客单价（元）`;
  $('sale-qty-label').textContent = `${label}售出件数`;
  $('sale-amount').textContent = fmtMoney(recent.amount);
  setSub('sale-amount-sub', [
    fmtChange(cmp.amount_pct, `${fmtMoney(prev.amount)} 元`),
    `累计成交 ${fmtMoney(summary.amount)} 元｜已收款 ${fmtMoney(summary.paid_amount)} 元`,
  ]);
  $('sale-orders').textContent = fmtInt(recent.orders);
  setSub('sale-orders-sub', [
    fmtChange(cmp.orders_pct, `${fmtInt(prev.orders)} 单`),
    `累计有效 ${fmtInt(summary.valid_orders)} 单｜取消 ${fmtInt(summary.cancelled_orders)} 单`,
  ]);
  $('sale-aov').textContent = fmtMoney(recent.avg_order_value);
  setSub('sale-aov-sub', [
    fmtChange(cmp.avg_order_value_pct, `${fmtMoney(prev.avg_order_value)} 元`),
    `累计客单价 ${fmtMoney(summary.avg_order_value)} 元`,
  ]);
  $('sale-qty').textContent = fmtInt(recent.qty);
  setSub('sale-qty-sub', [
    fmtChange(cmp.qty_pct, `${fmtInt(prev.qty)} 件`),
    `累计售出 ${fmtInt(summary.qty)} 件`,
  ]);

  const repeatLabel = `${label}复购率`;
  const repeatRateEl = $('sale-repeat-rate-label');
  if (repeatRateEl) repeatRateEl.textContent = repeatLabel;
  $('sale-repeat-rate').textContent = repeat.customers
    ? `${Number(repeat.repeat_rate || 0).toFixed(1)}%`
    : '—';
  setSub('sale-repeat-rate-sub', [repeat.customers
    ? `复购客户 ${fmtInt(repeat.repeat_customers)} / 下单客户 ${fmtInt(repeat.customers)}`
    : `${label}暂无下单客户（复购按手机号归并）`]);
  $('sale-repeat-amount').textContent = repeat.customers
    ? `${Number(repeat.repeat_amount_share || 0).toFixed(1)}%`
    : '—';
  setSub('sale-repeat-amount-sub', [repeat.customers
    ? `复购客户成交 ${fmtMoney(repeat.repeat_amount)} / ${fmtMoney(repeat.amount)} 元`
    : '—']);
  $('sale-customers').textContent = fmtInt(repeat.customers);
  setSub('sale-customers-sub', [repeat.customers
    ? `人均下单 ${Number(repeat.orders_per_customer || 0).toFixed(2)} 次｜合计 ${fmtInt(repeat.orders)} 单`
    : '—']);

  const trend = d.trend || [];
  if (trend.some((t) => Number(t.amount) > 0 || Number(t.orders) > 0)) {
    drawChart('chart-sales-trend', 'line', trend.map((t) => String(t.date).slice(5)), trend.map((t) => Number(t.amount)), { unit: ' 元' });
  } else {
    setChartPlaceholder('chart-sales-trend', `${label}暂无成交订单`);
  }

  const status = d.status || [];
  if (status.length) {
    drawChart(
      'chart-order-status', 'doughnut',
      status.map((s) => ORDER_STATUS_LABEL[s.status] || s.status),
      status.map((s) => Number(s.cnt)),
      { colors: status.map((s) => ORDER_STATUS_COLOR[s.status] || '#64748b'), unit: ' 单' },
    );
  } else {
    setChartPlaceholder('chart-order-status', '暂无订单数据');
  }

  const top = d.top_products || [];
  if (top.length) {
    drawChart(
      'chart-top-products', 'bar',
      top.map((p) => (String(p.name).length > 14 ? `${String(p.name).slice(0, 14)}…` : String(p.name))),
      top.map((p) => Number(p.qty)),
      { horizontal: true, unit: ' 件' },
    );
  } else {
    setChartPlaceholder('chart-top-products', '暂无销量数据');
  }

  const channels = d.channels || [];
  if (channels.length) {
    drawChart(
      'chart-channel-sales', 'bar',
      channels.map((c) => String(c.channel)),
      channels.map((c) => Number(c.amount)),
      { horizontal: true, unit: ' 元' },
    );
  } else {
    setChartPlaceholder('chart-channel-sales', `${label}暂无成交订单`);
  }

  const brands = d.brands || [];
  if (brands.length) {
    drawChart(
      'chart-brand-sales', 'doughnut',
      brands.map((b) => String(b.brand)),
      brands.map((b) => Number(b.qty)),
      { unit: ' 件' },
    );
  } else {
    setChartPlaceholder('chart-brand-sales', '暂无品牌销量数据');
  }
}

/* ---- 流量统计（数据源 /api/admin/stats/traffic，聚合在 D1 内完成） ----
 * PV / UV / 独立 IP / 设备 / 浏览器 / OS / 地域 / 落地页 / 漏斗全部来自
 * tracking_event + tracking_session；爬虫在采集侧打标、在查询侧剔除，
 * 因此这里展示的是「真实访客」口径，与 Cloudflare Web Analytics 的旁证数据可交叉验证。 */
let TRAFFIC_DAYS = 30;
let TRAFFIC_LOADING = false;

function fmtPct(v) {
  return (v === null || v === undefined) ? '—' : `${Number(v).toFixed(1)}%`;
}

/* 秒级可读化：停留时长从毫秒来，短访问显示秒、长访问显示分/小时，避免「1830 秒」这种不可读数字 */
function fmtDuration(ms) {
  const s = Math.round(Number(ms || 0) / 1000);
  if (s <= 0) return '0 秒';
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

function bindTrafficRange() {
  const sel = $('dash-traffic-days');
  if (!sel || sel._bound) return;
  sel._bound = true;
  sel.value = String(TRAFFIC_DAYS);
  sel.addEventListener('change', () => loadTrafficStats(Number(sel.value)));
}

async function loadTrafficStats(days) {
  const span = Math.min(90, Math.max(7, Number(days) || TRAFFIC_DAYS || 30));
  TRAFFIC_DAYS = span;
  if (TRAFFIC_LOADING) return;
  TRAFFIC_LOADING = true;
  try {
    const data = await api(`${API}/admin/stats/traffic?days=${span}`, { headers: authHeaders() });
    renderTrafficSection(data);
  } catch (err) {
    /* 迁移未执行或统计接口异常时只影响本区块，销售统计与其它面板保持可用 */
    toast(err.message, true);
    ['chart-traffic-trend', 'chart-traffic-device', 'chart-traffic-browser', 'chart-traffic-os', 'chart-traffic-landing', 'chart-traffic-toppages']
      .forEach((id) => setChartPlaceholder(id, '流量统计加载失败，请刷新重试'));
  } finally {
    TRAFFIC_LOADING = false;
  }
}

/* 表格用 DOM 拼接而非 innerHTML：路径、城市、来源域名都是外部数据，避免注入 */
function fillTrafficTable(tbodyId, rows, colspan) {
  const tb = $(tbodyId);
  if (!tb) return;
  tb.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.className = 'empty-cell';
    td.colSpan = colspan;
    td.textContent = '暂无数据（埋点上线后开始累积）';
    tr.appendChild(td);
    tb.appendChild(tr);
    return;
  }
  rows.forEach((cells) => {
    const tr = document.createElement('tr');
    cells.forEach((c) => {
      const td = document.createElement('td');
      td.textContent = String(c);
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
}

function renderTrafficSection(d) {
  if (!d || !d.summary) return;
  const label = `近 ${d.days} 天`;
  const s = d.summary || {};
  const f = d.funnel || {};
  ['traffic-pv', 'traffic-uv', 'traffic-ip', 'traffic-sessions', 'traffic-bounce', 'traffic-duration'].forEach((id) => {
    const el = $(`${id}-label`);
    if (!el) return;
    const base = el.textContent.replace(/^近 \d+ 天/, '');
    el.textContent = `${label}${base}`;
  });

  $('traffic-pv').textContent = fmtInt(s.pv);
  setSub('traffic-pv-sub', [
    `人均浏览 ${Number(s.pv_per_uv || 0).toFixed(2)} 页`,
    `已剔除爬虫 ${fmtInt(s.bot_pv)} 次`,
  ]);
  $('traffic-uv').textContent = fmtInt(s.uv);
  setSub('traffic-uv-sub', [
    s.uv ? `平均每访客 ${(Number(s.sessions || 0) / Number(s.uv)).toFixed(2)} 个会话` : '—',
    'UV 按访客 cookie 去重（不采集个人信息）',
  ]);
  $('traffic-ip').textContent = fmtInt(s.ip_count);
  setSub('traffic-ip-sub', [
    'IP 仅存每日加盐哈希，不留明文',
    '与 UV 的差额即「同 IP 多设备 / 换 IP」',
  ]);
  $('traffic-sessions').textContent = fmtInt(s.sessions);
  setSub('traffic-sessions-sub', [
    `事件数 ${fmtInt(s.events)} 次`,
    `成交会话 ${fmtInt(s.converted_sessions)} 个｜转化率 ${fmtPct(s.conversion_rate)}`,
  ]);
  $('traffic-bounce').textContent = fmtPct(s.bounce_rate);
  setSub('traffic-bounce-sub', [`跳出率 = 只看 1 页的会话占比`, `会话时长上限 30 分钟（离开页面才回传）`]);
  $('traffic-duration').textContent = fmtDuration(s.avg_duration);
  setSub('traffic-duration-sub', ['按会话平均停留', `数据保留：事件 ${d.ttl ? d.ttl.events_days : 30} 天 / 会话 ${d.ttl ? d.ttl.sessions_days : 180} 天`]);

  $('traffic-funnel-home').textContent = fmtInt(f.home);
  setSub('traffic-funnel-home-sub', ['看过首页的会话']);
  $('traffic-funnel-detail').textContent = fmtInt(f.detail);
  setSub('traffic-funnel-detail-sub', [`进站 → 详情 ${fmtPct(f.detail_rate)}`]);
  $('traffic-funnel-cart').textContent = fmtInt(f.add_cart);
  setSub('traffic-funnel-cart-sub', [`进站 → 加购 ${fmtPct(f.cart_rate)}`]);
  $('traffic-funnel-order').textContent = fmtInt(f.orders);
  setSub('traffic-funnel-order-sub', [`进站 → 下单 ${fmtPct(f.order_rate)}`]);

  const trend = d.trend || [];
  if (trend.some((t) => Number(t.pv) > 0)) {
    drawChart(
      'chart-traffic-trend', 'line',
      trend.map((t) => String(t.date).slice(5)),
      trend.map((t) => Number(t.pv)),
      { label: 'PV', unit: ' 次', datasets: [{ label: 'UV', data: trend.map((t) => Number(t.uv)), color: '#0ea5e9' }] },
    );
  } else {
    setChartPlaceholder('chart-traffic-trend', `${label}暂无访问数据`);
  }

  const device = d.device || [];
  if (device.length) {
    drawChart('chart-traffic-device', 'doughnut', device.map((x) => x.name), device.map((x) => Number(x.pv)), { unit: ' 次' });
  } else {
    setChartPlaceholder('chart-traffic-device', '暂无设备数据');
  }

  const browser = d.browser || [];
  if (browser.length) {
    drawChart('chart-traffic-browser', 'bar', browser.map((x) => x.name), browser.map((x) => Number(x.pv)), { horizontal: true, unit: ' 次' });
  } else {
    setChartPlaceholder('chart-traffic-browser', '暂无浏览器数据');
  }

  const os = d.os || [];
  if (os.length) {
    drawChart('chart-traffic-os', 'doughnut', os.map((x) => x.name), os.map((x) => Number(x.pv)), { unit: ' 次' });
  } else {
    setChartPlaceholder('chart-traffic-os', '暂无系统数据');
  }

  const landing = d.landing || [];
  if (landing.length) {
    drawChart(
      'chart-traffic-landing', 'bar',
      landing.map((x) => x.path), landing.map((x) => Number(x.pv)),
      { horizontal: true, unit: ' 次' },
    );
  } else {
    setChartPlaceholder('chart-traffic-landing', '暂无落地页数据');
  }

  /* 站内是 hash 路由，落地页图把所有商品页压成 /p/[id]；这里按未归一化路径看具体页面 */
  const topPages = d.top_pages || [];
  if (topPages.length) {
    drawChart(
      'chart-traffic-toppages', 'bar',
      topPages.map((x) => x.path), topPages.map((x) => Number(x.pv)),
      { horizontal: true, unit: ' 次' },
    );
  } else {
    setChartPlaceholder('chart-traffic-toppages', '暂无页面明细数据');
  }

  fillTrafficTable('traffic-channel-body', (d.channels || []).map((c) => [
    CHANNEL_LABEL[c.channel] || c.channel,
    fmtInt(c.sessions),
    fmtInt(c.pv),
    fmtInt(c.converted),
    fmtPct(c.conversion_rate),
  ]), 5);

  fillTrafficTable('traffic-geo-body', (d.geo || []).map((g) => [
    g.country, g.city, fmtInt(g.pv), fmtInt(g.uv),
  ]), 4);
}

function renderDashboard() {
  const cats = {};
  let hasImg = 0;
  let onShelf = 0;
  const priceBands = { '50 元以下': 0, '50-100 元': 0, '100-200 元': 0, '200 元以上': 0 };
  for (const p of products) {
    const c = p.category || '未分类';
    cats[c] = (cats[c] || 0) + 1;
    if (p.image) hasImg += 1;
    if (p.status === '下架') { /* off */ } else { onShelf += 1; }
    const m = String(p.wholesale_price || '').match(/\d+(\.\d+)?/);
    if (m) {
      const v = parseFloat(m[0]);
      if (v < 50) priceBands['50 元以下'] += 1;
      else if (v < 100) priceBands['50-100 元'] += 1;
      else if (v < 200) priceBands['100-200 元'] += 1;
      else priceBands['200 元以上'] += 1;
    }
  }
  $('dash-total').textContent = products.length;
  $('dash-cats').textContent = Object.keys(cats).length;
  $('dash-hasimg').textContent = hasImg;
  $('dash-noimg').textContent = products.length - hasImg;
  const catEntries = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 10);
  drawChart('chart-cat', 'bar', catEntries.map((e) => e[0]), catEntries.map((e) => e[1]));
  drawChart('chart-price', 'doughnut', Object.keys(priceBands), Object.values(priceBands));
  drawChart('chart-status', 'pie', ['上架', '下架'], [onShelf, products.length - onShelf]);
  bindSalesRange();
  loadSalesStats();
  bindTrafficRange();
  loadTrafficStats();
}

/* 初始化：有 token 直接尝试进入 */
if (sessionStorage.getItem(TOKEN_KEY)) {
  load().catch((err) => toast(err.message, true));
}

/* ================= 交易：订单管理 / 客户档案 / 品牌档案 ================= */
let ORDERS_CACHE = null;
let CUSTOMERS_CACHE = null;
let BRANDS_CACHE = null;
let CURRENT_ORDER = null;
let BRAND_EDITING = null;
let CERT_UPLOADING = false;

function fmtTimeAdmin(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d)) return String(ts).slice(0, 16).replace('T', ' ');
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 价格可能是 "50元/箱" 这类带单位字符串，统一安全解析，避免 toFixed 崩溃
function numOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v === undefined || v === null ? '' : v).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}
function money(v) { return numOf(v).toFixed(2); }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function orderStatusBadge(s) {
  const map = {
    inquiry: ['待报价', 'st-pending'], quoted: ['已报价', 'st-quoted'], confirmed: ['客户已确认', 'st-confirmed'],
    forwarded: ['已转厂', 'st-forwarded'], shipped: ['工厂已发货', 'st-shipped'],
    done: ['已完成', 'st-done'], cancelled: ['已取消', 'st-cancelled'],
  };
  const [label, cls] = map[s] || [s || '未知', 'st-cancelled'];
  return `<span class="order-status ${cls}">${label}</span>`;
}
function openModalAdmin(maskId, modalId) {
  const m = $(maskId);
  if (m) m.hidden = false;
  const d = $(modalId);
  if (d) d.hidden = false;
}
function closeModalAdmin(maskId, modalId) {
  const m = $(maskId);
  if (m) m.hidden = true;
  const d = $(modalId);
  if (d) d.hidden = true;
}

/* ---- 站内弹窗：替代原生 prompt / confirm，统一视觉与键盘行为 ---- */
function askConfirm(title, message, okText = '确定') {
  return new Promise((resolve) => {
    $('confirm-modal-title').textContent = title;
    $('confirm-modal-body').innerHTML = `<p style="margin:0;line-height:1.7">${escapeHtml(message).replace(/\n/g, '<br>')}</p>`;
    $('confirm-ok').textContent = okText;
    const finish = (val) => {
      closeModalAdmin('confirm-mask', 'confirm-modal');
      $('confirm-ok').onclick = null;
      $('confirm-cancel').onclick = null;
      $('confirm-close').onclick = null;
      $('confirm-mask').onclick = null;
      resolve(val);
    };
    $('confirm-ok').onclick = () => finish(true);
    $('confirm-cancel').onclick = () => finish(false);
    $('confirm-close').onclick = () => finish(false);
    $('confirm-mask').onclick = () => finish(false);
    openModalAdmin('confirm-mask', 'confirm-modal');
    $('confirm-ok').focus();
  });
}

function askText(opts) {
  const o = opts || {};
  const title = o.title || '请输入';
  const label = o.label || '内容';
  const okText = o.okText || '确定';
  return new Promise((resolve) => {
    $('prompt-modal-title').textContent = title;
    $('prompt-modal-body').innerHTML = `<div class="field"><label>${escapeHtml(label)}</label>`
      + `<input id="prompt-input" type="text" autocomplete="off" placeholder="${escapeHtml(o.placeholder || '')}" value="${escapeHtml(o.value || '')}" /></div>`
      + (o.tip ? `<p class="muted" style="margin:8px 0 0;font-size:.78rem">${escapeHtml(o.tip)}</p>` : '');
    $('prompt-ok').textContent = okText;
    const finish = (val) => {
      closeModalAdmin('prompt-mask', 'prompt-modal');
      $('prompt-ok').onclick = null;
      $('prompt-cancel').onclick = null;
      $('prompt-close').onclick = null;
      $('prompt-mask').onclick = null;
      const input = $('prompt-input');
      if (input) input.onkeydown = null;
      resolve(val);
    };
    const input = $('prompt-input');
    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    $('prompt-ok').onclick = () => finish(input.value);
    $('prompt-cancel').onclick = () => finish(null);
    $('prompt-close').onclick = () => finish(null);
    $('prompt-mask').onclick = () => finish(null);
    openModalAdmin('prompt-mask', 'prompt-modal');
    input.focus();
    input.select();
  });
}

/* ---- 订单管理 ---- */
async function loadOrdersPanel() {
  const body = $('orders-body');
  if (body) body.innerHTML = '<tr class="empty-row"><td colspan="8" class="empty-cell">加载中…</td></tr>';
  try {
    const f = $('orders-filter') ? $('orders-filter').value : '';
    const qs = f ? '?status=' + encodeURIComponent(f) : '';
    const data = await api('/api/admin/orders' + qs, { headers: authHeaders() });
    ORDERS_CACHE = data.orders || [];
    renderOrdersTable();
  } catch (e) {
    if (body) body.innerHTML = `<tr class="empty-row"><td colspan="8" class="empty-cell">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}
function renderOrdersTable() {
  const body = $('orders-body');
  if (!body) return;
  const kw = ($('orders-search') ? $('orders-search').value : '').trim().toLowerCase();
  const list = (ORDERS_CACHE || []).filter((o) => !kw || (o.id + (o.customer_name || '') + (o.customer_phone || '')).toLowerCase().includes(kw));
  if (!list.length) { body.innerHTML = '<tr class="empty-row"><td colspan="8" class="empty-cell">暂无订单</td></tr>'; return; }
  body.innerHTML = list.map((o) => {
    const qty = (o.items || []).reduce((s, it) => s + (it.qty || 0), 0);
    return `<tr class="clickable-row" data-order-id="${escapeHtml(o.id)}">
      <td><b>${escapeHtml(o.id)}</b></td>
      <td>${escapeHtml(o.customer_name)}</td>
      <td>${escapeHtml(o.customer_phone)}</td>
      <td>${(o.items || []).length} 种 / ${qty} 件</td>
      <td>¥${money(o.total_amount)}</td>
      <td>${orderStatusBadge(o.status)}</td>
      <td>${fmtTimeAdmin(o.created_at)}</td>
      <td><button type="button" class="btn btn-outline btn-sm" data-order-view="${escapeHtml(o.id)}">详情</button></td>
    </tr>`;
  }).join('');
}
async function openOrderModal(id) {
  try {
    const o = await api('/api/admin/orders/' + encodeURIComponent(id), { headers: authHeaders() });
    CURRENT_ORDER = o.order || o;
    renderOrderModal(CURRENT_ORDER);
    openModalAdmin('order-mask', 'order-modal');
  } catch (e) { toast(e.message, true); }
}
function renderOrderModal(o) {
  const rows = (o.items || []).map((it) => `<tr>
    <td>${it.image ? `<img src="${escapeHtml(imgUrl(it.image))}" style="width:36px;height:36px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:8px" onerror="this.style.display='none'" />` : ''}${escapeHtml(it.name)}</td>
    <td>${escapeHtml(it.spec || '-')}</td>
    <td>${it.qty}</td>
    <td class="num">¥${money(it.price)}${it.base_price ? `<div class="muted" style="font-size:.72rem">出厂 ¥${money(it.base_price)}</div>` : ''}</td>
    <td>¥${money(numOf(it.price) * numOf(it.qty))}</td>
  </tr>`).join('');
  // 出厂成本 / 毛利：结算价已含加价，这里给出成本口径便于核对利润
  const costTotal = (o.items || []).reduce((sum, it) => sum + (it.base_price ? numOf(it.base_price) * numOf(it.qty) : 0), 0);
  $('order-modal-body').innerHTML = `
    <div class="order-detail-grid">
      <div class="kv"><b>订单号</b><span>${escapeHtml(o.id)}</span></div>
      <div class="kv"><b>状态</b><span>${orderStatusBadge(o.status)}</span></div>
      <div class="kv"><b>客户</b><span>${escapeHtml(o.customer_name)}</span></div>
      <div class="kv"><b>手机号</b><span>${escapeHtml(o.customer_phone)}</span></div>
      <div class="kv"><b>下单时间</b><span>${fmtTimeAdmin(o.created_at)}</span></div>
      <div class="kv"><b>货款</b><span>¥${money(o.total_amount)}</span></div>
      <div class="kv"><b>服务费</b><span>¥${money(o.service_fee)}</span></div>
      <div class="kv"><b>应付合计</b><span style="color:var(--accent);font-weight:700">¥${money(o.total_payable)}</span></div>
      ${costTotal > 0 ? `<div class="kv"><b>出厂成本</b><span>¥${money(costTotal)}</span></div>
      <div class="kv"><b>预计毛利</b><span style="font-weight:700">¥${money(numOf(o.total_amount) - costTotal)}</span></div>` : ''}
      ${(o.province || o.address || o.receiver_name) ? `<div class="kv" style="grid-column:1/-1"><b>收货信息</b><span>${escapeHtml([
      o.receiver_name || '',
      o.receiver_phone || '',
      [o.province, o.city, o.district, o.address].filter(Boolean).join(''),
      o.postal_code ? `（${o.postal_code}）` : '',
    ].filter(Boolean).join(' · '))}</span></div>` : ''}
      ${o.remark ? `<div class="kv" style="grid-column:1/-1"><b>备注</b><span>${escapeHtml(o.remark)}</span></div>` : ''}
      ${o.tracking_no ? `<div class="kv" style="grid-column:1/-1"><b>物流单号</b><span>${escapeHtml(o.tracking_no)}</span></div>` : ''}
      <div class="kv" style="grid-column:1/-1"><b>供货工厂 / 服务费</b><span>${o.factory_id ? escapeHtml(o.factory_id) : '<span class="muted">未指定</span>'} · ${FEE_STATUS_LABEL[o.service_fee_status] || '待开账'}${o.service_fee_paid_at ? `（${escapeHtml(String(o.service_fee_paid_at).slice(0, 10))} 到账）` : ''}${o.goods_paid_at ? ` · 货款已付工厂 ${escapeHtml(String(o.goods_paid_at).slice(0, 10))}` : ''}${o.service_fee_note ? `<div class="muted" style="font-size:.72rem">${escapeHtml(o.service_fee_note)}</div>` : ''}</span></div>
      ${o.pay_note ? `<div class="kv" style="grid-column:1/-1"><b>付款说明</b><span>${escapeHtml(o.pay_note)}</span></div>` : ''}
      ${o.note ? `<div class="kv" style="grid-column:1/-1"><b>后台备注</b><span>${escapeHtml(o.note)}</span></div>` : ''}
      <div class="kv" style="grid-column:1/-1"><b>来源渠道</b><span>${escapeHtml(orderChannelText(o))}</span></div>
    </div>
    <h4 style="margin:6px 0 2px">商品明细</h4>
    <table class="ord-items-table">
      <thead><tr><th>商品</th><th>规格</th><th class="num">数量</th><th class="num">单价</th><th class="num">小计</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">—</td></tr>'}</tbody>
    </table>`;
  const foot = $('order-modal-foot');
  const act = [];
  const terminal = o.status === 'done' || o.status === 'cancelled';
  // 服务费 / 工厂登记与状态流转解耦：非终态订单随时可补登记，不必为了填到账日期去动状态
  if (!terminal) act.push('<button type="button" class="btn btn-outline" data-order-act="fee">服务费 / 工厂</button>');
  if (o.status === 'inquiry') act.push('<button type="button" class="btn btn-primary" data-order-act="quote">报价（填服务费）</button>');
  if (o.status === 'quoted') act.push('<button type="button" class="btn btn-primary" data-order-act="confirm">客户已确认</button>');
  if (o.status === 'confirmed') act.push('<button type="button" class="btn btn-primary" data-order-act="forward">转厂下单</button>');
  if (o.status === 'forwarded') act.push('<button type="button" class="btn btn-primary" data-order-act="ship">发货（填物流单号）</button>');
  if (o.status === 'shipped') act.push('<button type="button" class="btn btn-primary" data-order-act="complete">确认完成</button>');
  if (!terminal && o.status !== 'shipped') act.push('<button type="button" class="btn btn-outline" style="color:#c0392b" data-order-act="cancel">取消订单</button>');
  foot.innerHTML = act.join('') || '';
}
async function orderAct(action) {
  const o = CURRENT_ORDER;
  if (!o) return;
  if (action === 'cancel') {
    if (!await askConfirm('取消订单', '确认取消该订单？取消后订单将终止。', '取消订单')) return;
    await updateOrderStatus(o.id, 'cancelled');
    return;
  }
  if (action === 'ship') {
    // 已发货态前台只凭运单号让客户追踪，后端会拒绝空单号，这里先挡住避免白跑一次请求
    const track = await askText({ title: '发货', label: '物流单号（必填）', placeholder: '如 SF1234567890', okText: '确认发货' });
    if (track === null) return;
    if (!String(track).trim()) return toast('请填写物流单号', true);
    await updateOrderStatus(o.id, 'shipped', String(track).trim());
    return;
  }
  if (action === 'fee') { openOrderFeeModal(o); return; }
  if (action === 'quote') {
    // 报价这一步要填服务费，直接开服务费弹窗（填完保存即视为已报价），少一次点击
    openOrderFeeModal(o, { advance: o.status === 'inquiry' || o.status === 'pending' ? 'quoted' : '' });
    return;
  }
  const statusMap = { confirm: 'confirmed', forward: 'forwarded', complete: 'done', 'confirm-paid': 'confirmed' };
  await updateOrderStatus(o.id, statusMap[action]);
}
/* 服务费 / 工厂登记弹窗：模式B 下这是后台唯一能把「服务费、工厂归属、回款时间」写进订单的入口。
 * 独立于状态流转：报价、收款、对账各走各的，避免为了登记一个到账日期被迫改订单状态。
 * 弹窗自建 DOM（admin.html 里没有对应节点），关闭时整块移除，不给页面留隐藏残骸。 */
async function openOrderFeeModal(o, opts) {
  opts = opts || {};
  // 工厂下拉需要品牌档案：订单面板直接进来时缓存可能为空，先补一次（失败不阻断，允许手填 key）
  if (!BRANDS_CACHE) {
    try {
      const d = await api('/api/admin/brands/profile', { headers: authHeaders() });
      BRANDS_CACHE = d.brands || [];
    } catch (_) { BRANDS_CACHE = []; }
  }
  const fee = Number(o.service_fee || 0);
  const field = (label, inner, full) => `<label class="field"${full ? ' style="grid-column:1/-1"' : ''}><span>${label}</span>${inner}</label>`;
  const brandOpts = ['<option value="">— 未指定 —</option>'].concat(
    (BRANDS_CACHE || []).map((b) => `<option value="${escapeHtml(b.key)}"${b.key === (o.factory_id || '') ? ' selected' : ''}>${escapeHtml(b.name || b.key)}</option>`)
  ).join('');
  const feeOpts = Object.entries(FEE_STATUS_LABEL).map(([k, v]) =>
    `<option value="${k}"${(o.service_fee_status || 'unbilled') === k ? ' selected' : ''}>${v}</option>`).join('');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const box = document.createElement('div');
  box.className = 'modal modal-lg';
  box.innerHTML = `
    <div class="modal-head"><h3>服务费 / 工厂登记 · ${escapeHtml(o.id)}</h3></div>
    <div class="form-grid">
      ${field('供货工厂（品牌档案 key）', `<select id="fee-factory">${brandOpts}</select>`, true)}
      ${field('服务费金额（元，不含货款）', `<input type="number" min="0" step="0.01" id="fee-amount" value="${fee ? fee : ''}" placeholder="如 800" />`)}
      ${field('服务费状态', `<select id="fee-status">${feeOpts}</select>`)}
      ${field('服务费到账日期', `<input type="date" id="fee-paid-at" value="${escapeHtml(String(o.service_fee_paid_at || '').slice(0, 10))}" />`)}
      ${field('货款到账日期（客户付给工厂）', `<input type="date" id="goods-paid-at" value="${escapeHtml(String(o.goods_paid_at || '').slice(0, 10))}" />`)}
      ${field('服务费说明（内部备注，不对客户展示）', `<input type="text" id="fee-note" maxlength="300" value="${escapeHtml(o.service_fee_note || '')}" placeholder="如：含打样与验货，订单确认后 3 日内开账" />`, true)}
      ${field('付款说明（货款付工厂、服务费付我方）', `<input type="text" id="pay-note" maxlength="300" value="${escapeHtml(o.pay_note || '')}" placeholder="如：货款直付工厂对公账户，服务费按我方账单支付" />`, true)}
    </div>
    <div class="modal-foot" style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
      <button type="button" class="btn btn-outline" data-fee-close="1">取消</button>
      <button type="button" class="btn btn-primary" id="fee-save">保存</button>
    </div>`;
  document.body.appendChild(mask);
  document.body.appendChild(box);
  const close = () => { mask.remove(); box.remove(); };
  mask.addEventListener('click', close);
  box.querySelector('[data-fee-close]').addEventListener('click', close);
  box.querySelector('#fee-save').addEventListener('click', async () => {
    const payload = {
      version: o.version,
      factory_id: box.querySelector('#fee-factory').value.trim(),
      service_fee: Number(box.querySelector('#fee-amount').value || 0),
      service_fee_status: box.querySelector('#fee-status').value,
      service_fee_note: box.querySelector('#fee-note').value.trim(),
      service_fee_paid_at: box.querySelector('#fee-paid-at').value,
      goods_paid_at: box.querySelector('#goods-paid-at').value,
      pay_note: box.querySelector('#pay-note').value.trim(),
    };
    if (payload.service_fee < 0) return toast('服务费不能为负', true);
    const btn = box.querySelector('#fee-save');
    btn.disabled = true;
    try {
      const r = await api('/api/admin/orders/' + encodeURIComponent(o.id) + '/fee', {
        method: 'POST', headers: authHeaders(), body: JSON.stringify(payload),
      });
      close();
      toast('服务费信息已保存');
      CURRENT_ORDER = r.order || CURRENT_ORDER;
      if (opts.advance) await updateOrderStatus(o.id, opts.advance);
      else { renderOrderModal(CURRENT_ORDER); loadOrdersPanel(); }
    } catch (e) {
      btn.disabled = false;
      toast(e.message, true);
    }
  });
}
async function updateOrderStatus(id, status, trackingNo) {
  try {
    const r = await api('/api/admin/orders/' + encodeURIComponent(id) + '/status', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ status, tracking_no: trackingNo || undefined, version: CURRENT_ORDER ? CURRENT_ORDER.version : undefined }),
    });
    toast('订单状态已更新');
    CURRENT_ORDER = r.order || CURRENT_ORDER;
    renderOrderModal(CURRENT_ORDER);
    loadOrdersPanel();
  } catch (e) { toast(e.message, true); }
}

/* ---- 客户档案 ---- */
async function loadCustomersPanel() {
  const body = $('customers-body');
  if (body) body.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty-cell">加载中…</td></tr>';
  try {
    const data = await api('/api/admin/customers', { headers: authHeaders() });
    CUSTOMERS_CACHE = data.customers || [];
    renderCustomersTable();
  } catch (e) {
    if (body) body.innerHTML = `<tr class="empty-row"><td colspan="7" class="empty-cell">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}
function renderCustomersTable() {
  const body = $('customers-body');
  if (!body) return;
  const kw = ($('customers-search') ? $('customers-search').value : '').trim().toLowerCase();
  const list = (CUSTOMERS_CACHE || []).filter((c) => !kw || ((c.name || '') + (c.phone || '')).toLowerCase().includes(kw));
  if (!list.length) { body.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty-cell">暂无客户</td></tr>'; return; }
  body.innerHTML = list.map((c) => `<tr class="clickable-row" data-customer-phone="${escapeHtml(c.phone)}">
    <td><b>${escapeHtml(c.name || '-')}</b></td>
    <td>${escapeHtml(c.phone)}</td>
    <td class="num">${c.order_count || 0}</td>
    <td class="num">${c.total_qty || 0}</td>
    <td class="num">${c.order_count ? '¥' + money(c.total_amount) : '<span class="muted">—</span>'}</td>
    <td>${fmtTimeAdmin(c.last_order_at)}</td>
    <td><button type="button" class="btn btn-outline btn-sm" data-customer-view="${escapeHtml(c.phone)}">查看</button></td>
  </tr>`).join('');
}
async function openCustomerModal(phone) {
  try {
    const data = await api('/api/admin/customers/' + encodeURIComponent(phone), { headers: authHeaders() });
    const c = data.customer || {};
    const orders = data.orders || [];
    const orderHtml = orders.map((o) => `
      <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:8px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
          <div style="flex:1;min-width:0">
            <b>${escapeHtml(o.id)}</b> ${orderStatusBadge(o.status)}
            <div class="muted" style="font-size:.76rem;margin-top:2px">${fmtTimeAdmin(o.created_at)} · ${(o.items || []).length} 种 / ${(o.items || []).reduce((s, it) => s + (it.qty || 0), 0)} 件 · ¥${money(o.total_amount)}</div>
          </div>
          <button type="button" class="btn btn-outline btn-sm" data-order-view="${escapeHtml(o.id)}">详情</button>
        </div>
      </div>`).join('') || '<div class="muted" style="margin-top:8px">暂无订单</div>';
    $('customer-modal-body').innerHTML = `
      <div class="order-detail-grid">
        <div class="kv"><b>客户名称</b><span>${escapeHtml(c.name || '-')}</span></div>
        <div class="kv"><b>手机号</b><span>${escapeHtml(c.phone)}</span></div>
        <div class="kv"><b>订单数</b><span>${c.order_count || 0}</span></div>
        <div class="kv"><b>累计件数</b><span>${c.total_qty || 0}</span></div>
        <div class="kv"><b>累计金额</b><span style="color:var(--accent);font-weight:700">${c.order_count ? '¥' + money(c.total_amount) : '—'}</span></div>
        <div class="kv"><b>最近下单</b><span>${fmtTimeAdmin(c.last_order_at)}</span></div>
      </div>
      <h4 style="margin:6px 0 2px">历史订单（${orders.length}）</h4>
      ${orderHtml}`;
    openModalAdmin('customer-mask', 'customer-modal');
  } catch (e) { toast(e.message, true); }
}

/* ---- 品牌档案 ---- */
async function loadBrandsPanel() {
  const body = $('brands-body');
  if (body) body.innerHTML = '<tr class="empty-row"><td colspan="7" class="empty-cell">加载中…</td></tr>';
  try {
    const data = await api('/api/admin/brands/profile', { headers: authHeaders() });
    BRANDS_CACHE = data.brands || [];
    renderBrandsTable();
  } catch (e) {
    if (body) body.innerHTML = `<tr class="empty-row"><td colspan="7" class="empty-cell">加载失败：${escapeHtml(e.message)}</td></tr>`;
  }
}
function renderBrandsTable() {
  const body = $('brands-body');
  if (!body) return;
  const kw = ($('brands-search') ? $('brands-search').value : '').trim().toLowerCase();
  const list = (BRANDS_CACHE || []).filter((b) => !kw
    || [b.key, b.name, b.intro, b.services, b.contact].some((v) => String(v || '').toLowerCase().includes(kw)));
  if (!(BRANDS_CACHE || []).length) { body.innerHTML = '<tr class="empty-row"><td colspan="8" class="empty-cell">暂无品牌档案，点击右上角新增</td></tr>'; return; }
  if (!list.length) { body.innerHTML = `<tr class="empty-row"><td colspan="8" class="empty-cell">没有匹配「${escapeHtml(kw)}」的品牌档案</td></tr>`; return; }
  const today = new Date().toISOString().slice(0, 10);
  body.innerHTML = list.map((b) => {
    const certsN = (b.certs || []).length;
    const accOk = !!(b.bank_account_name && b.bank_name && b.bank_account);
    // 证号全量展示供人工核对；账号只出后四位，后台列表不做整号外露
    const licNo = b.license_no ? '<span class="muted">证号 ' + escapeHtml(b.license_no) + '</span>' : '<span style="color:#c0392b">缺许可证号</span>';
    let lic;
    if (!b.license_valid_to) lic = '<span style="color:#c0392b">缺有效期</span>';
    else if (b.license_valid_to < today) lic = '<span style="color:#c0392b">已过期 ' + escapeHtml(b.license_valid_to) + '</span>';
    else lic = '<span style="color:#059669">有效期至 ' + escapeHtml(b.license_valid_to) + '</span>';
    const accTail = b.bank_account ? String(b.bank_account).slice(-4) : '';
    const accLine = accOk
      ? '<span style="color:#059669">对公 ****' + escapeHtml(accTail) + ' · ' + escapeHtml(b.bank_name) + '</span>'
      : '<span style="color:#c0392b">缺对公账户</span>';
    const channel = [
      b.entity_name ? escapeHtml(b.entity_name) : '<span class="muted">未填主体全称</span>',
      licNo + ' ' + lic,
      accLine,
    ].join('<br>');
    return `<tr>
    <td><b>${escapeHtml(b.key)}</b></td>
    <td>${escapeHtml(b.name || '-')}</td>
    <td>${b.product_count || 0}</td>
    <td class="num">${certsN}</td>
    <td style="font-size:.78rem;line-height:1.75">${channel}</td>
    <td>${escapeHtml((b.intro || '').slice(0, 30))}</td>
    <td>${fmtTimeAdmin(b.updated_at) || '<span class="muted">—</span>'}</td>
    <td>
      <button type="button" class="btn btn-outline btn-sm" data-brand-edit="${escapeHtml(b.key)}">编辑</button>
      <button type="button" class="btn btn-outline btn-sm" style="color:#c0392b" data-brand-del="${escapeHtml(b.key)}">删除</button>
    </td>
  </tr>`;
  }).join('');
}
function openBrandModal(b) {
  BRAND_EDITING = b ? Object.assign({}, b) : { key: '', name: '', intro: '', services: '', contact: '', certs: [] };
  $('brand-modal-title').textContent = b ? `编辑品牌档案：${b.name || b.key}` : '新增品牌档案';
  const certs = (BRAND_EDITING.certs || []).map((c) => `
    <div class="cert-list-item">
      <img class="cert-thumb" src="${escapeHtml(imgUrl(c))}" onerror="this.style.display='none'" />
      <span style="flex:1;font-size:.78rem;word-break:break-all">${escapeHtml(c)}</span>
      <button type="button" class="btn btn-outline btn-sm" data-cert-del="${escapeHtml(c)}">移除</button>
    </div>`).join('') || '<div class="muted" style="font-size:.78rem">暂无资质证书图</div>';
  $('brand-modal-body').innerHTML = `
    <div class="form-grid brand-form">
      <div class="field"><label>品牌 Key *（唯一标识，创建后不可改）</label><input id="b-key" value="${escapeHtml(BRAND_EDITING.key || '')}" ${b ? 'readonly' : ''} placeholder="如 main / supplier-a" /></div>
      <div class="field"><label>品牌名称 *</label><input id="b-name" value="${escapeHtml(BRAND_EDITING.name || '')}" placeholder="如 领柿食品" /></div>
      <div class="field" style="grid-column:1/-1"><label>公司介绍（换行保留）</label><textarea id="b-intro" placeholder="公司简介、主营产品、优势…">${escapeHtml(BRAND_EDITING.intro || '')}</textarea></div>
      <div class="field" style="grid-column:1/-1"><label>服务说明（可含下单流程/物流/售后，换行保留）</label><textarea id="b-services">${escapeHtml(BRAND_EDITING.services || '')}</textarea></div>
      <div class="field" style="grid-column:1/-1"><label>联系方式（可含地址/电话/微信，换行保留）</label><textarea id="b-contact">${escapeHtml(BRAND_EDITING.contact || '')}</textarea></div>
      <div class="field" style="grid-column:1/-1"><label>工厂资质（模式B 公示项：客户在品牌页可见，仅账户不公开）</label></div>
      <div class="field"><label>主体全称（营业执照名称）</label><input id="b-entity" maxlength="80" value="${escapeHtml(BRAND_EDITING.entity_name || '')}" placeholder="如 内蒙古某某食品有限公司" /></div>
      <div class="field"><label>食品生产许可证号</label><input id="b-license-no" maxlength="40" value="${escapeHtml(BRAND_EDITING.license_no || '')}" placeholder="SC 开头" /></div>
      <div class="field"><label>许可品类 / 范围</label><input id="b-license-scope" maxlength="200" value="${escapeHtml(BRAND_EDITING.license_scope || '')}" placeholder="如 调味品（半固态）" /></div>
      <div class="field"><label>许可证有效期至</label><input type="date" id="b-license-valid-to" value="${escapeHtml(BRAND_EDITING.license_valid_to || '')}" /></div>
      <div class="field"><label>生产地址</label><input id="b-factory-address" maxlength="200" value="${escapeHtml(BRAND_EDITING.factory_address || '')}" placeholder="许可证载明地址" /></div>
      <div class="field" style="grid-column:1/-1"><label>货款收款账户（客户直付工厂用，仅后台与查单双因子下发，绝不出现在品牌页）</label></div>
      <div class="field"><label>收款户名（须与主体全称一致）</label><input id="b-bank-account-name" maxlength="80" value="${escapeHtml(BRAND_EDITING.bank_account_name || '')}" /></div>
      <div class="field"><label>开户行（含支行）</label><input id="b-bank-name" maxlength="80" value="${escapeHtml(BRAND_EDITING.bank_name || '')}" /></div>
      <div class="field"><label>对公账号</label><input id="b-bank-account" maxlength="40" value="${escapeHtml(BRAND_EDITING.bank_account || '')}" placeholder="仅数字/字母/短横" /></div>
    </div>
    <div class="field" style="margin-top:12px">
      <label>资质证书图（${(BRAND_EDITING.certs || []).length}）</label>
      <div id="b-certs-list">${certs}</div>
      <div style="display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="b-cert-url" placeholder="粘贴图片 URL（/img/... 或 http...）" style="flex:1;min-width:200px" />
        <button type="button" class="btn btn-outline btn-sm" id="b-cert-add">添加 URL</button>
        <span class="muted" style="font-size:.74rem">或</span>
        <input type="file" id="b-cert-file" accept="image/*" style="display:none" />
        <button type="button" class="btn btn-outline btn-sm" id="b-cert-upload">上传图片</button>
      </div>
    </div>`;
  openModalAdmin('brand-mask', 'brand-modal');
}
async function handleCertUpload() {
  const file = $('b-cert-file').files[0];
  if (!file) return toast('请选择图片', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return toast('仅支持 JPG/PNG/WebP', true);
  if (CERT_UPLOADING) return;
  CERT_UPLOADING = true;
  try {
    const { dataUrl, ext } = await fileToImageBase64(file, { maxSize: 1200, quality: 0.85 });
    const filename = `brand-cert-${Date.now().toString(36)}.${ext}`;
    const r = await api('/api/upload', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ filename, base64: dataUrl }) });
    (BRAND_EDITING.certs = BRAND_EDITING.certs || []).push(r.url);
    openBrandModal(BRAND_EDITING);
    toast('资质图片已上传');
  } catch (e) { toast(e.message, true); } finally { CERT_UPLOADING = false; }
}

/* ---- 交易面板事件绑定 ---- */
function bindTradeEvents() {
  const of = $('orders-filter');
  if (of) of.addEventListener('change', () => { loadOrdersPanel(); });
  const os = $('orders-search');
  if (os) os.addEventListener('input', () => renderOrdersTable());
  const oref = $('orders-refresh-btn');
  if (oref) oref.addEventListener('click', () => loadOrdersPanel());
  const cs = $('customers-search');
  if (cs) cs.addEventListener('input', () => renderCustomersTable());
  const bs = $('brands-search');
  if (bs) bs.addEventListener('input', () => renderBrandsTable());
  const ob = $('orders-body');
  if (ob) ob.addEventListener('click', (e) => {
    const view = e.target.closest('[data-order-view]');
    if (view) { e.stopPropagation(); openOrderModal(view.dataset.orderView); return; }
    const row = e.target.closest('tr[data-order-id]');
    if (row) openOrderModal(row.dataset.orderId);
  });
  const cb = $('customers-body');
  if (cb) cb.addEventListener('click', (e) => {
    const view = e.target.closest('[data-customer-view]');
    if (view) { e.stopPropagation(); openCustomerModal(view.dataset.customerView); return; }
    const row = e.target.closest('tr[data-customer-phone]');
    if (row) openCustomerModal(row.dataset.customerPhone);
  });
  const bb = $('brands-body');
  if (bb) bb.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-brand-edit]');
    if (edit) { const b = (BRANDS_CACHE || []).find((x) => x.key === edit.dataset.brandEdit); if (b) openBrandModal(b); return; }
    const del = e.target.closest('[data-brand-del]');
    if (del) {
      askConfirm('删除品牌档案', '确认删除该品牌档案？前台品牌页将不可用。', '删除').then((ok) => {
        if (!ok) return;
        api('/api/admin/brands/profile/' + encodeURIComponent(del.dataset.brandDel), { method: 'DELETE', headers: authHeaders() })
          .then(() => { toast('品牌档案已删除'); loadBrandsPanel(); })
          .catch((err) => toast(err.message, true));
      });
    }
  });
  const fm = $('order-modal-foot');
  if (fm) fm.addEventListener('click', (e) => {
    const act = e.target.closest('[data-order-act]');
    if (act) orderAct(act.dataset.orderAct);
  });
  const cmb = $('customer-modal-body');
  if (cmb) cmb.addEventListener('click', (e) => {
    const view = e.target.closest('[data-order-view]');
    if (view) { closeModalAdmin('customer-mask', 'customer-modal'); openOrderModal(view.dataset.orderView); }
  });
  const bm = $('brand-modal-body');
  if (bm) bm.addEventListener('click', (e) => {
    const del = e.target.closest('[data-cert-del]');
    if (del) { BRAND_EDITING.certs = (BRAND_EDITING.certs || []).filter((c) => c !== del.dataset.certDel); openBrandModal(BRAND_EDITING); return; }
    const add = e.target.closest('#b-cert-add');
    if (add) {
      const v = ($('b-cert-url') ? $('b-cert-url').value : '').trim();
      if (!v) return toast('请输入图片 URL', true);
      (BRAND_EDITING.certs = BRAND_EDITING.certs || []).push(v);
      openBrandModal(BRAND_EDITING);
      return;
    }
    const up = e.target.closest('#b-cert-upload');
    if (up) { const f = $('b-cert-file'); if (f) f.click(); }
  });
  const bf = $('b-cert-file');
  if (bf) bf.addEventListener('change', () => handleCertUpload().catch((err) => toast(err.message, true)));
  const addBtn = $('brand-add-btn');
  if (addBtn) addBtn.addEventListener('click', () => openBrandModal(null));
  const saveBtn = $('brand-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', async () => {
    const key = ($('b-key') ? $('b-key').value : '').trim();
    const name = ($('b-name') ? $('b-name').value : '').trim();
    if (!key) return toast('请填写品牌 Key', true);
    if (!name) return toast('请填写品牌名称', true);
    const v = (id) => ($(id) ? String($(id).value || '').trim() : '');
    const bankAccount = v('b-bank-account');
    // 账号只允许数字/字母/短横，与后端 sanitizeBankAccount 保持一致，避免静默清空
    if (bankAccount && !/^[0-9A-Za-z\-]+$/.test(bankAccount)) {
      return toast('对公账号只能填数字、字母或短横', true);
    }
    const payload = {
      key,
      name,
      intro: $('b-intro') ? $('b-intro').value : '',
      services: $('b-services') ? $('b-services').value : '',
      contact: $('b-contact') ? $('b-contact').value : '',
      certs: BRAND_EDITING.certs || [],
      // 模式B：资质公示 5 项 + 货款收款账户 3 项（后端白名单 FACTORY_TEXT_FIELDS 已支持）
      entity_name: v('b-entity'),
      license_no: v('b-license-no'),
      license_scope: v('b-license-scope'),
      license_valid_to: v('b-license-valid-to'),
      factory_address: v('b-factory-address'),
      bank_account_name: v('b-bank-account-name'),
      bank_name: v('b-bank-name'),
      bank_account: bankAccount,
    };
    try {
      await api('/api/admin/brands/profile/' + encodeURIComponent(key), { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) });
      toast('品牌档案已保存');
      closeModalAdmin('brand-mask', 'brand-modal');
      loadBrandsPanel();
    } catch (e) { toast(e.message, true); }
  });
  const sellerSave = $('seller-save-btn');
  if (sellerSave) sellerSave.addEventListener('click', () => saveSellerPanel());
  const closers = [['order-mask', 'order-modal', 'order-close'], ['customer-mask', 'customer-modal', 'customer-close'], ['brand-mask', 'brand-modal', 'brand-close']];
  closers.forEach(([maskId, modalId, closeId]) => {
    const m = $(maskId), d = $(modalId), c = $(closeId);
    if (m) m.addEventListener('click', () => closeModalAdmin(maskId, modalId));
    if (c) c.addEventListener('click', () => closeModalAdmin(maskId, modalId));
    if (d) d.addEventListener('click', (e) => { if (e.target === d) closeModalAdmin(maskId, modalId); });
  });
}
bindTradeEvents();

/* ---- 服务方主体（模式B 纯居间：只公示撮合方与收款说明，不登记任何货款账户） ---- */
const SELLER_MAP = [
  ['s-entity', 'entity_name'],
  ['s-credit', 'credit_code'],
  ['s-address', 'address'],
  ['s-license', 'license_no'],
  ['s-scope', 'license_scope'],
  ['s-contact', 'contact'],
  ['s-fee-note', 'fee_note'],
];

async function loadSellerPanel() {
  try {
    const r = await api('/api/site/seller', { headers: authHeaders() });
    const d = (r && (r.seller || r)) || {};
    SELLER_MAP.forEach(([id, key2]) => { if ($(id)) $(id).value = d[key2] == null ? '' : String(d[key2]); });
  } catch (e) {
    toast('加载服务方主体失败：' + e.message, true);
  }
}

async function saveSellerPanel() {
  const payload = {};
  SELLER_MAP.forEach(([id, key2]) => { payload[key2] = ($(id) ? String($(id).value || '').trim() : ''); });
  // 主体名称与经营范围是该区块的成立前提，缺任一项前台整块不渲染
  if (!payload.entity_name) return toast('请填写服务方主体名称', true);
  if (!payload.license_scope) return toast('请填写经营范围 / 服务内容', true);
  const btn = $('seller-save-btn');
  if (btn) btn.disabled = true;
  try {
    await api('/api/site/seller', { method: 'PUT', headers: authHeaders(), body: JSON.stringify(payload) });
    toast('服务方主体已保存');
    loadSellerPanel();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}
