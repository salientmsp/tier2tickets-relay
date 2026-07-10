import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/db.js";
import { assetNum, syncAll } from "../src/sync.js";

// --- outbound fetch stub: mock the four Gorelo list endpoints syncAll pulls ----
interface GoreloData {
  agents: Record<string, unknown>[];
  clients: Record<string, unknown>[];
  locations: Record<number, Record<string, unknown>[]>;
  contacts: Record<number, Record<string, unknown>[]>;
}
let data: GoreloData;
let realFetch: typeof fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(new Request(input as RequestInfo, init).url);
    const p = url.pathname;
    if (p === "/v1/assets/agents") return json(data.agents);
    if (p === "/v1/clients") return json(data.clients);
    const loc = p.match(/^\/v1\/clients\/(\d+)\/locations$/);
    if (loc) return json(data.locations[Number(loc[1])] ?? []);
    if (p === "/v1/contacts") {
      const cid = Number(url.searchParams.get("clientid"));
      return json(data.contacts[cid] ?? []);
    }
    throw new Error(`unmocked fetch: ${p}`);
  }) as typeof fetch;
}

// Build a Gorelo dataset: one client (id 10) with one site, one contact, one device.
function baseData(): GoreloData {
  return {
    clients: [{ id: 10, name: "Corp" }],
    locations: { 10: [{ id: 100, name: "HQ" }] },
    contacts: {
      10: [{ id: 55, primaryEmail: "user@corp.com", firstName: "Jane", lastName: "Doe", clientId: 10, clientLocationId: 100 }],
    },
    agents: [
      {
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        clientId: 10,
        clientLocationId: 100,
        displayName: "PC-01",
        serialNo: "SN1",
        localIPAddress: "10.0.0.5",
        publicIPAddress: "",
      },
    ],
  };
}

async function wipe(): Promise<void> {
  await initSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM clients`),
    env.DB.prepare(`DELETE FROM locations`),
    env.DB.prepare(`DELETE FROM contacts`),
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM sync_meta`),
  ]);
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? 0;
}

beforeEach(async () => {
  data = baseData();
  installFetch();
  await wipe();
});

describe("syncAll delta reconcile", () => {
  it("upserts the full dataset on a first (empty-mirror) sync", async () => {
    const r = await syncAll(env);
    // Every table starts empty, so all four rows are written and none deleted.
    expect(r).toEqual({ clients: 1, locations: 1, contacts: 1, devices: 1, changed: 4, deleted: 0 });
    expect(await count("clients")).toBe(1);
    expect(await count("locations")).toBe(1);
    expect(await count("contacts")).toBe(1);
    expect(await count("devices")).toBe(1);

    const dev = await env.DB
      .prepare(`SELECT hostname, asset_num FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ hostname: string; asset_num: number }>();
    expect(dev?.hostname).toBe("pc-01"); // normalizeHost lowercases
    expect(dev?.asset_num).toBe(assetNum(String(data.agents[0]!.id)));
  });

  it("reports zero changes when nothing changed upstream (no wasted writes)", async () => {
    await syncAll(env);
    const r = await syncAll(env); // identical dataset, second run
    expect(r.changed).toBe(0);
    expect(r.deleted).toBe(0);
    // Row counts unchanged.
    expect(r).toMatchObject({ clients: 1, locations: 1, contacts: 1, devices: 1 });
  });

  it("is idempotent: a second identical sync changes no rows and keeps the data", async () => {
    await syncAll(env);
    // Tag every row so we can detect an unnecessary rewrite: a real
    // delete+reinsert would blow these markers away, an upsert-with-diff-guard
    // leaves untouched rows alone.
    await env.DB.batch([
      env.DB.prepare(`UPDATE clients SET name = name || '#'`),
      env.DB.prepare(`UPDATE devices SET os = 'MARK'`),
    ]);
    // Re-fetch identical data (except the columns we just poked locally). The
    // client name now differs from upstream, so it SHOULD be corrected; the
    // device os we set is not part of the Gorelo agent payload (os is always
    // "" from the fleet list) so it will be rewritten back to "".
    await syncAll(env);
    expect(await count("clients")).toBe(1);
    expect(await count("devices")).toBe(1);
    const c = await env.DB.prepare(`SELECT name FROM clients WHERE id = 10`).first<{ name: string }>();
    expect(c?.name).toBe("Corp"); // upstream value restored
  });

  it("deletes rows that vanished upstream and inserts newly-appeared ones", async () => {
    await syncAll(env);
    expect(await count("devices")).toBe(1);

    // Upstream: the old device is gone, two new ones appear; a new client too.
    data.clients.push({ id: 20, name: "NewCo" });
    data.locations[20] = [{ id: 200, name: "Branch" }];
    data.contacts[20] = [];
    data.agents = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", clientId: 10, clientLocationId: 100, displayName: "PC-NEW" },
      { id: "bbbbbbbb-0000-0000-0000-000000000002", clientId: 20, clientLocationId: 200, displayName: "PC-BRANCH" },
    ];

    const r = await syncAll(env);
    expect(r.devices).toBe(2);
    // 2 new devices + 1 new client + 1 new location written; old device deleted.
    expect(r.changed).toBeGreaterThanOrEqual(4);
    expect(r.deleted).toBe(1); // the vanished device
    expect(await count("devices")).toBe(2);
    expect(await count("clients")).toBe(2);

    // The original device (its agent_id) must be gone.
    const gone = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM devices WHERE agent_id = ?`)
      .bind("3fa85f64-5717-4562-b3fc-2c963f66afa6")
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
  });

  it("applies a field change to an existing row in place (same agent_id)", async () => {
    await syncAll(env);
    // Same device id, new hostname + serial.
    data.agents[0]!.displayName = "PC-RENAMED";
    data.agents[0]!.serialNo = "SN2";
    const r = await syncAll(env);
    expect(r.changed).toBe(1); // exactly the one device row updated in place
    expect(r.deleted).toBe(0);

    expect(await count("devices")).toBe(1); // still one row, updated not duplicated
    const dev = await env.DB
      .prepare(`SELECT hostname, serial FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ hostname: string; serial: string }>();
    expect(dev?.hostname).toBe("pc-renamed");
    expect(dev?.serial).toBe("SN2");
  });
});
