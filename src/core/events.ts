/**
 * Internal event spine (the ingress → egress contract).
 *
 * Ingress (the Halo mock and any future ticket source) EMITS domain events when a
 * ticket is created or resolved. Egress modules (the Jira fan-out, any future sink)
 * SUBSCRIBE to those events. Neither side imports the other — they meet only here,
 * in core. `index.ts` wires the two together by registering egress subscribers.
 *
 * Events describe what happened to a Gorelo ticket in terms every sink can consume:
 * a ticket reference, the resolved routing ids, the source product key, and a
 * subject/timestamp. Nothing sink-specific (no Jira, no Slack, …) appears here.
 *
 * With NO subscribers registered, emitting is a no-op — the relay's behavior is
 * byte-for-byte identical to before the spine existed. A subscriber is invoked
 * synchronously but is expected to background its own I/O via `context.ctx`
 * (waitUntil); emission wraps every callback in try/catch so a misbehaving sink can
 * never fail, delay, or throw into the ticket-create path.
 */

import { breadcrumb, describeError } from "./log.js";
import type { Env } from "./types.js";

/**
 * Emitted right after a Gorelo ticket is successfully created from an inbound
 * request (the eager-create seam in the Halo mock).
 *
 * Field availability is derived from what the create path ACTUALLY holds at the
 * emit point — fields that can be absent there are typed optional/nullable and
 * annotated below.
 */
export interface TicketCreatedEvent {
  readonly type: "ticket.created";
  /**
   * The Gorelo ticket GUID from the create response (the value the rest of the
   * code calls the "ticket number", extracted via extractTicketNumber). Empty
   * string only if the create response carried no id — best-effort, but in
   * practice always present on a successful create.
   */
  readonly goreloId: string;
  /**
   * The id the relay handed back to the Halo client, and the `created_tickets`
   * ledger key: the real human Gorelo number when the read-back resolved one,
   * else a synthetic surrogate. ALWAYS present. Use this to correlate a later
   * resolution back to this ticket.
   */
  readonly haloId: number;
  /**
   * Human-facing Gorelo ticket number, read back from the create GUID. OPTIONAL —
   * the read-back is best-effort (a GET that can fail or lag), so either part may
   * be null even on a successful create.
   */
  readonly number: number | null;
  readonly displayNumber: string | null;
  /**
   * The source product key that produced the ticket (e.g. "tier2", "huntress").
   * Null when no product matched the request (e.g. the IP allowlist is disabled).
   */
  readonly productKey: string | null;
  /**
   * Resolved Gorelo client id. ALWAYS present — the routing resolver falls back to
   * the catch-all client id, so this is never null.
   */
  readonly clientId: number;
  /** Resolved Gorelo location/site id. OPTIONAL — null when none resolved. */
  readonly locationId: number | null;
  /** Resolved Gorelo contact id. OPTIONAL — null when no contact matched. */
  readonly contactId: number | null;
  /**
   * Resolved Gorelo agent/device asset UUIDs linked to the ticket. May be empty
   * (no device matched); never null.
   */
  readonly deviceAssetIds: readonly string[];
  /** Ticket subject/title (the Gorelo command's title). ALWAYS present. */
  readonly subject: string;
  /**
   * The ticket body flattened to plain text (the Gorelo HTML description run through
   * htmlToText at emit time). A neutral, sink-agnostic representation — a sink that
   * wants rich text re-renders from this. May be empty when the ticket had no body.
   */
  readonly descriptionText: string;
  /** ISO-8601 timestamp of emission. */
  readonly timestamp: string;
}

/**
 * A reference to the ORIGINAL ticket being resolved, carried on a resolution event.
 * Sourced from the `created_tickets` ledger row for the ticket that is being
 * resolved. `haloId` is the ledger key — a sink that needs sink-specific link data
 * (e.g. a stored external issue key) looks it up from the ledger by this id, so no
 * sink-specific field leaks into the event.
 */
export interface ResolvedTicketRef {
  /** The ledger key (the id originally handed back at create time). ALWAYS present. */
  readonly haloId: number;
  /** The original Gorelo ticket GUID, if the ledger recorded one. */
  readonly goreloId: string | null;
  /** The original human Gorelo number/displayNumber, if known. */
  readonly number: number | null;
  readonly displayNumber: string | null;
  /** The original ticket title, if the ledger recorded one. */
  readonly title: string | null;
  /** The original ticket's resolved client id. OPTIONAL — null if unrecorded. */
  readonly clientId: number | null;
  /** The original ticket's resolved contact id. OPTIONAL. */
  readonly contactId: number | null;
}

/**
 * Emitted when an inbound resolution edit is matched to a ticket the relay
 * previously created (the resolution seam in the Halo mock). Gorelo has no
 * ticket-update API, so the relay files a labeled "Resolved:" notice; this event
 * fires alongside that so sinks can mirror the resolution.
 */
export interface TicketResolvedEvent {
  readonly type: "ticket.resolved";
  /** The original ticket being resolved. */
  readonly original: ResolvedTicketRef;
  /**
   * The source product key, when known. OPTIONAL — a resolution edit is matched
   * purely by a ledger-known id, so the matching product is only known when the
   * emitting request itself matched one (it normally does: a product resolves its
   * own resolutions).
   */
  readonly productKey: string | null;
  /** The Gorelo status id the resolution moved the ticket into. */
  readonly resolvedStatusId: number;
  /** ISO-8601 timestamp of emission. */
  readonly timestamp: string;
}

/** Runtime context handed to every subscriber: the Env and (when available) the ExecutionContext. */
export interface EventContext {
  readonly env: Env;
  /**
   * The request/cron ExecutionContext, when one exists. A subscriber that does I/O
   * should background it with `context.ctx?.waitUntil(...)` so it never blocks or
   * fails the emitting path. Undefined in contexts without one.
   */
  readonly ctx?: ExecutionContext;
}

/**
 * A sink implements the handlers it cares about. Handlers return void — a subscriber
 * must dispatch its own async work via `context.ctx` and must not rely on the emitter
 * awaiting it. Both handlers are optional so a sink can subscribe to just one.
 */
export interface TicketEventSubscriber {
  onTicketCreated?(event: TicketCreatedEvent, context: EventContext): void;
  onTicketResolved?(event: TicketResolvedEvent, context: EventContext): void;
}

// Module-level registry. Deliberately simple: the Worker is a single isolate and
// subscribers are registered once at module load (via index.ts), never per-request.
const subscribers: TicketEventSubscriber[] = [];

/** Register an egress subscriber. Idempotent per instance (a repeat is ignored). */
export function registerSubscriber(subscriber: TicketEventSubscriber): void {
  if (!subscribers.includes(subscriber)) subscribers.push(subscriber);
}

/** Remove all registered subscribers. Intended for test isolation. */
export function clearSubscribers(): void {
  subscribers.length = 0;
}

/** Number of registered subscribers (for tests/introspection). */
export function subscriberCount(): number {
  return subscribers.length;
}

/**
 * Emit a ticket-created event to every subscriber. A subscriber throwing (or its
 * handler being absent) never propagates — the create path is unaffected.
 */
export function emitTicketCreated(event: TicketCreatedEvent, context: EventContext): void {
  for (const s of subscribers) {
    if (!s.onTicketCreated) continue;
    try {
      s.onTicketCreated(event, context);
    } catch (err) {
      breadcrumb(`event subscriber onTicketCreated failed: ${describeError(err)}`);
    }
  }
}

/**
 * Emit a ticket-resolved event to every subscriber. Same isolation guarantees as
 * emitTicketCreated — a subscriber can never fail the resolution path.
 */
export function emitTicketResolved(event: TicketResolvedEvent, context: EventContext): void {
  for (const s of subscribers) {
    if (!s.onTicketResolved) continue;
    try {
      s.onTicketResolved(event, context);
    } catch (err) {
      breadcrumb(`event subscriber onTicketResolved failed: ${describeError(err)}`);
    }
  }
}
