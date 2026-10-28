/**
 * Lightning Shop Worker
 * 路由：
 *   GET  /api/products            -> 全部产品（支持 ?category=  ?brand=  ?q= 过滤；自动排除下架）
 *   GET  /api/products/:id        -> 单个产品
 *   GET  /api/categories          -> 分类列表（配置分类 + 产品聚合，含数量）
 *   GET  /api/brands              -> 品牌列表（产品聚合，含数量）
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
};

// 内置角色（不可删除；权限可在角色管理中调整）
const BUILTIN_ROLES = {
  admin: { key: 'admin', name: '管理员', builtin: true, permissions: ['*'] },
  ops: { key: 'ops', name: '运营', builtin: true, permissions: ['dashboard', 'products', 'categories', 'price', 'hero', 'qr'] },
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
    const user = await authUser(request, env);
    if (!user) return unauthorized();
    if (!await can(env, user, 'products:write')) return forbidden();
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
      const brand = String(user.role === 'supplier' ? user.supplierBrand : (row.brand || '')).trim();
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
      const user = await authUser(request, env);
      if (!user) return unauthorized();
      if (!await can(env, user, 'products:write')) return forbidden();
      const idx = products.findIndex((x) => x.id === m[1]);
      if (idx === -1) return notFound();
      if (user.role === 'supplier' && products[idx].brand !== user.supplierBrand) return forbidden();

      if (method === 'PUT') {
        const raw = await readJson(request);
        if (!raw) return json({ error: 'bad_request' }, 400);
        if (user.role === 'supplier') raw.brand = user.supplierBrand;
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
