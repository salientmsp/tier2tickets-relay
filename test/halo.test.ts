import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { flushPendingTickets, haloResource, isHaloPath } from "../src/halo.js";
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
    const url = new URL(req.url);
    for (const r of routes) if (r.method === req.method && r.match(url)) return r.handler(req);
    // Fallback: the live agent-detail lookup 404s unless a test mocks it (getAgent
    // tolerates that and falls back to the mirror row). Everything else is an error.
    if (req.method === "GET" && /^\/v1\/assets\/agents\//.test(url.pathname)) {
      return new Response("", { status: 404 });
    }
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
    env.DB.prepare(`DELETE FROM pending_tickets`),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO clients (id, name) VALUES (10, 'Corp'), (999, 'Salient MSP')`),
    env.DB.prepare(`INSERT INTO locations (id, name, client_id) VALUES (100, 'HQ', 10)`),
    env.DB
      .prepare(`INSERT INTO contacts (id, email, name, client_id, location_id) VALUES (?,?,?,?,?)`)
      .bind(55, "user@corp.com", "Jane Doe", 10, 100),
    env.DB
      .prepare(
        `INSERT INTO devices (hostname, client_id, location_id, agent_id, asset_num, display_name, serial, local_ip, public_ip, os)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .bind("pc-01", 10, 100, AGENT_UUID, ASSET_NUM, "PC-01", "SN1", "10.0.0.5", "", ""),
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

describe("isHaloPath / haloResource", () => {
  it("matches the real Tier2 paths (no /api prefix) and the /api form", () => {
    // Tier2 actually calls these (from the capture): /token, /users, ...
    expect(isHaloPath("/token")).toBe(true);
    expect(isHaloPath("/users")).toBe(true);
    expect(isHaloPath("/tickets")).toBe(true);
    expect(isHaloPath("/api/Users")).toBe(true);
    expect(isHaloPath("/auth/token")).toBe(true);
    expect(isHaloPath("/health")).toBe(false);
    expect(isHaloPath("/admin/sync")).toBe(false);
  });
  it("normalizes to a resource name", () => {
    expect(haloResource("/users")).toBe("users");
    expect(haloResource("/api/Users/123")).toBe("users");
    expect(haloResource("/token")).toBe("token");
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

  it("issues a bearer token at the real Tier2 path POST /token?tenant=", async () => {
    const res = await req("/token?tenant=salient-x", token("halo-test-secret"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect((j.access_token as string).length).toBeGreaterThan(0);
    expect(j.token_type).toBe("Bearer");
  });

  it("rejects a wrong client secret", async () => {
    const res = await req("/token", token("nope"));
    expect(res.status).toBe(401);
  });
});

describe("Halo routing to real Tier2 paths (no /api prefix)", () => {
  it("GET /users (lowercase, halo-app-name header) resolves a contact", async () => {
    const res = await req("/users?search=user@corp.com", { headers: { "halo-app-name": "tier2tech" } });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { users: Array<Record<string, unknown>> };
    expect(j.users[0]).toMatchObject({ id: 55, client_id: 10 });
  });

  it("GET /users for the unregistered catch-all returns JSON (never 404/text)", async () => {
    const res = await req("/users?search=unregistered@helpdeskbuttons.com");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const j = (await res.json()) as { users: Array<Record<string, unknown>> };
    expect(j.users[0]).toMatchObject({ id: 999999999, client_id: 999 });
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
    expect(j.users[0]).toMatchObject({ id: 999999999, client_id: 999 });
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

// A minimal Tier2 "Report Summary" table (the real payload embeds the reporter
// identity here, not in the Halo user_id, which is the catch-all).
const reportHtml = (opts: {
  email?: string;
  host?: string;
  name?: string;
  company?: string;
  selections?: string;
}): string =>
  `<table><tbody>
     <tr><td style="font-weight:600;">Name:</td><td>${opts.name ?? "Eli Brody"}</td></tr>
     ${opts.email ? `<tr><td style="font-weight:600;">Email:</td><td>${opts.email}</td></tr>` : ""}
     ${opts.company ? `<tr><td style="font-weight:600;">Business Name:</td><td>${opts.company}</td></tr>` : ""}
     ${opts.host ? `<tr><td style="font-weight:600;">Hostname:</td><td>${opts.host}</td></tr>` : ""}
     ${opts.selections ? `<tr><td style="font-weight:600;">Selections:</td><td>${opts.selections}</td></tr>` : ""}
   </tbody></table>`;

/** Capture the single Gorelo create call (returns a fixed ticket uuid). */
function captureGoreloCreate(uuid = "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a"): {
  posted: () => Record<string, unknown> | undefined;
} {
  let posted: Record<string, unknown> | undefined;
  routes.push({
    method: "POST",
    match: (u) => u.pathname === "/v1/tickets",
    handler: async (r) => {
      posted = (await r.json()) as Record<string, unknown>;
      return json(200, { ticketId: uuid });
    },
  });
  return { posted: () => posted };
}

describe("Halo deferred ticket create (/tickets queues, /actions creates)", () => {
  it("does NOT create the Gorelo ticket on /tickets — it queues it", async () => {
    const cap = captureGoreloCreate();
    const res = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ summary: "Printer down", details_html: reportHtml({ email: "user@corp.com" }) }]),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.id).toBe("number");
    // Deferred: nothing posted to Gorelo yet.
    expect(cap.posted()).toBeUndefined();
    // The command is queued for its note.
    const row = await env.DB.prepare(`SELECT command FROM pending_tickets WHERE halo_id = ?`)
      .bind(body.id)
      .first<{ command: string }>();
    expect(row).not.toBeNull();
  });

  it("creates the Gorelo ticket when the /actions note arrives, folding in the note", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        {
          summary: "Printer down",
          details_html: reportHtml({ email: "user@corp.com", host: "pc-01" }),
          user_id: 999999999, // Tier2 always sends the unregistered catch-all user
          client_id: 999, // ...and the catch-all client
          site_id: 0,
        },
      ]),
    });
    const haloId = ((await created.json()) as { id: number }).id;

    const res = await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "<b>It won't print</b>" }]),
    });
    expect(res.status).toBe(201);

    const posted = cap.posted();
    expect(posted).toMatchObject({
      title: "Printer down",
      // Resolved from the report email/hostname, NOT the catch-all ids Tier2 sent.
      clientId: 10,
      locationId: 100,
      contactId: 55,
      statusId: 1,
      groupId: 7,
      typeId: 3,
      tagIds: [31974],
      agentAssetIds: [AGENT_UUID],
    });
    const desc = String(posted?.description);
    // The report fields are rendered into the HTML body (reporter email survives).
    expect(desc).toContain("user@corp.com");
    // HTML formatting: section headers + line breaks.
    expect(desc).toContain("<b>Report Summary</b>");
    expect(desc).toContain("<br>");
    // The routing detail is logged, not shown in the ticket.
    expect(desc).not.toContain("Helpdesk Buttons routing");
    // The notification note is NOT dumped into the body.
    expect(desc).not.toContain("@font-face");
    // the pending row is consumed
    const row = await env.DB.prepare(`SELECT command FROM pending_tickets WHERE halo_id = ?`)
      .bind(haloId)
      .first();
    expect(row).toBeNull();
  });

  it("surfaces the HDB report/remote links from the /actions note into the ticket", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ summary: "help", details_html: reportHtml({ email: "user@corp.com" }) }]),
    });
    const haloId = ((await created.json()) as { id: number }).id;

    const res = await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        {
          ticket_id: haloId,
          note_html:
            `<html><head><style>@font-face{font-family:'X'}</style></head><body>` +
            `You have a new ticket number ${haloId}. ` +
            `<a href="https://portal.helpdeskbuttons.com/r/abc">View Report</a> ` +
            `<a href="https://portal.helpdeskbuttons.com/c/abc">Connect to Computer</a></body></html>`,
        },
      ]),
    });
    expect(res.status).toBe(201);
    const desc = String(cap.posted()?.description);
    expect(desc).toContain("View Report");
    expect(desc).toContain('<a href="https://portal.helpdeskbuttons.com/r/abc">');
    // The "Connect to Computer" remote link is dropped.
    expect(desc).not.toContain("Connect to Computer");
    expect(desc).not.toContain("/c/abc");
    // The font-CSS boilerplate is still not dumped.
    expect(desc).not.toContain("@font-face");
  });

  it("trims default selections, dropping the label when only defaults were chosen", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        {
          summary: "Test",
          details_html: reportHtml({
            email: "user@corp.com",
            selections: "Connect directly to my computer as soon as available This affects only me",
          }),
        },
      ]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    const desc = String(cap.posted()?.description);
    expect(desc).not.toContain("This affects only me");
    expect(desc).not.toContain("Connect directly to my computer");
    expect(desc).not.toContain("Selections:"); // label dropped — nothing non-default left
  });

  it("keeps Selections when a non-default item is chosen, minus the defaults", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        {
          summary: "Test",
          details_html: reportHtml({
            email: "user@corp.com",
            selections: "This is an emergency Connect directly to my computer as soon as available This affects only me",
          }),
        },
      ]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    const desc = String(cap.posted()?.description);
    expect(desc).toContain("Selections:");
    expect(desc).toContain("This is an emergency");
    expect(desc).not.toContain("This affects only me");
  });

  it("enriches the ticket with rich device detail from the live Gorelo agent record", async () => {
    const cap = captureGoreloCreate();
    routes.push({
      method: "GET",
      match: (u) => u.pathname === `/v1/assets/agents/${AGENT_UUID}`,
      handler: () =>
        json(200, {
          id: AGENT_UUID,
          name: "PC-01",
          osName: "Microsoft Windows 11 Enterprise",
          osVersion: "25H2",
          manufacturer: "Microsoft Corporation",
          model: "Virtual Machine",
          cpu: "AMD EPYC 9V74 80-Core Processor",
          memory: "32",
          serialNo: "SN-RICH",
          localIPAddress: "10.100.1.13",
          publicIPAddress: "68.211.123.114",
          lastLoggedOnUserUpn: "cmaidan@sph.health",
          lastBootUpTime: "2020-01-01T00:00:00", // long ago -> relative "years ago"
        }),
    });
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ summary: "Test", details_html: reportHtml({ email: "user@corp.com", host: "pc-01" }) }]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    const desc = String(cap.posted()?.description);
    expect(desc).toContain("<b>Device</b>");
    expect(desc).toContain("Microsoft Windows 11 Enterprise");
    expect(desc).toContain("AMD EPYC 9V74 80-Core Processor");
    expect(desc).toContain("32 GB RAM");
    expect(desc).toContain("SN SN-RICH");
    expect(desc).toContain("Last user cmaidan@sph.health");
    expect(desc).toMatch(/Last boot \d+ years? ago/);
  });

  it("bumps priority to EMERGENCY_PRIORITY when the press is flagged an emergency", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        { summary: "Test", details_html: reportHtml({ email: "user@corp.com", selections: "This is an emergency" }) },
      ]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    expect(cap.posted()).toMatchObject({ priorityId: 1 }); // EMERGENCY_PRIORITY
  });

  it("uses DEFAULT_PRIORITY for a non-emergency press", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ summary: "Test", details_html: reportHtml({ email: "user@corp.com" }) }]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    expect(cap.posted()).toMatchObject({ priorityId: 2 }); // DEFAULT_PRIORITY
  });

  it("dead-letters a queued ticket after MAX_PENDING_ATTEMPTS failed creates", async () => {
    // Gorelo create keeps failing.
    routes.push({
      method: "POST",
      match: (u) => u.pathname === "/v1/tickets",
      handler: () => json(500, { error: "boom" }),
    });
    // A stale pending row already at attempt 4 -> the next failure is attempt 5 = give up.
    const cmd = { title: "Doomed", clientId: 10, statusId: 1, groupId: 7, typeId: 3, priorityId: 2, sourceId: 6, agentAssetIds: [] };
    await env.DB.prepare(`INSERT INTO pending_tickets (halo_id, command, created_at, attempts) VALUES (?,?,?,?)`)
      .bind(9999, JSON.stringify(cmd), "2000-01-01T00:00:00Z", 4)
      .run();

    const n = await flushPendingTickets(env);
    expect(n).toBe(0);
    // Dropped, not re-queued.
    const row = await env.DB.prepare(`SELECT halo_id FROM pending_tickets WHERE halo_id = 9999`).first();
    expect(row).toBeNull();
  });

  it("re-queues with an incremented attempt when a create fails below the cap", async () => {
    routes.push({
      method: "POST",
      match: (u) => u.pathname === "/v1/tickets",
      handler: () => json(500, { error: "boom" }),
    });
    const cmd = { title: "Retry", clientId: 10, statusId: 1, groupId: 7, typeId: 3, priorityId: 2, sourceId: 6, agentAssetIds: [] };
    await env.DB.prepare(`INSERT INTO pending_tickets (halo_id, command, created_at, attempts) VALUES (?,?,?,?)`)
      .bind(8888, JSON.stringify(cmd), "2000-01-01T00:00:00Z", 1)
      .run();

    await flushPendingTickets(env);
    const row = await env.DB.prepare(`SELECT attempts FROM pending_tickets WHERE halo_id = 8888`).first<{
      attempts: number;
    }>();
    expect(row?.attempts).toBe(2);
  });

  it("routes client + location from the asset object Tier2 sends (site_id 0 fallback)", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        {
          summary: "Test",
          details_html: reportHtml({ host: "sph-chile-005" }), // hostname not in the mirror
          site_id: 0, // Tier2 sends no site...
          assets: [{ id: ASSET_NUM, client_id: 10, site_id: 100 }], // ...but the asset carries one
        },
      ]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    // Client + location recovered from the asset; the asset itself is linked.
    expect(cap.posted()).toMatchObject({ clientId: 10, locationId: 100, agentAssetIds: [AGENT_UUID] });
  });

  it("correlates the note by the ticket number in its text when no explicit id is sent", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ summary: "help", details_html: reportHtml({ email: "user@corp.com" }) }]),
    });
    const haloId = ((await created.json()) as { id: number }).id;

    // Tier2's notification email embeds the returned id as "ticket number <id>".
    const res = await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ note_html: `<p>You have a new ticket number ${haloId} from your Helpdesk</p>` }]),
    });
    expect(res.status).toBe(201);
    expect(cap.posted()).toMatchObject({ contactId: 55, clientId: 10 });
  });

  it("resolves the contact from the report even when Tier2 sends only catch-all ids", async () => {
    const cap = captureGoreloCreate();
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([
        {
          user_id: 999999999,
          client_id: 999,
          site_id: 0,
          summary: "Test",
          details_html: reportHtml({ email: "user@corp.com", host: "PC-01", company: "Corp" }),
        },
      ]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "note" }]),
    });
    // Contact + client + asset all recovered from the report, not the catch-all input.
    expect(cap.posted()).toMatchObject({ clientId: 10, contactId: 55, agentAssetIds: [AGENT_UUID] });
  });

  it("falls back to the catch-all client when the report resolves nothing", async () => {
    const cap = captureGoreloCreate("00000000-0000-0000-0000-000000000000");
    const created = await req("/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ summary: "help", details_html: reportHtml({ email: "stranger@nowhere.test" }) }]),
    });
    const haloId = ((await created.json()) as { id: number }).id;
    await req("/actions", {
      method: "POST",
      headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
      body: JSON.stringify([{ ticket_id: haloId, note_html: "x" }]),
    });
    expect(cap.posted()).toMatchObject({ clientId: 999, contactId: null, agentAssetIds: [] });
  });

  it("orphan-flush creates a queued ticket whose note never arrived", async () => {
    const cap = captureGoreloCreate("11111111-1111-1111-1111-111111111111");
    // Insert a pending row that is already past the grace window.
    const cmd = {
      title: "Orphaned",
      createdByName: "x",
      clientId: 10,
      locationId: null,
      contactId: null,
      description: "d",
      statusId: 1,
      groupId: 7,
      typeId: 3,
      priorityId: 2,
      sourceId: 6,
      agentAssetIds: [],
      sendTicketCreatedEmail: false,
    };
    await env.DB.prepare(`INSERT INTO pending_tickets (halo_id, command, created_at) VALUES (?,?,?)`)
      .bind(4242, JSON.stringify(cmd), "2000-01-01T00:00:00Z")
      .run();

    const n = await flushPendingTickets(env);
    expect(n).toBe(1);
    expect(cap.posted()).toMatchObject({ title: "Orphaned", clientId: 10 });
    const row = await env.DB.prepare(`SELECT halo_id FROM pending_tickets WHERE halo_id = 4242`).first();
    expect(row).toBeNull();
  });
});
