import type { PressIdentity } from "./types.js";

/** osTicket-shaped inbound fields (all optional/defensive). */
export interface InboundTicket {
  name: string;
  email: string;
  subject: string;
  message: string;
}

/** Tag block appended by the Helpdesk Buttons Dispatcher Rule. */
export interface HdbTag {
  host?: string;
  mac?: string;
  ip?: string;
}

/**
 * The Helpdesk Buttons Dispatcher Rule appends this tag to `msg`. Dispatcher
 * Rules are sandboxed Python 3, so variables are bare names concatenated into
 * the string — NOT `{}` template interpolation. The exact rule to configure is:
 *   msg = msg + '\n\n[[hdb host=' + str(hostname) + ' mac=' + str(mac) + ' ip=' + str(ip) + ']]'
 * which yields e.g.:
 *   [[hdb host=PC-01 mac=AA:BB:CC:DD:EE:FF ip=10.0.0.5]]
 * The parser below is deliberately tolerant of key ordering, extra whitespace,
 * quotes, and missing keys.
 */
const HDB_BLOCK_RE = /\[\[\s*hdb\b([^\]]*)\]\]/i;
const HDB_KV_RE = /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s\]]+)/g;

/** Parse the [[hdb ...]] tag from a message body, if present. */
export function parseHdbTag(message: string): HdbTag {
  const block = HDB_BLOCK_RE.exec(message ?? "");
  if (!block) return {};
  const inner = block[1];
  const tag: HdbTag = {};
  let m: RegExpExecArray | null;
  HDB_KV_RE.lastIndex = 0;
  while ((m = HDB_KV_RE.exec(inner)) !== null) {
    const key = m[1].toLowerCase();
    // value is either quoted (groups 3/4) or bare (whole group 2)
    const value = (m[3] ?? m[4] ?? m[2] ?? "").trim();
    if (key === "host" || key === "hostname") tag.host = value;
    else if (key === "mac") tag.mac = value;
    else if (key === "ip") tag.ip = value;
  }
  return tag;
}

/** Remove the [[hdb ...]] tag from the body so the client-facing description stays clean. */
export function stripHdbTag(message: string): string {
  return (message ?? "")
    .replace(HDB_BLOCK_RE, "")
    // collapse any blank lines / trailing whitespace left behind
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Short-lowercase a hostname: strip domain, lowercase, trim. e.g. "PC-01.corp.local" -> "pc-01". */
export function normalizeHost(host: string | null | undefined): string {
  if (!host) return "";
  return host.trim().toLowerCase().split(".")[0] ?? "";
}

/** Lowercase/trim an email. */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/** Extract the domain part of an email, lowercased. e.g. "a@Corp.com" -> "corp.com". */
export function emailDomain(email: string | null | undefined): string {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf("@");
  return at >= 0 ? e.slice(at + 1) : "";
}

/**
 * Parse an inbound osTicket-shaped request body. Accepts JSON and form-encoded
 * (urlencoded or multipart). Tolerates both `message` and `msg` (Tier2's
 * Dispatcher writes the tagged block to `msg`).
 */
export async function parseInbound(request: Request): Promise<InboundTicket> {
  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  let raw: Record<string, unknown> = {};

  if (ct.includes("application/json")) {
    raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  } else if (
    ct.includes("application/x-www-form-urlencoded") ||
    ct.includes("multipart/form-data")
  ) {
    const form = await request.formData();
    for (const [k, v] of form.entries()) raw[k] = typeof v === "string" ? v : "";
  } else {
    // Unknown/absent content-type: try JSON, then fall back to urlencoded text.
    const text = await request.text();
    try {
      raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
      const params = new URLSearchParams(text);
      for (const [k, v] of params.entries()) raw[k] = v;
    }
  }

  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

  return {
    name: str(raw.name),
    email: str(raw.email),
    subject: str(raw.subject),
    // Prefer `message` (osTicket body), fall back to `msg` (Dispatcher target).
    message: str(raw.message !== undefined && raw.message !== "" ? raw.message : raw.msg),
  };
}

/** Build a normalized press identity from an inbound ticket + parsed tag. */
export function buildIdentity(inbound: InboundTicket, tag: HdbTag): PressIdentity {
  return {
    email: normalizeEmail(inbound.email),
    name: (inbound.name ?? "").trim(),
    host: normalizeHost(tag.host),
    mac: (tag.mac ?? "").trim(),
    ip: (tag.ip ?? "").trim(),
  };
}
