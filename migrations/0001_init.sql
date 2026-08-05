-- D1 schema for the Tier2 -> Gorelo relay (Gorelo mirror for per-press lookups).
-- The Worker also self-creates + additively migrates this at runtime (src/db.ts
-- initSchema), so applying this migration is optional but recommended for a fresh DB.

-- Agents/devices (Halo asset lookup + ticket enrichment).
CREATE TABLE IF NOT EXISTS devices (
  hostname     TEXT,
  client_id    INTEGER,
  location_id  INTEGER,
  agent_id     TEXT,
  asset_num    INTEGER,
  display_name TEXT,
  serial       TEXT,
  local_ip     TEXT,
  public_ip    TEXT,
  os           TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices (hostname);
CREATE INDEX IF NOT EXISTS idx_devices_asset_num ON devices (asset_num);

-- Clients (customers).
CREATE TABLE IF NOT EXISTS clients (
  id   INTEGER PRIMARY KEY,
  name TEXT
);

-- Locations (sites).
CREATE TABLE IF NOT EXISTS locations (
  id        INTEGER PRIMARY KEY,
  name      TEXT,
  client_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_locations_client ON locations (client_id);

-- Contacts (users), keyed by email for the Halo Users lookup.
CREATE TABLE IF NOT EXISTS contacts (
  id          INTEGER PRIMARY KEY,
  email       TEXT,
  name        TEXT,
  client_id   INTEGER,
  location_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email);

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Deferred Gorelo ticket creates: /tickets queues the built command here, /actions
-- (or the orphan-flush cron) creates it. `attempts` drives the dead-letter cap.
CREATE TABLE IF NOT EXISTS pending_tickets (
  halo_id    INTEGER PRIMARY KEY,
  command    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_tickets (created_at);

-- Monitoring alerts (POST /v1/alerts). One row per stable `dedupe_key`; `status` is
-- our own 'open'|'resolved' lifecycle (Gorelo has no ticket-update/close API), and
-- `last_event_id` is the last processed Idempotency-Key/event_id for replay safety.
CREATE TABLE IF NOT EXISTS alerts (
  dedupe_key     TEXT PRIMARY KEY,
  monitor_id     TEXT,
  source         TEXT,
  host           TEXT,
  customer       TEXT,
  severity       TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  title          TEXT,
  message        TEXT,
  gorelo_id      TEXT,
  number         INTEGER,
  display_number TEXT,
  last_event_id  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status);

-- Monitor heartbeats (status='heartbeat' events) — last_seen per dedupe_key, no ticket.
CREATE TABLE IF NOT EXISTS alert_heartbeats (
  dedupe_key TEXT PRIMARY KEY,
  monitor_id TEXT,
  source     TEXT,
  host       TEXT,
  customer   TEXT,
  last_seen  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
