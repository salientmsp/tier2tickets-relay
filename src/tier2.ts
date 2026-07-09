import type { Env } from "./types.js";

/** Tier2Tickets cloud posts from these two fixed source IPs. */
export const TIER2_SOURCE_IPS = new Set(["34.202.14.153", "3.209.57.193"]);

/** True if the request is from an allowlisted Tier2 IP (or the allowlist is off). */
export function ipAllowed(request: Request, env: Env): boolean {
  if (env.ENFORCE_IP_ALLOWLIST !== "true") return true;
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  return TIER2_SOURCE_IPS.has(ip);
}
