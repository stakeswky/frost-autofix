/**
 * frost-autofix — All-in-one Worker: Webhook + OAuth + API + Dashboard
 * v0.4.0: single Worker serves everything, no Pages dependency
 */

const ENCODER = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Dashboard HTML
    if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : DASHBOARD_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    // Health
    if (path === "/health") return json({ status: "ok", version: "0.4.0" });

    // Public API
    if (path === "/api/stats" && request.method === "GET") return handleStats(env);

    // Webhook
    if (path === "/webhook" && request.method === "POST") return handleWebhook(request, env);
    if (path === "/callback" && request.method === "POST") return handleCallback(request, env);

    // OAuth
    if (path === "/auth/login") return handleOAuthLogin(url, env);
    if (path === "/auth/callback") return handleOAuthCallback(url, env);
    if (path === "/auth/logout" && request.method === "POST") return handleLogout(request, env);

    // Authenticated API
    if (path === "/api/me") return withAuth(request, env, handleMe);
    if (path === "/api/my/installations") return withAuth(request, env, handleMyInstallations);
    if (path === "/api/my/runs") return withAuth(request, env, handleMyRuns);
    if (path === "/api/my/usage") return withAuth(request, env, handleMyUsage);

    return new Response("Not Found", { status: 404 });
  },
};

// ─── Helpers ───

function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders() } });
}

// ─── OAuth ───

function handleOAuthLogin(url, env) {
  const origin = url.origin;
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    scope: "read:user read:org",
    state: crypto.randomUUID(),
  });
  return Response.redirect(`https://github.com/login/oauth/authorize?${params}`, 302);
}

async function handleOAuthCallback(url, env) {
  const code = url.searchParams.get("code");
  if (!code) return new Response("Missing code", { status: 400 });

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) return json({ error: "oauth_failed", detail: tokenData }, 400);

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "frost-autofix" },
  });
  const user = await userRes.json();

  const installRes = await fetch("https://api.github.com/user/installations", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "frost-autofix" },
  });
  const installData = await installRes.json();

  const sessionToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();

  await env.DB.prepare(
    "INSERT OR REPLACE INTO sessions (token,github_user_id,github_login,github_avatar,access_token,expires_at) VALUES(?,?,?,?,?,?)"
  ).bind(sessionToken, user.id, user.login, user.avatar_url, tokenData.access_token, expires).run();

  if (installData.installations) {
    for (const inst of installData.installations) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_installations (github_user_id,installation_id) VALUES(?,?)").bind(user.id, inst.id).run();
    }
  }

  // Same-origin redirect — cookie works perfectly
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${url.origin}/#dashboard`,
      "Set-Cookie": `session=${sessionToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`,
    },
  });
}

async function handleLogout(request, env) {
  const token = getSessionToken(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token=?").bind(token).run();
  return new Response(null, {
    status: 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json", "Set-Cookie": "session=; Path=/; Max-Age=0" },
  });
}

// ─── Auth middleware ───

function getSessionToken(request) {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const cookies = request.headers.get("Cookie") || "";
  const m = cookies.match(/session=([^;]+)/);
  return m?.[1] || null;
}

async function getSession(request, env) {
  const token = getSessionToken(request);
  if (!token) return null;
  return env.DB.prepare("SELECT * FROM sessions WHERE token=? AND expires_at>datetime('now')").bind(token).first();
}

async function withAuth(request, env, handler) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "unauthorized" }, 401);
  return handler(session, env);
}

// ─── Authenticated handlers ───

async function handleMe(session) {
  return json({ login: session.github_login, avatar: session.github_avatar, user_id: session.github_user_id });
}

async function handleMyInstallations(session, env) {
  const rows = await env.DB.prepare(
    "SELECT i.* FROM installations i JOIN user_installations ui ON ui.installation_id=i.github_installation_id WHERE ui.github_user_id=? ORDER BY i.created_at DESC"
  ).bind(session.github_user_id).all();
  const month = new Date().toISOString().slice(0, 7);
  const results = [];
  for (const inst of rows.results || []) {
    const usage = await env.DB.prepare("SELECT pr_count FROM usage_monthly WHERE installation_id=? AND month=?").bind(inst.github_installation_id, month).first();
    results.push({ ...inst, current_month_prs: usage?.pr_count || 0 });
  }
  return json({ installations: results });
}

async function handleMyRuns(session, env) {
  const runs = await env.DB.prepare(
    "SELECT fr.* FROM fix_runs fr JOIN user_installations ui ON ui.installation_id=fr.installation_id WHERE ui.github_user_id=? ORDER BY fr.created_at DESC LIMIT 50"
  ).bind(session.github_user_id).all();
  return json({ runs: runs.results || [] });
}

async function handleMyUsage(session, env) {
  const rows = await env.DB.prepare(
    "SELECT um.*,i.account_login FROM usage_monthly um JOIN user_installations ui ON ui.installation_id=um.installation_id JOIN installations i ON i.github_installation_id=um.installation_id WHERE ui.github_user_id=? ORDER BY um.month DESC LIMIT 12"
  ).bind(session.github_user_id).all();
  return json({ usage: rows.results || [] });
}

// ─── Public stats ───

async function handleStats(env) {
  const installs = await env.DB.prepare("SELECT COUNT(*) as c FROM installations").first();
  const runs = await env.DB.prepare("SELECT COUNT(*) as c FROM fix_runs").first();
  const prs = await env.DB.prepare("SELECT COUNT(*) as c FROM fix_runs WHERE status='success'").first();
  const rate = runs.c > 0 ? Math.round((prs.c / runs.c) * 100) : 0;
  const recent = await env.DB.prepare("SELECT repo,issue_number,pr_number,status,created_at FROM fix_runs ORDER BY created_at DESC LIMIT 10").all();
  return json({ installations: installs.c, total_runs: runs.c, prs_created: prs.c, success_rate: rate, recent: recent.results || [] });
}

// ─── Webhook ───

async function handleWebhook(request, env) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!signature || !env.GITHUB_WEBHOOK_SECRET) return new Response("Missing signature", { status: 401 });
  if (!(await verifySignature(body, signature, env.GITHUB_WEBHOOK_SECRET))) return new Response("Invalid signature", { status: 401 });

  const event = request.headers.get("x-github-event");
  const payload = JSON.parse(body);

  // Installation lifecycle
  if (event === "installation") return handleInstallationEvent(payload, env);
  if (event === "installation_repositories") return handleInstallationRepos(payload, env);

  // Fix triggers
  if (event === "issues" && payload.action === "opened") return handleIssueOpened(payload, env);
  if (event === "issue_comment" && payload.action === "created") {
    const cmd = payload.comment?.body?.trim().toLowerCase();
    if (cmd === "/fix" || cmd === "/autofix") return handleFixCommand(payload, env);
  }
  return json({ status: "ignored", event });
}

async function handleInstallationEvent(payload, env) {
  const inst = payload.installation;
  const action = payload.action;

  if (action === "created") {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO installations (github_installation_id,account_login,account_type) VALUES(?,?,?)"
    ).bind(inst.id, inst.account.login, inst.account.type).run();
    // Link sender to installation
    if (payload.sender?.id) {
      await env.DB.prepare("INSERT OR IGNORE INTO user_installations (github_user_id,installation_id) VALUES(?,?)").bind(payload.sender.id, inst.id).run();
    }
  } else if (action === "deleted") {
    await env.DB.prepare("DELETE FROM installations WHERE github_installation_id=?").bind(inst.id).run();
    await env.DB.prepare("DELETE FROM user_installations WHERE installation_id=?").bind(inst.id).run();
  } else if (action === "suspend") {
    await env.DB.prepare("UPDATE installations SET plan='suspended',updated_at=datetime('now') WHERE github_installation_id=?").bind(inst.id).run();
  } else if (action === "unsuspend") {
    await env.DB.prepare("UPDATE installations SET plan='free',updated_at=datetime('now') WHERE github_installation_id=?").bind(inst.id).run();
  }
  return json({ status: "ok", action });
}

async function handleInstallationRepos(payload, env) {
  // When repos are added/removed from an installation — just acknowledge for now
  // Could track per-repo config later
  return json({ status: "ok", action: payload.action, repos_added: payload.repositories_added?.length || 0, repos_removed: payload.repositories_removed?.length || 0 });
}

async function handleIssueOpened(payload, env) {
  const issue = payload.issue;
  const repo = payload.repository.full_name;
  const installId = payload.installation?.id;
  if (!installId) return json({ status: "skipped", reason: "no_installation" });
  if (!looksLikeBug(issue.title, issue.body || "", issue.labels || [])) return json({ status: "skipped", reason: "not_bug" });

  const month = new Date().toISOString().slice(0, 7);
  const install = await env.DB.prepare("SELECT * FROM installations WHERE github_installation_id=?").bind(installId).first();
  if (install) {
    const usage = await env.DB.prepare("SELECT pr_count FROM usage_monthly WHERE installation_id=? AND month=?").bind(installId, month).first();
    if (install.pr_limit > 0 && (usage?.pr_count || 0) >= install.pr_limit) return json({ status: "skipped", reason: "limit_reached" });
  }

  await env.DB.prepare("INSERT INTO fix_runs (installation_id,repo,issue_number,status) VALUES(?,?,?,?)").bind(installId, repo, issue.number, "queued").run();

  // Forward to backend
  try {
    await fetch(env.BACKEND_URL || "https://autofix.14530529.xyz/autofix", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.BACKEND_TOKEN}` },
      body: JSON.stringify({ installation_id: installId, repo, issue_number: issue.number, issue_title: issue.title, issue_body: issue.body }),
    });
  } catch (e) { /* best effort */ }

  return json({ status: "queued", repo, issue: issue.number });
}

async function handleFixCommand(payload, env) {
  const issue = payload.issue;
  const repo = payload.repository.full_name;
  const installId = payload.installation?.id;
  if (!installId) return json({ status: "skipped" });

  await env.DB.prepare("INSERT INTO fix_runs (installation_id,repo,issue_number,status) VALUES(?,?,?,?)").bind(installId, repo, issue.number, "queued").run();
  try {
    await fetch(env.BACKEND_URL || "https://autofix.14530529.xyz/autofix", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.BACKEND_TOKEN}` },
      body: JSON.stringify({ installation_id: installId, repo, issue_number: issue.number, issue_title: issue.title, issue_body: issue.body }),
    });
  } catch (e) { /* best effort */ }
  return json({ status: "queued" });
}

async function handleCallback(request, env) {
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${env.BACKEND_TOKEN}`) return new Response("Unauthorized", { status: 401 });
  const data = await request.json();
  await env.DB.prepare(
    "UPDATE fix_runs SET status=?,pr_number=?,error_message=?,completed_at=datetime('now') WHERE installation_id=? AND repo=? AND issue_number=? AND status IN('queued','processing')"
  ).bind(data.status, data.pr_number || null, data.error_message || null, data.installation_id, data.repo, data.issue_number).run();
  if (data.status === "success" && data.pr_number) {
    const month = new Date().toISOString().slice(0, 7);
    await env.DB.prepare("INSERT INTO usage_monthly(installation_id,month,pr_count) VALUES(?,?,1) ON CONFLICT(installation_id,month) DO UPDATE SET pr_count=pr_count+1").bind(data.installation_id, month).run();
  }
  return json({ status: "updated" });
}

// ─── Utils ───

function looksLikeBug(title, body, labels) {
  if (labels.map(l => l.name.toLowerCase()).some(l => l.includes("bug") || l.includes("fix") || l.includes("error"))) return true;
  const text = `${title} ${body}`.toLowerCase();
  return ["error","bug","crash","fail","broken","exception","traceback","typeerror","referenceerror","undefined"].some(kw => text.includes(kw));
}

async function verifySignature(body, signature, secret) {
  const key = await crypto.subtle.importKey("raw", ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, ENCODER.encode(body));
  const expected = "sha256=" + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return signature === expected;
}

// ─── Dashboard HTML (inline, same-origin) ───

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>frost-autofix — AI Bug Fixer for GitHub</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:2rem 1rem}
nav{display:flex;align-items:center;justify-content:space-between;padding:1rem 0;margin-bottom:2rem;border-bottom:1px solid var(--border)}
nav .logo{font-size:1.3rem;font-weight:700}nav .logo span{color:var(--accent)}
.nav-links{display:flex;gap:1.5rem;align-items:center}
.nav-links a{color:var(--muted);font-size:.9rem;cursor:pointer}.nav-links a:hover,.nav-links a.active{color:var(--text);text-decoration:none}
.avatar{width:28px;height:28px;border-radius:50%;vertical-align:middle}
.user-menu{display:flex;align-items:center;gap:.5rem}
.btn{display:inline-block;padding:.5rem 1.25rem;border-radius:6px;font-size:.9rem;font-weight:600;cursor:pointer;border:none;transition:opacity .2s}
.btn:hover{opacity:.85}.btn-primary{background:var(--accent);color:#fff}
.btn-outline{background:transparent;color:var(--accent);border:1px solid var(--accent)}
.btn-sm{font-size:.8rem;padding:.35rem .75rem}
.btn-danger{background:transparent;color:var(--red);border:1px solid var(--red);font-size:.8rem;padding:.35rem .75rem}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;text-align:center}
.stat-card .value{font-size:2.5rem;font-weight:700;color:var(--accent)}.stat-card .label{color:var(--muted);font-size:.9rem;margin-top:.25rem}
.section-title{font-size:1.3rem;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}
.cta{text-align:center;margin:2.5rem 0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:1.5rem}
th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:.85rem;text-transform:uppercase}td{font-size:.9rem}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:600}
.badge-success{background:rgba(63,185,80,.15);color:var(--green)}
.badge-failed{background:rgba(248,81,73,.15);color:var(--red)}
.badge-queued{background:rgba(88,166,255,.15);color:var(--accent)}
.badge-processing{background:rgba(210,153,34,.15);color:var(--yellow)}
.how-it-works{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
.step{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.25rem}
.step .num{font-size:1.5rem;font-weight:700;color:var(--accent)}.step p{color:var(--muted);margin-top:.5rem;font-size:.9rem}
.pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:2rem}
.plan{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.5rem}
.plan.featured{border-color:var(--accent)}.plan h3{font-size:1.2rem;margin-bottom:.5rem}
.plan .price{font-size:2rem;font-weight:700;color:var(--accent)}.plan .price span{font-size:.9rem;color:var(--muted);font-weight:400}
.plan ul{list-style:none;margin-top:1rem}.plan ul li{padding:.3rem 0;color:var(--muted);font-size:.9rem}.plan ul li::before{content:"\\2713 ";color:var(--green)}
.usage-bar-wrap{background:var(--border);border-radius:4px;height:8px;margin-top:.5rem;overflow:hidden}
.usage-bar{height:100%;border-radius:4px;transition:width .3s}.usage-bar.ok{background:var(--green)}.usage-bar.warn{background:var(--yellow)}.usage-bar.full{background:var(--red)}
.usage-text{font-size:.85rem;color:var(--muted);margin-top:.25rem}
.install-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.25rem;margin-bottom:1rem}
.install-card .install-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:.75rem}
.install-card .account{font-weight:600;font-size:1.05rem}
.plan-badge{font-size:.75rem;padding:2px 10px;border-radius:12px;text-transform:uppercase;font-weight:700}
.plan-free{background:rgba(88,166,255,.15);color:var(--accent)}.plan-pro{background:rgba(63,185,80,.15);color:var(--green)}
.page{display:none}.page.active{display:block}
footer{text-align:center;color:var(--muted);font-size:.8rem;margin-top:3rem;padding-top:1rem;border-top:1px solid var(--border)}
.empty{text-align:center;color:var(--muted);padding:2rem}
</style>
</head>
<body>
<div class="container">
  <nav>
    <div class="logo">\\u{1F9CA} <span>frost-autofix</span></div>
    <div class="nav-links">
      <a id="nav-home" class="active" onclick="showPage('home')">Home</a>
      <a id="nav-dashboard" style="display:none" onclick="showPage('dashboard')">Dashboard</a>
      <span id="auth-area"></span>
    </div>
  </nav>

  <!-- HOME -->
  <div id="page-home" class="page active">
    <header style="text-align:center;margin-bottom:3rem">
      <h1 style="font-size:2.5rem;margin-bottom:.5rem">\\u{1F9CA} <span style="color:var(--accent)">frost-autofix</span></h1>
      <p style="color:var(--muted);font-size:1.1rem;max-width:600px;margin:0 auto">AI-powered bug fixer for GitHub. Install the app, and we'll automatically analyze new issues and submit fix PRs.</p>
    </header>
    <div class="stats">
      <div class="stat-card"><div class="value" id="s-installs">—</div><div class="label">Installations</div></div>
      <div class="stat-card"><div class="value" id="s-runs">—</div><div class="label">Fix Attempts</div></div>
      <div class="stat-card"><div class="value" id="s-prs">—</div><div class="label">PRs Created</div></div>
      <div class="stat-card"><div class="value" id="s-rate">—</div><div class="label">Success Rate</div></div>
    </div>
    <div class="cta"><a href="https://github.com/apps/frost-autofix" target="_blank" class="btn btn-primary">Install on GitHub \\u2192</a></div>
    <h2 class="section-title">How it works</h2>
    <div class="how-it-works">
      <div class="step"><div class="num">1</div><p>Install the GitHub App on your repo</p></div>
      <div class="step"><div class="num">2</div><p>A new bug issue is opened (or comment <code>/fix</code>)</p></div>
      <div class="step"><div class="num">3</div><p>AI analyzes the issue, locates the bug</p></div>
      <div class="step"><div class="num">4</div><p>A minimal fix PR is automatically submitted</p></div>
    </div>
    <h2 class="section-title">Pricing</h2>
    <div class="pricing">
      <div class="plan"><h3>Free</h3><div class="price">$0 <span>/month</span></div><ul><li>5 fix PRs per month</li><li>Public repos</li><li>Community support</li></ul></div>
      <div class="plan featured"><h3>Pro</h3><div class="price">$29 <span>/month</span></div><ul><li>Unlimited fix PRs</li><li>Public + private repos</li><li>Priority processing</li><li>Email support</li></ul></div>
    </div>
    <div id="activity" style="display:none">
      <h2 class="section-title">Recent Activity</h2>
      <table><thead><tr><th>Repo</th><th>Issue</th><th>PR</th><th>Status</th><th>Date</th></tr></thead><tbody id="activity-body"></tbody></table>
    </div>
    <div id="loading" style="color:var(--muted);text-align:center;padding:2rem">Loading stats...</div>
  </div>

  <!-- DASHBOARD -->
  <div id="page-dashboard" class="page">
    <h2 class="section-title">Your Installations</h2>
    <div id="dash-installations"><div class="empty">Loading...</div></div>
    <h2 class="section-title">Fix History</h2>
    <div id="dash-runs"><div class="empty">Loading...</div></div>
    <h2 class="section-title">Monthly Usage</h2>
    <div id="dash-usage"><div class="empty">Loading...</div></div>
  </div>

  <footer><p>frost-autofix · Built by <a href="https://github.com/stakeswky">stakeswky</a></p></footer>
</div>

<script>
let currentUser = null;

async function checkAuth() {
  try {
    const res = await fetch("/api/me");
    if (!res.ok) return updateAuthUI(null);
    currentUser = await res.json();
    updateAuthUI(currentUser);
    if (location.hash.includes("dashboard")) showPage("dashboard");
  } catch(e) { updateAuthUI(null); }
}

function updateAuthUI(user) {
  const area = document.getElementById("auth-area");
  const dashNav = document.getElementById("nav-dashboard");
  if (user) {
    dashNav.style.display = "";
    area.innerHTML = '<span class="user-menu"><img src="'+user.avatar+'" class="avatar" alt="'+user.login+'"><span style="font-size:.9rem">'+user.login+'</span><button class="btn-danger" onclick="logout()">Logout</button></span>';
  } else {
    dashNav.style.display = "none";
    area.innerHTML = '<a href="/auth/login" class="btn btn-outline btn-sm">Sign in with GitHub</a>';
  }
}

async function logout() {
  await fetch("/auth/logout", { method: "POST" }).catch(()=>{});
  currentUser = null;
  updateAuthUI(null);
  showPage("home");
}

function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-links a").forEach(a => a.classList.remove("active"));
  var pg = document.getElementById("page-"+name);
  var nv = document.getElementById("nav-"+name);
  if (pg) pg.classList.add("active");
  if (nv) nv.classList.add("active");
  if (name === "dashboard" && currentUser) loadDashboard();
  if (name === "home") loadPublicStats();
}

async function loadPublicStats() {
  try {
    const d = await (await fetch("/api/stats")).json();
    document.getElementById("s-installs").textContent = d.installations;
    document.getElementById("s-runs").textContent = d.total_runs;
    document.getElementById("s-prs").textContent = d.prs_created;
    document.getElementById("s-rate").textContent = d.success_rate + "%";
    const tbody = document.getElementById("activity-body");
    tbody.innerHTML = "";
    if (d.recent && d.recent.length) {
      d.recent.forEach(function(r) {
        var cls = r.status==="success"?"badge-success":r.status==="failed"?"badge-failed":r.status==="processing"?"badge-processing":"badge-queued";
        var tr = document.createElement("tr");
        tr.innerHTML = '<td><a href="https://github.com/'+r.repo+'">'+r.repo+'</a></td><td>#'+r.issue_number+'</td><td>'+(r.pr_number?'<a href="https://github.com/'+r.repo+'/pull/'+r.pr_number+'" style="color:var(--green)">#'+r.pr_number+'</a>':"—")+'</td><td><span class="badge '+cls+'">'+r.status+'</span></td><td>'+new Date(r.created_at).toLocaleDateString()+'</td>';
        tbody.appendChild(tr);
      });
      document.getElementById("activity").style.display = "";
    }
    document.getElementById("loading").style.display = "none";
  } catch(e) { document.getElementById("loading").textContent = "Could not load stats"; }
}

async function loadDashboard() {
  try {
    var data = await (await fetch("/api/my/installations")).json();
    var el = document.getElementById("dash-installations");
    if (!data.installations || !data.installations.length) {
      el.innerHTML = '<div class="empty">No installations found. <a href="https://github.com/apps/frost-autofix" target="_blank">Install the app \\u2192</a></div>';
    } else {
      el.innerHTML = data.installations.map(function(inst) {
        var pct = inst.pr_limit > 0 ? Math.min(100, Math.round(inst.current_month_prs / inst.pr_limit * 100)) : 0;
        var bc = pct >= 100 ? "full" : pct >= 80 ? "warn" : "ok";
        return '<div class="install-card"><div class="install-header"><span class="account">'+inst.account_login+'</span><span class="plan-badge plan-'+inst.plan+'">'+inst.plan+'</span></div><div class="usage-text">'+inst.current_month_prs+' / '+(inst.pr_limit===-1?"\\u221E":inst.pr_limit)+' PRs this month</div>'+(inst.pr_limit>0?'<div class="usage-bar-wrap"><div class="usage-bar '+bc+'" style="width:'+pct+'%"></div></div>':"")+'</div>';
      }).join("");
    }
  } catch(e) { document.getElementById("dash-installations").innerHTML = '<div class="empty">Failed to load</div>'; }

  try {
    var data = await (await fetch("/api/my/runs")).json();
    var el = document.getElementById("dash-runs");
    if (!data.runs || !data.runs.length) {
      el.innerHTML = '<div class="empty">No fix runs yet</div>';
    } else {
      var h = '<table><thead><tr><th>Repo</th><th>Issue</th><th>PR</th><th>Status</th><th>Date</th></tr></thead><tbody>';
      data.runs.forEach(function(r) {
        var cls = r.status==="success"?"badge-success":r.status==="failed"?"badge-failed":r.status==="processing"?"badge-processing":"badge-queued";
        h += '<tr><td><a href="https://github.com/'+r.repo+'">'+r.repo+'</a></td><td><a href="https://github.com/'+r.repo+'/issues/'+r.issue_number+'">#'+r.issue_number+'</a></td><td>'+(r.pr_number?'<a href="https://github.com/'+r.repo+'/pull/'+r.pr_number+'" style="color:var(--green)">#'+r.pr_number+'</a>':"—")+'</td><td><span class="badge '+cls+'">'+r.status+'</span></td><td>'+new Date(r.created_at).toLocaleDateString()+'</td></tr>';
      });
      h += '</tbody></table>';
      el.innerHTML = h;
    }
  } catch(e) { document.getElementById("dash-runs").innerHTML = '<div class="empty">Failed to load</div>'; }

  try {
    var data = await (await fetch("/api/my/usage")).json();
    var el = document.getElementById("dash-usage");
    if (!data.usage || !data.usage.length) {
      el.innerHTML = '<div class="empty">No usage data yet</div>';
    } else {
      var h = '<table><thead><tr><th>Account</th><th>Month</th><th>PRs</th></tr></thead><tbody>';
      data.usage.forEach(function(u) { h += '<tr><td>'+u.account_login+'</td><td>'+u.month+'</td><td>'+u.pr_count+'</td></tr>'; });
      h += '</tbody></table>';
      el.innerHTML = h;
    }
  } catch(e) { document.getElementById("dash-usage").innerHTML = '<div class="empty">Failed to load</div>'; }
}

checkAuth();
loadPublicStats();
</script>
</body>
</html>`;
