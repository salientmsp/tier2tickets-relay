import * as Sentry from "@sentry/cloudflare";

import { alertHealth, handleAlert } from "./alerts.js";
import { getLastSync, getSyncMeta, initSchema, mirrorCounts, setSyncMeta } from "./db.js";
import { GoreloClient } from "./gorelo.js";
import { flushPendingTickets, handleHalo, isHaloRequest, postSyncFailure, testNotifly } from "./halo.js";
import { breadcrumb, describeError } from "./log.js";
import { reconcileClientLocations, syncAll } from "./sync.js";
import type { Env, SyncLocationsMessage } from "./types.js";

// The 6-hourly mirror-refresh cron (must match wrangler.toml [triggers].crons).
// Any other cron firing is treated as the frequent orphaned-ticket flush.
const SYNC_CRON = "0 */6 * * *";

// Sentry DSN for this relay's project. A DSN is a write-only ingest identifier, not
// a secret (it can only submit events, never read them), so it lives in source rather
// than a secret binding. `nodejs_compat` (wrangler.toml) already satisfies the SDK's
// AsyncLocalStorage requirement, so no compatibility-flag change is needed.
const SENTRY_DSN =
  "https://e84c861f90b9a7e94e45bef4a3efae8f@o4511867765719040.ingest.us.sentry.io/4511867771355136";

// Master gate for the whole Sentry integration — OFF unless `SENTRY_ENABLED` is
// explicitly truthy (1/true/yes/on, case-insensitive; mirrors debugOn()). Production
// opts in via wrangler.toml [vars]; tests and `wrangler dev` leave it unset.
const sentryEnabled = (env: Env): boolean => /^(1|true|yes|on)$/i.test(env.SENTRY_ENABLED ?? "");

/**
 * Sentry options for `withSentry` (below), built per invocation from `env`.
 *
 * PRIVACY (mirrors the F4 no-PII logging posture in src/log.ts): this is a
 * PHI-adjacent relay whose request/response bodies and headers carry names, emails,
 * phone numbers and source IPs. Sentry's `dataCollection.*` categories are opt-OUT
 * (bodies, cookies, headers all default ON), so we explicitly turn off every channel
 * that could carry that data — leaving only the error type, stack trace and
 * request URL/method reaching Sentry. This is the analogue of DEBUG_LOGS=false: the
 * useful failure signal without the PII.
 */
function sentryOptions(env: Env): Sentry.CloudflareOptions {
  return {
    dsn: SENTRY_DSN,
    // The whole integration is gated on SENTRY_ENABLED: off by default (SDK
    // initializes but sends nothing — no events, no spans, no egress), so tests and
    // local dev never reach the DSN. Production sets SENTRY_ENABLED="true".
    enabled: sentryEnabled(env),
    // Capture 100% of traces. Low-volume relay; lower this if Sentry quota is a concern.
    tracesSampleRate: 1.0,
    dataCollection: {
      // Do NOT ship PII/PHI to a third party (see the note above):
      userInfo: false, // no user.* (includes the resolved client IP)
      httpBodies: [], // no request/response bodies (names, emails, phones)
      cookies: false, // no cookies
      httpHeaders: { request: false, response: false }, // no headers (auth, CF-Connecting-IP)
    },
    // Do not forward console/structured logs to Sentry — the same lines are the
    // non-PII breadcrumbs of src/log.ts and belong only in Workers Logs.
    enableLogs: false,
  };
}

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const jsonResponse = (status: number, body: unknown): Response =>
  // Pretty-printed with a trailing newline — this is read by humans curling it.
  new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// 405 for a recognized path hit with the wrong method — names the allowed
// method(s) (and sets the Allow header) so callers aren't left guessing with a 404.
const methodNotAllowed = (allow: string): Response =>
  new Response(`method not allowed (${allow} only)`, {
    status: 405,
    headers: { "content-type": "text/plain; charset=utf-8", allow },
  });

// Wrapped with `withSentry` at the bottom of this file — it instruments `fetch`,
// `scheduled` AND `queue`, so all three entry points report unhandled errors to
// Sentry (subject to the privacy-locked sentryOptions above).
const handler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // `routeRequest` owns the actual dispatch; an *uncaught* throw from it skips the
    // check below and propagates to withSentry (captured with a full stack trace, then
    // re-thrown -> the runtime returns 500 to the caller).
    const response = await routeRequest(request, env, ctx);

    // Safety net (the "no silent 500s" guarantee): several handlers CATCH their own
    // failure and RETURN a 5xx instead of throwing — e.g. /admin/sync -> 502, or a
    // Halo/alert handler's internal 500. withSentry never sees those (it only reports
    // uncaught throws), so we report every server-error response here. 4xx are client
    // errors (auth / not-found / bad-input) — expected, so NOT reported. Non-PII: only
    // the method, path and status (never the query string or body). No-op when Sentry
    // is disabled (SENTRY_ENABLED unset), so tests/dev stay silent.
    if (response.status >= 500) {
      Sentry.captureMessage(`http_5xx ${request.method} ${new URL(request.url).pathname}`, {
        level: "error",
        tags: { entrypoint: "fetch", method: request.method, status: String(response.status) },
      });
    }
    return response;
  },

  // Cron Triggers: the frequent cron flushes orphaned deferred tickets (a press
  // whose /actions note never arrived); the 6-hourly cron refreshes the mirror.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === SYNC_CRON) {
      ctx.waitUntil(
        syncAll(env)
          .then((r) =>
            breadcrumb(
              `cron sync ok clients=${r.clients} locations=${r.locations} contacts=${r.contacts} ` +
                `devices=${r.devices} changed=${r.changed} deleted=${r.deleted} ` +
                `locations_queued=${r.locationsQueued} complete=${r.complete}`,
            ),
          )
          .catch(async (err) => {
            const detail = describeError(err);
            breadcrumb(`cron sync failed ${detail}`);
            // Report to Sentry: the cron runs unattended, so a failed mirror refresh
            // would otherwise be invisible. captureException keeps the stack trace.
            Sentry.captureException(err, { tags: { entrypoint: "scheduled", job: "cron-sync" } });
            await postSyncFailure(env, { source: "cron", error: detail });
          }),
      );
      return;
    }
    ctx.waitUntil(
      initSchema(env.DB)
        .then(() => flushPendingTickets(env))
        .then((n) => {
          if (n > 0) breadcrumb(`cron flush created ${n} orphaned ticket(s)`);
        })
        .catch((err) => {
          breadcrumb(`cron flush failed ${describeError(err)}`);
          Sentry.captureException(err, { tags: { entrypoint: "scheduled", job: "cron-flush" } });
        }),
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
          breadcrumb(`queue locations client=${clientId} changed=${changed} deleted=${deleted}`);
        }
        msg.ack();
      } catch (err) {
        // Transient (Gorelo rate-limit / 5xx) — let the queue redeliver with
        // backoff up to max_retries, then drop. Never delete on failure.
        breadcrumb(`queue locations client=${clientId} failed, will retry: ${describeError(err)}`);
        // Only report to Sentry on the LAST delivery (attempts is 1-based; total
        // deliveries = 1 + max_retries). Reporting every transient retry would be
        // noise — but a sync that exhausts its retries is dropped SILENTLY otherwise,
        // which is exactly the kind of failure we need to see. Keep QUEUE_MAX_RETRIES
        // in sync with [[queues.consumers]] max_retries in wrangler.toml.
        if (msg.attempts > QUEUE_MAX_RETRIES) {
          Sentry.captureException(err, {
            tags: { entrypoint: "queue", job: "locations", clientId: String(clientId) },
            extra: { attempts: msg.attempts },
          });
        }
        msg.retry();
      }
    }
    // Stamp progress for /admin/status (once per batch, not per message).
    await setSyncMeta(env.DB, "locations_synced_at", new Date().toISOString());
  },
} satisfies ExportedHandler<Env, SyncLocationsMessage>;

// Mirrors [[queues.consumers]] max_retries in wrangler.toml — total deliveries of a
// queue message are 1 + max_retries, so `attempts > QUEUE_MAX_RETRIES` is the final
// (about-to-be-dropped) delivery. Used to report only permanent queue failures.
const QUEUE_MAX_RETRIES = 3;

// Actual request dispatch for `fetch` above. Returns a Response for every path; the
// wrapper reports any 5xx it returns (and withSentry reports anything it throws).
async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  // App's own endpoints: match on path, then validate the method so a wrong
  // method gets a clear 405 + Allow header (not a misleading 404). `matched`
  // stays true once a path is recognized, so we never fall through to Halo/404.
  // Admin: manual mirror refresh, gated by ADMIN_KEY.
  if (url.pathname === "/admin/sync") {
    if (request.method !== "POST") return methodNotAllowed("POST");
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
      const detail = describeError(err);
      breadcrumb(`admin sync failed ${detail}`);
      ctx.waitUntil(postSyncFailure(env, { source: "admin", error: detail }));
      return textResponse(502, "sync failed");
    }
  }

  // Admin: sync + location-queue status (ADMIN_KEY). Follow the location fan-out:
  // how many messages the last sync enqueued and whether the consumer has caught
  // up, alongside current mirror row counts.
  if (url.pathname === "/admin/status") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    if (!adminKeyOk(request, env)) return textResponse(401, "unauthorized");
    await initSchema(env.DB);
    const [counts, lastSync, enqueued, enqueuedAt, syncedAt] = await Promise.all([
      mirrorCounts(env.DB),
      getLastSync(env.DB),
      getSyncMeta(env.DB, "locations_enqueued"),
      getSyncMeta(env.DB, "locations_enqueued_at"),
      getSyncMeta(env.DB, "locations_synced_at"),
    ]);
    // How long the consumer took to drain after the last enqueue (null until it
    // has run at/after it); `drained` is just whether that lag is known.
    const enqMs = enqueuedAt ? Date.parse(enqueuedAt) : NaN;
    const syncMs = syncedAt ? Date.parse(syncedAt) : NaN;
    const caughtUp = Number.isFinite(enqMs) && Number.isFinite(syncMs) && syncMs >= enqMs;
    return jsonResponse(200, {
      lastSync,
      mirror: counts,
      locationQueue: {
        queued: enqueued != null ? Number(enqueued) : null,
        drained: caughtUp,
        lagSeconds: caughtUp ? Math.round((syncMs - enqMs) / 1000) : null,
      },
    });
  }

  // Admin: fire a test alert through the notifly dead-letter path (ADMIN_KEY).
  if (url.pathname === "/admin/test-webhook") {
    if (request.method !== "POST") return methodNotAllowed("POST");
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

  // Admin: deliberately throw so Sentry reporting can be verified end-to-end
  // (ADMIN_KEY). The throw is uncaught, so withSentry captures it (full stack) and
  // the runtime returns 500 — the same path a real unhandled error takes. Gated by
  // ADMIN_KEY so it is not publicly triggerable. `curl -X POST .../admin/debug-error
  // -H "X-Admin-Key: $ADMIN_KEY"` -> a "Sentry verification error" event appears.
  if (url.pathname === "/admin/debug-error") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!adminKeyOk(request, env)) return textResponse(401, "unauthorized");
    throw new Error("Sentry verification error (intentional, via /admin/debug-error)");
  }

  // Lightweight health check (no secrets). GET or HEAD — most uptime monitors
  // probe with HEAD.
  if (url.pathname === "/health") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return textResponse(200, "ok");
  }

  // Monitoring alert ingress (POST) + its own JSON health descriptor. Handled
  // explicitly here so it never falls through to the IP/UA-gated Halo mock; the
  // handler enforces its own IP allowlist + shared secret and speaks the alert
  // JSON contract for every response (including 405). See src/alerts.ts.
  if (url.pathname === "/v1/alerts") {
    return handleAlert(request, env);
  }
  if (url.pathname === "/v1/alerts/health") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return alertHealth();
  }

  // HaloPSA/ITSM mock (OAuth token + resource server) — the sole integration
  // path. Detected by the `halo-app-name` header Tier2 sends (and a path
  // fallback). See src/halo.ts.
  if (isHaloRequest(request, url.pathname)) {
    return handleHalo(request, env, ctx);
  }

  return textResponse(404, "not found");
}

// Pin the generics: without them `QueueHandlerMessage` infers as `unknown` and the
// return type widens to `ExportedHandler` (whose methods are all optional), so callers
// — the test suite — lose the concrete, always-present `fetch`/`queue`. The 4th
// generic (`typeof handler`) keeps the return type identical to the wrapped object.
export default Sentry.withSentry<Env, SyncLocationsMessage, unknown, typeof handler>(
  sentryOptions,
  handler,
);

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
  return constantTimeEqual(provided, env.ADMIN_KEY);
}

/**
 * Length-checked constant-time string compare (audit F6): once the lengths match,
 * the XOR-accumulate over the encoded bytes takes the same time regardless of
 * where the first difference is, so it can't be used as a timing oracle.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}
