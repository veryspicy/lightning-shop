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
 *   POST /api/admin/d1/migrate    -> KV 数据分批搬迁到 D1（幂等，需 x-admin-token）
 *   GET  /api/admin/d1/verify     -> KV 与 D1 一致性核对（需 x-admin-token）
 *   GET  /img/*                   -> R2 图片代理
 *   其余                           -> 静态资源（public/）
 */

import {
  d1SaveProduct,
  d1DeleteProduct,
  d1SaveOrder,
  d1ProductList,
  d1OrderList,
  d1OrderGet,
  d1CustomerList,
  migrateBatch,
  verifyConsistency,
} from './d1.js';

const CATEGORY_ORDER = ['低GI杂粮', '营养粮油', '黄柿子火锅底料', '野生苦菜', '坚果玉米', '羊杂碎'];

// 阶段 1：商品读路径以 D1 为准。D1 不可用（未绑定/查询异常）时回退 KV，
// 前台绝不能因为库抖动变成空页——读切的前提是可降级。
async function getProducts(env) {
  const rows = await d1ProductList(env);
  if (Array.isArray(rows) && rows.length) return rows;
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

// 站点前后端同源部署，公开接口不需要 CORS 通配。
// 原 `Access-Control-Allow-Origin: *` 让任意第三方页面可读取用户查单结果与商品数据，
// 统一收敛为不返回 ACAO 头（浏览器默认拒绝跨源读取）。
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
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
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 单图上限 5MB

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
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function forbidden() {
  return new Response(JSON.stringify({ error: 'forbidden', message: '无权限执行该操作' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
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

// 单轮 SHA-256 加盐对抗 GPU 离线爆破防护不足，改为 PBKDF2-SHA256 迭代派生。
// 迭代数取 30000：Workers 单请求 CPU 预算有限，兼顾强度与登录/改密响应耗时。
const PBKDF2_ITER = 30000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(String(salt)), iterations: PBKDF2_ITER, hash: 'SHA-256' },
    key,
    256
  );
  return `pbkdf2$${PBKDF2_ITER}$${toHex(bits)}`;
}

// 存量口令为无前缀的「单轮 SHA-256(salt:password)」，仅在验证时沿用，登录成功后自动升级
async function legacyHashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

function isLegacyHash(stored) {
  const s = String(stored || '');
  return !!s && !s.startsWith('pbkdf2$');
}

// 定长比较：先派生再逐字符异或，避免早退比较泄露前缀匹配长度
function timingSafeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, user) {
  const stored = String((user && user.passwordHash) || '');
  if (!stored) return false;
  const salt = String((user && user.salt) || '');
  if (isLegacyHash(stored)) return timingSafeEqual(await legacyHashPassword(password, salt), stored);
  return timingSafeEqual(await hashPassword(password, salt), stored);
}

// 口令强度：≥8 位，且至少包含「小写/大写/数字/符号」中的两类
function passwordIssue(pwd) {
  const s = String(pwd === undefined || pwd === null ? '' : pwd);
  if (s.length < 8) return '密码至少 8 位';
  if (s.length > 72) return '密码最长 72 位';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(s)).length;
  if (kinds < 2) return '密码需包含字母、数字、符号中至少两类';
  if (/^(.)\1+$/.test(s)) return '密码不能是单一字符重复';
  if (/^(?:12345678|password|admin123|qwertyui)$/i.test(s)) return '密码过于常见';
  return '';
}

/* ---- 轻量限流 ----
 * Worker 无进程内全局状态、KV 写入有配额成本，故窗口计数放 isolate 内存：
 * 同一 colo 内可精确拦截脚本爆破/遍历；跨 isolate 为近似保护。
 * 目标是把「手机号遍历查单」「口令爆破」「下单灌库」从零成本提升为有成本。
 */
const RATE_BUCKETS = new Map();

function clientIp(request) {
  const h = request.headers;
  return String(h.get('cf-connecting-ip') || h.get('x-real-ip') || h.get('x-forwarded-for') || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 64) || 'unknown';
}

function rateLimit(scope, key, limit, windowSec) {
  const now = Date.now();
  const k = `${scope}:${key}`;
  const cur = RATE_BUCKETS.get(k);
  if (!cur || cur.reset <= now) {
    // 防内存膨胀：清理过期桶，仍超限则整体重置（限流是近似保护，宁可短时放宽也不 OOM）
    if (RATE_BUCKETS.size > 5000) {
      for (const [kk, vv] of RATE_BUCKETS) if (vv.reset <= now) RATE_BUCKETS.delete(kk);
      if (RATE_BUCKETS.size > 5000) RATE_BUCKETS.clear();
    }
    RATE_BUCKETS.set(k, { count: 1, reset: now + windowSec * 1000 });
    return { ok: true, remaining: limit - 1, retryAfter: 0 };
  }
  cur.count += 1;
  if (cur.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((cur.reset - now) / 1000)) };
  }
  return { ok: true, remaining: limit - cur.count, retryAfter: 0 };
}

/* 限流统一入口：内存桶 + Cloudflare 原生 Rate Limiting binding 双闸。
 * 内存桶零延迟、同 isolate 内精确，负责挡单点突发；binding 按 PoP 计数、跨 isolate 生效，
 * 补内存桶「实例重启即清零、多 isolate 各记各的」的盲区。两闸取严，先撞者生效。
 * binding 未配置（本地降级/账号未开）或调用异常时自动退回纯内存桶，不影响业务。
 */
async function rateLimitGuard(env, scope, key, limit, windowSec, bindingName) {
  const local = rateLimit(scope, key, limit, windowSec);
  if (!local.ok) return local;
  const limiter = bindingName ? env[bindingName] : null;
  if (limiter && typeof limiter.limit === 'function') {
    try {
      const { success } = await limiter.limit({ key: `${scope}:${key}` });
      if (!success) return { ok: false, remaining: 0, retryAfter: 60 };
    } catch {
      // binding 异常不阻断主流程：内存桶已生效，宁可少一层也不误伤正常请求
    }
  }
  return local;
}

/* 账号维度登录闸：Durable Object 单实例，负责「同一账号累计 N 次即拦」。
 * 为什么不用现成的两层：内存桶随 isolate 重启清零、多 isolate 各记各的；
 * 原生 Rate Limiting binding 实测未累计计数（连续 7 次错误登录无拦截）。
 * DO 单实例串行处理、计数落 storage，跨 isolate、跨 PoP 都一致。
 */
export class LoginThrottle {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === '/reset') {
      await this.state.storage.delete('rec');
      return json({ ok: true, count: 0 });
    }
    const body = await request.json().catch(() => ({}));
    const limit = Number(body.limit) || 5;
    const windowMs = Number(body.windowMs) || 300000;
    let rec = await this.state.storage.get('rec');
    if (!rec || rec.reset <= now) rec = { count: 0, reset: now + windowMs };
    rec.count += 1;
    await this.state.storage.put('rec', rec);
    const ok = rec.count <= limit;
    return json({
      ok,
      count: rec.count,
      retryAfter: ok ? 0 : Math.max(1, Math.ceil((rec.reset - now) / 1000)),
    });
  }
}

/* 账号闸统一入口：内存桶（同 isolate 零延迟）+ DO（跨 isolate 准确），取严。 */
async function accountThrottle(env, key, limit, windowSec) {
  const local = rateLimit('login-acct', key, limit, windowSec);
  if (!local.ok) return local;
  const ns = env.LOGIN_THROTTLE;
  if (!ns || typeof ns.idFromName !== 'function') return local;
  try {
    const stub = ns.get(ns.idFromName(key));
    const res = await stub.fetch('https://throttle/check', {
      method: 'POST',
      body: JSON.stringify({ limit, windowMs: windowSec * 1000 }),
    });
    const r = await res.json();
    if (r && r.ok === false) return { ok: false, remaining: 0, retryAfter: r.retryAfter || windowSec };
  } catch {
    // DO 不可用不阻断业务：内存桶仍在挡单点突发
  }
  return local;
}

async function resetAccountThrottle(env, key) {
  RATE_BUCKETS.delete(`login-acct:${key}`);
  const ns = env.LOGIN_THROTTLE;
  if (!ns || typeof ns.idFromName !== 'function') return;
  try {
    const stub = ns.get(ns.idFromName(key));
    await stub.fetch('https://throttle/reset', { method: 'POST' });
  } catch {
    // 清零失败不影响本次登录
  }
}

function tooManyRequests(retryAfter, message = '请求过于频繁，请稍后再试') {
  return new Response(JSON.stringify({ error: 'rate_limited', message }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(retryAfter || 60),
      'Cache-Control': 'no-store',
    },
  });
}

// 畸形百分号编码（/%E0%A4%A）会让 decodeURIComponent 抛 URIError → 整个 Worker 500
function safeDecode(s) {
  try {
    return decodeURIComponent(String(s === undefined || s === null ? '' : s));
  } catch {
    return null;
  }
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
  if (!user) return null;
  // 口令版本比对：改密/重置会自增 pwdVer，此前签发的所有会话即刻失效（KV 无法按用户枚举删 session）
  if (Number(session.ver || 0) !== Number(user.pwdVer || 0)) return null;
  return user;
}

// 权限键归一：存量 KV 自定义角色里可能存着历史带后缀的旧键（products:write / users:manage ...），
// 与 PERM_DEFS 键不一致会导致「后台菜单可见但接口一律 403」。统一映射到 PERM_DEFS 键后再比对。
const PERM_ALIASES = {
  'users:manage': 'users',
  'roles:manage': 'roles',
  'categories:write': 'categories',
  'products:write': 'products',
  upload: 'products',
};
function normPerm(p) {
  const k = String(p === undefined || p === null ? '' : p).trim();
  return PERM_ALIASES[k] || k;
}
// 旧版 site:write 为聚合键，同时管首页/价格/二维码；拆分为 hero/price/qr 后需兼容存量角色
const SITE_PERMS = ['hero', 'price', 'qr'];

async function can(env, user, perm) {
  if (!user) return false;
  const map = await getRoles(env);
  const role = map[user.role];
  const perms = rolePermissions(role).map(normPerm);
  if (perms.includes('*')) return true;
  const want = normPerm(perm);
  if (perms.includes(want)) return true;
  if (SITE_PERMS.includes(want) && perms.includes('site:write')) return true;
  return false;
}

// 图片地址白名单：只放行站内 /img/{安全文件名} 与 http(s) 绝对地址。
// 前端订单明细、后台缩略图都直接把它塞进 <img src>，宽度限制之外的任意串（含 "><script>）一律剥离。
function safeImageUrl(u) {
  const s = String(u === undefined || u === null ? '' : u).trim();
  if (!s || s.length > 300) return '';
  if (/[\u0000-\u001f\u007f"'<>\\]/.test(s)) return '';
  if (/^\/img\/[A-Za-z0-9._-]+$/.test(s) && !s.includes('..')) return s;
  if (/^https?:\/\/[^\s]+$/i.test(s)) return s;
  return '';
}

// 手机号脱敏：公开接口回显一律打码，避免查单结果被截图/转发时泄露完整号码
function maskPhone(p) {
  const s = String(p || '');
  return /^\d{11}$/.test(s) ? `${s.slice(0, 3)}****${s.slice(7)}` : s;
}

// 对外订单投影：成本价（base_price）与内部字段仅后台可见，公开接口一律剔除。
function publicOrder(order) {
  const o = order || {};
  const items = Array.isArray(o.items) ? o.items : [];
  return {
    id: String(o.id || ''),
    status: String(o.status || ''),
    customer_name: String(o.customer_name || ''),
    customer_phone: maskPhone(o.customer_phone),
    remark: String(o.remark || ''),
    tracking_no: String(o.tracking_no || ''),
    status_note: String(o.status_note || ''),
    created_at: o.created_at || '',
    updated_at: o.updated_at || '',
    total_qty: o.total_qty || 0,
    total_amount: o.total_amount || 0,
    items: items.map((it) => ({
      id: String(it.id || ''),
      name: String(it.name || ''),
      spec: String(it.spec || ''),
      price: String(it.price || ''),
      moq: String(it.moq || ''),
      qty: it.qty || 1,
      image: safeImageUrl(it.image),
    })),
  };
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

// 结算加价：下单价也必须按同一策略计算，保证「展示价 = 下单价」，利润不被让掉
// 与前台 public/app.js 的 applyMargin 保持同一口径：含「元」只加成元前数字，纯数字串整体加价，其他文案原样
function applyMarginStr(priceStr, cfg) {
  if (!cfg || !cfg.enabled || !cfg.margin) return priceStr;
  const s = String(priceStr === undefined || priceStr === null ? '' : priceStr);
  if (!s) return s;
  const rate = 1 + cfg.margin / 100;
  const scale = (nums) => nums.replace(/\d+(?:\.\d+)?/g, (m) => String(parseFloat((parseFloat(m) * rate).toFixed(2))));
  if (s.includes('元')) {
    return s.replace(/(\d+(?:\.\d+)?(?:\s*[\/\-]\s*\d+(?:\.\d+)?)*)\s*元/g, (whole, nums) => whole.replace(nums, scale(nums)));
  }
  // 纯价格串（"12"、"12/11.5"）整体加价；含文字且无「元」的属议价说明，原样返回
  if (/^\s*\d+(?:\.\d+)?(\s*[\/\-]\s*\d+(?:\.\d+)?)*\s*$/.test(s)) return scale(s);
  return s;
}

// 公开商品投影：成本价（wholesale_price）只服务后台与供应商，
// 前台一律只下发「加价后的展示价」，价格策略（margin）也不再随公开接口暴露，
// 否则任何人拿到出厂价 × 展示价即可反推成本结构。
function publicProduct(p, priceCfg) {
  const item = p || {};
  return {
    id: String(item.id || ''),
    seq: item.seq || 0,
    name: String(item.name || ''),
    brand: String(item.brand || ''),
    category: String(item.category || ''),
    spec: String(item.spec || ''),
    // price = 出厂价 ×（1+利润率），与下单结算口径完全一致
    price: applyMarginStr(String(item.wholesale_price || ''), priceCfg),
    retail_price: applyMarginStr(String(item.retail_price || ''), priceCfg),
    price_note: String(item.price_note || ''),
    moq: String(item.moq || ''),
    highlights: String(item.highlights || ''),
    storage: String(item.storage || ''),
    shelf_life: String(item.shelf_life || ''),
    cert: String(item.cert || ''),
    badge: String(item.badge || ''),
    image: safeImageUrl(String(item.image || '')),
    status: String(item.status || ''),
  };
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
  p.image = safeImageUrl(String(raw.image || '').trim());
  p.status = raw.status === '下架' ? '下架' : '上架';
  p.category = normalizeCategory(p.category, p.brand);
  return p;
}

// 布局约定：products:{id} 为权威数据源，products 仅为读取加速用的索引数组。
// KV 无事务、无 CAS：若写索引时直接用请求开头读到的旧数组覆盖，会静默吞掉并发写入
// （两人同改不同商品，后写者把先写者的改动抹掉）。故所有写路径统一：
//   先落单条 products:{id} → 再从单条重建索引。索引永远是单条的真实投影。
// 删除墓碑：重建索引的「兼容历史数据」补写会把「索引里有、单条已删」的商品复活，
// 导致删除接口返回成功但商品仍在（删除被静默回滚）。墓碑记录已删 id，补写阶段一律跳过。
async function getDeletedProductIds(env) {
  const raw = await env.KV.get('meta:deletedProducts', 'json');
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}

async function markProductDeleted(env, id) {
  const set = await getDeletedProductIds(env);
  set.add(String(id));
  // 保留最近 500 条即可覆盖重建窗口，避免墓碑无限增长
  await env.KV.put('meta:deletedProducts', JSON.stringify(Array.from(set).slice(-500)));
}

// extraIds：本次刚写入的单条商品 id。KV.list 是弱一致读——写入后立即 list 可能读不到新 key，
// 若索引只以 list 为准，新增/导入的商品会从索引里整体丢失，表现为「后台新增成功、前台一直看不到，
// 直到下一次重建才凭空出现」。对已知 id 用 KV.get 强一致读补进来，可直接消除这个窗口。
async function rebuildProductsIndex(env, extraIds = []) {
  const raw = await env.KV.get('products', 'json');
  const fromIndex = Array.isArray(raw) ? raw : [];
  const deleted = await getDeletedProductIds(env);
  const byId = new Map();
  // KV.list 单页上限 1000，必须翻页，否则商品过千后重建会把后面的商品整批丢掉
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'products:', cursor });
    for (const k of page.keys) {
      const id = k.name.slice('products:'.length);
      const p = await env.KV.get(k.name, 'json');
      if (p && typeof p === 'object') byId.set(p.id || id, { ...p, id: p.id || id });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const rawId of extraIds) {
    const id = String(rawId || '').trim();
    if (!id || deleted.has(id) || byId.has(id)) continue;
    const p = await env.KV.get(`products:${id}`, 'json');
    if (p && typeof p === 'object') byId.set(p.id || id, { ...p, id: p.id || id });
  }
  // 兼容历史数据：索引里有、单条缺失的商品先补写单条，避免重建时把商品弄丢
  // （已删除的 id 有墓碑，不补写，否则删除会被这一步回滚）
  for (const p of fromIndex) {
    if (p && p.id && !byId.has(p.id) && !deleted.has(String(p.id))) {
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
  // 影子双写 D1：KV 仍是读源，D1 累积权威数据，供阶段 1 切换读路径。
  // 失败只记账（d1_dirty），绝不回滚主写。
  await d1SaveProduct(env, item);
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
        qty: Math.min(Math.max(1, parseInt(it.qty, 10) || 1), 9999),
        image: safeImageUrl(String(it.image || '').slice(0, 300)),
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

// 阶段 1：订单读路径切 D1（订单明细一次 IN 查询取回，取代 KV 的 key 全扫 + 逐条 get）。
// D1 异常或无数据时回退 KV，保证后台列表与查单链路不中断。
async function getOrders(env) {
  try {
    const rows = await d1OrderList(env);
    if (Array.isArray(rows) && rows.length) return rows.map(withOrderTotals);
  } catch (_) { /* 回退 KV */ }
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
  // 影子双写 D1：订单是并发冲突最敏感的数据（重号覆盖=静默丢单），
  // D1 主键冲突会直接报错而非静默覆盖，阶段 1 改用 INSERT 语义后彻底消除该风险。
  await d1SaveOrder(env, order);
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
    // 已取消订单不计入消费统计，但保留客户档案（列表可见、金额显示占位）
    if (String(o.status || '') === 'cancelled') continue;
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
    if (!cur.name) cur.name = o.customer_name || '';
    if (String(o.status || '') === 'cancelled') { agg.set(phone, cur); continue; }
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

// 阶段 1：客户档案改由 D1 视图 v_customer_stats 实时聚合（KV 时代的 customers: 聚合记录只是缓存）。
// 视图为空或 D1 异常时回退 KV，兼容尚未迁移的历史环境。
async function getCustomers(env) {
  try {
    const rows = await d1CustomerList(env);
    if (Array.isArray(rows) && rows.length) return rows;
  } catch (_) { /* 回退 KV */ }
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
  // 时间字段由服务端维护：created_at 沿用原值，updated_at 每次保存刷新
  if (raw.created_at) out.created_at = String(raw.created_at).slice(0, 40);
  if (raw.updated_at) out.updated_at = String(raw.updated_at).slice(0, 40);
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
  // 时间字段服务端盖章：历史档案缺 updated_at 时用保存时间补齐，后台「更新时间」列不再为空
  const now = new Date().toISOString();
  const next = { ...profile };
  if (!next.created_at) {
    // created_at 首次写入后不可变：历史档案已归档过就沿用原值
    const prev = await getBrandProfile(env, next.key);
    next.created_at = (prev && prev.created_at) || now;
  }
  next.updated_at = now;
  await env.KV.put(brandProfileKvKey(next.key), JSON.stringify(next));
  const legacy = `${BRAND_PROFILE_PREFIX}${next.key}`;
  if (legacy !== brandProfileKvKey(next.key) && (await env.KV.get(legacy))) {
    await env.KV.delete(legacy);
  }
  return next;
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
    // 登录限流：同 IP 5 分钟 20 次、同 IP+账号 5 分钟 5 次，阻断在线口令爆破
    const ip = clientIp(request);
    const ipLimit = await rateLimitGuard(env, 'login-ip', ip, 20, 300, 'RL_LOGIN');
    if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter, '登录尝试过于频繁，请稍后再试');
    const body = await readJson(request);
    if (!body || !String(body.username || '').trim() || !String(body.password || '')) {
      return json({ error: 'bad_request', message: '用户名和密码必填' }, 400);
    }
    const username = String(body.username).trim();
    const password = String(body.password);
    // 账号闸只按用户名为键，不含 IP：口径是「保护账号」而非「限制来源」。
    // 若把 IP 混进 key，攻击方换 IP 即可让每次请求落在新桶里，闸形同虚设。
    const acctKey = username.toLowerCase();
    const acctLimit = await accountThrottle(env, acctKey, 5, 300);
    if (!acctLimit.ok) return tooManyRequests(acctLimit.retryAfter, '该账号尝试过于频繁，请稍后再试');
    const users = await getUsers(env);
    const migrated = await ensureAdminUser(env, users, username, password);
    let user = migrated || users.find((u) => u.username === username && u.status !== 'disabled');
    if (!user) return unauthorized('用户名或密码错误');
    if (!await verifyPassword(password, user)) return unauthorized('用户名或密码错误');
    // 登录成功即清掉该账号的失败计数，避免本人多次输错后被自己锁在门外
    await resetAccountThrottle(env, acctKey);
    // 存量单轮 SHA-256 口令：验证通过后立即升级为 PBKDF2，旧哈希不再落库
    if (isLegacyHash(user.passwordHash)) {
      user.passwordHash = await hashPassword(password, user.salt);
    }
    const token = randomToken();
    await env.KV.put(
      `sessions:${token}`,
      JSON.stringify({ userId: user.id, ver: Number(user.pwdVer || 0) }),
      { expirationTtl: SESSION_TTL }
    );
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
      let passwordChanged = false;
      if (body.newPassword) {
        if (!body.oldPassword) return json({ error: 'bad_request', message: '请输入当前密码' }, 400);
        if (!await verifyPassword(String(body.oldPassword), user)) {
          return json({ error: 'bad_request', message: '当前密码不正确' }, 400);
        }
        const pwd = String(body.newPassword);
        const issue = passwordIssue(pwd);
        if (issue) return json({ error: 'bad_request', message: issue }, 400);
        if (pwd === String(body.oldPassword)) {
          return json({ error: 'bad_request', message: '新密码不能与当前密码相同' }, 400);
        }
        user.salt = randomToken();
        user.passwordHash = await hashPassword(pwd, user.salt);
        // 口令版本自增：该用户此前签发的全部会话（含当前这把）立即失效
        user.pwdVer = Number(user.pwdVer || 0) + 1;
        passwordChanged = true;
      }
      const uidx = (await getUsers(env)).findIndex((u) => u.id === user.id);
      if (uidx >= 0) {
        const users = await getUsers(env);
        users[uidx] = user;
        await saveUsers(env, users);
      }
      if (passwordChanged) {
        return json({
          ok: true,
          relogin: true,
          message: '密码已更新，其他设备上的登录状态已失效，请重新登录',
        });
      }
      return json({ ok: true, user: await publicUserWithPerms(env, user) });
    }
    return notFound();
  }

  // ---- 账号管理（仅 admin） ----
  if (path === '/api/admin/users' && method === 'GET') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'users')) return forbidden();
    const list = await Promise.all((await getUsers(env)).map((u) => publicUserWithPerms(env, u)));
    return jsonNoCache(list);
  }

  if (path === '/api/admin/users' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'users')) return forbidden();
    const body = await readJson(request);
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');
    const name = String(body?.name || '').trim();
    const roleMap = await getRoles(env);
    // 角色必须命中角色表：原先非法 role 静默回退 ops，等于给一个通用运营账号（含 cost 价与价格策略权限）
    const roleKey = String(body?.role || '');
    const role = roleKey ? (roleMap[roleKey] ? roleKey : '') : 'ops';
    if (!role) return json({ error: 'bad_request', message: '角色不存在' }, 400);
    if (!username || !password) return json({ error: 'bad_request', message: '用户名和密码必填' }, 400);
    if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return json({ error: 'bad_request', message: '用户名需 2-20 位字母/数字/下划线' }, 400);
    const pwdIssue = passwordIssue(password);
    if (pwdIssue) return json({ error: 'bad_request', message: pwdIssue }, 400);
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
    if (!await can(env, user, 'users')) return forbidden();
    const users = await getUsers(env);
    const idx = users.findIndex((u) => u.id === um[1]);
    if (idx === -1) return notFound();
    const target = users[idx];
    if (method === 'PUT') {
      const body = await readJson(request);
      if (!body) return json({ error: 'bad_request' }, 400);
      if (body.name !== undefined) target.name = String(body.name).trim().slice(0, 20);
      const roleMap = await getRoles(env);
      if (body.role !== undefined && !roleMap[String(body.role)]) {
        // 非法角色不再静默忽略：否则管理员以为降权成功、账号仍持原角色权限
        return json({ error: 'bad_request', message: '角色不存在' }, 400);
      }
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
        const issue = passwordIssue(String(body.password));
        if (issue) return json({ error: 'bad_request', message: issue }, 400);
        target.salt = randomToken();
        target.passwordHash = await hashPassword(String(body.password), target.salt);
        // 管理员重置他人口令同样吊销该账号已签发的全部会话
        target.pwdVer = Number(target.pwdVer || 0) + 1;
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
    if (!await can(env, user, 'roles')) return forbidden();
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
    if (!await can(env, user, 'roles')) return forbidden();
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
    // 成本价只对商品管理/价格权限开放：无权限的员工账号不该读到全量成本价
    if (!await can(env, user, 'products') && !await can(env, user, 'price')) return forbidden();
    return json(products);
  }

  // 分类配置管理：GET 返回配置分类与产品自动发现分类；POST 新增配置分类
  if (path === '/api/admin/categories') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'categories')) return forbidden();
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
        // 走 saveProduct：KV 主写 + D1 影子写必须同进，漏一处就会让 D1 与 KV 分叉
        for (const p of changed) await saveProduct(env, p);
        await rebuildProductsIndex(env, changed.map((p) => p.id));
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
      for (const p of used) await saveProduct(env, p);
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
      if (!await can(env, user, 'hero')) return forbidden();
      const raw = await readJson(request);
      if (!raw) return json({ error: 'bad_request' }, 400);
      const hero = await saveHero(env, raw);
      return json({ ok: true, hero });
    }
    return notFound();
  }

  // 价格策略：前台展示价 = 出厂价 × (1 + margin%)，GET 禁缓存，PUT 需鉴权
  if (path === '/api/site/price') {
    if (method === 'GET') {
      // margin 属于内部经营参数：公开可读会被用来「展示价 ÷ (1+margin)」反推出厂成本。
      // 故匿名只回 enabled（前台已不需要自行加价，价格由服务端投影直接给出），
      // 带 price 权限的管理端才回完整策略。
      const price = await getPrice(env);
      const viewer = await authUser(request, env);
      if (viewer && await can(env, viewer, 'price')) return jsonNoCache(price);
      return jsonNoCache({ enabled: !!price.enabled });
    }
    if (method === 'PUT') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'price')) return forbidden();
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
      if (!await can(env, user, 'qr')) return forbidden();
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
    if (!await can(env, user, 'products')) return forbidden();
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
        await saveProduct(env, item);
      }
      await rebuildProductsIndex(env, changed.map((p) => p.id));
    }
    return json({ ok: true, updated });
  }

  // 维护：POST /api/admin/products/rebuild-index —— 从单条 products:{id} 重建索引（自愈手段）
  if (path === '/api/admin/products/rebuild-index' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products')) return forbidden();
    const list = await rebuildProductsIndex(env);
    return json({ ok: true, total: list.length });
  }

  // 批量导入：POST /api/admin/products/import
  // body: { products: [ {...产品字段}, ... ] }
  // 按 name+brand upsert：已存在则仅合并传入字段，不存在则新增；逐行校验，失败行跳过不中断
  if (path === '/api/admin/products/import' && method === 'POST') {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products')) return forbidden();
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
    // 导入也是一条写路径：必须与单条新增/编辑共用 saveProduct，否则 D1 少掉整批商品
    if (imported.length) {
      for (const item of imported) await saveProduct(env, item);
    }
    if (updated.length) {
      for (const u of updated) await saveProduct(env, u.merged);
    }
    // 单条写完后统一重建索引：导入与后台编辑并发时不会相互覆盖
    const touched = [...imported, ...updated.map((u) => u.merged)].map((x) => x.id);
    const latest = (imported.length || updated.length) ? await rebuildProductsIndex(env, touched) : products;
    return json({ ok: true, imported: imported.length, updated: updated.length, errors, total: latest.length });
  }

  /* ---- 下单（公开）---- */
  if (path === '/api/orders' && method === 'POST') {
    // 下单限流：同 IP 1 分钟 10 单、1 小时 60 单，避免匿名接口被脚本灌库撑爆 KV 配额
    const ip = clientIp(request);
    const minLimit = await rateLimitGuard(env, 'order-ip-1m', ip, 10, 60, 'RL_ORDER');
    if (!minLimit.ok) return tooManyRequests(minLimit.retryAfter, '下单过于频繁，请稍后再试');
    const hourLimit = rateLimit('order-ip-1h', ip, 60, 3600);
    if (!hourLimit.ok) return tooManyRequests(hourLimit.retryAfter, '下单过于频繁，请稍后再试');
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
      // 结算价以商品库出厂价 ×（1+利润率）服务端重算：前端传入价格一概不采信，避免改价逃单
      const priceCfg = await getPrice(env);
      const pricedItems = order.items.map((it) => {
        const p = byId.get(it.id);
        const basePrice = String(p.wholesale_price || '');
        return {
          id: it.id,
          // 名称/规格/起订量一律取商品库快照：这几个字段会在前台与后台订单页渲染，
          // 匿名请求体可控会让攻击者伪造商品名/规格去误导其他客户与运营
          name: p.name || '',
          spec: p.spec || '',
          price: basePrice ? applyMarginStr(basePrice, priceCfg) : (it.price || ''),
          base_price: basePrice,
          moq: p.moq || '',
          qty: it.qty,
          // 图片只认商品库并过白名单：匿名下单请求体里的 image 属于外部输入，直接渲染会成存储型 XSS
          image: safeImageUrl(p.image),
        };
      });
      // 商品未维护出厂价时无法重算结算价，若放行会以 0 元成交并污染客户累计/统计，直接拒绝
      const noPrice = pricedItems.filter((x) => !x.price || !(Number(parseMoneyNum(x.price)) > 0));
      if (noPrice.length) {
        return json({ error: 'bad_request', message: `商品价格缺失，暂不可下单：${noPrice.map((x) => x.id).join(',')}` }, 400);
      }
      order.items = pricedItems;
    }
    Object.assign(order, orderTotals(order));
    // 业务上限：普通批发单不会到百万级/数万件，超限视为异常请求直接拒绝，避免脏数据进库与后台统计失真
    if (order.total_amount > 1000000) {
      return json({ error: 'bad_request', message: '单笔金额超出上限，请分批下单或联系业务员' }, 400);
    }
    if (order.total_qty > 50000) {
      return json({ error: 'bad_request', message: '单笔数量超出上限，请分批下单或联系业务员' }, 400);
    }
    order.id = await genOrderId(env);
    order.status = 'pending';
    order.version = 1;
    order.created_at = new Date().toISOString();
    order.updated_at = order.created_at;
    await saveOrder(env, order);
    await upsertCustomer(env, order);
    // 响应走公开投影：下单接口匿名可写，绝不能把 base_price（成本价）回吐给调用方
    return json({ ok: true, order: publicOrder(withOrderTotals(order)) }, 201);
  }

  /* ---- 查单（公开，POST 避免边缘缓存）---- */
  if (path === '/api/orders/query' && method === 'POST') {
    // 查单凭据只有手机号，必须限流，否则可被用于遍历手机号批量拖取订单信息
    const ip = clientIp(request);
    const ipLimit = await rateLimitGuard(env, 'query-ip', ip, 10, 300, 'RL_QUERY');
    if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter, '查询过于频繁，请稍后再试');
    const body = await readJson(request);
    const phone = String(body?.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) return json({ error: 'bad_request', message: '请填写正确的手机号' }, 400);
    const phoneLimit = rateLimit('query-phone', phone, 20, 3600);
    if (!phoneLimit.ok) return tooManyRequests(phoneLimit.retryAfter, '该手机号查询过于频繁，请稍后再试');
    const all = await getOrders(env);
    const mine = all.filter((o) => o.customer_phone === phone);
    const orderId = String(body?.order_id || '').trim();
    const list = orderId ? mine.filter((o) => o.id === orderId) : mine;
    // 查单仅凭手机号即可调用，返回体必须是公开投影，否则任何人可批量拖走成本价
    return json({ ok: true, orders: list.slice(0, 50).map(publicOrder), total: list.length });
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
      const key = safeDecode(bm[1]);
      if (key === null) return json({ error: 'bad_request', message: '请求路径编码无效' }, 400);
      const profile = await getBrandProfile(env, key);
      if (!profile) return notFound();
      // 公开接口只回展示价投影，成本价（wholesale_price）不得随品牌页泄露
      const priceCfg = await getPrice(env);
      const products = onShelf.filter((x) => x.brand === key).map((x) => publicProduct(x, priceCfg));
      return jsonNoCache({ ok: true, brand: { ...profile, products } });
    }
  }

  /* ---- 后台：D1 迁移与一致性核对（阶段 0，仅管理员） ---- */
  if (path.startsWith('/api/admin/d1/')) {
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (user.role !== 'admin') return forbidden();
    if (!env.DB) return json({ error: 'd1_not_bound', message: 'D1 binding DB 未配置' }, 503);
    // 分批搬迁：KV 全量 -> D1（products / orders / order_items / kv_doc）
    // 幂等可重入：靠 migration_state 游标续跑，中途失败重调即继续
    if (path === '/api/admin/d1/migrate' && method === 'POST') {
      const limit = Number(url.searchParams.get('limit') || 100);
      const r = await migrateBatch(env, limit);
      return jsonNoCache({ ok: true, ...r });
    }
    // 一致性核对：KV 与 D1 计数对比 + 抽样主键命中检查 + 影子写脏标记
    if (path === '/api/admin/d1/verify' && method === 'GET') {
      const r = await verifyConsistency(env, Number(url.searchParams.get('sample') || 5));
      return jsonNoCache({ ok: true, ...r });
    }
    return notFound();
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
      // 状态流转会改变订单是否计入客户消费（尤其取消），必须同步重算客户聚合
      await upsertCustomer(env, order);
      return json({ ok: true, order: withOrderTotals(order) });
    }
  }
  {
    const om = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (om && method === 'GET') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'orders')) return forbidden();
      // 阶段 1：单条订单也读 D1；D1 查无或异常（含尚未双写的历史单）时回退 KV
      const order = (await d1OrderGet(env, om[1])) || (await env.KV.get(`orders:${om[1]}`, 'json'));
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
      const phone = safeDecode(cm[1]);
      if (phone === null) return json({ error: 'bad_request', message: '请求路径编码无效' }, 400);
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
      const decodedKey = safeDecode(bm[1]);
      if (decodedKey === null) return json({ error: 'bad_request', message: '请求路径编码无效' }, 400);
      const key = decodedKey.slice(0, 40);
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
      const saved = await saveBrandProfile(env, profile);
      return json({ ok: true, brand: saved });
    }
  }

  // /api/products/:id
  const m = path.match(/^\/api\/products\/([^/]+)$/);
  if (m) {
    if (method === 'GET') {
      const p = products.find((x) => x.id === m[1]);
      if (!p) return notFound();
      // 下架商品对匿名访问一律视为不存在（原先按 id 可直读，等于绕过下架）
      if (p.status === '下架') {
        const viewer = await authUser(request, env);
        if (!viewer || !await can(env, viewer, 'products')) return notFound();
        return json(p);
      }
      const priceCfg = await getPrice(env);
      return json(publicProduct(p, priceCfg));
    }
    if (method === 'PUT' || method === 'DELETE') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'products')) return forbidden();
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
        await rebuildProductsIndex(env, [merged.id]);
        return json({ ok: true, product: merged });
      }

      // DELETE：同步删除详情 KV 与关联 R2 图片
      const removed = latest[idx];
      await env.KV.delete(`products:${removed.id}`);
      await markProductDeleted(env, removed.id);
      await d1DeleteProduct(env, removed.id);
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
      const priceCfg = await getPrice(env);
      const shown = list.map((p) => publicProduct(p, priceCfg));
      if (url.searchParams.has('limit') || url.searchParams.has('offset')) {
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
        const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0);
        return json({ items: shown.slice(offset, offset + limit), total: shown.length, offset, limit });
      }
      return json(shown);
    }
    if (method === 'POST') {
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'products')) return forbidden();
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
      await rebuildProductsIndex(env, [item.id]);
      return json({ ok: true, product: item }, 201);
    }
    return notFound();
  }

  // POST /api/upload：图片上传（base64 -> R2）
  if (path === '/api/upload') {
    if (method !== 'POST') return notFound();
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products')) return forbidden();
    const body = await readJson(request);
    if (!body || !body.filename || !body.base64) {
      return json({ error: 'bad_request', message: 'filename 与 base64 必填' }, 400);
    }
    const filename = String(body.filename).replace(/[^\w.-]/g, '');
    if (!filename) return json({ error: 'bad_request', message: '文件名无效' }, 400);
    // 后缀白名单：原先任意后缀都会落 R2 并被 /img/* 原样回吐（可当免费文件床，也可上传 svg/html 型内容）
    if (!/\.(jpe?g|png|webp|gif)$/i.test(filename)) {
      return json({ error: 'bad_request', message: '仅支持 jpg/jpeg/png/webp/gif 图片' }, 400);
    }
    // 体积上限：base64 长度先做一次廉价预检，避免把超大载荷先 atob 进内存
    const rawB64 = String(body.base64).replace(/^data:[^,]+,/, '');
    if (rawB64.length > UPLOAD_MAX_BYTES * 1.4) {
      return json({ error: 'bad_request', message: `图片不能超过 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB` }, 400);
    }
    let bin;
    try {
      bin = Uint8Array.from(atob(rawB64), (c) => c.charCodeAt(0));
    } catch {
      return json({ error: 'bad_request', message: 'base64 无效' }, 400);
    }
    if (bin.length > UPLOAD_MAX_BYTES) {
      return json({ error: 'bad_request', message: `图片不能超过 ${UPLOAD_MAX_BYTES / 1024 / 1024}MB` }, 400);
    }
    if (!bin.length) return json({ error: 'bad_request', message: '图片内容为空' }, 400);
    // 魔数校验：扩展名随时可改，只认文件头，杜绝把非图片内容伪装成 .png 存进 R2
    const magic = (bytes) => bytes.length >= 4 && bytes.every((b, i) => bin[i] === b);
    const isJpeg = bin[0] === 0xff && bin[1] === 0xd8 && bin[2] === 0xff;
    const isPng = magic([0x89, 0x50, 0x4e, 0x47]);
    const isGif = magic([0x47, 0x49, 0x46, 0x38]);
    const isWebp =
      magic([0x52, 0x49, 0x46, 0x46]) &&
      bin.length > 11 &&
      String.fromCharCode(bin[8], bin[9], bin[10], bin[11]) === 'WEBP';
    if (!isJpeg && !isPng && !isGif && !isWebp) {
      return json({ error: 'bad_request', message: '文件内容不是有效图片' }, 400);
    }
    // Content-Type 由真实文件头决定，不采信客户端传入的后缀
    const type = isPng
      ? 'image/png'
      : isWebp
        ? 'image/webp'
        : isGif
          ? 'image/gif'
          : 'image/jpeg';
    await env.R2.put(filename, bin, { httpMetadata: { contentType: type } });
    return json({ ok: true, url: `/img/${filename}` });
  }

  return notFound();
}

// 统一安全响应头：给所有响应加 nosniff / 禁外链引用 / 禁被第三方站内嵌，
// 页面类响应再加 CSP（限制脚本与样式来源，降低 XSS 后的可利用面）。
// 注：script-src 暂保留 'unsafe-inline'（前端存在内联初始化片段），先阻断外域脚本加载。
const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

function withSecurityHeaders(resp) {
  if (!resp || !resp.headers) return resp;
  const out = new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: new Headers(resp.headers) });
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('X-Frame-Options', 'DENY');
  out.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  out.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  const ctype = out.headers.get('Content-Type') || '';
  if (ctype.includes('text/html')) out.headers.set('Content-Security-Policy', CSP_POLICY);
  return out;
}

// 公开 API 边缘缓存时长：原 60s，收到 30s 以压低改价/文案变更的可见延迟。
// 下架/删除走 force bump 即时失效，不依赖此 TTL 兜底。
const CACHE_TTL_SEC = 30;
// 公开只读 API 的 Cache-Control：必须同时显式给 max-age。
// 只给 s-maxage 时源站没有 max-age，Cloudflare 会按浏览器缓存默认值补成 max-age=14400（4 小时），
// 结果是边缘 30s 就刷新了，但老访客的浏览器仍按 4 小时缓存旧列表，新增商品迟迟看不到。
const PUBLIC_API_CC = `public, max-age=${CACHE_TTL_SEC}, s-maxage=${CACHE_TTL_SEC}`;

// 公开 API 边缘缓存的版本号：任何写操作成功后 +1，使旧缓存立即失效。
// 只有 60s TTL 而没有失效机制时，商品下架/改价/删除后最长 60s 仍能被匿名读到
// （缓存副本里还是下架前的 200），等于绕过下架与改价。
async function getCacheEpoch(env) {
  try {
    return Number(await env.KV.get('cache:epoch')) || 0;
  } catch {
    return 0;
  }
}

// 普通写操作的 bump 节流窗口：KV 同 key 写入上限是 1 次/秒，批量/脚本循环写会撞限制。
// 窗口取 <= 缓存 TTL，即便本轮被节流跳过，旧副本也会在 TTL 内自然过期，不会放大延迟。
const CACHE_BUMP_THROTTLE_MS = CACHE_TTL_SEC * 1000;
let lastCacheBumpAt = 0;

// force=true 用于下架/删除这类安全敏感写：必须立即失效，不参与节流
async function bumpCacheEpoch(env, force = false) {
  const now = Date.now();
  if (!force && now - lastCacheBumpAt < CACHE_BUMP_THROTTLE_MS) return false;
  lastCacheBumpAt = now;
  try {
    const cur = await getCacheEpoch(env);
    await env.KV.put('cache:epoch', String(cur + 1));
    return true;
  } catch {
    // KV 单 key 有写入频率限制：失败时宁可让旧缓存自然过期，也不能让写操作报错
    return false;
  }
}

// 这些写接口不改变公开数据（登录态 / 订单 / 客户资料 / 图片上传），无需失效公开缓存
const CACHE_BUMP_SKIP_PREFIXES = ['/api/auth/', '/api/orders', '/api/track', '/api/customers', '/api/upload'];

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

    // 只读公开 API 边缘缓存（Cache API，TTL=CACHE_TTL_SEC）：GET /api/* 非后台接口，无管理 token
    // 缓存副本与回源响应都带 max-age=CACHE_TTL_SEC，浏览器与边缘同一个 30s 节奏
    // （只给 s-maxage 时 Cloudflare 会把浏览器 TTL 补成默认 4 小时）
    if (
      url.pathname.startsWith('/api/') &&
      request.method === 'GET' &&
      !url.pathname.startsWith('/api/admin/') &&
      !request.headers.has('x-admin-token')
    ) {
      const cache = caches.default;
      // 缓存 key 带数据版本号：写操作 bump 后 key 变化，旧副本不再命中
      const epoch = await getCacheEpoch(env);
      const cacheUrl = new URL(url.toString());
      cacheUrl.searchParams.set('__epoch', String(epoch));
      const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
      const hit = await cache.match(cacheKey);
      if (hit) {
        const copy = withSecurityHeaders(hit);
        copy.headers.set('Cache-Control', PUBLIC_API_CC);
        return copy;
      }
      const resp = withSecurityHeaders(await handleApi(request, env, url));
      if (resp && resp.status === 200 && (resp.headers.get('Content-Type') || '').includes('application/json')) {
        resp.headers.set('Cache-Control', PUBLIC_API_CC);
        const cached = resp.clone();
        cached.headers.set('Cache-Control', PUBLIC_API_CC);
        cached.headers.delete('Set-Cookie');
        await cache.put(cacheKey, cached);
      }
      return resp;
    }
    if (url.pathname.startsWith('/api/')) {
      const resp = withSecurityHeaders(await handleApi(request, env, url));
      // 写成功即失效公开 API 缓存，避免下架/改价/删除在 TTL 内仍被匿名读到旧数据
      if (
        request.method !== 'GET' &&
        resp.status < 400 &&
        !CACHE_BUMP_SKIP_PREFIXES.some((p) => url.pathname.startsWith(p))
      ) {
        // 安全敏感写必须即时生效：单商品改价/下架与 DELETE 不参与节流。
        // 新增与批量导入同样是「一次请求只 bump 一次」，若不 force 会被上一条写操作的节流窗口吞掉，
        // 导致新商品最长 TTL 内外网不可见（实测约 30s）；逐个 PUT 的高频场景仍走节流限制 KV 写频。
        const isCreate =
          request.method === 'POST' &&
          (url.pathname === '/api/products' || url.pathname === '/api/admin/products/import');
        const force =
          request.method === 'DELETE' || isCreate || /^\/api\/products\/(?!batch$)[^/]+$/.test(url.pathname);
        await bumpCacheEpoch(env, force);
      }
      return resp;
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
        return withSecurityHeaders(
          new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers }),
        );
      }
      return withSecurityHeaders(resp);
    }

    return withSecurityHeaders(new Response('Lightning Shop', { status: 200 }));
  },
};
