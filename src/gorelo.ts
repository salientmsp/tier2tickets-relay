import type {
  CreatePublicTicketCommand,
  Env,
  PublicClientLocationResponse,
  PublicClientResponse,
  PublicContactResponse,
  PublicDeviceResponse,
} from "./types.js";

/** Error carrying the upstream Gorelo HTTP status so the handler can surface a 502. */
export class GoreloError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "GoreloError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Strip trailing slashes with a linear scan. A regex like `/\/+$/` backtracks
 * super-linearly on inputs that are many slashes, so we walk from the end
 * instead — constant space, O(n) time, no ReDoS surface.
 */
function stripTrailingSlashes(s: string): string {
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
    throw new GoreloError(`GET ${path} failed`, lastStatus, lastBody);
  }

  /**
   * GET /v1/assets/agents — the whole agent fleet.
   * CONFIRMED (swagger): returns a bare array with no query params / pagination.
   * asArray still tolerates an envelope defensively.
   */
  async listAgents(): Promise<PublicDeviceResponse[]> {
    const raw = await this.getJsonWithRetry<unknown>("/v1/assets/agents");
    return asArray<PublicDeviceResponse>(raw);
  }

  /**
   * GET /v1/assets/agents/{id} — the full agent record (rich hardware/OS detail).
   * Best-effort: returns null on any failure so ticket creation never blocks on it.
   */
  async getAgent(id: string): Promise<PublicDeviceResponse | null> {
    try {
      const res = await this.request(`/v1/assets/agents/${encodeURIComponent(id)}`, { method: "GET" });
      if (!res.ok) return null;
      return (await res.json()) as PublicDeviceResponse;
    } catch {
      return null;
    }
  }

  /** GET /v1/clients — all clients + their domains (no query params). */
  async listClients(): Promise<PublicClientResponse[]> {
    const raw = await this.getJsonWithRetry<unknown>("/v1/clients");
    return asArray<PublicClientResponse>(raw);
  }

  /**
   * GET /v1/contacts — ALL contacts in one call (the `clientid` filter is
   * optional; each row carries its own clientId/clientLocationId). The sync uses
   * this instead of one call per client, collapsing N per-client fetches into a
   * single subrequest to stay under the Worker's per-invocation subrequest cap.
   */
  async listAllContacts(): Promise<PublicContactResponse[]> {
    const raw = await this.getJsonWithRetry<unknown>("/v1/contacts");
    return asArray<PublicContactResponse>(raw);
  }

  /** GET /v1/clients/{clientId}/locations — sites for one client. */
  async listLocations(clientId: number): Promise<PublicClientLocationResponse[]> {
    const raw = await this.getJsonWithRetry<unknown>(
      `/v1/clients/${encodeURIComponent(String(clientId))}/locations`,
    );
    return asArray<PublicClientLocationResponse>(raw);
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
      body: JSON.stringify(cmd),
    });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      throw new GoreloError("POST /v1/tickets failed", res.status, body);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return body;
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
 * Extract the ticket identifier from a POST /v1/tickets response.
 * CONFIRMED (swagger CreatePublicTicketResult): the response is
 * `{ "ticketId": "<uuid>" }` — a GUID, not a human ticket number (Gorelo's
 * public API exposes no ticket-number field and no GET-ticket endpoint). The
 * Halo mock uses this uuid to correlate the created ticket and log it.
 * `ticketId` is checked first; the rest are defensive fallbacks.
 */
export function extractTicketNumber(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const key of ["ticketId", "ticketNumber", "number", "id"]) {
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
