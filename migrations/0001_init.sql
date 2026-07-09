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
