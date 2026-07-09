import { initSchema, setLastSync } from "./db.js";
import { GoreloClient } from "./gorelo.js";
import { normalizeHost } from "./parse.js";
import type { Env, PublicContactResponse, PublicDeviceResponse } from "./types.js";

const INSERT_CHUNK = 100; // stay within D1's per-batch statement limits
const FETCH_CONCURRENCY = 5; // per-client Gorelo calls in flight at once

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Run `fn` over items with bounded concurrency (keeps us under Gorelo rate limits). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
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
interface LocationInsert {
  id: number;
  name: string;
  clientId: number;
}
interface ContactInsert {
  id: number;
  email: string;
  name: string;
  clientId: number;
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

/**
 * Rebuild the D1 mirror from Gorelo: clients, sites, contacts, devices.
 * Runs off the request path (cron / admin / first-press bootstrap).
 */
export async function syncAll(env: Env): Promise<{
  clients: number;
  locations: number;
  contacts: number;
  devices: number;
}> {
  await initSchema(env.DB);
  const client = new GoreloClient(env);

  const [agents, clients] = await Promise.all([client.listAgents(), client.listClients()]);
  const clientIds = clients.map((c) => c.id);

  // Per-client locations + contacts (bounded concurrency).
  const locationRows: LocationInsert[] = [];
  const contactRows: ContactInsert[] = [];
  await mapLimit(clientIds, FETCH_CONCURRENCY, async (cid) => {
    const [locations, contacts] = await Promise.all([
      client.listLocations(cid).catch(() => []),
      client.listContacts(cid).catch(() => []),
    ]);
    for (const l of locations) {
      locationRows.push({ id: l.id, name: (l.name ?? "").trim(), clientId: cid });
    }
    for (const ct of contacts) {
      const email = (ct.primaryEmail ?? "").trim().toLowerCase();
      if (!email) continue;
      contactRows.push({
        id: ct.id,
        email,
        name: contactName(ct),
        clientId: ct.clientId ?? cid,
        locationId: ct.clientLocationId ?? null,
      });
    }
  });

  const deviceRows = toDeviceRows(agents);
  const clientRows = clients.map((c) => ({ id: c.id, name: (c.name ?? "").trim() }));

  // Rebuild every table: delete, then chunked batched inserts.
  await rebuild(env.DB, "clients", clientRows, (r) =>
    env.DB.prepare(`INSERT OR REPLACE INTO clients (id, name) VALUES (?, ?)`).bind(r.id, r.name),
  );
  await rebuild(env.DB, "locations", locationRows, (r) =>
    env.DB.prepare(`INSERT OR REPLACE INTO locations (id, name, client_id) VALUES (?, ?, ?)`).bind(
      r.id,
      r.name,
      r.clientId,
    ),
  );
  await rebuild(env.DB, "contacts", contactRows, (r) =>
    env.DB
      .prepare(
        `INSERT OR REPLACE INTO contacts (id, email, name, client_id, location_id) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(r.id, r.email, r.name, r.clientId, r.locationId),
  );
  await rebuild(env.DB, "devices", deviceRows, (r) =>
    env.DB
      .prepare(
        `INSERT INTO devices
          (hostname, client_id, location_id, agent_id, asset_num, display_name, serial, local_ip, public_ip, os)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  await setLastSync(env.DB, new Date().toISOString());
  return {
    clients: clientRows.length,
    locations: locationRows.length,
    contacts: contactRows.length,
    devices: deviceRows.length,
  };
}

/** Delete a table then re-insert `rows` in chunked batches. */
async function rebuild<T>(
  db: D1Database,
  table: string,
  rows: T[],
  toStmt: (row: T) => D1PreparedStatement,
): Promise<void> {
  await db.batch([db.prepare(`DELETE FROM ${table}`)]);
  for (const part of chunk(rows, INSERT_CHUNK)) {
    const stmts = part.map(toStmt);
    if (stmts.length) await db.batch(stmts);
  }
}
