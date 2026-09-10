import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { initSchema, getCreatedTicket, putCreatedTicket, putPendingJira } from "../src/core/db.js";
import { clearSubscribers, registerSubscriber } from "../src/core/events.js";
import { assetNum } from "../src/ingress/sync.js";
import { flushPendingJira, jiraSubscriber, JiraClient, JiraError, type JiraTarget } from "../src/egress/jira/index.js";

// Integration coverage for the Jira egress path on the event spine:
//  - subscriber wiring: an enrolled client's ticket create -> Jira issue + ledger key
//  - enrollment gates: off / unenrolled -> no fan-out
//  - resolution -> close (comment + transition) via the ledger-stored issue key
//  - the durable pending_jira drain (flushPendingJira) + dead-letter, all against a
//    MOCKED Jira client
//
// !!! MOCK-ONLY !!!  Every Jira request here is stubbed. These specs prove the WIRING
// and control flow (enrollment, ledger dedup, queue drain, dead-letter), NOT that the
// real Jira Cloud API accepts our create/comment/transition bodies. That live check was
// done separately as a manual pass (2026-09-09: created HD-2, commented, transitioned
// To Do → Done against a real free Jira site — see PR #87 / REFACTOR-NOTES.md); these
// automated specs deliberately stay mocked so CI never touches a live Jira.

const HOST = "https://t2t.example.com";
const AGENT_UUID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ASSET_NUM = assetNum(AGENT_UUID);
const TIER2_IP = "34.202.14.153";
const JIRA_HOST = "acme.atlassian.net";
// basic-mode requests never hit JIRA_HOST directly (see JiraClient.resolveCloudId) —
// they resolve this cloudId via an unauthenticated GET {baseUrl}/_edge/tenant_info,
// then call api.atlassian.com/ex/jira/{JIRA_CLOUD_ID}/... like oauth mode does.
const JIRA_CLOUD_ID = "acme-cloud-id";
const TARGETS = JSON.stringify([
  {
    clientId: 10,
    baseUrl: `https://${JIRA_HOST}`,
    projectKey: "SEC",
    issueType: "Task",
    email: "svc@acme.com",
    apiToken: "tok",
    resolvedTransition: "Done",
  },
]);

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
    // Basic-mode JiraClient resolves its cloudId via this unauthenticated lookup
    // before every request (see resolveCloudId) — stub it for every test rather
    // than per-test, since it's not what any test is actually exercising.
    if (req.method === "GET" && url.host === JIRA_HOST && url.pathname === "/_edge/tenant_info") {
      return json(200, { cloudId: JIRA_CLOUD_ID });
    }
    throw new Error(`unmocked fetch: ${req.method} ${req.url}`);
  }) as typeof fetch;
}
const json = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Mock the Gorelo create + number read-back. */
function captureGoreloCreate(opts: { number?: number; displayNumber?: string } = {}): void {
  const uuid = "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a";
  const number = opts.number ?? 555001;
  const displayNumber = opts.displayNumber ?? "T-555001";
  routes.push({ method: "POST", match: (u) => u.pathname === "/v1/tickets", handler: () => json(200, { id: uuid }) });
  routes.push({
    method: "GET",
    match: (u) => u.pathname === "/v1/tickets",
    handler: () => json(200, { data: [{ id: uuid, number, displayNumber }], hasMore: false }),
  });
  // The resolution path resolves the original ticket directly (PATCH + a comment) —
  // this suite only cares about the Jira egress wiring, not these calls' wire shape
  // (see test/halo.test.ts for that), so a bare 200 is enough.
  routes.push({ method: "PATCH", match: (u) => /^\/v1\/tickets\/[^/]+$/.test(u.pathname), handler: () => json(200, { id: uuid }) });
  routes.push({
    method: "POST",
    match: (u) => /^\/v1\/tickets\/[^/]+\/comments$/.test(u.pathname),
    handler: () => json(200, { id: "comment-uuid" }),
  });
}

/** Mock POST /rest/api/3/issue on the Jira site; returns the created issues seen. */
function captureJiraCreate(key = "SEC-1"): { calls: () => Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  routes.push({
    method: "POST",
    match: (u) => u.host === "api.atlassian.com" && u.pathname === `/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/issue`,
    handler: async (r) => {
      seen.push((await r.json()) as Record<string, unknown>);
      return json(201, { id: "10001", key });
    },
  });
  return { calls: () => seen };
}

/** Mock the Jira comment + transitions endpoints; records what was called. */
function captureJiraClose(): { comments: () => string[]; transitioned: () => string[] } {
  const comments: string[] = [];
  const transitioned: string[] = [];
  routes.push({
    method: "POST",
    match: (u) => u.host === "api.atlassian.com" && new RegExp(`^/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/issue/[^/]+/comment$`).test(u.pathname),
    handler: (r) => {
      comments.push(new URL(r.url).pathname);
      return json(201, {});
    },
  });
  routes.push({
    method: "GET",
    match: (u) => u.host === "api.atlassian.com" && new RegExp(`^/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/issue/[^/]+/transitions$`).test(u.pathname),
    handler: () => json(200, { transitions: [{ id: "31", name: "Done" }] }),
  });
  routes.push({
    method: "POST",
    match: (u) => u.host === "api.atlassian.com" && new RegExp(`^/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/issue/[^/]+/transitions$`).test(u.pathname),
    handler: (r) => {
      transitioned.push(new URL(r.url).pathname);
      return new Response(null, { status: 204 });
    },
  });
  return { comments: () => comments, transitioned: () => transitioned };
}

const reportHtml = (email: string, host: string): string =>
  `<table><tbody>
     <tr><td>Email:</td><td>${email}</td></tr>
     <tr><td>Hostname:</td><td>${host}</td></tr>
   </tbody></table>`;

const tier2Init = (bodyObj: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", "halo-app-name": "tier2tech", "CF-Connecting-IP": TIER2_IP },
  body: JSON.stringify(bodyObj),
});

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
    env.DB.prepare(`DELETE FROM pending_jira`),
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

// Save/restore the env flags each test toggles.
let savedEnableJira: string | undefined;
let savedTargets: string | undefined;
let savedNotifly: string | undefined;

beforeEach(async () => {
  routes = [];
  // Register exactly the Jira subscriber (index.ts registers it at import; clear+add
  // makes this deterministic regardless of what other spec files did to the registry).
  clearSubscribers();
  registerSubscriber(jiraSubscriber);
  installFetch();
  await seed();
  const e = env as { ENABLE_JIRA?: string; JIRA_TARGETS?: string; NOTIFLY_URLS?: string };
  savedEnableJira = e.ENABLE_JIRA;
  savedTargets = e.JIRA_TARGETS;
  savedNotifly = e.NOTIFLY_URLS;
  e.ENABLE_JIRA = "true";
  e.JIRA_TARGETS = TARGETS;
});
afterEach(() => {
  clearSubscribers();
  globalThis.fetch = realFetch;
  const e = env as { ENABLE_JIRA?: string; JIRA_TARGETS?: string; NOTIFLY_URLS?: string };
  e.ENABLE_JIRA = savedEnableJira;
  e.JIRA_TARGETS = savedTargets;
  e.NOTIFLY_URLS = savedNotifly;
});

async function req(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${HOST}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx); // drains the fan-out waitUntil
  return res;
}

describe("Jira egress — subscriber wiring on create", () => {
  it("mirrors an enrolled client's created ticket to Jira and stores the issue key", async () => {
    captureGoreloCreate({ number: 555001, displayNumber: "T-555001" });
    const jira = captureJiraCreate("SEC-1");

    const created = await req(
      "/tickets",
      tier2Init([{ summary: "Printer down", details_html: reportHtml("user@corp.com", "pc-01") }]),
    );
    expect(created.status).toBe(201);
    const haloId = ((await created.json()) as { id: number }).id;
    expect(haloId).toBe(555001); // routed to client 10 (enrolled)

    // The Jira issue was created, cross-referencing the Gorelo number.
    expect(jira.calls()).toHaveLength(1);
    const fields = (jira.calls()[0] as { fields: Record<string, unknown> }).fields;
    expect(fields.summary).toBe("Printer down");
    expect(fields.project).toEqual({ key: "SEC" });
    expect(fields.labels).toEqual(["tier2", "gorelo-555001"]);

    // The issue key is recorded on the ledger (for the later close + dedup).
    const row = await getCreatedTicket(env.DB, haloId);
    expect(row?.jira_issue_key).toBe("SEC-1");
  });

  it("does NOT fan out when the client isn't enrolled", async () => {
    (env as { JIRA_TARGETS?: string }).JIRA_TARGETS = JSON.stringify([
      { clientId: 4242, baseUrl: `https://${JIRA_HOST}`, projectKey: "X", email: "e@x.com", apiToken: "t" },
    ]);
    captureGoreloCreate();
    const jira = captureJiraCreate();
    const created = await req(
      "/tickets",
      tier2Init([{ summary: "Printer down", details_html: reportHtml("user@corp.com", "pc-01") }]),
    );
    expect(created.status).toBe(201);
    expect(jira.calls()).toHaveLength(0); // client 10 not enrolled -> no Jira call
  });

  it("does NOT fan out when ENABLE_JIRA is off", async () => {
    (env as { ENABLE_JIRA?: string }).ENABLE_JIRA = "false";
    captureGoreloCreate();
    const jira = captureJiraCreate();
    await req("/tickets", tier2Init([{ summary: "x", details_html: reportHtml("user@corp.com", "pc-01") }]));
    expect(jira.calls()).toHaveLength(0);
  });
});

describe("Jira egress — close on resolution", () => {
  it("closes the linked Jira issue (comment + transition) on a resolution edit", async () => {
    captureGoreloCreate({ number: 555002, displayNumber: "T-555002" });
    captureJiraCreate("SEC-2");
    const close = captureJiraClose();

    // 1) Create — mirrored to Jira (ledger gets SEC-2).
    const created = await req(
      "/tickets",
      tier2Init([{ summary: "Broken", details_html: reportHtml("user@corp.com", "pc-01") }]),
    );
    const id = ((await created.json()) as { id: number }).id;
    expect((await getCreatedTicket(env.DB, id))?.jira_issue_key).toBe("SEC-2");

    // 2) Resolve — POST /tickets carrying the ledger-known id -> resolution path.
    const resolved = await req("/tickets", tier2Init([{ id, status_id: 3 }]));
    expect(resolved.status).toBe(200);

    // The linked issue was commented on and transitioned.
    expect(close.comments()).toHaveLength(1);
    expect(close.comments()[0]).toContain("SEC-2");
    expect(close.transitioned()).toHaveLength(1);
  });
});

describe("Jira egress — durable pending_jira drain (flushPendingJira)", () => {
  it("drains a queued create against the mocked Jira and records the key", async () => {
    const jira = captureJiraCreate("SEC-9");
    await putCreatedTicket(env.DB, {
      halo_id: 900,
      gorelo_id: "g",
      number: 900,
      display_number: "T-900",
      title: "Queued",
      client_id: 10,
      contact_id: 55,
      status_id: 1,
      created_at: "2026-01-01T00:00:00Z",
    });
    await putPendingJira(env.DB, {
      kind: "create",
      clientId: 10,
      haloId: 900,
      payload: JSON.stringify({ summary: "Queued", description: "body", labels: ["tier2"] }),
      createdAt: "2020-01-01T00:00:00Z", // older than the grace window -> eligible now
    });

    const n = await flushPendingJira(env);
    expect(n).toBe(1);
    expect(jira.calls()).toHaveLength(1);
    expect((await getCreatedTicket(env.DB, 900))?.jira_issue_key).toBe("SEC-9");
    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS c FROM pending_jira`).first<{ c: number }>();
    expect(remaining?.c).toBe(0);
  });

  it("dedup guard: skips a queued create whose ledger row already has a key", async () => {
    const jira = captureJiraCreate("SEC-DUP");
    await putCreatedTicket(env.DB, {
      halo_id: 901,
      gorelo_id: "g",
      number: 901,
      display_number: "T-901",
      title: "Already mirrored",
      client_id: 10,
      contact_id: 55,
      status_id: 1,
      created_at: "2026-01-01T00:00:00Z",
      jira_issue_key: "SEC-EXISTING", // already created
    });
    await putPendingJira(env.DB, {
      kind: "create",
      clientId: 10,
      haloId: 901,
      payload: JSON.stringify({ summary: "Already mirrored", description: "b", labels: [] }),
      createdAt: "2020-01-01T00:00:00Z",
    });

    const n = await flushPendingJira(env);
    expect(n).toBe(1); // counted as done...
    expect(jira.calls()).toHaveLength(0); // ...but NO duplicate create issued
    expect((await getCreatedTicket(env.DB, 901))?.jira_issue_key).toBe("SEC-EXISTING");
  });

  it("dead-letters a create after MAX_JIRA_ATTEMPTS failures and alerts via notifly", async () => {
    // Jira create always fails.
    routes.push({
      method: "POST",
      match: (u) => u.host === "api.atlassian.com" && u.pathname === `/ex/jira/${JIRA_CLOUD_ID}/rest/api/3/issue`,
      handler: () => json(400, { errorMessages: ["bad"] }),
    });
    // Capture the notifly dead-letter alert (jsons:// -> POST hooks.example.com).
    let alert: Record<string, unknown> | undefined;
    routes.push({
      method: "POST",
      match: (u) => u.host === "hooks.example.com",
      handler: async (r) => {
        alert = (await r.json()) as Record<string, unknown>;
        return new Response("ok", { status: 200 });
      },
    });
    await putPendingJira(env.DB, {
      kind: "create",
      clientId: 10,
      haloId: null,
      payload: JSON.stringify({ summary: "Doomed", description: "b", labels: [] }),
      createdAt: "2020-01-01T00:00:00Z",
      attempts: 4, // next failure = attempt 5 = MAX_JIRA_ATTEMPTS -> dead-letter
    });

    const n = await flushPendingJira(env);
    expect(n).toBe(0); // not completed
    // Dropped, not re-queued.
    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS c FROM pending_jira`).first<{ c: number }>();
    expect(remaining?.c).toBe(0);
    // notifly alerted, naming the client and action.
    expect(String(alert?.title)).toContain("Jira create failed");
    expect(String(alert?.body)).toContain("Client (Gorelo id): 10");
  });
});

// Drives JiraClient directly (not through the worker/event spine — that wiring is
// auth-mode-agnostic and already covered above) against the client_credentials +
// accessible-resources + api.atlassian.com/ex/jira/{cloudId} shape a service
// account's OAuth 2.0 credential uses (see README "Jira output (egress)").
describe("Jira egress — service-account OAuth 2.0 auth mode", () => {
  const CLOUD_ID = "11111111-2222-3333-4444-555555555555";
  const OAUTH_TARGET: JiraTarget = {
    clientId: 10,
    baseUrl: `https://${JIRA_HOST}`,
    projectKey: "SEC",
    issueType: "Task",
    resolvedTransition: "Done",
    auth: { mode: "oauth", oauthClientId: "oauth-id", oauthClientSecret: "oauth-secret" },
  };

  function mockOAuthToken(): { calls: () => number } {
    let calls = 0;
    routes.push({
      method: "POST",
      match: (u) => u.host === "auth.atlassian.com" && u.pathname === "/oauth/token",
      handler: async (r) => {
        calls++;
        const body = (await r.json()) as Record<string, unknown>;
        expect(body.grant_type).toBe("client_credentials");
        expect(body.client_id).toBe("oauth-id");
        expect(body.client_secret).toBe("oauth-secret");
        return json(200, { access_token: "fake-access-token", expires_in: 3600 });
      },
    });
    return { calls: () => calls };
  }

  function mockAccessibleResources(resources: Array<{ id: string; url: string }>): { calls: () => number } {
    let calls = 0;
    routes.push({
      method: "GET",
      match: (u) => u.host === "api.atlassian.com" && u.pathname === "/oauth/token/accessible-resources",
      handler: (r) => {
        calls++;
        expect(r.headers.get("authorization")).toBe("Bearer fake-access-token");
        return json(200, resources);
      },
    });
    return { calls: () => calls };
  }

  it("exchanges client_credentials for a token, resolves cloudId, and creates against api.atlassian.com/ex/jira/{cloudId}", async () => {
    const token = mockOAuthToken();
    const resources = mockAccessibleResources([
      { id: CLOUD_ID, url: `https://${JIRA_HOST}` },
      { id: "other-cloud-id", url: "https://other.atlassian.net" },
    ]);
    const seen: Array<{ fields?: Record<string, unknown> }> = [];
    routes.push({
      method: "POST",
      match: (u) => u.host === "api.atlassian.com" && u.pathname === `/ex/jira/${CLOUD_ID}/rest/api/3/issue`,
      handler: async (r) => {
        seen.push((await r.json()) as { fields?: Record<string, unknown> });
        return json(201, { id: "10001", key: "SEC-9" });
      },
    });

    const key = await new JiraClient(OAUTH_TARGET).createIssue({ summary: "OAuth test", description: "body" });
    expect(key).toBe("SEC-9");
    expect(token.calls()).toBe(1);
    expect(resources.calls()).toBe(1);
    expect(seen[0]?.fields?.project).toEqual({ key: "SEC" });
  });

  it("caches the token and cloudId across calls on one instance (create, comment, transition = one token fetch)", async () => {
    const token = mockOAuthToken();
    const resources = mockAccessibleResources([{ id: CLOUD_ID, url: `https://${JIRA_HOST}` }]);
    routes.push({
      method: "POST",
      match: (u) => u.host === "api.atlassian.com" && u.pathname === `/ex/jira/${CLOUD_ID}/rest/api/3/issue`,
      handler: () => json(201, { id: "10001", key: "SEC-9" }),
    });
    routes.push({
      method: "POST",
      match: (u) => u.host === "api.atlassian.com" && /\/comment$/.test(u.pathname),
      handler: () => json(201, {}),
    });
    routes.push({
      method: "GET",
      match: (u) => u.host === "api.atlassian.com" && /\/transitions$/.test(u.pathname),
      handler: () => json(200, { transitions: [{ id: "31", name: "Done" }] }),
    });
    routes.push({
      method: "POST",
      match: (u) => u.host === "api.atlassian.com" && /\/transitions$/.test(u.pathname),
      handler: () => new Response(null, { status: 204 }),
    });

    const client = new JiraClient(OAUTH_TARGET);
    const key = await client.createIssue({ summary: "s", description: "d" });
    await client.addComment(key, "resolved");
    const transitioned = await client.transitionTo(key, "done"); // case-insensitive vs "Done"

    expect(transitioned).toBe(true);
    // One token fetch + one cloudId lookup for the whole create+comment+transition
    // sequence, not one per call — see the instance-level cache in JiraClient.
    expect(token.calls()).toBe(1);
    expect(resources.calls()).toBe(1);
  });

  it("throws a JiraError when the service account's OAuth credential has no access to this target's site", async () => {
    mockOAuthToken();
    mockAccessibleResources([{ id: "other-cloud-id", url: "https://other.atlassian.net" }]); // no match for JIRA_HOST

    await expect(
      new JiraClient(OAUTH_TARGET).createIssue({ summary: "s", description: "d" }),
    ).rejects.toThrow(JiraError);
  });
});
