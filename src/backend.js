#!/usr/bin/env node
/**
 * frost-autofix backend — receives tasks from CF Worker, spawns fix agents
 * Runs on port 9800
 */

const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 9800;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || "frost-autofix-secret";
const QUEUE_DIR = "/root/.openclaw/autonomy/autofix-queue";

// Ensure queue dir exists
if (!fs.existsSync(QUEUE_DIR)) {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    res.end(JSON.stringify({ status: "ok", queue: countQueue() }));
    return;
  }

  if (req.method === "POST" && req.url === "/autofix") {
    // Auth check
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${BACKEND_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const task = JSON.parse(body);
      const taskId = `${task.repo.replace("/", "-")}-${task.issue}-${Date.now()}`;
      const taskFile = path.join(QUEUE_DIR, `${taskId}.json`);

      // Write task to queue
      fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));

      console.log(`[${new Date().toISOString()}] Queued: ${taskId} (${task.type})`);

      // Emit event
      try {
        execSync(
          `bash /root/openclaw/workspace/scripts/autonomy/emit-event.sh autofix_queued ` +
          `repo=${task.repo} issue=${task.issue} type=${task.type}`,
          { timeout: 5000 }
        );
      } catch (e) {
        console.error("Failed to emit event:", e.message);
      }

      res.end(JSON.stringify({ status: "queued", taskId }));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

function countQueue() {
  try {
    return fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`frost-autofix backend listening on :${PORT}`);
});
