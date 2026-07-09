import { ipAllowed } from "./tier2.js";
import type { Env } from "./types.js";

/**
 * HaloPSA/HaloITSM mock — PHASE 1 (capture).
 *
 * Tier2's Halo integration is a full OAuth2 client that (per the Halo setup docs)
 * authenticates against an Authorization Server, then hits the Resource Server for
 * customers (read:customers), CRM/contacts (read:crm), assets (read:assets), and
 * tickets (read/edit:tickets) — i.e. it does the PSA lookups we want to leverage.
 *
 * Because Tier2's client is opaque and Halo has many endpoints (one wrong shape
 * stalls the flow), Phase 1 does NOT create Gorelo tickets. It only:
 *   1. completes the OAuth handshake so Tier2 proceeds,
 *   2. logs EVERY request (method, path, query, body) so we can capture Tier2's
 *      exact call sequence, and
 *   3. returns minimal, plausible Halo-shaped responses so the flow runs to the end.
 *
 * Phase 2 replaces the synthetic responses with real Gorelo-backed lookups + create,
 * matched to the shapes the capture reveals.
 */

const HALO_PATH_PREFIXES = ["/auth/token", "/api/", "/token"];

/** Does this request look like a Halo (OAuth resource/auth server) call? */
export function isHaloPath(pathname: string): boolean {
  return HALO_PATH_PREFIXES.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Redact obvious secrets before logging headers. */
function safeHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const key = k.toLowerCase();
    out[key] = key === "authorization" || key === "cookie" ? "<redacted>" : v;
  }
  return out;
}

/** Phase-1 capture log: record exactly what Tier2 sends, without leaking secrets. */
async function logCapture(request: Request, url: URL): Promise<string> {
  let body = "";
  try {
    body = await request.clone().text();
  } catch {
    body = "<unreadable>";
  }
  // Redact client_secret / password-ish fields from the token body.
  const redactedBody = body.replace(
    /(client_secret|password|secret)=([^&\s]+)/gi,
    "$1=<redacted>",
  );
  console.log(
    `HALO CAPTURE ${request.method} ${url.pathname}${url.search} ` +
      `headers=${JSON.stringify(safeHeaders(request))} body=${redactedBody.slice(0, 2000)}`,
  );
  return body;
}

/** Parse client_id/client_secret/grant_type from a token request (form or JSON). */
async function parseTokenRequest(
  body: string,
  contentType: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (contentType.includes("application/json")) {
    try {
      const obj = JSON.parse(body) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) out[k] = String(v ?? "");
    } catch {
      /* ignore */
    }
  } else {
    for (const [k, v] of new URLSearchParams(body).entries()) out[k] = v;
  }
  return out;
}

/**
 * OAuth2 client_credentials token endpoint. Issues a bearer token so Tier2 can
 * proceed to the resource server. If HALO_CLIENT_ID/HALO_CLIENT_SECRET are
 * configured, they must match; otherwise any credentials are accepted (the
 * request is already IP-gated to Tier2's addresses).
 */
async function handleToken(request: Request, env: Env, body: string): Promise<Response> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  const params = await parseTokenRequest(body, ct);
  const clientId = params.client_id ?? "";
  console.log(`HALO token request grant=${params.grant_type ?? ""} client_id=${clientId}`);

  if (env.HALO_CLIENT_ID && env.HALO_CLIENT_SECRET) {
    if (clientId !== env.HALO_CLIENT_ID || params.client_secret !== env.HALO_CLIENT_SECRET) {
      return jsonResponse(401, { error: "invalid_client" });
    }
  }

  // Stateless token (Phase 1 accepts any bearer on resource calls). crypto.randomUUID
  // is available in the Workers runtime.
  const token = crypto.randomUUID().replace(/-/g, "");
  return jsonResponse(200, {
    access_token: token,
    token_type: "Bearer",
    expires_in: 3600,
    scope: params.scope ?? "all",
  });
}

/**
 * Resource-server router (Phase 1). Returns minimal, plausible Halo shapes so the
 * flow proceeds; every call is already captured by logCapture. Empty lookup
 * results make Tier2 fall back to the unregistered@helpdeskbuttons.com catch-all
 * user, which still lets the ticket-create call happen so we can observe it.
 */
function handleApi(request: Request, url: URL): Response {
  const path = url.pathname;
  const method = request.method;

  // Ticket create/update: Halo POSTs an array of ticket objects. Return a plausible
  // created-ticket object with a synthetic numeric id (NO Gorelo write in Phase 1).
  if (path === "/api/Tickets" || path === "/api/tickets") {
    if (method === "POST") {
      const id = Date.now() % 1_000_000_000; // synthetic numeric ticket id
      console.log(`HALO synthetic ticket id=${id} (phase 1 — no Gorelo write)`);
      return jsonResponse(201, { id, summary: "captured", dateoccurred: null });
    }
    return jsonResponse(200, { tickets: [], record_count: 0 });
  }

  // Notes/attachments.
  if (path === "/api/Actions" || path === "/api/actions") {
    return jsonResponse(201, [{ id: Date.now() % 1_000_000_000 }]);
  }

  // Lookup endpoints — return empty result sets in the Halo `{ <resource>: [] }` shape.
  const emptyLookups: Record<string, string> = {
    "/api/Client": "clients",
    "/api/Users": "users",
    "/api/Site": "sites",
    "/api/Asset": "assets",
    "/api/Agent": "agents",
    "/api/Team": "teams",
    "/api/Status": "statuses",
    "/api/TicketType": "tickettypes",
    "/api/Priority": "priorities",
  };
  const key = emptyLookups[path];
  if (key) return jsonResponse(200, { [key]: [], record_count: 0 });

  // Unknown resource: bare empty array (many Halo list endpoints return one).
  return jsonResponse(200, []);
}

/** Entry point for all Halo-shaped requests. */
export async function handleHalo(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const body = await logCapture(request, url);

  if (!ipAllowed(request, env)) {
    console.warn("HALO rejected: source IP not allowlisted");
    return jsonResponse(403, { error: "forbidden" });
  }

  if (url.pathname === "/auth/token" || url.pathname === "/token") {
    return handleToken(request, env, body);
  }
  return handleApi(request, url);
}
