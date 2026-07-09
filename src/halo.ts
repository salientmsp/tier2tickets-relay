import {
  findContactByEmail,
  getAgentIdByAssetNum,
  getClientName,
  getContactById,
  getLastSync,
  initSchema,
  listClientRows,
  listLocationRows,
  searchContactRows,
  searchDeviceRows,
  type ContactRow,
} from "./db.js";
import { GoreloClient, GoreloError, extractTicketNumber } from "./gorelo.js";
import { normalizeEmail } from "./parse.js";
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

export function isHaloPath(pathname: string): boolean {
  return pathname === "/auth/token" || pathname === "/token" || pathname.startsWith("/api/");
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

async function haloUserFromContact(db: D1Database, c: ContactRow): Promise<Record<string, unknown>> {
  const clientName = c.client_id != null ? await getClientName(db, c.client_id) : null;
  return {
    id: c.id,
    name: c.name || c.email,
    emailaddress: c.email,
    email: c.email,
    client_id: c.client_id ?? 0,
    client_name: clientName ?? "",
    site_id: c.location_id ?? 0,
    inactive: false,
    use: "user",
  };
}

async function handleUsers(env: Env, url: URL): Promise<Response> {
  const term = searchTerm(url);
  const email = normalizeEmail(term);

  // The catch-all "unregistered" user Tier2 falls back to for unknown submitters.
  if (email === HALO_UNREGISTERED_EMAIL) {
    return jsonResponse(200, {
      users: [
        {
          id: 0,
          name: "Unregistered",
          emailaddress: HALO_UNREGISTERED_EMAIL,
          email: HALO_UNREGISTERED_EMAIL,
          client_id: Number(env.CATCHALL_CLIENT_ID),
          site_id: 0,
          inactive: false,
        },
      ],
      record_count: 1,
    });
  }

  const rows = email.includes("@")
    ? [await findContactByEmail(env.DB, email)].filter((r): r is ContactRow => r != null)
    : await searchContactRows(env.DB, term);
  const users = await Promise.all(rows.map((r) => haloUserFromContact(env.DB, r)));
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
  const rows = await searchDeviceRows(env.DB, searchTerm(url));
  const assets = rows.map((d) => ({
    id: d.asset_num ?? 0,
    inventory_number: d.hostname ?? d.display_name ?? "",
    key_field: d.hostname ?? d.display_name ?? "",
    client_id: d.client_id ?? 0,
    site_id: d.location_id ?? 0,
  }));
  return jsonResponse(200, { assets, record_count: assets.length });
}

/** Minimal config lists so Tier2 can resolve default ids. Refine from captures. */
function handleConfig(env: Env, path: string): Response {
  switch (path) {
    case "/api/TicketType":
      return jsonResponse(200, [{ id: Number(env.DEFAULT_TYPE_ID), name: "Incident" }]);
    case "/api/Status":
      return jsonResponse(200, [{ id: Number(env.DEFAULT_STATUS_ID), name: "New" }]);
    case "/api/Team":
      return jsonResponse(200, [{ id: Number(env.DEFAULT_GROUP_ID), name: "Everyone" }]);
    case "/api/Priority":
      return jsonResponse(200, [
        { id: 1, name: "Critical" },
        { id: 2, name: "High" },
        { id: 3, name: "Medium" },
        { id: 4, name: "Low" },
      ]);
    case "/api/Agent":
      return jsonResponse(200, { agents: [], record_count: 0 });
    default:
      return jsonResponse(200, []);
  }
}

// --- Ticket create (POST /api/Tickets) --------------------------------------

type HaloTicket = Record<string, unknown>;

function firstTicket(parsed: unknown): HaloTicket {
  if (Array.isArray(parsed)) return (parsed[0] ?? {}) as HaloTicket;
  if (parsed && typeof parsed === "object") return parsed as HaloTicket;
  return {};
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

/** Pull the requester email out of the various fields Halo/Tier2 might use. */
function requesterEmail(t: HaloTicket): string {
  for (const k of ["emailfrom", "reportedby", "email", "useremail", "contactemail"]) {
    const v = normalizeEmail(str(t[k]));
    if (v.includes("@")) return v;
  }
  return "";
}

/** Map the asset ids Tier2 sends (our numeric surrogates) back to Gorelo agent UUIDs. */
async function resolveAssetUuids(db: D1Database, t: HaloTicket): Promise<string[]> {
  const ids: number[] = [];
  const assets = t.assets;
  if (Array.isArray(assets)) {
    for (const a of assets) {
      if (typeof a === "number") ids.push(a);
      else if (a && typeof a === "object") {
        const n = num((a as Record<string, unknown>).id);
        if (n != null) ids.push(n);
      }
    }
  }
  const uuids: string[] = [];
  for (const n of ids) {
    const uuid = await getAgentIdByAssetNum(db, n);
    if (uuid) uuids.push(uuid);
  }
  return uuids;
}

const FIELD_MAX = 2000; // cap any single field so a base64 attachment can't bloat the ticket

function truncate(s: string): string {
  return s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX)}… [truncated ${s.length - FIELD_MAX} chars]` : s;
}

/** Build a rich description: the body plus a dump of every field Tier2 sent. */
function buildHaloDescription(t: HaloTicket, email: string): string {
  const body = truncate((str(t.details_html) || str(t.details) || str(t.summary)).trim());

  const skip = new Set(["details", "details_html"]);
  const extras: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (skip.has(k) || v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
    extras.push(`${k}: ${truncate(rendered)}`);
  }
  if (email) extras.push(`resolved_requester: ${email}`);

  const footer = ["--- Helpdesk Buttons / Halo submission ---", ...extras].join("\n");
  return [body, footer].filter((s) => s.length > 0).join("\n\n");
}

async function handleCreateTicket(env: Env, body: string): Promise<Response> {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  })();
  const t = firstTicket(parsed);
  const email = requesterEmail(t);

  // Resolve the Gorelo routing. Prefer the ids Tier2 looked up (they ARE Gorelo
  // ids in our mock); fall back to the contact resolved from the email.
  const contact = num(t.user_id)
    ? await getContactById(env.DB, num(t.user_id) as number)
    : email
      ? await findContactByEmail(env.DB, email)
      : null;

  const clientId = num(t.client_id) ?? contact?.client_id ?? Number(env.CATCHALL_CLIENT_ID);
  const locationId = num(t.site_id) ?? contact?.location_id ?? null;
  const contactId = contact?.id ?? null;
  const agentAssetIds = await resolveAssetUuids(env.DB, t);

  const summary = str(t.summary) || str(t.subject) || "(no subject)";
  const description = buildHaloDescription(t, email);

  const cmd: CreatePublicTicketCommand = {
    title: summary,
    createdByName: contact?.name || email || "Helpdesk Buttons",
    clientId,
    locationId,
    contactId,
    description,
    statusId: Number(env.DEFAULT_STATUS_ID),
    groupId: Number(env.DEFAULT_GROUP_ID),
    typeId: Number(env.DEFAULT_TYPE_ID),
    priorityId: Number(env.DEFAULT_PRIORITY) as PublicTicketPriority,
    sourceId: Number(env.DEFAULT_SOURCE) as TicketSource,
    agentAssetIds,
    sendTicketCreatedEmail: false,
  };

  const client = new GoreloClient(env);
  let raw: unknown;
  try {
    raw = await client.createTicket(cmd);
  } catch (err) {
    if (err instanceof GoreloError) {
      console.error(
        `HALO gorelo create rejected status=${err.status} command=${JSON.stringify(cmd)} response=${err.body}`,
      );
      return jsonResponse(502, { error: "gorelo_create_failed", status: err.status });
    }
    throw err;
  }

  const uuid = extractTicketNumber(raw) ?? "";
  const id = assetNum(uuid) || Date.now() % 1_000_000_000;
  console.log(`HALO created gorelo ticket ${uuid} -> halo id ${id} (client=${clientId} contact=${contactId})`);

  // Echo a Halo-shaped created ticket so Tier2 can display/correlate it.
  return jsonResponse(201, {
    id,
    summary,
    details: str(t.details),
    client_id: clientId,
    site_id: locationId ?? 0,
    user_id: contactId ?? 0,
    tickettype_id: Number(env.DEFAULT_TYPE_ID),
    status_id: Number(env.DEFAULT_STATUS_ID),
    gorelo_ticket_id: uuid,
  });
}

// --- Router -----------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL, body: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/Tickets" || path === "/api/tickets") {
    if (method === "POST") return handleCreateTicket(env, body);
    return jsonResponse(200, { tickets: [], record_count: 0 });
  }
  if (path === "/api/Actions" || path === "/api/actions") {
    // Gorelo's public API has no ticket-note endpoint, so accept + log only.
    console.log("HALO action (note/attachment) accepted — no Gorelo note endpoint");
    return jsonResponse(201, [{ id: Date.now() % 1_000_000_000 }]);
  }
  if (method === "GET") {
    if (path === "/api/Users") return handleUsers(env, url);
    if (path === "/api/Client") return handleClient(env, url);
    if (path === "/api/Site") return handleSite(env, url);
    if (path === "/api/Asset") return handleAsset(env, url);
    return handleConfig(env, path);
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

export async function handleHalo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const body = await logCapture(request, url);

  if (!ipAllowed(request, env)) {
    console.warn("HALO rejected: source IP not allowlisted");
    return jsonResponse(403, { error: "forbidden" });
  }

  if (url.pathname === "/auth/token" || url.pathname === "/token") {
    return handleToken(request, env, url, body);
  }

  await ensureSynced(env);
  return handleApi(request, env, url, body);
}
