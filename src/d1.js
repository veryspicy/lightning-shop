/**
 * D1 数据层（阶段 3：D1 为唯一主库，KV 退为降级副本）
 *
 * 设计原则
 * 1. D1 是权威库；KV 只是副本/降级通道，读路径不再依赖它。
 * 2. 写函数区分两类失败：`no_db`（未绑定 → 允许 KV 单写降级）与 `error`（D1 报错 →
 *    调用方必须失败），绝不出现「只写 KV」的单边写——读走 D1，单写 KV 等于丢更新。
 * 3. 写失败会打 migration_state 上的 dirty 标记，由 /api/admin/d1/verify 暴露。
 *    阶段 3 起它只是**故障样本记录**，不再驱动任何补偿（补偿逻辑已随主写切换下线）。
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

/* 结构化收货地址的固定绑定顺序：orders 表 7 个地址列，统一从这里取，
 * 避免 INSERT（d1InsertOrder）与 UPSERT（d1UpsertOrder）两处顺序写岔导致字段错位。 */
function addressBinds(order) {
  const o = order || {};
  const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
  return [
    clip(o.receiver_name, 40),
    clip(o.receiver_phone, 20),
    clip(o.province, 30),
    clip(o.city, 30),
    clip(o.district, 30),
    clip(o.address, 200),
    clip(o.postal_code, 12),
  ];
}

/* 渠道维度的固定绑定顺序：orders 表 channel / referrer 两列。
 * 与 addressBinds 同理，INSERT 与 UPSERT 共用一处，避免两处写岔错位。 */
function channelBinds(order) {
  const o = order || {};
  const clip = (v, n) => String(v === undefined || v === null ? '' : v).trim().slice(0, n);
  return [
    clip(o.channel, 40),
    clip(o.referrer, 300),
  ];
}

/**
 * 订单 upsert 内核：orders + order_items 全量重写明细行（事务批次）。
 * 返回 { ok, reason } —— reason 取值 ok / no_db / error，调用方据此决定降级还是失败。
 * 阶段 3 起订单主写走这里：D1 报错不再被静默吞掉（否则后台读到旧状态、等于丢更新）。
 */
export async function d1UpsertOrder(env, order) {
  if (!env.DB || !order || !order.id) return { ok: false, reason: 'no_db' };
  const items = Array.isArray(order.items) ? order.items : [];
  try {
    const stmts = [
      env.DB.prepare(`
        INSERT INTO orders (id, customer_name, customer_phone, remark, status, version,
          tracking_no, status_note, total_qty, total_amount, created_at, updated_at,
          receiver_name, receiver_phone, province, city, district, address, postal_code,
          channel, referrer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          customer_name = excluded.customer_name, customer_phone = excluded.customer_phone,
          remark = excluded.remark, status = excluded.status, version = excluded.version,
          tracking_no = excluded.tracking_no, status_note = excluded.status_note,
          total_qty = excluded.total_qty, total_amount = excluded.total_amount,
          updated_at = excluded.updated_at,
          receiver_name = excluded.receiver_name, receiver_phone = excluded.receiver_phone,
          province = excluded.province, city = excluded.city, district = excluded.district,
          address = excluded.address, postal_code = excluded.postal_code,
          channel = excluded.channel, referrer = excluded.referrer
      `).bind(
        String(order.id), order.customer_name || '', order.customer_phone || '',
        order.remark || '', order.status || 'pending', Number(order.version || 1),
        order.tracking_no || '', order.status_note || '',
        Number(order.total_qty || 0), Number(order.total_amount || 0),
        order.created_at || nowIso(), order.updated_at || nowIso(),
        ...addressBinds(order),
        // 渠道维度：状态流转等后台更新也必须原样带回来，否则一次改状态就把来源抹成未标注
        ...channelBinds(order),
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
    return { ok: true, reason: 'ok' };
  } catch (e) {
    await markDirty(env, `order:${order.id} ${e && e.message}`);
    return { ok: false, reason: 'error', error: String(e && e.message ? e.message : e).slice(0, 200) };
  }
}

/**
 * 订单持久化（阶段 3 收口后的唯一写入口）：D1 主写，成功后 KV 回写副本。
 * - D1 未绑定（本地无 binding）→ KV 单写，属合法降级，KV 此时即真源；
 * - D1 报错 → 返回 { ok:false }，调用方必须 500，禁止「只写 KV」的单边写
 *   （读路径走 D1，单写 KV 等于后台读不到这次变更）。
 * 返回 { ok, source:'d1'|'kv', reason }；副本回写失败不影响 ok。
 */
export async function d1PersistOrder(env, order) {
  const r = await d1UpsertOrder(env, order);
  if (r.reason === 'no_db') {
    await env.KV.put(`orders:${order.id}`, JSON.stringify(order));
    return { ok: true, source: 'kv' };
  }
  if (!r.ok) return { ok: false, source: 'd1', reason: r.reason };
  try {
    await env.KV.put(`orders:${order.id}`, JSON.stringify(order));
  } catch (_) { /* 副本回写失败不影响主流程，后台读走 D1 */ }
  return { ok: true, source: 'd1' };
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
const MIGRATE_DONE = 'kv_migrate_done';

/**
 * 迁移是否已完成（阶段 3 收口保护）。
 * 阶段 3 起 KV 只是 D1 的降级副本，陈旧副本重跑迁移会反向覆盖真源
 * （软删商品复活、订单状态回退）。因此只要历史迁移跑过（有 done 标记，
 * 或 D1 里已有商品+文档两类迁移产物），默认拒绝再跑，必须显式 force。
 */
async function migrationAlreadyDone(env) {
  const done = await env.DB.prepare('SELECT value FROM migration_state WHERE key = ?')
    .bind(MIGRATE_DONE).first();
  if (done && String(done.value || '')) return true;
  try {
    const p = await env.DB.prepare('SELECT COUNT(*) AS c FROM products').first();
    const d = await env.DB.prepare('SELECT COUNT(*) AS c FROM kv_doc').first();
    const hasRows = Number(p && p.c ? p.c : 0) > 0 && Number(d && d.c ? d.c : 0) > 0;
    if (hasRows) {
      await env.DB.prepare(
        'INSERT INTO migration_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
      ).bind(MIGRATE_DONE, nowIso(), nowIso()).run();
      return true;
    }
  } catch (_) { /* 计数失败按未完成处理，避免误锁死 */ }
  return false;
}

/**
 * 分批把 KV 全量搬到 D1。可重复执行（幂等）：每次从游标继续，直到 has_more = false。
 * 阶段 3 后仅供「D1 重建/灾难恢复」使用：默认拒绝重跑，需 force = true。
 * 返回 { skipped, reason } 或 { products, orders, docs, has_more, cursor }
 */
export async function migrateBatch(env, limit = 100, force = false) {
  if (!force && await migrationAlreadyDone(env)) {
    return { skipped: true, reason: 'already_completed', hint: '迁移已完成，KV 仅为降级副本；如需重建 D1 请显式 ?force=1' };
  }
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
      if (o && o.id && (await d1UpsertOrder(env, o)).ok) orders += 1;
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
  if (page.list_complete) {
    // 跑完即落完成标记：后续再调默认被拒，避免陈旧 KV 副本覆盖 D1 真源
    await env.DB.prepare(
      'INSERT INTO migration_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).bind(MIGRATE_DONE, nowIso(), nowIso()).run();
  }

  return { scanned, products, orders, docs, has_more: !page.list_complete, cursor: next };
}

/**
 * 一致性核对（只读诊断，阶段 3 后语义已变）：
 * D1 是唯一真源，KV 只是降级副本 —— 因此「D1 有、KV 没有」属正常，不参与判定；
 * 只有「KV 有、D1 没有」才可疑（副本写失败 / 历史单未迁移），计入 abnormal。
 */
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
    kv_drift: {
      products_missing_in_d1: missing.length,
      orders_missing_in_d1: missingOrders.length,
      abnormal: missing.length + missingOrders.length > 0,
    },
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
          tracking_no, status_note, total_qty, total_amount, created_at, updated_at,
          receiver_name, receiver_phone, province, city, district, address, postal_code,
          channel, referrer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        String(order.id), String(order.customer_name || '').slice(0, 40),
        String(order.customer_phone || '').slice(0, 20),
        String(order.remark || '').slice(0, 200), order.status || 'pending', Number(order.version || 1),
        order.tracking_no || '', order.status_note || '',
        Number(order.total_qty || 0), Number(order.total_amount || 0),
        order.created_at || nowIso(), order.updated_at || nowIso(),
        ...addressBinds(order),
        ...channelBinds(order),
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

/* ==================== 查单验证码（verify_code） ====================
 * 公开查单的二次验证。表里只存 code_hash，明文码既不落库也不进日志。
 * 所有函数在 D1 不可用时返回「降级信号」而非抛错，由调用方决定是拒绝请求还是放行：
 * 查单属于敏感接口，D1 不可用时一律失败关闭（fail-closed），不放行。
 */

/** 写入一条验证码记录。返回 { ok, reason }。 */
export async function d1SaveVerifyCode(env, rec) {
  if (!env.DB) return { ok: false, reason: 'no_db' };
  try {
    await env.DB.prepare(`
      INSERT INTO verify_code (id, target, purpose, channel, code_hash, salt,
        attempts, max_attempts, consumed, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?)
    `).bind(
      String(rec.id), String(rec.target), String(rec.purpose || 'order_query'),
      String(rec.channel || 'sms'), String(rec.codeHash || ''), String(rec.salt || ''),
      Number(rec.maxAttempts || 3), String(rec.expiresAt), String(rec.createdAt || nowIso()),
    ).run();
    return { ok: true };
  } catch (e) {
    await markDirty(env, `verify-save ${e && e.message}`);
    return { ok: false, reason: 'error' };
  }
}

/** 统计某手机号在 sinceIso 之后已发码次数（跨 isolate 的真实频控）。 */
export async function d1CountRecentCodes(env, target, purpose, sinceIso) {
  if (!env.DB) return { ok: false, reason: 'no_db', count: 0 };
  try {
    const row = await env.DB.prepare(`
      SELECT COUNT(*) AS n FROM verify_code
       WHERE target = ? AND purpose = ? AND created_at >= ?
    `).bind(String(target), String(purpose || 'order_query'), String(sinceIso)).first();
    return { ok: true, count: Number(row && row.n) || 0 };
  } catch (_) {
    return { ok: false, reason: 'error', count: 0 };
  }
}

/** 取该手机号最近一条验证码记录（不滤 consumed / 过期，判定交给调用方给出准确文案）。 */
export async function d1LatestLiveCode(env, target, purpose) {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare(`
      SELECT * FROM verify_code
       WHERE target = ? AND purpose = ?
       ORDER BY created_at DESC LIMIT 1
    `).bind(String(target), String(purpose || 'order_query')).first() || null;
  } catch (_) {
    return null;
  }
}

/** 校验失败时累加尝试次数，返回累加后的 attempts / max_attempts。 */
export async function d1BumpCodeAttempt(env, id) {
  if (!env.DB) return { ok: false, reason: 'no_db' };
  try {
    const row = await env.DB.prepare(
      'UPDATE verify_code SET attempts = attempts + 1 WHERE id = ? RETURNING attempts, max_attempts',
    ).bind(String(id)).first();
    return { ok: true, attempts: Number(row && row.attempts) || 0, maxAttempts: Number(row && row.max_attempts) || 3 };
  } catch (_) {
    return { ok: false, reason: 'error' };
  }
}

/**
 * 原子消费：只有 consumed 仍为 0 的请求能抢到（changes > 0）。
 * 并发下同一验证码只可能有一次成功，避免同一码被重放拉多次订单。
 */
export async function d1ConsumeCode(env, id) {
  if (!env.DB) return { ok: false, reason: 'no_db' };
  try {
    const r = await env.DB.prepare(
      'UPDATE verify_code SET consumed = 1 WHERE id = ? AND consumed = 0',
    ).bind(String(id)).run();
    const changed = (r && r.meta && Number(r.meta.changes)) || 0;
    return changed > 0 ? { ok: true } : { ok: false, reason: 'already_consumed' };
  } catch (_) {
    return { ok: false, reason: 'error' };
  }
}

/** 清理过期/已消费的历史记录（后台低频调用即可，不需要定时任务）。 */
export async function d1PurgeCodes(env, beforeIso) {
  if (!env.DB) return { ok: false, reason: 'no_db' };
  try {
    const r = await env.DB.prepare('DELETE FROM verify_code WHERE created_at < ?').bind(String(beforeIso)).run();
    return { ok: true, deleted: (r && r.meta && Number(r.meta.changes)) || 0 };
  } catch (_) {
    return { ok: false, reason: 'error' };
  }
}

/** 按下单手机号取订单（查单专用：条件下推到 SQL，避免 KV 时代全表扫）。 */
export async function d1OrdersByPhone(env, phone, orderId) {
  if (!env.DB || !phone) return { ok: false, reason: 'no_db', orders: [] };
  try {
    const sql = orderId
      ? 'SELECT * FROM orders WHERE customer_phone = ? AND id = ? ORDER BY created_at DESC LIMIT 50'
      : 'SELECT * FROM orders WHERE customer_phone = ? ORDER BY created_at DESC LIMIT 50';
    const stmt = orderId
      ? env.DB.prepare(sql).bind(String(phone), String(orderId))
      : env.DB.prepare(sql).bind(String(phone));
    const rs = await stmt.all();
    const rows = rs.results || [];
    if (!rows.length) return { ok: true, orders: [] };
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
        base_price: it.base_price || '', moq: it.moq, qty: it.qty, image: it.image,
      });
    }
    return { ok: true, orders: rows.map((r) => ({ ...r, items: byOrder.get(r.id) || [] })) };
  } catch (_) {
    return { ok: false, reason: 'error', orders: [] };
  }
}

/* ================= 销售统计（后台看板） =================
 * 设计要点
 * 1. 全部聚合下推到 SQL：看板每次刷新只读聚合结果，不把订单明细拉到 Worker 里再算，
 *    避免订单量增长后看板请求随行数线性变慢、D1 读行数费用失控。
 * 2. 口径统一：销售额只统计未取消订单（status <> 'cancelled'）；
 *    另给 paid_amount（已支付及之后的 paid/shipped/done），用于区分成交额与实收额。
 * 3. created_at 存的是 UTC ISO 串，日期分桶必须先 +8 小时换算北京时间，
 *    否则每天早上 8 点前的订单会被算到前一天。
 * 4. 表格数据为空时不报错，返回空数组，由前端显式提示「暂无订单数据」，
 *    避免出现「图表空白但不知是没数据还是算错了」。
 */

const SALES_DAYS_MIN = 7;
const SALES_DAYS_MAX = 180;

export async function d1SalesStats(env, days = 30) {
  if (!env.DB) return { ok: false, reason: 'no_db' };
  const span = Math.min(SALES_DAYS_MAX, Math.max(SALES_DAYS_MIN, Number(days) || 30));
  const sinceModifier = `-${span - 1} days`;
  try {
    const summarySql = `
      SELECT
        COUNT(*) AS orders,
        SUM(CASE WHEN status <> 'cancelled' THEN 1 ELSE 0 END) AS valid_orders,
        ROUND(SUM(CASE WHEN status <> 'cancelled' THEN total_amount ELSE 0 END), 2) AS amount,
        ROUND(SUM(CASE WHEN status IN ('paid','shipped','done') THEN total_amount ELSE 0 END), 2) AS paid_amount,
        SUM(CASE WHEN status <> 'cancelled' THEN total_qty ELSE 0 END) AS qty,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_orders
      FROM orders`;
    const recentSql = `
      SELECT
        SUM(CASE WHEN status <> 'cancelled' THEN 1 ELSE 0 END) AS orders,
        ROUND(SUM(CASE WHEN status <> 'cancelled' THEN total_amount ELSE 0 END), 2) AS amount,
        SUM(CASE WHEN status <> 'cancelled' THEN total_qty ELSE 0 END) AS qty
      FROM orders
      WHERE date(created_at, '+8 hours') >= date('now', '+8 hours', ?)`;
    const trendSql = `
      SELECT date(created_at, '+8 hours') AS d,
             COUNT(*) AS orders,
             ROUND(SUM(total_amount), 2) AS amount,
             SUM(total_qty) AS qty
      FROM orders
      WHERE status <> 'cancelled'
        AND date(created_at, '+8 hours') >= date('now', '+8 hours', ?)
      GROUP BY d ORDER BY d ASC`;
    const statusSql = `
      SELECT status, COUNT(*) AS cnt, ROUND(SUM(total_amount), 2) AS amount
      FROM orders GROUP BY status`;
    const topProductsSql = `
      SELECT i.product_id AS id, MAX(i.name) AS name,
             SUM(i.qty) AS qty, COUNT(DISTINCT i.order_id) AS orders
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.status <> 'cancelled'
      GROUP BY i.product_id ORDER BY qty DESC LIMIT 10`;
    const brandsSql = `
      SELECT COALESCE(NULLIF(p.brand, ''), '未标注品牌') AS brand,
             SUM(i.qty) AS qty, COUNT(DISTINCT i.order_id) AS orders
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      LEFT JOIN products p ON p.id = i.product_id
      WHERE o.status <> 'cancelled'
      GROUP BY COALESCE(NULLIF(p.brand, ''), '未标注品牌')
      ORDER BY qty DESC LIMIT 8`;
    /* 上期同口径窗口（紧邻的前 span 天）：环比必须与本期同样排除已取消、同样 +8h 分桶，
     * 否则「本期剔取消、上期不剔」会把环比算成假涨。 */
    const prevSql = `
      SELECT COUNT(*) AS orders,
             ROUND(SUM(total_amount), 2) AS amount,
             SUM(total_qty) AS qty
      FROM orders
      WHERE status <> 'cancelled'
        AND date(created_at, '+8 hours') >= date('now', '+8 hours', ?)
        AND date(created_at, '+8 hours') <  date('now', '+8 hours', ?)`;
    /* 按渠道：channel 为空串即存量订单 / 未采集，归「未标注」，避免老订单从看板消失。 */
    const channelsSql = `
      SELECT COALESCE(NULLIF(channel, ''), '未标注') AS channel,
             COUNT(*) AS orders,
             ROUND(SUM(total_amount), 2) AS amount,
             SUM(total_qty) AS qty,
             COUNT(DISTINCT customer_phone) AS customers
      FROM orders
      WHERE status <> 'cancelled'
        AND date(created_at, '+8 hours') >= date('now', '+8 hours', ?)
      GROUP BY COALESCE(NULLIF(channel, ''), '未标注')
      ORDER BY amount DESC, orders DESC LIMIT 10`;
    /* 复购：以手机号为客户唯一键（姓名会重名、公司名会改），窗口内下单 ≥2 次算复购客户。
     * 复购率 = 复购客户数 / 窗口内下单客户数；repeat_amount 用于看复购客户贡献的 GMV 占比。 */
    const repeatSql = `
      SELECT COUNT(*) AS customers,
             SUM(CASE WHEN cnt >= 2 THEN 1 ELSE 0 END) AS repeat_customers,
             SUM(cnt) AS orders,
             ROUND(SUM(amount), 2) AS amount,
             ROUND(SUM(CASE WHEN cnt >= 2 THEN amount ELSE 0 END), 2) AS repeat_amount
      FROM (
        SELECT customer_phone, COUNT(*) AS cnt, SUM(total_amount) AS amount
        FROM orders
        WHERE status <> 'cancelled' AND customer_phone <> ''
          AND date(created_at, '+8 hours') >= date('now', '+8 hours', ?)
        GROUP BY customer_phone
      )`;

    const [summaryRs, recentRs, trendRs, statusRs, topRs, brandRs, prevRs, channelRs, repeatRs] = await Promise.all([
      env.DB.prepare(summarySql).all(),
      env.DB.prepare(recentSql).bind(sinceModifier).all(),
      env.DB.prepare(trendSql).bind(sinceModifier).all(),
      env.DB.prepare(statusSql).all(),
      env.DB.prepare(topProductsSql).all(),
      env.DB.prepare(brandsSql).all(),
      env.DB.prepare(prevSql).bind(`-${span * 2 - 1} days`, sinceModifier).all(),
      env.DB.prepare(channelsSql).bind(sinceModifier).all(),
      env.DB.prepare(repeatSql).bind(sinceModifier).all(),
    ]);

    const s = (summaryRs.results || [])[0] || {};
    const r = (recentRs.results || [])[0] || {};
    const num = (v) => (v === null || v === undefined ? 0 : Number(v));
    const avg = (amount, count) => (count > 0 ? Math.round((amount / count) * 100) / 100 : 0);

    // 补齐空白天：趋势图缺日会断线/错位，后端一次补齐，前端只负责画
    const byDate = new Map();
    for (const row of trendRs.results || []) {
      byDate.set(String(row.d), { date: String(row.d), orders: num(row.orders), amount: num(row.amount), qty: num(row.qty) });
    }
    const trend = [];
    const todayCn = new Date(Date.now() + 8 * 3600 * 1000);
    for (let i = span - 1; i >= 0; i -= 1) {
      const d = new Date(todayCn.getTime() - i * 86400000);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      trend.push(byDate.get(key) || { date: key, orders: 0, amount: 0, qty: 0 });
    }

    const validOrders = num(s.valid_orders);
    const recentOrders = num(r.orders);
    return {
      ok: true,
      days: span,
      range: { from: trend[0].date, to: trend[trend.length - 1].date },
      summary: {
        orders: num(s.orders),
        valid_orders: validOrders,
        cancelled_orders: num(s.cancelled_orders),
        amount: num(s.amount),
        paid_amount: num(s.paid_amount),
        qty: num(s.qty),
        avg_order_value: avg(num(s.amount), validOrders),
      },
      recent: {
        orders: recentOrders,
        amount: num(r.amount),
        qty: num(r.qty),
        avg_order_value: avg(num(r.amount), recentOrders),
      },
      // 环比：本期（近 span 天）对比紧邻的等长上期，pct 为 null 表示上期无数据，前端不得显示成 0%
      compare: (() => {
        const p = (prevRs.results || [])[0] || {};
        const curAmount = num(r.amount);
        const curOrders = recentOrders;
        const prevAmount = num(p.amount);
        const prevOrders = num(p.orders);
        const pct = (cur, base) => (base > 0 ? Math.round(((cur - base) / base) * 1000) / 10 : null);
        return {
          period_days: span,
          current: { amount: curAmount, orders: curOrders, qty: num(r.qty), avg_order_value: avg(curAmount, curOrders) },
          previous: { amount: prevAmount, orders: prevOrders, qty: num(p.qty), avg_order_value: avg(prevAmount, prevOrders) },
          change: {
            amount_pct: pct(curAmount, prevAmount),
            orders_pct: pct(curOrders, prevOrders),
            qty_pct: pct(num(r.qty), num(p.qty)),
            avg_order_value_pct: pct(avg(curAmount, curOrders), avg(prevAmount, prevOrders)),
          },
        };
      })(),
      // 渠道维度：amount 已按渠道汇总，customers 为渠道内去重客户数
      channels: (channelRs.results || []).map((row) => ({
        channel: String(row.channel),
        orders: num(row.orders),
        amount: num(row.amount),
        qty: num(row.qty),
        customers: num(row.customers),
      })),
      // 复购：repeat_rate / repeat_amount_share 均为百分比数值（如 33.3），无客户时为 0
      repeat: (() => {
        const x = (repeatRs.results || [])[0] || {};
        const customers = num(x.customers);
        const repeatCustomers = num(x.repeat_customers);
        const amount = num(x.amount);
        const repeatAmount = num(x.repeat_amount);
        const rate = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);
        return {
          customers,
          repeat_customers: repeatCustomers,
          repeat_rate: rate(repeatCustomers, customers),
          orders: num(x.orders),
          orders_per_customer: customers > 0 ? Math.round((num(x.orders) / customers) * 100) / 100 : 0,
          amount,
          repeat_amount: repeatAmount,
          repeat_amount_share: rate(repeatAmount, amount),
        };
      })(),
      trend,
      status: (statusRs.results || []).map((row) => ({
        status: String(row.status),
        cnt: num(row.cnt),
        amount: num(row.amount),
      })),
      top_products: (topRs.results || []).map((row) => ({
        id: String(row.id || ''),
        name: String(row.name || row.id || ''),
        qty: num(row.qty),
        orders: num(row.orders),
      })),
      brands: (brandRs.results || []).map((row) => ({
        brand: String(row.brand),
        qty: num(row.qty),
        orders: num(row.orders),
      })),
      generated_at: new Date().toISOString(),
    };
  } catch (_) {
    return { ok: false, reason: 'error' };
  }
}
