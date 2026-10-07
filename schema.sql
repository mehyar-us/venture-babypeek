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
  src TEXT,                                     -- render-source attribution (utm/src param threading, E18 measurement)
  extras_status TEXT NOT NULL DEFAULT 'none',  -- deluxe pack: none|processing|ready|error
  extras_retries INTEGER NOT NULL DEFAULT 0,   -- E18 fairness fix: client-driven single retry of failed extras
  extras_json TEXT,                             -- [{kind, key}] for v1/v2/v3/v4/age5/age15
  -- Funnel ladder (2026-10-06: $17 reprice + $9 bump + $27 upsell)
  bump_paid INTEGER NOT NULL DEFAULT 0,         -- 1 = $9 Couple Pack bump bought (unlocks v3/v4)
  agepack_token TEXT,                           -- $27 Age Progression Pack purchase token
  agepack_status TEXT NOT NULL DEFAULT 'none', -- none|processing|ready|error
  agepack_json TEXT                             -- [{kind, key}] for a1/a3/a10/a20
);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at);
-- Free-first-render abuse-guard telemetry (E18): one row per UTC day.
CREATE TABLE IF NOT EXISTS free_metrics (
  day TEXT PRIMARY KEY,
  renders INTEGER NOT NULL DEFAULT 0,
  est_cost_usd REAL NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0          -- soft alarm fired at >200 renders/day
);
-- Unlock-intent beacons (E18 10/8 verdict instrumentation, 2026-10-07):
-- client-side click telemetry for the free-result close rung.
-- kind='teaser' = blurred-teaser CTA clicked; kind='unlock' = valid-email $17
-- unlock attempt reached the checkout call. NO PII: only the opaque gid.
CREATE TABLE IF NOT EXISTS unlock_intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gid TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- 'teaser' | 'unlock'
  src TEXT,                                   -- render-source attribution, copied from generations
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
