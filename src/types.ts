// Hand-written subset of the Gorelo public API types actually used by this relay.
// Ground truth: https://api.usw.gorelo.io/swagger/v1/swagger.json
// (Verify against the live spec before deploy — see the runtime-verify checklist in README.)

/** A queued unit of location-sync work: refresh + reconcile one client's sites. */
export interface SyncLocationsMessage {
  type: "locations";
  clientId: number;
}

/** Worker environment: wrangler.toml [vars] + D1 binding + queue + CLI secrets. */
export interface Env {
  DB: D1Database;
  // Producer binding for the per-client location-fetch fan-out (see wrangler.toml).
  SYNC_QUEUE: Queue<SyncLocationsMessage>;

  // vars
  GORELO_BASE_URL: string;
  ENFORCE_IP_ALLOWLIST: string; // "true" | "false"
  // Per-product allowlist toggles (see src/products.ts PRODUCTS). "true" enables
  // that product's source IPs/CIDRs; unset falls back to the product's built-in
  // default (tier2 on, huntress off — backward-compatible).
  ENABLE_TIER2?: string; // "true" | "false" (default true)
  ENABLE_HUNTRESS?: string; // "true" | "false" (default false)
  DEFAULT_GROUP_ID: string; // int as string
  DEFAULT_TYPE_ID: string; // int as string
  DEFAULT_STATUS_ID: string; // int as string (REQUIRED by Gorelo's validator)
  DEFAULT_PRIORITY: string; // PublicTicketPriority int as string
  DEFAULT_SOURCE: string; // TicketSource int as string
  CATCHALL_CLIENT_ID: string; // int as string
  HDB_TAG_ID?: string; // Gorelo tag id applied to every HDB ticket ("Submitted VIA HDB")
  EMERGENCY_PRIORITY?: string; // priority id for a press flagged "This is an emergency"
  // "true" asks Gorelo to send its "ticket created" email — but ONLY when the Worker
  // resolved a real client contact (contactId), so the mail never fires on the
  // catch-all/no-contact fallback. Any other value (or unset) suppresses it.
  SEND_TICKET_CREATED_EMAIL?: string;
  DEBUG_LOGS?: string; // "true" enables verbose HALO CAPTURE/RESPONSE body logging (PII)

  // secrets (wrangler secret put ...)
  GORELO_API_KEY: string; // X-API-Key sent to Gorelo
  ADMIN_KEY: string; // gates POST /admin/sync
  // Optional notifly (Apprise-style) URLs alerted when a ticket is dead-lettered.
  // Comma/space/newline separated, e.g. "ntfy://alerts, msteams://…, slack://…".
  NOTIFLY_URLS?: string;

  // Per-product Halo mock OAuth credentials (issue #51). Each product authenticates
  // with its OWN client_id, so credentials are resolved per matched product via the
  // clientIdVar/clientSecretVar on its PRODUCTS entry (src/products.ts). When a
  // product's pair is set, its /token calls are validated and its resource requests
  // token-enforced; when unset that product stays lenient (any creds accepted).
  //
  // tier2 uses the original pair below (no migration for the existing deployment);
  // when no product matches (e.g. the allowlist is disabled) these are also the
  // global fallback so legacy single-credential setups keep working.
  HALO_CLIENT_ID?: string;
  HALO_CLIENT_SECRET?: string;
  // Huntress's own OAuth pair (its distinct client_id). Set the secret via
  // `wrangler secret put HALO_CLIENT_SECRET_HUNTRESS`.
  HALO_CLIENT_ID_HUNTRESS?: string;
  HALO_CLIENT_SECRET_HUNTRESS?: string;
  // Bearer-token enforcement on Halo resource endpoints (audit F1). Active per
  // request when the MATCHED product has a credential pair set. Values (default off):
  //   "off"     — no token check (identical to legacy behavior)
  //   "observe" — verify the bearer token and log a breadcrumb, never reject
  //   "enforce" — reject non-/token requests with 401 when the token is missing/invalid/expired
  HALO_TOKEN_ENFORCE?: string;
}

/**
 * PublicTicketPriority — spec ships integers [0,1,2,3,4] WITHOUT labels.
 * TODO(verify): confirm int->label mapping in the Gorelo UI.
 */
export type PublicTicketPriority = 0 | 1 | 2 | 3 | 4;

/**
 * TicketSource — spec ships integers [1,2,3,4,5,6] WITHOUT labels.
 * TODO(verify): confirm which int is the "integration/portal/API" source in the Gorelo UI.
 */
export type TicketSource = 1 | 2 | 3 | 4 | 5 | 6;

/** Body for POST /v1/tickets. No email field — requires numeric clientId/contactId. */
export interface CreatePublicTicketCommand {
  title: string;
  createdByName: string;
  clientId: number | null;
  locationId: number | null;
  contactId: number | null;
  description: string;
  // statusId is `nullable` in the swagger, but Gorelo's runtime validator REQUIRES it
  // (a create without statusId returns 400) — always send it.
  statusId: number;
  groupId: number; // required (non-nullable)
  typeId: number; // required (non-nullable)
  priorityId: PublicTicketPriority; // required (non-nullable)
  sourceId: TicketSource; // required (non-nullable)
  // CONFIRMED (swagger): array of int64 tag ids. Optional; omitted when unset.
  tagIds?: number[];
  // CONFIRMED (swagger): items are string UUIDs (PublicDeviceResponse.id is a uuid).
  agentAssetIds: string[];
  sendTicketCreatedEmail: boolean;
}

/** POST /v1/tickets response. CONFIRMED (swagger CreatePublicTicketResult): only a uuid. */
export interface CreatePublicTicketResult {
  ticketId: string | null;
}

/** GET /v1/assets/agents item. NOTE: no MAC field exists. `id` is a STRING. */
export interface PublicDeviceResponse {
  id: string;
  name?: string | null;
  displayName?: string | null;
  clientId?: number | null;
  clientLocationId?: number | null;
  serialNo?: string | null;
  uuid?: string | null;
  localIPAddress?: string | null;
  publicIPAddress?: string | null;
  lastLoggedOnUser?: string | null;
  lastLoggedOnUserUpn?: string | null;
  lastBootUpTime?: string | null;
  timeZone?: string | null;
  // Richer hardware/OS detail (present on GET /v1/assets/agents/{id}) — surfaced in
  // the ticket so a tech sees the machine without clicking through.
  os?: string | null;
  osName?: string | null;
  osVersion?: string | null;
  osArchitecture?: string | null;
  hardwareArchitecture?: string | null;
  hardwareType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  cpu?: string | null;
  memory?: string | null;
  disk?: string | null;
}

/** GET /v1/clients item. */
export interface PublicClientResponse {
  id: number;
  name?: string | null;
  domains?: Array<{ domain?: string | null; name?: string | null }> | null;
}

/** GET /v1/contacts?clientid={id} item. */
export interface PublicContactResponse {
  id: number;
  primaryEmail?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  clientId?: number | null;
  clientLocationId?: number | null;
}

/** GET /v1/clients/{clientId}/locations item. */
export interface PublicClientLocationResponse {
  id: number;
  name?: string | null;
  clientId?: number | null;
}
