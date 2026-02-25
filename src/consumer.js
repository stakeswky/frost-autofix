#!/usr/bin/env node
/**
 * frost-autofix queue consumer v2
 * Polls autofix-queue/ for tasks, spawns OpenClaw sub-agents to fix issues.
 * Improvements: better prompts, result callback to Worker, structured error handling.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const http = require("http");
const https = require("https");

const QUEUE_DIR = "/root/.openclaw/autonomy/autofix-queue";
const PROCESSING_DIR = "/root/.openclaw/autonomy/autofix-processing";
const DONE_DIR = "/root/.openclaw/autonomy/autofix-done";
const MAX_CONCURRENT = 1;
const WORKER_CALLBACK = process.env.WORKER_CALLBACK || "https://frost-autofix.stawky.workers.dev/callback";
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || "a1d61d560225762f338a087eaea17ae61a360da6";

[QUEUE_DIR, PROCESSING_DIR, DONE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

async function main() {
  const processing = fs.readdirSync(PROCESSING_DIR).filter(f => f.endsWith(".json"));
  if (processing.length >= MAX_CONCURRENT) {
    console.log(`[${ts()}] Already processing ${processing.length} task(s), skipping.`);
    return;
  }

  const queued = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json")).sort();
  if (queued.length === 0) {
    console.log(`[${ts()}] Queue empty.`);
    return;
  }

  const taskFile = queued[0];
  const srcPath = path.join(QUEUE_DIR, taskFile);
  const procPath = path.join(PROCESSING_DIR, taskFile);

  fs.renameSync(srcPath, procPath);
  const task = JSON.parse(fs.readFileSync(procPath, "utf-8"));

  console.log(`[${ts()}] Processing: ${task.repo}#${task.issue_number} — ${task.issue_title || "untitled"}`);

  try {
    const prompt = buildFixPrompt(task);
    const result = spawnFixAgent(task, prompt);

    task.result = result;
    task.completed_at = new Date().toISOString();
    fs.writeFileSync(path.join(DONE_DIR, taskFile), JSON.stringify(task, null, 2));
    fs.unlinkSync(procPath);

    console.log(`[${ts()}] Completed: ${task.repo}#${task.issue_number}`);
  } catch (err) {
    console.error(`[${ts()}] Failed: ${task.repo}#${task.issue_number} — ${err.message}`);
    task.retries = (task.retries || 0) + 1;
    task.last_error = err.message;

    if (task.retries >= 3) {
      task.result = { status: "failed", error: err.message };
      task.completed_at = new Date().toISOString();
      fs.writeFileSync(path.join(DONE_DIR, taskFile), JSON.stringify(task, null, 2));
      fs.unlinkSync(procPath);

      // Report failure to Worker
      callbackWorker(task, "failed", null, err.message);
    } else {
      fs.writeFileSync(srcPath, JSON.stringify(task, null, 2));
      fs.unlinkSync(procPath);
    }
  }
}

function buildFixPrompt(task) {
  const { repo, issue_number, issue_title, issue_body } = task;
  const repoDir = `/root/repos/${repo.replace("/", "--")}`;

  return `你是 frost-autofix，一个自动修复 GitHub issue 的 AI agent。

## 任务
修复 ${repo} 仓库的 issue #${issue_number}。

## Issue 信息
标题: ${issue_title || "(无标题)"}
内容:
${issue_body || "(无内容)"}

## 执行步骤

### 1. 获取代码
\`\`\`bash
if [ -d "${repoDir}" ]; then
  cd "${repoDir}" && git fetch origin && git checkout main 2>/dev/null || git checkout master && git pull
else
  git clone https://github.com/${repo}.git "${repoDir}" && cd "${repoDir}"
fi
\`\`\`

### 2. 分析 Issue
- 仔细阅读 issue 标题和内容
- 识别错误类型（运行时错误、逻辑错误、类型错误、配置问题等）
- 如果 issue 包含错误日志/堆栈，从中提取关键信息（文件名、行号、错误消息）

### 3. 定位代码
- 根据 issue 中的线索（文件名、函数名、错误消息）搜索相关代码
- 使用 grep/ripgrep 搜索关键词
- 阅读相关文件，理解上下文

### 4. 实现修复
- 只修改必要的代码，最小侵入性
- 遵循项目现有的代码风格
- 如果项目有测试，确保修复不破坏现有测试

### 5. 验证
- 如果项目有 lint/typecheck 命令，运行一下确认没有新错误
- 如果有简单的测试命令，运行测试

### 6. 提交 PR
\`\`\`bash
cd "${repoDir}"
git checkout -b fix/issue-${issue_number}
git add -A
git commit -m "fix: <简短描述> (closes #${issue_number})"
gh pr create --title "fix: <简短描述> (closes #${issue_number})" --body "Fixes #${issue_number}

## Changes
<描述你做了什么改动>

## Root Cause
<简述 bug 的根因>

---
*Automated fix by [frost-autofix](https://github.com/apps/frost-autofix)*"
\`\`\`

## 重要约束
- 如果 issue 信息不足以定位 bug，在 issue 下用 \`gh issue comment\` 留言说明需要更多信息，然后停止
- 不要做 issue 没提到的额外重构或优化
- 如果修复需要改动超过 5 个文件，先评估是否真的必要
- PR 分支名: fix/issue-${issue_number}
- 提交后输出 PR URL`;
}

function spawnFixAgent(task, prompt) {
  const gatewayUrl = "http://127.0.0.1:4319";
  const payload = JSON.stringify({
    task: prompt,
    mode: "run",
    label: `autofix-${task.repo.replace("/", "-")}-${task.issue_number}`,
    runTimeoutSeconds: 600,
  });

  try {
    const result = execSync(
      `curl -s -X POST "${gatewayUrl}/api/sessions/spawn" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`,
      { timeout: 15000, encoding: "utf-8" }
    );
    console.log(`[${ts()}] Spawn result: ${result.trim().slice(0, 200)}`);
    return { status: "spawned", response: result.trim() };
  } catch (e) {
    throw new Error(`Spawn failed: ${e.message}`);
  }
}

function callbackWorker(task, status, prNumber, errorMessage) {
  const data = JSON.stringify({
    installation_id: task.installation_id,
    repo: task.repo,
    issue_number: task.issue_number,
    status,
    pr_number: prNumber || null,
    error_message: errorMessage || null,
  });

  try {
    execSync(
      `curl -s -X POST "${WORKER_CALLBACK}" -H "Content-Type: application/json" -H "Authorization: Bearer ${BACKEND_TOKEN}" -d '${data.replace(/'/g, "'\\''")}'`,
      { timeout: 10000, encoding: "utf-8" }
    );
    console.log(`[${ts()}] Callback sent: ${status}`);
  } catch (e) {
    console.error(`[${ts()}] Callback failed: ${e.message}`);
  }
}

function ts() { return new Date().toISOString(); }

main().catch(err => {
  console.error(`[${ts()}] Fatal: ${err.message}`);
  process.exit(1);
});
