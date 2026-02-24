-- frost-autofix D1 schema

-- 安装记录
CREATE TABLE IF NOT EXISTS installations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_installation_id INTEGER UNIQUE NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'User', -- User | Organization
  plan TEXT NOT NULL DEFAULT 'free',          -- free | pro
  pr_limit INTEGER NOT NULL DEFAULT 5,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- PR 记录
CREATE TABLE IF NOT EXISTS fix_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  pr_number INTEGER,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | processing | success | failed | skipped
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (installation_id) REFERENCES installations(github_installation_id)
);

-- 月度用量
CREATE TABLE IF NOT EXISTS usage_monthly (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  installation_id INTEGER NOT NULL,
  month TEXT NOT NULL, -- YYYY-MM
  pr_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(installation_id, month),
  FOREIGN KEY (installation_id) REFERENCES installations(github_installation_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_fix_runs_repo ON fix_runs(repo, created_at);
CREATE INDEX IF NOT EXISTS idx_fix_runs_installation ON fix_runs(installation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_monthly_lookup ON usage_monthly(installation_id, month);
