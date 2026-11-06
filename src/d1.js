/**
 * D1 数据层（阶段 0：影子双写 + 迁移 + 一致性核对）
 *
 * 设计原则
 * 1. D1 为权威库，KV 退化为读缓存（阶段 1 再切换读路径）。
 * 2. 所有写函数都自己捕获异常：D1 抖动绝不能影响主流程（下单/改价必须先成功）。
 * 3. 影子写失败会打 migration_state 上的 dirty 标记，由 /api/admin/d1/verify 暴露。
 */

const DIRTY_KEY = 'd1_dirty';

function nowIso() {
  return new Date().toISOString();
}

async function markDirty(env, reason) {
  try {
    await env.DB.prepare(
      'INSERT INTO migration_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).bind(DIRTY_KEY, `${nowIso()} ${reason}`, `${nowIso()} ${reason}`).run();
  } catch (_) { /* 记账失败不放大故障 */ }
}

/** 商品 upsert（影子写）。items 为 sanitizeProduct 之后的完整对象。 */
export async function d1SaveProduct(env, item) {
  if (!env.DB || !item || !item.id) return false;
  const seq = Number.parseInt(String(item.id).replace(/\D/g, ''), 10);
  try {
    await env.DB.prepare(`
      INSERT INTO products (id, seq, name, brand, category, spec, wholesale_price, retail_price,
        price_note, moq, highlights, storage, shelf_life, cert, badge, image, status,
        deleted, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        seq = excluded.seq, name = excluded.name, brand = excluded.brand,
        category = excluded.category, spec = excluded.spec,
        wholesale_price = excluded.wholesale_price, retail_price = excluded.retail_price,
        price_note = excluded.price_note, moq = excluded.moq,
        highlights = excluded.highlights, storage = excluded.storage,
        shelf_life = excluded.shelf_life, cert = excluded.cert, badge = excluded.badge,
        image = excluded.image, status = excluded.status, deleted = 0,
        updated_at = excluded.updated_at
    `).bind(
      String(item.id), Number.isFinite(seq) ? seq : 0,
      item.name || '', item.brand || '', item.category || '', item.spec || '',
      item.wholesale_price || '', item.retail_price || '', item.price_note || '',
      item.moq || '', item.highlights || '', item.storage || '', item.shelf_life || '',
      item.cert || '', item.badge || '', item.image || '', item.status || '上架',
      item.created_at || nowIso(), nowIso(),
    ).run();
    return true;
  } catch (e) {
    await markDirty(env, `product:${item.id} ${e && e.message}`);
    return false;
  }
}

/** 商品软删（影子写）：保留行以便统计与审计，deleted=1 后所有读取均排除。 */
export async function d1DeleteProduct(env, id) {
  if (!env.DB || !id) return false;
  try {
    await env.DB.prepare('UPDATE products SET deleted = 1, updated_at = ? WHERE id = ?')
      .bind(nowIso(), String(id)).run();
    return true;
  } catch (e) {
    await markDirty(env, `del-product:${id} ${e && e.message}`);
    return false;
  }
}

/** 订单 upsert（影子写）：orders + order_items 全量重写明细行。 */
export async function d1SaveOrder(env, order) {
  if (!env.DB || !order || !order.id) return false;
  const items = Array.isArray(order.items) ? order.items : [];
  try {
    const stmts = [
      env.DB.prepare(`
        INSERT INTO orders (id, customer_name, customer_phone, remark, status, version,
          tracking_no, status_note, total_qty, total_amount, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          customer_name = excluded.customer_name, customer_phone = excluded.customer_phone,
          remark = excluded.remark, status = excluded.status, version = excluded.version,
          tracking_no = excluded.tracking_no, status_note = excluded.status_note,
          total_qty = excluded.total_qty, total_amount = excluded.total_amount,
          updated_at = excluded.updated_at
      `).bind(
        String(order.id), order.customer_name || '', order.customer_phone || '',
        order.remark || '', order.status || 'pending', Number(order.version || 1),
        order.tracking_no || '', order.status_note || '',
        Number(order.total_qty || 0), Number(order.total_amount || 0),
        order.created_at || nowIso(), order.updated_at || nowIso(),
      ),
      env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(String(order.id)),
    ];
    items.forEach((it, idx) => {
      stmts.push(env.DB.prepare(`
        INSERT INTO order_items (order_id, line_no, product_id, name, spec, price, base_price, moq, qty, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(order.id), idx + 1, String(it.id || ''), String(it.name || '').slice(0, 80),
        String(it.spec || '').slice(0, 60), String(it.price || '').slice(0, 40),
        // base_price（出厂价）后台成本列要用：公开响应已剔除，但 D1 必须留存快照
        String(it.base_price || '').slice(0, 40),
        String(it.moq || '').slice(0, 40), Number.parseInt(it.qty, 10) || 1,
        String(it.image || '').slice(0, 300),
      ));
    });
    await env.DB.batch(stmts);
    return true;
  } catch (e) {
    await markDirty(env, `order:${order.id} ${e && e.message}`);
    return false;
  }
}

/** 配置类小文档写 KV 镜像（hero/categories/brands/users/roles/config）。 */
export async function d1PutDoc(env, key, value) {
  if (!env.DB || !key) return false;
  try {
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    await env.DB.prepare(
      'INSERT INTO kv_doc (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = ?, updated_at = ?',
    ).bind(key, v, nowIso(), v, nowIso()).run();
    return true;
  } catch (e) {
    await markDirty(env, `doc:${key} ${e && e.message}`);
    return false;
  }
}

/** 配置类小文档删除（品牌档案下线等场景，KV 与 D1 必须同删，否则会被读路径复活）。 */
export async function d1DeleteDoc(env, key) {
  if (!env.DB || !key) return false;
  try {
    await env.DB.prepare('DELETE FROM kv_doc WHERE k = ?').bind(String(key)).run();
    return true;
  } catch (e) {
    await markDirty(env, `doc-del:${key} ${e && e.message}`);
    return false;
  }
}

/* ================= 迁移：KV -> D1 ================= */

const MIGRATE_CURSOR = 'kv_migrate_cursor';

/**
 * 分批把 KV 全量搬到 D1。可重复执行（幂等）：每次从游标继续，直到 has_more = false。
 * 返回 { products, orders, docs, has_more, cursor }
 */
export async function migrateBatch(env, limit = 100) {
  const bucket = Math.max(10, Math.min(500, Number(limit) || 100));
  const state = await env.DB.prepare('SELECT value FROM migration_state WHERE key = ?')
    .bind(MIGRATE_CURSOR).first();
  let cursor = state && state.value ? String(state.value) : '';
  let scanned = 0;
  let products = 0;
  let orders = 0;
  let docs = 0;

  const page = await env.KV.list({ prefix: '', cursor: cursor || undefined, limit: bucket });
  for (const k of page.keys) {
    scanned += 1;
    const name = k.name;
    if (name === 'products') {
      // 全量索引数组：不再入库，products 表按单条为准
      continue;
    }
    if (name.startsWith('products:')) {
      const p = await env.KV.get(name, 'json');
      if (p && p.id && await d1SaveProduct(env, p)) products += 1;
    } else if (name.startsWith('orders:')) {
      const o = await env.KV.get(name, 'json');
      if (o && o.id && await d1SaveOrder(env, o)) orders += 1;
    } else if (name.startsWith('customers:')) {
      // 客户不再落表：由 v_customer_stats 视图实时聚合
      continue;
    } else {
      const raw = await env.KV.get(name);
      if (raw !== null && await d1PutDoc(env, name, raw)) docs += 1;
    }
  }

  const next = page.list_complete ? '' : (page.cursor || '');
  await env.DB.prepare(
    'INSERT INTO migration_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  ).bind(MIGRATE_CURSOR, next, next).run();

  return { scanned, products, orders, docs, has_more: !page.list_complete, cursor: next };
}

/** KV 与 D1 的计数/抽样核对，用于判定影子双写是否可信。 */
export async function verifyConsistency(env, sample = 5) {
  const kvProductsKey = await env.KV.get('products', 'json');
  const kvProducts = Array.isArray(kvProductsKey) ? kvProductsKey : [];
  const kvProductIds = new Set(kvProducts.map((p) => String(p.id)));
  const kvOrderKeys = (await env.KV.list({ prefix: 'orders:' })).keys.map((k) => k.name.replace('orders:', ''));
  const kvOrders = new Set(kvOrderKeys);

  const d1Products = await env.DB.prepare('SELECT COUNT(*) AS c FROM products WHERE deleted = 0').first();
  const d1Orders = await env.DB.prepare('SELECT COUNT(*) AS c FROM orders').first();
  const d1Items = await env.DB.prepare('SELECT COUNT(*) AS c FROM order_items').first();

  const sampleIds = Array.from(kvProductIds).slice(0, Math.max(1, Math.min(20, sample)));
  const missing = [];
  for (const id of sampleIds) {
    const row = await env.DB.prepare('SELECT id FROM products WHERE id = ? AND deleted = 0').bind(id).first();
    if (!row) missing.push(id);
  }
  const sampleOrders = Array.from(kvOrders).slice(0, Math.max(1, Math.min(20, sample)));
  const missingOrders = [];
  for (const id of sampleOrders) {
    const row = await env.DB.prepare('SELECT id FROM orders WHERE id = ?').bind(id).first();
    if (!row) missingOrders.push(id);
  }

  const dirty = await env.DB.prepare('SELECT value FROM migration_state WHERE key = ?')
    .bind(DIRTY_KEY).first();

  return {
    kv: { products: kvProducts.length, orders: kvOrders.size },
    d1: {
      products: d1Products ? d1Products.c : 0,
      orders: d1Orders ? d1Orders.c : 0,
      order_items: d1Items ? d1Items.c : 0,
    },
    sample: { products: sampleIds, missing, orders: sampleOrders, missing_orders: missingOrders },
    ok: missing.length === 0 && missingOrders.length === 0,
    last_dirty: dirty ? dirty.value : null,
  };
}

/* ================= 阶段 1：读路径（D1 优先，KV 兜底） ================= */

/**
 * 商品列表读取。返回 null 表示「D1 不可用」，由调用方回退 KV——
 * 读切 D1 的前提是前台绝不空页，任何 D1 抖动都必须能降级到 KV。
 */
export async function d1ProductList(env) {
  if (!env.DB) return null;
  try {
    const rs = await env.DB.prepare(`
      SELECT id, seq, name, brand, category, spec, wholesale_price, retail_price,
             price_note, moq, highlights, storage, shelf_life, cert, badge, image,
             status, created_at, updated_at
      FROM products WHERE deleted = 0 ORDER BY seq, id
    `).all();
    return rs.results || [];
  } catch (_) {
    return null;
  }
}

/**
 * 商品 id 是否已被占用（阶段 2：替代 KV 的存在性探测）。
 * 查的是全表、含 deleted=1 的软删行——软删商品仍占着主键，id 不可复用。
 * 返回 true/false；D1 不可用返回 null，由调用方回退 KV 探测。
 */
export async function d1ProductExists(env, id) {
  if (!env.DB || !id) return null;
  try {
    const row = await env.DB.prepare('SELECT 1 AS hit FROM products WHERE id = ?')
      .bind(String(id)).first();
    return !!(row && row.hit);
  } catch (_) {
    return null;
  }
}

/** 配置类小文档读取（kv_doc）。返回 null 表示缺失或 D1 不可用。 */
export async function d1GetDoc(env, key) {
  if (!env.DB || !key) return null;
  try {
    const row = await env.DB.prepare('SELECT v FROM kv_doc WHERE k = ?').bind(String(key)).first();
    if (!row || row.v === null || row.v === undefined) return null;
    try { return JSON.parse(row.v); } catch (_) { return row.v; }
  } catch (_) {
    return null;
  }
}

/** 品牌档案列表读取：kv_doc 里 brand:profile: 前缀的全部文档。 */
export async function d1BrandProfiles(env, prefix) {
  if (!env.DB || !prefix) return null;
  try {
    const rs = await env.DB.prepare(
      "SELECT k, v FROM kv_doc WHERE k LIKE ? ORDER BY k",
    ).bind(`${prefix}%`).all();
    const out = [];
    for (const row of rs.results || []) {
      let v = row.v;
      try { v = JSON.parse(row.v); } catch (_) { /* 原样保留 */ }
      if (v && typeof v === 'object') out.push(v);
    }
    return out;
  } catch (_) {
    return null;
  }
}

/**
 * 订单创建主写（阶段 2）：纯 INSERT，不带 ON CONFLICT DO UPDATE。
 * 订单号由 orders.id 主键唯一兜底——重号直接报冲突由调用方换号重试，
 * 而不是像 KV 那样静默覆盖掉已有订单（丢单）。
 * 返回 { ok:true } / { ok:false, reason:'conflict' } / { ok:false, reason:'no_db'|'error' }。
 */
export async function d1InsertOrder(env, order) {
  if (!env.DB || !order || !order.id) return { ok: false, reason: 'no_db' };
  const items = Array.isArray(order.items) ? order.items : [];
  try {
    const stmts = [
      env.DB.prepare(`
        INSERT INTO orders (id, customer_name, customer_phone, remark, status, version,
          tracking_no, status_note, total_qty, total_amount, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(order.id), String(order.customer_name || '').slice(0, 40),
        String(order.customer_phone || '').slice(0, 20),
        String(order.remark || '').slice(0, 200), order.status || 'pending', Number(order.version || 1),
        order.tracking_no || '', order.status_note || '',
        Number(order.total_qty || 0), Number(order.total_amount || 0),
        order.created_at || nowIso(), order.updated_at || nowIso(),
      ),
    ];
    items.forEach((it, idx) => {
      stmts.push(env.DB.prepare(`
        INSERT INTO order_items (order_id, line_no, product_id, name, spec, price, base_price, moq, qty, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(order.id), idx + 1, String(it.id || ''),
        String(it.name || '').slice(0, 80), String(it.spec || '').slice(0, 60),
        String(it.price || '').slice(0, 40), String(it.base_price || '').slice(0, 40),
        String(it.moq || '').slice(0, 40), Number.parseInt(it.qty, 10) || 1,
        String(it.image || '').slice(0, 300),
      ));
    });
    await env.DB.batch(stmts);
    return { ok: true };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/UNIQUE constraint failed|PRIMARY KEY|constraint/i.test(msg)) return { ok: false, reason: 'conflict' };
    return { ok: false, reason: 'error', error: msg.slice(0, 200) };
  }
}

/** 单条订单读取（后台订单详情/状态页用）。返回 null 表示查无此单或 D1 不可用，由调用方回退 KV。 */
export async function d1OrderGet(env, id) {
  if (!env.DB || !id) return null;
  try {
    const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(String(id)).first();
    if (!row) return null;
    const rs = await env.DB.prepare(
      'SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no',
    ).bind(String(id)).all();
    const items = (rs.results || []).map((it) => ({
      id: it.product_id, name: it.name, spec: it.spec, price: it.price,
      base_price: it.base_price || '', moq: it.moq, qty: it.qty, image: it.image,
    }));
    return { ...row, items };
  } catch (_) {
    return null;
  }
}

/**
 * 订单状态流转的原子 CAS：UPDATE ... WHERE id = ? AND version = 旧版本。
 * 返回 { ok:true } 表示本请求赢得竞争；{ ok:false, reason:'conflict' } 表示版本已被他人推进；
 * { ok:false, reason:'no_db' | 'error' } 表示 D1 不可用，调用方应回退 KV 读改写。
 */
export async function d1OrderUpdateStatus(env, id, patch) {
  if (!env.DB || !id) return { ok: false, reason: 'no_db' };
  const expected = Number(patch?.version || 1) - 1;
  try {
    const r = await env.DB.prepare(`
      UPDATE orders
         SET status = ?, version = ?, tracking_no = ?, status_note = ?, updated_at = ?
       WHERE id = ? AND version = ?
    `).bind(
      String(patch.status || ''), Number(patch.version || 1),
      String(patch.trackingNo || ''), String(patch.statusNote || ''),
      String(patch.updatedAt || nowIso()), String(id), expected,
    ).run();
    const changed = (r && r.meta && Number(r.meta.changes)) || 0;
    return changed > 0 ? { ok: true } : { ok: false, reason: 'conflict' };
  } catch (_) {
    return { ok: false, reason: 'error' };
  }
}

/** 客户列表：一条 GROUP BY 取代 KV 时代「全扫订单 + 回写聚合」。 */
export async function d1CustomerList(env) {
  const rs = await env.DB.prepare(`
    SELECT phone, name, order_count, total_items, total_qty, total_amount, last_order_at, last_order_id
    FROM v_customer_stats ORDER BY last_order_at DESC
  `).all();
  return rs.results || [];
}

/** 订单列表：条件下推到 SQL，支持 status 过滤。 */
export async function d1OrderList(env, status) {
  const sql = status
    ? 'SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC'
    : 'SELECT * FROM orders ORDER BY created_at DESC';
  const stmt = status ? env.DB.prepare(sql).bind(status) : env.DB.prepare(sql);
  const rs = await stmt.all();
  const rows = rs.results || [];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const itemsRes = await env.DB.prepare(
    `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY order_id, line_no`,
  ).bind(...ids).all();
  const byOrder = new Map();
  for (const it of itemsRes.results || []) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push({
      id: it.product_id, name: it.name, spec: it.spec, price: it.price,
      // base_price 是后台成本列/成本合计的唯一来源，漏了后台就整体显示为空
      base_price: it.base_price || '',
      moq: it.moq, qty: it.qty, image: it.image,
    });
  }
  return rows.map((r) => ({ ...r, items: byOrder.get(r.id) || [] }));
}
