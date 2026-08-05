import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { initSchema } from "../src/db.js";

const HOST = "https://relay.example.com";
const SECRET = "alert-test-secret"; // matches vitest.config.ts ALERT_SHARED_SECRET

// --- outbound Gorelo fetch stub ---------------------------------------------
let realFetch: typeof fetch;
let createCalls = 0;
let lastId = "";
let failCreate = false;

beforeAll(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (status: number, data: unknown): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function installFetch(): void {
  createCalls = 0;
  lastId = "";
  failCreate = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/v1/tickets") {
      if (failCreate) return new Response("boom", { status: 500 });
      createCalls += 1;
      lastId = `uuid-${createCalls}`;
      return json(200, { id: lastId });
    }
    if (req.method === "GET" && url.pathname === "/v1/tickets") {
      return json(200, { data: [{ id: lastId, number: 5000 + createCalls, displayNumber: `T-${5000 + createCalls}` }] });
    }
    throw new Error(`unmocked fetch: ${req.method} ${url.pathname}`);
  }) as typeof fetch;
}

beforeEach(async () => {
  installFetch();
  await initSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM alerts`),
    env.DB.prepare(`DELETE FROM alert_heartbeats`),
  ]);
});

function baseAlert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "SQL Backup Monitor",
    host: "DB-SERVER-01",
    customer: "Example Customer",
    monitor_id: "daily-restore",
    event_id: "2026-08-05-daily-restore",
    dedupe_key: "DB-SERVER-01:daily-restore",
    status: "triggered",
    severity: "critical",
    title: "Daily restore failed",
    message: "The daily transaction-log restore failed after all retry attempts.",
    timestamp: "2026-08-05T01:30:00-05:00",
    details: { database: "app_db", error: "No new transaction-log backup was available." },
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`${HOST}/v1/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}`, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

interface AlertResponse {
  accepted?: boolean;
  action?: string;
  dedupe_key?: string;
  remote_id?: string;
  error?: string;
}
const body = async (res: Response): Promise<AlertResponse> => (await res.json()) as AlertResponse;

async function alertRow(dedupeKey: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare(`SELECT * FROM alerts WHERE dedupe_key = ?`).bind(dedupeKey).first();
}

describe("POST /v1/alerts — method & auth", () => {
  it("405 (JSON) for a non-POST method, with Allow: POST", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${HOST}/v1/alerts`, { method: "GET" }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await body(res)).toMatchObject({ accepted: false });
  });

  it("401 when the shared secret is missing", async () => {
    const res = await post(baseAlert(), { authorization: "" });
    expect(res.status).toBe(401);
    expect(await body(res)).toMatchObject({ accepted: false });
  });

  it("401 when the shared secret is wrong", async () => {
    const res = await post(baseAlert(), { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("accepts the secret via X-Alert-Key too", async () => {
    const res = await post(baseAlert(), { authorization: "", "X-Alert-Key": SECRET });
    expect(res.status).toBe(202);
  });
});

describe("POST /v1/alerts — validation", () => {
  it("400 on invalid JSON", async () => {
    const res = await post("{not json", {});
    expect(res.status).toBe(400);
    expect(await body(res)).toMatchObject({ accepted: false, error: "invalid JSON" });
  });

  it("400 on a missing required field", async () => {
    const res = await post(baseAlert({ monitor_id: "" }));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain("monitor_id");
  });

  it("400 on an unsupported status", async () => {
    const res = await post(baseAlert({ status: "flapping" }));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain("status");
  });

  it("400 on an unsupported severity", async () => {
    const res = await post(baseAlert({ severity: "fatal" }));
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain("severity");
  });
});

describe("POST /v1/alerts — triggered & dedup", () => {
  it("creates one Gorelo ticket and stores the alert (action=created)", async () => {
    const res = await post(baseAlert());
    expect(res.status).toBe(202);
    const b = await body(res);
    expect(b).toMatchObject({ accepted: true, action: "created", dedupe_key: "DB-SERVER-01:daily-restore" });
    expect(b.remote_id).toBe("T-5001");
    expect(createCalls).toBe(1);
    const row = await alertRow("DB-SERVER-01:daily-restore");
    expect(row).toMatchObject({ status: "open", severity: "critical", display_number: "T-5001" });
  });

  it("updates the open alert without a second ticket (action=updated)", async () => {
    await post(baseAlert());
    const res = await post(baseAlert({ event_id: "later-event", message: "still failing" }));
    expect(res.status).toBe(202);
    expect((await body(res)).action).toBe("updated");
    expect(createCalls).toBe(1); // no second create
    const row = await alertRow("DB-SERVER-01:daily-restore");
    expect(row?.message).toBe("still failing");
  });

  it("ignores an exact retry of the same event (Idempotency-Key)", async () => {
    await post(baseAlert(), { "Idempotency-Key": "evt-1" });
    const res = await post(baseAlert({ message: "changed but same key" }), { "Idempotency-Key": "evt-1" });
    expect(res.status).toBe(202);
    expect((await body(res)).action).toBe("duplicate-ignored");
    expect(createCalls).toBe(1);
    const row = await alertRow("DB-SERVER-01:daily-restore");
    expect(row?.message).toBe("The daily transaction-log restore failed after all retry attempts.");
  });
});

describe("POST /v1/alerts — resolved", () => {
  it("files a resolution notice and marks the alert resolved (action=resolved)", async () => {
    await post(baseAlert());
    expect(createCalls).toBe(1);
    const res = await post(baseAlert({ status: "resolved", event_id: "resolve-1" }));
    expect(res.status).toBe(202);
    expect((await body(res)).action).toBe("resolved");
    expect(createCalls).toBe(2); // the resolution notice
    const row = await alertRow("DB-SERVER-01:daily-restore");
    expect(row?.status).toBe("resolved");
    expect(row?.resolved_at).toBeTruthy();
  });

  it("returns success without creating anything when nothing is open", async () => {
    const res = await post(baseAlert({ status: "resolved", dedupe_key: "unknown:key" }));
    expect(res.status).toBe(202);
    expect((await body(res)).action).toBe("duplicate-ignored");
    expect(createCalls).toBe(0);
  });

  it("re-triggering after a resolve opens a fresh ticket", async () => {
    await post(baseAlert());
    await post(baseAlert({ status: "resolved", event_id: "r1" }));
    const res = await post(baseAlert({ event_id: "t2" }));
    expect((await body(res)).action).toBe("created");
    expect(createCalls).toBe(3);
    const row = await alertRow("DB-SERVER-01:daily-restore");
    expect(row?.status).toBe("open");
  });
});

describe("POST /v1/alerts — heartbeat", () => {
  it("records a heartbeat without creating a ticket (action=heartbeat-recorded)", async () => {
    const res = await post(baseAlert({ monitor_id: "heartbeat", status: "heartbeat", dedupe_key: "DB-SERVER-01:heartbeat" }));
    expect(res.status).toBe(202);
    expect((await body(res)).action).toBe("heartbeat-recorded");
    expect(createCalls).toBe(0);
    const hb = await env.DB.prepare(`SELECT * FROM alert_heartbeats WHERE dedupe_key = ?`).bind("DB-SERVER-01:heartbeat").first();
    expect(hb?.last_seen).toBeTruthy();
    expect(await alertRow("DB-SERVER-01:heartbeat")).toBeNull();
  });
});

describe("POST /v1/alerts — Gorelo failure", () => {
  it("502 and no stored alert when the Gorelo create is rejected", async () => {
    failCreate = true;
    const res = await post(baseAlert());
    expect(res.status).toBe(502);
    expect(await body(res)).toMatchObject({ accepted: false });
    expect(await alertRow("DB-SERVER-01:daily-restore")).toBeNull();
  });
});

describe("POST /v1/alerts — IP allowlist", () => {
  it("403 when enforcement is on and the source IP is not allowlisted", async () => {
    const prevEnforce = env.ENFORCE_IP_ALLOWLIST;
    const prevIps = env.ALERT_ALLOWED_IPS;
    env.ENFORCE_IP_ALLOWLIST = "true";
    env.ALERT_ALLOWED_IPS = "203.0.113.10, 198.51.100.0/24";
    try {
      const denied = await post(baseAlert(), { "CF-Connecting-IP": "8.8.8.8" });
      expect(denied.status).toBe(403);
      const allowed = await post(baseAlert(), { "CF-Connecting-IP": "198.51.100.42" });
      expect(allowed.status).toBe(202);
    } finally {
      env.ENFORCE_IP_ALLOWLIST = prevEnforce;
      env.ALERT_ALLOWED_IPS = prevIps;
    }
  });
});

describe("POST /v1/alerts — per-customer secret bound to IP", () => {
  const E = env as unknown as Record<string, string | undefined>;
  const DEFAULT_IP = "203.0.113.5"; // the `default` source's only IP
  const ACME_IP = "198.51.100.42"; // inside the `acme` source's CIDR
  const ACME_CIDR = "198.51.100.0/24";

  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      ENFORCE_IP_ALLOWLIST: E.ENFORCE_IP_ALLOWLIST,
      ALERT_SOURCES: E.ALERT_SOURCES,
      ALERT_ALLOWED_IPS: E.ALERT_ALLOWED_IPS,
      ALERT_SECRET_ACME: E.ALERT_SECRET_ACME,
      ALERT_IPS_ACME: E.ALERT_IPS_ACME,
    };
    E.ENFORCE_IP_ALLOWLIST = "true";
    E.ALERT_SOURCES = "default, acme";
    E.ALERT_ALLOWED_IPS = DEFAULT_IP; // default source ↔ SECRET
    E.ALERT_SECRET_ACME = "acme-secret"; // acme source ↔ its own IPs
    E.ALERT_IPS_ACME = ACME_CIDR;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete E[k];
      else E[k] = v;
    }
  });

  const call = (secret: string, ip: string): Promise<Response> =>
    post(baseAlert(), { authorization: `Bearer ${secret}`, "CF-Connecting-IP": ip });

  it("accepts each source's secret from that source's own IP", async () => {
    expect((await call("acme-secret", ACME_IP)).status).toBe(202);
    expect((await call(SECRET, DEFAULT_IP)).status).toBe(202);
  });

  it("403s a valid secret presented from another source's IP", async () => {
    expect((await call("acme-secret", DEFAULT_IP)).status).toBe(403); // acme secret, default's IP
    expect((await call(SECRET, ACME_IP)).status).toBe(403); // default secret, acme's IP
  });

  it("401s an unknown secret regardless of IP", async () => {
    expect((await call("bogus", ACME_IP)).status).toBe(401);
    expect((await call("bogus", DEFAULT_IP)).status).toBe(401);
  });
});

describe("POST /v1/alerts — a source allowlist holds many IPs/ranges/subnets", () => {
  const E = env as unknown as Record<string, string | undefined>;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      ENFORCE_IP_ALLOWLIST: E.ENFORCE_IP_ALLOWLIST,
      ALERT_SOURCES: E.ALERT_SOURCES,
      ALERT_SECRET_ACME: E.ALERT_SECRET_ACME,
      ALERT_IPS_ACME: E.ALERT_IPS_ACME,
    };
    E.ENFORCE_IP_ALLOWLIST = "true";
    E.ALERT_SOURCES = "acme";
    E.ALERT_SECRET_ACME = "acme-secret";
    // A mix of exact IPs, a /24 range and a /28 subnet — comma AND newline separated.
    E.ALERT_IPS_ACME = "203.0.113.7, 10.0.0.5\n198.51.100.0/24, 192.0.2.0/28";
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete E[k];
      else E[k] = v;
    }
  });

  const call = (ip: string): Promise<Response> =>
    post(baseAlert(), { authorization: "Bearer acme-secret", "CF-Connecting-IP": ip });

  it("accepts any member — exact IP, /24 range, or /28 subnet", async () => {
    for (const ip of ["203.0.113.7", "10.0.0.5", "198.51.100.42", "192.0.2.3"]) {
      expect((await call(ip)).status).toBe(202);
    }
  });

  it("rejects a non-member (incl. an address just outside the /28)", async () => {
    for (const ip of ["8.8.8.8", "192.0.2.20"]) {
      expect((await call(ip)).status).toBe(403);
    }
  });
});

describe("GET /v1/alerts/health", () => {
  it("returns the service descriptor with no secrets", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request(`${HOST}/v1/alerts/health`), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ status: "ok", service: "Gorelo alert proxy" });
  });
});
