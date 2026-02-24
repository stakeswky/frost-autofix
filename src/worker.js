/**
 * frost-autofix — GitHub App Webhook Worker
 * Receives issue events, routes to analysis pipeline, creates fix PRs.
 * D1 tracks installations, fix runs, and monthly usage.
 */

const ENCODER = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", app: "frost-autofix", version: "0.2.0" });
    }

    // API: stats (public dashboard data)
    if (url.pathname === "/api/stats" && request.method === "GET") {
      return handleStats(env);
    }

    // API: installation usage
    if (url.pathname.startsWith("/api/usage/") && request.method === "GET") {
      const installId = url.pathname.split("/").pop();
      return handleUsage(installId, env);
    }

    // Webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }

    // Webhook callback from backend (PR result)
    if (url.pathname === "/callback" && request.method === "POST") {
      return handleCallback(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function handleWebhook(request, env) {
  const body = await request.text();

  // Verify signature
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !env.GITHUB_WEBHOOK_SECRET) {
    return new Response("Missing signature or secret", { status: 401 });
  }

  const valid = await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body);

  // Route events
  if (event === "issues" && payload.action === "opened") {
    return handleIssueOpened(payload, env);
  }

  if (event === "issue_comment" && payload.action === "created") {
    const comment = payload.comment?.body?.trim().toLowerCase();
    if (comment === "/fix" || comment === "/autofix") {
      return handleFixCommand(payload, env);
    }
  }

  // Acknowledge but ignore other events
  return new Response(JSON.stringify({ status: "ignored", event }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function handleIssueOpened(payload, env) {
  const { issue, repository, installation } = payload;
  const repo = repository.full_name;
  const issueNumber = issue.number;
  const title = issue.title;
  const body = issue.body || "";
  const installationId = installation?.id;

  // Check if issue looks like a bug report
  if (!looksLikeBug(title, body, issue.labels)) {
    return json({ status: "skipped", reason: "not_a_bug", repo, issue: issueNumber });
  }

  // Check usage limit
  if (installationId && env.DB) {
    const month = new Date().toISOString().slice(0, 7);
    const usage = await env.DB.prepare(
      "SELECT pr_count FROM usage_monthly WHERE installation_id = ? AND month = ?"
    ).bind(installationId, month).first();

    const install = await env.DB.prepare(
      "SELECT plan, pr_limit FROM installations WHERE github_installation_id = ?"
    ).bind(installationId).first();

    const limit = install?.pr_limit || 5;
    if (usage && usage.pr_count >= limit) {
      return json({ status: "skipped", reason: "usage_limit", repo, issue: issueNumber, limit });
    }
  }

  // Record fix run
  if (installationId && env.DB) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO installations (github_installation_id, account_login, account_type) VALUES (?, ?, ?)"
    ).bind(installationId, repository.owner.login, repository.owner.type).run();

    await env.DB.prepare(
      "INSERT INTO fix_runs (installation_id, repo, issue_number, status) VALUES (?, ?, ?, 'queued')"
    ).bind(installationId, repo, issueNumber).run();
  }

  // Queue for analysis
  const task = {
    type: "issue_opened",
    repo,
    issue: issueNumber,
    title,
    body: body.substring(0, 4000),
    labels: issue.labels.map(l => l.name),
    installation_id: installationId,
    timestamp: new Date().toISOString(),
  };

  try {
    const backendUrl = env.BACKEND_URL || "https://autofix.14530529.xyz/autofix";
    const resp = await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.BACKEND_TOKEN || ""}`,
      },
      body: JSON.stringify(task),
    });

    const respBody = await resp.text();
    return json({
      status: resp.ok ? "queued" : "backend_error",
      repo, issue: issueNumber,
      backend_status: resp.status,
    });
  } catch (err) {
    return json({ status: "error", error: err.message }, 502);
  }
}

async function handleFixCommand(payload, env) {
  const { issue, repository, installation } = payload;
  const repo = repository.full_name;
  const issueNumber = issue.number;
  const installationId = installation?.id;

  if (installationId && env.DB) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO installations (github_installation_id, account_login, account_type) VALUES (?, ?, ?)"
    ).bind(installationId, repository.owner.login, repository.owner.type).run();

    await env.DB.prepare(
      "INSERT INTO fix_runs (installation_id, repo, issue_number, status) VALUES (?, ?, ?, 'queued')"
    ).bind(installationId, repo, issueNumber).run();
  }

  const task = {
    type: "fix_command",
    repo,
    issue: issueNumber,
    title: issue.title,
    body: (issue.body || "").substring(0, 4000),
    labels: issue.labels.map(l => l.name),
    installation_id: installationId,
    timestamp: new Date().toISOString(),
  };

  try {
    const backendUrl = env.BACKEND_URL || "https://autofix.14530529.xyz/autofix";
    await fetch(backendUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.BACKEND_TOKEN || ""}`,
      },
      body: JSON.stringify(task),
    });
    return json({ status: "queued", repo, issue: issueNumber });
  } catch (err) {
    return json({ status: "error", error: err.message }, 502);
  }
}

// Backend calls this after fix completes
async function handleCallback(request, env) {
  const body = await request.json();
  const { repo, issue_number, pr_number, status, installation_id } = body;

  if (!env.DB) return json({ status: "ok", note: "no DB" });

  // Update fix run
  if (status === "success" && pr_number) {
    await env.DB.prepare(
      "UPDATE fix_runs SET status = 'success', pr_number = ?, completed_at = datetime('now') WHERE repo = ? AND issue_number = ? AND status IN ('queued', 'processing')"
    ).bind(pr_number, repo, issue_number).run();

    // Increment monthly usage
    if (installation_id) {
      const month = new Date().toISOString().slice(0, 7);
      await env.DB.prepare(
        "INSERT INTO usage_monthly (installation_id, month, pr_count) VALUES (?, ?, 1) ON CONFLICT(installation_id, month) DO UPDATE SET pr_count = pr_count + 1"
      ).bind(installation_id, month).run();
    }
  } else {
    await env.DB.prepare(
      "UPDATE fix_runs SET status = ?, error_message = ?, completed_at = datetime('now') WHERE repo = ? AND issue_number = ? AND status IN ('queued', 'processing')"
    ).bind(status || "failed", body.error || null, repo, issue_number).run();
  }

  return json({ status: "ok" });
}

// Public stats for dashboard
async function handleStats(env) {
  if (!env.DB) return json({ error: "no DB" }, 500);

  const totals = await env.DB.prepare(
    "SELECT COUNT(*) as total_runs, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success, SUM(CASE WHEN pr_number IS NOT NULL THEN 1 ELSE 0 END) as prs_created FROM fix_runs"
  ).first();

  const installs = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM installations"
  ).first();

  const recent = await env.DB.prepare(
    "SELECT repo, issue_number, pr_number, status, created_at FROM fix_runs ORDER BY created_at DESC LIMIT 10"
  ).all();

  return json({
    installations: installs?.count || 0,
    total_runs: totals?.total_runs || 0,
    success_rate: totals?.total_runs ? ((totals.success / totals.total_runs) * 100).toFixed(1) : "0",
    prs_created: totals?.prs_created || 0,
    recent: recent.results || [],
  });
}

// Usage for a specific installation
async function handleUsage(installId, env) {
  if (!env.DB) return json({ error: "no DB" }, 500);

  const install = await env.DB.prepare(
    "SELECT * FROM installations WHERE github_installation_id = ?"
  ).bind(installId).first();

  if (!install) return json({ error: "not found" }, 404);

  const month = new Date().toISOString().slice(0, 7);
  const usage = await env.DB.prepare(
    "SELECT pr_count FROM usage_monthly WHERE installation_id = ? AND month = ?"
  ).bind(installId, month).first();

  const runs = await env.DB.prepare(
    "SELECT repo, issue_number, pr_number, status, created_at FROM fix_runs WHERE installation_id = ? ORDER BY created_at DESC LIMIT 20"
  ).bind(installId).all();

  return json({
    installation: install,
    current_month: month,
    pr_count: usage?.pr_count || 0,
    pr_limit: install.pr_limit,
    runs: runs.results || [],
  });
}

function looksLikeBug(title, body, labels) {
  const labelNames = labels.map(l => l.name.toLowerCase());
  if (labelNames.some(l => l.includes("bug") || l.includes("fix") || l.includes("error"))) {
    return true;
  }
  const text = `${title} ${body}`.toLowerCase();
  const bugKeywords = ["error", "bug", "crash", "fail", "broken", "exception", "traceback", "typeerror", "referenceerror", "undefined"];
  return bugKeywords.some(kw => text.includes(kw));
}

async function verifySignature(body, signature, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
  return signature === expected;
}
