import { findDeviceFullByHostname, getAlert, initSchema, listClientRows, putAlert, recordHeartbeat } from "./db.js";
import { GoreloClient, GoreloError } from "./gorelo.js";
import { breadcrumb, debug, describeError } from "./log.js";
import { normalizeHost } from "./parse.js";
import { ipInCidr } from "./products.js";
import type { AlertLevel, Env, PostAlertRequest } from "./types.js";

/**
 * Monitoring alert relay — POST /v1/alerts.
 *
 * A standardized HTTPS ingress for on-prem/monitoring sources (e.g. a Windows/SQL
 * Server) to raise, update, and resolve alerts in Gorelo through this IP-allowlisted
 * proxy. Requests are gated by source IP (CF-Connecting-IP) AND a shared secret
 * (Authorization: Bearer or X-Alert-Key), then deduplicated by `dedupe_key` so a
 * retrying monitor never re-raises the same alert.
 *
 * Events map to Gorelo's NATIVE alert endpoint (POST /v1/alerts/) — an alert, not a
 * service ticket. That endpoint is create-only (no id, no update/close), so the relay
 * owns the lifecycle in D1: a `triggered` event posts ONE Gorelo alert and remembers
 * it by `dedupe_key`; repeats update the stored row WITHOUT re-posting; a `resolved`
 * event posts a "Resolved: …" alert and marks the stored row resolved; `heartbeat`
 * events only stamp last-seen (no Gorelo call).
 */

// The alert lifecycle statuses a source may send.
const STATUSES = new Set(["triggered", "resolved", "heartbeat"]);
// Severities we map to a Gorelo AlertLevel.
const SEVERITIES = new Set(["info", "warning", "critical"]);

// Required top-level string fields on every alert (all must be present & non-empty).
const REQUIRED = ["source", "host", "monitor_id", "dedupe_key", "status", "severity", "title", "message", "timestamp"] as const;

/** The normalized, validated alert payload. */
interface Alert {
  source: string;
  host: string;
  customer: string;
  monitor_id: string;
  event_id: string;
  dedupe_key: string;
  status: string;
  severity: string;
  title: string;
  message: string;
  timestamp: string;
  details: Record<string, unknown> | null;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** The `{ accepted: false, error }` shape all error responses use. */
const errorResponse = (status: number, error: string, extra: Record<string, unknown> = {}): Response =>
  jsonResponse(status, { accepted: false, error, ...extra });

/** GET /v1/alerts/health — a liveness descriptor that exposes no secrets/config. */
export function alertHealth(): Response {
  return jsonResponse(200, { status: "ok", service: "Gorelo alert proxy" });
}

// --- auth: per-source secret bound to that source's IP(s) -------------------
//
// Every request must satisfy TWO factors that belong to the SAME source (a
// "customer"), mirroring how each Halo product ties a credential to its own IPs:
//   1. present that source's shared secret (Authorization: Bearer / X-Alert-Key), and
//   2. originate from an IP in that source's own allowlist.
// A wrong secret is a 401; a valid secret from an IP outside its source's list is a
// 403. One customer's secret is therefore useless from another customer's network.
//
// Sources are env-configured so onboarding needs no code change: ALERT_SOURCES is a
// comma/space-separated list of source keys (defaulting to the single built-in
// `default`). For key `default` the credential pair is ALERT_SHARED_SECRET +
// ALERT_ALLOWED_IPS; for any other key `<k>` it is ALERT_SECRET_<K> + ALERT_IPS_<K>
// (key upper-cased, non-alphanumerics -> `_`). A source whose secret is unset is
// skipped, so a misconfigured key can never authenticate.

/** A resolved alert source: its key + the secret and raw IP list configured for it. */
interface AlertSource {
  key: string;
  secret: string;
  ipsRaw: string;
}

/** The Env var names holding a source key's secret + IP allowlist. */
function sourceVars(key: string): { secretVar: string; ipsVar: string } {
  if (key === "default") return { secretVar: "ALERT_SHARED_SECRET", ipsVar: "ALERT_ALLOWED_IPS" };
  // Normalize the key to an env-var suffix: upper-case, runs of non-alphanumerics
  // become a single "_", with none leading/trailing. Done via split+join (each char
  // consumed once) rather than an anchored `_+` replace, which backtracks on long
  // underscore runs (CodeQL js/polynomial-redos).
  const suffix = key.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).join("_");
  return { secretVar: `ALERT_SECRET_${suffix}`, ipsVar: `ALERT_IPS_${suffix}` };
}

/** Resolve the configured alert sources from env (keys from ALERT_SOURCES, else `default`). */
function alertSources(env: Env): AlertSource[] {
  const e = env as unknown as Record<string, string | undefined>;
  const keysRaw = (env.ALERT_SOURCES ?? "").trim();
  const keys = keysRaw ? keysRaw.split(/[\s,]+/).filter(Boolean) : ["default"];
  return keys.map((key) => {
    const { secretVar, ipsVar } = sourceVars(key);
    return { key, secret: String(e[secretVar] ?? ""), ipsRaw: String(e[ipsVar] ?? "") };
  });
}

/** The shared secret presented on the request: Bearer token first, then X-Alert-Key. */
function presentedSecret(request: Request): string {
  const auth = request.headers.get("Authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return (request.headers.get("X-Alert-Key") ?? "").trim();
}

/**
 * Length-checked constant-time compare (mirrors the admin-key check in index.ts):
 * once lengths match, the XOR-accumulate takes the same time regardless of where the
 * first byte differs, so it can't be used as a timing oracle.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i]! ^ eb[i]!;
  return diff === 0;
}

/** Split an IP allowlist string into exact IPs and CIDR ranges. */
function parseAllowlist(raw: string | undefined): { ips: Set<string>; cidrs: string[] } {
  const ips = new Set<string>();
  const cidrs: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    const e = entry.trim();
    if (!e) continue;
    if (e.includes("/")) cidrs.push(e);
    else ips.add(e);
  }
  return { ips, cidrs };
}

/**
 * True if the request IP falls in `ipsRaw`. Honors the shared ENFORCE_IP_ALLOWLIST
 * flag (an explicit "false"/"0"/"" disables enforcement, e.g. in tests); when
 * enforced, matches CF-Connecting-IP against the source's IPs/CIDRs. An absent header
 * fails closed.
 */
function ipAllowedForSource(request: Request, env: Env, ipsRaw: string): boolean {
  const raw = env.ENFORCE_IP_ALLOWLIST;
  if (raw !== undefined) {
    const flag = raw.trim().toLowerCase();
    if (flag === "false" || flag === "0" || flag === "") return true;
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (!ip) return false;
  const { ips, cidrs } = parseAllowlist(ipsRaw);
  return ips.has(ip) || cidrs.some((c) => ipInCidr(ip, c));
}

/** The result of authenticating a request against the configured sources. */
type AuthResult =
  | { ok: true; sourceKey: string }
  | { ok: false; status: 401 }
  | { ok: false; status: 403; sourceKey: string };

/**
 * Identify the source by its secret (constant-time, over ALL configured sources so the
 * match position isn't a timing oracle), THEN require the request IP to be in that
 * source's allowlist. No secret match -> 401; matched-but-wrong-IP -> 403.
 */
function authenticate(request: Request, env: Env): AuthResult {
  const presented = presentedSecret(request);
  let matched: AlertSource | null = null;
  for (const s of alertSources(env)) {
    if (!s.secret) continue; // unconfigured source can never authenticate
    if (constantTimeEqual(presented, s.secret)) matched = s; // no early break (timing)
  }
  if (!matched) return { ok: false, status: 401 };
  if (!ipAllowedForSource(request, env, matched.ipsRaw)) {
    return { ok: false, status: 403, sourceKey: matched.key };
  }
  return { ok: true, sourceKey: matched.key };
}

// --- validation -------------------------------------------------------------

const asString = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Validate + normalize the parsed body into an Alert, or return the first error. */
function validateAlert(parsed: unknown): { alert: Alert } | { error: string } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "body must be a JSON object" };
  }
  const o = parsed as Record<string, unknown>;
  for (const field of REQUIRED) {
    if (asString(o[field]).trim() === "") return { error: `missing required field: ${field}` };
  }
  const status = asString(o.status).trim().toLowerCase();
  if (!STATUSES.has(status)) {
    return { error: `unsupported status: ${status} (expected triggered, resolved, or heartbeat)` };
  }
  const severity = asString(o.severity).trim().toLowerCase();
  if (!SEVERITIES.has(severity)) {
    return { error: `unsupported severity: ${severity} (expected info, warning, or critical)` };
  }
  const details =
    o.details && typeof o.details === "object" && !Array.isArray(o.details)
      ? (o.details as Record<string, unknown>)
      : null;
  return {
    alert: {
      source: asString(o.source).trim(),
      host: asString(o.host).trim(),
      customer: asString(o.customer).trim(),
      monitor_id: asString(o.monitor_id).trim(),
      event_id: asString(o.event_id).trim(),
      dedupe_key: asString(o.dedupe_key).trim(),
      status,
      severity,
      title: asString(o.title).trim(),
      message: asString(o.message).trim(),
      timestamp: asString(o.timestamp).trim(),
      details,
    },
  };
}

// --- Gorelo mapping (native alerts: POST /v1/alerts/) -----------------------

/**
 * Map an alert severity to Gorelo's AlertLevel. Gorelo's level enum is FIXED (not
 * tenant-customizable), so the mapping is hardcoded rather than env-configurable:
 * 1 = Critical (confirmed against the Gorelo alerts UI), 3 = Warning, 4 = Info/Low.
 * (2 = Error/High is left for a future tier the relay doesn't emit.) The relay's three
 * input severities map to distinct, correctly-ordered levels — critical is the most
 * severe (1), info the least (4).
 */
function alertLevel(severity: string): AlertLevel {
  switch (severity) {
    case "critical":
      return 1; // Critical
    case "warning":
      return 3; // Warning
    default: // info
      return 4; // Info / Low
  }
}

const FIELD_MAX = 4000;
const truncate = (s: string): string =>
  s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}… [truncated ${s.length - FIELD_MAX} chars]` : s;

/** The alert `details` object rendered as plain `key: value` lines. */
function detailLines(details: Record<string, unknown> | null): string[] {
  if (!details) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(details)) {
    if (v == null || v === "") continue;
    out.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return out;
}

/**
 * Build the Gorelo alert Description (free text): the message, then the alert's
 * metadata and detail fields, so the alert carries full context. Plain text — the
 * alerts endpoint takes a description string, not HTML.
 */
function buildDescription(alert: Alert): string {
  const lines = [
    alert.message,
    "",
    `Monitor: ${alert.monitor_id}`,
    alert.source ? `Source: ${alert.source}` : "",
    alert.customer ? `Customer: ${alert.customer}` : "",
    alert.event_id ? `Event: ${alert.event_id}` : "",
    `Event time: ${alert.timestamp}`,
    `Dedupe key: ${alert.dedupe_key}`,
    ...detailLines(alert.details),
  ].filter((l) => l !== "");
  return truncate(lines.join("\n"));
}

/**
 * Resolve the Gorelo client an alert is raised against: an explicit ALERT_CLIENT_ID,
 * else the alert's `customer` matched by exact name in the client mirror, else the
 * alert's `host` matched to a mirrored device's client, else CATCHALL_CLIENT_ID.
 */
async function resolveClientId(env: Env, alert: Alert): Promise<number> {
  const explicit = Number(env.ALERT_CLIENT_ID);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  if (alert.customer) {
    const rows = await listClientRows(env.DB, alert.customer, 5);
    const want = alert.customer.trim().toLowerCase();
    const exact = rows.find((r) => (r.name ?? "").trim().toLowerCase() === want);
    if (exact) return exact.id;
  }

  const host = normalizeHost(alert.host);
  if (host) {
    const device = await findDeviceFullByHostname(env.DB, host);
    if (device?.client_id) return device.client_id;
  }

  return Number(env.CATCHALL_CLIENT_ID) || 0;
}

/** Build a Gorelo PostAlertRequest for an alert (optionally overriding name/severity/description). */
function buildAlertRequest(
  clientId: number,
  alert: Alert,
  overrides: Partial<PostAlertRequest> = {},
): PostAlertRequest {
  return {
    name: alert.title,
    clientId,
    resource: alert.host, // the host/service the alert is raised for
    severity: alertLevel(alert.severity),
    description: buildDescription(alert),
    ...overrides,
  };
}

// --- request handler --------------------------------------------------------

/** POST /v1/alerts — see the module doc. Always answers with the alert JSON contract. */
export async function handleAlert(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(`${JSON.stringify({ accepted: false, error: "method not allowed" }, null, 2)}\n`, {
      status: 405,
      headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
    });
  }

  // Two-factor gate: the presented secret identifies the source (401 if none matches),
  // then that source's own IP allowlist is enforced (403). A customer's secret is only
  // valid from that customer's IP(s).
  const auth = authenticate(request, env);
  if (!auth.ok) {
    if (auth.status === 401) {
      breadcrumb("ALERT rejected: no source secret matched");
      return errorResponse(401, "invalid shared secret");
    }
    breadcrumb(`ALERT rejected: source IP not allowed for source=${auth.sourceKey}`);
    return errorResponse(403, "source IP not allowed");
  }
  const sourceKey = auth.sourceKey;

  const raw = await request.text().catch(() => "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return errorResponse(400, "invalid JSON");
  }

  const result = validateAlert(parsed);
  if ("error" in result) return errorResponse(400, result.error);
  const alert = result.alert;

  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  // Idempotency identity for a repeated event: the explicit header, else event_id.
  const eventKey = (request.headers.get("Idempotency-Key") ?? "").trim() || alert.event_id || "";

  try {
    await initSchema(env.DB);
    const outcome = await applyAlert(env, alert, eventKey);
    logAlert(alert, ip, sourceKey, outcome);
    return jsonResponse(202, {
      accepted: true,
      action: outcome.action,
      dedupe_key: alert.dedupe_key,
    });
  } catch (err) {
    if (err instanceof GoreloError) {
      breadcrumb(`ALERT gorelo rejected dedupe=${alert.dedupe_key} status=${err.status}`);
      debug(env, `ALERT gorelo rejected dedupe=${alert.dedupe_key} status=${err.status} body=${err.body}`);
      return errorResponse(502, "Gorelo rejected the request or was unavailable", { dedupe_key: alert.dedupe_key });
    }
    const requestId = crypto.randomUUID();
    breadcrumb(`ALERT handler error dedupe=${alert.dedupe_key} id=${requestId} ${describeError(err)}`);
    return errorResponse(500, "unexpected worker error", { request_id: requestId });
  }
}

/** The result of applying an alert: the action taken + whether we posted to Gorelo. */
interface Outcome {
  action: "created" | "updated" | "resolved" | "heartbeat-recorded" | "duplicate-ignored";
  posted?: boolean; // true when this event posted an alert to Gorelo (for the audit log)
}

/** Apply the alert to our store + Gorelo per its status. May throw GoreloError. */
async function applyAlert(env: Env, alert: Alert, eventKey: string): Promise<Outcome> {
  const now = new Date().toISOString();

  if (alert.status === "heartbeat") {
    await recordHeartbeat(env.DB, {
      dedupe_key: alert.dedupe_key,
      monitor_id: alert.monitor_id,
      source: alert.source,
      host: alert.host,
      customer: alert.customer,
      last_seen: now,
    });
    return { action: "heartbeat-recorded" };
  }

  const existing = await getAlert(env.DB, alert.dedupe_key);
  const client = new GoreloClient(env);

  if (alert.status === "resolved") {
    // Nothing open to resolve -> idempotent success, no Gorelo call (spec).
    if (!existing || existing.status !== "open") return { action: "duplicate-ignored" };

    // Gorelo alerts are create-only (no close), so post a "Resolved: …" alert to
    // signal the clear, then mark our row resolved. The post is the gate: on failure
    // we leave the alert open so a retry re-posts.
    const clientId = await resolveClientId(env, alert);
    await client.postAlert(
      buildAlertRequest(clientId, alert, {
        name: `Resolved: ${existing.title || alert.title}`,
        description: `Resolved.\n\n${buildDescription(alert)}`,
      }),
    );
    await putAlert(env.DB, {
      ...existing,
      severity: alert.severity,
      message: alert.message,
      status: "resolved",
      last_event_id: eventKey || existing.last_event_id,
      updated_at: now,
      resolved_at: now,
    });
    return { action: "resolved", posted: true };
  }

  // status === "triggered"
  const open = existing && existing.status === "open" ? existing : null;
  if (open) {
    // Exact same event replayed -> ignore (idempotency). Otherwise fold the newer
    // message/severity into the open alert WITHOUT re-posting to Gorelo.
    if (eventKey && open.last_event_id === eventKey) {
      return { action: "duplicate-ignored" };
    }
    await putAlert(env.DB, {
      ...open,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      last_event_id: eventKey || open.last_event_id,
      updated_at: now,
    });
    return { action: "updated" };
  }

  // No open alert (new, or re-triggered after a resolve) -> post a fresh Gorelo alert.
  const clientId = await resolveClientId(env, alert);
  await client.postAlert(buildAlertRequest(clientId, alert));
  await putAlert(env.DB, {
    dedupe_key: alert.dedupe_key,
    monitor_id: alert.monitor_id,
    source: alert.source,
    host: alert.host,
    customer: alert.customer,
    severity: alert.severity,
    status: "open",
    title: alert.title,
    message: alert.message,
    gorelo_id: null,
    number: null,
    display_number: null,
    last_event_id: eventKey || null,
    created_at: now,
    updated_at: now,
    resolved_at: null,
  });
  return { action: "created", posted: true };
}

/**
 * Operational log line for an alert (audit trail). Logs the fields the spec asks for —
 * event time, source IP, host, monitor_id, dedupe_key, status, severity, action, and
 * whether we posted to Gorelo — and NEVER the shared secret.
 */
function logAlert(alert: Alert, ip: string, sourceKey: string, outcome: Outcome): void {
  breadcrumb(
    `ALERT ts=${alert.timestamp} ip=${ip || "?"} source=${sourceKey} host=${alert.host} ` +
      `monitor=${alert.monitor_id} dedupe=${alert.dedupe_key} status=${alert.status} ` +
      `severity=${alert.severity} action=${outcome.action} gorelo=${outcome.posted ? "posted" : "-"}`,
  );
}
