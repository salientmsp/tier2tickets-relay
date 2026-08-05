/** D1 schema management and point lookups for the Gorelo mirror. */

// Bump when the CREATE/migration block below changes. Stamped in sync_meta once
// applied so later syncs skip the whole idempotent block — it costs ~14
// subrequests every run otherwise, and syncAll runs under the Worker's
// per-invocation subrequest cap.
const SCHEMA_VERSION = "4";

/** Create the mirror tables + indexes if they don't exist (idempotent). */
export async function initSchema(db: D1Database): Promise<void> {
  // Fast path: already migrated to the current version -> a single read, done.
  // On a fresh DB sync_meta doesn't exist yet, so the read throws -> full init.
  const applied = await db
    .prepare(`SELECT value FROM sync_meta WHERE key = 'schema_version' LIMIT 1`)
    .first<{ value: string }>()
    .catch(() => null);
  if (applied?.value === SCHEMA_VERSION) return;

  await db.batch([
    // Agents/devices — enriched for the Halo asset lookup + ticket enrichment.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS devices (
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
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices (hostname)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_asset_num ON devices (asset_num)`),
    // Clients (customers).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS clients (
        id   INTEGER PRIMARY KEY,
        name TEXT
      )`,
    ),
    // Locations (sites).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS locations (
        id        INTEGER PRIMARY KEY,
        name      TEXT,
        client_id INTEGER
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_locations_client ON locations (client_id)`),
    // Contacts (users), keyed by email for the Halo Users lookup.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS contacts (
        id          INTEGER PRIMARY KEY,
        email       TEXT,
        name        TEXT,
        client_id   INTEGER,
        location_id INTEGER
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts (email)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS sync_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      )`,
    ),
    // Deferred Gorelo ticket creates. Tier2's Halo flow POSTs the ticket, then
    // POSTs the actual report as an /actions note — but Gorelo has no
    // ticket-append endpoint, so we hold the built command here (keyed by the
    // Halo ticket id we hand back) and create the Gorelo ticket only once the
    // note arrives (or the cron orphan-flush fires).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS pending_tickets (
        halo_id    INTEGER PRIMARY KEY,
        command    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_tickets (created_at)`),
    // Ledger of tickets we've actually created in Gorelo, keyed by the Halo ticket
    // id we handed back to the client. Huntress does GET /api/Tickets/{id} after a
    // create to verify it exists (and read the number); without a real answer it
    // treats the create as failed and retries -> duplicates. We serve that GET from
    // here, and it doubles as a dedup record.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS created_tickets (
        halo_id        INTEGER PRIMARY KEY,
        gorelo_id      TEXT,
        number         INTEGER,
        display_number TEXT,
        title          TEXT,
        client_id      INTEGER,
        contact_id     INTEGER,
        status_id      INTEGER,
        created_at     TEXT NOT NULL
      )`,
    ),
    // Monitoring alerts (POST /v1/alerts). One row per `dedupe_key` — the stable
    // identity a monitoring source (e.g. an on-prem SQL server) reuses across
    // retries. `status` is our own lifecycle ('open' | 'resolved'), distinct from
    // the Gorelo ticket status; `last_event_id` is the last processed
    // Idempotency-Key / event_id so a re-POST of the SAME event is ignored rather
    // than treated as an update. Gorelo has no ticket-update/close API, so dedup
    // and the open→resolved transition are tracked here (the Gorelo ticket is
    // created once; resolution files a labeled notice — see src/alerts.ts).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS alerts (
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
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts (status)`),
    // Monitor heartbeats (status='heartbeat' events). A heartbeat asserts the
    // monitor is alive; it never creates a visible ticket, we just stamp last_seen
    // keyed by dedupe_key so a future stale-heartbeat check has the data it needs.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS alert_heartbeats (
        dedupe_key TEXT PRIMARY KEY,
        monitor_id TEXT,
        source     TEXT,
        host       TEXT,
        customer   TEXT,
        last_seen  TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
  ]);

  // Additive migration: a devices table created before Phase 2 lacks the new
  // columns, and CREATE TABLE IF NOT EXISTS won't add them. Try to add each; a
  // "duplicate column name" error (column already present) is expected and
  // ignored. We attempt the ALTER unconditionally rather than trusting PRAGMA,
  // because PRAGMA table_info behaves differently across D1 builds — a false
  // "missing" reading there previously crashed the request with a 500.
  const newColumns: Record<string, string> = {
    asset_num: "INTEGER",
    display_name: "TEXT",
    serial: "TEXT",
    local_ip: "TEXT",
    public_ip: "TEXT",
    os: "TEXT",
  };
  for (const [col, type] of Object.entries(newColumns)) {
    try {
      await db.prepare(`ALTER TABLE devices ADD COLUMN ${col} ${type}`).run();
    } catch {
      // column already exists — fine
    }
  }
  try {
    await db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_asset_num ON devices (asset_num)`).run();
  } catch {
    // index already exists / column race — fine
  }
  // Delta sync upserts devices with ON CONFLICT(agent_id), which needs a UNIQUE
  // index as the conflict target. The old full-rebuild produced one row per agent
  // so duplicates shouldn't exist, but dedupe first (keep the lowest rowid per
  // agent_id) so the unique index can be created even on a legacy table.
  try {
    await db
      .prepare(`DELETE FROM devices WHERE rowid NOT IN (SELECT MIN(rowid) FROM devices GROUP BY agent_id)`)
      .run();
  } catch {
    // nothing to dedupe / build doesn't expose rowid — fine
  }
  try {
    await db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_agent_id ON devices (agent_id)`).run();
  } catch {
    // index already exists / residual duplicate — fine
  }
  // Additive migration: attempts counter on an older pending_tickets table.
  try {
    await db.prepare(`ALTER TABLE pending_tickets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`).run();
  } catch {
    // column already exists — fine
  }
  // Drop the dead osTicket-era mirror artifacts (domain matching / UPN lookup are
  // gone). Both are unread now; best-effort so older/newer D1 builds don't error.
  for (const stmt of [
    `DROP TABLE IF EXISTS client_domains`,
    `DROP INDEX IF EXISTS idx_devices_upn`,
    `ALTER TABLE devices DROP COLUMN upn`,
  ]) {
    try {
      await db.prepare(stmt).run();
    } catch {
      // already dropped / column absent / build doesn't support DROP COLUMN — fine
    }
  }

  // Stamp the version so subsequent syncs take the fast path above.
  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(SCHEMA_VERSION)
    .run();
}

// --- Halo mock lookups ------------------------------------------------------

export interface ClientRow {
  id: number;
  name: string | null;
}
export interface LocationRow {
  id: number;
  name: string | null;
  client_id: number | null;
}
export interface ContactRow {
  id: number;
  email: string | null;
  name: string | null;
  client_id: number | null;
  location_id: number | null;
}
export interface DeviceFullRow {
  hostname: string | null;
  agent_id: string | null;
  asset_num: number | null;
  client_id: number | null;
  location_id: number | null;
  display_name: string | null;
  serial: string | null;
  local_ip: string | null;
  public_ip: string | null;
  os: string | null;
}

const like = (term: string): string => `%${term.trim().toLowerCase()}%`;

/** Clients, optionally filtered by a name substring (case-insensitive). */
export async function listClientRows(db: D1Database, search = "", limit = 100): Promise<ClientRow[]> {
  const stmt = search
    ? db
        .prepare(`SELECT id, name FROM clients WHERE lower(name) LIKE ? ORDER BY name LIMIT ?`)
        .bind(like(search), limit)
    : db.prepare(`SELECT id, name FROM clients ORDER BY name LIMIT ?`).bind(limit);
  const { results } = await stmt.all<ClientRow>();
  return results ?? [];
}

export async function getClientName(db: D1Database, id: number): Promise<string | null> {
  const row = await db.prepare(`SELECT name FROM clients WHERE id = ? LIMIT 1`).bind(id).first<{
    name: string | null;
  }>();
  return row ? row.name : null;
}

/** Sites, optionally filtered by client and/or name substring. */
export async function listLocationRows(
  db: D1Database,
  clientId?: number,
  search = "",
  limit = 100,
): Promise<LocationRow[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (clientId != null) {
    clauses.push(`client_id = ?`);
    binds.push(clientId);
  }
  if (search) {
    clauses.push(`lower(name) LIKE ?`);
    binds.push(like(search));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  binds.push(limit);
  const { results } = await db
    .prepare(`SELECT id, name, client_id FROM locations ${where} ORDER BY name LIMIT ?`)
    .bind(...binds)
    .all<LocationRow>();
  return results ?? [];
}

/** Contact by exact (lowercased) email. */
export async function findContactByEmail(db: D1Database, email: string): Promise<ContactRow | null> {
  const e = email.trim().toLowerCase();
  if (!e) return null;
  return db
    .prepare(
      `SELECT id, email, name, client_id, location_id FROM contacts WHERE email = ? LIMIT 1`,
    )
    .bind(e)
    .first<ContactRow>();
}

/** Contacts by email/name substring (for a broader Users search). */
export async function searchContactRows(db: D1Database, search: string, limit = 25): Promise<ContactRow[]> {
  const s = like(search);
  const { results } = await db
    .prepare(
      `SELECT id, email, name, client_id, location_id FROM contacts
       WHERE lower(email) LIKE ? OR lower(name) LIKE ? ORDER BY name LIMIT ?`,
    )
    .bind(s, s, limit)
    .all<ContactRow>();
  return results ?? [];
}

/** Contact by numeric id (to validate a user_id sent on ticket create). */
export async function getContactById(db: D1Database, id: number): Promise<ContactRow | null> {
  return db
    .prepare(`SELECT id, email, name, client_id, location_id FROM contacts WHERE id = ? LIMIT 1`)
    .bind(id)
    .first<ContactRow>();
}

/** Devices by hostname/display-name/serial substring (for the Halo asset search),
 *  optionally scoped to a client (Halo passes client_id on the asset lookup). */
export async function searchDeviceRows(
  db: D1Database,
  search: string,
  clientId?: number,
  limit = 25,
): Promise<DeviceFullRow[]> {
  const s = like(search);
  const cols = `hostname, agent_id, asset_num, client_id, location_id, display_name, serial, local_ip, public_ip, os`;
  const match = `(lower(hostname) LIKE ? OR lower(display_name) LIKE ? OR lower(serial) LIKE ?)`;
  const stmt =
    clientId != null
      ? db
          .prepare(`SELECT ${cols} FROM devices WHERE ${match} AND client_id = ? ORDER BY hostname LIMIT ?`)
          .bind(s, s, s, clientId, limit)
      : db.prepare(`SELECT ${cols} FROM devices WHERE ${match} ORDER BY hostname LIMIT ?`).bind(s, s, s, limit);
  const { results } = await stmt.all<DeviceFullRow>();
  return results ?? [];
}

/** Full device row by exact (normalized) hostname — for asset link + ticket enrichment. */
export async function findDeviceFullByHostname(
  db: D1Database,
  host: string,
): Promise<DeviceFullRow | null> {
  if (!host) return null;
  const cols = `hostname, agent_id, asset_num, client_id, location_id, display_name, serial, local_ip, public_ip, os`;
  return db
    .prepare(`SELECT ${cols} FROM devices WHERE hostname = ? LIMIT 1`)
    .bind(host)
    .first<DeviceFullRow>();
}

/** Map a Halo asset id (our numeric surrogate) back to the Gorelo agent uuid. */
export async function getAgentIdByAssetNum(db: D1Database, assetNum: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT agent_id FROM devices WHERE asset_num = ? LIMIT 1`)
    .bind(assetNum)
    .first<{ agent_id: string | null }>();
  return row ? row.agent_id : null;
}

// --- Monitoring alerts (POST /v1/alerts) ------------------------------------

/** A stored monitoring alert, keyed by its stable `dedupe_key`. */
export interface AlertRow {
  dedupe_key: string;
  monitor_id: string | null;
  source: string | null;
  host: string | null;
  customer: string | null;
  severity: string | null;
  status: string; // our lifecycle: 'open' | 'resolved'
  title: string | null;
  message: string | null;
  gorelo_id: string | null;
  number: number | null;
  display_number: string | null;
  last_event_id: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const ALERT_COLS =
  `dedupe_key, monitor_id, source, host, customer, severity, status, title, message, ` +
  `gorelo_id, number, display_number, last_event_id, created_at, updated_at, resolved_at`;

/** The open/resolved alert for a dedupe_key, or null if we've never seen it. */
export async function getAlert(db: D1Database, dedupeKey: string): Promise<AlertRow | null> {
  return db
    .prepare(`SELECT ${ALERT_COLS} FROM alerts WHERE dedupe_key = ? LIMIT 1`)
    .bind(dedupeKey)
    .first<AlertRow>();
}

/** Insert or replace the alert row for its dedupe_key (full upsert). */
export async function putAlert(db: D1Database, row: AlertRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alerts
         (${ALERT_COLS})
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         monitor_id = excluded.monitor_id, source = excluded.source, host = excluded.host,
         customer = excluded.customer, severity = excluded.severity, status = excluded.status,
         title = excluded.title, message = excluded.message, gorelo_id = excluded.gorelo_id,
         number = excluded.number, display_number = excluded.display_number,
         last_event_id = excluded.last_event_id, updated_at = excluded.updated_at,
         resolved_at = excluded.resolved_at`,
    )
    .bind(
      row.dedupe_key,
      row.monitor_id,
      row.source,
      row.host,
      row.customer,
      row.severity,
      row.status,
      row.title,
      row.message,
      row.gorelo_id,
      row.number,
      row.display_number,
      row.last_event_id,
      row.created_at,
      row.updated_at,
      row.resolved_at,
    )
    .run();
}

/** Stamp a monitor heartbeat (last_seen) keyed by dedupe_key. */
export async function recordHeartbeat(
  db: D1Database,
  hb: { dedupe_key: string; monitor_id: string | null; source: string | null; host: string | null; customer: string | null; last_seen: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_heartbeats (dedupe_key, monitor_id, source, host, customer, last_seen, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         monitor_id = excluded.monitor_id, source = excluded.source, host = excluded.host,
         customer = excluded.customer, last_seen = excluded.last_seen, updated_at = excluded.updated_at`,
    )
    .bind(hb.dedupe_key, hb.monitor_id, hb.source, hb.host, hb.customer, hb.last_seen, hb.last_seen)
    .run();
}

// --- Deferred ticket queue (Halo /tickets -> /actions) ----------------------

export interface PendingRow {
  halo_id: number;
  command: string;
  created_at: string;
  attempts: number;
}

/** Store (or replace) a built Gorelo command awaiting its /actions note. */
export async function putPendingTicket(
  db: D1Database,
  haloId: number,
  command: string,
  createdAt: string,
  attempts = 0,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_tickets (halo_id, command, created_at, attempts) VALUES (?,?,?,?)
       ON CONFLICT(halo_id) DO UPDATE SET
         command = excluded.command, created_at = excluded.created_at, attempts = excluded.attempts`,
    )
    .bind(haloId, command, createdAt, attempts)
    .run();
}

/** A created-ticket ledger row (what we handed the Halo client ↔ the Gorelo ticket). */
export interface CreatedTicketRow {
  halo_id: number;
  gorelo_id: string | null;
  number: number | null;
  display_number: string | null;
  title: string | null;
  client_id: number | null;
  contact_id: number | null;
  status_id: number | null;
  created_at: string;
}

/** Record a ticket we created in Gorelo, keyed by the Halo id handed to the client. */
export async function putCreatedTicket(db: D1Database, row: CreatedTicketRow): Promise<void> {
  await db
    .prepare(
      `INSERT INTO created_tickets
         (halo_id, gorelo_id, number, display_number, title, client_id, contact_id, status_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(halo_id) DO UPDATE SET
         gorelo_id = excluded.gorelo_id, number = excluded.number,
         display_number = excluded.display_number, title = excluded.title,
         client_id = excluded.client_id, contact_id = excluded.contact_id,
         status_id = excluded.status_id, created_at = excluded.created_at`,
    )
    .bind(
      row.halo_id,
      row.gorelo_id,
      row.number,
      row.display_number,
      row.title,
      row.client_id,
      row.contact_id,
      row.status_id,
      row.created_at,
    )
    .run();
}

/** Look up a created ticket by the Halo id we handed back (for GET /api/Tickets/{id}). */
export async function getCreatedTicket(db: D1Database, haloId: number): Promise<CreatedTicketRow | null> {
  return db
    .prepare(
      `SELECT halo_id, gorelo_id, number, display_number, title, client_id, contact_id, status_id, created_at
       FROM created_tickets WHERE halo_id = ? LIMIT 1`,
    )
    .bind(haloId)
    .first<CreatedTicketRow>();
}

/** Atomically claim (delete + return) one pending ticket by its Halo id. */
export async function takePendingTicket(db: D1Database, haloId: number): Promise<PendingRow | null> {
  return db
    .prepare(
      `DELETE FROM pending_tickets WHERE halo_id = ? RETURNING halo_id, command, created_at, attempts`,
    )
    .bind(haloId)
    .first<PendingRow>();
}

/** Atomically claim all pending tickets older than the cutoff (orphan flush). */
export async function takeStalePendingTickets(
  db: D1Database,
  cutoffIso: string,
  limit = 50,
): Promise<PendingRow[]> {
  const { results } = await db
    .prepare(
      `DELETE FROM pending_tickets
       WHERE halo_id IN (
         SELECT halo_id FROM pending_tickets WHERE created_at < ? ORDER BY created_at LIMIT ?
       )
       RETURNING halo_id, command, created_at, attempts`,
    )
    .bind(cutoffIso, limit)
    .all<PendingRow>();
  return results ?? [];
}

// --- sync bookkeeping -------------------------------------------------------

export async function getLastSync(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM sync_meta WHERE key = 'last_sync' LIMIT 1`)
    .first<{ value: string }>();
  return row ? row.value : null;
}

export async function setLastSync(db: D1Database, iso: string): Promise<void> {
  await setSyncMeta(db, "last_sync", iso);
}

/** Read an arbitrary sync_meta value (null if unset). */
export async function getSyncMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM sync_meta WHERE key = ? LIMIT 1`)
    .bind(key)
    .first<{ value: string }>();
  return row ? row.value : null;
}

/** Upsert an arbitrary sync_meta value. */
export async function setSyncMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

/** Row counts for the mirrored tables (for the admin status endpoint). */
export async function mirrorCounts(
  db: D1Database,
): Promise<{ clients: number; locations: number; contacts: number; devices: number }> {
  const one = async (table: string): Promise<number> => {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    return row?.n ?? 0;
  };
  const [clients, locations, contacts, devices] = await Promise.all([
    one("clients"),
    one("locations"),
    one("contacts"),
    one("devices"),
  ]);
  return { clients, locations, contacts, devices };
}
