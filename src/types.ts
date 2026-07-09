// Hand-written subset of the Gorelo public API types actually used by this relay.
// Ground truth: https://api.usw.gorelo.io/swagger/v1/swagger.json
// (Verify against the live spec before deploy — see the runtime-verify checklist in README.)

/** Worker environment: wrangler.toml [vars] + D1 binding + CLI secrets. */
export interface Env {
  DB: D1Database;

  // vars
  GORELO_BASE_URL: string;
  ENFORCE_IP_ALLOWLIST: string; // "true" | "false"
  DEFAULT_GROUP_ID: string; // int as string
  DEFAULT_TYPE_ID: string; // int as string
  DEFAULT_STATUS_ID: string; // int as string (REQUIRED by Gorelo's validator)
  DEFAULT_PRIORITY: string; // PublicTicketPriority int as string
  DEFAULT_SOURCE: string; // TicketSource int as string
  CATCHALL_CLIENT_ID: string; // int as string
  HDB_TAG_ID?: string; // Gorelo tag id applied to every HDB ticket ("Submitted VIA HDB")
  EMERGENCY_PRIORITY?: string; // priority id for a press flagged "This is an emergency"
  DEBUG_LOGS?: string; // "true" enables verbose HALO CAPTURE/RESPONSE body logging (PII)

  // secrets (wrangler secret put ...)
  GORELO_API_KEY: string; // X-API-Key sent to Gorelo
  ADMIN_KEY: string; // gates POST /admin/sync

  // optional Halo mock OAuth credentials (Tier2's client_id/client_secret).
  // If both set, the token endpoint validates them; otherwise any creds are accepted.
  HALO_CLIENT_ID?: string;
  HALO_CLIENT_SECRET?: string;
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
