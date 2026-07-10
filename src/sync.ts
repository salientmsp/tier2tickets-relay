import { initSchema, setLastSync, setSyncMeta } from "./db.js";
import { GoreloClient } from "./gorelo.js";
import { normalizeHost } from "./parse.js";
import type {
  Env,
  PublicClientLocationResponse,
  PublicContactResponse,
  PublicDeviceResponse,
} from "./types.js";

// D1 caps a batch's total bound parameters (~variable limit); the widest row
// (devices, 10 cols) at 200/batch stays well under it. Larger chunks mean fewer
// batches = fewer subrequests per sync — the fleet writes fit the invocation cap.
const INSERT_CHUNK = 200;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Halo asset ids are integers, but Gorelo agent ids are UUIDs. Derive a stable
 * numeric surrogate from the UUID (first 12 hex -> a <=2^48 integer, safely inside
 * Number.MAX_SAFE_INTEGER). Deterministic across syncs; mapped back via D1.
 */
export function assetNum(uuid: string): number {
  const hex = uuid.replace(/[^0-9a-fA-F]/g, "").slice(0, 12);
  const n = Number.parseInt(hex || "0", 16);
  return Number.isFinite(n) ? n : 0;
}

interface DeviceInsert {
  hostname: string;
  clientId: number;
  locationId: number | null;
  agentId: string;
  assetNum: number;
  displayName: string;
  serial: string;
  localIp: string;
  publicIp: string;
  os: string;
}
interface ContactInsert {
  id: number;
  email: string;
  name: string;
  clientId: number | null;
  locationId: number | null;
}

function toDeviceRows(agents: PublicDeviceResponse[]): DeviceInsert[] {
  const rows: DeviceInsert[] = [];
  for (const a of agents) {
    if (a.clientId == null) continue; // can't route without a client
    rows.push({
      hostname: normalizeHost(a.displayName ?? a.name ?? ""),
      clientId: a.clientId,
      locationId: a.clientLocationId ?? null,
      agentId: a.id,
      assetNum: assetNum(a.id),
      displayName: (a.displayName ?? a.name ?? "").trim(),
      serial: (a.serialNo ?? "").trim(),
      localIp: (a.localIPAddress ?? "").trim(),
      publicIp: (a.publicIPAddress ?? "").trim(),
      os: "",
    });
  }
  return rows;
}

function contactName(c: PublicContactResponse): string {
  return [c.firstName ?? "", c.lastName ?? ""].join(" ").trim();
}

/** Per-table reconcile result: mirror size, rows actually written, rows deleted. */
export interface TableStats {
  total: number; // the mirror's actual row count after the sync
  changed: number; // rows actually inserted or updated in D1 this run
  deleted: number; // rows removed because they vanished upstream
}

export interface SyncStats {
  clients: number;
  locations: number; // current mirror size (this run's location refresh lands async via the queue)
  contacts: number;
  devices: number;
  /** Per-client location-fetch messages enqueued this run (processed async). */
  locationsQueued: number;
  /** Rows actually written this run for the inline tables (clients/contacts/devices). */
  changed: number;
  /** Rows deleted this run from the inline tables. */
  deleted: number;
  /**
   * True when the bulk fetches succeeded. When false, the bulk contacts fetch
   * failed, so contacts were upsert-only (deletes skipped) to avoid dropping rows
   * we merely failed to fetch. Locations are reconciled asynchronously by the
   * queue consumer, so their success isn't reflected here.
   */
  complete: boolean;
}

/**
 * Reconcile the D1 mirror against Gorelo: clients, sites, contacts, devices.
 * Delta-only — unchanged rows are left untouched — so writes track churn, not
 * fleet size. Runs off the request path (cron / admin / first-press bootstrap).
 */
export async function syncAll(env: Env): Promise<SyncStats> {
  await initSchema(env.DB);
  const client = new GoreloClient(env);

  // Agents, clients and ALL contacts come from three bulk calls (contacts carry
  // their own clientId) — cheap on the 50 external-subrequest/invocation cap.
  // Locations have NO bulk endpoint (one call per client), so doing them inline
  // blew that cap at scale; instead we fan them out to a queue below and a
  // consumer fetches them in small batches, each with its own subrequest budget.
  //
  // A bulk fetch can fail; if contacts do, the set is INCOMPLETE and must NOT be
  // treated as authoritative — deleting then would drop rows we merely failed to
  // fetch. Gate the contact deletes on that.
  const [agents, clients, allContacts] = await Promise.all([
    client.listAgents(),
    client.listClients(),
    client.listAllContacts().catch((err) => {
      console.error(`sync: listAllContacts failed — skipping contact deletes: ${String(err)}`);
      return null;
    }),
  ]);
  const clientIds = clients.map((c) => c.id);

  const contactsComplete = allContacts !== null;
  const contactRows: ContactInsert[] = [];
  for (const ct of allContacts ?? []) {
    const email = (ct.primaryEmail ?? "").trim().toLowerCase();
    if (!email) continue;
    contactRows.push({
      id: ct.id,
      email,
      name: contactName(ct),
      clientId: ct.clientId ?? null,
      locationId: ct.clientLocationId ?? null,
    });
  }

  const deviceRows = toDeviceRows(agents);
  const clientRows = clients.map((c) => ({ id: c.id, name: (c.name ?? "").trim() }));

  // Delta-reconcile every table: upsert changed/new rows, delete rows that
  // vanished upstream. Unchanged rows write nothing (the ON CONFLICT guards on a
  // real diff), so a no-op sync costs ~0 D1 writes regardless of dataset size.
  const clientStats = await syncTable(env.DB, "clients", "id", clientRows, (r) => r.id, (r) =>
    env.DB
      .prepare(
        `INSERT INTO clients (id, name) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name
         WHERE clients.name IS NOT excluded.name`,
      )
      .bind(r.id, r.name),
  );
  // contacts pass their completeness flag: when the bulk fetch failed, the row
  // set is partial, so upsert-only (no deletes) this run.
  const contactStats = await syncTable(env.DB, "contacts", "id", contactRows, (r) => r.id, (r) =>
    env.DB
      .prepare(
        `INSERT INTO contacts (id, email, name, client_id, location_id) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           email = excluded.email, name = excluded.name,
           client_id = excluded.client_id, location_id = excluded.location_id
         WHERE contacts.email IS NOT excluded.email OR contacts.name IS NOT excluded.name
            OR contacts.client_id IS NOT excluded.client_id OR contacts.location_id IS NOT excluded.location_id`,
      )
      .bind(r.id, r.email, r.name, r.clientId, r.locationId),
    contactsComplete,
  );
  const deviceStats = await syncTable(env.DB, "devices", "agent_id", deviceRows, (r) => r.agentId, (r) =>
    env.DB
      .prepare(
        `INSERT INTO devices
          (hostname, client_id, location_id, agent_id, asset_num, display_name, serial, local_ip, public_ip, os)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           hostname = excluded.hostname, client_id = excluded.client_id, location_id = excluded.location_id,
           asset_num = excluded.asset_num, display_name = excluded.display_name, serial = excluded.serial,
           local_ip = excluded.local_ip, public_ip = excluded.public_ip, os = excluded.os
         WHERE devices.hostname IS NOT excluded.hostname OR devices.client_id IS NOT excluded.client_id
            OR devices.location_id IS NOT excluded.location_id OR devices.asset_num IS NOT excluded.asset_num
            OR devices.display_name IS NOT excluded.display_name OR devices.serial IS NOT excluded.serial
            OR devices.local_ip IS NOT excluded.local_ip OR devices.public_ip IS NOT excluded.public_ip
            OR devices.os IS NOT excluded.os`,
      )
      .bind(
        r.hostname,
        r.clientId,
        r.locationId,
        r.agentId,
        r.assetNum,
        r.displayName,
        r.serial,
        r.localIp,
        r.publicIp,
        r.os,
      ),
  );

  // Drop locations belonging to clients that no longer exist — the queue only
  // reconciles clients we enqueue below, so a vanished client's sites would
  // otherwise linger. D1-only, so it doesn't touch the external-subrequest cap.
  if (clientIds.length) {
    const ph = clientIds.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM locations WHERE client_id NOT IN (${ph})`).bind(...clientIds).run();
  }

  // Fan out per-client location fetches to the queue: one message each, sent in
  // batches of 100 (the sendBatch max). The consumer refreshes + reconciles each
  // client's sites in small batches, keeping every invocation under the cap.
  const messages = clientIds.map((cid) => ({ body: { type: "locations" as const, clientId: cid } }));
  for (const part of chunk(messages, 100)) {
    if (part.length) await env.SYNC_QUEUE.sendBatch(part);
  }

  const now = new Date().toISOString();
  await setLastSync(env.DB, now);
  // Bookkeeping for the admin status endpoint: how many location messages this
  // run enqueued and when, so it can be compared against the consumer's progress.
  await setSyncMeta(env.DB, "locations_enqueued", String(messages.length));
  await setSyncMeta(env.DB, "locations_enqueued_at", now);
  const locations = await countRows(env.DB, "locations");
  return {
    clients: clientStats.total,
    locations, // current mirror size; this run's refresh lands async via the queue
    contacts: contactStats.total,
    devices: deviceStats.total,
    locationsQueued: messages.length,
    changed: clientStats.changed + contactStats.changed + deviceStats.changed,
    deleted: clientStats.deleted + contactStats.deleted + deviceStats.deleted,
    complete: contactsComplete, // agents/clients throw on failure; locations reconcile async
  };
}

/** Count rows in a table (used for reporting the mirror size). */
async function countRows(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Refresh + reconcile ONE client's locations: upsert its sites, then delete only
 * that client's stale rows. Scoped per-client so the queue consumer can process
 * each client independently — no global snapshot needed for safe deletes.
 */
export async function reconcileClientLocations(
  db: D1Database,
  clientId: number,
  locations: PublicClientLocationResponse[],
): Promise<{ changed: number; deleted: number }> {
  const rows = dedupeByKey(
    locations.map((l) => ({ id: l.id, name: (l.name ?? "").trim(), clientId })),
    (r) => r.id,
  );
  let changed = 0;
  for (const part of chunk(rows, INSERT_CHUNK)) {
    if (!part.length) continue;
    const res = await db.batch(
      part.map((r) =>
        db
          .prepare(
            `INSERT INTO locations (id, name, client_id) VALUES (?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, client_id = excluded.client_id
             WHERE locations.name IS NOT excluded.name OR locations.client_id IS NOT excluded.client_id`,
          )
          .bind(r.id, r.name, r.clientId),
      ),
    );
    for (const x of res) changed += x.meta?.changes ?? 0;
  }
  // Reconcile deletes scoped to THIS client only.
  const fetched = new Set(rows.map((r) => String(r.id)));
  const { results } = await db
    .prepare(`SELECT id FROM locations WHERE client_id = ?`)
    .bind(clientId)
    .all<{ id: number }>();
  const stale = (results ?? [])
    .map((r) => r.id)
    .filter((id): id is number => id != null && !fetched.has(String(id)));
  for (const part of chunk(stale, INSERT_CHUNK)) {
    if (!part.length) continue;
    const ph = part.map(() => "?").join(", ");
    await db.batch([db.prepare(`DELETE FROM locations WHERE id IN (${ph})`).bind(...part)]);
  }
  return { changed, deleted: stale.length };
}

/**
 * Collapse rows sharing a key down to one deterministic winner. Gorelo can
 * return the same contact under more than one client (or with a null clientId
 * that falls back to the query's cid), so the raw row list — built by concurrent
 * per-client fetches — can hold several entries for one id in a run-dependent
 * order. Without this, the "last writer wins" upsert flip-flops that row's
 * client/location every sync (endless `changed` churn). Picking the smallest
 * serialization makes the winner stable across runs regardless of fetch order.
 */
function dedupeByKey<T>(rows: T[], keyOf: (row: T) => string | number): T[] {
  const byKey = new Map<string, T>();
  for (const r of rows) {
    const k = String(keyOf(r));
    const cur = byKey.get(k);
    if (cur === undefined || JSON.stringify(r) < JSON.stringify(cur)) byKey.set(k, r);
  }
  return [...byKey.values()];
}

/**
 * Reconcile `table` against `rows` without a full rewrite:
 *  1. Upsert every fetched row (the caller's stmt guards ON CONFLICT on a real
 *     diff, so unchanged rows write nothing).
 *  2. When `canDelete`, read back the surviving keys and DELETE only those that
 *     vanished upstream. `canDelete` is false when the caller's fetch was partial
 *     (a per-client failure) — deleting then would drop rows we merely failed to
 *     fetch, so we upsert-only and let a later complete sync reconcile.
 * Net D1 writes per sync = (new + changed rows) + (removed rows) — zero when the
 * upstream data is unchanged, vs. a full-table rewrite every run before.
 *
 * Returns row counts: `total` (the mirror's actual row count after the sync),
 * `changed` actually written (D1 reports `meta.changes = 0` when the
 * WHERE-guarded upsert is a no-op) and `deleted`.
 */
async function syncTable<T>(
  db: D1Database,
  table: string,
  keyCol: string,
  rows: T[],
  keyOf: (row: T) => string | number,
  toStmt: (row: T) => D1PreparedStatement,
  canDelete = true,
): Promise<TableStats> {
  const deduped = dedupeByKey(rows, keyOf);
  let changed = 0;
  for (const part of chunk(deduped, INSERT_CHUNK)) {
    const stmts = part.map(toStmt);
    if (!stmts.length) continue;
    const res = await db.batch(stmts);
    for (const r of res) changed += r.meta?.changes ?? 0;
  }

  // Current mirror keys (post-upsert). Reading keys is cheap (D1 bills reads far
  // below writes) and also yields the true post-sync row count for `total`.
  const { results } = await db.prepare(`SELECT ${keyCol} AS k FROM ${table}`).all<{ k: unknown }>();
  const dbKeys = (results ?? []).map((row) => row.k).filter((k) => k != null) as (string | number)[];

  let deleted = 0;
  if (canDelete) {
    // Reconcile deletes: keys present in D1 but no longer returned by Gorelo.
    // Usually empty, so a steady-state sync issues no DELETE batches at all.
    const fetched = new Set<string>(deduped.map((r) => String(keyOf(r))));
    const stale = dbKeys.filter((k) => !fetched.has(String(k)));
    for (const part of chunk(stale, INSERT_CHUNK)) {
      if (!part.length) continue;
      const placeholders = part.map(() => "?").join(", ");
      await db.batch([db.prepare(`DELETE FROM ${table} WHERE ${keyCol} IN (${placeholders})`).bind(...part)]);
    }
    deleted = stale.length;
  }
  return { total: dbKeys.length - deleted, changed, deleted };
}
