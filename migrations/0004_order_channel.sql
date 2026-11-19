-- 0004_order_channel.sql
-- 订单来源渠道：看板「按渠道统计」需要按来源维度聚合 GMV / 单量。
--
-- 设计要点：
--   1) 渠道由前端在「首次落地」时采集（utm_source/channel/src/from > referrer 域名 > direct），
--      后端按白名单形态归一化后落库，匿名请求体无法伪造统计维度。
--   2) referrer 保留截断后的来源地址，便于运营回溯未知渠道，不参与任何统计口径。
--   3) 两列均 DEFAULT ''，存量订单无需回填，统计时以「未标注」聚合展示，
--      不会因为新增列导致历史订单从看板消失。
--
-- 注意：本迁移是 ALTER，存量库必须真实执行，故不写 d1-baseline-when 基线探测。
ALTER TABLE orders ADD COLUMN channel  TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN referrer TEXT NOT NULL DEFAULT '';

-- 按渠道看单量 / GMV，避免全表扫描（D1 按扫描行计费）
CREATE INDEX IF NOT EXISTS idx_orders_channel ON orders(channel, created_at DESC);
