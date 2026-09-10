import { GoreloError } from "./gorelo.js";
import type { Env } from "./types.js";

/**
 * Single logging chokepoint (audit F4). Two levels, nothing else:
 *
 *  - `debug(env, msg)` — verbose / potentially-PII lines (full request & response
 *    bodies, raw upstream error bodies, emails, hostnames). Emitted ONLY when
 *    `DEBUG_LOGS` is truthy, so it is silent by default.
 *  - `breadcrumb(msg)` — always-on operational line. Callers MUST pass only
 *    non-PII fields: ids, counts, status codes, y/n flags. Never a body, email,
 *    hostname, or secret.
 *
 * Route every `console.*` in the codebase through one of these. A raw `console.*`
 * that survives is a defect.
 */

/** `DEBUG_LOGS` is truthy for 1/true/yes/on (case-insensitive). */
export const debugOn = (env: Env): boolean => /^(1|true|yes|on)$/i.test(env.DEBUG_LOGS ?? "");

/** Verbose, potentially-PII log line — no-op unless `DEBUG_LOGS` is on. */
export function debug(env: Env, msg: string): void {
  if (debugOn(env)) console.log(msg);
}

/** Always-on operational log line. Only ever called with non-PII fields. */
export function breadcrumb(msg: string): void {
  console.log(msg);
}

/**
 * Describe an error WITHOUT leaking internals or secrets: a GoreloError collapses
 * to its HTTP status, other errors to name + message. Never the raw error body.
 */
export function describeError(err: unknown): string {
  if (err instanceof GoreloError) {
    // Include the 6-digit Notifications code when Gorelo returned one — it is the
    // stable, non-PII failure identifier to triage on (see GoreloError.code).
    return `GoreloError status=${err.status}${err.code ? ` code=${err.code}` : ""}`;
  }
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
