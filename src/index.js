/**
 * Lightning Shop Worker
 * 路由：
 *   GET  /api/products            -> 全部产品（支持 ?category=  ?q= 过滤；自动排除下架）
 *   GET  /api/products/:id        -> 单个产品
 *   GET  /api/categories          -> 分类列表（配置分类 + 产品聚合，含数量）
 *   GET  /api/admin/categories    -> 分类配置管理（配置分类 + 产品自动发现分类，需 x-admin-token）
 *   POST /api/admin/categories    -> 新增配置分类（需 x-admin-token）
 *   PUT  /api/admin/categories    -> 重命名配置分类（同步产品分类，需 x-admin-token）
 *   DELETE /api/admin/categories  -> 删除配置分类（产品数据不动，需 x-admin-token）
 *   POST /api/products            -> 新增产品（需 x-admin-token）
 *   POST /api/admin/products/import -> 批量导入产品（数组，按 name+brand upsert，需 x-admin-token）
 *   PATCH /api/products/batch     -> 批量更新产品字段（需 x-admin-token）
 *   PUT  /api/products/:id        -> 更新产品（需 x-admin-token）
 *   DELETE /api/products/:id      -> 删除产品（需 x-admin-token）
 *   POST /api/upload              -> 图片上传 base64 -> R2（需 x-admin-token）
 *   GET  /img/*                   -> R2 图片代理
 *   其余                           -> 静态资源（public/）
 */

const CATEGORY_ORDER = ['低GI杂粮', '营养粮油', '黄柿子火锅底料', '野生苦菜', '坚果玉米', '羊杂碎'];

async function getProducts(env) {
  const raw = await env.KV.get('products', 'json');
  if (raw) return raw;
  return [];
}

// 配置分类：管理员维护的分类名列表（KV config:categories），缺省使用 CATEGORY_ORDER
async function getConfigCategories(env) {
  const raw = await env.KV.get('config:categories', 'json');
  if (Array.isArray(raw) && raw.length > 0) {
    return [...new Set(raw.map((x) => String(x).trim()).filter(Boolean))];
  }
  return [...CATEGORY_ORDER];
}

async function getCategories(env) {
  const raw = await env.KV.get('categories', 'json');
  if (raw) return raw;
  return [];
}

// 合并分类：配置分类固定在前（无产品也显示，count=0），产品中出现但未配置的分类自动追加在后
function buildCategories(products, configured = CATEGORY_ORDER) {
  const map = new Map();
  for (const p of products) {
    const c = p.category || '未分类';
    map.set(c, (map.get(c) || 0) + 1);
  }
  const seen = new Set();
  const list = [];
  for (const name of configured) {
    list.push({ name, count: map.get(name) || 0 });
    seen.add(name);
  }
  const extra = [...map.keys()].filter((c) => !seen.has(c)).sort();
  return list.concat(extra.map((name) => ({ name, count: map.get(name) })));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// 配置类接口响应：禁止浏览器缓存，保证后台改动立即生效
function jsonNoCache(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function notFound() {
  return new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/* ---- 管理后台：鉴权与写接口 ---- */

function unauthorized() {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

function checkAuth(request, env) {
  const token = (request.headers.get('x-admin-token') || '').trim();
  return !!env.ADMIN_PASSWORD && token === env.ADMIN_PASSWORD;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function nextId(products) {
  const maxSeq = products.reduce((m, p) => Math.max(m, p.seq || 0), 0);
  const seq = maxSeq + 1;
  return { id: `p${String(seq).padStart(2, '0')}`, seq };
}

const PRODUCT_FIELDS = [
  'name', 'brand', 'category', 'spec', 'wholesale_price', 'retail_price',
  'price_note', 'moq', 'highlights', 'storage', 'shelf_life', 'cert', 'badge',
];

const DEFAULT_HERO = {
  title: '农牧特产批发，源头厂家直供',
  eyebrow: '产地直供',
  bgImage: '',
};

async function getHero(env) {
  const raw = await env.KV.get('site:hero', 'json');
  if (raw && raw.title) return raw;
  return DEFAULT_HERO;
}

async function saveHero(env, hero) {
  const h = {
    title: String(hero.title || '').trim(),
    eyebrow: String(hero.eyebrow || '').trim(),
    bgImage: String(hero.bgImage || '').trim(),
  };
  if (!h.title) h.title = DEFAULT_HERO.title;
  if (!h.eyebrow) h.eyebrow = DEFAULT_HERO.eyebrow;
  await env.KV.put('site:hero', JSON.stringify(h));
  return h;
}

// 价格策略：前台展示价 = 出厂价 × (1 + margin%)
const DEFAULT_PRICE = { enabled: true, margin: 10 };

async function getPrice(env) {
  const raw = await env.KV.get('site:price', 'json');
  if (raw && typeof raw.margin === 'number') {
    return { enabled: !!raw.enabled, margin: raw.margin };
  }
  return DEFAULT_PRICE;
}

async function savePrice(env, raw) {
  let margin = Number(raw.margin);
  if (!Number.isFinite(margin)) margin = DEFAULT_PRICE.margin;
  margin = Math.min(500, Math.max(0, Math.round(margin * 10) / 10));
  const p = { enabled: raw.enabled !== false, margin };
  await env.KV.put('site:price', JSON.stringify(p));
  return p;
}

// 二维码站点配置：url 用于首页动态生成「扫码直达商城」二维码，quoteImage 为报价单二维码图片（R2）
// quoteTitle / shopTitle 为两张卡片标题，后台可配置，留空回退默认
const DEFAULT_QR = {
  url: 'https://lightning-shop.gora.dpdns.org',
  quoteImage: '/wechat-qr.jpg',
  quoteTitle: '获取完整报价单',
  shopTitle: '扫码直达商城',
};

async function getQr(env) {
  const raw = await env.KV.get('site:qr', 'json');
  if (raw && (raw.url || raw.quoteImage)) {
    return {
      url: String(raw.url || DEFAULT_QR.url).trim() || DEFAULT_QR.url,
      quoteImage: String(raw.quoteImage || DEFAULT_QR.quoteImage).trim() || DEFAULT_QR.quoteImage,
      quoteTitle: String(raw.quoteTitle || '').trim() || DEFAULT_QR.quoteTitle,
      shopTitle: String(raw.shopTitle || '').trim() || DEFAULT_QR.shopTitle,
    };
  }
  return DEFAULT_QR;
}

async function saveQr(env, raw) {
  const q = {
    url: String(raw.url || '').trim(),
    quoteImage: String(raw.quoteImage || '').trim(),
    quoteTitle: String(raw.quoteTitle || '').trim() || DEFAULT_QR.quoteTitle,
    shopTitle: String(raw.shopTitle || '').trim() || DEFAULT_QR.shopTitle,
  };
  if (!q.url) q.url = DEFAULT_QR.url;
  if (!q.quoteImage) q.quoteImage = DEFAULT_QR.quoteImage;
  await env.KV.put('site:qr', JSON.stringify(q));
  return q;
}

function sanitizeProduct(raw) {
  const p = {};
  for (const f of PRODUCT_FIELDS) p[f] = String(raw[f] ?? '').trim();
  p.image = (raw.image || '').trim();
  p.status = raw.status === '下架' ? '下架' : '上架';
  if (!p.category) p.category = '未分类';
  return p;
}

async function saveProduct(env, products, item) {
  await env.KV.put('products', JSON.stringify(products));
  await env.KV.put(`products:${item.id}`, JSON.stringify(item));
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const products = await getProducts(env);
  const onShelf = products.filter((p) => p.status !== '下架');

  // GET /api/admin/products：后台全量列表（含下架）
  if (path === '/api/admin/products' && method === 'GET') {
    if (!checkAuth(request, env)) return unauthorized();
    return json(products);
  }

  // 分类配置管理：GET 返回配置分类与产品自动发现分类；POST 新增配置分类
  if (path === '/api/admin/categories') {
    if (!checkAuth(request, env)) return unauthorized();
    const configured = await getConfigCategories(env);
    if (method === 'GET') {
      const merged = buildCategories(onShelf, configured);
      const configuredSet = new Set(configured);
      return jsonNoCache({
        configured: merged.filter((c) => configuredSet.has(c.name)),
        extra: merged.filter((c) => !configuredSet.has(c.name)),
      });
    }
    if (method === 'POST') {
      const raw = await readJson(request);
      const name = String(raw?.name || '').trim();
      if (!name) return json({ error: 'bad_request', message: '分类名称必填' }, 400);
      if (name.length > 20) return json({ error: 'bad_request', message: '分类名称过长（≤20字）' }, 400);
      if (configured.includes(name)) return json({ error: 'duplicated', message: '分类已存在' }, 400);
      const next = [...configured, name];
      await env.KV.put('config:categories', JSON.stringify(next));
      return jsonNoCache({ ok: true, categories: next });
    }
    if (method === 'PUT') {
      const raw = await readJson(request);
      const old = String(raw?.old || '').trim();
      const name = String(raw?.name || '').trim();
      if (!old) return json({ error: 'bad_request', message: '原分类名必填' }, 400);
      if (!configured.includes(old)) return json({ error: 'not_found', message: '分类不存在' }, 404);
      if (!name) return json({ error: 'bad_request', message: '新分类名必填' }, 400);
      if (name.length > 20) return json({ error: 'bad_request', message: '分类名称过长（≤20字）' }, 400);
      if (name !== old && configured.includes(name)) return json({ error: 'duplicated', message: '目标分类名已存在' }, 400);
      const next = configured.map((c) => (c === old ? name : c));
      await env.KV.put('config:categories', JSON.stringify(next));
      // 同步重命名产品中的该分类（仅改 category 字段，其余不动）
      let renamed = 0;
      const changed = products.filter((p) => p.category === old);
      if (changed.length) {
        for (const p of changed) p.category = name;
        await env.KV.put('products', JSON.stringify(products));
        for (const p of changed) await env.KV.put(`products:${p.id}`, JSON.stringify(p));
        renamed = changed.length;
      }
      return jsonNoCache({ ok: true, categories: next, renamed });
    }
    if (method === 'DELETE') {
      const raw = await readJson(request);
      const name = String(raw?.name || '').trim();
      if (!name) return json({ error: 'bad_request', message: '分类名必填' }, 400);
      if (!configured.includes(name)) return json({ error: 'not_found', message: '分类不存在' }, 404);
      // 仅移除配置分类，产品中引用该分类的产品保留原分类（自动出现在 extra）
      const next = configured.filter((c) => c !== name);
      await env.KV.put('config:categories', JSON.stringify(next));
      return jsonNoCache({ ok: true, categories: next });
    }
    return notFound();
  }

  // GET /api/categories：配置分类 + 产品聚合分类（禁缓存，配置改动立即生效）
  if (path === '/api/categories' && method === 'GET') {
    return jsonNoCache(buildCategories(onShelf, await getConfigCategories(env)));
  }

  // Hero 站点配置：GET 公共可读（禁缓存，保证后台改配置前端立即生效），PUT 需鉴权
  if (path === '/api/site/hero') {
    if (method === 'GET') return jsonNoCache(await getHero(env));
    if (method === 'PUT') {
      if (!checkAuth(request, env)) return unauthorized();
      const raw = await readJson(request);
      if (!raw) return json({ error: 'bad_request' }, 400);
      const hero = await saveHero(env, raw);
      return json({ ok: true, hero });
    }
    return notFound();
  }

  // 价格策略：前台展示价 = 出厂价 × (1 + margin%)，GET 禁缓存，PUT 需鉴权
  if (path === '/api/site/price') {
    if (method === 'GET') return jsonNoCache(await getPrice(env));
    if (method === 'PUT') {
      if (!checkAuth(request, env)) return unauthorized();
      const raw = await readJson(request);
      if (!raw) return json({ error: 'bad_request' }, 400);
      const price = await savePrice(env, raw);
      return json({ ok: true, price });
    }
    return notFound();
  }

  // 二维码站点配置：GET 公共可读（禁缓存，保证后台改配置前端立即生效），PUT 需鉴权
  if (path === '/api/site/qr') {
    if (method === 'GET') return jsonNoCache(await getQr(env));
    if (method === 'PUT') {
      if (!checkAuth(request, env)) return unauthorized();
      const raw = await readJson(request);
      if (!raw) return json({ error: 'bad_request' }, 400);
      const qr = await saveQr(env, raw);
      return json({ ok: true, qr });
    }
    return notFound();
  }

  // 批量更新：PATCH /api/products/batch
  // body: { ids: [id...], patch: { badge: '火锅底料', ... } }
  // 仅合并 patch 中出现的字段（白名单），未传字段保留原值，批量回写 KV
  if (path === '/api/products/batch' && (method === 'PATCH' || method === 'PUT')) {
    if (!checkAuth(request, env)) return unauthorized();
    const raw = await readJson(request);
    if (!raw || !Array.isArray(raw.ids) || raw.ids.length === 0 || !raw.patch || typeof raw.patch !== 'object') {
      return json({ error: 'bad_request', message: 'ids 数组与 patch 对象必填' }, 400);
    }
    const patchKeys = Object.keys(raw.patch).filter((k) => PRODUCT_FIELDS.includes(k) || k === 'status');
    if (patchKeys.length === 0) {
      return json({ error: 'bad_request', message: 'patch 中无有效字段' }, 400);
    }
    const idSet = new Set(raw.ids);
    let updated = 0;
    const changed = [];
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      if (!idSet.has(p.id)) continue;
      const merged = { ...p };
      for (const k of patchKeys) {
        if (k === 'status') {
          merged.status = raw.patch.status === '下架' ? '下架' : '上架';
        } else {
          merged[k] = String(raw.patch[k] ?? '').trim();
        }
      }
      if (!merged.category) merged.category = '未分类';
      products[i] = merged;
      changed.push(merged);
      updated++;
    }
    if (updated > 0) {
      await env.KV.put('products', JSON.stringify(products));
      for (const item of changed) {
        await env.KV.put(`products:${item.id}`, JSON.stringify(item));
      }
    }
    return json({ ok: true, updated });
  }

  // 批量导入：POST /api/admin/products/import
  // body: { products: [ {...产品字段}, ... ] }
  // 按 name+brand upsert：已存在则仅合并传入字段，不存在则新增；逐行校验，失败行跳过不中断
  if (path === '/api/admin/products/import' && method === 'POST') {
    if (!checkAuth(request, env)) return unauthorized();
    const raw = await readJson(request);
    if (!raw || !Array.isArray(raw.products)) {
      return json({ error: 'bad_request', message: 'products 数组必填' }, 400);
    }
    const IMPORT_FIELDS = [...PRODUCT_FIELDS, 'image'];
    const imported = [];
    const updated = [];
    const errors = [];
    const upsert = new Map(products.map((p, idx) => [`${p.name}\u0000${p.brand || ''}`, { item: p, idx }]));
    let seqCursor = null;
    for (let i = 0; i < raw.products.length; i++) {
      const row = raw.products[i];
      if (!row || typeof row !== 'object') {
        errors.push({ index: i, message: '行数据无效' });
        continue;
      }
      const name = String(row.name || '').trim();
      if (!name) {
        errors.push({ index: i, message: '品名必填' });
        continue;
      }
      const brand = String(row.brand || '').trim();
      const key = `${name}\u0000${brand}`;
      const hit = upsert.get(key);
      if (hit) {
        const merged = { ...hit.item };
        for (const f of IMPORT_FIELDS) {
          if (row[f] !== undefined && row[f] !== null) {
            if (f === 'image') merged.image = String(row.image).trim();
            else if (f === 'status') merged.status = row.status === '下架' ? '下架' : '上架';
            else merged[f] = String(row[f]).trim();
          }
        }
        if (!merged.category) merged.category = '未分类';
        updated.push({ merged, idx: hit.idx });
      } else {
        if (seqCursor === null) seqCursor = nextId(products);
        else {
          seqCursor.seq += 1;
          seqCursor.id = `p${String(seqCursor.seq).padStart(2, '0')}`;
        }
        const item = { id: seqCursor.id, seq: seqCursor.seq, ...sanitizeProduct(row) };
        imported.push(item);
        upsert.set(key, { item, idx: null });
      }
    }
    if (imported.length) {
      products.push(...imported);
      await env.KV.put('products', JSON.stringify(products));
      for (const item of imported) await env.KV.put(`products:${item.id}`, JSON.stringify(item));
    }
    if (updated.length) {
      for (const u of updated) products[u.idx] = u.merged;
      await env.KV.put('products', JSON.stringify(products));
      for (const u of updated) await env.KV.put(`products:${u.merged.id}`, JSON.stringify(u.merged));
    }
    return json({ ok: true, imported: imported.length, updated: updated.length, errors, total: products.length });
  }

  // /api/products/:id
  const m = path.match(/^\/api\/products\/([^/]+)$/);
  if (m) {
    if (method === 'GET') {
      const p = products.find((x) => x.id === m[1]);
      return p ? json(p) : notFound();
    }
    if (method === 'PUT' || method === 'DELETE') {
      if (!checkAuth(request, env)) return unauthorized();
      const idx = products.findIndex((x) => x.id === m[1]);
      if (idx === -1) return notFound();

      if (method === 'PUT') {
        const raw = await readJson(request);
        if (!raw) return json({ error: 'bad_request' }, 400);
        const merged = { ...products[idx], ...sanitizeProduct(raw) };
        products[idx] = merged;
        await saveProduct(env, products, merged);
        return json({ ok: true, product: merged });
      }

      // DELETE：同步删除详情 KV 与关联 R2 图片
      const removed = products[idx];
      products.splice(idx, 1);
      await env.KV.put('products', JSON.stringify(products));
      await env.KV.delete(`products:${removed.id}`);
      if (removed.image) {
        const key = removed.image.replace(/^\/img\//, '');
        try {
          await env.R2.delete(key);
        } catch {
          /* 图片不存在时忽略 */
        }
      }
      return json({ ok: true, id: removed.id });
    }
    return notFound();
  }

  // /api/products
  if (path === '/api/products') {
    if (method === 'GET') {
      const category = url.searchParams.get('category');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      let list = onShelf;
      if (category) list = list.filter((p) => p.category === category);
      if (q) {
        list = list.filter(
          (p) =>
            (p.name || '').toLowerCase().includes(q) ||
            (p.brand || '').toLowerCase().includes(q) ||
            (p.highlights || '').toLowerCase().includes(q)
        );
      }
      // 分页：?limit=&offset=；显式传分页参数时返回 { items,total,offset,limit }，否则保持数组兼容
      if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
        return json({ items: list.slice(offset, offset + limit), total: list.length, offset, limit });
      }
      return json(list);
    }
    if (method === 'POST') {
      if (!checkAuth(request, env)) return unauthorized();
      const raw = await readJson(request);
      if (!raw || !String(raw.name || '').trim()) {
        return json({ error: 'bad_request', message: '品名必填' }, 400);
      }
      const { id, seq } = nextId(products);
      const item = { id, seq, ...sanitizeProduct(raw) };
      products.push(item);
      await saveProduct(env, products, item);
      return json({ ok: true, product: item }, 201);
    }
    return notFound();
  }

  // POST /api/upload：图片上传（base64 -> R2）
  if (path === '/api/upload') {
    if (method !== 'POST') return notFound();
    if (!checkAuth(request, env)) return unauthorized();
    const body = await readJson(request);
    if (!body || !body.filename || !body.base64) {
      return json({ error: 'bad_request', message: 'filename 与 base64 必填' }, 400);
    }
    const filename = String(body.filename).replace(/[^\w.-]/g, '');
    if (!filename) return json({ error: 'bad_request', message: '文件名无效' }, 400);
    let bin;
    try {
      const b64 = String(body.base64).replace(/^data:[^,]+,/, '');
      bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    } catch {
      return json({ error: 'bad_request', message: 'base64 无效' }, 400);
    }
    const type = /\.png$/i.test(filename)
      ? 'image/png'
      : /\.webp$/i.test(filename)
        ? 'image/webp'
        : 'image/jpeg';
    await env.R2.put(filename, bin, { httpMetadata: { contentType: type } });
    return json({ ok: true, url: `/img/${filename}` });
  }

  return notFound();
}

async function handleImage(request, env, url) {
  const key = url.pathname.replace(/^\/img\//, '');
  const obj = await env.R2.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=86400');
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    if (url.pathname.startsWith('/img/')) {
      return handleImage(request, env, url);
    }

    // 静态资源：public/ 目录
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Lightning Shop', { status: 200 });
  },
};
