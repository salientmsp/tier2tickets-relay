import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { initSchema } from "../src/db.js";
import { assetNum, syncAll } from "../src/sync.js";
import type { SyncLocationsMessage } from "../src/types.js";

// --- outbound fetch stub: mock the Gorelo list endpoints the sync pulls --------
interface GoreloData {
  agents: Record<string, unknown>[];
  clients: Record<string, unknown>[];
  locations: Record<number, Record<string, unknown>[]>;
  // Keyed by client id for readability; the bulk /v1/contacts stub flattens them.
  contacts: Record<number, Record<string, unknown>[]>;
  // When true, the bulk /v1/contacts fetch fails (400) — simulates a partial sync.
  failAllContacts: boolean;
  // Client ids whose /v1/clients/{id}/locations fetch should fail (400).
  failLocations: Set<number>;
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

// --- 2026-08 Gorelo wire-format helpers ----------------------------------------
// Responses now carry PascalCase fields inside the standard envelope, with paging
// under DataContext.Pagination. Keep the camelCase fixtures below and convert at the
// mock boundary so the mocked bytes match the real wire shape the relay must parse.
function rekey(v: unknown, fn: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => rekey(x, fn));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[fn(k)] = rekey(val, fn);
    return o;
  }
  return v;
}
const pascal = (v: unknown): unknown => rekey(v, (k) => (k ? k[0]!.toUpperCase() + k.slice(1) : k));

/** A single-page enveloped list response (PascalCase Data, paging in DataContext). */
const listEnv = (items: unknown[], pagination?: Record<string, unknown>): Response =>
  json({
    StatusCode: 200,
    IsSuccess: true,
    Data: pascal(items),
    DataContext: { Pagination: pagination ?? { NextCursor: null, HasMore: false, TotalCount: items.length } },
    Notifications: [],
  });

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(new Request(input as RequestInfo, init).url);
    const p = url.pathname;
    if (p === "/v1/assets/agents") return listEnv(data.agents);
    if (p === "/v1/clients") return listEnv(data.clients);
    const loc = p.match(/^\/v1\/clients\/(\d+)\/locations$/);
    if (loc) {
      const cid = Number(loc[1]);
      if (data.failLocations.has(cid)) return new Response("bad request", { status: 400 });
      return listEnv(data.locations[cid] ?? []);
    }
    if (p === "/v1/contacts") {
      // Bulk fetch (no clientid): return every contact flattened.
      if (data.failAllContacts) return new Response("bad request", { status: 400 });
      return listEnv(Object.values(data.contacts).flat());
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
      10: [{ id: 55, primaryEmail: "user@corp.com", firstName: "Jane", lastName: "Doe", clientId: 10, locationId: 100 }],
    },
    agents: [
      {
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        clientId: 10,
        locationId: 100,
        displayName: "PC-01",
        serialNo: "SN1",
        localIPAddress: "10.0.0.5",
        publicIPAddress: "",
      },
    ],
    failAllContacts: false,
    failLocations: new Set<number>(),
  };
}

// A capturing SYNC_QUEUE producer: records the client ids syncAll enqueues.
function makeQueue(): { queued: number[]; env: typeof env } {
  const queued: number[] = [];
  const SYNC_QUEUE = {
    send: async (b: SyncLocationsMessage) => void queued.push(b.clientId),
    sendBatch: async (msgs: Iterable<{ body: SyncLocationsMessage }>) => {
      for (const m of msgs) queued.push(m.body.clientId);
    },
  } as unknown as Queue<SyncLocationsMessage>;
  return { queued, env: { ...env, SYNC_QUEUE } };
}

// Drive the real queue consumer (worker.queue) over a set of client ids.
async function runConsumer(clientIds: number[]): Promise<{ acked: number[]; retried: number[] }> {
  const acked: number[] = [];
  const retried: number[] = [];
  const messages = clientIds.map((clientId) => ({
    body: { type: "locations" as const, clientId },
    id: `m-${clientId}`,
    timestamp: new Date(0),
    attempts: 1,
    ack: () => void acked.push(clientId),
    retry: () => void retried.push(clientId),
  }));
  const batch = { queue: "tier2tickets-sync", messages, ackAll: () => {}, retryAll: () => {} };
  const ctx = createExecutionContext();
  await worker.queue!(batch as unknown as MessageBatch<SyncLocationsMessage>, env, ctx);
  await waitOnExecutionContext(ctx);
  return { acked, retried };
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

describe("syncAll delta reconcile (inline tables + location fan-out)", () => {
  it("reconciles clients/contacts/devices inline and enqueues one location message per client", async () => {
    const q = makeQueue();
    const r = await syncAll(q.env);
    // Locations are NOT written inline — they're enqueued for the consumer.
    expect(r).toEqual({
      clients: 1,
      locations: 0, // queue not drained yet
      contacts: 1,
      devices: 1,
      locationsQueued: 1,
      changed: 3, // clients + contacts + devices (locations are async)
      deleted: 0,
      complete: true,
    });
    expect(q.queued).toEqual([10]);
    expect(await count("clients")).toBe(1);
    expect(await count("contacts")).toBe(1);
    expect(await count("devices")).toBe(1);

    const dev = await env.DB
      .prepare(`SELECT hostname, asset_num FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ hostname: string; asset_num: number }>();
    expect(dev?.hostname).toBe("pc-01"); // normalizeHost lowercases
    expect(dev?.asset_num).toBe(assetNum(String(data.agents[0]!.id)));
  });

  // Regression: Gorelo renamed the site field on devices and contacts from
  // `clientLocationId` to `locationId`. Both are optional on the response types, so the
  // sync kept reading the old name with no type error, wrote NULL for every device and
  // contact, and nulled the site on every ticket the relay filed. Nothing failed — the
  // old suite mocked the pre-rename shape, so it agreed with the bug. These assert the
  // mirrored site id directly, in both response shapes.
  it("mirrors the site id from `locationId` (the current Gorelo shape)", async () => {
    await syncAll(makeQueue().env);

    const dev = await env.DB
      .prepare(`SELECT location_id FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ location_id: number | null }>();
    expect(dev?.location_id).toBe(100);

    const ct = await env.DB
      .prepare(`SELECT location_id FROM contacts WHERE id = 55`)
      .first<{ location_id: number | null }>();
    expect(ct?.location_id).toBe(100);
  });

  it("still mirrors the site id from the legacy `clientLocationId` shape", async () => {
    // A region that has not rolled the rename out yet, or a rollback.
    data.agents[0] = { id: data.agents[0]!.id, clientId: 10, clientLocationId: 100, displayName: "PC-01" };
    data.contacts[10] = [
      { id: 55, primaryEmail: "user@corp.com", firstName: "Jane", lastName: "Doe", clientId: 10, clientLocationId: 100 },
    ];
    await syncAll(makeQueue().env);

    const dev = await env.DB
      .prepare(`SELECT location_id FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ location_id: number | null }>();
    expect(dev?.location_id).toBe(100);

    const ct = await env.DB
      .prepare(`SELECT location_id FROM contacts WHERE id = 55`)
      .first<{ location_id: number | null }>();
    expect(ct?.location_id).toBe(100);
  });

  it("leaves the site id NULL when Gorelo sends neither field", async () => {
    data.agents[0] = { id: data.agents[0]!.id, clientId: 10, displayName: "PC-01" };
    await syncAll(makeQueue().env);

    const dev = await env.DB
      .prepare(`SELECT location_id FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ location_id: number | null }>();
    expect(dev?.location_id).toBeNull();
  });

  it("reports zero changes when nothing changed upstream (no wasted writes)", async () => {
    await syncAll(makeQueue().env);
    const r = await syncAll(makeQueue().env); // identical dataset, second run
    expect(r.changed).toBe(0);
    expect(r.deleted).toBe(0);
    expect(r).toMatchObject({ clients: 1, contacts: 1, devices: 1, locationsQueued: 1 });
  });

  it("is idempotent: a second identical sync changes no inline rows and keeps the data", async () => {
    await syncAll(makeQueue().env);
    // Poke a column upstream-owns so an unnecessary rewrite would be visible; the
    // upsert's WHERE-guard should still restore it (proving it did run) without a
    // full delete+reinsert.
    await env.DB.batch([env.DB.prepare(`UPDATE clients SET name = name || '#'`)]);
    await syncAll(makeQueue().env);
    expect(await count("clients")).toBe(1);
    const c = await env.DB.prepare(`SELECT name FROM clients WHERE id = 10`).first<{ name: string }>();
    expect(c?.name).toBe("Corp"); // upstream value restored
  });

  it("deletes vanished devices, inserts new ones, and enqueues all current clients", async () => {
    await syncAll(makeQueue().env);
    expect(await count("devices")).toBe(1);

    data.clients.push({ id: 20, name: "NewCo" });
    data.agents = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", clientId: 10, locationId: 100, displayName: "PC-NEW" },
      { id: "bbbbbbbb-0000-0000-0000-000000000002", clientId: 20, locationId: 200, displayName: "PC-BRANCH" },
    ];

    const q = makeQueue();
    const r = await syncAll(q.env);
    expect(r.devices).toBe(2);
    expect(r.deleted).toBe(1); // the vanished original device
    expect(q.queued.sort()).toEqual([10, 20]); // a message per current client
    const gone = await env.DB
      .prepare(`SELECT COUNT(*) AS n FROM devices WHERE agent_id = ?`)
      .bind("3fa85f64-5717-4562-b3fc-2c963f66afa6")
      .first<{ n: number }>();
    expect(gone?.n).toBe(0);
  });

  it("deletes more than 100 stale rows without blowing D1's bound-variable cap", async () => {
    // Seed 250 mirror devices, then let upstream return an empty fleet so every
    // one is stale. The delete IN-list must chunk under D1's ~100-param-per-query
    // limit — a single 250-placeholder DELETE throws "too many SQL variables".
    const N = 250;
    const inserts = Array.from({ length: N }, (_, i) =>
      env.DB
        .prepare(
          `INSERT INTO devices (hostname, client_id, location_id, agent_id, asset_num) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(`pc-${i}`, 10, 100, `agent-${i}`, i + 1),
    );
    await env.DB.batch(inserts);
    expect(await count("devices")).toBe(N);

    data.agents = []; // upstream fleet is now empty -> all 250 are stale
    const r = await syncAll(makeQueue().env);
    expect(r.deleted).toBe(N);
    expect(await count("devices")).toBe(0);
  });

  it("follows cursor pagination on the bulk list endpoints (all pages land in the mirror)", async () => {
    // 2026-08: signed cursors + paging under DataContext.Pagination, PascalCase Data.
    // The sync must follow NextCursor across pages to get every row.
    const contactsByCursor: Record<string, Response> = {
      "": listEnv(
        [
          { id: 1, primaryEmail: "a@corp.com", firstName: "A", lastName: "A", clientId: 10, locationId: 100 },
          { id: 2, primaryEmail: "b@corp.com", firstName: "B", lastName: "B", clientId: 10, locationId: 100 },
        ],
        { NextCursor: "page2", HasMore: true },
      ),
      page2: listEnv(
        [{ id: 3, primaryEmail: "c@corp.com", firstName: "C", lastName: "C", clientId: 10, locationId: 100 }],
        { NextCursor: null, HasMore: false },
      ),
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(new Request(input as RequestInfo, init).url);
      const p = url.pathname;
      if (p === "/v1/assets/agents") return listEnv([]);
      if (p === "/v1/clients") return listEnv([{ id: 10, name: "Corp" }]);
      if (p === "/v1/contacts") return contactsByCursor[url.searchParams.get("cursor") ?? ""]!.clone();
      throw new Error(`unmocked fetch: ${p}`);
    }) as typeof fetch;

    const r = await syncAll(makeQueue().env);
    expect(r.contacts).toBe(3); // both pages reconciled, not just the first
    expect(await count("contacts")).toBe(3);
  });

  it("drops locations of a client that vanished upstream (inline, D1-only)", async () => {
    // Seed two clients' locations via the consumer, then remove client 20.
    data.clients.push({ id: 20, name: "NewCo" });
    data.locations[20] = [{ id: 200, name: "Branch" }];
    await syncAll(makeQueue().env);
    await runConsumer([10, 20]);
    expect(await count("locations")).toBe(2);

    // Client 20 disappears upstream -> its site must be dropped on the next sync.
    data.clients = [{ id: 10, name: "Corp" }];
    await syncAll(makeQueue().env);
    expect(await count("locations")).toBe(1);
    const orphan = await env.DB.prepare(`SELECT COUNT(*) AS n FROM locations WHERE client_id = 20`).first<{ n: number }>();
    expect(orphan?.n).toBe(0);
  });

  it("does NOT delete contacts when the bulk contacts fetch fails (partial sync)", async () => {
    data.clients.push({ id: 20, name: "NewCo" });
    data.contacts[20] = [
      { id: 77, primaryEmail: "bob@newco.com", firstName: "Bob", lastName: "Roe", clientId: 20, locationId: 200 },
    ];
    await syncAll(makeQueue().env);
    expect(await count("contacts")).toBe(2);

    data.failAllContacts = true;
    const r = await syncAll(makeQueue().env);
    expect(r.complete).toBe(false);
    expect(r.deleted).toBe(0); // no contact deletes despite the fetch returning nothing
    expect(await count("contacts")).toBe(2);
  });

  it("collapses a duplicate contact id in the bulk feed to one stable row", async () => {
    data.contacts[10] = [
      { id: 55, primaryEmail: "a@corp.com", firstName: "Jane", lastName: "A", clientId: 10, locationId: 100 },
      { id: 55, primaryEmail: "b@corp.com", firstName: "Jane", lastName: "B", clientId: 20, locationId: 200 },
    ];
    await syncAll(makeQueue().env);
    expect(await count("contacts")).toBe(1);
    const first = await env.DB.prepare(`SELECT email FROM contacts WHERE id = 55`).first<{ email: string }>();

    const r2 = await syncAll(makeQueue().env);
    expect(r2.changed).toBe(0); // stable winner — no rewrite
    const second = await env.DB.prepare(`SELECT email FROM contacts WHERE id = 55`).first<{ email: string }>();
    expect(second?.email).toBe(first?.email);
  });

  it("applies a device field change in place (same agent_id)", async () => {
    await syncAll(makeQueue().env);
    data.agents[0]!.displayName = "PC-RENAMED";
    data.agents[0]!.serialNo = "SN2";
    const r = await syncAll(makeQueue().env);
    expect(r.changed).toBe(1); // exactly the one device row updated in place
    expect(await count("devices")).toBe(1);
    const dev = await env.DB
      .prepare(`SELECT hostname, serial FROM devices WHERE agent_id = ?`)
      .bind(data.agents[0]!.id)
      .first<{ hostname: string; serial: string }>();
    expect(dev?.hostname).toBe("pc-renamed");
    expect(dev?.serial).toBe("SN2");
  });
});

describe("/admin/status", () => {
  async function status(method: string, headers?: Record<string, string>): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("https://t2t.example.com/admin/status", { method, headers }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("requires the admin key", async () => {
    expect((await status("GET")).status).toBe(401);
  });

  it("is GET-only: a wrong method returns 405 (not 404) with an Allow header", async () => {
    const res = await status("POST", { "X-Admin-Key": "test-admin-key" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET");
  });

  it("reports mirror counts and location-queue drain progress", async () => {
    await syncAll(makeQueue().env); // enqueues 1 location message, stamps enqueued_at
    await runConsumer([10]); // consumer reconciles client 10, stamps synced_at

    const res = await status("GET", { "X-Admin-Key": "test-admin-key" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mirror: { clients: number; locations: number; contacts: number; devices: number };
      lastSync: string | null;
      locationQueue: { queued: number | null; drained: boolean; lagSeconds: number | null };
    };
    expect(body.mirror).toMatchObject({ clients: 1, contacts: 1, devices: 1 });
    expect(body.mirror.locations).toBe(1); // consumer wrote client 10's site
    expect(body.lastSync).toBeTruthy();
    expect(body.locationQueue.queued).toBe(1);
    expect(body.locationQueue.drained).toBe(true); // consumer ran after the enqueue
    expect(body.locationQueue.lagSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("location queue consumer", () => {
  it("fetches and upserts a client's sites, then acks", async () => {
    data.locations[10] = [{ id: 100, name: "HQ" }, { id: 101, name: "Annex" }];
    const { acked, retried } = await runConsumer([10]);
    expect(acked).toEqual([10]);
    expect(retried).toEqual([]);
    expect(await count("locations")).toBe(2);
    const hq = await env.DB.prepare(`SELECT name, client_id FROM locations WHERE id = 100`).first<{ name: string; client_id: number }>();
    expect(hq).toEqual({ name: "HQ", client_id: 10 });
  });

  it("reconciles deletes scoped to one client, leaving other clients' sites alone", async () => {
    // Pre-seed: client 10 has 100+101, client 20 has 200.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO locations (id, name, client_id) VALUES (100,'HQ',10),(101,'Old',10),(200,'Branch',20)`),
    ]);
    // Upstream, client 10 now has only 100 -> 101 is stale for client 10.
    data.locations[10] = [{ id: 100, name: "HQ" }];
    await runConsumer([10]);
    expect(await count("locations")).toBe(2); // 101 gone, 100 + 200 remain
    const stale = await env.DB.prepare(`SELECT COUNT(*) AS n FROM locations WHERE id = 101`).first<{ n: number }>();
    expect(stale?.n).toBe(0);
    const other = await env.DB.prepare(`SELECT COUNT(*) AS n FROM locations WHERE id = 200`).first<{ n: number }>();
    expect(other?.n).toBe(1); // client 20 untouched
  });

  it("retries (never deletes) when a client's locations fetch fails", async () => {
    await env.DB.batch([env.DB.prepare(`INSERT INTO locations (id, name, client_id) VALUES (100,'HQ',10)`)]);
    data.failLocations.add(10);
    const { acked, retried } = await runConsumer([10]);
    expect(acked).toEqual([]);
    expect(retried).toEqual([10]); // redelivered, not dropped
    expect(await count("locations")).toBe(1); // existing site preserved
  });
});
