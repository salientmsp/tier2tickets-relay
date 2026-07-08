/** D1 schema management and point lookups for the agent/client mirror. */

/** Create the mirror tables + indexes if they don't exist (idempotent). */
export async function initSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS devices (
        hostname    TEXT,
        upn         TEXT,
        client_id   INTEGER,
        location_id INTEGER,
        agent_id    TEXT
      )`,
    ),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_hostname ON devices (hostname)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_devices_upn ON devices (upn)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS client_domains (
        domain    TEXT PRIMARY KEY,
        client_id INTEGER
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS sync_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      )`,
    ),
  ]);
}

export interface DeviceRow {
  client_id: number;
  location_id: number | null;
  agent_id: string | null;
}

/** Point lookup: device by normalized short-lowercase hostname. */
export async function findDeviceByHostname(
  db: D1Database,
  host: string,
): Promise<DeviceRow | null> {
  if (!host) return null;
  return db
    .prepare(
      `SELECT client_id, location_id, agent_id FROM devices WHERE hostname = ? LIMIT 1`,
    )
    .bind(host)
    .first<DeviceRow>();
}

/** Point lookup: device by logged-on user UPN (lowercased email). */
export async function findDeviceByUpn(db: D1Database, upn: string): Promise<DeviceRow | null> {
  if (!upn) return null;
  return db
    .prepare(`SELECT client_id, location_id, agent_id FROM devices WHERE upn = ? LIMIT 1`)
    .bind(upn)
    .first<DeviceRow>();
}

/** Point lookup: client id by email domain. */
export async function findClientByDomain(db: D1Database, domain: string): Promise<number | null> {
  if (!domain) return null;
  const row = await db
    .prepare(`SELECT client_id FROM client_domains WHERE domain = ? LIMIT 1`)
    .bind(domain)
    .first<{ client_id: number }>();
  return row ? row.client_id : null;
}

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
