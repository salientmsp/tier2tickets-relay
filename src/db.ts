/** D1 schema management and point lookups for the Gorelo mirror. */

/** Create the mirror tables + indexes if they don't exist (idempotent). */
export async function initSchema(db: D1Database): Promise<void> {
  await db.batch([
    // Agents/devices — enriched for the Halo asset lookup + ticket enrichment.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS devices (
        hostname     TEXT,
        upn          TEXT,
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
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_upn ON devices (upn)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_asset_num ON devices (asset_num)`),
    // Email domain -> client.
    db.prepare(
      `CREATE TABLE IF NOT EXISTS client_domains (
        domain    TEXT PRIMARY KEY,
        client_id INTEGER
      )`,
    ),
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
        created_at TEXT NOT NULL
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_tickets (created_at)`),
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
}

// --- Matcher lookups (osTicket path) ----------------------------------------

export interface DeviceRow {
  client_id: number;
  location_id: number | null;
  agent_id: string | null;
}

export async function findDeviceByHostname(db: D1Database, host: string): Promise<DeviceRow | null> {
  if (!host) return null;
  return db
    .prepare(`SELECT client_id, location_id, agent_id FROM devices WHERE hostname = ? LIMIT 1`)
    .bind(host)
    .first<DeviceRow>();
}

export async function findDeviceByUpn(db: D1Database, upn: string): Promise<DeviceRow | null> {
  if (!upn) return null;
  return db
    .prepare(`SELECT client_id, location_id, agent_id FROM devices WHERE upn = ? LIMIT 1`)
    .bind(upn)
    .first<DeviceRow>();
}

export async function findClientByDomain(db: D1Database, domain: string): Promise<number | null> {
  if (!domain) return null;
  const row = await db
    .prepare(`SELECT client_id FROM client_domains WHERE domain = ? LIMIT 1`)
    .bind(domain)
    .first<{ client_id: number }>();
  return row ? row.client_id : null;
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

// --- Deferred ticket queue (Halo /tickets -> /actions) ----------------------

export interface PendingRow {
  halo_id: number;
  command: string;
  created_at: string;
}

/** Store (or replace) a built Gorelo command awaiting its /actions note. */
export async function putPendingTicket(
  db: D1Database,
  haloId: number,
  command: string,
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO pending_tickets (halo_id, command, created_at) VALUES (?,?,?)
       ON CONFLICT(halo_id) DO UPDATE SET command = excluded.command, created_at = excluded.created_at`,
    )
    .bind(haloId, command, createdAt)
    .run();
}

/** Atomically claim (delete + return) one pending ticket by its Halo id. */
export async function takePendingTicket(db: D1Database, haloId: number): Promise<PendingRow | null> {
  return db
    .prepare(`DELETE FROM pending_tickets WHERE halo_id = ? RETURNING halo_id, command, created_at`)
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
       RETURNING halo_id, command, created_at`,
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
  await db
    .prepare(
      `INSERT INTO sync_meta (key, value) VALUES ('last_sync', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(iso)
    .run();
}
