/**
 * frost-autofix — GitHub App Webhook Worker + OAuth + Dashboard API
 * v0.3.0: adds GitHub OAuth login, user sessions, authenticated dashboard API
 */

const ENCODER = new TextEncoder();
const DASHBOARD_URL = "https://frost-autofix-dashboard.pages.dev";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // --- Public routes ---
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ status: "ok", app: "frost-autofix", version: "0.3.0" });
    }
    if (url.pathname === "/api/stats" && request.method === "GET") {
      return handleStats(env);
    }
    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleWebhook(request, env);
    }
    if (url.pathname === "/callback" && request.method === "POST") {
      return handleCallback(request, env);
    }

    // --- OAuth routes ---
    if (url.pathname === "/auth/login") {
      return handleOAuthLogin(env);
    }
    if (url.pathname === "/auth/callback") {
      return handleOAuthCallback(url, env);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return handleLogout(request, env);
    }

    // --- Authenticated routes ---
    if (url.pathname === "/api/me") {
      return withAuth(request, env, handleMe);
    }
    if (url.pathname === "/api/my/installations") {
      return withAuth(request, env, handleMyInstallations);
    }
    if (url.pathname === "/api/my/runs") {
      return withAuth(request, env, handleMyRuns);
    }
    if (url.pathname === "/api/my/usage") {
      return withAuth(request, env, handleMyUsage);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ─── Helpers ───

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// ─── OAuth ───

function handleOAuthLogin(env) {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `https://frost-autofix.stawky.workers.dev/auth/callback`,
    scope: "read:user read:org",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://github.com/login/oauth/authorize?${params}`,
      "Set-Cookie": `oauth_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing code", { status: 400 });

  // Exchange code for access token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return new Response("OAuth failed: " + JSON.stringify(tokenData), { status: 400 });
  }

  // Get user info
  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "frost-autofix" },
  });
  const user = await userRes.json();

  // Fetch user's installations of our app
  const installRes = await fetch("https://api.github.com/user/installations", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "frost-autofix" },
  });
  const installData = await installRes.json();

  // Create session
  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(); // 30 days

  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (token, github_user_id, github_login, github_avatar, access_token, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(sessionToken, user.id, user.login, user.avatar_url, tokenData.access_token, expires).run();

  // Link user to their installations
  if (installData.installations) {
    for (const inst of installData.installations) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO user_installations (github_user_id, installation_id) VALUES (?, ?)"
      ).bind(user.id, inst.id).run();
    }
  }

  // Redirect to dashboard with token in URL fragment (cross-domain safe)
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${DASHBOARD_URL}/#token=${sessionToken}`,
    },
  });
}

async function handleLogout(request, env) {
  const session = getSessionToken(request);
  if (session) {
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(session).run();
  }
  return json({ ok: true }, 200);
}

// ─── Auth middleware ───

function getSessionToken(request) {
  // Check Authorization header first
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  // Then cookie
  const cookies = request.headers.get("Cookie") || "";
  const match = cookies.match(/session=([^;]+)/);
  return match?.[1] || null;
}

async function getSession(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  const session = await env.DB.prepare(
    "SELECT * FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).bind(token).first();
  return session;
}

async function withAuth(request, env, handler) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "unauthorized" }, 401);
  return handler(session, env);
}

// ─── Authenticated API handlers ───

async function handleMe(session, env) {
  return json({
    user: {
      id: session.github_user_id,
      login: session.github_login,
      avatar: session.github_avatar,
    },
  });
}

async function handleMyInstallations(session, env) {
  const rows = await env.DB.prepare(`
    SELECT i.* FROM installations i
    JOIN user_installations ui ON ui.installation_id = i.github_installation_id
    WHERE ui.github_user_id = ?
    ORDER BY i.created_at DESC
  `).bind(session.github_user_id).all();

  // Enrich with current month usage
  const month = new Date().toISOString().slice(0, 7);
  const results = [];
  for (const inst of rows.results || []) {
    const usage = await env.DB.prepare(
      "SELECT pr_count FROM usage_monthly WHERE installation_id = ? AND month = ?"
    ).bind(inst.github_installation_id, month).first();
    results.push({
      ...inst,
      current_month_prs: usage?.pr_count || 0,
    });
  }

  return json({ installations: results });
}

async function handleMyRuns(session, env) {
  const runs = await env.DB.prepare(`
    SELECT fr.* FROM fix_runs fr
    JOIN user_installations ui ON ui.installation_id = fr.installation_id
    WHERE ui.github_user_id = ?
    ORDER BY fr.created_at DESC
    LIMIT 50
  `).bind(session.github_user_id).all();

  return json({ runs: runs.results || [] });
}

async function handleMyUsage(session, env) {
  const rows = await env.DB.prepare(`
    SELECT um.*, i.account_login FROM usage_monthly um
    JOIN user_installations ui ON ui.installation_id = um.installation_id
    JOIN installations i ON i.github_installation_id = um.installation_id
    WHERE ui.github_user_id = ?
    ORDER BY um.month DESC
    LIMIT 12
  `).bind(session.github_user_id).all();

  return json({ usage: rows.results || [] });
}

// ─── Public stats ───

async function handleStats(env) {
  const installs = await env.DB.prepare("SELECT COUNT(*) as c FROM installations").first();
  const runs = await env.DB.prepare("SELECT COUNT(*) as c FROM fix_runs").first();
  const prs = await env.DB.prepare("SELECT COUNT(*) as c FROM fix_runs WHERE status = 'success'").first();
  const rate = runs.c > 0 ? Math.round((prs.c / runs.c) * 100) : 0;

  const recent = await env.DB.prepare(
    "SELECT repo, issue_number, pr_number, status, created_at FROM fix_runs ORDER BY created_at DESC LIMIT 10"
  ).all();

  return json({
    installations: installs.c,
    total_runs: runs.c,
    prs_created: prs.c,
    success_rate: rate,
    recent: recent.results || [],
  });
}

// ─── Webhook handling ───

async function handleWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !env.GITHUB_WEBHOOK_SECRET) {
    return new Response("Missing signature or secret", { status: 401 });
  }
  const valid = await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body);

  if (event === "issues" && payload.action === "opened") {
    return handleIssueOpened(payload, env);
  }
  if (event === "issue_comment" && payload.action === "created") {
    const comment = payload.comment?.body?.trim().toLowerCase();
    if (comment === "/fix" || comment === "/autofix") {
      return handleFixCommand(payload, env);
    }
  }
  if (event === "installation" && payload.action === "created") {
    return handleInstallation(payload, env);
  }

  return json({ status: "ignored", event });
}

async function handleInstallation(payload, env) {
  const inst = payload.installation;
  await env.DB.prepare(
    "INSERT OR IGNORE INTO installations (github_installation_id, account_login, account_type) VALUES (?, ?, ?)"
  ).bind(inst.id, inst.account.login, inst.account.type).run();
  return json({ status: "installation_recorded" });
}

async function handleIssueOpened(payload, env) {
  const issue = payload.issue;
  const repo = payload.repository.full_name;
  const installId = payload.installation?.id;

  if (!installId) return json({ status: "no_installation" });

  // Ensure installation exists
  await env.DB.prepare(
    "INSERT OR IGNORE INTO installations (github_installation_id, account_login, account_type) VALUES (?, ?, ?)"
  ).bind(installId, payload.repository.owner.login, payload.repository.owner.type || "User").run();

  // Check usage limit
  const install = await env.DB.prepare(
    "SELECT plan, pr_limit FROM installations WHERE github_installation_id = ?"
  ).bind(installId).first();
  const month = new Date().toISOString().slice(0, 7);
  const usage = await env.DB.prepare(
    "SELECT pr_count FROM usage_monthly WHERE installation_id = ? AND month = ?"
  ).bind(installId, month).first();

  if (usage && usage.pr_count >= (install?.pr_limit || 5)) {
    return json({ status: "limit_reached", pr_count: usage.pr_count, limit: install?.pr_limit });
  }

  if (!looksLikeBug(issue.title, issue.body || "", issue.labels || [])) {
    return json({ status: "not_a_bug" });
  }

  // Record fix run
  await env.DB.prepare(
    "INSERT INTO fix_runs (installation_id, repo, issue_number, status) VALUES (?, ?, ?, 'queued')"
  ).bind(installId, repo, issue.number).run();

  // Forward to backend
  try {
    await fetch(env.BACKEND_URL || "https://autofix.14530529.xyz/fix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.BACKEND_TOKEN}`,
      },
      body: JSON.stringify({
        installation_id: installId,
        repo,
        issue_number: issue.number,
        issue_title: issue.title,
        issue_body: issue.body,
      }),
    });
  } catch (e) {
    // Queue file fallback handled by backend polling
  }

  return json({ status: "queued", repo, issue: issue.number });
}

async function handleFixCommand(payload, env) {
  const issue = payload.issue;
  const repo = payload.repository.full_name;
  const installId = payload.installation?.id;
  if (!installId) return json({ status: "no_installation" });

  await env.DB.prepare(
    "INSERT OR IGNORE INTO installations (github_installation_id, account_login, account_type) VALUES (?, ?, ?)"
  ).bind(installId, payload.repository.owner.login, payload.repository.owner.type || "User").run();

  await env.DB.prepare(
    "INSERT INTO fix_runs (installation_id, repo, issue_number, status) VALUES (?, ?, ?, 'queued')"
  ).bind(installId, repo, issue.number).run();

  try {
    await fetch(env.BACKEND_URL || "https://autofix.14530529.xyz/fix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.BACKEND_TOKEN}`,
      },
      body: JSON.stringify({
        installation_id: installId,
        repo,
        issue_number: issue.number,
        issue_title: issue.title,
        issue_body: issue.body,
      }),
    });
  } catch (e) {}

  return json({ status: "queued", repo, issue: issue.number });
}

async function handleCallback(request, env) {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.BACKEND_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const data = await request.json();
  const { installation_id, repo, issue_number, pr_number, status, error_message } = data;

  await env.DB.prepare(
    "UPDATE fix_runs SET status = ?, pr_number = ?, error_message = ?, completed_at = datetime('now') WHERE installation_id = ? AND repo = ? AND issue_number = ? AND status IN ('queued', 'processing')"
  ).bind(status, pr_number || null, error_message || null, installation_id, repo, issue_number).run();

  if (status === "success" && pr_number) {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare(
      "INSERT INTO usage_monthly (installation_id, month, pr_count) VALUES (?, ?, 1) ON CONFLICT(installation_id, month) DO UPDATE SET pr_count = pr_count + 1"
    ).bind(installation_id, month).run();
  }

  return json({ status: "updated" });
}

// ─── Utilities ───

function looksLikeBug(title, body, labels) {
  const labelNames = labels.map(l => l.name.toLowerCase());
  if (labelNames.some(l => l.includes("bug") || l.includes("fix") || l.includes("error"))) return true;
  const text = `${title} ${body}`.toLowerCase();
  return ["error", "bug", "crash", "fail", "broken", "exception", "traceback", "typeerror", "referenceerror", "undefined"]
    .some(kw => text.includes(kw));
}

async function verifySignature(body, signature, secret) {
  const key = await crypto.subtle.importKey("raw", ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return signature === expected;
}
