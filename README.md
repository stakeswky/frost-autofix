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
- **Dashboard**: Cloudflare Pages

## Support

Open an issue in this repo or reach out on [GitHub](https://github.com/stakeswky).

---

Built by [@stakeswky](https://github.com/stakeswky)
