#!/usr/bin/env node
/**
 * frost-autofix queue consumer
 * Polls autofix-queue/ for tasks, spawns OpenClaw sub-agents to fix issues, submits PRs.
 * Runs as a cron or systemd timer every 5 minutes.
 */

const fs = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const QUEUE_DIR = "/root/.openclaw/autonomy/autofix-queue";
const PROCESSING_DIR = "/root/.openclaw/autonomy/autofix-processing";
const DONE_DIR = "/root/.openclaw/autonomy/autofix-done";
const MAX_CONCURRENT = 1; // one fix at a time to avoid resource contention
const PEM_PATH = "/root/.openclaw/secrets/github-app-2934515.pem";

// Ensure dirs exist
[QUEUE_DIR, PROCESSING_DIR, DONE_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

async function main() {
  // Check how many are currently processing
  const processing = fs.readdirSync(PROCESSING_DIR).filter(f => f.endsWith(".json"));
  if (processing.length >= MAX_CONCURRENT) {
    console.log(`[${ts()}] Already processing ${processing.length} task(s), skipping.`);
    return;
  }

  // Get queued tasks, oldest first
  const queued = fs.readdirSync(QUEUE_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();

  if (queued.length === 0) {
    console.log(`[${ts()}] Queue empty.`);
    return;
  }

  const taskFile = queued[0];
  const srcPath = path.join(QUEUE_DIR, taskFile);
  const procPath = path.join(PROCESSING_DIR, taskFile);

  // Move to processing
  fs.renameSync(srcPath, procPath);
  const task = JSON.parse(fs.readFileSync(procPath, "utf-8"));

  console.log(`[${ts()}] Processing: ${task.repo}#${task.issue} — ${task.title || task.type}`);

  try {
    // Build the sub-agent prompt
    const prompt = buildFixPrompt(task);

    // Spawn via OpenClaw sessions_spawn (using the CLI)
    const result = spawnFixAgent(task, prompt);

    // Mark done
    task.result = result;
    task.completed_at = new Date().toISOString();
    const donePath = path.join(DONE_DIR, taskFile);
    fs.writeFileSync(donePath, JSON.stringify(task, null, 2));
    fs.unlinkSync(procPath);

    // Emit event
    emitEvent("autofix_completed", `repo=${task.repo} issue=${task.issue} status=done`);
    console.log(`[${ts()}] Completed: ${task.repo}#${task.issue}`);
  } catch (err) {
    console.error(`[${ts()}] Failed: ${task.repo}#${task.issue} — ${err.message}`);
    // Move back to queue with retry count
    task.retries = (task.retries || 0) + 1;
    task.last_error = err.message;

    if (task.retries >= 3) {
      // Give up, move to done with failure
      task.result = { status: "failed", error: err.message };
      task.completed_at = new Date().toISOString();
      const donePath = path.join(DONE_DIR, taskFile);
      fs.writeFileSync(donePath, JSON.stringify(task, null, 2));
      fs.unlinkSync(procPath);
      emitEvent("autofix_failed", `repo=${task.repo} issue=${task.issue} retries=${task.retries}`);
    } else {
      // Retry — move back to queue
      fs.writeFileSync(srcPath, JSON.stringify(task, null, 2));
      fs.unlinkSync(procPath);
    }
  }
}

function buildFixPrompt(task) {
  const repo = task.repo;
  const issue = task.issue;
  const title = task.title || "";
  const body = task.body || "";
  const labels = (task.labels || []).join(", ");

  return `你需要为 ${repo} 仓库修复 issue #${issue}。

Issue 标题: ${title}
Issue 内容:
${body}

标签: ${labels}

步骤:
1. Clone 仓库到 /root/repos/${repo.replace("/", "--")} (如已存在则 git pull)
2. 仔细阅读 issue 内容，理解 bug 的根因
3. 在代码中定位相关文件
4. 实现最小侵入性的修复
5. 确保修复不会引入新问题
6. 用 GitHub 用户 stakeswky 创建 PR 到主分支，引用 issue #${issue}
7. PR 标题格式: fix: <简短描述> (closes #${issue})

注意:
- 只修复 issue 描述的问题，不要做额外重构
- 如果 issue 信息不足以定位 bug，在 issue 下留评论说明需要更多信息，不要提 PR
- 如果修复涉及多个文件，确保所有改动都是必要的
- 提交前检查代码风格是否与项目一致`;
}

function spawnFixAgent(task, prompt) {
  // Use openclaw CLI to spawn a sub-agent
  // The gateway API endpoint for sessions_spawn
  const gatewayUrl = "http://127.0.0.1:4319";

  // Write prompt to temp file to avoid shell escaping issues
  const tmpFile = `/tmp/autofix-prompt-${task.issue}.txt`;
  fs.writeFileSync(tmpFile, prompt);

  try {
    const cmd = `curl -s -X POST "${gatewayUrl}/api/sessions/spawn" \
      -H "Content-Type: application/json" \
      -d '${JSON.stringify({
        task: prompt,
        mode: "run",
        label: `autofix-${task.repo.replace("/", "-")}-${task.issue}`,
        runTimeoutSeconds: 600
      })}'`;

    const result = execSync(cmd, { timeout: 15000, encoding: "utf-8" });
    console.log(`[${ts()}] Spawn result: ${result.trim()}`);
    return { status: "spawned", response: result.trim() };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function emitEvent(type, kvPairs) {
  try {
    execSync(
      `bash /root/openclaw/workspace/scripts/autonomy/emit-event.sh ${type} ${kvPairs}`,
      { timeout: 5000 }
    );
  } catch (e) {
    console.error(`Failed to emit event: ${e.message}`);
  }
}

function ts() {
  return new Date().toISOString();
}

main().catch(err => {
  console.error(`[${ts()}] Fatal: ${err.message}`);
  process.exit(1);
});
