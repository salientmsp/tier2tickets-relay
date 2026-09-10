// Helpdesk Buttons / Tier2Tickets mapper — the original integration's payload shape.
//
// Tier2 files every press under a hardcoded catch-all user; the REAL reporter identity
// (email, hostname, name) lives only in the "Report Summary" <td>Label:</td><td>Value</td>
// table inside details_html, so this mapper parses that table out to feed routing, and
// renders the report as the ticket body. A payload WITHOUT that table (a free-text
// product such as Huntress) parses to an empty report and cleanly falls through to the
// free-text body path — which is why Huntress reuses this same mapper (no genuine
// divergence: the report-table vs free-text branch is data-driven, not product-driven).

import {
  BODY_MAX,
  deviceSection,
  decodeEntities,
  esc,
  extraFieldLines,
  heading,
  htmlToText,
  linkify,
  requesterEmail,
  str,
  stripTags,
  truncate,
} from "../html.js";
import { normalizeEmail, normalizeHost } from "../../core/parse.js";
import type { HaloTicket, MapperDeviceContext, ParsedInbound, ProductMapper } from "./types.js";

// Tier2 files every press under the hardcoded `unregistered@helpdeskbuttons.com` user
// (-> a synthetic id + catch-all client). The catch-all address is skipped when
// harvesting the real reporter email from the report.
export const HALO_UNREGISTERED_EMAIL = "unregistered@helpdeskbuttons.com";
// Synthetic id for the unregistered catch-all user. Non-zero (Halo user ids are
// positive) and high enough not to collide with a real Gorelo contact id; on
// ticket create it resolves to no contact -> catch-all client.
export const HALO_UNREGISTERED_USER_ID = 999_999_999;

/** Extract the `<td>Label:</td><td>Value</td>` pairs from the report table. */
function parseReport(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!html) return out;
  const re = /<td[^>]*>\s*([^<:]+?)\s*:\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = m[1]!.trim().toLowerCase();
    const value = decodeEntities(stripTags(m[2]!)).trim();
    if (label && value && !(label in out)) out[label] = value;
  }
  return out;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** The reporter email: the labeled report field first, else the first non-catch-all address. */
function reportEmail(report: Record<string, string>, html: string): string {
  const labeled = normalizeEmail(report.email ?? "");
  if (labeled.includes("@") && labeled !== HALO_UNREGISTERED_EMAIL) return labeled;
  for (const m of html.matchAll(EMAIL_RE)) {
    const e = normalizeEmail(m[0]);
    if (e && e !== HALO_UNREGISTERED_EMAIL) return e;
  }
  return "";
}

/** Ordered label/value pairs from the report table, original casing preserved. */
function parseReportPairs(html: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const re = /<td[^>]*>\s*([^<:]+?)\s*:\s*<\/td>\s*<td[^>]*>\s*([\s\S]*?)\s*<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = m[1]!.trim();
    const value = decodeEntities(stripTags(m[2]!)).replace(/\s+/g, " ").trim();
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** Split the Selections value cell into individual items (handles <br>/list markup). */
function extractSelectionItems(html: string): string[] {
  const m = /Selections\s*:?\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i.exec(html);
  if (!m) return [];
  return m[1]!
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr)\s*>/gi, "\n")
    .split("\n")
    .map((s) => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// Default HDB selections (every press has them) — removed as substrings so they go
// whether the report lists them separately or concatenated into one string.
const DEFAULT_SELECTION_RES = [
  /connect directly to my computer as soon as (?:available|possible)/gi,
  /this affects only me/gi,
];
function cleanSelection(item: string): string {
  let out = item;
  for (const re of DEFAULT_SELECTION_RES) out = out.replace(re, "");
  return out.replace(/\s{2,}/g, " ").replace(/^[\s;,.·•-]+|[\s;,.·•-]+$/g, "").trim();
}

/** The non-default selections a user actually chose (empty if only defaults). */
function chosenSelections(html: string, pairs: Array<{ label: string; value: string }>): string[] {
  let items = extractSelectionItems(html);
  if (!items.length) {
    const pair = pairs.find((p) => p.label.toLowerCase() === "selections");
    if (pair) items = [pair.value];
  }
  return items.map(cleanSelection).filter(Boolean);
}

/** The Helpdesk Buttons mapper singleton. */
export const helpdeskButtonsMapper: ProductMapper = {
  key: "helpdeskButtons",

  parse(t: HaloTicket): ParsedInbound {
    const html = str(t.details_html) || str(t.details);
    const report = parseReport(html);
    const email = requesterEmail(t) || reportEmail(report, html);
    const hostname = normalizeHost(report.hostname ?? "");
    // A press flagged as an emergency bumps the ticket priority.
    const isEmergency = /this is an emergency/i.test(html);
    const reporterName = report.name ?? "";
    return { email, hostname, isEmergency, reporterName, report };
  },

  /** Build the ticket description as HTML: report + extra fields + device. */
  buildDescription(t: HaloTicket, device: MapperDeviceContext, bodyHeading: string): string {
    const raw = str(t.details_html) || str(t.details) || str(t.summary);
    const sections: string[] = [];

    // Body section — one line per report field (non-default selections as bullets) for
    // Tier2's HDB report, or the plain details for a product that sends free text. The
    // heading follows the product (Tier2 "Report Summary", else e.g. "Details").
    const pairs = parseReportPairs(raw);
    const rows = pairs
      .filter((p) => p.label.toLowerCase() !== "selections")
      .map((p) => `${esc(p.label)}: ${linkify(truncate(p.value))}`);
    const sels = chosenSelections(raw, pairs);
    if (sels.length) {
      rows.push(`Selections:<br>${sels.map((s) => `&nbsp;&bull; ${esc(s)}`).join("<br>")}`);
    }
    const report = rows.length
      ? rows.join("<br>")
      : linkify(truncate(htmlToText(raw), BODY_MAX)).replace(/\n/g, "<br>");
    sections.push(`${heading(bodyHeading)}<br>${report}`);

    // Any other submitted fields (rarely present after trimming the routing ids).
    const extras = extraFieldLines(t);
    if (extras.length) sections.push(`${heading("Other fields")}<br>${extras.join("<br>")}`);

    // Device hardware (rich detail from the live Gorelo agent record).
    const dev = deviceSection(device.agent, device.device);
    if (dev) sections.push(dev);

    // (Routing outcome — client/contact/location/asset — is logged, not shown in the
    // ticket; the asset is already attached as a real Gorelo asset.)
    return sections.join("<br><br>");
  },
};
