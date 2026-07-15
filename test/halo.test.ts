import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { flushPendingTickets, haloResource, isHaloPath, isHaloRequest } from "../src/halo.js";
import { initSchema } from "../src/db.js";
import { assetNum } from "../src/sync.js";
import { signToken } from "../src/token.js";

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
  it("never routes /admin/* or /health to Halo, even when the resource name collides", () => {
    // /admin/status normalizes to the `status` resource, which IS a Halo resource
    // — but admin/health paths are handled by the fetch router, so isHaloRequest
    // must exclude them so they don't hit the IP-gated Halo mock.
    expect(haloResource("/admin/status")).toBe("status");
    expect(isHaloPath("/admin/status")).toBe(true); // collides at the path level
    const req = (p: string): Request => new Request(`https://t2t.example.com${p}`);
    expect(isHaloRequest(req("/admin/status"), "/admin/status")).toBe(false);
    expect(isHaloRequest(req("/admin/sync"), "/admin/sync")).toBe(false);
    expect(isHaloRequest(req("/health"), "/health")).toBe(false);
    // A real Halo path still routes via the path fallback (no header needed).
    expect(isHaloRequest(req("/users"), "/users")).toBe(true);
  });
});

describe("health check", () => {
  it("returns 200 for GET /health", async () => {
    const res = await req("/health", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
  it("returns 200 for HEAD /health (uptime monitors probe with HEAD)", async () => {
    const res = await req("/health", { method: "HEAD" });
    expect(res.status).toBe(200);
  });
  it("returns 405 (not 404) for POST /health", async () => {
    const res = await req("/health", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("method guards on app endpoints", () => {
  it("returns 405 + Allow: POST for GET /admin/sync", async () => {
    const res = await req("/admin/sync", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });
  it("returns 405 + Allow: POST for GET /admin/test-webhook", async () => {
    const res = await req("/admin/test-webhook", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
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

  it("mints a signed HMAC token (payload.sig) when creds are set", async () => {
    const res = await req("/token", token("halo-test-secret"));
    const j = (await res.json()) as Record<string, unknown>;
    // Signed token shape is `payload.sig` (two base64url parts), not a bare UUID.
    expect(String(j.access_token).split(".")).toHaveLength(2);
    expect(j.expires_in).toBe(3600);
  });
});

describe("Halo bearer-token enforcement gate (audit F1)", () => {
  const secret = "halo-test-secret";
  const withMode = async (mode: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prev = (env as { HALO_TOKEN_ENFORCE?: string }).HALO_TOKEN_ENFORCE;
    (env as { HALO_TOKEN_ENFORCE?: string }).HALO_TOKEN_ENFORCE = mode;
    try {
      await fn();
    } finally {
      (env as { HALO_TOKEN_ENFORCE?: string }).HALO_TOKEN_ENFORCE = prev;
    }
  };
  const bearer = async (): Promise<Record<string, string>> => ({
    "halo-app-name": "tier2tech",
    Authorization: `Bearer ${await signToken(secret, { exp: Math.floor(Date.now() / 1000) + 3600 })}`,
  });

  it("off (default): no token required — GET /users still resolves", async () => {
    await withMode("off", async () => {
      const res = await req("/users?search=user@corp.com", { headers: { "halo-app-name": "tier2tech" } });
      expect(res.status).toBe(200);
    });
  });

  it("observe: never rejects a missing token, still answers 200", async () => {
    await withMode("observe", async () => {
      const res = await req("/users?search=user@corp.com", { headers: { "halo-app-name": "tier2tech" } });
      expect(res.status).toBe(200);
    });
  });

  it("enforce: rejects a missing token with 401 invalid_token", async () => {
    await withMode("enforce", async () => {
      const res = await req("/users?search=user@corp.com", { headers: { "halo-app-name": "tier2tech" } });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    });
  });

  it("enforce: rejects an invalid token with 401", async () => {
    await withMode("enforce", async () => {
      const res = await req("/users?search=user@corp.com", {
        headers: { "halo-app-name": "tier2tech", Authorization: "Bearer not.a.valid.token" },
      });
      expect(res.status).toBe(401);
    });
  });

  it("enforce: accepts a valid signed token", async () => {
    await withMode("enforce", async () => {
      const res = await req("/users?search=user@corp.com", { headers: await bearer() });
      expect(res.status).toBe(200);
      const j = (await res.json()) as { users: Array<Record<string, unknown>> };
      expect(j.users[0]).toMatchObject({ id: 55 });
    });
  });

  it("enforce: /token itself is exempt (Tier2 has no token yet at that point)", async () => {
    await withMode("enforce", async () => {
      const res = await req("/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: "halo-test-id",
          client_secret: secret,
        }).toString(),
      });
      expect(res.status).toBe(200);
    });
  });
});

describe("per-product Halo OAuth credentials (#51)", () => {
  // Real Halo traffic always carries a CF-Connecting-IP (from Cloudflare); the
  // per-product credential resolution keys off which product that IP matches.
  const TIER2_IP = "34.202.14.153";
  const HUNTRESS_IP = "52.4.130.244";
  const HUNTRESS_UA = "Huntress Halo Integration";
  // tier2 reuses the global pair set in vitest.config; huntress gets its own.
  const HUNTRESS_ID = "huntress-client-id";
  const HUNTRESS_SECRET = "huntress-client-secret";

  type Overridable = Record<string, string | undefined>;
  const withEnv = async (overrides: Overridable, fn: () => Promise<void>): Promise<void> => {
    const e = env as unknown as Overridable;
    const prev: Overridable = {};
    for (const k of Object.keys(overrides)) prev[k] = e[k];
    Object.assign(e, overrides);
    try {
      await fn();
    } finally {
      for (const k of Object.keys(overrides)) e[k] = prev[k];
    }
  };

  const tokenReq = (
    ip: string,
    clientId: string,
    clientSecret: string,
    ua?: string,
  ): RequestInit => {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      "CF-Connecting-IP": ip,
    };
    if (ua) headers["User-Agent"] = ua;
    return {
      method: "POST",
      headers,
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    };
  };

  const accessToken = async (init: RequestInit): Promise<string> => {
    const res = await req("/token", init);
    expect(res.status).toBe(200);
    return String(((await res.json()) as Record<string, unknown>).access_token);
  };

  // Both products enabled; enforcement on. Huntress configured with its OWN pair.
  const bothEnabled: Overridable = {
    HALO_TOKEN_ENFORCE: "enforce",
    ENABLE_HUNTRESS: "true",
    HALO_CLIENT_ID_HUNTRESS: HUNTRESS_ID,
    HALO_CLIENT_SECRET_HUNTRESS: HUNTRESS_SECRET,
  };

  it("validates each product's /token against its OWN credentials", async () => {
    await withEnv(bothEnabled, async () => {
      // tier2's pair authenticates a tier2-IP request.
      expect((await req("/token", tokenReq(TIER2_IP, "halo-test-id", "halo-test-secret"))).status).toBe(200);
      // Huntress's pair authenticates a Huntress-IP+UA request.
      expect(
        (await req("/token", tokenReq(HUNTRESS_IP, HUNTRESS_ID, HUNTRESS_SECRET, HUNTRESS_UA))).status,
      ).toBe(200);
      // Cross-product creds are rejected — Huntress's client_id at a tier2 IP fails.
      expect((await req("/token", tokenReq(TIER2_IP, HUNTRESS_ID, HUNTRESS_SECRET))).status).toBe(401);
      // ...and tier2's client_id at a Huntress IP fails.
      expect(
        (await req("/token", tokenReq(HUNTRESS_IP, "halo-test-id", "halo-test-secret", HUNTRESS_UA))).status,
      ).toBe(401);
    });
  });

  it("under enforce, BOTH products authenticate with their own token (the #51 fix)", async () => {
    await withEnv(bothEnabled, async () => {
      const t2 = await accessToken(tokenReq(TIER2_IP, "halo-test-id", "halo-test-secret"));
      const th = await accessToken(tokenReq(HUNTRESS_IP, HUNTRESS_ID, HUNTRESS_SECRET, HUNTRESS_UA));

      // Each product's own token passes its own resource requests.
      const t2res = await req("/users?search=user@corp.com", {
        headers: { "halo-app-name": "tier2tech", "CF-Connecting-IP": TIER2_IP, Authorization: `Bearer ${t2}` },
      });
      expect(t2res.status).toBe(200);
      const thres = await req("/users?search=user@corp.com", {
        headers: { "CF-Connecting-IP": HUNTRESS_IP, "User-Agent": HUNTRESS_UA, Authorization: `Bearer ${th}` },
      });
      expect(thres.status).toBe(200);
    });
  });

  it("rejects a token minted for a DIFFERENT product (prod claim + distinct secret)", async () => {
    await withEnv(bothEnabled, async () => {
      const t2 = await accessToken(tokenReq(TIER2_IP, "halo-test-id", "halo-test-secret"));
      // tier2's token presented on a Huntress request is not valid for Huntress.
      const res = await req("/users?search=user@corp.com", {
        headers: { "CF-Connecting-IP": HUNTRESS_IP, "User-Agent": HUNTRESS_UA, Authorization: `Bearer ${t2}` },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    });
  });

  it("a product with NO credentials stays lenient under enforce (rollout-safe)", async () => {
    // Huntress enabled + enforce, but its credential pair is left unset.
    await withEnv({ HALO_TOKEN_ENFORCE: "enforce", ENABLE_HUNTRESS: "true" }, async () => {
      // No bearer token at all — a credential-less product is not gated.
      const res = await req("/users?search=user@corp.com", {
        headers: { "CF-Connecting-IP": HUNTRESS_IP, "User-Agent": HUNTRESS_UA },
      });
      expect(res.status).toBe(200);
      // /token accepts any creds for it (legacy lenient behavior), opaque token.
      const tok = await accessToken(tokenReq(HUNTRESS_IP, "anything", "goes", HUNTRESS_UA));
      expect(tok.split(".")).toHaveLength(1); // opaque UUID, not a signed payload.sig
    });
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
  it("GET /api/Client returns mirrored clients in the fuller Halo shape", async () => {
    const res = await req("/api/Client?search=corp");
    const j = (await res.json()) as { clients: Array<Record<string, unknown>>; record_count: number };
    expect(j.record_count).toBe(1);
    expect(j.clients).toHaveLength(1);
    // id/name preserved for existing consumers; standard Halo fields added for stricter ones.
    expect(j.clients[0]).toMatchObject({
      id: 10,
      name: "Corp",
      inactive: false,
      use: "client",
      toplevel_id: 0,
    });
  });

  it("GET /api/Client/{id} returns a single Area object, not the list envelope", async () => {
    const j = (await (await req("/api/Client/10")).json()) as Record<string, unknown>;
    expect(j).toMatchObject({ id: 10, name: "Corp", use: "client" });
    expect(j.clients).toBeUndefined(); // single object, not the { clients: [...] } envelope
  });

  it("GET /api/Client/{id} synthesizes a bare object for an unmirrored id (e.g. catch-all)", async () => {
    const j = (await (await req("/api/Client/99999")).json()) as Record<string, unknown>;
    expect(j).toMatchObject({ id: 99999, name: "", use: "client" });
    expect(j.clients).toBeUndefined();
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

  it("GET /api/Site filters by client_id, wrapped in the paging envelope", async () => {
    const res = await req("/api/Site?client_id=10");
    const j = (await res.json()) as {
      sites: Array<Record<string, unknown>>;
      record_count: number;
      page_no: number;
      page_size: number;
    };
    expect(j).toMatchObject({ record_count: 1, page_no: 1 });
    expect(typeof j.page_size).toBe("number"); // paging fields present (Site_View)
    expect(j.sites).toEqual([{ id: 100, name: "HQ", client_id: 10 }]);
  });

  it("GET /api/Asset returns the device with its numeric surrogate id", async () => {
    const res = await req("/api/Asset?search=pc-01");
    const j = (await res.json()) as { assets: Array<Record<string, unknown>> };
    expect(j.assets[0]).toMatchObject({ id: ASSET_NUM, inventory_number: "pc-01", client_id: 10 });
  });

  it("GET /api/TicketType returns a bare array of full-shape ticket types", async () => {
    const res = await req("/api/TicketType");
    const j = (await res.json()) as Array<Record<string, unknown>>;
    expect(Array.isArray(j)).toBe(true); // bare array (no envelope) — matches Halo
    expect(j[0]).toMatchObject({ id: 3, name: "Incident", cancreate: true, agentscanselect: true });
    // Full shape: many fields present so a strict client can't hit undefined.
    expect(Object.keys(j[0]!).length).toBeGreaterThan(20);
  });

  it("GET /api/Status returns a full-shape open->closed status set", async () => {
    const status = (await (await req("/api/Status")).json()) as Array<Record<string, unknown>>;
    expect(status[0]).toMatchObject({ id: 1, name: "New", type: 0, intent: "open" });
    expect(Object.keys(status[0]!).length).toBeGreaterThan(20);
    // A closed/resolved status must exist or a PSA editor's closed-side lookup crashes.
    expect(status.some((s) => s.type === 2 && /closed|resolved/i.test(String(s.name)))).toBe(true);
  });

  it("GET /api/Team returns a full-shape bare array", async () => {
    const team = (await (await req("/api/Team")).json()) as Array<Record<string, unknown>>;
    expect(team[0]).toMatchObject({ name: "Everyone", forrequests: true });
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

  it("dead-letters a queued ticket after MAX_PENDING_ATTEMPTS + alerts via notifly", async () => {
    // Gorelo create keeps failing.
    routes.push({
      method: "POST",
      match: (u) => u.pathname === "/v1/tickets",
      handler: () => json(500, { error: "boom" }),
    });
    // Capture the notifly delivery (jsons:// -> POST https://hooks.example.com/dead-letter).
    let alert: Record<string, unknown> | undefined;
    routes.push({
      method: "POST",
      match: (u) => u.host === "hooks.example.com",
      handler: async (r) => {
        alert = (await r.json()) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    });
    // A stale pending row already at attempt 4 -> the next failure is attempt 5 = give up.
    const cmd = { title: "Doomed", clientId: 10, contactId: 55, statusId: 1, groupId: 7, typeId: 3, priorityId: 2, sourceId: 6, agentAssetIds: [] };
    await env.DB.prepare(`INSERT INTO pending_tickets (halo_id, command, created_at, attempts) VALUES (?,?,?,?)`)
      .bind(9999, JSON.stringify(cmd), "2000-01-01T00:00:00Z", 4)
      .run();

    const n = await flushPendingTickets(env);
    expect(n).toBe(0);
    // Dropped, not re-queued.
    const row = await env.DB.prepare(`SELECT halo_id FROM pending_tickets WHERE halo_id = 9999`).first();
    expect(row).toBeNull();
    // notifly alerted (webhook payload = {title, body, ...}); body carries recreate detail.
    expect(String(alert?.title)).toContain("dropped after 5");
    expect(String(alert?.body)).toContain("Doomed");
    expect(String(alert?.body)).toContain("Client: 10");
  });

  it("POST /admin/test-webhook fires a test alert via notifly and reports results", async () => {
    let alert: Record<string, unknown> | undefined;
    routes.push({
      method: "POST",
      match: (u) => u.host === "hooks.example.com",
      handler: async (r) => {
        alert = (await r.json()) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    });
    const res = await req("/admin/test-webhook", { method: "POST", headers: { "X-Admin-Key": "test-admin-key" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("notifly: 1 ok, 0 failed");
    expect(String(alert?.title)).toContain("Helpdesk Buttons");
  });

  it("POST /admin/test-webhook requires the admin key", async () => {
    const res = await req("/admin/test-webhook", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /admin/sync alerts via notifly when the sync fails", async () => {
    // Gorelo fleet fetch is down -> syncAll rejects. Clients + contacts resolve so
    // the Promise.all has a single (handled) rejection, no unhandled-rejection noise.
    routes.push({
      method: "GET",
      match: (u) => u.pathname === "/v1/clients",
      handler: () => json(200, []),
    });
    routes.push({
      method: "GET",
      match: (u) => u.pathname === "/v1/contacts",
      handler: () => json(200, []),
    });
    // 400 is non-retryable, so getJsonWithRetry throws immediately (no backoff).
    routes.push({
      method: "GET",
      match: (u) => u.pathname === "/v1/assets/agents",
      handler: () => new Response("bad request", { status: 400 }),
    });
    let alert: Record<string, unknown> | undefined;
    routes.push({
      method: "POST",
      match: (u) => u.host === "hooks.example.com",
      handler: async (r) => {
        alert = (await r.json()) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    });

    const res = await req("/admin/sync", { method: "POST", headers: { "X-Admin-Key": "test-admin-key" } });
    expect(res.status).toBe(502);
    expect(String(alert?.title)).toContain("mirror sync failed");
    expect(String(alert?.body)).toContain("Source: admin");
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

  it("sends the ticket-created email only on a matched contact when SEND_TICKET_CREATED_EMAIL=true", async () => {
    const prev = (env as { SEND_TICKET_CREATED_EMAIL?: string }).SEND_TICKET_CREATED_EMAIL;
    (env as { SEND_TICKET_CREATED_EMAIL?: string }).SEND_TICKET_CREATED_EMAIL = "true";
    try {
      // Matched contact (user@corp.com -> id 55): email is requested.
      const hit = captureGoreloCreate();
      const c1 = await req("/tickets", {
        method: "POST",
        headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
        body: JSON.stringify([{ summary: "help", details_html: reportHtml({ email: "user@corp.com" }) }]),
      });
      const id1 = ((await c1.json()) as { id: number }).id;
      await req("/actions", {
        method: "POST",
        headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
        body: JSON.stringify([{ ticket_id: id1, note_html: "note" }]),
      });
      expect(hit.posted()).toMatchObject({ contactId: 55, sendTicketCreatedEmail: true });

      // No contact match (catch-all fallback): email stays suppressed even with the flag on.
      routes = []; // drop the first capture so this create hits the new route
      const miss = captureGoreloCreate("00000000-0000-0000-0000-000000000000");
      const c2 = await req("/tickets", {
        method: "POST",
        headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
        body: JSON.stringify([{ summary: "help", details_html: reportHtml({ email: "stranger@nowhere.test" }) }]),
      });
      const id2 = ((await c2.json()) as { id: number }).id;
      await req("/actions", {
        method: "POST",
        headers: { "content-type": "application/json", "halo-app-name": "tier2tech" },
        body: JSON.stringify([{ ticket_id: id2, note_html: "x" }]),
      });
      expect(miss.posted()).toMatchObject({ contactId: null, sendTicketCreatedEmail: false });
    } finally {
      (env as { SEND_TICKET_CREATED_EMAIL?: string }).SEND_TICKET_CREATED_EMAIL = prev;
    }
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

describe("Halo immediate ticket create (one-shot product: Huntress)", () => {
  // Drive the request as Huntress: its source IP + self-declared User-Agent, with
  // ENABLE_HUNTRESS on so matchProduct resolves the product.
  const huntressInit = (bodyObj: unknown): RequestInit => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Huntress Halo Integration",
      "CF-Connecting-IP": "52.4.130.244",
    },
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

  it("creates the Gorelo ticket immediately (no queue) on the /api/Tickets POST", async () => {
    await withHuntressEnabled(async () => {
      const cap = captureGoreloCreate();
      const res = await req(
        "/api/Tickets",
        huntressInit([
          { summary: "Huntress Test", details: "hello world", client_id: "10", tickettype_id: "7045" },
        ]),
      );
      expect(res.status).toBe(201);
      // Immediate: the Gorelo create fired on this POST (unlike Tier2's deferred path).
      const posted = cap.posted();
      expect(posted).toBeDefined();
      expect(posted).toMatchObject({ title: "Huntress Test", clientId: 10 });
      // The free-text details land in the description (not the HDB "Report Summary").
      expect(String(posted!.description)).toContain("hello world");
      expect(String(posted!.description)).toContain("Details");
      // Nothing left queued.
      const row = await env.DB.prepare(`SELECT halo_id FROM pending_tickets`).first();
      expect(row).toBeNull();
    });
  });

  it("falls back to the pending queue if the immediate Gorelo create fails", async () => {
    await withHuntressEnabled(async () => {
      routes.push({
        method: "POST",
        match: (u) => u.pathname === "/v1/tickets",
        handler: () => json(500, { error: "boom" }),
      });
      const res = await req("/api/Tickets", huntressInit([{ summary: "Huntress Retry", details: "x", client_id: "10" }]));
      // Still 201 to the caller; the command is queued so the orphan flush retries it.
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const row = await env.DB.prepare(`SELECT command FROM pending_tickets WHERE halo_id = ?`)
        .bind(body.id)
        .first<{ command: string }>();
      expect(row).not.toBeNull();
    });
  });
});
