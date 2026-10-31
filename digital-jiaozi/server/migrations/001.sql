PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS dj_migrations (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS dj_wallets (
  user_id TEXT NOT NULL, activity_id TEXT NOT NULL, title TEXT NOT NULL, serial TEXT NOT NULL,
  lifetime INTEGER NOT NULL DEFAULT 0 CHECK(lifetime>=0), available INTEGER NOT NULL DEFAULT 0 CHECK(available>=0),
  unlocked_at INTEGER, PRIMARY KEY(user_id,activity_id)
);
CREATE TABLE IF NOT EXISTS dj_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, activity_id TEXT NOT NULL,
  kind TEXT NOT NULL, delta INTEGER NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL,
  dedup TEXT NOT NULL, day TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(user_id,activity_id,dedup)
);
CREATE INDEX IF NOT EXISTS dj_ledger_daily ON dj_ledger(user_id,activity_id,day,source_type);
CREATE TABLE IF NOT EXISTS dj_stamps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, activity_id TEXT NOT NULL,
  source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, asset_id TEXT, file_id TEXT,
  created_at INTEGER NOT NULL, UNIQUE(user_id,activity_id,source,source_id)
);
CREATE TABLE IF NOT EXISTS dj_events (
  event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dj_business (
  source_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, activity_id TEXT NOT NULL, semantic TEXT NOT NULL, result TEXT NOT NULL,
  UNIQUE(user_id,activity_id,semantic)
);
CREATE TABLE IF NOT EXISTS dj_receipts (
  source_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, activity_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dj_jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, activity_id TEXT NOT NULL,
  status TEXT NOT NULL, analysis_status TEXT NOT NULL DEFAULT 'NOT_REQUESTED', analysis TEXT, error TEXT,
  original TEXT, width INTEGER NOT NULL, height INTEGER NOT NULL, draft TEXT NOT NULL,
  result_file TEXT, preview_file TEXT, success_day TEXT, reserved_day TEXT, lease_until INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dj_jobs_quota ON dj_jobs(user_id,success_day,reserved_day,status);
CREATE TABLE IF NOT EXISTS dj_rewards (
  id TEXT NOT NULL, activity_id TEXT NOT NULL, data TEXT NOT NULL, stock INTEGER NOT NULL CHECK(stock>=0),
  PRIMARY KEY(id,activity_id)
);
CREATE TABLE IF NOT EXISTS dj_orders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, activity_id TEXT NOT NULL, reward_id TEXT NOT NULL,
  title TEXT NOT NULL, cost INTEGER NOT NULL, point_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, redeemed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS dj_orders_one_active ON dj_orders(user_id,activity_id,reward_id) WHERE status IN ('PENDING','REDEEMED');
CREATE TABLE IF NOT EXISTS dj_tokens (
  digest TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES dj_orders(id), expires_at INTEGER NOT NULL, active INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dj_idempotency (
  scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,key)
);
CREATE TABLE IF NOT EXISTS dj_sessions (
  digest TEXT PRIMARY KEY, identity TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS dj_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO dj_migrations VALUES(1);
