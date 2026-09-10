/**
 * Minimal signed bearer tokens for the Halo mock (audit F1).
 *
 * A token is `payload.sig`: base64url(JSON payload) + "." + base64url(HMAC-SHA256).
 * The HMAC key IS `HALO_CLIENT_SECRET` — no new secret is introduced, which ties
 * enforceability directly to the OAuth credentials being set (no secret, no
 * enforceable token). Verification uses `crypto.subtle.verify` (constant-time)
 * and rejects expired tokens. No runtime dependency — Web Crypto only.
 */

export interface TokenPayload {
  /** Expiry as Unix seconds. */
  exp: number;
  [k: string]: unknown;
}

/** Result of a verification: the payload, or why it failed. */
export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: "invalid" | "expired" };

const enc = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Sign a payload into a compact `payload.sig` token keyed by `secret`. */
export async function signToken(secret: string, payload: TokenPayload): Promise<string> {
  const body = bytesToBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${bytesToBase64Url(sig)}`;
}

/** Verify a token, distinguishing a bad signature/shape (`invalid`) from expiry (`expired`). */
export async function verifyTokenResult(secret: string, token: string): Promise<VerifyResult> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "invalid" };
  const body = token.slice(0, dot);
  const sigPart = token.slice(dot + 1);

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlToBytes(sigPart);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  const key = await importKey(secret);
  // Constant-time signature check.
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(body));
  if (!valid) return { ok: false, reason: "invalid" };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(body))) as TokenPayload;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (typeof payload.exp !== "number") return { ok: false, reason: "invalid" };
  if (Date.now() / 1000 >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, payload };
}

/** Verify a token: the payload on success, `null` on any failure (bad sig or expired). */
export async function verifyToken(secret: string, token: string): Promise<TokenPayload | null> {
  const r = await verifyTokenResult(secret, token);
  return r.ok ? r.payload : null;
}
