/* Lightning Shop 管理后台逻辑：登录、产品增删改、图片上传 */
const API = '/api';
const TOKEN_KEY = 'ls_admin_token';

const $ = (id) => document.getElementById(id);
let products = [];
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
    throw new Error('登录已失效，请重新输入密码');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.message || data.error || `请求失败(${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function login() {
  const pass = $('login-pass').value.trim();
  if (!pass) return toast('请输入管理密码', true);
  sessionStorage.setItem(TOKEN_KEY, pass);
  load().catch((err) => toast(err.message, true));
}

function logout() {
  sessionStorage.removeItem(TOKEN_KEY);
  $('login-panel').classList.remove('hidden');
  $('admin-main').classList.add('hidden');
  $('logout-btn').hidden = true;
}

async function load() {
  // 用全量接口校验密码并拉取列表（含下架产品）
  const data = await api('/api/admin/products', { headers: authHeaders() });
  products = data;
  renderList();
  $('login-panel').classList.add('hidden');
  $('admin-main').classList.remove('hidden');
  $('logout-btn').hidden = false;
  loadCategoryOptions();
  loadConfigCategories();
  loadHero();
  loadQr();
  loadPrice();
}

async function reload() {
  const data = await api('/api/admin/products', { headers: authHeaders() });
  products = data;
  renderList();
  loadCategoryOptions();
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
      (extra.length
        ? `<span class="chip chip-extra" title="产品中自动发现的分类">${extra.map((c) => esc(c.name)).join('、')}<span class="chip-count">${extra.reduce((s, c) => s + c.count, 0)}</span></span>`
        : '');
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
  if (!confirm(`确定删除分类「${name}」？\n仅从分类配置移除，产品数据不受影响。`)) return;
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
  const cats = await api('/api/categories', { headers: authHeaders() });
  const dl = $('category-list');
  dl.innerHTML = cats.map((c) => `<option value="${c.name}"></option>`).join('');
  const sel = $('batch-cat-select');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— 选择分类 —</option>' + cats.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}（${c.count}）</option>`).join('');
  sel.value = cur;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 多标签渲染：badge 字符串按逗号/顿号/竖线拆分，逐个输出小标签 */
function badgeChips(raw) {
  const list = String(raw || '').split(/[,，|]/).map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) return '';
  return `<span class="badge-chips">${list.map((b) => `<span class="badge-chip${b.includes('低GI') ? ' gi' : ''}">${esc(b)}</span>`).join('')}</span>`;
}

function renderList() {
  const q = ($('list-search').value || '').trim().toLowerCase();
  const list = q
    ? products.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q))
    : products;
  $('list-count').textContent = `共 ${products.length} 个`;
  $('list-body').innerHTML = list
    .map(
      (p) => `<tr>
        <td><input type="checkbox" class="row-check" data-id="${esc(p.id)}" ${selected.has(p.id) ? 'checked' : ''} /></td>
        <td>${p.image ? `<img src="${p.image}" alt="" />` : '<div class="ph">无图</div>'}</td>
        <td>${esc(p.id)}</td>
        <td>${esc(p.name)}</td>
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
 * opts.quality  JPEG 质量 0-1，默认 0.85 */
function fileToJpgBase64(file, opts = {}) {
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
      resolve(canvas.toDataURL('image/jpeg', QUALITY));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}

async function handleUpload() {
  const file = $('f-img-file').files[0];
  if (!file) return toast('请选择图片文件', true);
  if (!/\.(jpe?g|png|webp)$/i.test(file.name)) return toast('仅支持 JPG / PNG / WebP', true);
  const dataUrl = await fileToJpgBase64(file, { square: $('f-img-crop')?.checked, maxSize: 1000, quality: 0.82 });
  const filename = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  const r = await api('/api/upload', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filename, base64: dataUrl }),
  });
  $('f-img').value = r.url;
  const prev = $('img-preview');
  prev.src = r.url;
  prev.hidden = false;
  toast('图片上传成功');
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
  const dataUrl = await fileToJpgBase64(file, { maxSize: 1600, quality: 0.8 });
  const filename = `hero-${Date.now()}.jpg`;
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
  const dataUrl = await fileToJpgBase64(file, { maxSize: 800, quality: 0.85 });
  const filename = `quote-qr-${Date.now()}.jpg`;
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
    if (!confirm(`确认删除「${p.name}」？关联图片也会一并删除。`)) return;
    try {
      await api(`/api/products/${id}`, { method: 'DELETE', headers: authHeaders() });
      toast('已删除');
      await reload();
    } catch (err) { toast(err.message, true); }
  }
}

/* 事件绑定 */
$('login-btn').addEventListener('click', login);
$('login-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout-btn').addEventListener('click', logout);
$('product-form').addEventListener('submit', submitForm);
$('form-reset').addEventListener('click', resetForm);
$('f-img-file').addEventListener('change', () => handleUpload().catch((err) => toast(err.message, true)));
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
$('list-search').addEventListener('input', renderList);

/* ---- 批量修改 ---- */
$('check-all').addEventListener('change', (e) => {
  const q = ($('list-search').value || '').trim().toLowerCase();
  const visible = q
    ? products.filter((p) => (p.name || '').toLowerCase().includes(q) || (p.brand || '').toLowerCase().includes(q))
    : products;
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
  if (!confirm(`确认将「${fieldLabel}」批量修改为「${value || '(清空)'}」？将影响 ${ids.length} 个产品。`)) return;
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

/* ---- Tab 切换 ---- */
$('admin-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const active = b === btn;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === 'tab-' + btn.dataset.tab);
  });
});

/* 初始化：有 token 直接尝试进入 */
if (sessionStorage.getItem(TOKEN_KEY)) {
  load().catch((err) => toast(err.message, true));
}
