import { breadcrumb } from "./log.js";
import type {
  CreatePublicCommentCommand,
  CreatePublicTicketCommand,
  Env,
  PostAlertRequest,
  PublicClientLocationResponse,
  PublicClientResponse,
  PublicContactResponse,
  PublicDeviceResponse,
  PublicTicketListItem,
  PublicTicketListResponse,
  UpdatePublicTicketCommand,
} from "./types.js";

/** Error carrying the upstream Gorelo HTTP status so the handler can surface a 502. */
export class GoreloError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    /**
     * The stable 6-digit failure code (MMTTNN) parsed from the response envelope's
     * `Notifications[]` when present. Since 2026-08 every failure carries one — it
     * is the language-independent identifier to branch/alert on (message text is
     * not). Non-PII, so it is safe to surface in a breadcrumb. `null` when the body
     * carried no envelope/code (e.g. a raw 5xx/proxy error).
     */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "GoreloError";
  }

  /** Build from a raw error body, parsing the first `Notifications[].Code` off it. */
  static fromBody(message: string, status: number, body: string): GoreloError {
    return new GoreloError(message, status, body, firstNotificationCode(body));
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- 2026-08 wire-format bridge -------------------------------------------------
// The Gorelo public API now (a) wraps every response in a standard envelope
// `{ StatusCode, IsSuccess, Data, DataContext, Notifications }`, (b) uses PascalCase
// field names throughout, (c) carries cursor-paging metadata under
// `DataContext.Pagination` (cursors are signed/opaque), and (d) REJECTS request
// bodies with unknown/misspelled fields (400). The relay models everything in
// camelCase, so we camelize responses on the way in and pascalize the create body
// on the way out — a single seam here keeps the rest of the codebase unchanged.

/** Lower-case the first character of a key (PascalCase -> camelCase; camelCase unchanged). */
function camelKey(k: string): string {
  return k.length > 0 ? k[0]!.toLowerCase() + k.slice(1) : k;
}

/** Upper-case the first character of a key (camelCase -> PascalCase). */
function pascalKey(k: string): string {
  return k.length > 0 ? k[0]!.toUpperCase() + k.slice(1) : k;
}

/**
 * Recursively rewrite object keys with `fn`, walking arrays and nested objects.
 * Values (and non-objects) pass through untouched. First-char case flips round-trip
 * cleanly for every field the relay reads/writes (e.g. `LocalIPAddress` <->
 * `localIPAddress`, `SendTicketCreatedEmail` <-> `sendTicketCreatedEmail`).
 */
function rekey(v: unknown, fn: (k: string) => string): unknown {
  if (Array.isArray(v)) return v.map((x) => rekey(x, fn));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[fn(k)] = rekey(val, fn);
    return out;
  }
  return v;
}

/** Gorelo now rejects pageSize outside 1–200 with a 400 (was silently clamped). Clamp here. */
export function clampPageSize(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.min(200, Math.max(1, Math.floor(n)));
}

/** Paging metadata, camelized from `DataContext.Pagination`. */
interface Pagination {
  nextCursor?: string | null;
  previousCursor?: string | null;
  hasMore?: boolean;
  hasPrevious?: boolean;
  totalCount?: number;
}

/** A parsed envelope: the camelized payload plus its paging/notifications. */
interface Unwrapped {
  data: unknown;
  pagination: Pagination | null;
  notifications: GoreloNotification[];
  isSuccess: boolean | null;
}

/** A single `Notifications[]` entry (camelized), carrying the 6-digit `code`. */
export interface GoreloNotification {
  code?: string | null;
  message?: string | null;
  propertyName?: string | null;
  actionHint?: string | null;
  docUrl?: string | null;
}

/**
 * Camelize a parsed Gorelo response and peel the standard envelope: return `Data`
 * as the payload plus any `DataContext.Pagination` and `Notifications`. A bare array
 * or a body without the envelope markers passes through as the payload, so config
 * endpoints (bare arrays) and any pre-envelope shape still parse.
 */
function unwrap(raw: unknown): Unwrapped {
  const v = rekey(raw, camelKey);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const enveloped =
      "data" in o && ("isSuccess" in o || "statusCode" in o || "notifications" in o || "dataContext" in o);
    if (enveloped) {
      const dc = o.dataContext && typeof o.dataContext === "object" ? (o.dataContext as Record<string, unknown>) : null;
      const pg = dc && dc.pagination && typeof dc.pagination === "object" ? (dc.pagination as Pagination) : null;
      return {
        data: o.data,
        pagination: pg,
        notifications: Array.isArray(o.notifications) ? (o.notifications as GoreloNotification[]) : [],
        isSuccess: typeof o.isSuccess === "boolean" ? o.isSuccess : null,
      };
    }
  }
  return { data: v, pagination: null, notifications: [], isSuccess: null };
}

/** Pull the first 6-digit `Notifications[].Code` out of a raw error body, if any. */
export function firstNotificationCode(body: string): string | null {
  if (!body) return null;
  try {
    for (const n of unwrap(JSON.parse(body)).notifications) {
      if (typeof n?.code === "string" && /^\d{6}$/.test(n.code)) return n.code;
    }
  } catch {
    // non-JSON / unparseable body — no code to surface.
  }
  return null;
}

/**
 * Strip trailing '/' characters in a single linear scan. A regex like
 * `/\/+$/` backtracks quadratically on inputs with long runs of slashes, so
 * we walk back from the end by hand instead — O(n) regardless of the input.
 */
export function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return s.slice(0, end);
}

const MAX_RETRY_WAIT_MS = 15_000; // cap any single backoff so a sync can't hang

/**
 * How long to wait before retrying a transient (429/5xx) response. Honors the
 * server's `Retry-After` (delta-seconds or HTTP-date) when present — the fixed
 * exponential schedule was often shorter than Gorelo's actual rate-limit window,
 * so attempts exhausted and the fetch failed. Falls back to exponential backoff
 * with jitter to avoid a thundering herd of retries realigning under load.
 */
export function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0) * 1000, MAX_RETRY_WAIT_MS);
    const when = Date.parse(ra); // HTTP-date form
    if (!Number.isNaN(when)) return Math.min(Math.max(when - Date.now(), 0), MAX_RETRY_WAIT_MS);
  }
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000); // 0.5,1,2,4,8s (capped)
  return base + Math.floor(Math.random() * 250); // jitter
}

/** Thin, dependency-free Gorelo API client. Keeps the API key out of logs. */
export class GoreloClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(env: Env) {
    this.baseUrl = stripTrailingSlashes(env.GORELO_BASE_URL);
    this.apiKey = env.GORELO_API_KEY;
  }

  private async request(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "X-API-Key": this.apiKey,
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  }

  /**
   * GET with retry/backoff on 429/5xx (used by the off-request-path sync).
   * Never logs the request headers (they carry the API key).
   */
  private async getJsonWithRetry<T>(path: string, maxAttempts = 4): Promise<T> {
    let attempt = 0;
    let lastStatus = 0;
    let lastBody = "";
    while (attempt < maxAttempts) {
      const res = await this.request(path, { method: "GET" });
      if (res.ok) return (await res.json()) as T;
      lastStatus = res.status;
      lastBody = await res.text().catch(() => "");
      // Retry only transient failures.
      if (res.status === 429 || res.status >= 500) {
        attempt += 1;
        if (attempt < maxAttempts) {
          await sleep(retryDelayMs(res, attempt));
          continue;
        }
      }
      break;
    }
    throw GoreloError.fromBody(`GET ${path} failed`, lastStatus, lastBody);
  }

  /**
   * Fetch every record from a cursor-paginated list endpoint (Gorelo's 2026-07-24
   * API change: `/v1/assets/agents`, `/v1/clients`, `/v1/contacts` now return a
   * `{ data, nextCursor, hasMore }` envelope and default to 50 rows/page, so a
   * single GET no longer returns the whole set). Requests a large page to keep the
   * page count (and thus subrequests, bounded by the Worker's ~50/invocation cap)
   * low, then follows `nextCursor` until drained. Still tolerates a bare array /
   * `{items|results|value}` shape for endpoints that haven't been paginated.
   * `maxPages` is a runaway guard; hitting it is logged, never silent.
   */
  private async getAllPages<T>(path: string, pageSize = 200, maxPages = 25): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= maxPages; page++) {
      const qs = new URLSearchParams({ pageSize: String(clampPageSize(pageSize)) });
      if (cursor) qs.set("cursor", cursor);
      const raw = await this.getJsonWithRetry<unknown>(`${path}${sep}${qs.toString()}`);
      if (Array.isArray(raw)) {
        out.push(...(raw as T[])); // not (yet) paginated — bare array
        return out;
      }
      // Since 2026-08, paging lives in DataContext.Pagination (signed cursors); the
      // page rows are the envelope's Data. unwrap() camelizes both.
      const env = unwrap(raw);
      const items = asArray<T>(env.data);
      out.push(...items);
      cursor = env.pagination?.nextCursor ?? null;
      const more = env.pagination?.hasMore ?? (cursor != null && items.length > 0);
      if (!more || !cursor) return out;
      if (page === maxPages) {
        breadcrumb(`Gorelo paged ${path}: stopped at ${maxPages} pages (${out.length} rows) with more remaining`);
      }
    }
    return out;
  }

  /**
   * GET /v1/assets/agents — the whole agent fleet. Cursor-paginated since
   * 2026-07-24 (was a bare array); getAllPages follows the cursor to fetch all.
   */
  async listAgents(): Promise<PublicDeviceResponse[]> {
    return this.getAllPages<PublicDeviceResponse>("/v1/assets/agents");
  }

  /**
   * GET /v1/assets/agents/{id} — the full agent record (rich hardware/OS detail).
   * Best-effort: returns null on any failure so ticket creation never blocks on it.
   */
  async getAgent(id: string): Promise<PublicDeviceResponse | null> {
    try {
      const res = await this.request(`/v1/assets/agents/${encodeURIComponent(id)}`, { method: "GET" });
      if (!res.ok) return null;
      // Single-object endpoint: the device sits under the envelope's Data (camelized).
      return (unwrap(await res.json()).data as PublicDeviceResponse | null) ?? null;
    } catch {
      return null;
    }
  }

  /** GET /v1/clients — all clients + their domains. Cursor-paginated since 2026-07-24. */
  async listClients(): Promise<PublicClientResponse[]> {
    return this.getAllPages<PublicClientResponse>("/v1/clients");
  }

  /**
   * GET /v1/contacts — ALL contacts (the `clientId` filter is optional; each row
   * carries its own clientId/locationId). The sync uses this instead of one
   * call per client. Cursor-paginated since 2026-07-24, so getAllPages follows the
   * cursor across pages (a large page size keeps the page/subrequest count low).
   */
  async listAllContacts(): Promise<PublicContactResponse[]> {
    return this.getAllPages<PublicContactResponse>("/v1/contacts");
  }

  /** GET /v1/clients/{clientId}/locations — sites for one client. */
  async listLocations(clientId: number): Promise<PublicClientLocationResponse[]> {
    const raw = await this.getJsonWithRetry<unknown>(
      `/v1/clients/${encodeURIComponent(String(clientId))}/locations`,
    );
    // Enveloped list (single page — no cursor param on this endpoint): rows are Data.
    return asArray<PublicClientLocationResponse>(unwrap(raw).data);
  }

  /**
   * POST /v1/alerts/ — Gorelo's native external-alert endpoint. Throws GoreloError
   * (with upstream status + notification code) on non-2xx so the handler can return
   * 502. The response is a boolean success envelope with no id, so there's nothing to
   * return — success is "did not throw". Body is pascalized like the ticket create.
   */
  async postAlert(req: PostAlertRequest): Promise<void> {
    const res = await this.request("/v1/alerts/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rekey(req, pascalKey)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw GoreloError.fromBody("POST /v1/alerts/ failed", res.status, body);
    }
  }

  /**
   * POST /v1/tickets. Throws GoreloError (with upstream status) on non-2xx so the
   * handler can return 502. Returns the raw parsed response for the caller to
   * extract the ticket number defensively.
   */
  async createTicket(cmd: CreatePublicTicketCommand): Promise<unknown> {
    const res = await this.request("/v1/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 2026-08: Gorelo requires PascalCase request fields and rejects unknown/
      // misspelled ones with a 400. The relay models the command in camelCase and
      // only ever sets documented CreatePublicTicketCommand fields, so pascalizing
      // its keys yields exactly the accepted field set (no stray field introduced).
      body: JSON.stringify(rekey(cmd, pascalKey)),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw GoreloError.fromBody("POST /v1/tickets failed", res.status, body);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return body;
    }
    // Peel the envelope so the caller reads the create result ({ id }) directly.
    return unwrap(parsed).data ?? parsed;
  }

  /**
   * PATCH /v1/tickets/{ticketId} — a genuine partial update, added to the Gorelo API
   * after this client's original "create-only" assumption was written (confirmed live
   * 2026-09-10). The relay only ever sends `statusId` (closing the original ticket on
   * a Huntress resolution — see handleResolution in ingress/halo.ts). Throws
   * GoreloError on non-2xx so the caller can fall back / queue a retry.
   */
  async updateTicket(ticketId: string, patch: UpdatePublicTicketCommand): Promise<void> {
    const res = await this.request(`/v1/tickets/${encodeURIComponent(ticketId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rekey(patch, pascalKey)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw GoreloError.fromBody(`PATCH /v1/tickets/${ticketId} failed`, res.status, body);
    }
  }

  /**
   * POST /v1/tickets/{ticketId}/comments — a Public (main-thread) comment; `body` is
   * HTML. Throws GoreloError on non-2xx.
   */
  async addTicketComment(ticketId: string, bodyHtml: string): Promise<void> {
    const cmd: CreatePublicCommentCommand = { conversationTypeId: 1, body: bodyHtml };
    const res = await this.request(`/v1/tickets/${encodeURIComponent(ticketId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rekey(cmd, pascalKey)),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw GoreloError.fromBody(`POST /v1/tickets/${ticketId}/comments failed`, res.status, body);
    }
  }

  /**
   * GET /v1/tickets — the paged ticket list (added to the Gorelo public API in
   * 2026-07). Cursor-paginated; defaults mirror the swagger (pageSize 50, newest
   * `updatedOn` first). Used to read a ticket's human number back after a create
   * (see resolveTicketNumber) — there is no GET /v1/tickets/{id}.
   */
  async listTickets(
    params?: {
      cursor?: string;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: string;
    },
    maxAttempts = 4,
  ): Promise<PublicTicketListResponse> {
    const qs = new URLSearchParams();
    if (params?.cursor) qs.set("cursor", params.cursor);
    // pageSize outside 1–200 is now a 400 (was silently clamped); sortBy/sortOrder
    // outside the documented values are also rejected. Callers already pass valid
    // sort values; clamp pageSize defensively so a bad caller can't trip the 400.
    if (params?.pageSize != null) qs.set("pageSize", String(clampPageSize(params.pageSize)));
    if (params?.sortBy) qs.set("sortBy", params.sortBy);
    if (params?.sortOrder) qs.set("sortOrder", params.sortOrder);
    const q = qs.toString();
    const raw = await this.getJsonWithRetry<unknown>(`/v1/tickets${q ? `?${q}` : ""}`, maxAttempts);
    // Flatten the envelope into the relay's normalized shape: rows from Data, paging
    // hoisted from DataContext.Pagination back to the top level callers already read.
    const env = unwrap(raw);
    const pg = env.pagination ?? {};
    return {
      data: asArray<PublicTicketListItem>(env.data),
      totalCount: pg.totalCount,
      nextCursor: pg.nextCursor ?? null,
      previousCursor: pg.previousCursor ?? null,
      hasMore: pg.hasMore,
      hasPrevious: pg.hasPrevious,
    };
  }

  /**
   * Read a ticket's human-facing number back from its create-response GUID. The
   * create returns only the `id` (a UUID); the number/displayNumber live on the
   * GET /v1/tickets list items. A just-created ticket sorts to the top by
   * createdOn, so we scan the first page and match by id. Best-effort: returns
   * null on any miss/failure so surfacing the number never blocks ticket creation.
   */
  async resolveTicketNumber(
    id: string,
    pageSize = 50,
  ): Promise<{ number: number | null; displayNumber: string | null } | null> {
    if (!id) return null;
    try {
      // Runs inline in the create response path, so bound the retries (one quick
      // retry) — a slow rate-limit backoff would delay the caller for a value we
      // treat as best-effort anyway.
      const page = await this.listTickets({ sortBy: "createdOn", sortOrder: "desc", pageSize }, 2);
      const match = (page.data ?? []).find((t: PublicTicketListItem) => t.id === id);
      if (!match) return null;
      return { number: match.number ?? null, displayNumber: match.displayNumber ?? null };
    } catch {
      return null;
    }
  }
}

/** Accept a bare array or a common { items|data|results: [...] } envelope. */
function asArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["items", "data", "results", "value"]) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

/**
 * Extract the created ticket's GUID from a POST /v1/tickets response. Since 2026-08
 * the create result is wrapped in the standard envelope; `createTicket` already
 * peels it, so the value passed here is the camelized `CreatePublicTicketResult`
 * (`{ "id": "<uuid>" }`) — a GUID, not a human ticket number. The Halo mock uses
 * this uuid to correlate the created ticket, log it, and read the human
 * number/displayNumber back via GET /v1/tickets (GoreloClient.resolveTicketNumber).
 * `id` is checked first; `ticketId` (the earlier field name) and the rest are
 * defensive fallbacks so a spec revert or envelope shape still resolves.
 */
export function extractTicketNumber(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["id", "ticketId", "ticketNumber", "number"]) {
      const v = obj[key];
      if (typeof v === "string" || typeof v === "number") return String(v);
    }
    // Some APIs nest under { data: {...} } / { ticket: {...} }.
    for (const key of ["data", "ticket", "result"]) {
      const nested = obj[key];
      if (nested && typeof nested === "object") {
        const found = extractTicketNumber(nested);
        if (found) return found;
      }
    }
  }
  return null;
}
