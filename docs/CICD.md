# GitHub Actions CICD 部署固化

Lightning-shop 已启用 GitHub Actions 自动化部署：**push 到 `main` 即自动构建并部署到 Cloudflare Workers + KV + R2**，全程无需手动 wrangler 操作。

## 1. 触发方式

- `git push origin main`：推送即部署（含文档、配置变更）
- GitHub 网页 Actions 页 → Run workflow：手动触发

## 2. 流水线步骤（.github/workflows/deploy.yml）

| 步骤 | 动作 |
|---|---|
| checkout | 拉取仓库代码 |
| setup-node | Node 20 + npm 依赖缓存 |
| npm ci | 安装依赖（package-lock.json） |
| secret put | 注入 `ADMIN_PASSWORD` 到 Cloudflare Worker |
| seed + kv:bulk put | 生成 KV 种子数据并写入生产命名空间（`--preview false`） |
| upload:images | 上传产品图到 R2 bucket |
| deploy | `wrangler deploy` 上线 |

## 3. 前置配置（一次性）

### 3.1 GitHub Secrets（仓库 Settings → Secrets and variables → Actions）

| Secret 名 | 值来源 |
|---|---|
| `CF_API_TOKEN` | Cloudflare API Token（见 3.2） |
| `CF_ACCOUNT_ID` | Cloudflare 账号 ID（Dashboard 右下角，本账号 `422dd0994559b384a1a0e568cd0c677c`） |
| `ADMIN_PASSWORD` | 供应链管理后台密码（生产强密码） |

### 3.2 Cloudflare API Token 权限

创建位置：My Profile → API Tokens → Create Token（模板 Edit Cloudflare Workers 后补充）：

| 权限 | 级别 |
|---|---|
| Account → Cloudflare Workers Scripts | Edit |
| Account → Cloudflare Workers KV Storage | Edit |
| Account → Cloudflare Workers R2 Storage | Edit |
| Account → Account Settings | Read |

### 3.3 本地仓库代理（中国大陆网络）

本仓库已配置 git 代理（写入仓库级 `.git/config`，仅影响本仓库）：

```bash
git config http.proxy http://127.0.0.1:10809
```

代理端口变化时需同步修改；无需代理的环境可移除：

```bash
git config --unset http.proxy
```

## 4. 日常提交流程

```bash
git add -A
git commit -m "feat: ..."
git push origin main   # 自动触发部署
```

推送后到 https://github.com/veryspicy/lightning-shop/actions 查看运行状态，绿色对勾即部署成功，可访问 https://lightning-shop.headache.workers.dev 验证。

## 5. 常见问题

- **KV 数据未更新**：确认 `wrangler kv:bulk put --binding=KV --preview false` 带 `--preview false`（toml 同时配置 id/preview_id 时必须显式指定）
- **Secret 变更**：修改 GitHub 仓库 Secret `ADMIN_PASSWORD` 后重新 push 即可同步到 Cloudflare
- **部署失败**：先看 Actions 日志，常见为 API Token 权限不足或 KV/R2 资源未创建

## 6. 敏感信息边界

- `.dev.vars`、`temp/`、日志、`node_modules/` 已由 `.gitignore` 排除，禁止提交
- `ADMIN_PASSWORD` 仅存在于 GitHub Secrets 与 Cloudflare Secrets，**禁止**写入任何代码、配置或文档
- `wrangler.toml` 含真实 KV/R2 资源 ID，属资源标识符非凭据；若仓库设为 Private 可进一步收敛
