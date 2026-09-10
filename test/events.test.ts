import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { initSchema } from "../src/core/db.js";
import { assetNum } from "../src/ingress/sync.js";
import {
  clearSubscribers,
  registerSubscriber,
  subscriberCount,
  type TicketCreatedEvent,
  type TicketResolvedEvent,
} from "../src/core/events.js";

// This spec proves the ingress event spine (src/core/events.ts): a TicketCreatedEvent
// fires on a Gorelo create and a TicketResolvedEvent fires on a resolution, each with
// a payload derived from what the create/resolution path actually holds — and that
// with NO subscriber the paths behave identically (emission is a no-op).

const HOST = "https://t2t.example.com";
const AGENT_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ASSET_NUM = assetNum(AGENT_UUID);
const TIER2_IP = "34.202.14.153";
const HUNTRESS_IP = "52.4.130.244";
const HUNTRESS_UA = "Huntress Halo Integration";

// --- outbound fetch stub (mirrors test/halo.test.ts) ------------------------
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
function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    for (const r of routes) if (r.method === req.method && r.match(url)) return r.handler(req);
    if (req.method === "GET" && /^\/v1\/assets\/agents\//.test(url.pathname)) {
      return new Response("", { status: 404 });
    }
    throw new Error(`unmocked fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
}
const json = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Capture the Gorelo create + mock the number read-back (as test/halo.test.ts does). */
function captureGoreloCreate(
  opts: { uuid?: string; number?: number | null; displayNumber?: string | null } = {},
): void {
  const uuid = opts.uuid ?? "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a";
  const number = opts.number ?? 264274883401817;
  const displayNumber = opts.displayNumber ?? "T-100234";
  routes.push({
    method: "POST",
    match: (u) => u.pathname === "/v1/tickets",
    handler: () => json(200, { id: uuid }),
  });
  routes.push({
    method: "GET",
    match: (u) => u.pathname === "/v1/tickets",
    handler: () => json(200, { data: [{ id: uuid, number, displayNumber }], hasMore: false }),
  });
  // The resolution path resolves the original ticket directly (PATCH + a comment) —
  // this spec only cares about the emitted TicketResolvedEvent, not these calls'
  // wire shape (see test/halo.test.ts for that), so a bare 200 is enough.
  routes.push({ method: "PATCH", match: (u) => /^\/v1\/tickets\/[^/]+$/.test(u.pathname), handler: () => json(200, { id: uuid }) });
  routes.push({
    method: "POST",
    match: (u) => /^\/v1\/tickets\/[^/]+\/comments$/.test(u.pathname),
    handler: () => json(200, { id: "comment-uuid" }),
  });
}

async function seed(): Promise<void> {
  await initSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM clients`),
    env.DB.prepare(`DELETE FROM locations`),
    env.DB.prepare(`DELETE FROM contacts`),
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM sync_meta`),
    env.DB.prepare(`DELETE FROM pending_tickets`),
    env.DB.prepare(`DELETE FROM created_tickets`),
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
  clearSubscribers();
  installFetch();
  await seed();
});
afterEach(() => {
  clearSubscribers();
  globalThis.fetch = realFetch;
});

async function req(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${HOST}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** An HDB "Report Summary" table carrying the reporter email + hostname. */
const reportHtml = (email: string, host: string): string =>
  `<table><tbody>
     <tr><td>Email:</td><td>${email}</td></tr>
     <tr><td>Hostname:</td><td>${host}</td></tr>
     <tr><td>Selections:</td><td>My screen is frozen</td></tr>
   </tbody></table>`;

const tier2Init = (bodyObj: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "halo-app-name": "tier2tech", "CF-Connecting-IP": TIER2_IP },
  body: JSON.stringify(bodyObj),
});

const huntressInit = (bodyObj: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "user-agent": HUNTRESS_UA, "CF-Connecting-IP": HUNTRESS_IP },
  body: JSON.stringify(bodyObj),
});

async function withHuntressEnabled(fn: () => Promise<void>): Promise<void> {
  const e = env as { ENABLE_HUNTRESS?: string };
  const prev = e.ENABLE_HUNTRESS;
  e.ENABLE_HUNTRESS = "true";
  try {
    await fn();
  } finally {
    e.ENABLE_HUNTRESS = prev;
  }
}

describe("event spine — TicketCreatedEvent", () => {
  it("fires once on an eager Gorelo create, with the resolved routing payload", async () => {
    const created: TicketCreatedEvent[] = [];
    registerSubscriber({ onTicketCreated: (e) => created.push(e) });
    captureGoreloCreate({ number: 264274883401817, displayNumber: "T-100234" });

    const res = await req(
      "/tickets",
      tier2Init([{ summary: "Printer down", details_html: reportHtml("user@corp.com", "pc-01") }]),
    );
    expect(res.status).toBe(201);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: "ticket.created",
      goreloId: "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a",
      haloId: 264274883401817, // returned id = the resolved human number
      number: 264274883401817,
      displayNumber: "T-100234",
      productKey: "tier2",
      clientId: 10, // resolved from the report email, not the catch-all
      locationId: 100,
      contactId: 55,
      deviceAssetIds: [AGENT_UUID], // resolved from the report hostname
      subject: "Printer down",
    });
    expect(typeof created[0]!.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(created[0]!.timestamp))).toBe(false);
  });

  it("carries productKey='huntress' for a Huntress create", async () => {
    await withHuntressEnabled(async () => {
      const created: TicketCreatedEvent[] = [];
      registerSubscriber({ onTicketCreated: (e) => created.push(e) });
      captureGoreloCreate({ number: 500100, displayNumber: "T-500100" });

      const res = await req(
        "/api/Tickets",
        huntressInit([{ summary: "Suspicious login", details: "anomalous", client_id: "10" }]),
      );
      expect(res.status).toBe(201);
      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        type: "ticket.created",
        productKey: "huntress",
        clientId: 10,
        number: 500100,
        subject: "Suspicious login",
      });
    });
  });

  it("read-back miss leaves number/displayNumber null but still fires", async () => {
    const created: TicketCreatedEvent[] = [];
    registerSubscriber({ onTicketCreated: (e) => created.push(e) });
    // Create succeeds; the number read-back returns a page without our id.
    routes.push({
      method: "POST",
      match: (u) => u.pathname === "/v1/tickets",
      handler: () => json(200, { id: "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a" }),
    });
    routes.push({
      method: "GET",
      match: (u) => u.pathname === "/v1/tickets",
      handler: () => json(200, { data: [], hasMore: false }),
    });

    const res = await req(
      "/tickets",
      tier2Init([{ summary: "No number", details_html: reportHtml("user@corp.com", "pc-01") }]),
    );
    expect(res.status).toBe(201);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ number: null, displayNumber: null, subject: "No number" });
    // haloId falls back to the synthetic surrogate (not the human number).
    expect(created[0]!.number).toBeNull();
    expect(created[0]!.haloId).toBeGreaterThan(0);
  });
});

describe("event spine — TicketResolvedEvent", () => {
  it("fires on a Huntress resolution edit, referencing the original ticket", async () => {
    await withHuntressEnabled(async () => {
      const e = env as { DEFAULT_RESOLVED_STATUS_ID?: string };
      const prev = e.DEFAULT_RESOLVED_STATUS_ID;
      e.DEFAULT_RESOLVED_STATUS_ID = "5";
      try {
        const created: TicketCreatedEvent[] = [];
        const resolved: TicketResolvedEvent[] = [];
        registerSubscriber({
          onTicketCreated: (ev) => created.push(ev),
          onTicketResolved: (ev) => resolved.push(ev),
        });
        captureGoreloCreate({ number: 700900, displayNumber: "T-700900" });

        // 1) Original alert -> Gorelo ticket, ledgered under number 700900.
        const createdRes = await req(
          "/api/Tickets",
          huntressInit([{ summary: "Suspicious login", details: "anomalous", client_id: "10" }]),
        );
        const id = ((await createdRes.json()) as { id: number }).id;
        expect(id).toBe(700900);
        expect(created).toHaveLength(1);

        // 2) Huntress resolves by editing that ticket.
        const res = await req("/api/Tickets", huntressInit([{ id, status_id: 3 }]));
        expect(res.status).toBe(200);

        expect(resolved).toHaveLength(1);
        expect(resolved[0]).toMatchObject({
          type: "ticket.resolved",
          productKey: "huntress",
          resolvedStatusId: 5,
          original: {
            haloId: 700900,
            number: 700900,
            displayNumber: "T-700900",
            title: "Suspicious login",
            clientId: 10,
          },
        });
        expect(typeof resolved[0]!.timestamp).toBe("string");
      } finally {
        e.DEFAULT_RESOLVED_STATUS_ID = prev;
      }
    });
  });

  it("a fresh (unknown-id) alert is a create, not a resolution", async () => {
    await withHuntressEnabled(async () => {
      const created: TicketCreatedEvent[] = [];
      const resolved: TicketResolvedEvent[] = [];
      registerSubscriber({
        onTicketCreated: (ev) => created.push(ev),
        onTicketResolved: (ev) => resolved.push(ev),
      });
      captureGoreloCreate({ number: 800200, displayNumber: "T-800200" });
      const res = await req(
        "/api/Tickets",
        huntressInit([{ id: 555555, summary: "Fresh alert", details: "new", client_id: "10" }]),
      );
      expect(res.status).toBe(201);
      expect(created).toHaveLength(1);
      expect(resolved).toHaveLength(0); // an unknown id is never misread as a resolution
    });
  });
});

describe("event spine — no subscribers", () => {
  it("emits nothing and the create still succeeds (no-op emission)", async () => {
    expect(subscriberCount()).toBe(0);
    captureGoreloCreate();
    const res = await req(
      "/tickets",
      tier2Init([{ summary: "Quiet", details_html: reportHtml("user@corp.com", "pc-01") }]),
    );
    // Behavior is identical to before the spine: a normal 201 create.
    expect(res.status).toBe(201);
  });
});
