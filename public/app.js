/* Lightning Shop 前端逻辑：加载产品、分类筛选、搜索渲染 */

const grid = document.getElementById('product-grid');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search-input');
const tabs = document.getElementById('category-tabs');
const brandTabs = document.getElementById('brand-tabs');
const resultMeta = document.getElementById('result-meta');

let products = [];
let total = 0;
let activeCategory = '';
let activeBrand = '';
let loading = false;
const PAGE_SIZE = 24;
let currentPage = 0; // 当前页码（0-based），PC 分页器使用
let totalPages = 0;  // 总页数
// 单行折叠状态：chip 列表始终保持一行，放不下时溢出项隐藏 + 「展开 N 个」按钮
let categoryExpanded = false;
let brandExpanded = false;
let categoryList = [];
let brandList = [];

const CATEGORY_LABEL = {
  低GI杂粮: '低GI杂粮',
  营养粮油: '营养粮油',
  黄柿子火锅底料: '黄柿子火锅底料',
  野生苦菜: '野生苦菜',
  坚果玉米: '坚果玉米',
  羊杂碎: '羊杂碎',
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 图片地址白名单：站内 /img/{安全文件名} 或 http(s) 绝对地址，其余一律丢弃。
   订单明细/商品图来自外部输入（匿名下单、供应商上传），直接拼进 src 会形成存储型 XSS。 */
function safeImgUrl(u) {
  const s = String(u ?? '').trim();
  if (!s || s.length > 300) return '';
  if (/[\u0000-\u001f"'<>\\]/.test(s)) return '';
  if (/^\/img\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')) return s;
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  return '';
}

/* 价格：展示价一律由服务端投影下发（已按后台策略加价），前端不再二次加价，
 * 也不再拉取 /api/site/price（利润率属于内部经营参数，不对匿名下发） */
function displayPrice(str) {
  return String(str === undefined || str === null ? '' : str);
}

function cardHtml(p) {
  const badge = p.badge
    ? `<span class="card-badges">${String(p.badge).split(/[,，|]/).map((s) => s.trim()).filter(Boolean)
        .map((b) => `<span class="card-badge${b.includes('低GI') ? ' gi' : ''}">${escapeHtml(b)}</span>`)
        .join('')}</span>`
    : '';

  const media = p.image
    ? `<img src="${escapeHtml(safeImgUrl(p.image))}" alt="${escapeHtml(p.name)}" loading="lazy" decoding="async" />`
    : `<div class="card-placeholder" aria-hidden="true">🍱</div>`;

  const retailText = p.retail_price && !p.retail_price.includes('报价') ? p.retail_price : '议价';

  const shareBtn = `
    <button class="share-btn" type="button" data-pid="${escapeHtml(p.id)}" aria-label="分享 ${escapeHtml(p.name)}" title="生成分享图">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
    </button>`;

  return `
    <article class="product-card">
      <div class="card-media">${media}${badge}${shareBtn}</div>
      <div class="card-body">
        <h3 class="card-name"><a href="#/p/${encodeURIComponent(p.id)}" class="card-name-link">${escapeHtml(p.name)}</a></h3>
        <p class="card-spec">${escapeHtml(p.spec)} · ${escapeHtml(p.brand)}</p>
        <div class="hl-wrap">
          <p class="card-highlight">${escapeHtml(p.highlights)}</p>
          <button class="hl-toggle" type="button" hidden>更多</button>
        </div>
        <div class="card-meta">
          ${p.cert ? `<span class="card-tag">${escapeHtml(p.cert)}</span>` : ''}
          ${p.moq ? `<span class="card-tag amber">起订 ${escapeHtml(p.moq)}</span>` : ''}
        </div>
        <div class="card-price">
          <div class="price-wholesale">
            <span>批发价</span>
            <b>${escapeHtml(displayPrice(p.price))}</b>
          </div>
          <div class="price-retail">
            <span>零售</span>
            <b>${escapeHtml(displayPrice(retailText))}</b>
          </div>
        </div>
        <a class="card-detail-link" href="#/p/${encodeURIComponent(p.id)}">查看详情 →</a>
      </div>
    </article>`;
}

function render() {
  grid.innerHTML = products.map(cardHtml).join('');
  grid.removeAttribute('aria-busy');
  emptyState.hidden = products.length > 0;
  updateResultMeta();
  updateLoadMore();
  updatePagination();
  initHighlightToggles();
}

/* 描述折叠：默认最多显示 3 行；溢出时显示「更多」按钮，点击展开/收起 */
function initHighlightToggles() {
  document.querySelectorAll('.hl-wrap').forEach((wrap) => {
    const p = wrap.querySelector('.card-highlight');
    const btn = wrap.querySelector('.hl-toggle');
    if (!p || !btn) return;
    p.classList.add('clamped');
    btn.hidden = p.scrollHeight <= p.clientHeight + 1;
  });
}

function toggleHighlight(btn) {
  const wrap = btn.closest('.hl-wrap');
  if (!wrap) return;
  const p = wrap.querySelector('.card-highlight');
  if (!p) return;
  const isClamped = p.classList.contains('clamped');
  p.classList.toggle('clamped', !isClamped);
  btn.textContent = isClamped ? '收起' : '更多';
}

/* 端判定：768px 断点与 CSS 响应式一致（PC=分页器 / 移动=触底加载） */
function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function updateLoadMore() {
  const moreBtn = document.getElementById('load-more');
  if (!moreBtn) return;
  // PC 端由页码分页器接管，按钮隐藏；移动端保留按钮作触底加载兜底
  if (!isMobile()) { moreBtn.hidden = true; return; }
  moreBtn.hidden = products.length >= total;
}

function updatePagination() {
  const pager = document.getElementById('pagination');
  if (!pager) return;
  totalPages = Math.ceil(total / PAGE_SIZE);
  if (isMobile() || totalPages <= 1) {
    pager.hidden = true;
    pager.innerHTML = '';
    return;
  }
  pager.hidden = false;
  pager.innerHTML = pagerHtml(totalPages, currentPage);
}

/* 页码窗口：首/尾页 + 当前页前后各 2 页，其余用省略号折叠；页数少时全量展示 */
function pagerHtml(totalPages, page) {
  const parts = [];
  const pushBtn = (text, key, cls, disabled) => {
    const activeMark = (!disabled && key !== 'prev' && key !== 'next' && Number(key) === page)
      ? ' aria-current="page"' : '';
    parts.push(`<button type="button" class="pager-btn${cls ? ' ' + cls : ''}" data-page="${key}" ${disabled ? 'disabled' : ''}${activeMark}>${text}</button>`);
  };
  pushBtn('‹ 上一页', 'prev', '', page <= 0);
  const start = Math.max(0, page - 2);
  const end = Math.min(totalPages - 1, page + 2);
  if (start > 0) pushBtn('1', '0', '', false);
  if (start > 1) parts.push('<span class="pager-ellipsis">…</span>');
  for (let i = start; i <= end; i++) pushBtn(String(i + 1), String(i), i === page ? 'active' : '', false);
  if (end < totalPages - 2) parts.push('<span class="pager-ellipsis">…</span>');
  if (end < totalPages - 1) pushBtn(String(totalPages), String(totalPages - 1), '', false);
  pushBtn('下一页 ›', 'next', '', page >= totalPages - 1);
  return parts.join('');
}

function chipHtml(key, name, count, active) {
  return `<button class="chip${active ? ' active' : ''}" type="button" data-${key}="${escapeHtml(name)}" aria-pressed="${active}">
    <span class="chip-name">${escapeHtml(name || '全部')}</span>
    <span class="chip-count">${count}</span>
  </button>`;
}

function renderTabs(categories) {
  categoryList = categories;
  const all = [{ name: '', count: total }].concat(categories);
  tabs.innerHTML = all
    .map((c) => chipHtml('category', c.name, c.count, c.name === activeCategory))
    .join('');
  applyCollapse(tabs, 'category');
}

function renderBrandTabs(brands) {
  brandList = brands;
  const all = [{ name: '', count: total }].concat(brands);
  brandTabs.innerHTML = all
    .map((b) => chipHtml('brand', b.name, b.count, b.name === activeBrand))
    .join('');
  applyCollapse(brandTabs, 'brand');
}

/* 单行折叠：chip 列表始终保持一行；一行放不下（出现换行）时从尾部隐藏溢出项，
   追加「展开 N 个」按钮（与可见项同排）；展开后全部显示可换行，点「收起」恢复单行。
   手机端（<=480px）保持横向滑动全展示，不参与折叠。 */
function sameRow(elms) {
  if (!elms.length) return true;
  const top = elms[0].getBoundingClientRect().top;
  return elms.every((c) => Math.abs(c.getBoundingClientRect().top - top) < 2);
}

function applyCollapse(listEl, key) {
  if (!listEl) return;
  // 清理旧的隐藏标记与 toggle 按钮
  listEl.querySelectorAll('.chip-hidden').forEach((c) => c.classList.remove('chip-hidden'));
  listEl.querySelectorAll('.chip-toggle').forEach((t) => t.remove());
  listEl.classList.remove('chip-collapsed');
  if (window.matchMedia('(max-width: 480px)').matches) return; // 手机端横滑，不折叠

  const expanded = key === 'category' ? categoryExpanded : brandExpanded;
  if (expanded) {
    listEl.insertAdjacentHTML('beforeend',
      `<button class="chip chip-toggle" type="button" data-toggle="${key}" aria-expanded="true">收起</button>`);
    return;
  }
  const chips = Array.from(listEl.querySelectorAll('.chip:not(.chip-toggle)'));
  if (!chips.length || sameRow(chips)) return; // 一行放得下，无需折叠

  // 预留 toggle 按钮空间：从尾部隐藏 chip，直到可见项与 toggle 同排
  listEl.classList.add('chip-collapsed');
  listEl.insertAdjacentHTML('beforeend',
    `<button class="chip chip-toggle" type="button" data-toggle="${key}" aria-expanded="false">展开</button>`);
  let hidden = 0;
  const toggle = listEl.querySelector('.chip-toggle');
  for (let i = chips.length - 1; i >= 0; i--) {
    chips[i].classList.add('chip-hidden');
    hidden++;
    const rest = Array.from(listEl.querySelectorAll('.chip:not(.chip-hidden)'));
    if (sameRow(rest)) break;
  }
  toggle.textContent = `展开 ${hidden} 个`;
}

function updateResultMeta() {
  if (!resultMeta) return;
  const q = searchInput.value.trim();
  const parts = [];
  if (activeCategory) parts.push(`品类「${activeCategory}」`);
  if (activeBrand) parts.push(`品牌「${activeBrand}」`);
  if (q) parts.push(`关键词「${q}」`);
  const prefix = parts.length ? `筛选：${parts.join(' + ')} · 共 ` : '共 ';
  resultMeta.textContent = `${prefix}${total} 件商品`;
}

function applyHero(hero) {
  if (!hero) return;
  // 浏览器标签动态跟随小字配置：Lightning Shop · <eyebrow>
  document.title = `Lightning Shop · ${hero.eyebrow || ''}`;
  const titleEl = document.getElementById('hero-title');
  const heroStats = document.getElementById('hero-stats');
  const heroEl = document.querySelector('.hero');
  if (titleEl && hero.title) titleEl.textContent = hero.title;
  if (heroStats) heroStats.textContent = hero.eyebrow || '';
  if (heroEl) {
    if (hero.bgImage) {
      heroEl.style.backgroundImage = `linear-gradient(135deg, rgba(6,78,59,.82) 0%, rgba(5,110,80,.72) 60%, rgba(16,185,129,.66) 100%), url('${hero.bgImage}')`;
      heroEl.style.backgroundSize = 'cover';
      heroEl.style.backgroundPosition = 'center';
      // 首屏 hero 大图预加载：CSS 背景图不走浏览器预加载，显式 fetchPriority 抢占
      if (!document.querySelector(`link[rel="preload"][href="${hero.bgImage}"]`)) {
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = hero.bgImage;
        link.fetchPriority = 'high';
        document.head.appendChild(link);
      }
    } else {
      heroEl.style.backgroundImage = '';
    }
  }
}

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

function applyQr(qr) {
  if (!qr) return;
  // 报价二维码：.b2b 区块 + 联系方式面板同步
  const quoteImgs = ['quote-qr-img', 'contact-quote-img']
    .map((id) => document.getElementById(id)).filter(Boolean);
  if (qr.quoteImage) {
    quoteImgs.forEach((img) => { img.src = qr.quoteImage; img.alt = '报价单二维码'; });
  }
  const quoteTitle = document.getElementById('quote-qr-title');
  const contactQuoteTitle = document.getElementById('contact-quote-title');
  if (qr.quoteTitle && quoteTitle) quoteTitle.textContent = qr.quoteTitle;
  if (qr.quoteTitle && contactQuoteTitle) contactQuoteTitle.textContent = qr.quoteTitle;
  const shopTitle = document.getElementById('shop-qr-title');
  const contactShopTitle = document.getElementById('contact-shop-title');
  if (qr.shopTitle && shopTitle) shopTitle.textContent = qr.shopTitle;
  if (qr.shopTitle && contactShopTitle) contactShopTitle.textContent = qr.shopTitle;
  // 商城二维码：.b2b 区块与联系方式面板各生成一份（同配置同尺寸）
  const boxes = ['site-qr', 'contact-site-qr']
    .map((id) => document.getElementById(id)).filter(Boolean);
  if (qr.url && typeof QRCode !== 'undefined') {
    boxes.forEach((box) => {
      try {
        box.innerHTML = '';
        // 移动端按 220px 容器生成 206px 位图，微信内长按识别更稳
        const qrSize = window.matchMedia('(max-width: 768px)').matches ? 206 : 180;
        new QRCode(box, {
          text: qr.url,
          width: qrSize,
          height: qrSize,
          colorDark: '#111111',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M,
        });
        styleQrGradient(box);
        box.hidden = false;
      } catch {
        /* 二维码生成失败不阻塞页面 */
      }
    });
  }
}

function updateStats() {
  const sku = total;
  const brands = new Set(products.map((p) => p.brand).filter(Boolean)).size;
  const skuEl = document.getElementById('stat-sku');
  const brandEl = document.getElementById('stat-brand');
  if (skuEl) skuEl.textContent = String(sku);
  if (brandEl) brandEl.textContent = String(brands);
}

async function fetchPage(offset) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (activeCategory) params.set('category', activeCategory);
  if (activeBrand) params.set('brand', activeBrand);
  const q = searchInput.value.trim();
  if (q) params.set('q', q);
  const res = await fetch(`/api/products?${params.toString()}`);
  const data = await res.json();
  return Array.isArray(data) ? { items: data, total: data.length } : data;
}

async function reload() {
  if (loading) return;
  loading = true;
  try {
    const data = await fetchPage(0);
    products = data.items || [];
    total = data.total || products.length;
    currentPage = 0;
    render();
    updateStats();
  } catch (err) {
    grid.innerHTML = '<p style="color:#dc2626">加载失败，请刷新重试。</p>';
  } finally {
    loading = false;
  }
}

async function loadMore() {
  if (loading || products.length >= total) return;
  loading = true;
  const moreBtn = document.getElementById('load-more');
  if (moreBtn) {
    moreBtn.disabled = true;
    moreBtn.textContent = '加载中…';
  }
  try {
    const data = await fetchPage(products.length);
    products = products.concat(data.items || []);
    total = data.total || products.length;
    render();
  } finally {
    if (moreBtn) {
      moreBtn.disabled = false;
      moreBtn.textContent = '加载更多';
    }
    loading = false;
  }
}

/* PC 分页：切换页码直接替换当前列表（加载指定页） */
async function goToPage(page) {
  if (loading) return;
  if (page < 0 || page >= totalPages) return;
  currentPage = page;
  loading = true;
  try {
    const data = await fetchPage(currentPage * PAGE_SIZE);
    products = data.items || [];
    total = data.total || products.length;
    render();
    const productsEl = document.getElementById('products');
    if (productsEl) productsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    grid.innerHTML = '<p style="color:#dc2626">加载失败，请刷新重试。</p>';
  } finally {
    loading = false;
  }
}

async function load() {
  try {
    const [data, cRes, bRes, heroRes, qrRes] = await Promise.all([
      fetchPage(0),
      fetch('/api/categories'),
      fetch('/api/brands'),
      fetch('/api/site/hero'),
      fetch('/api/site/qr'),
    ]);
    products = data.items || [];
    total = data.total || products.length;
    const categories = await cRes.json();
    const brands = await bRes.json();
    const hero = await heroRes.json().catch(() => null);
    const qrConfig = await qrRes.json().catch(() => null);
    renderTabs(categories);
    renderBrandTabs(brands);
    render();
    updateStats();
    applyHero(hero);
    applyQr(qrConfig);
  } catch (err) {
    grid.innerHTML = '<p style="color:#dc2626">加载失败，请刷新重试。</p>';
  }
}

function bindChipList(container, selector, apply, key) {
  if (!container) return;
  container.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('.chip-toggle');
    if (toggleBtn) {
      if (key === 'category') categoryExpanded = !categoryExpanded;
      else brandExpanded = !brandExpanded;
      renderTabs(categoryList);
      renderBrandTabs(brandList);
      return;
    }
    const btn = e.target.closest(selector);
    if (!btn) return;
    apply(btn);
  });
}

bindChipList(tabs, '.chip[data-category]', (btn) => {
  activeCategory = btn.dataset.category;
  tabs.querySelectorAll('.chip[data-category]').forEach((b) => {
    const active = b === btn;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  reload();
}, 'category');

bindChipList(brandTabs, '.chip[data-brand]', (btn) => {
  activeBrand = btn.dataset.brand;
  brandTabs.querySelectorAll('.chip[data-brand]').forEach((b) => {
    const active = b === btn;
    b.classList.toggle('active', active);
    b.setAttribute('aria-pressed', String(active));
  });
  reload();
}, 'brand');

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reload, 300);
});

/* 窗口尺寸变化时重新计算单行折叠（防抖） */
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderTabs(categoryList);
    renderBrandTabs(brandList);
    updatePagination();
    updateLoadMore();
  }, 200);
});

load();

/* 商品分页：加载更多 */
const loadMoreBtn = document.getElementById('load-more');
if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMore);

/* 页码分页器事件委托（PC 宽屏） */
const pager = document.getElementById('pagination');
if (pager) {
  pager.addEventListener('click', (e) => {
    const btn = e.target.closest('button.pager-btn');
    if (!btn || btn.disabled) return;
    const key = btn.dataset.page;
    if (key === 'prev') goToPage(currentPage - 1);
    else if (key === 'next') goToPage(currentPage + 1);
    else goToPage(Number(key));
  });
}

/* 移动端触底自动加载：滚动接近列表底部自动追加下一页（PC 端由分页器接管，不触发） */
const loadSentinel = document.getElementById('load-sentinel');
if (loadSentinel && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    if (!entries.some((en) => en.isIntersecting)) return;
    if (!isMobile()) return;
    if (loading || products.length >= total) return;
    loadMore();
  }, { rootMargin: '220px 0px' });
  io.observe(loadSentinel);
}

/* 顶部导航「联系方式」入口：弹出报价二维码 + 商城二维码面板 */
(function () {
  const openBtn = document.getElementById('contact-open');
  const mask = document.getElementById('contact-mask');
  const expressBtn = document.getElementById('express-open');
  const expressMask = document.getElementById('express-mask');
  function closeExpress() {
    if (!expressMask || expressMask.hidden) return;
    expressMask.hidden = true;
    if (expressBtn) expressBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  function openPanel() {
    closeExpress();
    mask.hidden = false;
    openBtn.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
    syncPanelQr();
  }
  function closePanel() {
    mask.hidden = true;
    openBtn.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
  }
  /* 兜底：若商城二维码尚未由 applyQr 生成，从 .b2b 容器复制一份 */
  function syncPanelQr() {
    const target = document.getElementById('contact-site-qr');
    const source = document.getElementById('site-qr');
    if (!target || !source) return;
    if (target.querySelector('canvas,img') || !source.querySelector('canvas,img')) return;
    const node = source.querySelector('canvas,img');
    target.innerHTML = '';
    target.appendChild(node.cloneNode(true));
    target.hidden = false;
  }
  openBtn.addEventListener('click', openPanel);
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.contact-close')) closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !mask.hidden) closePanel();
  });

  /* 顶部导航「特惠快递」入口：弹出寄件省钱海报 */
  (function () {
    if (!expressBtn || !expressMask) return;
    function openExpress() {
      closePanel();
      expressMask.hidden = false;
      expressBtn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
    }
    expressBtn.addEventListener('click', openExpress);
    expressMask.addEventListener('click', (e) => {
      if (e.target === expressMask || e.target.closest('.contact-close')) closeExpress();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !expressMask.hidden) closeExpress();
    });
  })();
})();

/* 页脚隐蔽管理入口：输入 admin 口令后显示供应链管理链接 */
(function () {
  const gateInput = document.getElementById('admin-gate-input');
  const gateLink = document.getElementById('admin-gate-link');
  if (!gateInput || !gateLink) return;
  gateInput.addEventListener('input', () => {
    if (gateInput.value.trim().toLowerCase() === 'admin') {
      gateLink.hidden = false;
      gateInput.style.display = 'none';
    }
  });
})();

/* ================= 商品分享海报 ================= */

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function textLines(ctx, text, maxWidth) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      out.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) out.push(line);
  return out;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT_BODY = '"PingFang SC","Microsoft YaHei",sans-serif';

async function buildSharePoster(p) {
  const W = 750;
  const padX = 28;
  const contentW = W - padX * 2;
  const headerH = 96;
  const imgH = 440;
  const footerH = 176;

  const [productImg, qrImg] = await Promise.all([
    p.image ? loadImage(p.image) : Promise.resolve(null),
    loadImage('/wechat-qr.jpg'),
  ]);

  // 预测量文本行数
  const mCtx = document.createElement('canvas').getContext('2d');
  mCtx.font = `600 28px ${FONT_BODY}`;
  const nameLines = textLines(mCtx, p.name, contentW).slice(0, 2);
  mCtx.font = `16px ${FONT_BODY}`;
  const hiLines = textLines(mCtx, p.highlights || '', contentW).slice(0, 3);
  const gridItems = [
    ['起订', p.moq], ['保质期', p.shelf_life], ['储存', p.storage],
    ['认证', p.cert], ['分类', p.category],
  ].filter(([, v]) => v);

  const nameH = nameLines.length * 38;
  const hiH = hiLines.length * 26;
  const gridH = Math.ceil(gridItems.length / 2) * 52;
  const H = headerH + 26 + imgH + 24 + nameH + 42 + hiH + 110 + gridH + 16 + footerH + 12;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  let y = 0;

  // 顶部品牌条
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#047857');
  grad.addColorStop(1, '#10b981');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, headerH);
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 22px ${FONT_BODY}`;
  ctx.fillText(p.brand || 'Lightning Shop', padX, 40);
  ctx.font = `13px ${FONT_BODY}`;
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText('Lightning Shop · 绿色助农 · 源头直供', padX, 68);
  if (p.badge) {
    const badgeText = String(p.badge).split(/[,，|]/)[0] || String(p.badge);
    ctx.font = `700 14px ${FONT_BODY}`;
    const bw = ctx.measureText(badgeText).width + 28;
    ctx.fillStyle = '#ffffff';
    roundRectPath(ctx, W - padX - bw, 30, bw, 36, 999);
    ctx.fill();
    ctx.fillStyle = '#047857';
    ctx.fillText(badgeText, W - padX - bw + 14, 48);
  }
  y += headerH;

  // 商品图（圆角裁切）
  y += 26;
  roundRectPath(ctx, padX, y, contentW, imgH, 24);
  ctx.save();
  ctx.clip();
  if (productImg) {
    const ir = productImg.width / productImg.height;
    const dr = contentW / imgH;
    let sx = 0, sy = 0, sw, sh;
    if (ir > dr) { sh = productImg.height; sw = sh * dr; sx = (productImg.width - sw) / 2; }
    else { sw = productImg.width; sh = sw / dr; sy = (productImg.height - sh) / 2; }
    ctx.drawImage(productImg, sx, sy, sw, sh, padX, y, contentW, imgH);
  } else {
    ctx.fillStyle = '#eef2ef';
    ctx.fillRect(padX, y, contentW, imgH);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '64px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🍱', W / 2, y + imgH / 2 + 22);
    ctx.textAlign = 'left';
  }
  ctx.restore();
  y += imgH;

  // 品名
  y += 24;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#1f2937';
  ctx.font = `600 28px ${FONT_BODY}`;
  nameLines.forEach((ln, i) => ctx.fillText(ln, padX, y + i * 38 + 30));
  y += nameLines.length * 38 + 10;

  // 规格
  ctx.fillStyle = '#6b7280';
  ctx.font = `15px ${FONT_BODY}`;
  ctx.fillText([p.spec, p.brand].filter(Boolean).join(' · ') || p.category, padX, y + 18);
  y += 34;

  // 卖点
  if (hiLines.length) {
    ctx.fillStyle = '#4b5563';
    ctx.font = `16px ${FONT_BODY}`;
    hiLines.forEach((ln, i) => ctx.fillText(ln, padX, y + i * 26 + 20));
    y += hiLines.length * 26;
  }

  // 价格区
  y += 20;
  ctx.fillStyle = '#f3f4f6';
  roundRectPath(ctx, padX, y, contentW, 72, 16);
  ctx.fill();
  const wLabel = p.price_note ? `批发价 · ${p.price_note}` : '批发价';
  ctx.fillStyle = '#059669';
  ctx.font = `13px ${FONT_BODY}`;
  ctx.fillText(wLabel, padX + 18, y + 24);
  ctx.font = `700 30px ${FONT_BODY}`;
  ctx.fillText(displayPrice(p.price) || '—', padX + 18, y + 58);
  const retail = p.retail_price && !p.retail_price.includes('报价') ? p.retail_price : '议价';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#d97706';
  ctx.font = `13px ${FONT_BODY}`;
  ctx.fillText('零售', W - padX - 18, y + 24);
  ctx.font = `700 24px ${FONT_BODY}`;
  ctx.fillText(displayPrice(retail), W - padX - 18, y + 58);
  ctx.textAlign = 'left';
  y += 72 + 18;

  // 信息网格
  if (gridItems.length) {
    gridItems.forEach((item, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const gx = padX + col * (contentW / 2);
      const gy = y + row * 52;
      ctx.fillStyle = '#6b7280';
      ctx.font = `12px ${FONT_BODY}`;
      ctx.fillText(item[0], gx, gy + 16);
      ctx.fillStyle = '#1f2937';
      ctx.font = `600 15px ${FONT_BODY}`;
      ctx.fillText(String(item[1]).slice(0, 16), gx, gy + 38);
    });
    y += Math.ceil(gridItems.length / 2) * 52;
  }

  // 底部：微信二维码
  y += 16;
  ctx.fillStyle = '#ecfdf5';
  ctx.fillRect(0, y, W, footerH);
  const qrSize = 136;
  if (qrImg) {
    ctx.drawImage(qrImg, padX, y + (footerH - qrSize) / 2, qrSize, qrSize);
  }
  ctx.fillStyle = '#047857';
  ctx.font = `700 20px ${FONT_BODY}`;
  ctx.fillText('扫码加微信 · 源头厂家直供', padX + qrSize + 24, y + 60);
  ctx.fillStyle = '#4b5563';
  ctx.font = `14px ${FONT_BODY}`;
  ctx.fillText('Lightning Shop · 私域货盘展示', padX + qrSize + 24, y + 94);
  ctx.fillText('绿色 · 助农 · 公益', padX + qrSize + 24, y + 120);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('canvas toBlob failed'));
      resolve(URL.createObjectURL(blob));
    }, 'image/png');
  });
}

async function openShareModal(p) {
  const inWechat = /MicroMessenger/i.test(navigator.userAgent);
  let modal = document.getElementById('share-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'share-modal';
    modal.className = 'share-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="share-sheet" role="dialog" aria-modal="true" aria-label="商品分享图">
        <div class="share-head">
          <b>商品分享图</b>
          <button class="share-close" type="button" aria-label="关闭">✕</button>
        </div>
        <img class="share-img" alt="商品分享图">
        <p class="share-tip">${inWechat ? '长按图片保存，或点击右上角「···」转发给好友' : '长按图片保存，或点击下方按钮分享给微信好友'}</p>
        <div class="share-actions">
          <button class="btn-wx" type="button">${inWechat ? '去右上角转发' : '分享到微信'}</button>
          <a class="btn-save" download>保存图片</a>
        </div>
      </div>`;
    modal.addEventListener('click', (e) => {
      if (e.target === modal || e.target.closest('.share-close')) {
        modal.hidden = true;
        document.body.style.overflow = '';
        const img = modal.querySelector('.share-img');
        if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      }
    });
    document.body.appendChild(modal);
  }
  const url = await buildSharePoster(p);
  const img = modal.querySelector('.share-img');
  if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
  img.src = url;
  img.dataset.url = url;
  modal.querySelector('.btn-save').href = url;
  modal.querySelector('.btn-save').download = `${p.name}-分享.png`;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';

  const wxBtn = modal.querySelector('.btn-wx');
  wxBtn.onclick = async () => {
    if (inWechat) {
      // 微信内置浏览器不支持 Web Share API，只能引导右上角菜单转发
      wxBtn.textContent = '请点击右上角「···」→ 转发给朋友';
      wxBtn.disabled = true;
      return;
    }
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `${p.name}-分享.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: p.name });
      } else {
        wxBtn.textContent = '当前环境不支持直接分享，请长按图片保存';
        wxBtn.disabled = true;
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      wxBtn.textContent = '分享失败，请长按图片保存';
    }
  };
}

/* ================= 大图预览 ================= */
let lightboxEl = null;
function openLightbox(src, alt) {
  if (!lightboxEl) {
    lightboxEl = document.createElement('div');
    lightboxEl.className = 'lightbox';
    lightboxEl.innerHTML =
      '<button class="lightbox-close" type="button" aria-label="关闭">×</button>' +
      '<img class="lightbox-img" alt="" />' +
      '<p class="lightbox-name"></p>';
    lightboxEl.addEventListener('click', (e) => {
      if (e.target === lightboxEl || e.target.closest('.lightbox-close')) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLightbox();
    });
    document.body.appendChild(lightboxEl);
  }
  const img = lightboxEl.querySelector('.lightbox-img');
  img.src = src;
  img.alt = alt || '';
  lightboxEl.querySelector('.lightbox-name').textContent = alt || '';
  lightboxEl.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.classList.remove('open');
  document.body.style.overflow = '';
  lightboxEl.querySelector('.lightbox-img').src = '';
}

grid.addEventListener('click', async (e) => {
  // 点击「更多/收起」-> 展开/折叠描述
  const hlBtn = e.target.closest('.hl-toggle');
  if (hlBtn) {
    toggleHighlight(hlBtn);
    return;
  }
  // 点击产品图片 -> 预览大图
  const cardImg = e.target.closest('.card-media img');
  if (cardImg) {
    const p = products.find((it) => it.image === cardImg.getAttribute('src'));
    openLightbox(cardImg.getAttribute('src'), p ? p.name : '');
    return;
  }
  const btn = e.target.closest('.share-btn');
  if (!btn || btn.disabled) return;
  const p = products.find((it) => it.id === btn.dataset.pid);
  if (!p) return;
  btn.disabled = true;
  try {
    await openShareModal(p);
  } catch (err) {
    console.error('share failed', err);
  } finally {
    btn.disabled = false;
  }
});

/* ================================================================
 * 购物车（localStorage）
 * ================================================================ */
const CART_KEY = 'ls_cart';
function getCart() {
  try { const c = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(c) ? c : []; }
  catch (e) { return []; }
}
function setCart(c) {
  localStorage.setItem(CART_KEY, JSON.stringify(c));
  updateCartBadge();
}
function updateCartBadge() {
  const c = getCart();
  const n = c.reduce((s, it) => s + (parseInt(it.qty, 10) || 0), 0);
  const b = document.getElementById('cart-badge');
  const fab = document.getElementById('fab-badge');
  const fabBtn = document.getElementById('cart-fab');
  const txt = n > 99 ? '99+' : String(n);
  if (b) { b.hidden = !n; b.textContent = txt; }
  if (fab) { fab.hidden = !n; fab.textContent = txt; }
  if (fabBtn) fabBtn.hidden = !n;
}
function cartQty(id) {
  const it = getCart().find((x) => x.id === id);
  return it ? (parseInt(it.qty, 10) || 0) : 0;
}
function addToCart(p, qty) {
  const cart = getCart();
  const n = Math.max(1, parseInt(qty, 10) || 1);
  const idx = cart.findIndex((it) => it.id === p.id);
  if (idx >= 0) cart[idx].qty = (parseInt(cart[idx].qty, 10) || 0) + n;
  else cart.push({ id: p.id, name: p.name, spec: p.spec, price: p.price, base_price: p.price, retail: p.retail_price, moq: p.moq, brand: p.brand, image: p.image, qty: n });
  setCart(cart);
  toastTip('已加入购物车');
}
function cartEstimate(cart) {
  let total = 0, ok = true;
  for (const it of cart) {
    // 合计按下单价（含加价）估算，与 /api/orders 服务端结算口径保持一致
    const m = String(displayPrice(it.price || '') || '').match(/\d+(?:\.\d+)?/);
    if (!m) { ok = false; break; }
    total += parseFloat(m[0]) * (parseInt(it.qty, 10) || 1);
  }
  return ok ? Math.round(total * 100) / 100 : null;
}
/* 轻量提示（无 toast 组件，用临时浮层） */
let tipEl = null;
function toastTip(msg, isErr) {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip-toast';
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = msg;
  tipEl.classList.toggle('err', !!isErr);
  tipEl.classList.add('show');
  clearTimeout(tipEl._t);
  tipEl._t = setTimeout(() => tipEl.classList.remove('show'), 2200);
}

/* ================================================================
 * Hash 路由：#/p/:id 详情 | #/cart 购物车 | #/orders 查单 | #/b/:key 品牌
 * ================================================================ */
const views = {
  products: document.getElementById('products'),
  detail: document.getElementById('view-detail'),
  cart: document.getElementById('view-cart'),
  orders: document.getElementById('view-orders'),
  brand: document.getElementById('view-brand'),
};
function showView(name) {
  for (const [k, el] of Object.entries(views)) {
    if (!el) continue;
    if (k === 'products') el.hidden = name !== 'products';
    else el.hidden = name !== k;
  }
  window.scrollTo(0, 0);
}
function parseHash() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  const seg = h.split('/')[0];
  const param = h.split('/')[1] || '';
  if (seg === 'p' && param) { showView('detail'); loadDetail(decodeURIComponent(param)); return; }
  if (seg === 'cart') { showView('cart'); renderCart(); return; }
  if (seg === 'orders') { showView('orders'); renderOrders(); return; }
  if (seg === 'b' && param) { showView('brand'); loadBrand(decodeURIComponent(param)); return; }
  showView('products');
}
window.addEventListener('hashchange', parseHash);

/* ================================================================
 * 商品详情页
 * ================================================================ */
let currentDetail = null;
function detailRow(label, val) {
  if (val === undefined || val === null || String(val).trim() === '') return '';
  return `<div class="param-row"><span class="param-label">${escapeHtml(label)}</span><span class="param-value">${escapeHtml(val)}</span></div>`;
}
function detailHtml(p) {
  const badge = p.badge
    ? `<span class="card-badges">${String(p.badge).split(/[,，|]/).map((s) => s.trim()).filter(Boolean)
        .map((b) => `<span class="card-badge${b.includes('低GI') ? ' gi' : ''}">${escapeHtml(b)}</span>`).join('')}</span>` : '';
  const retailText = p.retail_price && !p.retail_price.includes('报价') ? p.retail_price : '议价';
  const brandCard = p.brand
    ? `<div class="detail-brand">
        <div class="brand-card">
          <div class="brand-card-info">
            <b class="brand-card-name">${escapeHtml(p.brand)}</b>
            <span class="brand-card-sub">产地品牌 · 点击查看品牌主页与资质</span>
          </div>
          <a class="btn btn-outline btn-sm" href="#/b/${encodeURIComponent(p.brand)}">品牌主页</a>
        </div>
      </div>` : '';
  return `
    <div class="detail-top">
      <a class="detail-back" href="#/">← 返回商品列表</a>
    </div>
    <div class="detail-wrap">
      <div class="detail-media">
        ${p.image ? `<img src="${escapeHtml(safeImgUrl(p.image))}" alt="${escapeHtml(p.name)}" onclick="openLightbox('${safeImgUrl(p.image)}', '${escapeHtml(p.name).replace(/'/g, "\\'")}')" />` : '<div class="card-placeholder">🍱</div>'}
        ${badge}
      </div>
      <div class="detail-info">
        <h1 class="detail-name">${escapeHtml(p.name)}</h1>
        <p class="detail-spec">${escapeHtml(p.spec || '')}${p.brand ? ' · ' + escapeHtml(p.brand) : ''}</p>
        <div class="detail-price">
          <div class="price-wholesale"><span>批发价</span><b>${escapeHtml(displayPrice(p.price))}</b></div>
          <div class="price-retail"><span>零售</span><b>${escapeHtml(displayPrice(retailText))}</b></div>
        </div>
        ${p.highlights ? `<p class="detail-highlight">${escapeHtml(p.highlights)}</p>` : ''}
        <div class="detail-meta">
          ${p.cert ? `<span class="card-tag">${escapeHtml(p.cert)}</span>` : ''}
          ${p.moq ? `<span class="card-tag amber">起订 ${escapeHtml(p.moq)}</span>` : ''}
        </div>
        <div class="detail-buy">
          <div class="qty-picker">
            <button type="button" class="qty-btn" data-action="qty-minus" aria-label="减少数量">−</button>
            <span class="qty-num" id="detail-qty">1</span>
            <button type="button" class="qty-btn" data-action="qty-plus" aria-label="增加数量">+</button>
          </div>
          <button type="button" class="btn btn-primary" data-action="add-cart">加入购物车</button>
          <button type="button" class="btn btn-outline" data-action="buy-now">立即下单</button>
        </div>
      </div>
    </div>
    ${brandCard}
    <div class="detail-params panel-params">
      <h2>产品参数</h2>
      ${detailRow('品牌', p.brand)}
      ${detailRow('分类', p.category)}
      ${detailRow('规格', p.spec)}
      ${detailRow('批发价', displayPrice(p.price))}
      ${detailRow('零售价', displayPrice(retailText))}
      ${detailRow('起订量', p.moq)}
      ${detailRow('储存方式', p.storage)}
      ${detailRow('保质期', p.shelf_life)}
      ${detailRow('认证/证书', p.cert)}
      ${detailRow('价格说明', p.price_note)}
    </div>
    <div class="detail-tip">
      <b>下单说明</b>
      <p>1. 加入购物车后提交订单，凭订单号微信转账；2. 后台确认收款后安排发货；3. 可随时凭手机号+订单号查询进度。</p>
    </div>`;
}
async function loadDetail(id) {
  const el = views.detail;
  el.innerHTML = '<div class="view-loading">加载中…</div>';
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(id)}`);
    if (!res.ok) { el.innerHTML = '<div class="view-empty">商品不存在或已下架</div>'; return; }
    const p = await res.json();
    currentDetail = p;
    el.innerHTML = detailHtml(p);
    document.getElementById('detail-qty').textContent = String(Math.max(1, cartQty(p.id) || 1));
  } catch (err) {
    el.innerHTML = '<div class="view-empty">加载失败，请稍后重试</div>';
  }
}

/* ================================================================
 * 购物车视图
 * ================================================================ */
function renderCart() {
  const el = views.cart;
  const cart = getCart();
  if (!cart.length) {
    el.innerHTML = `<div class="view-head"><h1>购物车</h1></div>
      <div class="view-empty">购物车还是空的，去挑选心仪的商品吧</div>
      <div class="cart-actions"><a class="btn btn-primary" href="#/">去逛逛</a></div>`;
    return;
  }
  const estimate = cartEstimate(cart);
  el.innerHTML = `
    <div class="view-head"><h1>购物车 <span class="muted small">${cart.reduce((s, it) => s + it.qty, 0)} 件</span></h1></div>
    <div class="cart-list">
      ${cart.map((it) => `
        <div class="cart-item" data-id="${escapeHtml(it.id)}">
          ${it.image ? `<img class="cart-item-img" src="${escapeHtml(safeImgUrl(it.image))}" alt="" loading="lazy" />` : '<div class="cart-item-img placeholder">🍱</div>'}
          <div class="cart-item-info">
            <b class="cart-item-name">${escapeHtml(it.name)}</b>
            <span class="cart-item-spec">${escapeHtml(it.spec || '')}${it.brand ? ' · ' + escapeHtml(it.brand) : ''}</span>
            <span class="cart-item-price">批发 ${escapeHtml(displayPrice(it.price) || '议价')}</span>
          </div>
          <div class="cart-item-side">
            <div class="qty-picker small">
              <button type="button" class="qty-btn" data-action="cart-minus" data-id="${escapeHtml(it.id)}">−</button>
              <span class="qty-num">${it.qty}</span>
              <button type="button" class="qty-btn" data-action="cart-plus" data-id="${escapeHtml(it.id)}">+</button>
            </div>
            <button type="button" class="cart-remove" data-action="cart-remove" data-id="${escapeHtml(it.id)}">删除</button>
          </div>
        </div>`).join('')}
    </div>
    <div class="cart-summary">
      <div class="cart-total">合计（下单金额）<b>${estimate !== null ? '¥' + estimate : '人工核算'}</b><span class="cart-total-tip">按当前价目计算，多档批发价可在备注中说明</span></div>
    </div>
    <div class="checkout-form panel-params">
      <h2>提交订单</h2>
      <p class="query-notice">下单不收款：提交后请按订单金额微信转账，后台确认后发货。下单成功后订单号会自动保存在本机，凭手机号 + 订单号可随时查单。</p>
      <label class="form-field"><span>公司/个人名称 *</span><input type="text" id="co-name" maxlength="40" placeholder="如：上海 XX 贸易有限公司 / 王小明" autocomplete="off" /></label>
      <label class="form-field"><span>手机号 *</span><input type="tel" id="co-phone" maxlength="11" placeholder="11 位手机号，用于查单" autocomplete="off" /></label>
      <h3 class="form-subhead">收货地址</h3>
      <div class="order-query-row">
        <label class="form-field"><span>收货人 *</span><input type="text" id="co-receiver" maxlength="40" placeholder="默认同公司/个人名称" autocomplete="off" /></label>
        <label class="form-field"><span>收货手机号 *</span><input type="tel" id="co-receiver-phone" maxlength="11" placeholder="默认同下单手机号" autocomplete="off" /></label>
      </div>
      <div class="order-query-row">
        <label class="form-field"><span>省份 *</span><input type="text" id="co-province" maxlength="30" placeholder="如：江苏省" autocomplete="off" /></label>
        <label class="form-field"><span>城市 *</span><input type="text" id="co-city" maxlength="30" placeholder="如：苏州市" autocomplete="off" /></label>
      </div>
      <div class="order-query-row">
        <label class="form-field"><span>区/县</span><input type="text" id="co-district" maxlength="30" placeholder="如：姑苏区" autocomplete="off" /></label>
        <label class="form-field"><span>邮编</span><input type="text" id="co-postal" maxlength="6" placeholder="选填，6 位数字" autocomplete="off" /></label>
      </div>
      <label class="form-field"><span>详细地址 *</span><textarea id="co-address" rows="2" maxlength="200" placeholder="街道、门牌号、楼栋、仓库收货要求等"></textarea></label>
      <label class="form-field"><span>备注</span><textarea id="co-remark" rows="2" maxlength="200" placeholder="物流要求、开票信息等（选填）"></textarea></label>
      <div class="checkout-actions">
        <button type="button" class="btn btn-primary" id="co-submit" data-action="submit-order">提交订单</button>
      </div>
    </div>`;
}
async function submitOrder() {
  const name = document.getElementById('co-name').value.trim();
  const phone = document.getElementById('co-phone').value.trim();
  const remark = document.getElementById('co-remark').value.trim();
  // 收货人/收货电话留空时默认与公司名、下单手机号一致（多数批发客户两者相同）
  const receiverName = (document.getElementById('co-receiver').value.trim() || name);
  const receiverPhone = (document.getElementById('co-receiver-phone').value.trim() || phone);
  const province = document.getElementById('co-province').value.trim();
  const city = document.getElementById('co-city').value.trim();
  const district = document.getElementById('co-district').value.trim();
  const address = document.getElementById('co-address').value.trim();
  const postalCode = document.getElementById('co-postal').value.trim();
  if (!name) return toastTip('请填写公司/个人名称', true);
  if (!/^1\d{10}$/.test(phone)) return toastTip('请填写正确的手机号', true);
  if (!province) return toastTip('请填写收货省份', true);
  if (!city) return toastTip('请填写收货城市', true);
  if (!receiverName) return toastTip('请填写收货人', true);
  if (!/^1\d{10}$/.test(receiverPhone)) return toastTip('请填写正确的收货手机号', true);
  if (address.length < 5) return toastTip('请填写详细收货地址（不少于 5 个字）', true);
  if (postalCode && !/^\d{6}$/.test(postalCode)) return toastTip('邮编格式不正确', true);
  const cart = getCart();
  if (!cart.length) return toastTip('购物车为空', true);
  const btn = document.getElementById('co-submit');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_name: name,
        customer_phone: phone,
        remark,
        receiver_name: receiverName,
        receiver_phone: receiverPhone,
        province,
        city,
        district,
        address,
        postal_code: postalCode,
        items: cart,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      toastTip((data && data.message) || '下单失败', true);
      btn.disabled = false;
      btn.textContent = '提交订单';
      return;
    }
    setCart([]);
    localStorage.setItem('ls_query_phone', phone);
    rememberMyOrder(data.order, phone);
    pendingOrderSuccess = data.order;
    toastTip(`下单成功：${data.order.id}`);
    setTimeout(() => { location.hash = '#/orders'; }, 600);
  } catch (err) {
    toastTip('网络异常，请重试', true);
    btn.disabled = false;
    btn.textContent = '提交订单';
  }
}

/* ================================================================
 * 查单视图
 * ================================================================ */
const ORDER_STATUS_LABEL = { pending: '待确认支付', paid: '已支付待发货', shipped: '已发货', done: '已完成', cancelled: '已取消' };
const ORDER_STATUS_CLS = { pending: 'st-pending', paid: 'st-paid', shipped: 'st-shipped', done: 'st-done', cancelled: 'st-cancelled' };
function statusBadge(s) {
  return `<span class="order-status ${ORDER_STATUS_CLS[s] || 'st-cancelled'}">${ORDER_STATUS_LABEL[s] || escapeHtml(s || '未知')}</span>`;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function orderItemHtml(it) {
  return `<div class="order-line">
    ${it.image ? `<img src="${escapeHtml(safeImgUrl(it.image))}" alt="" loading="lazy" />` : '<span class="order-line-ph">🍱</span>'}
    <div class="order-line-info"><b>${escapeHtml(it.name)}</b><span>${escapeHtml(it.spec || '')} × ${it.qty}</span></div>
    <span class="order-line-price">${escapeHtml(it.price || '议价')}</span>
  </div>`;
}
function orderCardHtml(o) {
  const totalQty = o.items.reduce((s, it) => s + (it.qty || 1), 0);
  return `<div class="order-card" data-id="${escapeHtml(o.id)}">
    <div class="order-card-head">
      <div class="order-card-left">
        <b class="order-no">${escapeHtml(o.id)}</b>
        <span class="order-time">${fmtTime(o.created_at)}</span>
      </div>
      ${statusBadge(o.status)}
    </div>
    <div class="order-card-summary">${escapeHtml(o.customer_name)} · ${escapeHtml(o.customer_phone)} · ${totalQty} 件商品</div>
    <div class="order-card-body" hidden>
      <div class="order-lines">${(o.items || []).map(orderItemHtml).join('')}</div>
      ${(o.province || o.address)
    ? `<p class="order-addr">收货：${escapeHtml([o.receiver_name, o.receiver_phone, o.province, o.city, o.district, o.address, o.postal_code].filter(Boolean).join(' '))}</p>`
    : ''}
      ${o.remark ? `<p class="order-remark">备注：${escapeHtml(o.remark)}</p>` : ''}
      ${o.tracking_no ? `<p class="order-tracking">物流单号：${escapeHtml(o.tracking_no)}</p>` : ''}
      ${o.status_note ? `<p class="order-note">${escapeHtml(o.status_note)}</p>` : ''}
      ${o.status === 'pending' ? `<p class="order-tip">请微信转账后等待确认，或联系客服咨询</p>` : ''}
    </div>
    <div class="order-card-foot">
      <button type="button" class="btn btn-outline btn-sm" data-action="order-toggle">查看明细</button>
    </div>
  </div>`;
}
let queryModeCache = null;
let queryTurnstileToken = '';
let pendingOrderSuccess = null;
const MY_ORDERS_KEY = 'ls_my_orders';
const MY_ORDERS_MAX = 10;
function loadMyOrders() {
  try {
    const list = JSON.parse(localStorage.getItem(MY_ORDERS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x) => x && x.id) : [];
  } catch (e) {
    return [];
  }
}
/* 下单成功即在本机留档订单号：用户忘记订单号时可直接点选回填 */
function rememberMyOrder(order, phoneOverride) {
  if (!order || !order.id) return;
  const list = loadMyOrders().filter((x) => x.id !== order.id);
  list.unshift({ id: order.id, phone: phoneOverride || order.customer_phone || '', ts: order.created_at || new Date().toISOString() });
  try {
    localStorage.setItem(MY_ORDERS_KEY, JSON.stringify(list.slice(0, MY_ORDERS_MAX)));
  } catch (e) { /* 隐私模式/配额满时忽略，不影响下单 */ }
}
async function fetchQueryMode(force) {
  if (queryModeCache && !force) return queryModeCache;
  try {
    const res = await fetch('/api/orders/query/mode');
    if (res.ok) queryModeCache = await res.json();
  } catch (e) { /* 接口不可用时回落订单号双因子 */ }
  if (!queryModeCache) queryModeCache = { mode: 'scope', sms: false, ttl: 300, turnstile_site_key: '' };
  return queryModeCache;
}
function mountQueryTurnstile(siteKey) {
  const slot = document.getElementById('q-turnstile');
  if (!slot) return;
  queryTurnstileToken = '';
  const render = () => {
    if (!window.turnstile) return;
    window.turnstile.render(slot, {
      sitekey: siteKey,
      callback: (token) => { queryTurnstileToken = token; },
      'expired-callback': () => { queryTurnstileToken = ''; },
      'error-callback': () => { queryTurnstileToken = ''; },
    });
  };
  if (window.turnstile) return render();
  if (document.getElementById('cf-turnstile-script')) return;
  const s = document.createElement('script');
  s.id = 'cf-turnstile-script';
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.defer = true;
  s.onload = render;
  document.head.appendChild(s);
}
function startCodeCountdown(btn, ttl) {
  if (!btn) return;
  let left = Math.min(60, ttl || 60);
  btn.disabled = true;
  btn.textContent = `${left}s 后重发`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = '获取验证码';
      return;
    }
    btn.textContent = `${left}s 后重发`;
  }, 1000);
}
async function sendQueryCode() {
  const phone = document.getElementById('q-phone').value.trim();
  if (!/^1\d{10}$/.test(phone)) return setQueryError('请填写正确的手机号');
  const btn = document.getElementById('q-send');
  if (btn && btn.disabled) return;
  try {
    const res = await fetch('/api/orders/query/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) return setQueryError((data && data.message) || '验证码发送失败');
    toastTip('验证码已发送，5 分钟内有效');
    startCodeCountdown(btn, data.ttl);
  } catch (err) {
    toastTip('网络异常，请重试', true);
  }
}
function fallbackCopyText(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { toastTip('复制失败，请手动长按选择订单号', true); }
  document.body.removeChild(ta);
}
function copyOrderId(id) {
  if (!id) return;
  const done = () => toastTip('订单号已复制：' + id);
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(id).then(done).catch(() => fallbackCopyText(id, done));
  } else {
    fallbackCopyText(id, done);
  }
}
/* 查单页的报错一律显示在表单顶部（底部提示用户容易漏看） */
function setQueryError(msg) {
  const box = document.getElementById('q-error');
  if (!box) return toastTip(msg, true);
  box.textContent = msg;
  box.hidden = false;
  if (box.scrollIntoView) box.scrollIntoView({ block: 'nearest' });
}
function clearQueryError() {
  const box = document.getElementById('q-error');
  if (box) { box.hidden = true; box.textContent = ''; }
}
async function renderOrders() {
  const el = views.orders;
  const savedPhone = localStorage.getItem('ls_query_phone') || '';
  el.innerHTML = '<div class="view-loading">加载中…</div>';
  const mode = await fetchQueryMode();
  const justOrder = pendingOrderSuccess;
  pendingOrderSuccess = null;
  const myOrders = loadMyOrders().filter((o) => !savedPhone || o.phone === savedPhone).slice(0, 5);
  const recentHtml = !mode.sms && myOrders.length
    ? `<div class="recent-chips">
        <p class="recent-chips-title">本机最近下单（点击填入上方订单号）</p>
        ${myOrders.map((o) => `<button type="button" class="recent-chip" data-action="fill-order" data-order-id="${escapeHtml(o.id)}">${escapeHtml(o.id)}</button>`).join('')}
      </div>`
    : '';
  el.innerHTML = `
    <div class="view-head"><h1>查单</h1></div>
    ${justOrder ? `<div class="order-success">
      <h2>下单成功，订单号已保存在本机</h2>
      <p>订单号：<span class="order-success-no">${escapeHtml(justOrder.id)}</span></p>
      <button type="button" class="btn btn-outline btn-sm" data-action="copy-order" data-order-id="${escapeHtml(justOrder.id)}">复制订单号</button>
      <p class="checkout-tip">凭手机号 + 订单号可随时查单；建议顺手截图，清缓存或换设备后本机记录会丢失。</p>
    </div>` : ''}
    <div class="order-query panel-params">
      <p class="query-notice">${mode.sms
    ? '查单需短信验证码，5 分钟内有效，最多尝试 3 次；只需手机号，无需订单号。'
    : '查单需同时提供手机号和订单号（订单号含随机段，无法被猜测，用于保护订单隐私）。下单成功后订单号会自动保存在本机，忘记时可点选下方记录填入。'}</p>
      <p class="query-notice is-err" id="q-error" hidden></p>
      <div class="order-query-row">
        <label class="form-field"><span>手机号 *</span><input type="tel" id="q-phone" maxlength="11" placeholder="下单时填写的手机号" autocomplete="off" value="${escapeHtml(savedPhone)}" /></label>
        ${mode.sms
    ? '<label class="form-field"><span>短信验证码 *</span><input type="text" id="q-code" maxlength="6" inputmode="numeric" placeholder="6 位数字" autocomplete="one-time-code" /></label>'
    : '<label class="form-field"><span>订单号 *</span><input type="text" id="q-order" maxlength="20" placeholder="下单成功页显示的订单号" autocomplete="off" /></label>'}
      </div>
      ${recentHtml}
      ${mode.sms ? '<div class="checkout-actions"><button type="button" class="btn btn-outline btn-sm" id="q-send" data-action="send-query-code">获取验证码</button></div>' : ''}
      ${mode.turnstile_site_key ? '<div id="q-turnstile" class="turnstile-slot"></div>' : ''}
      <div class="checkout-actions"><button type="button" class="btn btn-primary" data-action="query-orders">查询</button></div>
      ${mode.sms ? '' : `<div class="query-forgot">
        <button type="button" class="query-forgot-btn" data-action="forgot-order-toggle">忘记订单号？</button>
        <div class="query-forgot-body" id="q-forgot" hidden>
          <ol>
            <li>本机记录：下单成功后订单号会自动保存在本机，点上方「本机最近下单」即可填入；</li>
            <li>客服找回：联系客服并提供下单手机号、大致金额与收货人，客服按手机号核对订单后告知订单号；</li>
            <li>清缓存、换设备或隐私模式下本机记录会丢失，下单成功时请顺手截图保存。</li>
          </ol>
          <button type="button" class="btn btn-outline btn-sm" data-action="open-contact">联系客服找回订单号</button>
        </div>
      </div>`}
    </div>
    <div id="order-results"></div>`;
  if (savedPhone) document.getElementById('q-phone').select();
  if (mode.turnstile_site_key) mountQueryTurnstile(mode.turnstile_site_key);
}
async function queryOrdersNow() {
  const mode = await fetchQueryMode();
  const phone = document.getElementById('q-phone').value.trim();
  if (!/^1\d{10}$/.test(phone)) return setQueryError('请填写正确的手机号');
  const payload = { phone };
  if (mode.sms) {
    const code = (document.getElementById('q-code').value || '').trim();
    if (!/^\d{6}$/.test(code)) return setQueryError('请填写 6 位短信验证码');
    payload.code = code;
  } else {
    const orderId = (document.getElementById('q-order').value || '').trim();
    if (!orderId) return setQueryError('请填写订单号；忘记订单号可点下方「忘记订单号？」查看找回方式');
    payload.order_id = orderId;
    if (queryTurnstileToken) payload.turnstile_token = queryTurnstileToken;
  }
  const box = document.getElementById('order-results');
  clearQueryError();
  box.innerHTML = '<div class="view-loading">查询中…</div>';
  try {
    const res = await fetch('/api/orders/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      box.innerHTML = `<div class="view-empty">${escapeHtml((data && data.message) || '查询失败，请稍后重试')}</div>`;
      return;
    }
    if (!data.orders.length) {
      box.innerHTML = `<div class="view-empty">${mode.sms ? '该手机号暂无订单，下单后即可查询' : '未找到该订单，请核对订单号与手机号'}</div>`;
      return;
    }
    box.innerHTML = `<div class="order-list">${data.orders.map(orderCardHtml).join('')}</div>`;
  } catch (err) {
    box.innerHTML = '<div class="view-empty">网络异常，请重试</div>';
  }
}

/* ================================================================
 * 品牌页
 * ================================================================ */
async function loadBrand(key) {
  const el = views.brand;
  el.innerHTML = '<div class="view-loading">加载中…</div>';
  let brand = null;
  let products = [];
  try {
    const res = await fetch(`/api/brands/profile/${encodeURIComponent(key)}`);
    if (res.ok) {
      const data = await res.json();
      brand = data.brand || null;
      products = (brand && brand.products) || [];
    }
  } catch (e) { /* 档案缺失时降级 */ }
  if (!brand && !products.length) {
    try {
      const res = await fetch(`/api/products?brand=${encodeURIComponent(key)}`);
      if (res.ok) { const data = await res.json(); products = Array.isArray(data) ? data : (data.products || []); }
    } catch (e) { /* ignore */ }
  }
  const certs = (brand && Array.isArray(brand.certs)) ? brand.certs : [];
  el.innerHTML = `
    <div class="view-head brand-page-head">
      <h1>${escapeHtml(key)}</h1>
      <p>${products.length} 个在售产品${brand ? ' · 产地品牌档案' : ''}</p>
    </div>
    ${(!brand || !brand.intro) ? '<div class="brand-intro"><h2>品牌介绍</h2><p class="brand-empty">该品牌暂未维护公司介绍与资质档案，可联系客服获取详情</p></div>' : ''}
    ${brand && brand.intro ? `<div class="brand-intro"><h2>品牌介绍</h2><p>${escapeHtml(brand.intro).replace(/\n/g, '<br />')}</p></div>` : ''}
    ${certs.length ? `<div class="brand-certs"><h2>资质证书</h2><div class="cert-grid">${certs.map((c) => `<img src="${escapeHtml(safeImgUrl(c))}" alt="资质证书" loading="lazy" onclick="openLightbox('${safeImgUrl(c)}', '资质证书')" />`).join('')}</div></div>` : ''}
    ${brand && brand.services ? `<div class="brand-services"><h2>合作方式</h2><p>${escapeHtml(brand.services).replace(/\n/g, '<br />')}</p></div>` : ''}
    ${brand && brand.contact ? `<div class="brand-contact"><h2>联系方式</h2><p>${escapeHtml(brand.contact).replace(/\n/g, '<br />')}</p></div>` : ''}
    <h2 class="brand-products-title">该品牌在售产品</h2>
    ${products.length ? `<div class="product-grid">${products.map(cardHtml).join('')}</div>` : '<div class="view-empty">该品牌暂无在售产品</div>'}
    <div class="cart-actions"><a class="btn btn-outline" href="#/">返回全部商品</a></div>`;
}

/* ================================================================
 * 全局事件分发（data-action）
 * ================================================================ */
function detailQty() { return Math.max(1, parseInt((document.getElementById('detail-qty') || { textContent: '1' }).textContent, 10) || 1); }
function changeQty(delta) {
  const el = document.getElementById('detail-qty');
  if (!el) return;
  el.textContent = String(Math.max(1, (parseInt(el.textContent, 10) || 1) + delta));
}
function cartItemQty(id, delta) {
  const cart = getCart();
  const it = cart.find((x) => x.id === id);
  if (!it) return;
  it.qty = Math.max(1, (parseInt(it.qty, 10) || 1) + delta);
  setCart(cart);
  renderCart();
}
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'qty-minus') changeQty(-1);
  else if (action === 'qty-plus') changeQty(1);
  else if (action === 'add-cart') {
    if (currentDetail) addToCart(currentDetail, detailQty());
  } else if (action === 'buy-now') {
    if (currentDetail) addToCart(currentDetail, detailQty());
    location.hash = '#/cart';
  } else if (action === 'cart-minus') cartItemQty(btn.dataset.id, -1);
  else if (action === 'cart-plus') cartItemQty(btn.dataset.id, 1);
  else if (action === 'cart-remove') {
    const cart = getCart().filter((x) => x.id !== btn.dataset.id);
    setCart(cart);
    renderCart();
  } else if (action === 'submit-order') {
    submitOrder();
  } else if (action === 'fill-order') {
    const input = document.getElementById('q-order');
    if (input) {
      input.value = btn.dataset.orderId || '';
      input.focus();
    }
    clearQueryError();
  } else if (action === 'forgot-order-toggle') {
    const body = document.getElementById('q-forgot');
    if (!body) return;
    body.hidden = !body.hidden;
    btn.setAttribute('aria-expanded', String(!body.hidden));
  } else if (action === 'open-contact') {
    const contactBtn = document.getElementById('contact-open');
    if (contactBtn) contactBtn.click();
  } else if (action === 'copy-order') {
    copyOrderId(btn.dataset.orderId || '');
  } else if (action === 'query-orders') {
    queryOrdersNow();
  } else if (action === 'send-query-code') {
    sendQueryCode();
  } else if (action === 'order-toggle') {
    const card = btn.closest('.order-card');
    if (!card) return;
    const body = card.querySelector('.order-card-body');
    const hidden = body.hidden;
    body.hidden = !hidden;
    btn.textContent = hidden ? '收起明细' : '查看明细';
  }
});

const cartOpenBtn = document.getElementById('cart-open');
if (cartOpenBtn) cartOpenBtn.addEventListener('click', () => { location.hash = '#/cart'; });
const ordersOpenBtn = document.getElementById('orders-open');
if (ordersOpenBtn) ordersOpenBtn.addEventListener('click', () => { location.hash = '#/orders'; });

updateCartBadge();
parseHash();
