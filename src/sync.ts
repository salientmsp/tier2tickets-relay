import { initSchema, setLastSync } from "./db.js";
import { GoreloClient } from "./gorelo.js";
import { normalizeHost } from "./parse.js";
import type { Env, PublicClientResponse, PublicDeviceResponse } from "./types.js";

const INSERT_CHUNK = 100; // stay within D1's per-batch statement limits

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface DeviceInsert {
  hostname: string;
  upn: string;
  clientId: number;
  locationId: number | null;
  agentId: string;
}

interface DomainInsert {
  domain: string;
  clientId: number;
}

/** Map Gorelo agents -> device rows. Prefer displayName then name for hostname. */
function toDeviceRows(agents: PublicDeviceResponse[]): DeviceInsert[] {
  const rows: DeviceInsert[] = [];
  for (const a of agents) {
    if (a.clientId == null) continue; // can't route without a client
    const host = normalizeHost(a.displayName ?? a.name ?? "");
    const upn = (a.lastLoggedOnUserUpn ?? "").trim().toLowerCase();
    rows.push({
      hostname: host,
      upn,
      clientId: a.clientId,
      locationId: a.clientLocationId ?? null,
      agentId: a.id,
    });
  }
  return rows;
}

/** Map Gorelo clients -> (domain -> client_id) rows, deduped (domain is PK). */
function toDomainRows(clients: PublicClientResponse[]): DomainInsert[] {
  const seen = new Map<string, number>();
  for (const c of clients) {
    for (const d of c.domains ?? []) {
      const domain = (d?.domain ?? d?.name ?? "").trim().toLowerCase();
      if (domain && !seen.has(domain)) seen.set(domain, c.id);
    }
  }
  return [...seen.entries()].map(([domain, clientId]) => ({ domain, clientId }));
}

/**
 * Rebuild the D1 mirror from Gorelo. Fetches agents + clients, rebuilds both
 * tables (delete + chunked batched inserts), then stamps last_sync.
 * Runs off the request path (cron / admin / first-press bootstrap).
 */
export async function syncAll(env: Env): Promise<{ devices: number; domains: number }> {
  await initSchema(env.DB);
  const client = new GoreloClient(env);

  const [agents, clients] = await Promise.all([client.listAgents(), client.listClients()]);
  const deviceRows = toDeviceRows(agents);
  const domainRows = toDomainRows(clients);

  // Rebuild devices.
  const deviceStmts: D1PreparedStatement[] = [env.DB.prepare(`DELETE FROM devices`)];
  await env.DB.batch(deviceStmts);
  for (const part of chunk(deviceRows, INSERT_CHUNK)) {
    const stmts = part.map((r) =>
      env.DB.prepare(
        `INSERT INTO devices (hostname, upn, client_id, location_id, agent_id) VALUES (?, ?, ?, ?, ?)`,
      ).bind(r.hostname, r.upn, r.clientId, r.locationId, r.agentId),
    );
    if (stmts.length) await env.DB.batch(stmts);
  }

  // Rebuild client_domains.
  await env.DB.batch([env.DB.prepare(`DELETE FROM client_domains`)]);
  for (const part of chunk(domainRows, INSERT_CHUNK)) {
    const stmts = part.map((r) =>
      env.DB.prepare(`INSERT INTO client_domains (domain, client_id) VALUES (?, ?)`).bind(
        r.domain,
        r.clientId,
      ),
    );
    if (stmts.length) await env.DB.batch(stmts);
  }

  await setLastSync(env.DB, new Date().toISOString());
  return { devices: deviceRows.length, domains: domainRows.length };
}
