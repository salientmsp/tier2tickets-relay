import { getLastSync, getSyncMeta, initSchema, mirrorCounts, setSyncMeta } from "./db.js";
import { GoreloClient, GoreloError } from "./gorelo.js";
import { flushPendingTickets, handleHalo, isHaloRequest, postSyncFailure, testNotifly } from "./halo.js";
import { reconcileClientLocations, syncAll } from "./sync.js";
import type { Env, SyncLocationsMessage } from "./types.js";

// The 6-hourly mirror-refresh cron (must match wrangler.toml [triggers].crons).
// Any other cron firing is treated as the frequent orphaned-ticket flush.
const SYNC_CRON = "0 */6 * * *";

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

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
          `ok clients=${r.clients} locations=${r.locations} contacts=${r.contacts} devices=${r.devices} ` +
            `changed=${r.changed} deleted=${r.deleted} locations_queued=${r.locationsQueued}` +
            `${r.complete ? "" : " (partial: bulk contacts fetch failed, contact deletes skipped)"}`,
        );
      } catch (err) {
        console.error("admin sync failed", describeError(err));
        ctx.waitUntil(postSyncFailure(env, { source: "admin", error: describeError(err) }));
        return textResponse(502, "sync failed");
      }
    }

    // Admin: sync + location-queue status (ADMIN_KEY). Lets you "follow" the
    // location fan-out — compare when work was last enqueued vs. when the consumer
    // last ran, alongside current mirror row counts.
    if (request.method === "GET" && url.pathname === "/admin/status") {
      if (!adminKeyOk(request, env)) return textResponse(401, "unauthorized");
      await initSchema(env.DB);
      const [counts, lastSync, enqueued, enqueuedAt, syncedAt] = await Promise.all([
        mirrorCounts(env.DB),
        getLastSync(env.DB),
        getSyncMeta(env.DB, "locations_enqueued"),
        getSyncMeta(env.DB, "locations_enqueued_at"),
        getSyncMeta(env.DB, "locations_synced_at"),
      ]);
      // Heuristic: the consumer has caught up if it ran at/after the last enqueue.
      const drained = enqueuedAt != null && syncedAt != null && syncedAt >= enqueuedAt;
      return jsonResponse(200, {
        mirror: counts,
        lastSync,
        locationQueue: {
          enqueued: enqueued != null ? Number(enqueued) : null,
          enqueuedAt,
          lastConsumerRunAt: syncedAt,
          drained,
        },
      });
    }

    // Admin: fire a test alert through the notifly dead-letter path (ADMIN_KEY).
    if (request.method === "POST" && url.pathname === "/admin/test-webhook") {
      if (!adminKeyOk(request, env)) return textResponse(401, "unauthorized");
      const r = await testNotifly(env);
      if (!r.configured) return textResponse(400, "NOTIFLY_URLS not set");
      const ok = r.results.filter((x) => x.success);
      const failed = r.results.filter((x) => !x.success);
      const detail = failed.length
        ? ` — ${failed.map((f) => `${f.service}: ${f.error ?? "?"}`).join("; ")}`
        : "";
      return textResponse(
        failed.length ? 502 : 200,
        `notifly: ${ok.length} ok, ${failed.length} failed${detail}`,
      );
    }

    // Lightweight health check (no secrets). Accept HEAD too — most uptime
    // monitors probe with HEAD, which must not fall through to the 404 below.
    if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/health") {
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
              `cron sync ok clients=${r.clients} locations=${r.locations} contacts=${r.contacts} ` +
                `devices=${r.devices} changed=${r.changed} deleted=${r.deleted} ` +
                `locations_queued=${r.locationsQueued} complete=${r.complete}`,
            ),
          )
          .catch(async (err) => {
            const detail = describeError(err);
            console.error("cron sync failed", detail);
            await postSyncFailure(env, { source: "cron", error: detail });
          }),
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

  // Queue consumer: per-client location fetches fanned out by syncAll. Each batch
  // is <=max_batch_size clients (wrangler.toml), so an invocation makes at most
  // that many Gorelo calls — comfortably under the 50 external-subrequest cap that
  // an inline all-clients sweep would exceed. Failed messages retry with backoff.
  async queue(batch: MessageBatch<SyncLocationsMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    await initSchema(env.DB);
    const client = new GoreloClient(env);
    for (const msg of batch.messages) {
      const { clientId } = msg.body;
      try {
        const locations = await client.listLocations(clientId);
        const { changed, deleted } = await reconcileClientLocations(env.DB, clientId, locations);
        if (changed || deleted) {
          console.log(`queue locations client=${clientId} changed=${changed} deleted=${deleted}`);
        }
        msg.ack();
      } catch (err) {
        // Transient (Gorelo rate-limit / 5xx) — let the queue redeliver with
        // backoff up to max_retries, then drop. Never delete on failure.
        console.error(`queue locations client=${clientId} failed, will retry: ${describeError(err)}`);
        msg.retry();
      }
    }
    // Stamp progress for /admin/status (once per batch, not per message).
    await setSyncMeta(env.DB, "locations_synced_at", new Date().toISOString());
  },
} satisfies ExportedHandler<Env, SyncLocationsMessage>;

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
