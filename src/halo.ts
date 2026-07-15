import {
  findContactByEmail,
  findDeviceFullByHostname,
  getAgentIdByAssetNum,
  getClientName,
  getContactById,
  getLastSync,
  initSchema,
  listClientRows,
  listLocationRows,
  putPendingTicket,
  searchContactRows,
  searchDeviceRows,
  takePendingTicket,
  takeStalePendingTickets,
  type ContactRow,
  type DeviceFullRow,
} from "./db.js";
import { notify } from "@ambersecurityinc/notifly";
import { GoreloClient, GoreloError, extractTicketNumber } from "./gorelo.js";
import { breadcrumb, debug, debugOn, describeError } from "./log.js";
import { normalizeEmail, normalizeHost } from "./parse.js";
import { assetNum, syncAll } from "./sync.js";
import { ipAllowed, matchProduct, type Product } from "./products.js";
import { haloPriority, haloStatus, haloTeam, haloTicketType } from "./haloShapes.js";
import { signToken, verifyTokenResult } from "./token.js";
import type {
  CreatePublicTicketCommand,
  Env,
  PublicDeviceResponse,
  PublicTicketPriority,
  TicketSource,
} from "./types.js";

/**
 * HaloPSA/HaloITSM mock — PHASE 2 (Gorelo-backed).
 *
 * Tier2's Halo integration authenticates via OAuth2 (client_credentials), then
 * hits the resource server to look up the customer/contact/site/asset before
 * creating the ticket. We answer those lookups from the Gorelo mirror (D1) so
 * Tier2 recognizes the user and routes to the right Gorelo client, then map the
 * ticket-create call back to a Gorelo ticket — packing as much data as possible
 * into the description.
 *
 * Cloud Hosted deployment: Tier2 sends `tenant+client_id:client_secret`; the token
 * endpoint tolerates the tenant (query or body) and the on-prem form too. Every
 * request is logged with a `HALO CAPTURE` prefix (secrets redacted) so the exact
 * request/response shapes can be refined against real traffic.
 */

const HALO_UNREGISTERED_EMAIL = "unregistered@helpdeskbuttons.com";
// Synthetic id for the unregistered catch-all user. Non-zero (Halo user ids are
// positive) and high enough not to collide with a real Gorelo contact id; on
// ticket create it resolves to no contact -> catch-all client.
const HALO_UNREGISTERED_USER_ID = 999_999_999;

// Tier2 sends this header on every Halo request — the most reliable discriminator.
export const HALO_HEADER = "halo-app-name";

// Known Halo resource names (singular + plural). Tier2 calls these WITHOUT the
// standard `/api/` prefix and lowercased (e.g. `GET /users`, `POST /tickets`),
// so we route on the normalized resource name rather than the exact path.
const HALO_RESOURCES = new Set([
  "token",
  "users",
  "client",
  "clients",
  "site",
  "sites",
  "asset",
  "assets",
  "ticket",
  "tickets",
  "action",
  "actions",
  "tickettype",
  "tickettypes",
  "status",
  "statuses",
  "team",
  "teams",
  "priority",
  "priorities",
  "agent",
  "agents",
]);

/** Last non-numeric path segment, lowercased: `/api/Users/123` -> `users`, `/token` -> `token`. */
export function haloResource(pathname: string): string {
  const segs = pathname
    .split("/")
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  while (segs.length && /^\d+$/.test(segs[segs.length - 1]!)) segs.pop();
  return segs.length ? segs[segs.length - 1]! : "";
}

/** Trailing numeric path segment — Halo's `/Client/{id}` etc. — or null. */
export function trailingId(pathname: string): number | null {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "";
  return /^\d+$/.test(seg) ? Number(seg) : null;
}

/** Fallback path matcher (primary routing is the halo-app-name header). */
export function isHaloPath(pathname: string): boolean {
  return pathname === "/auth/token" || HALO_RESOURCES.has(haloResource(pathname));
}

/** True if this request is a Halo call (header first, then path shape). */
export function isHaloRequest(request: Request, pathname: string): boolean {
  // `/admin/*` and `/health` are handled explicitly by the fetch router and must
  // NOT fall through to the IP-gated Halo mock — some admin paths collide with a
  // Halo resource name (e.g. `/admin/status` normalizes to the `status` resource),
  // which otherwise routes an admin call into Halo and rejects it on the IP
  // allowlist. Unknown paths here should 404, not masquerade as Halo.
  if (pathname.startsWith("/admin/") || pathname === "/health") return false;
  return request.headers.get(HALO_HEADER) != null || isHaloPath(pathname);
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Verbose logging (full request/response bodies) carries PII/PHI — the report
// includes names, emails, phones — so it's OFF unless DEBUG_LOGS is enabled
// (see src/log.ts). Operational breadcrumbs (ids only, errors) are always emitted.

function safeHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const key = k.toLowerCase();
    out[key] = key === "authorization" || key === "cookie" ? "<redacted>" : v;
  }
  return out;
}

/** Read the request body (always) and, only when DEBUG_LOGS is on, log the full capture. */
async function logCapture(request: Request, url: URL, env: Env): Promise<string> {
  let body = "";
  try {
    // Decode via arrayBuffer (works for JSON + form bodies without the workerd
    // "text() on non-text body" warning that would clutter the capture logs).
    const buf = await request.clone().arrayBuffer();
    body = new TextDecoder().decode(buf);
  } catch {
    body = "<unreadable>";
  }
  if (debugOn(env)) {
    const redacted = body.replace(/(client_secret|password|secret)=([^&\s]+)/gi, "$1=<redacted>");
    debug(
      env,
      `HALO CAPTURE ${request.method} ${url.pathname}${url.search} ` +
        `headers=${JSON.stringify(safeHeaders(request))} body=${redacted.slice(0, 2000)}`,
    );
  } else {
    // Non-PII breadcrumb: method + path only (search params can carry emails).
    breadcrumb(`HALO ${request.method} ${url.pathname}`);
  }
  return body;
}

// --- OAuth token ------------------------------------------------------------

// Lifetime of a minted bearer token, echoed as `expires_in` and baked into the
// signed token's `exp` claim.
const TOKEN_TTL_SECONDS = 3600;

/**
 * Classify the inbound bearer token for the enforcement gate (audit F1):
 * `missing` (no bearer header), `invalid` (bad signature/shape), `expired`, or
 * `present` (valid & unexpired). Keyed by HALO_CLIENT_SECRET — no separate secret.
 */
async function bearerTokenStatus(
  request: Request,
  secret: string,
): Promise<"present" | "missing" | "invalid" | "expired"> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token) return "missing";
  const r = await verifyTokenResult(secret, token);
  return r.ok ? "present" : r.reason;
}

async function parseKeyValues(body: string, contentType: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(body) as Record<string, unknown>)) {
        out[k] = String(v ?? "");
      }
    } catch {
      /* ignore */
    }
  } else {
    for (const [k, v] of new URLSearchParams(body).entries()) out[k] = v;
  }
  return out;
}

async function handleToken(request: Request, env: Env, url: URL, body: string): Promise<Response> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  const params = await parseKeyValues(body, ct);
  const clientId = params.client_id ?? "";
  const tenant = params.tenant ?? url.searchParams.get("tenant") ?? "";
  debug(env, `HALO token grant=${params.grant_type ?? ""} tenant=${tenant} client_id=${clientId}`);

  const credsSet = Boolean(env.HALO_CLIENT_ID && env.HALO_CLIENT_SECRET);
  if (credsSet) {
    if (clientId !== env.HALO_CLIENT_ID || params.client_secret !== env.HALO_CLIENT_SECRET) {
      return jsonResponse(401, { error: "invalid_client" });
    }
  }
  // With credentials set and validated, mint a signed HMAC token (keyed by
  // HALO_CLIENT_SECRET) that the resource gate can verify (audit F1). With
  // credentials unset, keep the legacy opaque token so nothing breaks.
  const token = credsSet
    ? await signToken(env.HALO_CLIENT_SECRET!, { exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS })
    : crypto.randomUUID().replace(/-/g, "");
  return jsonResponse(200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_SECONDS,
    scope: params.scope ?? "all",
  });
}

// --- Lookups (GET) ----------------------------------------------------------

/** Honor Halo's `page_size` (bounded), defaulting to the prior 100-row cap when absent. */
function pageSize(url: URL, fallback = 100, max = 5000): number {
  const n = Number(url.searchParams.get("page_size"));
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

/**
 * Halo's `*_View` list envelope: `{ page_no, page_size, record_count, columns, <items> }`.
 * A paginating Halo client (Huntress) reads page_no/page_size back to drive its loop,
 * so every wrapped list endpoint (Client/Site/Asset/Users) must echo them — omitting
 * them was what crashed Huntress on /Client. `extra` carries the entity array (e.g.
 * `{ clients }`) plus its `record_count` and any endpoint-specific arrays.
 */
function listEnvelope(url: URL, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    page_no: Number(url.searchParams.get("page_no")) || 1,
    page_size: pageSize(url),
    columns: [],
    ...extra,
  };
}

/** Grab the search term Tier2 sent (Halo uses `search`; also accept an email-ish param). */
function searchTerm(url: URL): string {
  const s = url.searchParams.get("search");
  if (s) return s;
  for (const [, v] of url.searchParams.entries()) if (v.includes("@")) return v;
  return "";
}

function splitName(name: string, email: string): { first: string; last: string } {
  const n = (name || email.split("@")[0] || "").trim();
  const parts = n.split(/\s+/);
  return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/** Map a Gorelo contact to a Halo user object (fuller shape for Tier2's parser). */
async function haloUserFromContact(
  db: D1Database,
  c: { id: number; email: string; name: string; client_id: number; site_id: number },
): Promise<Record<string, unknown>> {
  const clientName = (await getClientName(db, c.client_id)) ?? "";
  const { first, last } = splitName(c.name, c.email);
  return {
    id: c.id,
    name: c.name || c.email,
    firstname: first,
    surname: last,
    emailaddress: c.email,
    email: c.email,
    client_id: c.client_id,
    client_name: clientName,
    site_id: c.site_id,
    site_name: "",
    inactive: false,
    isserviceaccount: false,
    use: "user",
  };
}

async function handleUsers(env: Env, url: URL): Promise<Response> {
  const term = searchTerm(url);
  const email = normalizeEmail(term);

  // The catch-all "unregistered" user Tier2 falls back to for unknown submitters.
  if (email === HALO_UNREGISTERED_EMAIL) {
    const user = await haloUserFromContact(env.DB, {
      id: HALO_UNREGISTERED_USER_ID,
      email: HALO_UNREGISTERED_EMAIL,
      name: "Unregistered",
      client_id: Number(env.CATCHALL_CLIENT_ID),
      site_id: 0,
    });
    return jsonResponse(200, listEnvelope(url, { record_count: 1, users: [user], user_ids: [] }));
  }

  const rows = email.includes("@")
    ? [await findContactByEmail(env.DB, email)].filter((r): r is ContactRow => r != null)
    : await searchContactRows(env.DB, term);
  const users = await Promise.all(
    rows.map((r) =>
      haloUserFromContact(env.DB, {
        id: r.id,
        email: r.email ?? "",
        name: r.name ?? "",
        client_id: r.client_id ?? 0,
        site_id: r.location_id ?? 0,
      }),
    ),
  );
  return jsonResponse(200, listEnvelope(url, { record_count: users.length, users, user_ids: [] }));
}

/** One Halo "client" (Area_List-ish) object — the fields our list already exposes. */
function clientObject(id: number, name: string): Record<string, unknown> {
  return { id, name, colour: "", inactive: false, toplevel_id: 0, toplevel_name: "", use: "client" };
}

/**
 * GET /Client/{id} — Halo returns a SINGLE Area object here (not the list envelope
 * /Client returns). Huntress fetches its configured/catch-all client this way and
 * reads fields off the object directly, so returning the list crashes it. Resolve
 * the name from the mirror; synthesize a bare object if the id isn't mirrored (e.g.
 * the catch-all client) rather than 404, so a saved config reference still loads.
 */
async function handleClientById(env: Env, id: number): Promise<Response> {
  const name = (await getClientName(env.DB, id)) ?? "";
  return jsonResponse(200, clientObject(id, name));
}

async function handleClient(env: Env, url: URL): Promise<Response> {
  const rows = await listClientRows(env.DB, searchTerm(url), pageSize(url));
  // Fuller Halo "client" (Area_List) shape. Tier2's parser was happy with
  // { id, name }, but a stricter Halo client (e.g. Huntress) deserializes each row
  // into a typed model and needs the standard fields present. Extra fields are
  // ignored by simpler consumers, so this stays backward-compatible.
  const clients = rows.map((c) => clientObject(c.id, c.name ?? ""));
  // Envelope mirrors Halo's Area_View (docs/halo-swagger.v2.json).
  return jsonResponse(200, listEnvelope(url, { record_count: clients.length, clients }));
}

async function handleSite(env: Env, url: URL): Promise<Response> {
  const clientIdParam = url.searchParams.get("client_id");
  const clientId = clientIdParam ? Number(clientIdParam) : undefined;
  const rows = await listLocationRows(
    env.DB,
    Number.isFinite(clientId) ? clientId : undefined,
    searchTerm(url),
  );
  const sites = rows.map((l) => ({ id: l.id, name: l.name ?? "", client_id: l.client_id ?? 0 }));
  return jsonResponse(200, listEnvelope(url, { record_count: sites.length, sites }));
}

async function handleAsset(env: Env, url: URL): Promise<Response> {
  const clientIdParam = url.searchParams.get("client_id");
  const clientId = clientIdParam ? Number(clientIdParam) : undefined;
  const rows = await searchDeviceRows(
    env.DB,
    searchTerm(url),
    Number.isFinite(clientId) ? clientId : undefined,
  );
  const assets = rows.map((d) => ({
    id: d.asset_num ?? 0,
    inventory_number: d.hostname ?? d.display_name ?? "",
    key_field: d.hostname ?? d.display_name ?? "",
    client_id: d.client_id ?? 0,
    site_id: d.location_id ?? 0,
    inactive: false,
  }));
  return jsonResponse(200, listEnvelope(url, { record_count: assets.length, assets }));
}

/**
 * Config lookup lists. Halo returns these as BARE ARRAYS of full objects (no
 * envelope, unlike /Client). Each item is the full Halo shape (src/haloShapes.ts,
 * derived from the swagger) so a strict client's editor can't hit an undefined
 * field or filter the list to empty. These are picker options only — ticket
 * creation still uses the DEFAULT_* ids from wrangler.toml.
 */
function handleConfig(env: Env, resource: string): Response {
  switch (resource) {
    case "tickettype":
    case "tickettypes":
      return jsonResponse(200, [haloTicketType(Number(env.DEFAULT_TYPE_ID), "Incident")]);
    case "status":
    case "statuses":
      // A realistic open->closed spread (not just "New"): a PSA editor maps a
      // "new" AND a "closed/resolved" status, and a single status crashes the
      // closed-side lookup. type: 0=open, 1=pending, 2=closed; intent mirrors it.
      // Creation still uses DEFAULT_STATUS_ID; these are picker options.
      return jsonResponse(200, [
        haloStatus(Number(env.DEFAULT_STATUS_ID) || 1, "New", 0, "open"),
        haloStatus(2, "In Progress", 0, "open"),
        haloStatus(3, "Resolved", 2, "closed"),
        haloStatus(4, "Closed", 2, "closed"),
      ]);
    case "team":
    case "teams":
      return jsonResponse(200, [haloTeam(Number(env.DEFAULT_GROUP_ID), "Everyone")]);
    case "priority":
    case "priorities":
      return jsonResponse(200, [
        haloPriority(1, "Critical"),
        haloPriority(2, "High"),
        haloPriority(3, "Medium"),
        haloPriority(4, "Low"),
      ]);
    case "agent":
    case "agents":
      return jsonResponse(200, { agents: [], record_count: 0, page_no: 1, page_size: 100 });
    default:
      return jsonResponse(200, []);
  }
}

// --- Ticket create (POST /tickets) + note (POST /actions) -------------------

type HaloTicket = Record<string, unknown>;

function firstTicket(parsed: unknown): HaloTicket {
  if (Array.isArray(parsed)) return (parsed[0] ?? {}) as HaloTicket;
  if (parsed && typeof parsed === "object") return parsed as HaloTicket;
  return {};
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

// Deferred-create grace: how long a queued /tickets command waits for its
// /actions note before the cron orphan-flush creates it note-less. Tier2 posts
// the action ~1s after the ticket, so this is a generous safety margin.
const PENDING_GRACE_MS = 5 * 60 * 1000;
// Give up on a queued ticket after this many failed Gorelo create attempts, so a
// permanently-rejected command can't be retried forever (dead-letter -> logged + dropped).
const MAX_PENDING_ATTEMPTS = 5;

const nowIso = (): string => new Date().toISOString();

// --- HTML report parsing ----------------------------------------------------
// Tier2 files every press under the hardcoded `unregistered@helpdeskbuttons.com`
// user (-> our synthetic id + catch-all client). The REAL reporter identity is
// only in the "Report Summary" table inside details_html, so we parse it out to
// resolve the actual Gorelo contact/company/asset.

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}
function decodeEntities(s: string): string {
  // Decode `&amp;` LAST: doing it first would let a literal `&lt;` (written
  // `&amp;lt;`) collapse to `<` on a later pass — a double-unescape. By the
  // time `&amp;` runs, no other rule can re-interpret the `&`s it produces.
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}
function htmlToText(s: string): string {
  // Drop non-content blocks first — a full HTML email (the /actions note) carries
  // <head>/<style> with @font-face/@media rules that otherwise flatten into noise.
  // Match end tags tolerantly (`</script >`, `</script\t\n bar>`): a browser
  // closes on `</script` followed by anything up to the next `>`, so a naive
  // `</script>` would leave the block's contents behind to flatten into the
  // extracted text. `[^>]*>` consumes any trailing junk before the `>`.
  const stripped = s
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<head[\s\S]*?<\/head[^>]*>/gi, " ");
  return decodeEntities(stripTags(stripped))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Extract the `<td>Label:</td><td>Value</td>` pairs from the report table. */
function parseReport(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!html) return out;
  const re = /<td[^>]*>\s*([^<:]+?)\s*:\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = m[1]!.trim().toLowerCase();
    const value = decodeEntities(stripTags(m[2]!)).trim();
    if (label && value && !(label in out)) out[label] = value;
  }
  return out;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** The reporter email: the labeled report field first, else the first non-catch-all address. */
function reportEmail(report: Record<string, string>, html: string): string {
  const labeled = normalizeEmail(report.email ?? "");
  if (labeled.includes("@") && labeled !== HALO_UNREGISTERED_EMAIL) return labeled;
  for (const m of html.matchAll(EMAIL_RE)) {
    const e = normalizeEmail(m[0]);
    if (e && e !== HALO_UNREGISTERED_EMAIL) return e;
  }
  return "";
}

/** Pull the requester email out of the explicit fields Halo/Tier2 might use. */
function requesterEmail(t: HaloTicket): string {
  for (const k of ["emailfrom", "reportedby", "emailaddress", "email", "useremail", "contactemail"]) {
    const v = normalizeEmail(str(t[k]));
    if (v.includes("@")) return v;
  }
  return "";
}

/** Map the asset ids Tier2 sends (our numeric surrogates) back to Gorelo agent UUIDs. */
async function resolveAssetUuids(db: D1Database, t: HaloTicket): Promise<string[]> {
  const ids: number[] = [];
  for (const key of ["assets", "asset_id", "assetid", "asset"]) {
    const v = t[key];
    if (typeof v === "number") ids.push(v);
    else if (Array.isArray(v)) {
      for (const a of v) {
        if (typeof a === "number") ids.push(a);
        else if (a && typeof a === "object") {
          const n = num((a as Record<string, unknown>).id);
          if (n != null) ids.push(n);
        }
      }
    } else if (v != null) {
      const n = num(v);
      if (n != null) ids.push(n);
    }
  }
  const uuids: string[] = [];
  for (const n of ids) {
    const uuid = await getAgentIdByAssetNum(db, n);
    if (uuid && !uuids.includes(uuid)) uuids.push(uuid);
  }
  return uuids;
}

/** The client/site the first asset object carries (Tier2 includes these on the create). */
function firstAssetRouting(t: HaloTicket): { clientId: number | null; siteId: number | null } {
  const a = Array.isArray(t.assets) ? t.assets[0] : t.assets;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    return { clientId: num(o.client_id), siteId: num(o.site_id) };
  }
  return { clientId: null, siteId: null };
}

/** Resolved Gorelo routing for a press. */
interface Routing {
  clientId: number;
  locationId: number | null;
  contactId: number | null;
  contactName: string;
  agentAssetIds: string[];
  email: string;
  hostname: string;
  assetMatched: boolean;
  isEmergency: boolean;
  device: DeviceFullRow | null;
  agentDetail: PublicDeviceResponse | null;
  report: Record<string, string>;
}

async function resolveRouting(env: Env, t: HaloTicket, product: Product | null): Promise<Routing> {
  const html = str(t.details_html) || str(t.details);
  const report = parseReport(html);
  const email = requesterEmail(t) || reportEmail(report, html);
  const hostname = normalizeHost(report.hostname ?? "");

  // Contact: a real user_id first (the synthetic unregistered id resolves to
  // nothing), then the reporter email parsed from the report.
  let contact: ContactRow | null = null;
  const uid = num(t.user_id);
  if (uid && uid !== HALO_UNREGISTERED_USER_ID) contact = await getContactById(env.DB, uid);
  if (!contact && email) contact = await findContactByEmail(env.DB, email);

  // Device by hostname (from the report) — the agent asset link, a client/location
  // fallback, and extra hardware detail for the ticket. Tier2 looks the asset up
  // separately but does NOT send it on create, so we re-resolve here: exact
  // hostname first, then the same fuzzy match the /asset lookup uses (the stored
  // hostname can be a display-name/serial variant of what the report shows).
  let device: DeviceFullRow | null = null;
  if (hostname) {
    device = await findDeviceFullByHostname(env.DB, hostname);
    if (!device) {
      const [fuzzy] = await searchDeviceRows(env.DB, hostname, undefined, 1);
      device = fuzzy ?? null;
    }
  }

  // The asset object Tier2 sends on the create carries its own client_id/site_id
  // (its Gorelo location) — a good location source when Tier2's own site_id is 0.
  const asset = firstAssetRouting(t);

  const bodyClient = num(t.client_id);
  const isCatchall = bodyClient === Number(env.CATCHALL_CLIENT_ID);
  // Most specific signal wins: matched contact, matched device, the asset's own
  // client, a NON-catch-all client Tier2 sent, then whatever remains (catch-all).
  const clientId =
    contact?.client_id ??
    device?.client_id ??
    asset.clientId ??
    (bodyClient && !isCatchall ? bodyClient : null) ??
    bodyClient ??
    Number(env.CATCHALL_CLIENT_ID);
  // Location from the contact, the matched device, or the asset's site (Tier2's own
  // site_id is often 0). Asset location fills in the ticket's site when nothing else does.
  const locationId =
    contact?.location_id ?? device?.location_id ?? asset.siteId ?? num(t.site_id) ?? null;
  const contactId = contact?.id ?? null;

  const agentAssetIds = await resolveAssetUuids(env.DB, t);
  if (device?.agent_id && !agentAssetIds.includes(device.agent_id)) agentAssetIds.push(device.agent_id);

  // Pull the full agent record (cpu/memory/model/OS/last-user) from Gorelo so the
  // ticket shows the machine detail HDB keeps behind its portal link. Best-effort.
  const agentDetail = device?.agent_id ? await new GoreloClient(env).getAgent(device.agent_id) : null;

  const contactName =
    contact?.name || report.name || email || product?.ticketCreatedBy || "Helpdesk Buttons";
  // A press flagged as an emergency bumps the ticket priority.
  const isEmergency = /this is an emergency/i.test(html);

  // Operational routing breadcrumb — no raw email or hostname (both PII: a hostname
  // can embed a username). Presence-only flags here; the values go behind DEBUG_LOGS.
  breadcrumb(
    `HALO routing: emailMatch=${email ? "y" : "n"} host=${hostname ? "y" : "n"} ` +
      `contact=${contactId ?? "MISS"} device=${device ? "hit" : "miss"} assets=${agentAssetIds.length} ` +
      `emergency=${isEmergency ? "y" : "n"} -> client=${clientId} location=${locationId ?? "none"} ` +
      `(assetSite=${asset.siteId ?? "none"})`,
  );
  if (email) debug(env, `HALO routing email=${email}`);
  if (hostname) debug(env, `HALO routing hostname=${hostname}`);

  return {
    clientId,
    locationId,
    contactId,
    contactName,
    agentAssetIds,
    email,
    hostname,
    assetMatched: agentAssetIds.length > 0,
    isEmergency,
    device,
    agentDetail,
    report,
  };
}

const FIELD_MAX = 2000; // cap any single extra field so one value can't bloat the ticket
const BODY_MAX = 16000; // generous cap on the whole report body — keep everything, guard only pathological blobs

function truncate(s: string, max = FIELD_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

// Fields we already surface elsewhere (report body, device line, routing trail, or
// dedicated handling), so they don't need to appear again in the raw-fields dump.
const DUMP_SKIP = new Set([
  "details_html",
  "details",
  "summary",
  "subject",
  "note_html",
  "note",
  "user_id",
  "client_id",
  "site_id",
  "tickettype_id",
  "assets",
]);

// Gorelo renders the ticket description as HTML (plain newlines collapse), so the
// body is built as HTML: section headers, <br> line breaks, bulleted selections,
// and clickable links. All text values are escaped before interpolation.
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const heading = (title: string): string => `<b>${esc(title)}</b>`;

/** Ordered label/value pairs from the report table, original casing preserved. */
function parseReportPairs(html: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const re = /<td[^>]*>\s*([^<:]+?)\s*:\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = m[1]!.trim();
    const value = decodeEntities(stripTags(m[2]!)).replace(/\s+/g, " ").trim();
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** Split the Selections value cell into individual items (handles <br>/list markup). */
function extractSelectionItems(html: string): string[] {
  const m = /Selections\s*:?\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  if (!m) return [];
  return m[1]!
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr)\s*>/gi, "\n")
    .split("\n")
    .map((s) => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Default HDB selections (every press has them) — removed as substrings so they go
// whether the report lists them separately or concatenated into one string.
const DEFAULT_SELECTION_RES = [
  /connect directly to my computer as soon as (?:available|possible)/gi,
  /this affects only me/gi,
];
function cleanSelection(item: string): string {
  let out = item;
  for (const re of DEFAULT_SELECTION_RES) out = out.replace(re, "");
  return out.replace(/\s{2,}/g, " ").replace(/^[\s;,.·•-]+|[\s;,.·•-]+$/g, "").trim();
}

/** The non-default selections a user actually chose (empty if only defaults). */
function chosenSelections(html: string, pairs: Array<{ label: string; value: string }>): string[] {
  let items = extractSelectionItems(html);
  if (!items.length) {
    const pair = pairs.find((p) => p.label.toLowerCase() === "selections");
    if (pair) items = [pair.value];
  }
  return items.map(cleanSelection).filter(Boolean);
}

const nonEmpty = (v: unknown): string => (v == null ? "" : String(v).trim());
/** Join present parts with " · ", escaped. */
function dot(parts: unknown[]): string {
  return parts
    .map(nonEmpty)
    .filter(Boolean)
    .map((s) => esc(s))
    .join(" · ");
}
/** Offset (ms) of an IANA time zone from UTC at a given instant. */
function tzOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  const asUtc = Date.UTC(f.year!, (f.month ?? 1) - 1, f.day!, f.hour ?? 0, f.minute ?? 0, f.second ?? 0);
  return asUtc - instant;
}

/**
 * A Gorelo ISO timestamp as a coarse relative age, e.g. "13 hours ago", "7 days ago".
 * Gorelo sends timezone-naive timestamps that are wall-clock in the agent's `tz`; if a
 * tz is given we resolve the real instant through it, else we fall back to UTC.
 */
function relativeTime(iso: string, tz?: string | null): string {
  if (!iso) return "";
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(iso);
  let t: number;
  if (hasTz) {
    t = Date.parse(iso);
  } else {
    const asUtc = Date.parse(`${iso}Z`); // wall time read as if UTC
    if (!Number.isFinite(asUtc)) return "";
    // Subtract the zone's offset at that wall time to get the true instant.
    let offset = 0;
    if (tz) {
      try {
        offset = tzOffsetMs(asUtc, tz);
      } catch {
        offset = 0; // unknown zone — treat as UTC
      }
    }
    t = asUtc - offset;
  }
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const suffix = diff >= 0 ? "ago" : "from now";
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 1) return "just now";
  const units: Array<[number, string]> = [
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = mins;
  for (const [factor, name] of units) {
    if (value < factor) return `${value} ${name}${value === 1 ? "" : "s"} ${suffix}`;
    value = Math.round(value / factor);
  }
  return `${value} years ${suffix}`;
}

/**
 * The "Device" section — rich hardware/OS detail from the live Gorelo agent record
 * (falling back to the mirror row). This is data HDB keeps behind its portal link.
 */
function deviceSection(agent: PublicDeviceResponse | null, d: DeviceFullRow | null): string {
  const name = nonEmpty(agent?.displayName) || nonEmpty(agent?.name) || nonEmpty(d?.display_name) || nonEmpty(d?.hostname);
  const os = nonEmpty(agent?.osName) || nonEmpty(agent?.os) || nonEmpty(d?.os);
  const serial = nonEmpty(agent?.serialNo) || nonEmpty(d?.serial);
  const localIp = nonEmpty(agent?.localIPAddress) || nonEmpty(d?.local_ip);
  const pubIp = nonEmpty(agent?.publicIPAddress) || nonEmpty(d?.public_ip);
  if (!name && !serial && !localIp) return "";

  const mem = nonEmpty(agent?.memory) ? `${nonEmpty(agent?.memory)} GB RAM` : "";
  const model = dot([agent?.manufacturer, agent?.model]);
  const lastUser = nonEmpty(agent?.lastLoggedOnUserUpn) || nonEmpty(agent?.lastLoggedOnUser);
  const lastBoot = relativeTime(nonEmpty(agent?.lastBootUpTime), agent?.timeZone);

  const lines = [
    dot([name, os, agent?.osVersion]),
    dot([model, agent?.hardwareArchitecture, agent?.cpu, mem]),
    dot([serial ? `SN ${serial}` : "", localIp ? `Local IP ${localIp}` : "", pubIp ? `Public IP ${pubIp}` : ""]),
    dot([lastUser ? `Last user ${lastUser}` : "", lastBoot ? `Last boot ${lastBoot}` : ""]),
  ].filter(Boolean);
  return lines.length ? `${heading("Device")}<br>${lines.join("<br>")}` : "";
}

/** Any remaining top-level fields Tier2 sent (beyond what we surface elsewhere). */
function extraFieldLines(t: HaloTicket): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (DUMP_SKIP.has(k) || v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`${esc(k)}: ${esc(truncate(rendered))}`);
  }
  return lines;
}

/** Build the ticket description as HTML: report + extra fields + device + routing. */
function buildHaloDescription(t: HaloTicket, routing: Routing, product: Product | null): string {
  const raw = str(t.details_html) || str(t.details) || str(t.summary);
  const sections: string[] = [];

  // Body section — one line per report field (non-default selections as bullets) for
  // Tier2's HDB report, or the plain details for a product that sends free text. The
  // heading follows the product (Tier2 "Report Summary", else e.g. "Details").
  const pairs = parseReportPairs(raw);
  const rows = pairs
    .filter((p) => p.label.toLowerCase() !== "selections")
    .map((p) => `${esc(p.label)}: ${esc(truncate(p.value))}`);
  const sels = chosenSelections(raw, pairs);
  if (sels.length) {
    rows.push(`Selections:<br>${sels.map((s) => `&nbsp;&bull; ${esc(s)}`).join("<br>")}`);
  }
  const report = rows.length
    ? rows.join("<br>")
    : esc(truncate(htmlToText(raw), BODY_MAX)).replace(/\n/g, "<br>");
  sections.push(`${heading(product?.ticketBodyHeading || "Report Summary")}<br>${report}`);

  // Any other submitted fields (rarely present after trimming the routing ids).
  const extras = extraFieldLines(t);
  if (extras.length) sections.push(`${heading("Other fields")}<br>${extras.join("<br>")}`);

  // Device hardware (rich detail from the live Gorelo agent record).
  const dev = deviceSection(routing.agentDetail, routing.device);
  if (dev) sections.push(dev);

  // (Routing outcome — client/contact/location/asset — is logged, not shown in the
  // ticket; the asset is already attached as a real Gorelo asset.)
  return sections.join("<br><br>");
}

/**
 * Extract the report/remote links HDB embeds in the /actions note. HDB hosts the
 * full report (screenshots, diagnostic data) and the remote-connect session on its
 * own portal and only sends hyperlinks — Gorelo has no attachment API, so surfacing
 * these links in the ticket is how a tech reaches the screenshots/diag/remote.
 */
function extractNoteLinks(html: string): Array<{ label: string; href: string }> {
  const out: Array<{ label: string; href: string }> = [];
  const seen = new Set<string>();
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = decodeEntities(m[1]!).trim();
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const label = htmlToText(m[2]!).trim() || "Link";
    out.push({ label, href });
  }
  return out;
}

function buildTicketCommand(
  env: Env,
  t: HaloTicket,
  routing: Routing,
  product: Product | null,
): CreatePublicTicketCommand {
  const summary = str(t.summary) || str(t.subject) || "(no subject)";
  const tagId = num(env.HDB_TAG_ID);
  // "This is an emergency" bumps the priority (when EMERGENCY_PRIORITY is set).
  const emergencyId = num(env.EMERGENCY_PRIORITY);
  const priorityId = (routing.isEmergency && emergencyId ? emergencyId : Number(env.DEFAULT_PRIORITY)) as PublicTicketPriority;
  return {
    title: summary,
    createdByName: routing.contactName,
    clientId: routing.clientId,
    locationId: routing.locationId,
    contactId: routing.contactId,
    description: buildHaloDescription(t, routing, product),
    statusId: Number(env.DEFAULT_STATUS_ID),
    groupId: Number(env.DEFAULT_GROUP_ID),
    typeId: Number(env.DEFAULT_TYPE_ID),
    priorityId,
    sourceId: Number(env.DEFAULT_SOURCE) as TicketSource,
    tagIds: tagId ? [tagId] : undefined,
    agentAssetIds: routing.agentAssetIds,
    // Only let Gorelo email the requester when SEND_TICKET_CREATED_EMAIL is on AND we
    // matched a real contact — otherwise the ticket lands on the catch-all client with
    // no (or the wrong) contact, and an auto-email would notify nobody useful.
    sendTicketCreatedEmail: env.SEND_TICKET_CREATED_EMAIL === "true" && routing.contactId != null,
  };
}

/**
 * POST /tickets — Tier2 creates the ticket, then POSTs the report/notification as
 * a separate /actions note. Gorelo has no ticket-append endpoint, so we DON'T
 * create the Gorelo ticket yet: we build the command, queue it keyed by the Halo
 * id we return, and let the /actions note fold in before the create. An orphan
 * flush (cron + opportunistic) creates any ticket whose note never arrives.
 */
/** Echo a Halo-shaped created ticket (the 201 Faults object) so the caller can correlate. */
function haloCreatedTicket(env: Env, haloId: number, cmd: CreatePublicTicketCommand, t: HaloTicket, routing: Routing): Response {
  return jsonResponse(201, {
    id: haloId,
    summary: cmd.title,
    details: str(t.details),
    client_id: routing.clientId,
    site_id: routing.locationId ?? 0,
    user_id: routing.contactId ?? 0,
    tickettype_id: Number(env.DEFAULT_TYPE_ID),
    status_id: Number(env.DEFAULT_STATUS_ID),
  });
}

async function handleCreateTicket(
  env: Env,
  ctx: ExecutionContext | undefined,
  body: string,
  product: Product | null,
): Promise<Response> {
  const t = firstTicket(parseJson(body));
  const routing = await resolveRouting(env, t, product);
  const cmd = buildTicketCommand(env, t, routing, product);
  const haloId = assetNum(crypto.randomUUID()) || Date.now() % 1_000_000_000_000;

  // One-shot products (deferCreate=false, e.g. Huntress) send the whole ticket here
  // and never follow up with a /actions note, so there is nothing to fold in — create
  // the Gorelo ticket immediately. On failure, fall back to the pending queue so the
  // orphan flush retries it (same resilience as the deferred path below).
  if (product && !product.deferCreate) {
    try {
      const raw = await new GoreloClient(env).createTicket(cmd);
      const uuid = extractTicketNumber(raw) ?? "";
      breadcrumb(
        `HALO created gorelo ticket ${uuid} immediately (product=${product.key} halo_id=${haloId} ` +
          `client=${routing.clientId} contact=${routing.contactId} email=${cmd.sendTicketCreatedEmail ? "y" : "n"})`,
      );
    } catch (err) {
      await putPendingTicket(env.DB, haloId, JSON.stringify(cmd), nowIso());
      breadcrumb(
        `HALO immediate create failed (product=${product.key} halo_id=${haloId}), queued for retry: ${describeError(err)}`,
      );
    }
    return haloCreatedTicket(env, haloId, cmd, t, routing);
  }

  // Tier2 two-step flow: DON'T create yet. Queue the command keyed by the Halo id we
  // return; the /actions note folds in before the create, else the orphan flush
  // (cron + opportunistic) creates it note-less after the grace window.
  await putPendingTicket(env.DB, haloId, JSON.stringify(cmd), nowIso());
  breadcrumb(
    `HALO queued ticket halo_id=${haloId} client=${routing.clientId} contact=${routing.contactId} ` +
      `assets=${routing.agentAssetIds.length} email=${cmd.sendTicketCreatedEmail ? "y" : "n"}`,
  );

  // Opportunistically flush older orphans in the background (no-op when empty).
  ctx?.waitUntil(flushPendingTickets(env).catch((e) => breadcrumb(`HALO opportunistic flush failed ${describeError(e)}`)));

  return haloCreatedTicket(env, haloId, cmd, t, routing);
}

/** Parse "...ticket number 264274883401817..." out of a note's text. */
function ticketNumberFromText(text: string): number | null {
  const m = /ticket\s*(?:number|#|no\.?)?\s*[:#]?\s*(\d{6,})/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * POST /actions — the report/notification note. Correlate it to the queued
 * ticket (explicit ticket id field, else the ticket number in the note text),
 * fold the note into the description, then create the Gorelo ticket.
 */
async function handleActions(env: Env, ctx: ExecutionContext | undefined, body: string): Promise<Response> {
  const parsed = parseJson(body);
  const actions = (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (a): a is Record<string, unknown> => a != null && typeof a === "object",
  );

  let haloId: number | null = null;
  const noteParts: string[] = [];
  for (const a of actions) {
    haloId = haloId ?? num(a.ticket_id) ?? num(a.ticketid) ?? num(a.ticket) ?? num(a.request_id);
    const note = str(a.note_html) || str(a.note) || str(a.details_html) || str(a.details) || str(a.outcome);
    if (note) noteParts.push(note);
  }
  const noteText = noteParts.join("\n\n");
  if (haloId == null) haloId = ticketNumberFromText(noteText);

  const actionId = assetNum(crypto.randomUUID()) || Date.now() % 1_000_000_000;

  if (haloId == null) {
    breadcrumb("HALO action with no correlatable ticket id — accepted, nothing to attach");
    return jsonResponse(201, [{ id: actionId }]);
  }

  const pending = await takePendingTicket(env.DB, haloId);
  if (!pending) {
    // Already created (duplicate/late action) or unknown ticket — accept, no dup.
    breadcrumb(`HALO action halo_id=${haloId}: no pending to attach — accepted`);
    return jsonResponse(201, [{ id: actionId, ticket_id: haloId }]);
  }

  // The /actions note is Tier2's notification email — its body is redundant with
  // the report already in the ticket, and its <head>/<style> flatten into noise,
  // so we don't dump it. But it carries the HDB portal hyperlinks (View Report =
  // screenshots/diagnostics, Connect to Computer = remote session); those we DO
  // surface, since Gorelo has no attachment API and this is the only path to them.
  const cmd = JSON.parse(pending.command) as CreatePublicTicketCommand;
  // Keep the report link (screenshots/diag); drop the remote "Connect to Computer"
  // link — techs connect from Gorelo, and it just clutters the ticket.
  const links = extractNoteLinks(noteText).filter(
    (l) => !/connect to computer/i.test(l.label) && !/\/connect\b/i.test(l.href),
  );
  if (links.length) {
    const rendered = links
      .map((l) => `${esc(l.label)}: <a href="${esc(l.href)}">${esc(l.href)}</a>`)
      .join("<br>");
    cmd.description = `${cmd.description}<br><br><b>Helpdesk Buttons report</b><br>${rendered}`;
    breadcrumb(`HALO action halo_id=${haloId}: attached ${links.length} report link(s)`);
  }

  try {
    const raw = await new GoreloClient(env).createTicket(cmd);
    const uuid = extractTicketNumber(raw) ?? "";
    breadcrumb(
      `HALO created gorelo ticket ${uuid} from action (halo_id=${haloId} client=${cmd.clientId} ` +
        `contact=${cmd.contactId} email=${cmd.sendTicketCreatedEmail ? "y" : "n"})`,
    );
    return jsonResponse(201, [{ id: actionId, ticket_id: haloId, gorelo_ticket_id: uuid }]);
  } catch (err) {
    // Re-queue so the orphan flush retries — unless we've exhausted attempts, in
    // which case dead-letter it (drop + log) so a bad command can't loop forever.
    const attempts = pending.attempts + 1;
    if (attempts >= MAX_PENDING_ATTEMPTS) {
      breadcrumb(`HALO dead-letter halo_id=${haloId} after ${attempts} attempts: ${describeError(err)}`);
      const alert = postDeadLetter(env, { haloId, command: JSON.stringify(cmd), attempts, error: String(err) });
      if (ctx) ctx.waitUntil(alert);
      else await alert;
    } else {
      await putPendingTicket(env.DB, haloId, JSON.stringify(cmd), pending.created_at, attempts);
    }
    if (err instanceof GoreloError) {
      // Non-PII breadcrumb: halo_id + status only. The raw upstream body (which can
      // echo request internals) goes behind DEBUG_LOGS (audit F3).
      breadcrumb(`HALO action gorelo create rejected halo_id=${haloId} status=${err.status}`);
      debug(env, `HALO action gorelo create rejected halo_id=${haloId} status=${err.status} response=${err.body}`);
      return jsonResponse(502, { error: "gorelo_create_failed", status: err.status });
    }
    throw err;
  }
}

/** Parse the configured notifly (Apprise) URLs — comma / whitespace / newline separated. */
export function notiflyUrls(env: Env): string[] {
  return (env.NOTIFLY_URLS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A dead-lettered ticket is a lost help request, so (optionally) alert via notifly —
 * one Apprise URL per destination (ntfy / Teams / Slack / …). notify() never throws;
 * we log any per-destination failures. The body carries enough to recreate the ticket.
 */
async function postDeadLetter(
  env: Env,
  info: { haloId: number; command: string; attempts: number; error: string },
): Promise<void> {
  const urls = notiflyUrls(env);
  if (!urls.length) return;
  let cmd: Partial<CreatePublicTicketCommand> = {};
  try {
    cmd = JSON.parse(info.command) as CreatePublicTicketCommand;
  } catch {
    /* keep empty */
  }
  const title = `⚠️ HDB ticket dropped after ${info.attempts} failed Gorelo creates`;
  const body = [
    `Title: ${cmd.title ?? "(none)"}`,
    `Client: ${cmd.clientId ?? "?"}  Contact: ${cmd.contactId ?? "none"}  Location: ${cmd.locationId ?? "none"}`,
    `Attempts: ${info.attempts}`,
    `Error: ${info.error}`,
    "",
    "--- ticket (recreate manually) ---",
    htmlToText(cmd.description ?? ""),
  ].join("\n");
  const results = await notify({ urls }, { title, body, type: "failure" });
  const failed = results.filter((r) => !r.success);
  if (failed.length) {
    // Log only the failing service names + a static code — never f.error, which can
    // embed a NOTIFLY_URLS destination and a Teams `sig=` token (audit F8).
    breadcrumb(
      `HALO dead-letter notify failures halo_id=${info.haloId}: ` +
        failed.map((f) => `${f.service}:delivery_failed`).join("; "),
    );
  }
}

/**
 * The mirror-refresh sync failing is a silent-degradation risk (stale lookups →
 * mis-routed tickets), so alert via notifly when it does. No-op when NOTIFLY_URLS
 * is unset. notify() never throws; per-destination failures are logged.
 */
export async function postSyncFailure(
  env: Env,
  info: { source: string; error: string },
): Promise<void> {
  const urls = notiflyUrls(env);
  if (!urls.length) return;
  const results = await notify(
    { urls },
    {
      title: "⚠️ Gorelo → D1 mirror sync failed",
      body: [
        `Source: ${info.source}`,
        `Error: ${info.error}`,
        "",
        "The D1 mirror was not refreshed; lookups may serve stale data until the next successful sync.",
      ].join("\n"),
      type: "failure",
    },
  );
  const failed = results.filter((r) => !r.success);
  if (failed.length) {
    // Service names + a static code only — never f.error, which can embed a
    // NOTIFLY_URLS destination / Teams `sig=` token (audit F8).
    breadcrumb(`sync-failure notify errors: ${failed.map((f) => `${f.service}:delivery_failed`).join("; ")}`);
  }
}

/**
 * Send a test alert through the real notifly path so the wiring can be verified on
 * demand (POST /admin/test-webhook), returning the per-destination results.
 */
export async function testNotifly(
  env: Env,
): Promise<{ configured: boolean; results: Array<{ service: string; success: boolean; error?: string }> }> {
  const urls = notiflyUrls(env);
  if (!urls.length) return { configured: false, results: [] };
  const results = await notify(
    { urls },
    {
      title: "✅ Helpdesk Buttons → Gorelo relay",
      body: "Dead-letter alert test. If you see this, notifly alerts are wired up.",
      type: "info",
    },
  );
  return { configured: true, results };
}

/**
 * Create any queued tickets whose /actions note never arrived (older than the
 * grace window). Runs from the cron and opportunistically off live requests.
 */
export async function flushPendingTickets(env: Env): Promise<number> {
  const cutoff = new Date(Date.now() - PENDING_GRACE_MS).toISOString();
  const stale = await takeStalePendingTickets(env.DB, cutoff);
  if (!stale.length) return 0;
  const client = new GoreloClient(env);
  let created = 0;
  for (const row of stale) {
    try {
      const cmd = JSON.parse(row.command) as CreatePublicTicketCommand;
      const raw = await client.createTicket(cmd);
      const uuid = extractTicketNumber(raw) ?? "";
      created++;
      breadcrumb(
        `HALO orphan-flush created gorelo ticket ${uuid} (halo_id=${row.halo_id} ` +
          `contact=${cmd.contactId} email=${cmd.sendTicketCreatedEmail ? "y" : "n"})`,
      );
    } catch (err) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_PENDING_ATTEMPTS) {
        breadcrumb(`HALO dead-letter halo_id=${row.halo_id} after ${attempts} attempts: ${describeError(err)}`);
        await postDeadLetter(env, {
          haloId: row.halo_id,
          command: row.command,
          attempts,
          error: String(err),
        });
      } else {
        await putPendingTicket(env.DB, row.halo_id, row.command, row.created_at, attempts);
        breadcrumb(`HALO orphan-flush failed halo_id=${row.halo_id} (attempt ${attempts}): ${describeError(err)}`);
      }
    }
  }
  return created;
}

// --- Router -----------------------------------------------------------------

async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext | undefined,
  url: URL,
  body: string,
): Promise<Response> {
  const resource = haloResource(url.pathname);
  const method = request.method;

  if (resource === "ticket" || resource === "tickets") {
    if (method === "POST") return handleCreateTicket(env, ctx, body, matchProduct(request, env));
    return jsonResponse(200, { tickets: [], record_count: 0 });
  }
  if (resource === "action" || resource === "actions") {
    // The note folds into the queued ticket, which is then created in Gorelo.
    if (method === "POST") return handleActions(env, ctx, body);
    return jsonResponse(200, []);
  }
  if (method === "GET") {
    if (resource === "users") return handleUsers(env, url);
    if (resource === "client" || resource === "clients") {
      // /Client/{id} -> single Area object; /Client -> the list envelope.
      const id = trailingId(url.pathname);
      return id != null ? handleClientById(env, id) : handleClient(env, url);
    }
    if (resource === "site" || resource === "sites") return handleSite(env, url);
    if (resource === "asset" || resource === "assets") return handleAsset(env, url);
    return handleConfig(env, resource);
  }
  return jsonResponse(200, []);
}

/** Lazy bootstrap: populate the mirror before answering resource lookups. */
async function ensureSynced(env: Env): Promise<void> {
  await initSchema(env.DB);
  if (!(await getLastSync(env.DB))) {
    breadcrumb("HALO: no last_sync — running inline bootstrap sync");
    await syncAll(env).catch(async (err) => {
      const detail = describeError(err);
      breadcrumb(`HALO bootstrap sync failed ${detail}`);
      await postSyncFailure(env, { source: "bootstrap", error: detail });
    });
  }
}

export async function handleHalo(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const body = await logCapture(request, url, env);

  if (!ipAllowed(request, env)) {
    breadcrumb("HALO rejected: no enabled product matched (source IP / User-Agent)");
    return jsonResponse(403, { error: "forbidden" });
  }

  const resource = haloResource(url.pathname);

  // Bearer-token gate (audit F1). No-op unless BOTH HALO_CLIENT_ID and
  // HALO_CLIENT_SECRET are set, and never applies to /token itself. Three modes:
  //   off      — no token check (default; identical to legacy behavior)
  //   observe  — verify + breadcrumb the outcome, never reject
  //   enforce  — 401 { error: "invalid_token" } when the token is not present-&-valid
  if (env.HALO_CLIENT_ID && env.HALO_CLIENT_SECRET && resource !== "token") {
    const mode = (env.HALO_TOKEN_ENFORCE ?? "off").trim().toLowerCase();
    if (mode === "observe" || mode === "enforce") {
      const status = await bearerTokenStatus(request, env.HALO_CLIENT_SECRET);
      breadcrumb(`HALO token ${mode} resource=${resource} token=${status}`);
      if (mode === "enforce" && status !== "present") {
        return jsonResponse(401, { error: "invalid_token" });
      }
    }
  }

  // Always return decodable JSON: Tier2's Halo client fails hard ("could not
  // decode json from the response") on any non-JSON body, so no error may escape
  // as an HTML/text 500.
  let res: Response;
  try {
    if (resource === "token") {
      res = await handleToken(request, env, url, body);
    } else {
      await ensureSynced(env);
      res = await handleApi(request, env, ctx, url, body);
    }
  } catch (err) {
    // No internals in the 500 body or the always-on log (audit F3): correlate via a
    // short request id and keep the describeError detail out of the response entirely.
    const requestId = crypto.randomUUID();
    breadcrumb(`HALO handler error ${request.method} ${url.pathname} id=${requestId} ${describeError(err)}`);
    res = jsonResponse(500, { error: "internal_error", request_id: requestId });
  }

  // Always-on status breadcrumb; the full response body (PII) only under DEBUG_LOGS.
  breadcrumb(`HALO RESPONSE ${res.status} ${request.method} ${url.pathname}`);
  if (debugOn(env)) {
    try {
      const out = await res.clone().text();
      debug(env, `HALO RESPONSE body ${res.status} ${request.method} ${url.pathname} -> ${out.slice(0, 1500)}`);
    } catch {
      /* ignore */
    }
  }
  return res;
}
