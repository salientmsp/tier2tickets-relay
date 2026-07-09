import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { isHaloPath } from "../src/halo.js";

const HOST = "https://t2t.example.com";

async function call(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${HOST}${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("isHaloPath", () => {
  it("matches the OAuth token and resource-server paths", () => {
    expect(isHaloPath("/auth/token")).toBe(true);
    expect(isHaloPath("/api/Tickets")).toBe(true);
    expect(isHaloPath("/api/Client")).toBe(true);
    expect(isHaloPath("/health")).toBe(false);
    expect(isHaloPath("/admin/sync")).toBe(false);
  });
});

describe("Halo mock (phase 1)", () => {
  it("issues a bearer token from client_credentials (form-encoded)", async () => {
    const res = await call("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "halo-test-id",
        client_secret: "halo-test-secret",
        scope: "all",
      }).toString(),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json.access_token).toBe("string");
    expect((json.access_token as string).length).toBeGreaterThan(0);
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBe(3600);
  });

  it("validates configured client credentials when set", async () => {
    // vitest binds HALO_CLIENT_ID/SECRET; wrong secret -> 401.
    const res = await call("/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "halo-test-id",
        client_secret: "wrong",
      }).toString(),
    });
    expect(res.status).toBe(401);
  });

  it("returns empty Halo-shaped lookups", async () => {
    const res = await call("/api/Client?search=acme");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ clients: [], record_count: 0 });
  });

  it("returns a synthetic ticket id on create (no Gorelo write in phase 1)", async () => {
    const res = await call("/api/Tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ summary: "printer down", details: "help" }]),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(typeof json.id).toBe("number");
  });
});
