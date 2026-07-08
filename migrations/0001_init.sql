-- D1 schema for the Tier2 -> Gorelo relay.
-- Mirrors of Gorelo agents/clients used for per-press point lookups.
-- Kept in sync off the request path (cron + POST /admin/sync + first-press bootstrap).
-- The Worker also self-creates these on demand (see src/db.ts initSchema),
-- so applying this migration is optional but recommended.

CREATE TABLE IF NOT EXISTS devices (
  hostname    TEXT,
  upn         TEXT,
  client_id   INTEGER,
  location_id INTEGER,
  agent_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices (hostname);
CREATE INDEX IF NOT EXISTS idx_devices_upn ON devices (upn);

CREATE TABLE IF NOT EXISTS client_domains (
  domain    TEXT PRIMARY KEY,
  client_id INTEGER
);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
