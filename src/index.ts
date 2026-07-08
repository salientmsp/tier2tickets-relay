import { getLastSync, initSchema } from "./db.js";
import { extractTicketNumber, GoreloClient, GoreloError } from "./gorelo.js";
import { matchClient } from "./matcher.js";
import { buildIdentity, normalizeEmail, parseHdbTag, parseInbound, stripHdbTag } from "./parse.js";
import { syncAll } from "./sync.js";
import { buildDescription, buildTicketCommand } from "./ticket.js";
import type { Env } from "./types.js";

// Tier2Tickets cloud posts from these two fixed source IPs.
const TIER2_SOURCE_IPS = new Set(["34.202.14.153", "3.209.57.193"]);

const textResponse = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Admin: manual mirror refresh, gated by ADMIN_KEY.
    if (request.method === "POST" && url.pathname === "/admin/sync") {
      if (!adminKeyOk(request, env)) return textResponse(401, "unauthorized");
      try {
        const result = await syncAll(env);
        return textResponse(200, `ok devices=${result.devices} domains=${result.domains}`);
      } catch (err) {
        console.error("admin sync failed", describeError(err));
        return textResponse(502, "sync failed");
      }
    }

    // Lightweight health check (no secrets).
    if (request.method === "GET" && url.pathname === "/health") {
      return textResponse(200, "ok");
    }

    // Everything else that's a POST is treated as an osTicket-style ticket create.
    // (Tier2's "Ticket System API endpoint" host may point at any path.)
    if (request.method === "POST") {
      return handleTicketCreate(request, env);
    }

    return textResponse(404, "not found");
  },

  // Cron Trigger: refresh the D1 mirror off the request path.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      syncAll(env)
        .then((r) => console.log(`cron sync ok devices=${r.devices} domains=${r.domains}`))
        .catch((err) => console.error("cron sync failed", describeError(err))),
    );
  },
} satisfies ExportedHandler<Env>;

async function handleTicketCreate(request: Request, env: Env): Promise<Response> {
  // 1. IP allowlist (Tier2's two fixed source IPs).
  if (env.ENFORCE_IP_ALLOWLIST === "true") {
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    if (!TIER2_SOURCE_IPS.has(ip)) {
      console.warn("rejected ticket create: source IP not allowlisted");
      return textResponse(403, "forbidden");
    }
  }

  // 2. Shared-secret gate (the "API key" Tier2 sends).
  if (!keyOk(request, env)) {
    return textResponse(401, "unauthorized");
  }

  // 3. Parse the osTicket-shaped body (JSON or form).
  const inbound = await parseInbound(request);
  const tag = parseHdbTag(inbound.message);
  const cleanBody = stripHdbTag(inbound.message);
  const identity = buildIdentity(inbound, tag);

  try {
    // 4. First-press bootstrap: self-heal a fresh deploy with no mirror yet.
    await initSchema(env.DB);
    const lastSync = await getLastSync(env.DB);
    if (!lastSync) {
      console.log("no last_sync — running inline bootstrap sync");
      await syncAll(env);
    }

    // 5. Resolve the Gorelo client from the press identity.
    const match = await matchClient(env.DB, identity, Number(env.CATCHALL_CLIENT_ID));

    // 6. Resolve the contact live (small per-client list; keeps mapping fresh).
    const client = new GoreloClient(env);
    let contactId: number | null = null;
    if (identity.email) {
      try {
        const contacts = await client.listContacts(match.clientId);
        const hit = contacts.find(
          (c) => normalizeEmail(c.primaryEmail) === identity.email,
        );
        contactId = hit ? hit.id : null;
      } catch (err) {
        // Contact resolution is best-effort — a ticket without a contact still beats a dropped press.
        console.warn("contact lookup failed", describeError(err));
      }
    }

    // 7. Build + create the ticket.
    const description = buildDescription(cleanBody, identity, match);
    const cmd = buildTicketCommand(
      env,
      identity,
      match,
      contactId,
      inbound.subject,
      description,
    );

    const raw = await client.createTicket(cmd);
    // TODO(verify #3): pin the ticket-number field once confirmed. Log the raw
    // response so the shape can be inspected on the first successful create.
    console.log("gorelo create response", JSON.stringify(raw));
    const ticketNumber = extractTicketNumber(raw);

    if (!ticketNumber) {
      console.error("could not extract ticket number from Gorelo response");
      return textResponse(502, "created but could not read ticket number");
    }

    // osTicket-style success: 201 + ticket number as plain text.
    return textResponse(201, ticketNumber);
  } catch (err) {
    if (err instanceof GoreloError) {
      console.error(`gorelo failure status=${err.status}`, err.body);
      return textResponse(502, `gorelo upstream error (status ${err.status})`);
    }
    console.error("ticket create failed", describeError(err));
    return textResponse(502, "ticket create failed");
  }
}

/** The inbound X-API-Key Tier2 sends must equal EXPECTED_KEY (gates ticket creation). */
function keyOk(request: Request, env: Env): boolean {
  const provided = request.headers.get("X-API-Key") ?? "";
  return Boolean(env.EXPECTED_KEY) && provided === env.EXPECTED_KEY;
}

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
