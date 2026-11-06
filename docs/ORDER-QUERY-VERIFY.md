# 公开查单二次验证（OTP）与免费通道选型

> 目标：把「只凭手机号就能拉走该号码全部订单」的 IDOR / PII 枚举风险关掉，并把成本压到 0。
>
> 相关迁移：`migrations/0003_order_address_verify.sql`

## 1. 风险与结论

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| 查单凭据 | 手机号（单因子） | 手机号 + 订单号 或 短信验证码（至少两因子） |
| 可枚举性 | 可遍历手机号批量拖库 | 需同时知道订单号 / 收到短信码；错误即拒 |
| 频控 | 30 次/60s（仅 IP） | 查单 10 次/5min（IP）＋ 发码 5 次/5min（IP）＋ 每号码 5 条/小时 |
| 数据库不可用 | 放行 | **fail-closed**（拒绝，不放行） |

结论：默认档 `scope`（手机号 + 订单号，可叠加 Turnstile）**完全免费且今天即可上线**；短信档 `sms` 留作可选升级。

## 2. 三档机制（`otpMode()` 自动判定）

| 模式 | 触发条件 | 校验要素 | 成本 |
| --- | --- | --- | --- |
| `scope`（默认） | 未配置任何短信密钥 | 手机号 + 订单号 | 0（Workers 免费额度内） |
| `scope` + Turnstile | 额外配置 `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` | 手机号 + 订单号 + 人机校验 | 0（Turnstile 免费计划挑战次数不限） |
| `sms` | 配置 `SMS_PROVIDER` 及对应密钥 | 手机号 + 订单号 + 短信验证码 | 依赖通道额度 |

前端 `GET /api/config` 返回 `mode` 与 `turnstile_site_key`，据此决定渲染「订单号」还是「验证码」输入框。

## 3. 接口

| 路由 | 说明 |
| --- | --- |
| `POST /api/orders/query/code` | 发码。仅对**名下确有订单**的号码真发短信，但响应统一为「若该手机号有订单，验证码已发送」，不泄露号码是否下过单。`scope` 模式返回 501 `sms_not_configured` |
| `POST /api/orders/query` | 查单。`scope` 模式要 `order_id`；`sms` 模式要 `code` |
| `GET /api/orders/query` | 同上，query 参数形式（保留兼容） |

## 4. 配置项

在 `wrangler.toml` 的 `[vars]` 放非敏感项，密钥用 `wrangler secret put`：

| 变量 | 说明 |
| --- | --- |
| `SMS_PROVIDER` | `tencent` / `aliyun`，缺省即 `scope` 档 |
| `SMS_TC_SECRET_ID` / `SMS_TC_SECRET_KEY` | 腾讯云访问密钥 |
| `SMS_TC_SDK_APP_ID` / `SMS_TC_TEMPLATE_ID` / `SMS_TC_SIGN_NAME` | 短信应用、模板 ID、签名 |
| `SMS_TC_REGION` | 默认 `ap-guangzhou` |
| `SMS_ALI_KEY_ID` / `SMS_ALI_KEY_SECRET` / `SMS_ALI_SIGN_NAME` / `SMS_ALI_TEMPLATE_CODE` | 阿里云对应项 |
| `TURNSTILE_SECRET` / `TURNSTILE_SITE_KEY` | 可选，配了即叠加人机校验 |

验证码参数（代码常量，`src/index.js` 顶部）：`OTP_TTL_SEC = 300`（5 分钟）、`OTP_MAX_ATTEMPTS = 3`、`OTP_PER_HOUR = 5`。要调整直接改常量。

切换到短信档：`npx wrangler secret put SMS_TC_SECRET_ID` 等逐项写入 → 部署，`otpMode()` 自动切到 `sms`，前端自动换渲染验证码输入框，**无需改代码**。

## 5. 免费短信通道调研（截至 2026-11，均需实名 + 签名/模板审核）

| 通道 | 免费额度 | 有效期 | 关键门槛 | 来源 |
| --- | --- | --- | --- | --- |
| 阿里云短信 | 个人实名 100 条国内短信；企业实名 200 条 | 3 个月 | 需签名 + 模板审核；额度用尽后转按量付费（不会自动停） | [阿里云测试与试用指南](https://help.aliyun.com/zh/sms/getting-started/test-and-usage-guide) |
| 腾讯云短信 | 个人认证首次开通赠 100 条国内短信；企业认证 500 条 | 一次性赠送 | **个人主体签名无法做运营商实名报备**，发国内短信需企业证件 + 授权委托书申请他用资质 | [腾讯云短信使用须知](https://cloud.tencent.com/document/product/382/13444) |
| Cloudflare Turnstile | 挑战次数不限（免费计划，最多 20 个 widget） | 长期 | 不是短信，只能挡机器，不能证明「手机号归属」 | [Turnstile plans](https://developers.cloudflare.com/turnstile/plans/) |

结论：

1. **没有长期、永久免费的国内短信网关**，免费额度都是一次性/3 个月量级，且个人主体过签名报备很容易卡住。
2. 0 成本方案 = 现有 `scope` 档（手机号 + 订单号）+ 可选 Turnstile，已实现并验证通过。
3. 想上短信：先领阿里云个人 100 条（3 个月内够验证链路），密钥注入即切 `sms` 档，无需改代码；量大了再买套餐包。

## 6. 安全实现要点

- `verify_code` 表只存 `code_hash = SHA-256(phone|purpose|code|salt)`，明文码不落库、不进日志、不回显。
- `attempts` 持久化在 D1（不是内存桶），跨 isolate 计数才有效；达到上限返回 `code_locked`。
- 验证通过后用 `UPDATE ... WHERE consumed = 0` 原子消费，`changes = 0` 视为重放，返回 `code_reused`。
- 频控用 D1 按 `created_at` 计数（发码 5 条/小时/号码），叠加 IP 级限流。
- 短信发送失败不静默：返回 500 提示改用订单号查询，避免用户无限等待。
- D1 不可用时查单与发码一律拒绝（fail-closed）。

## 7. 本地验证

```powershell
# 1) 起本地环境（带假短信密钥，模拟 sms 档）
npx wrangler dev --local --port 8791 --persist-to .wrangler/test-state `
  --var SMS_PROVIDER:tencent --var SMS_TC_SECRET_ID:AKIDtestonly `
  --var SMS_TC_SECRET_KEY:testkeyonly --var SMS_TC_SDK_APP_ID:1400000000 `
  --var SMS_TC_TEMPLATE_ID:123456 --var SMS_TC_SIGN_NAME:test

# 2) 跑端到端脚本（默认 scope 档；sms 档另建）
python temp/verify_query_otp.py
```

覆盖用例：无订单号被拒 → 手机号+订单号通过 → 错订单号查不到 → 发码返回 sms_not_configured（scope 档）→ 错误码计数 → 三次后锁定 → 正确码通过 → 重放被拒 → 过期码被拒 → 发码频控 429。

注意：`wrangler dev` 运行期间外部 `d1 execute` 写入不会立刻可见（进程持有独立 sqlite 副本），造数据要先停 dev、写完再起。

## 8. 前端交互约定：提示一律置顶

- 页面级说明、校验错误、操作结果**只能出现在表单顶部**（`.query-notice` / `.query-notice.is-err` / `.order-success`），禁止放在提交按钮下方：底部提示在小屏上滚不到、用户感知不到，只能算「事后通知」。
- 全局 toast（`.tip-toast`）固定顶部居中，配合 `aria-live="polite"`，不遮挡底部操作按钮。
- 下单表单的「下单不收款」说明同样置顶（`renderCheckout` 内 `.query-notice`），原先位于按钮下方的 `.checkout-tip` 已移除。
- 校验错误由 `setQueryError()` / `clearQueryError()` 统一写入顶部错误位，禁止在字段旁另起内联错误，避免出现「两套提示位置」。

## 9. 忘记订单号的补救（`scope` 档）

`scope` 档要求订单号作第二因子，而订单号含随机段、不可猜，因此必须给用户留可走通的找回路径，按可靠性分三层：

| 层级 | 手段 | 实现 | 边界 |
| --- | --- | --- | --- |
| 1 | 下单即本机留档 | `submitOrder` 成功后 `rememberMyOrder(order, phone)` 写入 `localStorage.ls_my_orders`（最多 10 条，`{id, phone, ts}`）；查单页顶部「本机最近下单」胶囊点击即回填订单号 | 换设备 / 清缓存 / 隐私模式会丢失 |
| 2 | 成功页当场留存 | 跳转查单页后顶部绿色横幅常驻显示订单号 + 「复制订单号」，并提示截图保存 | 关掉页面即失效 |
| 3 | 人工客服找回 | 「忘记订单号？」展开说明 + 「联系客服找回订单号」按钮，直接唤起联系方式弹层；客服凭下单手机号核对姓名/金额/收货人后告知订单号 | 需人工响应 |

结论：**不内置「仅凭手机号自助找回订单号」**——那等于把双因子验证退化成单因子，`scope` 档的安全意义就没了。若将来确实需要跨设备自助找回，正确做法是切到 `sms` 档（用短信验证码替代订单号作第二因子，`sms` 档前端不渲染订单号输入框与本机胶囊），而不是在后端放开订单号查询。

