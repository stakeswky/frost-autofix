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

    // Dashboard HTML (support legacy and static-like paths)
    const isDashboardPath = path === "/" || path === "/index.html" || path === "/dashboard" || path === "/dashboard/" || path === "/dashboard/index.html";
    if (isDashboardPath && (request.method === "GET" || request.method === "HEAD")) {
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

// Auto-create installation record if missing (handles race conditions / missed webhooks)
async function ensureInstallation(payload, env) {
  const inst = payload.installation;
  if (!inst?.id) return;
  const login = inst.account?.login || payload.repository?.owner?.login || "unknown";
  const type = inst.account?.type || "User";
  await env.DB.prepare(
    "INSERT OR IGNORE INTO installations (github_installation_id,account_login,account_type) VALUES(?,?,?)"
  ).bind(inst.id, login, type).run();
}

async function handleIssueOpened(payload, env) {
  const issue = payload.issue;
  const repo = payload.repository.full_name;
  const installId = payload.installation?.id;
  if (!installId) return json({ status: "skipped", reason: "no_installation" });
  if (!looksLikeBug(issue.title, issue.body || "", issue.labels || [])) return json({ status: "skipped", reason: "not_bug" });

  await ensureInstallation(payload, env);

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

  await ensureInstallation(payload, env);

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
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>frost-autofix</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--border:#30363d;--text:#e6edf3;--muted:#8b949e;--accent:#58a6ff;--green:#3fb950;--red:#f85149;--yellow:#d29922}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.container{max-width:960px;margin:0 auto;padding:2rem 1rem}
nav{display:flex;align-items:center;justify-content:space-between;padding:1rem 0;margin-bottom:2rem;border-bottom:1px solid var(--border);flex-wrap:wrap;gap:.5rem}
nav .logo{font-size:1.3rem;font-weight:700}nav .logo span{color:var(--accent)}
.nav-links{display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.nav-links a{color:var(--muted);font-size:.9rem;cursor:pointer}.nav-links a:hover,.nav-links a.active{color:var(--text);text-decoration:none}
.lang-sw{font-size:.75rem;padding:2px 8px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--muted);cursor:pointer}.lang-sw:hover{color:var(--text)}
.avatar{width:28px;height:28px;border-radius:50%;vertical-align:middle}
.user-menu{display:flex;align-items:center;gap:.5rem}
.btn{display:inline-block;padding:.5rem 1.25rem;border-radius:6px;font-size:.9rem;font-weight:600;cursor:pointer;border:none;transition:opacity .2s}
.btn:hover{opacity:.85}.btn-primary{background:var(--accent);color:#fff}.btn-outline{background:transparent;color:var(--accent);border:1px solid var(--accent)}.btn-sm{font-size:.8rem;padding:.35rem .75rem}
.btn-danger{background:transparent;color:var(--red);border:1px solid var(--red);font-size:.8rem;padding:.35rem .75rem}
.btn-installed{background:rgba(63,185,80,.15);color:var(--green);border:1px solid rgba(63,185,80,.3);cursor:default;display:inline-block;padding:.5rem 1.25rem;border-radius:6px;font-size:.9rem;font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.5rem;text-align:center}
.stat-card .value{font-size:2.5rem;font-weight:700;color:var(--accent)}.stat-card .label{color:var(--muted);font-size:.9rem;margin-top:.25rem}
.section-title{font-size:1.3rem;margin-bottom:1rem;border-bottom:1px solid var(--border);padding-bottom:.5rem}
.cta{text-align:center;margin:2.5rem 0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:1.5rem}
th,td{padding:.75rem 1rem;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--muted);font-weight:600;font-size:.85rem;text-transform:uppercase}td{font-size:.9rem}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:.75rem;font-weight:600}
.badge-success{background:rgba(63,185,80,.15);color:var(--green)}.badge-failed{background:rgba(248,81,73,.15);color:var(--red)}.badge-queued{background:rgba(88,166,255,.15);color:var(--accent)}.badge-processing{background:rgba(210,153,34,.15);color:var(--yellow)}
.how-it-works{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem}
.step{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.25rem}
.step .num{font-size:1.5rem;font-weight:700;color:var(--accent)}.step p{color:var(--muted);margin-top:.5rem;font-size:.9rem}
.pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1rem;margin-bottom:2rem}
.plan{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:1.5rem}.plan.featured{border-color:var(--accent)}.plan h3{font-size:1.2rem;margin-bottom:.5rem}
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
    <div class="logo">&#x1F9CA; <span>frost-autofix</span></div>
    <div class="nav-links">
      <a id="nav-home" class="active" onclick="showPage('home')"></a>
      <a id="nav-dashboard" style="display:none" onclick="showPage('dashboard')"></a>
      <button class="lang-sw" onclick="toggleLang()" id="lang-btn">EN</button>
      <span id="auth-area"></span>
    </div>
  </nav>

  <div id="page-home" class="page active">
    <header style="text-align:center;margin-bottom:3rem">
      <h1 style="font-size:2.5rem;margin-bottom:.5rem">&#x1F9CA; <span style="color:var(--accent)">frost-autofix</span></h1>
      <p id="hero-desc" style="color:var(--muted);font-size:1.1rem;max-width:600px;margin:0 auto"></p>
    </header>
    <div class="stats">
      <div class="stat-card"><div class="value" id="s-installs">&mdash;</div><div class="label" id="lbl-installs"></div></div>
      <div class="stat-card"><div class="value" id="s-runs">&mdash;</div><div class="label" id="lbl-runs"></div></div>
      <div class="stat-card"><div class="value" id="s-prs">&mdash;</div><div class="label" id="lbl-prs"></div></div>
      <div class="stat-card"><div class="value" id="s-rate">&mdash;</div><div class="label" id="lbl-rate"></div></div>
    </div>
    <div class="cta" id="cta-area"></div>
    <h2 class="section-title" id="how-title"></h2>
    <div class="how-it-works">
      <div class="step"><div class="num">1</div><p id="step1"></p></div>
      <div class="step"><div class="num">2</div><p id="step2"></p></div>
      <div class="step"><div class="num">3</div><p id="step3"></p></div>
      <div class="step"><div class="num">4</div><p id="step4"></p></div>
    </div>
    <h2 class="section-title" id="pricing-title"></h2>
    <div class="pricing">
      <div class="plan"><h3>Free</h3><div class="price">$0 <span>/mo</span></div><ul><li id="free1"></li><li id="free2"></li><li id="free3"></li></ul></div>
      <div class="plan featured"><h3>Pro</h3><div class="price">$29 <span>/mo</span></div><ul><li id="pro1"></li><li id="pro2"></li><li id="pro3"></li><li id="pro4"></li></ul></div>
    </div>
    <div id="activity" style="display:none">
      <h2 class="section-title" id="recent-title"></h2>
      <table><thead><tr><th id="th-repo"></th><th>Issue</th><th>PR</th><th id="th-status"></th><th id="th-date"></th></tr></thead><tbody id="activity-body"></tbody></table>
    </div>
    <div id="loading" style="color:var(--muted);text-align:center;padding:2rem"></div>
  </div>

  <div id="page-dashboard" class="page">
    <h2 class="section-title" id="dash-title-installs"></h2>
    <div id="dash-installations"><div class="empty" id="dash-inst-loading"></div></div>
    <h2 class="section-title" id="dash-title-history"></h2>
    <div id="dash-runs"><div class="empty" id="dash-runs-loading"></div></div>
    <h2 class="section-title" id="dash-title-usage"></h2>
    <div id="dash-usage"><div class="empty" id="dash-usage-loading"></div></div>
  </div>

  <footer><p>frost-autofix &middot; Built by <a href="https://github.com/stakeswky">stakeswky</a></p></footer>
</div>
<script>
var L = localStorage.getItem('frost-lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
var currentUser = null;
var userInstalled = false;

var I18N = {
  zh: {
    nav_home:'首页', nav_dash:'控制台',
    hero:'AI 驱动的 GitHub Bug 自动修复。安装后自动分析 Issue 并提交修复 PR。',
    lbl_installs:'安装数', lbl_runs:'修复次数', lbl_prs:'已创建 PR', lbl_rate:'成功率',
    cta_go:'安装到 GitHub →', cta_done:'✓ 已安装',
    how:'工作原理',
    s1:'在你的仓库安装 GitHub App', s2:'新 Bug Issue 被创建（或评论 /fix）',
    s3:'AI 分析 Issue，定位 Bug', s4:'自动提交最小修复 PR',
    pricing:'定价',
    f1:'每月 5 个修复 PR', f2:'公开仓库', f3:'社区支持',
    p1:'无限修复 PR', p2:'公开 + 私有仓库', p3:'优先处理', p4:'邮件支持',
    recent:'最近活动', th_repo:'仓库', th_status:'状态', th_date:'日期',
    loading:'加载中...', load_fail:'加载失败',
    dash_installs:'你的安装', dash_history:'修复历史', dash_usage:'月度用量',
    no_installs:'未找到安装。', install_link:'去安装 →',
    no_runs:'暂无修复记录', no_usage:'暂无用量数据',
    login:'GitHub 登录', logout:'退出',
    th_issue:'Issue', th_pr:'PR', th_account:'账号', th_month:'月份', th_count:'PR 数'
  },
  en: {
    nav_home:'Home', nav_dash:'Dashboard',
    hero:'AI-powered bug fixer for GitHub. Install the app and we'll automatically analyze issues and submit fix PRs.',
    lbl_installs:'Installations', lbl_runs:'Fix Attempts', lbl_prs:'PRs Created', lbl_rate:'Success Rate',
    cta_go:'Install on GitHub →', cta_done:'✓ Installed',
    how:'How it works',
    s1:'Install the GitHub App on your repo', s2:'A new bug issue is opened (or comment /fix)',
    s3:'AI analyzes the issue, locates the bug', s4:'A minimal fix PR is automatically submitted',
    pricing:'Pricing',
    f1:'5 fix PRs per month', f2:'Public repos', f3:'Community support',
    p1:'Unlimited fix PRs', p2:'Public + private repos', p3:'Priority processing', p4:'Email support',
    recent:'Recent Activity', th_repo:'Repo', th_status:'Status', th_date:'Date',
    loading:'Loading...', load_fail:'Failed to load',
    dash_installs:'Your Installations', dash_history:'Fix History', dash_usage:'Monthly Usage',
    no_installs:'No installations found. ', install_link:'Install the app →',
    no_runs:'No fix runs yet', no_usage:'No usage data yet',
    login:'Sign in with GitHub', logout:'Logout',
    th_issue:'Issue', th_pr:'PR', th_account:'Account', th_month:'Month', th_count:'PRs'
  }
};

function t(k){ return (I18N[L]||I18N.en)[k] || (I18N.en)[k] || k; }

function applyLang(){
  document.getElementById('nav-home').textContent = t('nav_home');
  document.getElementById('nav-dashboard').textContent = t('nav_dash');
  document.getElementById('hero-desc').textContent = t('hero');
  document.getElementById('lbl-installs').textContent = t('lbl_installs');
  document.getElementById('lbl-runs').textContent = t('lbl_runs');
  document.getElementById('lbl-prs').textContent = t('lbl_prs');
  document.getElementById('lbl-rate').textContent = t('lbl_rate');
  document.getElementById('how-title').textContent = t('how');
  document.getElementById('step1').textContent = t('s1');
  document.getElementById('step2').textContent = t('s2');
  document.getElementById('step3').textContent = t('s3');
  document.getElementById('step4').textContent = t('s4');
  document.getElementById('pricing-title').textContent = t('pricing');
  document.getElementById('free1').textContent = t('f1');
  document.getElementById('free2').textContent = t('f2');
  document.getElementById('free3').textContent = t('f3');
  document.getElementById('pro1').textContent = t('p1');
  document.getElementById('pro2').textContent = t('p2');
  document.getElementById('pro3').textContent = t('p3');
  document.getElementById('pro4').textContent = t('p4');
  document.getElementById('recent-title').textContent = t('recent');
  document.getElementById('th-repo').textContent = t('th_repo');
  document.getElementById('th-status').textContent = t('th_status');
  document.getElementById('th-date').textContent = t('th_date');
  document.getElementById('loading').textContent = t('loading');
  document.getElementById('dash-title-installs').textContent = t('dash_installs');
  document.getElementById('dash-title-history').textContent = t('dash_history');
  document.getElementById('dash-title-usage').textContent = t('dash_usage');
  document.getElementById('dash-inst-loading').textContent = t('loading');
  document.getElementById('dash-runs-loading').textContent = t('loading');
  document.getElementById('dash-usage-loading').textContent = t('loading');
  document.getElementById('lang-btn').textContent = L==='zh' ? 'EN' : '中文';
  document.documentElement.lang = L;
  updateCTA();
  updateAuthUI(currentUser);
}

function toggleLang(){
  L = L==='zh' ? 'en' : 'zh';
  localStorage.setItem('frost-lang', L);
  applyLang();
}

function updateCTA(){
  var el = document.getElementById('cta-area');
  if(!el) return;
  if(userInstalled){
    el.innerHTML = '<span class="btn-installed">'+t('cta_done')+'</span>';
  } else {
    el.innerHTML = '<a href="https://github.com/apps/frost-autofix" target="_blank" class="btn btn-primary">'+t('cta_go')+'</a>';
  }
}

function showPage(name){
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('active')});
  document.querySelectorAll('.nav-links a').forEach(function(a){a.classList.remove('active')});
  var pg = document.getElementById('page-'+name);
  var nv = document.getElementById('nav-'+name);
  if(pg) pg.classList.add('active');
  if(nv) nv.classList.add('active');
  if(name==='dashboard' && currentUser) loadDashboard();
  if(name==='home') loadPublicStats();
}

function updateAuthUI(user){
  var area = document.getElementById('auth-area');
  var dashNav = document.getElementById('nav-dashboard');
  if(!area) return;
  if(user){
    dashNav.style.display = '';
    area.innerHTML = '<span class="user-menu"><img src="'+user.avatar+'" class="avatar" alt="'+user.login+'"><span style="font-size:.9rem">'+user.login+'</span><button class="btn-danger" onclick="doLogout()">'+t('logout')+'</button></span>';
  } else {
    dashNav.style.display = 'none';
    area.innerHTML = '<a href="/auth/login" class="btn btn-outline btn-sm">'+t('login')+'</a>';
  }
}

async function checkAuth(){
  try {
    var res = await fetch('/api/me');
    if(!res.ok){ updateAuthUI(null); return; }
    currentUser = await res.json();
    // Check installations to update CTA
    try {
      var ir = await fetch('/api/my/installations');
      if(ir.ok){
        var id = await ir.json();
        if(id.installations && id.installations.length > 0) userInstalled = true;
      }
    } catch(e){}
    updateAuthUI(currentUser);
    updateCTA();
    if(location.hash.includes('dashboard')) showPage('dashboard');
  } catch(e){ updateAuthUI(null); }
}

async function doLogout(){
  await fetch('/auth/logout',{method:'POST'}).catch(function(){});
  currentUser = null; userInstalled = false;
  updateAuthUI(null); updateCTA();
  showPage('home');
}

async function loadPublicStats(){
  try {
    var d = await (await fetch('/api/stats')).json();
    document.getElementById('s-installs').textContent = d.installations;
    document.getElementById('s-runs').textContent = d.total_runs;
    document.getElementById('s-prs').textContent = d.prs_created;
    document.getElementById('s-rate').textContent = d.success_rate+'%';
    var tbody = document.getElementById('activity-body');
    tbody.innerHTML = '';
    if(d.recent && d.recent.length){
      d.recent.forEach(function(r){
        var cls = r.status==='success'?'badge-success':r.status==='failed'?'badge-failed':r.status==='processing'?'badge-processing':'badge-queued';
        var tr = document.createElement('tr');
        tr.innerHTML = '<td><a href="https://github.com/'+r.repo+'">'+r.repo+'</a></td><td>#'+r.issue_number+'</td><td>'+(r.pr_number?'<a href="https://github.com/'+r.repo+'/pull/'+r.pr_number+'" style="color:var(--green)">#'+r.pr_number+'</a>':'&mdash;')+'</td><td><span class="badge '+cls+'">'+r.status+'</span></td><td>'+new Date(r.created_at).toLocaleDateString()+'</td>';
        tbody.appendChild(tr);
      });
      document.getElementById('activity').style.display = '';
    }
    document.getElementById('loading').style.display = 'none';
  } catch(e){ document.getElementById('loading').textContent = t('load_fail'); }
}

async function loadDashboard(){
  try {
    var data = await (await fetch('/api/my/installations')).json();
    var el = document.getElementById('dash-installations');
    if(!data.installations || !data.installations.length){
      el.innerHTML = '<div class="empty">'+t('no_installs')+'<a href="https://github.com/apps/frost-autofix" target="_blank">'+t('install_link')+'</a></div>';
    } else {
      userInstalled = true; updateCTA();
      el.innerHTML = data.installations.map(function(inst){
        var pct = inst.pr_limit>0 ? Math.min(100,Math.round(inst.current_month_prs/inst.pr_limit*100)) : 0;
        var bc = pct>=100?'full':pct>=80?'warn':'ok';
        var limitStr = inst.pr_limit===-1 ? '∞' : inst.pr_limit;
        return '<div class="install-card"><div class="install-header"><span class="account">'+inst.account_login+'</span><span class="plan-badge plan-'+inst.plan+'">'+inst.plan+'</span></div><div class="usage-text">'+inst.current_month_prs+' / '+limitStr+' PRs</div>'+(inst.pr_limit>0?'<div class="usage-bar-wrap"><div class="usage-bar '+bc+'" style="width:'+pct+'%"></div></div>':'')+'</div>';
      }).join('');
    }
  } catch(e){ document.getElementById('dash-installations').innerHTML = '<div class="empty">'+t('load_fail')+'</div>'; }

  try {
    var data = await (await fetch('/api/my/runs')).json();
    var el = document.getElementById('dash-runs');
    if(!data.runs || !data.runs.length){
      el.innerHTML = '<div class="empty">'+t('no_runs')+'</div>';
    } else {
      var h = '<table><thead><tr><th>'+t('th_repo')+'</th><th>'+t('th_issue')+'</th><th>'+t('th_pr')+'</th><th>'+t('th_status')+'</th><th>'+t('th_date')+'</th></tr></thead><tbody>';
      data.runs.forEach(function(r){
        var cls = r.status==='success'?'badge-success':r.status==='failed'?'badge-failed':r.status==='processing'?'badge-processing':'badge-queued';
        h += '<tr><td><a href="https://github.com/'+r.repo+'">'+r.repo+'</a></td><td><a href="https://github.com/'+r.repo+'/issues/'+r.issue_number+'">#'+r.issue_number+'</a></td><td>'+(r.pr_number?'<a href="https://github.com/'+r.repo+'/pull/'+r.pr_number+'" style="color:var(--green)">#'+r.pr_number+'</a>':'&mdash;')+'</td><td><span class="badge '+cls+'">'+r.status+'</span></td><td>'+new Date(r.created_at).toLocaleDateString()+'</td></tr>';
      });
      h += '</tbody></table>';
      el.innerHTML = h;
    }
  } catch(e){ document.getElementById('dash-runs').innerHTML = '<div class="empty">'+t('load_fail')+'</div>'; }

  try {
    var data = await (await fetch('/api/my/usage')).json();
    var el = document.getElementById('dash-usage');
    if(!data.usage || !data.usage.length){
      el.innerHTML = '<div class="empty">'+t('no_usage')+'</div>';
    } else {
      var h = '<table><thead><tr><th>'+t('th_account')+'</th><th>'+t('th_month')+'</th><th>'+t('th_count')+'</th></tr></thead><tbody>';
      data.usage.forEach(function(u){ h += '<tr><td>'+u.account_login+'</td><td>'+u.month+'</td><td>'+u.pr_count+'</td></tr>'; });
      h += '</tbody></table>';
      el.innerHTML = h;
    }
  } catch(e){ document.getElementById('dash-usage').innerHTML = '<div class="empty">'+t('load_fail')+'</div>'; }
}

applyLang();
checkAuth();
loadPublicStats();
</script>
</body>
</html>`;

