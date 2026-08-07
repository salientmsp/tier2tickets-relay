// Hand-written subset of the Gorelo public API types actually used by this relay.
// Ground truth: https://api.usw.gorelo.io/swagger/v1/swagger.json
// (Verify against the live spec before deploy — see the runtime-verify checklist in README.)
//
// NOTE (2026-08 API): Gorelo now wraps every response in a standard envelope
// `{ StatusCode, IsSuccess, Data, DataContext, Notifications }`, uses PascalCase
// field names, and carries paging under `DataContext.Pagination`. These types stay
// in the relay's camelCase model: `src/gorelo.ts` camelizes responses (and unwraps
// the envelope) on the way in and pascalizes the create body on the way out, so the
// shapes below describe the payload AFTER that bridge — not the raw wire format.

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
  // Gorelo status id used for a Huntress-resolution notice (see handleCreateTicket).
  // Huntress signals a resolution by EDITING the original ticket to its configured
  // "Status after Huntress Resolution"; Gorelo has no ticket-update API, so we file a
  // labeled resolution ticket in this status instead. Unset -> falls back to
  // DEFAULT_STATUS_ID (notice still lands, just not in a closed status).
  DEFAULT_RESOLVED_STATUS_ID?: string; // int as string
  DEFAULT_PRIORITY: string; // PublicTicketPriority int as string
  DEFAULT_SOURCE: string; // TicketSource int as string
  CATCHALL_CLIENT_ID: string; // int as string
  // Per-product "Submitted via …" tags (resolved via each product's tagVar in
  // src/products.ts). A ticket is tagged with its product's tag; a product with no
  // configured tag (or a newly onboarded one) falls back to FALLBACK_TAG_ID so nothing
  // is left untagged. Each is a Gorelo tag id (int as string); unset skips that tag.
  HDB_TAG_ID?: string; // tag applied to Helpdesk Buttons tickets ("Submitted VIA HDB")
  HUNTRESS_TAG_ID?: string; // tag applied to Huntress tickets ("Submitted via Huntress")
  // Catch-all tag applied when a ticket's product has no tag of its own (e.g. a service
  // onboarded before its dedicated tag is wired up) — "Submitted via API".
  FALLBACK_TAG_ID?: string;
  EMERGENCY_PRIORITY?: string; // priority id for a press flagged "This is an emergency"
  // "true" asks Gorelo to send its "ticket created" email — but ONLY when the Worker
  // resolved a real client contact (contactId), so the mail never fires on the
  // catch-all/no-contact fallback. Any other value (or unset) suppresses it.
  SEND_TICKET_CREATED_EMAIL?: string;
  DEBUG_LOGS?: string; // "true" enables verbose HALO CAPTURE/RESPONSE body logging (PII)

  // --- Monitoring alerts endpoint (POST /v1/alerts) ---------------------------
  // Each alert "source" (a customer) has its OWN shared secret bound to its OWN IP
  // allowlist: a request must present the source's secret AND originate from that
  // source's IP(s), so one customer's secret is useless from another's network.
  //
  // ALERT_SOURCES is a comma/space-separated list of source keys (unset => the single
  // built-in `default`). Per key the credential pair is resolved by name (see
  // src/alerts.ts sourceVars): `default` -> ALERT_SHARED_SECRET + ALERT_ALLOWED_IPS;
  // any other key `<k>` -> ALERT_SECRET_<K> (secret) + ALERT_IPS_<K> (var), with the
  // key upper-cased and non-alphanumerics replaced by `_`. Those per-source vars are
  // read dynamically by name, so onboarding a customer needs no code/type change —
  // just set the two vars and add the key to ALERT_SOURCES.
  ALERT_SOURCES?: string;
  // `default` source: exact IPs and/or IPv4 CIDR ranges (comma/space/newline separated)
  // permitted to POST alerts (matched via CF-Connecting-IP). Enforced only when
  // ENFORCE_IP_ALLOWLIST is on; empty while enforced => the source is rejected.
  ALERT_ALLOWED_IPS?: string;
  // Optional Gorelo client id alerts are raised against (PostAlertRequest.ClientId).
  // Unset => resolve the alert's `customer` against the client mirror by exact name,
  // then the alert's `host` against a mirrored device, else CATCHALL_CLIENT_ID.
  ALERT_CLIENT_ID?: string; // int as string
  // Severity->AlertLevel is a fixed, hardcoded mapping (Gorelo's level enum is not
  // tenant-customizable) — see alertLevel() in src/alerts.ts. No env override.

  // secrets (wrangler secret put ...)
  GORELO_API_KEY: string; // X-API-Key sent to Gorelo
  ADMIN_KEY: string; // gates POST /admin/sync
  // Optional notifly (Apprise-style) URLs alerted when a ticket is dead-lettered.
  // Comma/space/newline separated, e.g. "ntfy://alerts, msteams://…, slack://…".
  NOTIFLY_URLS?: string;
  // Shared secret for the `default` alert source (POST /v1/alerts). Accepted as
  // `Authorization: Bearer <secret>` (preferred) or `X-Alert-Key: <secret>`; valid only
  // from an ALERT_ALLOWED_IPS address. Unset => the default source can't authenticate.
  // Additional per-customer secrets are set as ALERT_SECRET_<KEY> (read dynamically).
  ALERT_SHARED_SECRET?: string;

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

/**
 * AlertLevel — Gorelo's alert severity enum, integers [1,2,3,4]. Confirmed against the
 * Gorelo alerts UI: 1 = Critical (2 = Error/High, 3 = Warning, 4 = Info/Low). The enum
 * is fixed (not tenant-customizable); the relay's severity->level mapping lives in
 * alertLevel() (src/alerts.ts).
 */
export type AlertLevel = 1 | 2 | 3 | 4;

/**
 * Body for Gorelo's native alert endpoint, POST /v1/alerts/ ("Posts an external alert
 * against a client"). Modeled camelCase; GoreloClient pascalizes it on the way out
 * (Name/ClientId/Resource/Severity/Description). Required: name, clientId, resource.
 * The response is a boolean success envelope — there is NO alert id, and no
 * update/close/GET, so alert dedup + the open→resolved lifecycle are owned by the relay.
 */
export interface PostAlertRequest {
  name: string; // alert title
  clientId: number; // the client the alert relates to
  resource: string; // host/service the alert is raised for (e.g. "SPH-RVR-SQL01")
  severity?: AlertLevel;
  description?: string; // free-text detail
}

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

/**
 * POST /v1/tickets response. CONFIRMED (live swagger CreatePublicTicketResult):
 * `{ "id": "<uuid>" }` — the created ticket's GUID (NOT a human ticket number).
 * The human `number`/`displayNumber` is read back via GET /v1/tickets by matching
 * this `id` (see GoreloClient.resolveTicketNumber). Was `{ ticketId }` in an
 * earlier spec revision; `extractTicketNumber` still tolerates the old field.
 */
export interface CreatePublicTicketResult {
  id: string | null;
}

/**
 * GET /v1/tickets item (subset of PublicTicketListItemModel actually read here).
 * `id` is the ticket GUID (matches the create response); `number` is the numeric
 * ticket number and `displayNumber` its formatted form — the human-facing values.
 */
export interface PublicTicketListItem {
  id: string;
  number?: number | null;
  displayNumber?: string | null;
  title?: string | null;
  clientId?: number | null;
  contactId?: number | null;
}

/**
 * GET /v1/tickets — the relay's NORMALIZED list shape. On the wire (2026-08) the
 * rows are the envelope's `Data` and the paging fields live under
 * `DataContext.Pagination`; GoreloClient.listTickets flattens both back to this
 * top-level shape the relay already consumed.
 */
export interface PublicTicketListResponse {
  data?: PublicTicketListItem[] | null;
  totalCount?: number;
  nextCursor?: string | null;
  previousCursor?: string | null;
  hasMore?: boolean;
  hasPrevious?: boolean;
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
  // Web domains (PublicClientWebDomainResponse): the domain string is `name`
  // (camelized from `Name`). Not consumed by the sync today; kept for reference.
  domains?: Array<{ name?: string | null }> | null;
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
