# CI/CD 分工：Cloudflare Workers Builds 发布 + GitHub Actions 只做校验

Lightning-shop 的**发布链路在 Cloudflare 侧**，GitHub Actions **不再部署**。

| 职责 | 归属 | 触发 |
|---|---|---|
| 生产发布（含 D1 迁移） | Cloudflare Workers Builds | 推送到生产分支 |
| 预览部署（每个功能分支独立 URL） | Cloudflare Workers Builds（Worker Previews） | 推送到非生产分支 |
| 校验、审核、检查（语法/配置/迁移幂等/密钥边界/发布入口守卫） | GitHub Actions `ci.yml` | PR 到 dev/main、push dev |
| 生产只读冒烟（缓存头、登录限流） | GitHub Actions `verify-prod.yml` | 手动 |
| D1 每日备份归档到 R2 | GitHub Actions `backup-d1.yml` | 每日定时 / 手动 |

## 1. Cloudflare 侧配置（Worker → 设置 → 构建）

### 1.1 生产（Production）

| 字段 | 值 |
|---|---|
| Git 存储库 | `veryspicy/lightning-shop` |
| 生产分支 | `main`（发布闸门：dev → PR → main） |
| 构建命令 | `npm ci` |
| 部署命令 | `node scripts/d1-migrate.mjs --remote && npx wrangler deploy` |
| 根目录 | `/` |
| 构建监视路径 | 包括 `*`；排除 `node_modules/**`、`.git/` |
| API 令牌 | `cf-mail build token`（需含 D1 编辑、Workers 脚本编辑、KV 编辑、R2 编辑） |

部署命令把 **D1 迁移放在 `wrangler deploy` 之前**：先按 `migrations/*.sql` 顺序幂等迁移（账本 `_d1_migrations`），迁移失败即中止，不会出现"新代码上线但库里没有新表/新列"。

### 1.2 预览（Preview，即"预览基础"标签页）

| 字段 | 值 |
|---|---|
| 预览分支构建 | 开启 |
| 构建命令 | `npm ci` |
| 预览命令 | `npx wrangler preview`（Wrangler v4 的 Worker Previews，勿改 `versions upload`） |

启用后，向非生产分支推送会生成 Preview URL（Worker → Previews，也会尝试在 PR 上回帖），用于合并前验证；预览不提升为生产部署。

## 2. GitHub Actions 只做校验

`ci.yml` 的检查项：

1. `node --check` 语法检查（`src/`、`public/`、`scripts/`）
2. `wrangler.toml` 关键 binding 完整性（`main`、`DB`、`KV`）
3. `d1-migrate.mjs --local` 空库顺序执行 + 二次执行幂等 + 账本覆盖全部迁移文件
4. `.dev.vars` 未被 Git 跟踪
5. **发布入口守卫** `scripts/check-no-deploy.mjs`：workflow 中一旦出现 `wrangler deploy`、`versions upload`、`secret put`、`d1 execute --remote`、`kv bulk put --remote`、`r2 object put`（`d1-backup/` 归档除外）、`upload-r2.mjs`、`sync-prod-to-seed.mjs` 等发布或写生产动作即失败，防止两套 CI/CD 双写生产

`.github/workflows/deploy.yml` 已删除。部署动作只允许出现在 Cloudflare Workers Builds 配置里。

## 3. 数据初始化（不再是自动发布的一部分）

首次部署或换新环境时，以下动作**手动**执行（本地或 Cloudflare 侧），不经 GitHub Actions：

```bash
npm run seed                                         # 生成 data/kv-bulk.json
npx wrangler kv bulk put data/kv-bulk.json --binding=KV --remote
npm run upload:images                                # assets/images → R2
npx wrangler secret put ADMIN_PASSWORD               # 后台密码
```

生产 KV 已有数据时不要重复 `bulk put`（会覆盖同 key）；R2 图片是幂等覆盖写。

## 4. 日常发布流程

```bash
# 1) 功能分支开发，推送即触发 Workers Builds 预览构建
git push origin feature/xxx

# 2) 通过 PR 合并到 dev，GitHub Actions 跑校验

# 3) 合并 dev → main 触发生产构建：d1-migrate → wrangler deploy
git push origin main
```

查看结果：Cloudflare → Workers & Pages → lightning-shop → Deployments（Build history / Previews），构建日志保留 90 天。

## 5. 常见问题

- **构建失败在 `npm ci`**：确认 `package-lock.json` 已提交且与 `package.json` 一致
- **构建失败在迁移**：`d1-migrate.mjs` 会拒绝执行"已上线迁移文件被改过"的情况，需新增迁移文件而非改旧文件
- **预览构建失败**：预览基础页签的构建命令必须也是 `npm ci`，否则缺依赖
- **部署成功但线上没变**：确认推送落在生产分支，且 Deployments 里该次构建状态为成功
- **令牌权限不足**：D1 迁移要求令牌含 D1 编辑权限

## 6. 敏感信息边界

- `.dev.vars`、`temp/`、日志、`node_modules/` 已由 `.gitignore` 排除
- `ADMIN_PASSWORD` 只存在于 Cloudflare Secrets，构建环境不注入、不入库
- `wrangler.toml` 含 KV/R2/D1 资源 ID，属资源标识符非凭据
