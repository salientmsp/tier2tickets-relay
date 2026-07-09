import { initSchema } from "./db.js";
import { GoreloError } from "./gorelo.js";
import { flushPendingTickets, handleHalo, isHaloRequest } from "./halo.js";
import { syncAll } from "./sync.js";
import type { Env } from "./types.js";

// The 6-hourly mirror-refresh cron (must match wrangler.toml [triggers].crons).
// Any other cron firing is treated as the frequent orphaned-ticket flush.
const SYNC_CRON = "0 */6 * * *";

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Admin: manual mirror refresh, gated by ADMIN_KEY.
    if (request.method === "POST" && url.pathname === "/admin/sync") {
      if (!adminKeyOk(request, env)) return textResponse(401, "unauthorized");
      try {
        const r = await syncAll(env);
        return textResponse(
          200,
          `ok clients=${r.clients} domains=${r.domains} locations=${r.locations} contacts=${r.contacts} devices=${r.devices}`,
        );
      } catch (err) {
        console.error("admin sync failed", describeError(err));
        return textResponse(502, "sync failed");
      }
    }

    // Lightweight health check (no secrets).
    if (request.method === "GET" && url.pathname === "/health") {
      return textResponse(200, "ok");
    }

    // HaloPSA/ITSM mock (OAuth token + resource server) — the sole integration
    // path. Detected by the `halo-app-name` header Tier2 sends (and a path
    // fallback). See src/halo.ts.
    if (isHaloRequest(request, url.pathname)) {
      return handleHalo(request, env, ctx);
    }

    return textResponse(404, "not found");
  },

  // Cron Triggers: the frequent cron flushes orphaned deferred tickets (a press
  // whose /actions note never arrived); the 6-hourly cron refreshes the mirror.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === SYNC_CRON) {
      ctx.waitUntil(
        syncAll(env)
          .then((r) =>
            console.log(
              `cron sync ok clients=${r.clients} domains=${r.domains} locations=${r.locations} contacts=${r.contacts} devices=${r.devices}`,
            ),
          )
          .catch((err) => console.error("cron sync failed", describeError(err))),
      );
      return;
    }
    ctx.waitUntil(
      initSchema(env.DB)
        .then(() => flushPendingTickets(env))
        .then((n) => {
          if (n > 0) console.log(`cron flush created ${n} orphaned ticket(s)`);
        })
        .catch((err) => console.error("cron flush failed", describeError(err))),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * Gate POST /admin/sync. Accepts the key via `X-API-Key` or `X-Admin-Key`
 * header, or an `Authorization: Bearer` token, matched against ADMIN_KEY.
 */
function adminKeyOk(request: Request, env: Env): boolean {
  if (!env.ADMIN_KEY) return false;
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const provided =
    request.headers.get("X-Admin-Key") ?? request.headers.get("X-API-Key") ?? bearer;
  return provided === env.ADMIN_KEY;
}

/** Describe an error WITHOUT leaking secrets. */
function describeError(err: unknown): string {
  if (err instanceof GoreloError) return `GoreloError status=${err.status}`;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
