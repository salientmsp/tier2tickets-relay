import { breadcrumb } from "./log.js";
import type { Env } from "./types.js";

/**
 * A source product whose Halo integration posts into this relay. Access is
 * gated by matching the request's `CF-Connecting-IP` against the product's exact
 * IPs or CIDR ranges. Each product is toggled by its own `ENABLE_*` env flag
 * (`enableVar`); `defaultEnabled` is the value used when that flag is unset.
 */
export interface Product {
  key: string;
  label: string;
  enableVar: keyof Env; // the "ENABLE_*" var that toggles this product
  defaultEnabled: boolean; // value when enableVar is unset/empty
  ips: Set<string>; // exact source IPs
  cidrs: string[]; // IPv4 CIDR ranges ("a.b.c.d/len")
  // Optional second gate: a case-insensitive substring the request's User-Agent
  // must contain. IP membership is ALWAYS required; when userAgent is set the UA
  // must ALSO match (IP AND UA). Left undefined => IP-only (no UA requirement).
  // UA is client-controlled/spoofable, so it only tightens an IP-passing request,
  // never widens access.
  userAgent?: string;

  // Optional per-product Halo OAuth credentials, resolved from these Env vars. Each
  // product authenticates with its OWN client_id (Tier2's tenant credential, Huntress's
  // fixed client_id), so a single shared pair can't token-enforce more than one product
  // (issue #51). When BOTH vars resolve to non-empty values, this product's `/token`
  // calls are validated against them and its resource requests are token-enforced (per
  // HALO_TOKEN_ENFORCE); when either is missing the product stays lenient (any creds
  // accepted, no enforcement), preserving pre-per-product behavior during rollout. The
  // secret var MUST be set via `wrangler secret put`, never committed to wrangler.toml.
  clientIdVar?: keyof Env; // Env var holding this product's OAuth client_id
  clientSecretVar?: keyof Env; // Env secret holding this product's client_secret

  // Ticket-create behavior. Tier2 posts /tickets then a separate /actions note, so
  // the Gorelo create is DEFERRED to fold the note in. One-shot products (Huntress)
  // send the whole ticket in the create and never post /actions, so their create
  // fires immediately (deferCreate=false).
  deferCreate: boolean;
  // Submitter-name fallback for a ticket from this product when no contact resolves.
  ticketCreatedBy: string;
  // Heading over the pasted ticket body (Tier2 uses Helpdesk-Buttons "Report Summary").
  ticketBodyHeading: string;
}

/**
 * Registry of known source products. To onboard a product: add its exact IPs
 * and/or CIDR ranges here with an `ENABLE_<KEY>` flag (also declared on Env and
 * documented in wrangler.toml). NOTE: allowlisting a product's IPs is only the
 * doorman — the downstream ticket-building path (buildHaloDescription / HDB
 * report parsing) is still Tier2/Helpdesk-Buttons-shaped, so a newly enabled
 * product needs its own field handling before it produces correct Gorelo
 * tickets. `matchProduct` returns the matched product precisely so that handling
 * can branch on it later.
 */
export const PRODUCTS: Record<string, Product> = {
  // Tier2Tickets / Helpdesk Buttons cloud — the original integration. On by default.
  tier2: {
    key: "tier2",
    label: "Tier2Tickets / Helpdesk Buttons",
    enableVar: "ENABLE_TIER2",
    defaultEnabled: true,
    ips: new Set(["34.202.14.153", "3.209.57.193"]),
    cidrs: [],
    // Tier2 keeps the original global HALO_CLIENT_ID/HALO_CLIENT_SECRET pair — no
    // migration needed for the existing deployment.
    clientIdVar: "HALO_CLIENT_ID",
    clientSecretVar: "HALO_CLIENT_SECRET",
    deferCreate: true, // two-step: /tickets then /actions note folds in before the create
    ticketCreatedBy: "Helpdesk Buttons",
    ticketBodyHeading: "Report Summary",
  },
  // Huntress — additional source IPs + /28 ranges. Opt-in (off by default).
  // Gated on IP AND its self-declared User-Agent ("Huntress Halo Integration").
  huntress: {
    key: "huntress",
    label: "Huntress",
    enableVar: "ENABLE_HUNTRESS",
    defaultEnabled: false,
    ips: new Set(["52.4.130.244", "34.205.224.75", "184.72.103.99", "107.21.187.4"]),
    cidrs: ["4.150.82.176/28", "172.200.220.176/28"],
    userAgent: "Huntress Halo Integration",
    // Huntress authenticates with its own client_id — its own credential pair, set
    // independently of Tier2's so both pass token enforcement (issue #51).
    clientIdVar: "HALO_CLIENT_ID_HUNTRESS",
    clientSecretVar: "HALO_CLIENT_SECRET_HUNTRESS",
    deferCreate: false, // one-shot: the whole ticket arrives in the create, no /actions note
    ticketCreatedBy: "Huntress",
    ticketBodyHeading: "Details",
  },
};

/**
 * Interpret an `ENABLE_*` flag. "true"/"1"/"yes"/"on" (case-insensitive) enable;
 * any other non-empty value disables; unset or empty falls back to `dflt` so a
 * missing var can't accidentally flip a product's built-in default.
 */
function flagOn(raw: string | undefined, dflt: boolean): boolean {
  if (raw === undefined) return dflt;
  const v = raw.trim().toLowerCase();
  if (v === "") return dflt;
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** Parse a dotted-quad IPv4 string to a 32-bit unsigned int, or null if malformed. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    n = (n << 8) | octet;
  }
  return n >>> 0;
}

/** True if `ip` falls within the `a.b.c.d/len` IPv4 CIDR range. */
export function ipInCidr(ip: string, cidr: string): boolean {
  const [base, lenStr] = cidr.split("/");
  const prefix = Number(lenStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base ?? "");
  if (ipInt === null || baseInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false;
  }
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/**
 * The currently-enabled products — those whose `ENABLE_*` flag resolves on. A
 * breadcrumb is logged when everything is disabled, since (with the allowlist
 * enforced) that closes the door to all inbound Halo traffic.
 */
export function enabledProducts(env: Env): Product[] {
  const on = Object.values(PRODUCTS).filter((p) =>
    flagOn(env[p.enableVar] as string | undefined, p.defaultEnabled),
  );
  if (on.length === 0) breadcrumb("no products enabled — all inbound Halo IPs will be rejected");
  return on;
}

/**
 * The enabled product whose allowlist contains the request's `CF-Connecting-IP`,
 * or null if none match (or the header is absent — which fails closed). Returns
 * the Product rather than a boolean so callers can later branch ticket handling
 * on which product a request originated from.
 */
export function matchProduct(request: Request, env: Env): Product | null {
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (!ip) return null;
  const ua = (request.headers.get("User-Agent") ?? "").toLowerCase();
  for (const p of enabledProducts(env)) {
    const ipOk = p.ips.has(ip) || p.cidrs.some((c) => ipInCidr(ip, c));
    if (!ipOk) continue; // IP membership is always mandatory
    if (p.userAgent && !ua.includes(p.userAgent.toLowerCase())) continue; // optional UA second gate
    return p;
  }
  return null;
}

/**
 * True if the request is from an allowlisted source IP (or the allowlist is
 * explicitly disabled). Fails closed (audit F2): the allowlist is ENFORCED by
 * default. Only an explicit, normalized `"false"`, `"0"`, or `""` disables it —
 * an unset var, `"true"`, `"True"`, or any other value enforces. Enforcement
 * matches `CF-Connecting-IP` against the exact IPs and CIDR ranges of the
 * currently-enabled products; the header is Cloudflare-controlled and an absent
 * header already fails closed (it matches no product).
 */
export function ipAllowed(request: Request, env: Env): boolean {
  const raw = env.ENFORCE_IP_ALLOWLIST;
  if (raw !== undefined) {
    const flag = raw.trim().toLowerCase();
    if (flag === "false" || flag === "0" || flag === "") return true; // explicitly disabled
  }
  return matchProduct(request, env) !== null;
}

/** A resolved Halo OAuth credential pair (both parts guaranteed non-empty). */
export interface HaloCreds {
  clientId: string;
  secret: string;
}

/** A `{clientId, secret}` pair, or null unless BOTH env vars resolve to non-empty. */
function credsFrom(env: Env, idVar?: keyof Env, secretVar?: keyof Env): HaloCreds | null {
  const clientId = idVar ? String(env[idVar] ?? "") : "";
  const secret = secretVar ? String(env[secretVar] ?? "") : "";
  return clientId && secret ? { clientId, secret } : null;
}

/**
 * A product's own configured OAuth pair, or null when it has no credentials (its
 * lenient mode: any creds accepted at `/token`, no token enforcement). Each product
 * carries its OWN pair (Tier2 via the legacy HALO_CLIENT_ID/SECRET, Huntress via
 * HALO_CLIENT_ID_HUNTRESS/SECRET) so both can authenticate under `enforce` — the fix
 * for issue #51.
 */
export function productCredentials(product: Product, env: Env): HaloCreds | null {
  return credsFrom(env, product.clientIdVar, product.clientSecretVar);
}

/**
 * Resolve the OAuth credentials governing a request: the matched product's own pair
 * (for Tier2 that IS the legacy HALO_CLIENT_ID/SECRET). When no product matches — e.g.
 * the IP allowlist is disabled — fall back to the global HALO_CLIENT_ID/SECRET pair so
 * legacy single-credential deployments keep working unchanged. `creds` is null in
 * lenient mode. `product` is echoed so a minted token can be bound to it (a `prod`
 * claim) and the enforcement gate can check that claim against the request's product.
 */
export function haloCredentials(
  request: Request,
  env: Env,
): { product: Product | null; creds: HaloCreds | null } {
  const product = matchProduct(request, env);
  if (product) return { product, creds: productCredentials(product, env) };
  return { product: null, creds: credsFrom(env, "HALO_CLIENT_ID", "HALO_CLIENT_SECRET") };
}
