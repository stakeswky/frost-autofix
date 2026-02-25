#!/usr/bin/env node
/**
 * frost-autofix backend v2 — receives tasks from CF Worker, writes to queue
 * Runs on port 9800
 */

const http = require("http");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = 9800;
const BACKEND_TOKEN = process.env.BACKEND_TOKEN || "a1d61d560225762f338a087eaea17ae61a360da6";
const QUEUE_DIR = "/root/.openclaw/autonomy/autofix-queue";

if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && req.url === "/health") {
    const queueCount = fs.readdirSync(QUEUE_DIR).filter(f => f.endsWith(".json")).length;
    res.end(JSON.stringify({ status: "ok", queue: queueCount }));
    return;
  }

  // Accept both /autofix and /enqueue for compatibility
  if (req.method === "POST" && (req.url === "/autofix" || req.url === "/enqueue")) {
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
      // Normalize field names (Worker sends issue_number, old format sends issue)
      task.issue_number = task.issue_number || task.issue;
      task.issue_title = task.issue_title || task.title || "";
      task.issue_body = task.issue_body || task.body || "";

      const taskId = `${task.repo.replace("/", "-")}-${task.issue_number}-${Date.now()}`;
      const taskFile = path.join(QUEUE_DIR, `${taskId}.json`);
      fs.writeFileSync(taskFile, JSON.stringify(task, null, 2));

      console.log(`[${new Date().toISOString()}] Queued: ${taskId}`);
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

server.listen(PORT, "0.0.0.0", () => {
  console.log(`frost-autofix backend v2 listening on :${PORT}`);
});
