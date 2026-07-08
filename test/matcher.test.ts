import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { initSchema } from "../src/db.js";
import { matchClient } from "../src/matcher.js";
import type { PressIdentity } from "../src/types.js";

const CATCHALL = 999;

function identity(over: Partial<PressIdentity>): PressIdentity {
  return { email: "", name: "", host: "", mac: "", ip: "", ...over };
}

async function seed(): Promise<void> {
  await initSchema(env.DB);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM devices`),
    env.DB.prepare(`DELETE FROM client_domains`),
  ]);
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO devices (hostname, upn, client_id, location_id, agent_id) VALUES (?,?,?,?,?)`)
      .bind("pc-01", "user@corp.com", 10, 100, "agent-abc"),
    env.DB
      .prepare(`INSERT INTO devices (hostname, upn, client_id, location_id, agent_id) VALUES (?,?,?,?,?)`)
      .bind("laptop-9", "roamer@corp.com", 20, 200, "agent-xyz"),
    env.DB.prepare(`INSERT INTO client_domains (domain, client_id) VALUES (?, ?)`).bind("corp.com", 10),
    env.DB.prepare(`INSERT INTO client_domains (domain, client_id) VALUES (?, ?)`).bind("acme.io", 30),
  ]);
}

describe("matchClient", () => {
  beforeEach(seed);

  it("matches by hostname first, carrying location + agent", async () => {
    const r = await matchClient(env.DB, identity({ host: "pc-01", email: "someone@acme.io" }), CATCHALL);
    expect(r).toEqual({ clientId: 10, locationId: 100, agentId: "agent-abc", matchType: "hostname" });
  });

  it("matches a FQDN/uppercase hostname after normalization at the caller", async () => {
    // matcher expects already-normalized host (short-lowercase); buildIdentity does this.
    const r = await matchClient(env.DB, identity({ host: "laptop-9" }), CATCHALL);
    expect(r.clientId).toBe(20);
    expect(r.matchType).toBe("hostname");
  });

  it("falls back to UPN match when hostname misses", async () => {
    const r = await matchClient(env.DB, identity({ host: "unknown-host", email: "roamer@corp.com" }), CATCHALL);
    expect(r).toEqual({ clientId: 20, locationId: 200, agentId: "agent-xyz", matchType: "upn" });
  });

  it("falls back to email domain when device misses", async () => {
    const r = await matchClient(env.DB, identity({ email: "newhire@acme.io" }), CATCHALL);
    expect(r).toEqual({ clientId: 30, locationId: null, agentId: null, matchType: "domain" });
  });

  it("uses the catch-all when nothing matches", async () => {
    const r = await matchClient(env.DB, identity({ email: "stranger@nowhere.test", host: "ghost" }), CATCHALL);
    expect(r).toEqual({ clientId: CATCHALL, locationId: null, agentId: null, matchType: "catchall" });
  });
});
