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
  access_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at);
