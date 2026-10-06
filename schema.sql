-- BabyPeek D1 schema (already applied to babypeek_prod via the Cloudflare API)
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  ip TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'processing',
  error TEXT,
  features TEXT,
  full_key TEXT,
  teaser_key TEXT,
  access_token TEXT,
  tier TEXT NOT NULL DEFAULT 'paid',           -- 'free' = free-first render, 'paid' = legacy teaser funnel
  est_cost_usd REAL,                           -- published-rate inference cost estimate per render
  extras_status TEXT NOT NULL DEFAULT 'none',  -- deluxe pack: none|processing|ready|error
  extras_json TEXT                              -- [{kind, key}] for v1/v2/age5/age15
);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at);
-- Free-first-render abuse-guard telemetry (E18): one row per UTC day.
CREATE TABLE IF NOT EXISTS free_metrics (
  day TEXT PRIMARY KEY,
  renders INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0          -- soft alarm fired at >200 renders/day
);
