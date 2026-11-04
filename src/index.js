/**
 * Lightning Shop Worker
 * 路由：
 *   GET  /api/products            -> 全部产品（支持 ?category=  ?brand=  ?q= 过滤；自动排除下架）
 *   GET  /api/products/:id        -> 单个产品
 *   GET  /api/categories          -> 分类列表（配置分类 + 产品聚合，含数量）
 *   GET  /api/brands              -> 品牌列表（产品聚合，含数量）
 *   POST /api/orders              -> 下单（公开，手机号+公司/个人标识）
 *   POST /api/orders/query        -> 查单（公开，手机号[+订单号]）
 *   GET  /api/brands/profile      -> 品牌档案列表（公开）
 *   GET  /api/brands/profile/:key -> 品牌档案详情+该品牌产品（公开）
 *   GET  /api/admin/orders        -> 订单列表（?status= 过滤，需 x-admin-token）
 *   GET  /api/admin/orders/:id    -> 订单详情（需 x-admin-token）
 *   POST /api/admin/orders/:id/status -> 订单状态流转（收款/发货/完成/取消，需 x-admin-token）
 *   GET  /api/admin/customers     -> 客户列表（手机号聚合，需 x-admin-token）
 *   GET  /api/admin/customers/:phone -> 客户详情+订单（需 x-admin-token）
 *   GET  /api/admin/brands/profile    -> 品牌档案列表（需 x-admin-token）
 *   GET/PUT/DELETE /api/admin/brands/profile/:key -> 品牌档案详情/维护/删除（需 x-admin-token）
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
      'Cache-Control': 'no-cache',
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

const SESSION_TTL = 60 * 60 * 24 * 7; // 会话有效期 7 天

// 可配置权限点（角色管理界面可勾选）
const PERM_DEFS = {
  dashboard: { label: '看板', desc: '查看统计看板' },
  products: { label: '产品管理', desc: '产品增删改查与图片上传' },
  categories: { label: '分类管理', desc: '配置商品分类' },
  price: { label: '价格策略', desc: '前台价格加成策略' },
  hero: { label: '首页配置', desc: '首页文案与背景图' },
  qr: { label: '二维码配置', desc: '二维码与卡片文案' },
  users: { label: '账号管理', desc: '管理登录账号' },
  roles: { label: '角色管理', desc: '管理角色与权限' },
  orders: { label: '订单管理', desc: '查看订单并处理收款/发货' },
  customers: { label: '客户档案', desc: '按手机号查看客户与订单' },
  brands: { label: '品牌档案', desc: '维护品牌介绍与资质' },
};

// 内置角色（不可删除；权限可在角色管理中调整）
const BUILTIN_ROLES = {
  admin: { key: 'admin', name: '管理员', builtin: true, permissions: ['*'] },
  ops: { key: 'ops', name: '运营', builtin: true, permissions: ['dashboard', 'products', 'categories', 'price', 'hero', 'qr', 'orders', 'customers', 'brands'] },
  supplier: { key: 'supplier', name: '供应商', builtin: true, permissions: ['dashboard', 'products'] },
};

// 角色表 = 内置角色 + KV 自定义角色（KV roles 存自定义角色数组）
async function getRoles(env) {
  const map = {};
  for (const k of Object.keys(BUILTIN_ROLES)) map[k] = { ...BUILTIN_ROLES[k], permissions: [...BUILTIN_ROLES[k].permissions] };
  const raw = await env.KV.get('roles', 'json');
  if (Array.isArray(raw)) {
    for (const r of raw) if (r && r.key) map[r.key] = { key: r.key, name: r.name, builtin: false, permissions: Array.isArray(r.permissions) ? r.permissions : [] };
  }
  return map;
}

async function saveRoles(env, roles) {
  const custom = Object.values(roles).filter((r) => !r.builtin);
  await env.KV.put('roles', JSON.stringify(custom));
}

// 角色权限解析：'*' 表示全部权限
function rolePermissions(role) {
  return (role && role.permissions) || [];
}

function unauthorized(msg = 'unauthorized') {
  return new Response(JSON.stringify({ error: msg }), {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

function forbidden() {
  return new Response(JSON.stringify({ error: 'forbidden', message: '无权限执行该操作' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

async function getUsers(env) {
  const raw = await env.KV.get('users', 'json');
  if (Array.isArray(raw)) return raw;
  return [];
}

async function saveUsers(env, users) {
  await env.KV.put('users', JSON.stringify(users));
}

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name || '',
    role: u.role || 'ops',
    supplierBrand: u.supplierBrand || '',
    status: u.status || 'active',
    createdAt: u.createdAt || '',
    lastLoginAt: u.lastLoginAt || '',
  };
}

// 附加角色名与权限（前端据此渲染菜单与权限控制）
async function publicUserWithPerms(env, u) {
  const pu = publicUser(u);
  const map = await getRoles(env);
  const role = map[pu.role] || map.ops;
  pu.roleName = role ? role.name : pu.role;
  pu.permissions = rolePermissions(role);
  return pu;
}

function nextUserId(users) {
  const max = users.reduce((m, u) => Math.max(m, Number(String(u.id || 'u0').replace('u', '')) || 0), 0);
  return `u${max + 1}`;
}

// 迁移兼容：系统中尚无 admin 用户时，以 env.ADMIN_PASSWORD 作为初始 admin 密码自动创建
async function ensureAdminUser(env, users, username, password) {
  const hasAdmin = users.some((u) => u.role === 'admin' && u.status !== 'disabled');
  if (hasAdmin) return null;
  if (username !== 'admin' || !env.ADMIN_PASSWORD || password !== env.ADMIN_PASSWORD) return null;
  const salt = randomToken();
  const passwordHash = await hashPassword(password, salt);
  const admin = {
    id: nextUserId(users),
    username: 'admin',
    name: '管理员',
    role: 'admin',
    supplierBrand: '',
    status: 'active',
    passwordHash,
    salt,
    createdAt: new Date().toISOString(),
  };
  users.push(admin);
  await saveUsers(env, users);
  return admin;
}

async function authUser(request, env) {
  const token = (request.headers.get('x-admin-token') || '').trim();
  if (!token) return null;
  const session = await env.KV.get(`sessions:${token}`, 'json');
  if (!session || !session.userId) return null;
  const users = await getUsers(env);
  const user = users.find((u) => u.id === session.userId && u.status !== 'disabled');
  return user || null;
}

async function can(env, user, perm) {
  if (!user) return false;
  const map = await getRoles(env);
  const role = map[user.role];
  const perms = rolePermissions(role);
  return perms.includes('*') || perms.includes(perm);
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// KV 无 CAS：同毫秒并发新增会算出同一个 seq，「先查后写」挡不住互相覆盖。
// 故 id 追加 4 位随机后缀——seq 前缀保留可读性，排序仍以 seq 字段为准。
function makeProductId(seq) {
  const rnd = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `p${String(seq).padStart(2, '0')}-${rnd}`;
}

function nextId(products) {
  const maxSeq = products.reduce((m, p) => Math.max(m, p.seq || 0), 0);
  const seq = maxSeq + 1;
  return { id: makeProductId(seq), seq };
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

// 分类名规范化：多级路径（→ / > / | 等分隔）取末级，避免「米面粮油→食用油→葵花籽油」整串入库；
// 与品牌同名视为品牌误当分类，置「未分类」；去空白并限长 20 字（与配置分类上限一致）
function normalizeCategory(raw, brand) {
  let c = String(raw || '').trim();
  if (!c) return '未分类';
  // 多级路径（→/➜/>/｜/|/、）取首级分类，避免杂糅分类名
  const parts = c.split(/[→➜>｜|/、]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) c = parts[0];
  if (c.length > 20) c = c.slice(0, 20);
  const b = String(brand || '').trim();
  if (b && c === b) return '未分类';
  return c || '未分类';
}

function sanitizeProduct(raw) {
  const p = {};
  for (const f of PRODUCT_FIELDS) p[f] = String(raw[f] ?? '').trim();
  p.image = (raw.image || '').trim();
  p.status = raw.status === '下架' ? '下架' : '上架';
  p.category = normalizeCategory(p.category, p.brand);
  return p;
}

// 布局约定：products:{id} 为权威数据源，products 仅为读取加速用的索引数组。
// KV 无事务、无 CAS：若写索引时直接用请求开头读到的旧数组覆盖，会静默吞掉并发写入
// （两人同改不同商品，后写者把先写者的改动抹掉）。故所有写路径统一：
//   先落单条 products:{id} → 再从单条重建索引。索引永远是单条的真实投影。
async function rebuildProductsIndex(env) {
  const raw = await env.KV.get('products', 'json');
  const fromIndex = Array.isArray(raw) ? raw : [];
  const byId = new Map();
  const list = await env.KV.list({ prefix: 'products:' });
  for (const k of list.keys) {
    const id = k.name.slice('products:'.length);
    const p = await env.KV.get(k.name, 'json');
    if (p && typeof p === 'object') byId.set(p.id || id, { ...p, id: p.id || id });
  }
  // 兼容历史数据：索引里有、单条缺失的商品先补写单条，避免重建时把商品弄丢
  for (const p of fromIndex) {
    if (p && p.id && !byId.has(p.id)) {
      byId.set(p.id, p);
      await env.KV.put(`products:${p.id}`, JSON.stringify(p));
    }
  }
  const merged = Array.from(byId.values()).sort(
    (a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || String(a.id).localeCompare(String(b.id))
  );
  await env.KV.put('products', JSON.stringify(merged));
  return merged;
}

// 单条写入：只碰自己的 key，不碰索引（并发安全）
async function saveProduct(env, item) {
  await env.KV.put(`products:${item.id}`, JSON.stringify(item));
}

/* ================= 订单 / 客户 / 品牌档案 ================= */

const ORDER_STATUS = {
  pending: { label: '待确认支付', next: ['paid', 'cancelled'] },
  paid: { label: '已支付待发货', next: ['shipped', 'cancelled'] },
  shipped: { label: '已发货', next: ['done'] },
  done: { label: '已完成', next: [] },
  cancelled: { label: '已取消', next: [] },
};

function genOrderIdTs(d) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(d.getFullYear() % 100)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// 订单号必须唯一：KV 无事务无 CAS，重复 id 会直接覆盖已有订单（静默丢单）。
// 并发场景下「先查后写」并不能真正防撞（两个请求可能同时查到空），故随机空间必须足够大：
// 4 字节 = 2^32 空间，同分钟 50 单的碰撞概率约 3e-7；查重只作为兜底。
async function genOrderId(env) {
  const ts = genOrderIdTs(new Date());
  for (let i = 0; i < 3; i += 1) {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    const rnd = [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    const id = `D${ts}${rnd}`;
    if (!(await env.KV.get(`orders:${id}`))) return id;
  }
  const rnd = [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  return `D${ts}${rnd}`;
}

function sanitizeOrder(raw) {
  const name = String(raw.customer_name || '').trim().slice(0, 40);
  const phone = String(raw.customer_phone || '').trim().slice(0, 20);
  const remark = String(raw.remark || '').trim().slice(0, 200);
  const items = Array.isArray(raw.items)
    ? raw.items.slice(0, 30).map((it) => ({
        id: String(it.id || '').slice(0, 40),
        name: String(it.name || '').slice(0, 80),
        spec: String(it.spec || '').slice(0, 60),
        price: String(it.price || '').slice(0, 40),
        moq: String(it.moq || '').slice(0, 40),
        qty: Math.max(1, parseInt(it.qty, 10) || 1),
        image: String(it.image || '').slice(0, 300),
      }))
    : [];
  return { customer_name: name, customer_phone: phone, remark, items };
}

// ---- 金额：价格可能是 "50元/箱" 这类带单位字符串，统一解析为数值 ----
function parseMoneyNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v === undefined || v === null ? '' : v).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}
function orderTotals(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const total_qty = items.reduce((s, it) => s + (parseInt(it && it.qty, 10) || 0), 0);
  const total_amount = Math.round(items.reduce((s, it) => s + parseMoneyNum(it && it.price) * (parseInt(it && it.qty, 10) || 0), 0) * 100) / 100;
  return { total_qty, total_amount };
}
function withOrderTotals(order) {
  return { ...order, ...orderTotals(order) };
}

async function getOrders(env) {
  const list = await env.KV.list({ prefix: 'orders:' });
  const out = [];
  for (const k of list.keys) {
    const o = await env.KV.get(k.name, 'json');
    if (o) out.push(withOrderTotals(o));
  }
  return out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

async function saveOrder(env, order) {
  await env.KV.put(`orders:${order.id}`, JSON.stringify(order));
}

// 客户档案：按手机号聚合（无独立写接口，下单/后台变更时 upsert）
// 幂等重算：以已落库订单独占为准重新聚合，天然幂等。旧实现用 += 增量累加，
// 并发下单必然丢更新，且错误会永久沉淀在 customers 记录里。
async function aggregateCustomer(env, phone, keys) {
  let agg = null;
  for (const name of keys) {
    const o = await env.KV.get(name, 'json');
    if (!o || String(o.customer_phone || '').trim() !== phone) continue;
    const t = orderTotals(o);
    if (!agg) {
      agg = { phone, name: o.customer_name || '', order_count: 0, total_items: 0, total_qty: 0, total_amount: 0, last_order_at: '', last_order_id: '' };
    }
    agg.order_count += 1;
    agg.total_items += (o.items || []).length;
    agg.total_qty += t.total_qty;
    agg.total_amount = Math.round((agg.total_amount + t.total_amount) * 100) / 100;
    const at = String(o.created_at || '');
    if (at >= String(agg.last_order_at || '')) {
      agg.last_order_at = at;
      agg.last_order_id = o.id;
      agg.name = o.customer_name || agg.name;
    }
  }
  return agg;
}

async function recomputeOneCustomer(env, phone) {
  const p = String(phone || '').trim();
  if (!p) return null;
  let agg = null;
  // 纯重算仍是「读—算—写」，并发下单时会互相写回较旧的聚合结果。
  // 因此写完再核一次订单集合，若期间有新订单就再算一轮，让记录尽快收敛到真实值。
  for (let round = 0; round < 2; round += 1) {
    const before = (await env.KV.list({ prefix: 'orders:' })).keys.map((k) => k.name).sort();
    agg = await aggregateCustomer(env, p, before);
    if (!agg) return null;
    await env.KV.put(`customers:${p}`, JSON.stringify(agg));
    const after = (await env.KV.list({ prefix: 'orders:' })).keys.map((k) => k.name).sort();
    if (after.join(',') === before.join(',')) return agg;
  }
  return agg;
}

async function upsertCustomer(env, order) {
  return await recomputeOneCustomer(env, order.customer_phone);
}

// 以订单为准重算客户聚合：保证件数/金额准确，且不依赖历史字段
async function recomputeCustomers(env) {
  const base = await getCustomers(env);
  const orders = await getOrders(env);
  const agg = new Map();
  for (const o of orders) {
    const phone = String(o.customer_phone || '').trim();
    if (!phone) continue;
    const cur = agg.get(phone) || { phone, name: '', order_count: 0, total_items: 0, total_qty: 0, total_amount: 0, last_order_at: '', last_order_id: '' };
    cur.order_count += 1;
    cur.total_items += (o.items || []).length;
    cur.total_qty += o.total_qty || 0;
    cur.total_amount = Math.round((cur.total_amount + (o.total_amount || 0)) * 100) / 100;
    if (!cur.name) cur.name = o.customer_name || '';
    const at = String(o.created_at || '');
    if (at >= String(cur.last_order_at || '')) { cur.last_order_at = at; cur.last_order_id = o.id; cur.name = o.customer_name || cur.name; }
    agg.set(phone, cur);
  }
  // 合并仅存在于 customers: 记录（尚无订单）的客户
  for (const c of base) {
    if (!c || !c.phone || agg.has(c.phone)) continue;
    agg.set(c.phone, { ...c, total_qty: c.total_qty || c.total_items || 0, total_amount: c.total_amount || 0 });
  }
  return Array.from(agg.values()).sort((a, b) => String(b.last_order_at || '').localeCompare(String(a.last_order_at || '')));
}

async function getCustomers(env) {
  const list = await env.KV.list({ prefix: 'customers:' });
  const out = [];
  for (const k of list.keys) {
    const c = await env.KV.get(k.name, 'json');
    if (c) out.push(c);
  }
  return out.sort((a, b) => String(b.last_order_at || '').localeCompare(String(a.last_order_at || '')));
}

// 品牌档案：brand:profile:{key}（key=品牌名）
const BRAND_PROFILE_FIELDS = ['intro', 'services', 'certs', 'contact'];
function sanitizeBrandProfile(raw) {
  const out = { certs: [] };
  out.name = String(raw.name || '').trim().slice(0, 60);
  for (const f of ['intro', 'services', 'contact']) out[f] = String(raw[f] || '').trim().slice(0, 3000);
  const certs = Array.isArray(raw.certs) ? raw.certs : [];
  out.certs = certs.map((c) => String(c || '').trim().slice(0, 300)).filter((c) => c.startsWith('/img/') || c.startsWith('http'));
  return out;
}

// 品牌名可能含中文：KV key 统一用 encodeURIComponent 存 ASCII，避免本地/边缘对非 ASCII key 的 list/get 不一致
const BRAND_PROFILE_PREFIX = 'brand:profile:';
function brandProfileKvKey(key) {
  return `${BRAND_PROFILE_PREFIX}${encodeURIComponent(String(key || ''))}`;
}
function brandProfileKeyFromListName(name) {
  const raw = String(name || '').slice(BRAND_PROFILE_PREFIX.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

async function getBrandProfile(env, key) {
  if (!key) return null;
  const hit = await env.KV.get(brandProfileKvKey(key), 'json');
  if (hit) return hit;
  // 兼容历史写入的原始（非编码）key
  return await env.KV.get(`${BRAND_PROFILE_PREFIX}${key}`, 'json');
}

async function getBrandProfiles(env) {
  const list = await env.KV.list({ prefix: BRAND_PROFILE_PREFIX });
  const seen = new Set();
  const out = [];
  for (const k of list.keys) {
    const key = brandProfileKeyFromListName(k.name);
    if (!key || seen.has(key)) continue;
    const p = (await getBrandProfile(env, key)) || (await env.KV.get(k.name, 'json'));
    if (!p) continue;
    seen.add(key);
    out.push({ ...p, key: p.key || key });
  }
  return out.sort((a, b) => String(a.key || '').localeCompare(String(b.key || ''), 'zh'));
}

async function saveBrandProfile(env, profile) {
  await env.KV.put(brandProfileKvKey(profile.key), JSON.stringify(profile));
  const legacy = `${BRAND_PROFILE_PREFIX}${profile.key}`;
  if (legacy !== brandProfileKvKey(profile.key) && (await env.KV.get(legacy))) {
    await env.KV.delete(legacy);
  }
}

async function deleteBrandProfile(env, key) {
  await env.KV.delete(brandProfileKvKey(key));
  const legacy = `${BRAND_PROFILE_PREFIX}${key}`;
  if (legacy !== brandProfileKvKey(key)) await env.KV.delete(legacy);
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  const products = await getProducts(env);
  const onShelf = products.filter((p) => p.status !== '下架');

  // ---- 登录 / 会话 / 当前用户 ----
  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request);
    if (!body || !String(body.username || '').trim() || !String(body.password || '')) {
      return json({ error: 'bad_request', message: '用户名和密码必填' }, 400);
    }
    const username = String(body.username).trim();
    const password = String(body.password);
    const users = await getUsers(env);
    const migrated = await ensureAdminUser(env, users, username, password);
    let user = migrated || users.find((u) => u.username === username && u.status !== 'disabled');
    if (!user) return unauthorized('用户名或密码错误');
    const hash = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return unauthorized('用户名或密码错误');
    const token = randomToken();
    await env.KV.put(`sessions:${token}`, JSON.stringify({ userId: user.id }), { expirationTtl: SESSION_TTL });
    user.lastLoginAt = new Date().toISOString();
    await saveUsers(env, users);
    return json({ ok: true, token, user: await publicUserWithPerms(env, user) });
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    const token = (request.headers.get('x-admin-token') || '').trim();
    if (token) await env.KV.delete(`sessions:${token}`);
    return json({ ok: true });
  }

  if (path === '/api/auth/me') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (method === 'GET') return json({ ok: true, user: await publicUserWithPerms(env, user) });
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request' }, 400);
      if (body.name !== undefined) user.name = String(body.name).trim().slice(0, 20);
      if (body.newPassword) {
        if (!body.oldPassword) return json({ error: 'bad_request', message: '请输入当前密码' }, 400);
        const oldHash = await hashPassword(String(body.oldPassword), user.salt);
        if (oldHash !== user.passwordHash) return json({ error: 'bad_request', message: '当前密码不正确' }, 400);
        const pwd = String(body.newPassword);
        if (pwd.length < 6) return json({ error: 'bad_request', message: '新密码至少 6 位' }, 400);
        user.salt = randomToken();
        user.passwordHash = await hashPassword(pwd, user.salt);
      }
      const uidx = (await getUsers(env)).findIndex((u) => u.id === user.id);
      if (uidx >= 0) {
        const users = await getUsers(env);
        users[uidx] = user;
        await saveUsers(env, users);
      }
      return json({ ok: true, user: await publicUserWithPerms(env, user) });
    }
    return notFound();
  }

  // ---- 账号管理（仅 admin） ----
  if (path === '/api/admin/users' && method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'users:manage')) return forbidden();
    const list = await Promise.all((await getUsers(env)).map((u) => publicUserWithPerms(env, u)));
    return jsonNoCache(list);
  }

  if (path === '/api/admin/users' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'users:manage')) return forbidden();
    const body = await readJson(request);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    const name = String(body?.name || '').trim();
    const roleMap = await getRoles(env);
    const role = roleMap[String(body?.role || '')] ? String(body.role) : 'ops';
    if (!username || !password) return json({ error: 'bad_request', message: '用户名和密码必填' }, 400);
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return json({ error: 'bad_request', message: '用户名需 2-20 位字母/数字/下划线' }, 400);
    if (password.length < 6) return json({ error: 'bad_request', message: '密码至少 6 位' }, 400);
    const users = await getUsers(env);
    if (users.some((u) => u.username === username)) return json({ error: 'duplicated', message: '用户名已存在' }, 400);
    const supplierBrand = role === 'supplier' ? String(body?.supplierBrand || '').trim() : '';
    if (role === 'supplier' && !supplierBrand) return json({ error: 'bad_request', message: '供应商账号需绑定品牌' }, 400);
    const salt = randomToken();
    const passwordHash = await hashPassword(password, salt);
    const nu = {
      id: nextUserId(users),
      username,
      name: name || username,
      role,
      supplierBrand,
      status: 'active',
      passwordHash,
      salt,
      createdAt: new Date().toISOString(),
    };
    users.push(nu);
    await saveUsers(env, users);
    return json({ ok: true, user: await publicUserWithPerms(env, nu) }, 201);
  }

  // /api/admin/users/:id
  const um = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (um) {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'users:manage')) return forbidden();
    const users = await getUsers(env);
    const idx = users.findIndex((u) => u.id === um[1]);
    if (idx === -1) return notFound();
    const target = users[idx];
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request' }, 400);
      if (body.name !== undefined) target.name = String(body.name).trim().slice(0, 20);
      const roleMap = await getRoles(env);
      if (body.role !== undefined && roleMap[String(body.role)]) {
        target.role = body.role;
        if (body.role === 'supplier') {
          const sb = String((body.supplierBrand ?? target.supplierBrand) || '').trim();
          if (!sb) return json({ error: 'bad_request', message: '供应商账号需绑定品牌' }, 400);
          target.supplierBrand = sb;
        } else {
          target.supplierBrand = '';
        }
      } else if (body.supplierBrand !== undefined && target.role === 'supplier') {
        const sb = String(body.supplierBrand || '').trim();
        if (!sb) return json({ error: 'bad_request', message: '供应商账号需绑定品牌' }, 400);
        target.supplierBrand = sb;
      }
      if (body.password) {
        if (String(body.password).length < 6) return json({ error: 'bad_request', message: '密码至少 6 位' }, 400);
        target.salt = randomToken();
        target.passwordHash = await hashPassword(String(body.password), target.salt);
      }
      if (body.status !== undefined) {
        if (body.status === 'disabled') {
          if (target.id === user.id) return json({ error: 'bad_request', message: '不能停用当前登录账号' }, 400);
          const admins = users.filter((u) => u.role === 'admin' && u.status !== 'disabled');
          if (target.role === 'admin' && admins.length <= 1) return json({ error: 'bad_request', message: '至少保留一个启用中的管理员' }, 400);
        }
        target.status = body.status === 'active' ? 'active' : 'disabled';
      }
      users[idx] = target;
      await saveUsers(env, users);
      return json({ ok: true, user: await publicUserWithPerms(env, target) });
    }
    if (method === 'DELETE') {
      if (target.id === user.id) return json({ error: 'bad_request', message: '不能删除当前登录账号' }, 400);
      const admins = users.filter((u) => u.role === 'admin' && u.status !== 'disabled');
      if (target.role === 'admin' && admins.length <= 1) return json({ error: 'bad_request', message: '至少保留一个管理员' }, 400);
      users.splice(idx, 1);
      await saveUsers(env, users);
      return json({ ok: true, id: target.id });
    }
    return notFound();
  }

  // ---- 角色管理（roles:manage 权限） ----
  if (path === '/api/admin/roles') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'roles:manage')) return forbidden();
    const map = await getRoles(env);
    const users = await getUsers(env);
    if (method === 'GET') {
      const list = Object.values(map)
        .map((r) => ({ ...r, userCount: users.filter((u) => u.role === r.key).length }))
        .sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.key.localeCompare(b.key));
      return jsonNoCache({ ok: true, roles: list, perms: PERM_DEFS });
    }
    if (method === 'POST') {
      const body = await readJson(request);
      const key = String(body?.key || '').trim().toLowerCase();
      const name = String(body?.name || '').trim();
      if (!/^[a-z0-9_]{2,20}$/.test(key)) return json({ error: 'bad_request', message: '角色标识需 2-20 位小写字母/数字/下划线' }, 400);
      if (!name) return json({ error: 'bad_request', message: '角色名称必填' }, 400);
      if (map[key]) return json({ error: 'duplicated', message: '角色标识已存在' }, 400);
      const permissions = (Array.isArray(body?.permissions) ? body.permissions : []).filter((p) => PERM_DEFS[p]);
      map[key] = { key, name, builtin: false, permissions };
      await saveRoles(env, map);
      return json({ ok: true, role: { key, name, builtin: false, permissions, userCount: 0 } }, 201);
    }
    return notFound();
  }

  // /api/admin/roles/:key
  const rm = path.match(/^\/api\/admin\/roles\/([^/]+)$/);
  if (rm) {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'roles:manage')) return forbidden();
    const map = await getRoles(env);
    const key = rm[1];
    const role = map[key];
    if (!role) return notFound();
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request' }, 400);
      if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return json({ error: 'bad_request', message: '角色名称必填' }, 400);
        role.name = name;
      }
      if (body.permissions !== undefined) {
        if (!Array.isArray(body.permissions)) return json({ error: 'bad_request', message: 'permissions 必须是数组' }, 400);
        const perms = body.permissions.filter((p) => PERM_DEFS[p] || p === '*');
        role.permissions = perms;
      }
      if (role.builtin) {
        // 内置角色允许调权限，但保持原 key / builtin 标志
        map[key] = { ...BUILTIN_ROLES[key], name: role.name, permissions: role.permissions };
      } else {
        map[key] = role;
      }
      await saveRoles(env, map);
      const users = await getUsers(env);
      return json({ ok: true, role: { ...map[key], userCount: users.filter((u) => u.role === key).length } });
    }
    if (method === 'DELETE') {
      if (role.builtin) return json({ error: 'bad_request', message: '内置角色不可删除' }, 400);
      const users = await getUsers(env);
      if (users.some((u) => u.role === key)) return json({ error: 'bad_request', message: '该角色已被账号使用，请先调整账号角色' }, 400);
      delete map[key];
      await saveRoles(env, map);
      return json({ ok: true, id: key });
    }
    return notFound();
  }

  // GET /api/admin/products：后台全量列表（含下架）
  if (path === '/api/admin/products' && method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (user.role === 'supplier') {
      return json(products.filter((p) => p.brand === user.supplierBrand));
    }
    return json(products);
  }

  // 分类配置管理：GET 返回配置分类与产品自动发现分类；POST 新增配置分类
  if (path === '/api/admin/categories') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'categories:write')) return forbidden();
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
      if (!name) return json({ error: 'bad_request', message: '新分类名必填' }, 400);
      if (name.length > 20) return json({ error: 'bad_request', message: '分类名称过长（≤20字）' }, 400);
      const isConfigured = configured.includes(old);
      if (isConfigured && name !== old && configured.includes(name)) {
        return json({ error: 'duplicated', message: '目标分类名已存在' }, 400);
      }
      // 自动发现分类（extra）重命名：同步改产品分类，新名自动纳入配置分类（可编辑）
      const changed = products.filter((p) => p.category === old);
      if (!isConfigured && changed.length === 0) return json({ error: 'not_found', message: '分类不存在' }, 404);
      let next = isConfigured ? configured.map((c) => (c === old ? name : c)) : configured;
      if (!next.includes(name)) next = [...next, name];
      await env.KV.put('config:categories', JSON.stringify(next));
      let renamed = 0;
      if (changed.length) {
        for (const p of changed) p.category = name;
        for (const p of changed) await env.KV.put(`products:${p.id}`, JSON.stringify(p));
        await rebuildProductsIndex(env);
        renamed = changed.length;
      }
      return jsonNoCache({ ok: true, categories: next, renamed });
    }
    if (method === 'DELETE') {
      const raw = await readJson(request);
      const name = String(raw?.name || '').trim();
      if (!name) return json({ error: 'bad_request', message: '分类名必填' }, 400);
      const isConfigured = configured.includes(name);
      const used = products.filter((p) => p.category === name);
      if (!isConfigured && used.length === 0) return json({ error: 'not_found', message: '分类不存在' }, 404);
      if (isConfigured) {
        // 配置分类：仅移除配置（保持原设计，产品分类保留并自动出现在自动发现区）
        const next = configured.filter((c) => c !== name);
        await env.KV.put('config:categories', JSON.stringify(next));
        return jsonNoCache({ ok: true, categories: next, removed: 0 });
      }
      // 自动发现分类（extra）：同步清理产品分类，避免删除后重新聚合出现
      for (const p of used) p.category = '未分类';
      for (const p of used) await env.KV.put(`products:${p.id}`, JSON.stringify(p));
      await rebuildProductsIndex(env);
      return jsonNoCache({ ok: true, categories: configured, removed: used.length });
    }
    return notFound();
  }

  // GET /api/categories：配置分类 + 产品聚合分类（禁缓存，配置改动立即生效）
  if (path === '/api/categories' && method === 'GET') {
    return jsonNoCache(buildCategories(onShelf, await getConfigCategories(env)));
  }

  // GET /api/brands：产品品牌聚合（按数量降序，禁缓存）
  if (path === '/api/brands' && method === 'GET') {
    const map = new Map();
    for (const p of onShelf) {
      const b = String(p.brand || '').trim();
      if (!b) continue;
      map.set(b, (map.get(b) || 0) + 1);
    }
    const list = [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    return jsonNoCache(list);
  }

  // Hero 站点配置：GET 公共可读（禁缓存，保证后台改配置前端立即生效），PUT 需鉴权
  if (path === '/api/site/hero') {
    if (method === 'GET') return jsonNoCache(await getHero(env));
    if (method === 'PUT') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'site:write')) return forbidden();
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
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'site:write')) return forbidden();
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
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'site:write')) return forbidden();
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
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products:write')) return forbidden();
    const raw = await readJson(request);
    if (!raw || !Array.isArray(raw.ids) || raw.ids.length === 0 || !raw.patch || typeof raw.patch !== 'object') {
      return json({ error: 'bad_request', message: 'ids 数组与 patch 对象必填' }, 400);
    }
    const patchKeys = Object.keys(raw.patch).filter((k) => PRODUCT_FIELDS.includes(k) || k === 'status');
    if (patchKeys.length === 0) {
      return json({ error: 'bad_request', message: 'patch 中无有效字段' }, 400);
    }
    let ids = raw.ids;
    if (user.role === 'supplier') {
      const owned = new Set(products.filter((p) => p.brand === user.supplierBrand).map((p) => p.id));
      ids = ids.filter((id) => owned.has(id));
    }
    const idSet = new Set(ids);
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
      for (const item of changed) {
        await env.KV.put(`products:${item.id}`, JSON.stringify(item));
      }
      await rebuildProductsIndex(env);
    }
    return json({ ok: true, updated });
  }

  // 维护：POST /api/admin/products/rebuild-index —— 从单条 products:{id} 重建索引（自愈手段）
  if (path === '/api/admin/products/rebuild-index' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products:write')) return forbidden();
    const list = await rebuildProductsIndex(env);
    return json({ ok: true, total: list.length });
  }

  // 批量导入：POST /api/admin/products/import
  // body: { products: [ {...产品字段}, ... ] }
  // 按 name+brand upsert：已存在则仅合并传入字段，不存在则新增；逐行校验，失败行跳过不中断
  if (path === '/api/admin/products/import' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products:write')) return forbidden();
    const raw = await readJson(request);
    if (!raw || !Array.isArray(raw.products)) {
      return json({ error: 'bad_request', message: 'products 数组必填' }, 400);
    }
    // 以单条权威数据重建后的最新索引为基准做 upsert，避免拿陈旧快照判重
    const latestProducts = await rebuildProductsIndex(env);
    const IMPORT_FIELDS = [...PRODUCT_FIELDS, 'image'];
    const imported = [];
    const updated = [];
    const errors = [];
    const upsert = new Map(latestProducts.map((p, idx) => [`${p.name}\u0000${p.brand || ''}`, { item: p, idx }]));
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
      const brand = String(user.role === 'supplier' ? user.supplierBrand : (row.brand || '')).trim();
      const key = `${name}\u0000${brand}`;
      const hit = upsert.get(key);
      if (hit) {
        const merged = { ...hit.item };
        for (const f of IMPORT_FIELDS) {
          if (row[f] !== undefined && row[f] !== null) {
            if (f === 'image') merged.image = String(row.image).trim();
            else if (f === 'status') merged.status = row.status === '下架' ? '下架' : '上架';
            else if (f === 'category') merged.category = normalizeCategory(row[f], merged.brand);
            else merged[f] = String(row[f]).trim();
          }
        }
        if (!merged.category) merged.category = '未分类';
        updated.push({ merged, idx: hit.idx });
      } else {
        if (seqCursor === null) seqCursor = nextId(latestProducts);
        else {
          seqCursor.seq += 1;
          seqCursor.id = makeProductId(seqCursor.seq);
        }
        // 占用检查：并发导入/新增撞到同一 id 时顺延，避免覆盖已有商品单条
        for (let guard = 0; guard < 20 && await env.KV.get(`products:${seqCursor.id}`); guard++) {
          seqCursor.seq += 1;
          seqCursor.id = makeProductId(seqCursor.seq);
        }
        const item = { id: seqCursor.id, seq: seqCursor.seq, ...sanitizeProduct(row) };
        imported.push(item);
        upsert.set(key, { item, idx: null });
      }
    }
    if (imported.length) {
      for (const item of imported) await env.KV.put(`products:${item.id}`, JSON.stringify(item));
    }
    if (updated.length) {
      for (const u of updated) await env.KV.put(`products:${u.merged.id}`, JSON.stringify(u.merged));
    }
    // 单条写完后统一重建索引：导入与后台编辑并发时不会相互覆盖
    const latest = (imported.length || updated.length) ? await rebuildProductsIndex(env) : products;
    return json({ ok: true, imported: imported.length, updated: updated.length, errors, total: latest.length });
  }

  /* ---- 下单（公开）---- */
  if (path === '/api/orders' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return json({ error: 'bad_request', message: '请求体无效' }, 400);
    const order = sanitizeOrder(body);
    if (!order.customer_phone || !/^1\d{10}$/.test(order.customer_phone)) {
      return json({ error: 'bad_request', message: '请填写正确的手机号' }, 400);
    }
    if (!order.customer_name) return json({ error: 'bad_request', message: '请填写公司/个人名称' }, 400);
    if (!order.items.length) return json({ error: 'bad_request', message: '购物车为空，无法下单' }, 400);
    {
      // 明细快照以商品库为准：前端只传 id+qty 时也能落全量信息，未知商品直接拒绝
      const byId = new Map(products.map((p) => [p.id, p]));
      const unknown = order.items.filter((it) => !byId.has(it.id));
      if (unknown.length) {
        return json({ error: 'bad_request', message: `商品不存在或已下架：${unknown.map((x) => x.id).join(',')}` }, 400);
      }
      order.items = order.items.map((it) => {
        const p = byId.get(it.id);
        return {
          id: it.id,
          name: it.name || p.name || '',
          spec: it.spec || p.spec || '',
          price: it.price || p.wholesale_price || '',
          moq: it.moq || p.moq || '',
          qty: it.qty,
          image: it.image || p.image || '',
        };
      });
    }
    Object.assign(order, orderTotals(order));
    order.id = await genOrderId(env);
    order.status = 'pending';
    order.version = 1;
    order.created_at = new Date().toISOString();
    order.updated_at = order.created_at;
    await saveOrder(env, order);
    await upsertCustomer(env, order);
    return json({ ok: true, order }, 201);
  }

  /* ---- 查单（公开，POST 避免边缘缓存）---- */
  if (path === '/api/orders/query' && method === 'POST') {
    const body = await readJson(request);
    const phone = String(body?.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) return json({ error: 'bad_request', message: '请填写正确的手机号' }, 400);
    const all = await getOrders(env);
    const mine = all.filter((o) => o.customer_phone === phone);
    const orderId = String(body?.order_id || '').trim();
    const list = orderId ? mine.filter((o) => o.id === orderId) : mine;
    return json({ ok: true, orders: list.slice(0, 50), total: list.length });
  }

  /* ---- 品牌档案（公开）---- */
  if (path === '/api/brands/profile' && method === 'GET') {
    const list = await getBrandProfiles(env);
    const withCount = list.map((p) => ({ ...p, product_count: onShelf.filter((x) => x.brand === p.key).length }));
    return jsonNoCache({ ok: true, brands: withCount });
  }
  {
    const bm = path.match(/^\/api\/brands\/profile\/([^/]+)$/);
    if (bm && method === 'GET') {
      const key = decodeURIComponent(bm[1]);
      const profile = await getBrandProfile(env, key);
      if (!profile) return notFound();
      const products = onShelf.filter((x) => x.brand === key);
      return jsonNoCache({ ok: true, brand: { ...profile, products } });
    }
  }

  /* ---- 后台：订单 ---- */
  if (path === '/api/admin/orders' && method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'orders')) return forbidden();
    const status = String(url.searchParams.get('status') || '').trim();
    const all = await getOrders(env);
    const list = status ? all.filter((o) => o.status === status) : all;
    return jsonNoCache({ ok: true, orders: list, total: list.length });
  }
  {
    const om = path.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
    if (om && method === 'POST') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'orders')) return forbidden();
      const order = await env.KV.get(`orders:${om[1]}`, 'json');
      if (!order) return notFound();
      const body = await readJson(request);
      const next = String(body?.status || '').trim();
      // 乐观并发：前端带上读取时的 version，不一致说明期间有人改过，直接拒绝而不是覆盖
      if (body?.version !== undefined && Number(body.version) !== Number(order.version || 1)) {
        return json({ error: 'conflict', message: '订单已被他人修改，请刷新后重试', order: withOrderTotals(order) }, 409);
      }
      if (!ORDER_STATUS[next] || !ORDER_STATUS[order.status].next.includes(next)) {
        return json({ error: 'bad_request', message: `状态不允许从「${ORDER_STATUS[order.status].label}」流转到该状态` }, 400);
      }
      // KV 无 CAS：写前重读一次，缩小读改写窗口，避免把他人已提交的流转覆盖掉
      const fresh = await env.KV.get(`orders:${om[1]}`, 'json');
      if (!fresh) return notFound();
      if (String(fresh.status) !== String(order.status) || Number(fresh.version || 1) !== Number(order.version || 1)) {
        return json({ error: 'conflict', message: '订单状态刚被他人更新，请刷新后重试' }, 409);
      }
      order.status = next;
      order.version = Number(order.version || 1) + 1;
      if (body?.tracking_no !== undefined) order.tracking_no = String(body.tracking_no).trim().slice(0, 100);
      if (body?.status_note !== undefined) order.status_note = String(body.status_note).trim().slice(0, 200);
      order.updated_at = new Date().toISOString();
      await saveOrder(env, order);
      return json({ ok: true, order: withOrderTotals(order) });
    }
  }
  {
    const om = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (om && method === 'GET') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'orders')) return forbidden();
      const order = await env.KV.get(`orders:${om[1]}`, 'json');
      return order ? jsonNoCache({ ok: true, order: withOrderTotals(order) }) : notFound();
    }
  }

  /* ---- 后台：客户档案 ---- */
  if (path === '/api/admin/customers' && method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'customers')) return forbidden();
    const list = await recomputeCustomers(env);
    return jsonNoCache({ ok: true, customers: list, total: list.length });
  }
  {
    const cm = path.match(/^\/api\/admin\/customers\/([^/]+)$/);
    if (cm && method === 'GET') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'customers')) return forbidden();
      const phone = decodeURIComponent(cm[1]);
      const aggregated = await recomputeCustomers(env);
      const customer = aggregated.find((c) => c.phone === phone) || (await env.KV.get(`customers:${phone}`, 'json'));
      if (!customer) return notFound();
      const all = await getOrders(env);
      const orders = all.filter((o) => o.customer_phone === phone);
      return jsonNoCache({ ok: true, customer, orders });
    }
  }

  /* ---- 后台：品牌档案 ---- */
  if (path === '/api/admin/brands/profile' && method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'brands')) return forbidden();
    const list = await getBrandProfiles(env);
    const withCount = list.map((p) => ({ ...p, product_count: products.filter((x) => x.brand === p.key).length }));
    return jsonNoCache({ ok: true, brands: withCount });
  }
  {
    const bm = path.match(/^\/api\/admin\/brands\/profile\/([^/]+)$/);
    if (bm && (method === 'PUT' || method === 'GET' || method === 'DELETE')) {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'brands')) return forbidden();
      const key = decodeURIComponent(bm[1]).slice(0, 40);
      if (method === 'GET') {
        const profile = await getBrandProfile(env, key);
        if (!profile) return notFound();
        return jsonNoCache({ ok: true, brand: profile });
      }
      if (method === 'DELETE') {
        await deleteBrandProfile(env, key);
        return json({ ok: true });
      }
      const body = await readJson(request);
      const profile = { ...sanitizeBrandProfile(body || {}), key };
      await saveBrandProfile(env, profile);
      return json({ ok: true, brand: profile });
    }
  }

  // /api/products/:id
  const m = path.match(/^\/api\/products\/([^/]+)$/);
  if (m) {
    if (method === 'GET') {
      const p = products.find((x) => x.id === m[1]);
      return p ? json(p) : notFound();
    }
    if (method === 'PUT' || method === 'DELETE') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'products:write')) return forbidden();
      // 写前从单条重建索引，保证不是拿请求开头的陈旧快照去覆盖
      const latest = await rebuildProductsIndex(env);
      const idx = latest.findIndex((x) => x.id === m[1]);
      if (idx === -1) return notFound();
      if (user.role === 'supplier' && latest[idx].brand !== user.supplierBrand) return forbidden();

      if (method === 'PUT') {
        const raw = await readJson(request);
        if (!raw) return json({ error: 'bad_request' }, 400);
        if (user.role === 'supplier') raw.brand = user.supplierBrand;
        const merged = { ...latest[idx], ...sanitizeProduct(raw) };
        await saveProduct(env, merged);
        await rebuildProductsIndex(env);
        return json({ ok: true, product: merged });
      }

      // DELETE：同步删除详情 KV 与关联 R2 图片
      const removed = latest[idx];
      await env.KV.delete(`products:${removed.id}`);
      await rebuildProductsIndex(env);
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
      const brand = url.searchParams.get('brand');
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      let list = onShelf;
      if (category) list = list.filter((p) => p.category === category);
      if (brand) list = list.filter((p) => p.brand === brand);
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
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'products:write')) return forbidden();
      const raw = await readJson(request);
      if (!raw || !String(raw.name || '').trim()) {
        return json({ error: 'bad_request', message: '品名必填' }, 400);
      }
      if (user.role === 'supplier') raw.brand = user.supplierBrand;
      const latest = await rebuildProductsIndex(env);
      // 并发新增时 seq 可能撞车：占用检查后顺延，避免覆盖他人刚建的商品
      let { id, seq } = nextId(latest);
      for (let guard = 0; guard < 20 && await env.KV.get(`products:${id}`); guard++) {
        ({ id, seq } = nextId([...latest, { id, seq }]));
      }
      const item = { id, seq, ...sanitizeProduct(raw) };
      await saveProduct(env, item);
      await rebuildProductsIndex(env);
      return json({ ok: true, product: item }, 201);
    }
    return notFound();
  }

  // POST /api/upload：图片上传（base64 -> R2）
  if (path === '/api/upload') {
    if (method !== 'POST') return notFound();
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'upload')) return forbidden();
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
  // 指纹化 key：URL 唯一、内容不可变 -> 边缘缓存（Cache API）+ 1 年 immutable 强缓存
  // 固定名 key：理论存在覆盖可能 -> 不缓存，直接回源走协商缓存，避免旧图
  const fingerprinted = /[-_][0-9a-z]{6,}\.(jpe?g|png|webp)$/i.test(key);

  if (fingerprinted) {
    const cache = caches.default;
    const cached = await cache.match(new Request(url));
    if (cached) return cached;
    const obj = await env.R2.get(key);
    if (!obj) return new Response('Not Found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    const resp = new Response(obj.body, { headers });
    await cache.put(new Request(url), resp.clone());
    return resp;
  }

  const obj = await env.R2.get(key);
  if (!obj) return new Response('Not Found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  // 固定名 key 保留协商缓存：no-cache + ETag/Last-Modified（writeHttpMetadata 已带），
  // 每次回源 304 校验，避免 R2 对象更新后浏览器仍展示旧图（历史踩坑）
  headers.set('Cache-Control', 'no-cache');
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 自定义域名主站化：页面级 GET 请求命中 workers.dev 时 301 到主站域名，
    // 避免双入口与微信内 workers.dev 访问不稳；API/图片路由不受影响
    const CANONICAL_HOST = 'lightning-shop.gora.dpdns.org';
    if (
      request.method === 'GET' &&
      url.hostname !== CANONICAL_HOST &&
      url.hostname.endsWith('.workers.dev') &&
      !url.pathname.startsWith('/api/') &&
      !url.pathname.startsWith('/img/')
    ) {
      return Response.redirect(`https://${CANONICAL_HOST}${url.pathname}${url.search}`, 301);
    }

    // 只读公开 API 边缘缓存（Cache API 60s）：GET /api/* 非后台接口，无管理 token
    // 缓存副本仅 s-maxage=60：命中时浏览器不缓存（无 max-age），边缘共享缓存 60s 直读
    if (
      url.pathname.startsWith('/api/') &&
      request.method === 'GET' &&
      !url.pathname.startsWith('/api/admin/') &&
      !request.headers.has('x-admin-token')
    ) {
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
      const resp = await handleApi(request, env, url);
      if (resp && resp.status === 200 && (resp.headers.get('Content-Type') || '').includes('application/json')) {
        const cached = resp.clone();
        cached.headers.set('Cache-Control', 's-maxage=60');
        cached.headers.delete('Set-Cookie');
        await cache.put(cacheKey, cached);
      }
      return resp;
    }
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    if (url.pathname.startsWith('/img/')) {
      return handleImage(request, env, url);
    }

    // 静态资源：public/ 目录
    if (env.ASSETS) {
      const resp = await env.ASSETS.fetch(request);
      // 指纹化脚本（index.html 引用带 ?v= 版本号）走一年强缓存，发版时改版本号即可破缓存
      if (url.pathname === '/app.js' || url.pathname === '/qrcode.min.js') {
        const headers = new Headers(resp.headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
      }
      return resp;
    }

    return new Response('Lightning Shop', { status: 200 });
  },
};
