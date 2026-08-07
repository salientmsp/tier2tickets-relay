import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const HOST = "https://relay.example.com";

// The Sentry verification endpoint: POST /admin/debug-error throws on purpose so an
// end-to-end Sentry test can be run against a deployment. It is gated by ADMIN_KEY and
// method-checked like the other /admin routes. Sentry itself is disabled in tests
// (SENTRY_ENABLED unset in vitest.config.ts), so nothing is emitted here.
describe("/admin/debug-error", () => {
  async function call(method: string, headers?: Record<string, string>): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`${HOST}/admin/debug-error`, { method, headers }),
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("requires the admin key (401), without throwing", async () => {
    expect((await call("POST")).status).toBe(401);
  });

  it("is POST-only: a wrong method returns 405 (not 404) with an Allow header", async () => {
    const res = await call("GET", { "X-Admin-Key": "test-admin-key" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("throws an uncaught error when authorized (this is what Sentry reports)", async () => {
    // The throw is uncaught by design: withSentry captures it and the runtime turns it
    // into a 500 for the caller. Invoking the handler directly surfaces the rejection.
    const ctx = createExecutionContext();
    await expect(
      worker.fetch(
        new Request(`${HOST}/admin/debug-error`, {
          method: "POST",
          headers: { "X-Admin-Key": "test-admin-key" },
        }),
        env,
        ctx,
      ),
    ).rejects.toThrow(/verification error/i);
  });
});
