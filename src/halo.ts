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
import { GoreloClient, GoreloError, extractTicketNumber } from "./gorelo.js";
import { normalizeEmail, normalizeHost } from "./parse.js";
import { assetNum, syncAll } from "./sync.js";
import { ipAllowed } from "./tier2.js";
import type {
  CreatePublicTicketCommand,
  Env,
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

/** Fallback path matcher (primary routing is the halo-app-name header). */
export function isHaloPath(pathname: string): boolean {
  return pathname === "/auth/token" || HALO_RESOURCES.has(haloResource(pathname));
}

/** True if this request is a Halo call (header first, then path shape). */
export function isHaloRequest(request: Request, pathname: string): boolean {
  return request.headers.get(HALO_HEADER) != null || isHaloPath(pathname);
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function safeHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const key = k.toLowerCase();
    out[key] = key === "authorization" || key === "cookie" ? "<redacted>" : v;
  }
  return out;
}

async function logCapture(request: Request, url: URL): Promise<string> {
  let body = "";
  try {
    // Decode via arrayBuffer (works for JSON + form bodies without the workerd
    // "text() on non-text body" warning that would clutter the capture logs).
    const buf = await request.clone().arrayBuffer();
    body = new TextDecoder().decode(buf);
  } catch {
    body = "<unreadable>";
  }
  const redacted = body.replace(/(client_secret|password|secret)=([^&\s]+)/gi, "$1=<redacted>");
  console.log(
    `HALO CAPTURE ${request.method} ${url.pathname}${url.search} ` +
      `headers=${JSON.stringify(safeHeaders(request))} body=${redacted.slice(0, 2000)}`,
  );
  return body;
}

// --- OAuth token ------------------------------------------------------------

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
  console.log(`HALO token grant=${params.grant_type ?? ""} tenant=${tenant} client_id=${clientId}`);

  if (env.HALO_CLIENT_ID && env.HALO_CLIENT_SECRET) {
    if (clientId !== env.HALO_CLIENT_ID || params.client_secret !== env.HALO_CLIENT_SECRET) {
      return jsonResponse(401, { error: "invalid_client" });
    }
  }
  const token = crypto.randomUUID().replace(/-/g, "");
  return jsonResponse(200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: 3600,
    scope: params.scope ?? "all",
  });
}

// --- Lookups (GET) ----------------------------------------------------------

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
    return jsonResponse(200, { users: [user], record_count: 1 });
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
  return jsonResponse(200, { users, record_count: users.length });
}

async function handleClient(env: Env, url: URL): Promise<Response> {
  const rows = await listClientRows(env.DB, searchTerm(url));
  const clients = rows.map((c) => ({ id: c.id, name: c.name ?? "" }));
  return jsonResponse(200, { clients, record_count: clients.length });
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
  return jsonResponse(200, { sites, record_count: sites.length });
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
  return jsonResponse(200, { assets, record_count: assets.length });
}

/** Minimal config lists so Tier2 can resolve default ids. Refine from captures. */
function handleConfig(env: Env, resource: string): Response {
  switch (resource) {
    case "tickettype":
    case "tickettypes":
      return jsonResponse(200, [{ id: Number(env.DEFAULT_TYPE_ID), name: "Incident" }]);
    case "status":
    case "statuses":
      return jsonResponse(200, [{ id: Number(env.DEFAULT_STATUS_ID), name: "New" }]);
    case "team":
    case "teams":
      return jsonResponse(200, [{ id: Number(env.DEFAULT_GROUP_ID), name: "Everyone" }]);
    case "priority":
    case "priorities":
      return jsonResponse(200, [
        { id: 1, name: "Critical" },
        { id: 2, name: "High" },
        { id: 3, name: "Medium" },
        { id: 4, name: "Low" },
      ]);
    case "agent":
    case "agents":
      return jsonResponse(200, { agents: [], record_count: 0 });
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
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
function htmlToText(s: string): string {
  // Drop non-content blocks first — a full HTML email (the /actions note) carries
  // <head>/<style> with @font-face/@media rules that otherwise flatten into noise.
  const stripped = s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ");
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
  device: DeviceFullRow | null;
  report: Record<string, string>;
}

async function resolveRouting(env: Env, t: HaloTicket): Promise<Routing> {
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

  const bodyClient = num(t.client_id);
  const isCatchall = bodyClient === Number(env.CATCHALL_CLIENT_ID);
  // Most specific signal wins: matched contact, matched device, a NON-catch-all
  // client Tier2 sent, then whatever remains (catch-all).
  const clientId =
    contact?.client_id ??
    device?.client_id ??
    (bodyClient && !isCatchall ? bodyClient : null) ??
    bodyClient ??
    Number(env.CATCHALL_CLIENT_ID);
  const locationId = contact?.location_id ?? device?.location_id ?? num(t.site_id) ?? null;
  const contactId = contact?.id ?? null;

  const agentAssetIds = await resolveAssetUuids(env.DB, t);
  if (device?.agent_id && !agentAssetIds.includes(device.agent_id)) agentAssetIds.push(device.agent_id);

  const contactName = contact?.name || report.name || email || "Helpdesk Buttons";
  console.log(
    `HALO routing: reportEmail=${email || "(none)"} hostname=${hostname || "(none)"} ` +
      `contact=${contactId ?? "MISS"} device=${device ? "hit" : "miss"} assets=${agentAssetIds.length} ` +
      `-> client=${clientId} location=${locationId ?? "none"}`,
  );
  return {
    clientId,
    locationId,
    contactId,
    contactName,
    agentAssetIds,
    email,
    hostname,
    assetMatched: agentAssetIds.length > 0,
    device,
    report,
  };
}

const FIELD_MAX = 2000; // cap any single extra field so one value can't bloat the ticket
const BODY_MAX = 16000; // generous cap on the whole report body — keep everything, guard only pathological blobs

function truncate(s: string, max = FIELD_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

// Fields we already surface elsewhere (report body / dedicated handling), so they
// don't need to appear again in the raw-fields dump.
const DUMP_SKIP = new Set(["details_html", "details", "summary", "subject", "note_html", "note"]);

/** Dump every remaining top-level field Tier2 sent, so nothing is silently lost. */
function dumpSubmittedFields(t: HaloTicket): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (DUMP_SKIP.has(k) || v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`${k}: ${truncate(rendered)}`);
  }
  return lines.length ? ["— All submitted fields —", ...lines].join("\n") : "";
}

/** One-line hardware summary from the matched Gorelo agent (blank if no match). */
function deviceSection(d: DeviceFullRow | null): string {
  if (!d) return "";
  const ips = [d.local_ip, d.public_ip].filter((s) => s && s.trim()).join(" / ");
  const parts = [
    d.display_name || d.hostname,
    d.os,
    d.serial ? `SN ${d.serial}` : "",
    ips ? `IP ${ips}` : "",
  ].filter((s) => s && String(s).trim());
  return parts.length ? `— Device —\n${parts.join(" · ")}` : "";
}

/** Build the ticket body: the report + every submitted field + device details + routing. */
function buildHaloDescription(t: HaloTicket, routing: Routing): string {
  const raw = str(t.details_html) || str(t.details) || str(t.summary);
  const body = truncate(htmlToText(raw), BODY_MAX);

  // The report body already shows reporter/company/hostname, so keep the trail to
  // just the routing outcome (which Gorelo ids we matched, and the asset status).
  const assetStatus = routing.hostname
    ? routing.assetMatched
      ? `${routing.hostname} (linked)`
      : `${routing.hostname} (no Gorelo agent match)`
    : "none";
  const trail = [
    "— Helpdesk Buttons routing —",
    `Client: ${routing.clientId}  Contact: ${routing.contactId ?? "none"}  Asset: ${assetStatus}`,
  ].join("\n");

  return [body, dumpSubmittedFields(t), deviceSection(routing.device), trail]
    .filter((s) => s.length > 0)
    .join("\n\n");
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

function buildTicketCommand(env: Env, t: HaloTicket, routing: Routing): CreatePublicTicketCommand {
  const summary = str(t.summary) || str(t.subject) || "(no subject)";
  const tagId = num(env.HDB_TAG_ID);
  return {
    title: summary,
    createdByName: routing.contactName,
    clientId: routing.clientId,
    locationId: routing.locationId,
    contactId: routing.contactId,
    description: buildHaloDescription(t, routing),
    statusId: Number(env.DEFAULT_STATUS_ID),
    groupId: Number(env.DEFAULT_GROUP_ID),
    typeId: Number(env.DEFAULT_TYPE_ID),
    priorityId: Number(env.DEFAULT_PRIORITY) as PublicTicketPriority,
    sourceId: Number(env.DEFAULT_SOURCE) as TicketSource,
    tagIds: tagId ? [tagId] : undefined,
    agentAssetIds: routing.agentAssetIds,
    sendTicketCreatedEmail: false,
  };
}

/**
 * POST /tickets — Tier2 creates the ticket, then POSTs the report/notification as
 * a separate /actions note. Gorelo has no ticket-append endpoint, so we DON'T
 * create the Gorelo ticket yet: we build the command, queue it keyed by the Halo
 * id we return, and let the /actions note fold in before the create. An orphan
 * flush (cron + opportunistic) creates any ticket whose note never arrives.
 */
async function handleCreateTicket(env: Env, ctx: ExecutionContext | undefined, body: string): Promise<Response> {
  const t = firstTicket(parseJson(body));
  const routing = await resolveRouting(env, t);
  const cmd = buildTicketCommand(env, t, routing);

  const haloId = assetNum(crypto.randomUUID()) || Date.now() % 1_000_000_000_000;
  await putPendingTicket(env.DB, haloId, JSON.stringify(cmd), nowIso());
  console.log(
    `HALO queued ticket halo_id=${haloId} client=${routing.clientId} contact=${routing.contactId} assets=${routing.agentAssetIds.length}`,
  );

  // Opportunistically flush older orphans in the background (no-op when empty).
  ctx?.waitUntil(flushPendingTickets(env).catch((e) => console.error("HALO opportunistic flush failed", String(e))));

  // Echo a Halo-shaped created ticket so Tier2 can display/correlate it.
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
async function handleActions(env: Env, body: string): Promise<Response> {
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
    console.log("HALO action with no correlatable ticket id — accepted, nothing to attach");
    return jsonResponse(201, [{ id: actionId }]);
  }

  const pending = await takePendingTicket(env.DB, haloId);
  if (!pending) {
    // Already created (duplicate/late action) or unknown ticket — accept, no dup.
    console.log(`HALO action halo_id=${haloId}: no pending to attach — accepted`);
    return jsonResponse(201, [{ id: actionId, ticket_id: haloId }]);
  }

  // The /actions note is Tier2's notification email — its body is redundant with
  // the report already in the ticket, and its <head>/<style> flatten into noise,
  // so we don't dump it. But it carries the HDB portal hyperlinks (View Report =
  // screenshots/diagnostics, Connect to Computer = remote session); those we DO
  // surface, since Gorelo has no attachment API and this is the only path to them.
  const cmd = JSON.parse(pending.command) as CreatePublicTicketCommand;
  const links = extractNoteLinks(noteText);
  if (links.length) {
    const rendered = links.map((l) => `${l.label}: ${l.href}`).join("\n");
    cmd.description = `${cmd.description}\n\n— Helpdesk Buttons report —\n${rendered}`;
    console.log(`HALO action halo_id=${haloId}: attached ${links.length} report link(s)`);
  }

  try {
    const raw = await new GoreloClient(env).createTicket(cmd);
    const uuid = extractTicketNumber(raw) ?? "";
    console.log(
      `HALO created gorelo ticket ${uuid} from action (halo_id=${haloId} client=${cmd.clientId} contact=${cmd.contactId})`,
    );
    return jsonResponse(201, [{ id: actionId, ticket_id: haloId, gorelo_ticket_id: uuid }]);
  } catch (err) {
    // Re-queue so the orphan flush retries; surface the failure to Tier2.
    await putPendingTicket(env.DB, haloId, JSON.stringify(cmd), pending.created_at);
    if (err instanceof GoreloError) {
      console.error(`HALO action gorelo create rejected status=${err.status} response=${err.body}`);
      return jsonResponse(502, { error: "gorelo_create_failed", status: err.status });
    }
    throw err;
  }
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
      console.log(`HALO orphan-flush created gorelo ticket ${uuid} (halo_id=${row.halo_id})`);
    } catch (err) {
      await putPendingTicket(env.DB, row.halo_id, row.command, row.created_at);
      console.error(`HALO orphan-flush failed halo_id=${row.halo_id}: ${String(err)}`);
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
    if (method === "POST") return handleCreateTicket(env, ctx, body);
    return jsonResponse(200, { tickets: [], record_count: 0 });
  }
  if (resource === "action" || resource === "actions") {
    // The note folds into the queued ticket, which is then created in Gorelo.
    if (method === "POST") return handleActions(env, body);
    return jsonResponse(200, []);
  }
  if (method === "GET") {
    if (resource === "users") return handleUsers(env, url);
    if (resource === "client" || resource === "clients") return handleClient(env, url);
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
    console.log("HALO: no last_sync — running inline bootstrap sync");
    await syncAll(env).catch((err) => console.error("HALO bootstrap sync failed", String(err)));
  }
}

export async function handleHalo(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const body = await logCapture(request, url);

  if (!ipAllowed(request, env)) {
    console.warn("HALO rejected: source IP not allowlisted");
    return jsonResponse(403, { error: "forbidden" });
  }

  // Always return decodable JSON: Tier2's Halo client fails hard ("could not
  // decode json from the response") on any non-JSON body, so no error may escape
  // as an HTML/text 500.
  let res: Response;
  try {
    if (haloResource(url.pathname) === "token") {
      res = await handleToken(request, env, url, body);
    } else {
      await ensureSynced(env);
      res = await handleApi(request, env, ctx, url, body);
    }
  } catch (err) {
    console.error(`HALO handler error ${request.method} ${url.pathname}:`, String(err));
    res = jsonResponse(500, { error: "internal_error", detail: String(err).slice(0, 300) });
  }

  // Log the response body we send back (debug phase — see exactly what Tier2 gets).
  try {
    const out = await res.clone().text();
    console.log(`HALO RESPONSE ${res.status} ${request.method} ${url.pathname} -> ${out.slice(0, 1500)}`);
  } catch {
    /* ignore */
  }
  return res;
}
