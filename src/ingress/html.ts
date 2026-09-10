// Shared, product-AGNOSTIC text/HTML helpers for the ingress side: value coercion,
// HTML escaping + linkifying, HTML→text flattening, entity decoding, field-dump
// rendering, and the device-detail section. Both the Halo mock (halo.ts) and the
// per-product mappers (mappers/*) build on these; nothing here is specific to a
// particular vendor's payload shape.

import { normalizeEmail } from "../core/parse.js";
import type { DeviceFullRow } from "../core/db.js";
import type { PublicDeviceResponse } from "../core/types.js";
import type { HaloTicket } from "./mappers/types.js";

export const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
export const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n !== 0 ? n : null;
};

export const FIELD_MAX = 2000; // cap any single extra field so one value can't bloat the ticket
export const BODY_MAX = 16000; // generous cap on the whole report body — keep everything, guard only pathological blobs

export function truncate(s: string, max = FIELD_MAX): string {
  return s.length > max ? `${s.slice(0, max)}… [truncated ${s.length - max} chars]` : s;
}

// Gorelo renders the ticket description as HTML (plain newlines collapse), so the
// body is built as HTML: section headers, <br> line breaks, bulleted selections,
// and clickable links. All text values are escaped before interpolation.
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const heading = (title: string): string => `<b>${esc(title)}</b>`;

// Bare http(s) URLs in a free-text body (e.g. Huntress's "Escalation:" link) arrive
// as plain text, so Gorelo renders them unclickable. Match a URL run up to the first
// whitespace/angle-bracket/quote and turn it into an <a>.
export const URL_RE = /https?:\/\/[^\s<>"']+/gi;

/**
 * Escape `text` for HTML AND turn any bare http(s) URL into a clickable link. Escaping
 * and linkifying happen in one pass so URL and non-URL spans are each escaped exactly
 * once (escaping already-built anchor markup would break the href). Trailing sentence
 * punctuation is kept out of the href so "…/818208." links to "…/818208".
 */
export function linkify(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0];
    const start = m.index ?? 0;
    out += esc(text.slice(last, start));
    const trimmed = url.replace(/[.,;:!?)\]}'"]+$/, ""); // don't swallow trailing punctuation
    const href = esc(trimmed);
    out += `<a href="${href}">${href}</a>${esc(url.slice(trimmed.length))}`;
    last = start + url.length;
  }
  out += esc(text.slice(last));
  return out;
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}
export function decodeEntities(s: string): string {
  // Decode `&amp;` LAST: doing it first would let a literal `&lt;` (written
  // `&amp;lt;`) collapse to `<` on a later pass — a double-unescape. By the
  // time `&amp;` runs, no other rule can re-interpret the `&`s it produces.
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&");
}
export function htmlToText(s: string): string {
  // Drop non-content blocks first — a full HTML email (the /actions note) carries
  // <head>/<style> with @font-face/@media rules that otherwise flatten into noise.
  // Match end tags tolerantly (`</script >`, `</script\t\n bar>`): a browser
  // closes on `</script` followed by anything up to the next `>`, so a naive
  // `</script>` would leave the block's contents behind to flatten into the
  // extracted text. `[^>]*>` consumes any trailing junk before the `>`.
  const stripped = s
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<head[\s\S]*?<\/head[^>]*>/gi, " ")
    // Preserve visual line breaks before stripTags collapses every tag to a space:
    // <br> and block-closing tags become newlines, so an HTML-bodied report (e.g. a
    // Huntress alert) keeps its section/line structure instead of flattening into
    // one paragraph. Mirrors the conversion extractSelectionItems already does.
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|table|thead|tbody|section|article|blockquote)\s*>/gi, "\n");
  return decodeEntities(stripTags(stripped))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Pull the requester email out of the explicit fields Halo/Tier2 might use. */
export function requesterEmail(t: HaloTicket): string {
  for (const k of ["emailfrom", "reportedby", "emailaddress", "email", "useremail", "contactemail"]) {
    const v = normalizeEmail(str(t[k]));
    if (v.includes("@")) return v;
  }
  return "";
}

export const nonEmpty = (v: unknown): string => (v == null ? "" : String(v).trim());
/** Join present parts with " · ", escaped. */
export function dot(parts: unknown[]): string {
  return parts
    .map(nonEmpty)
    .filter(Boolean)
    .map((s) => esc(s))
    .join(" · ");
}
/** Offset (ms) of an IANA time zone from UTC at a given instant. */
export function tzOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  const asUtc = Date.UTC(f.year!, (f.month ?? 1) - 1, f.day!, f.hour ?? 0, f.minute ?? 0, f.second ?? 0);
  return asUtc - instant;
}

/**
 * A Gorelo ISO timestamp as a coarse relative age, e.g. "13 hours ago", "7 days ago".
 * Gorelo sends timezone-naive timestamps that are wall-clock in the agent's `tz`; if a
 * tz is given we resolve the real instant through it, else we fall back to UTC.
 */
export function relativeTime(iso: string, tz?: string | null): string {
  if (!iso) return "";
  const hasTz = /[zZ]|[+-]\d\d:?\d\d$/.test(iso);
  let t: number;
  if (hasTz) {
    t = Date.parse(iso);
  } else {
    const asUtc = Date.parse(`${iso}Z`); // wall time read as if UTC
    if (!Number.isFinite(asUtc)) return "";
    // Subtract the zone's offset at that wall time to get the true instant.
    let offset = 0;
    if (tz) {
      try {
        offset = tzOffsetMs(asUtc, tz);
      } catch {
        offset = 0; // unknown zone — treat as UTC
      }
    }
    t = asUtc - offset;
  }
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const suffix = diff >= 0 ? "ago" : "from now";
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 1) return "just now";
  const units: Array<[number, string]> = [
    [60, "minute"],
    [24, "hour"],
    [30, "day"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let value = mins;
  for (const [factor, name] of units) {
    if (value < factor) return `${value} ${name}${value === 1 ? "" : "s"} ${suffix}`;
    value = Math.round(value / factor);
  }
  return `${value} years ${suffix}`;
}

/**
 * The "Device" section — rich hardware/OS detail from the live Gorelo agent record
 * (falling back to the mirror row). This is data HDB keeps behind its portal link.
 */
export function deviceSection(agent: PublicDeviceResponse | null, d: DeviceFullRow | null): string {
  const name = nonEmpty(agent?.displayName) || nonEmpty(agent?.name) || nonEmpty(d?.display_name) || nonEmpty(d?.hostname);
  const os = nonEmpty(agent?.osName) || nonEmpty(agent?.os) || nonEmpty(d?.os);
  const serial = nonEmpty(agent?.serialNo) || nonEmpty(d?.serial);
  const localIp = nonEmpty(agent?.localIPAddress) || nonEmpty(d?.local_ip);
  const pubIp = nonEmpty(agent?.publicIPAddress) || nonEmpty(d?.public_ip);
  if (!name && !serial && !localIp) return "";

  const mem = nonEmpty(agent?.memory) ? `${nonEmpty(agent?.memory)} GB RAM` : "";
  const model = dot([agent?.manufacturer, agent?.model]);
  const lastUser = nonEmpty(agent?.lastLoggedOnUserUpn) || nonEmpty(agent?.lastLoggedOnUser);
  const lastBoot = relativeTime(nonEmpty(agent?.lastBootUpTime), agent?.timeZone);

  const lines = [
    dot([name, os, agent?.osVersion]),
    dot([model, agent?.hardwareArchitecture, agent?.cpu, mem]),
    dot([serial ? `SN ${serial}` : "", localIp ? `Local IP ${localIp}` : "", pubIp ? `Public IP ${pubIp}` : ""]),
    dot([lastUser ? `Last user ${lastUser}` : "", lastBoot ? `Last boot ${lastBoot}` : ""]),
  ].filter(Boolean);
  return lines.length ? `${heading("Device")}<br>${lines.join("<br>")}` : "";
}

/** Render Halo's `customfields` ([{name,value}, …]) as readable lines, not raw JSON. */
export function customFieldLines(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = nonEmpty(o.name ?? o.label ?? o.id);
    if (!name) continue;
    const value = o.value;
    const rendered =
      value == null || value === "" ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    out.push(`${esc(name)}: ${linkify(truncate(rendered))}`);
  }
  return out;
}

// Fields we already surface elsewhere (report body, device line, routing trail, or
// dedicated handling), so they don't need to appear again in the raw-fields dump.
export const DUMP_SKIP = new Set([
  "details_html",
  "details",
  "summary",
  "subject",
  "note_html",
  "note",
  "user_id",
  "client_id",
  "site_id",
  "tickettype_id",
  "assets",
]);

/** Any remaining top-level fields Tier2 sent (beyond what we surface elsewhere). */
export function extraFieldLines(t: HaloTicket): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(t)) {
    if (DUMP_SKIP.has(k) || v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    // customfields is a [{name,value}] array — render each pair, not the JSON blob.
    if (k === "customfields") {
      const fields = customFieldLines(v);
      if (fields.length) lines.push(...fields);
      continue;
    }
    const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`${esc(k)}: ${linkify(truncate(rendered))}`);
  }
  return lines;
}
