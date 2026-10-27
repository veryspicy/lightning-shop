/* Lightning Shop 前端逻辑：加载产品、分类筛选、搜索渲染 */

const grid = document.getElementById('product-grid');
const emptyState = document.getElementById('empty-state');
const searchInput = document.getElementById('search-input');
const tabs = document.getElementById('category-tabs');
const brandTabs = document.getElementById('brand-tabs');

let products = [];
let total = 0;
let activeCategory = '';
let activeBrand = '';
let priceConfig = null;
let loading = false;
const PAGE_SIZE = 24;

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

/* 价格策略：前台展示价 = 出厂价 × (1 + 利润率%)，后台数据不变 */
function formatNum(n) {
  return String(parseFloat(n.toFixed(2)));
}

function applyMargin(priceStr, cfg) {
  if (!cfg || !cfg.enabled || !cfg.margin || !priceStr) return priceStr;
  if (!/元/.test(priceStr)) return priceStr; // 议价/报价说明等无价格数字的文案原样
  const rate = 1 + cfg.margin / 100;
  // 只加成"元"前的价格数字（含区间 9.9-13.9、多档 12/11.5/11、阶梯 100斤起12元），数量单位数字不动
  const tokenRe = /(\d+(?:\.\d+)?(?:\s*[\/\-]\s*\d+(?:\.\d+)?)*)\s*元/g;
  return priceStr.replace(tokenRe, (whole, nums) => {
    const scaled = nums.replace(/\d+(?:\.\d+)?/g, (m) => formatNum(parseFloat(m) * rate));
    return whole.replace(nums, scaled);
  });
}

function displayPrice(str) {
  return applyMargin(str, priceConfig);
}

function cardHtml(p) {
  const badge = p.badge
    ? `<span class="card-badges">${String(p.badge).split(/[,，|]/).map((s) => s.trim()).filter(Boolean)
        .map((b) => `<span class="card-badge${b.includes('低GI') ? ' gi' : ''}">${escapeHtml(b)}</span>`)
        .join('')}</span>`
    : '';

  const media = p.image
    ? `<img src="${p.image}" alt="${escapeHtml(p.name)}" loading="lazy" />`
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
        <h3 class="card-name">${escapeHtml(p.name)}</h3>
        <p class="card-spec">${escapeHtml(p.spec)} · ${escapeHtml(p.brand)}</p>
        <p class="card-highlight">${escapeHtml(p.highlights)}</p>
        <div class="card-meta">
          ${p.cert ? `<span class="card-tag">${escapeHtml(p.cert)}</span>` : ''}
          ${p.moq ? `<span class="card-tag amber">起订 ${escapeHtml(p.moq)}</span>` : ''}
        </div>
        <div class="card-price">
          <div class="price-wholesale">
            <span>批发价</span>
            <b>${escapeHtml(displayPrice(p.wholesale_price))}</b>
          </div>
          <div class="price-retail">
            <span>零售</span>
            <b>${escapeHtml(displayPrice(retailText))}</b>
          </div>
        </div>
      </div>
    </article>`;
}

function render() {
  grid.innerHTML = products.map(cardHtml).join('');
  emptyState.hidden = products.length > 0;
  if (updateCatNav) updateCatNav();
  if (updateBrandNav) updateBrandNav();
  updateLoadMore();
}

function updateLoadMore() {
  const moreBtn = document.getElementById('load-more');
  if (!moreBtn) return;
  moreBtn.hidden = products.length >= total;
}

function renderTabs(categories) {
  const all = [{ name: '', count: total }].concat(categories);
  tabs.innerHTML = all
    .map(
      (c) =>
        `<button class="cat-tab${c.name === activeCategory ? ' active' : ''}" data-category="${escapeHtml(c.name)}" role="tab">${escapeHtml(c.name || '全部')}<span style="opacity:.6"> · ${c.count}</span></button>`
    )
    .join('');
}

function renderBrandTabs(brands) {
  const all = [{ name: '', count: total }].concat(brands);
  brandTabs.innerHTML = all
    .map(
      (b) =>
        `<button class="cat-tab${b.name === activeBrand ? ' active' : ''}" data-brand="${escapeHtml(b.name)}" role="tab">${escapeHtml(b.name || '全部品牌')}<span style="opacity:.6"> · ${b.count}</span></button>`
    )
    .join('');
  if (updateBrandNav) updateBrandNav();
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
  const quoteImg = document.getElementById('quote-qr-img');
  if (quoteImg && qr.quoteImage) {
    quoteImg.src = qr.quoteImage;
    quoteImg.alt = '报价单二维码';
  }
  const quoteTitle = document.getElementById('quote-qr-title');
  if (quoteTitle && qr.quoteTitle) quoteTitle.textContent = qr.quoteTitle;
  const shopTitle = document.getElementById('shop-qr-title');
  if (shopTitle && qr.shopTitle) shopTitle.textContent = qr.shopTitle;
  const box = document.getElementById('site-qr');
  if (box && qr.url && typeof QRCode !== 'undefined') {
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

async function load() {
  try {
    const [data, cRes, bRes, heroRes, priceRes, qrRes] = await Promise.all([
      fetchPage(0),
      fetch('/api/categories'),
      fetch('/api/brands'),
      fetch('/api/site/hero'),
      fetch('/api/site/price'),
      fetch('/api/site/qr'),
    ]);
    products = data.items || [];
    total = data.total || products.length;
    const categories = await cRes.json();
    const brands = await bRes.json();
    const hero = await heroRes.json().catch(() => null);
    priceConfig = await priceRes.json().catch(() => null);
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

tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-tab');
  if (!btn) return;
  activeCategory = btn.dataset.category;
  tabs.querySelectorAll('.cat-tab').forEach((b) => b.classList.toggle('active', b === btn));
  btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  reload();
});

brandTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-tab');
  if (!btn) return;
  activeBrand = btn.dataset.brand;
  brandTabs.querySelectorAll('.cat-tab').forEach((b) => b.classList.toggle('active', b === btn));
  btn.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  reload();
});

/* 左右箭头（独立于滚动区两侧，不随内容滚动；移动端隐藏走触屏滑动） */
function setupScrollNav(scrollEl, prevBtn, nextBtn) {
  if (!scrollEl || !prevBtn || !nextBtn) return null;
  const update = () => {
    prevBtn.disabled = scrollEl.scrollLeft <= 0;
    nextBtn.disabled = scrollEl.scrollLeft >= scrollEl.scrollWidth - scrollEl.clientWidth - 1;
  };
  const step = () => Math.min(240, scrollEl.scrollWidth - scrollEl.clientWidth);
  prevBtn.addEventListener('click', () => scrollEl.scrollBy({ left: -step(), behavior: 'smooth' }));
  nextBtn.addEventListener('click', () => scrollEl.scrollBy({ left: step(), behavior: 'smooth' }));
  scrollEl.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  update();
  return update;
}
const updateCatNav = setupScrollNav(tabs, document.querySelector('.tabs-prev'), document.querySelector('.tabs-next'));
const updateBrandNav = setupScrollNav(brandTabs, document.querySelector('.brands-prev'), document.querySelector('.brands-next'));

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(reload, 300);
});

load();

/* 商品分页：加载更多 */
const loadMoreBtn = document.getElementById('load-more');
if (loadMoreBtn) loadMoreBtn.addEventListener('click', loadMore);

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
  ctx.fillText(displayPrice(p.wholesale_price) || '—', padX + 18, y + 58);
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
