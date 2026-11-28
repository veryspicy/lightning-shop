-- 0006_rfq_service_fee.sql — 询价单语义改造：供货工厂标注 + 居间服务费拆分
-- d1-baseline-when: SELECT 1 FROM pragma_table_info('orders') WHERE name='factory_id'
--
-- 背景：
--   本站经营模式为居间/经纪服务（不碰货、不碰款、不碰票），站内「订单」实为询价单：
--   客户提交询价 → 我方报价 → 客户确认 → 工厂直发。原表结构只有电商自营语义
--   （status 默认 pending =「待确认支付」、只有 total_amount 一个金额口径），存在两个缺口：
--     1. 无法标注「本单由哪家工厂供货」—— 工厂资质公示的落点缺失，订单与资质页对不上；
--     2. 无法把「货款（客户直付工厂，平台不经手）」与「我方服务费收入」分开记账 ——
--        服务费台账导出、收入核对都必须依赖这个拆分，混在一个 total_amount 里无法拆。
--
-- 设计约束：
--   1. 新列全部带 DEFAULT，存量订单无需回填；读出空串 / 0 时前端显示「未指定」。
--   2. factory_id 存品牌档案 key（brand:profile:{key} 的 key，即工厂/品牌名），
--      与 products.brand、品牌档案天然对齐，P0 不新建工厂主表（避免主数据与权限面扩大）。
--   3. service_fee 只允许后台鉴权接口写入；公开下单路由的 sanitizeOrder 必须显式丢弃该字段，
--      否则客户可自填 0 元服务费（收入与合规双风险）。
--   4. total_amount 语义固定为「商品货款合计（归属工厂）」；
--      客户应付合计 = total_amount + service_fee，由接口计算返回、不落库，避免双份真源。
--
-- 幂等性：ADD COLUMN 重复执行会报 duplicate column（SQLite 不支持 ADD COLUMN IF NOT EXISTS）。
--   本迁移的 7 列曾在生产库经 wrangler 原生 d1_migrations 通道手工执行，但脚本账本
--   _d1_migrations 未登记，导致 Workers Builds 构建期重放、因 duplicate column name:
--   factory_id 失败（构建 00ad011c，2026-11-28）。故补 d1-baseline-when 探测：列已存在
--   即登记为基线、不重放；空库探测不命中则正常执行，与 0003 的处理方式一致。

ALTER TABLE orders ADD COLUMN factory_id       TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN service_fee      REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN service_fee_note TEXT NOT NULL DEFAULT '';

-- 模式B（纯居间）补充：货款不经我方手，服务费是独立一笔收款，两者状态必须分开记。
--   service_fee_status：unbilled=待开账（未报价）/ quoted=已报价未开账 / invoiced=已开票待收
--                       / paid=服务费已收 / waived=减免（与后端 FEE_STATUS 白名单严格一致）
--   goods_paid_at：客户告知「货款已直付工厂」的时间，仅作进度记录，不代表我方收到货款
--   pay_note：付款凭证备注（客户转账流水 / 工厂确认信息），供对账留痕
ALTER TABLE orders ADD COLUMN service_fee_status TEXT NOT NULL DEFAULT 'unbilled';
ALTER TABLE orders ADD COLUMN service_fee_paid_at TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN goods_paid_at    TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN pay_note         TEXT NOT NULL DEFAULT '';

-- 后台按工厂维度看单量 / 货款，供资质页与台账核对使用
CREATE INDEX IF NOT EXISTS idx_orders_factory ON orders(factory_id, created_at DESC);

-- 服务费台账导出与「待收款」工作台依赖此索引
CREATE INDEX IF NOT EXISTS idx_orders_fee_status ON orders(service_fee_status, created_at DESC);

/* ---------- 状态键重命名（模式B：不得出现「已支付」语义） ----------
 * 纯居间下我方不收款，旧键 paid（标签「已支付待发货」）会让页面暗示平台代收货款，
 * 属合规误导，必须废弃。键位重排为：询价 → 报价 → 确认 → 转厂 → 发货 → 完成。
 *   pending → inquiry   待报价
 *   paid    → confirmed 客户已确认（货款直付工厂，我方未收任何货款）
 *   shipped / done / cancelled 键名保留，shipped 语义改为「工厂已发货」
 * UPDATE 幂等，可重复执行。
 * 注意：KV 里的订单副本不追改，读路径以 D1 为准（阶段 3 起已切 D1）。 */
UPDATE orders SET status = 'inquiry'   WHERE status = 'pending';
UPDATE orders SET status = 'confirmed' WHERE status = 'paid';
