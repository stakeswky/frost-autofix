# 🧊 frost-autofix

AI-powered bug fixer for GitHub. Install the app, and it automatically analyzes new bug issues and submits fix PRs.

## How it works

1. **Install** the GitHub App on your repository
2. A new issue is opened with a `bug` label (or someone comments `/fix`)
3. AI analyzes the issue, locates the bug in your codebase
4. A minimal fix PR is automatically submitted

## Features

- 🔍 Automatic bug detection from issue titles, labels, and descriptions
- 🛠️ AI-powered code analysis and fix generation
- 📝 Clean, minimal PRs that fix only the reported issue
- ⚡ Processes new issues within minutes
- 🔒 Secure webhook verification (SHA-256)
- 📊 Usage tracking and monthly limits

## Pricing

| Plan | Price | PRs/month | Repos |
|------|-------|-----------|-------|
| Free | $0 | 5 | Public |
| Pro | $29/mo | Unlimited | Public + Private |

## Quick Start

1. [Install frost-autofix](https://github.com/apps/frost-autofix) on your repository
2. Open a bug issue (or add the `bug` label to an existing one)
3. Wait for the fix PR to appear

You can also trigger a fix manually by commenting `/fix` on any issue.

## Dashboard

View live stats at [frost-autofix-dashboard.pages.dev](https://frost-autofix-dashboard.pages.dev)


## GitHub 自动构建与 Cloudflare 自动部署

已提供 GitHub Actions 工作流：`.github/workflows/deploy-cloudflare.yml`。

当你向 `main` 分支 push 代码时，会自动执行：

1. 安装依赖
2. 校验 Worker 配置（`wrangler deploy --dry-run`）
3. 部署 **Cloudflare Worker**

> 当前项目前后端都在 Worker 中，工作流不再部署 Pages。

### 你需要在 GitHub 仓库里配置

进入：`Settings -> Secrets and variables -> Actions`

#### Secrets
- `CLOUDFLARE_API_TOKEN`：Cloudflare API Token（需要 Worker Scripts 编辑权限）
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账户 ID

### 建议的 Cloudflare Token 权限
- `Account / Cloudflare Workers:Edit`
- `Zone / Zone:Read`（部分场景需要）


### 本地查看登录后的 Dashboard（Mock 数据）

不需要真实 GitHub 登录，直接打开：

- `/?mock=1#dashboard`（Worker 部署）
- `dashboard/index.html?mock=1#dashboard`（本地静态文件预览）

该模式会注入演示用户和示例安装/运行/用量数据，适合产品演示和截图。

## Track Record

| Repository | Issue | PR | Status |
|-----------|-------|-----|--------|
| stakeswky/doomsday-shelter | #3 | #4 | ✅ Merged |
| vllm-project/vllm | #32588 | #35159 | 🔄 Open |
| unslothai/unsloth-zoo | #4073 | #510 | 🔄 Open |

## How it's built

- **Webhook processing**: Cloudflare Worker (edge, <50ms response)
- **Analysis & fix**: AI agent with full codebase access
- **Usage tracking**: Cloudflare D1 (SQLite at the edge)
- **Dashboard**: Cloudflare Worker (same app)

## Support

Open an issue in this repo or reach out on [GitHub](https://github.com/stakeswky).

---

Built by [@stakeswky](https://github.com/stakeswky)
