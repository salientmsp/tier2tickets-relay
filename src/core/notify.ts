import type { Env } from "./types.js";

/**
 * Parse the configured notifly (Apprise) URLs — comma / whitespace / newline
 * separated. Shared by every dead-letter/alert path (ingress ticket drops, egress
 * fan-out failures, sync failures) so it lives in core, not on either side. The URLs
 * are secrets (they can embed tokens): callers pass them to notify(), never to a log.
 */
export function notiflyUrls(env: Env): string[] {
  return (env.NOTIFLY_URLS ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
