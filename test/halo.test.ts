import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { isHaloPath } from "../src/halo.js";
import { initSchema } from "../src/db.js";
import { assetNum } from "../src/sync.js";

const HOST = "https://t2t.example.com";
const AGENT_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ASSET_NUM = assetNum(AGENT_UUID);

// --- outbound fetch stub (shared workerd isolate) ---------------------------
interface Route {
  method: string;
  match: (u: URL) => boolean;
  handler: (req: Request) => Response | Promise<Response>;
}
let routes: Route[] = [];
let realFetch: typeof fetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    for (const r of routes) if (r.method === req.method && r.match(new URL(req.url))) return r.handler(req);
    throw new Error(`unmocked fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
}
const json = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function seed(): Promise<void> {
  await initSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM clients`),
    env.DB.prepare(`DELETE FROM locations`),
    env.DB.prepare(`DELETE FROM contacts`),
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM sync_meta`),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO clients (id, name) VALUES (10, 'Corp'), (999, 'Salient MSP')`),
    env.DB.prepare(`INSERT INTO locations (id, name, client_id) VALUES (100, 'HQ', 10)`),
    env.DB
      .prepare(`INSERT INTO contacts (id, email, name, client_id, location_id) VALUES (?,?,?,?,?)`)
      .bind(55, "user@corp.com", "Jane Doe", 10, 100),
    env.DB
      .prepare(
        `INSERT INTO devices (hostname, upn, client_id, location_id, agent_id, asset_num, display_name, serial, local_ip, public_ip, os)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind("pc-01", "user@corp.com", 10, 100, AGENT_UUID, ASSET_NUM, "PC-01", "SN1", "10.0.0.5", "", ""),
    env.DB.prepare(`INSERT INTO sync_meta (key, value) VALUES ('last_sync', '2026-01-01T00:00:00Z')`),
  ]);
}

beforeEach(async () => {
  routes = [];
  installFetch();
  await seed();
});

async function req(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${HOST}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("isHaloPath", () => {
  it("matches token + resource paths, not admin/health", () => {
    expect(isHaloPath("/auth/token")).toBe(true);
    expect(isHaloPath("/api/Tickets")).toBe(true);
    expect(isHaloPath("/health")).toBe(false);
    expect(isHaloPath("/admin/sync")).toBe(false);
  });
});

describe("Halo OAuth token", () => {
  const token = (client_secret: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: "halo-test-id",
      client_secret,
      scope: "all",
    }).toString(),
  });

  it("issues a bearer token for valid client credentials", async () => {
    const res = await req("/auth/token", token("halo-test-secret"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect((j.access_token as string).length).toBeGreaterThan(0);
    expect(j.token_type).toBe("Bearer");
  });

  it("rejects a wrong client secret", async () => {
    const res = await req("/auth/token", token("nope"));
    expect(res.status).toBe(401);
  });
});

describe("Halo lookups (Gorelo-backed)", () => {
  it("GET /api/Client returns mirrored clients", async () => {
    const res = await req("/api/Client?search=corp");
    expect(await res.json()).toEqual({ clients: [{ id: 10, name: "Corp" }], record_count: 1 });
  });

  it("GET /api/Users resolves a contact by email", async () => {
    const res = await req("/api/Users?search=user@corp.com");
    const j = (await res.json()) as { users: Array<Record<string, unknown>> };
    expect(j.users).toHaveLength(1);
    expect(j.users[0]).toMatchObject({
      id: 55,
      emailaddress: "user@corp.com",
      client_id: 10,
      client_name: "Corp",
      site_id: 100,
    });
  });

  it("GET /api/Users maps the unregistered catch-all user", async () => {
    const res = await req(`/api/Users?search=unregistered@helpdeskbuttons.com`);
    const j = (await res.json()) as { users: Array<Record<string, unknown>> };
    expect(j.users[0]).toMatchObject({ id: 0, client_id: 999 });
  });

  it("GET /api/Site filters by client_id", async () => {
    const res = await req("/api/Site?client_id=10");
    expect(await res.json()).toEqual({
      sites: [{ id: 100, name: "HQ", client_id: 10 }],
      record_count: 1,
    });
  });

  it("GET /api/Asset returns the device with its numeric surrogate id", async () => {
    const res = await req("/api/Asset?search=pc-01");
    const j = (await res.json()) as { assets: Array<Record<string, unknown>> };
    expect(j.assets[0]).toMatchObject({ id: ASSET_NUM, inventory_number: "pc-01", client_id: 10 });
  });

  it("GET /api/TicketType returns a default type", async () => {
    const res = await req("/api/TicketType");
    expect(await res.json()).toEqual([{ id: 3, name: "Incident" }]);
  });
});

describe("Halo ticket create -> Gorelo", () => {
  it("maps looked-up ids + rich data into a Gorelo ticket", async () => {
    let posted: Record<string, unknown> | undefined;
    routes.push({
      method: "POST",
      match: (u) => u.pathname === "/v1/tickets",
      handler: async (r) => {
        posted = (await r.json()) as Record<string, unknown>;
        return json(200, { ticketId: "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a" });
      },
    });

    const res = await req("/api/Tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          summary: "Printer down",
          details: "It won't print",
          client_id: 10,
          site_id: 100,
          user_id: 55,
          emailfrom: "user@corp.com",
          assets: [{ id: ASSET_NUM }],
          category_1: "Hardware>Printer",
        },
      ]),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ client_id: 10, site_id: 100, user_id: 55 });
    expect(typeof body.id).toBe("number");
    expect(body.gorelo_ticket_id).toBe("cb83b6cf-959c-4eed-afb8-ba3e18a3c53a");

    expect(posted).toMatchObject({
      title: "Printer down",
      clientId: 10,
      locationId: 100,
      contactId: 55,
      statusId: 1,
      groupId: 7,
      typeId: 3,
      agentAssetIds: [AGENT_UUID],
    });
    const desc = String(posted?.description);
    expect(desc).toContain("It won't print");
    expect(desc).toContain("category_1: Hardware>Printer");
  });

  it("falls back to the catch-all client when nothing matches", async () => {
    let posted: Record<string, unknown> | undefined;
    routes.push({
      method: "POST",
      match: (u) => u.pathname === "/v1/tickets",
      handler: async (r) => {
        posted = (await r.json()) as Record<string, unknown>;
        return json(200, { ticketId: "00000000-0000-0000-0000-000000000000" });
      },
    });
    const res = await req("/api/Tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ summary: "help", details: "x", emailfrom: "stranger@nowhere.test" }]),
    });
    expect(res.status).toBe(201);
    expect(posted).toMatchObject({ clientId: 999, contactId: null, agentAssetIds: [] });
  });
});
