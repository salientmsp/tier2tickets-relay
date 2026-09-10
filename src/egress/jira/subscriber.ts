import { notify } from "@ambersecurityinc/notifly";
import {
  getCreatedTicket,
  putPendingJira,
  setCreatedTicketJiraKey,
  takeStalePendingJira,
} from "../../core/db.js";
import { breadcrumb, describeError } from "../../core/log.js";
import { notiflyUrls } from "../../core/notify.js";
import type { Env } from "../../core/types.js";
import type {
  EventContext,
  TicketCreatedEvent,
  TicketEventSubscriber,
  TicketResolvedEvent,
} from "../../core/events.js";
import {
  JiraClient,
  jiraEnabled,
  jiraTargetFor,
  parseJiraTargets,
  type JiraIssueInput,
  type JiraTarget,
} from "./client.js";

/**
 * The Jira egress subscriber. It reacts ONLY to generic ticket events from
 * core/events.ts — it has no knowledge of Halo, Huntress, or any ticket source; it
 * knows only that a ticket was created or resolved for some Gorelo client, carrying a
 * product key. A client is mirrored to Jira exactly when ENABLE_JIRA is on AND the
 * client id has a JIRA_TARGETS entry — enrollment is by client, not by product.
 *
 * Every fan-out runs in the request's waitUntil and never throws into the emit path;
 * a failure is enqueued in pending_jira for the cron flush (flushPendingJira), with a
 * ledger-key dedup guard on create and a notifly dead-letter after MAX_JIRA_ATTEMPTS.
 */

// How many Jira jobs one cron flush processes, how many failed attempts before a
// job is dead-lettered, and a short grace window so a just-queued failure isn't
// re-claimed within the same flush run (see takeStalePendingJira).
const JIRA_FLUSH_LIMIT = 25;
const MAX_JIRA_ATTEMPTS = 5;
const JIRA_GRACE_MS = 60 * 1000;
const JIRA_RESOLVE_COMMENT =
  "Resolved — the source ticket was marked resolved, so this issue is being closed to mirror the Gorelo ticket.";

const nowIso = (): string => new Date().toISOString();

/**
 * Build the Jira issue fields from a ticket-created event. Summary is the ticket
 * subject; the body is the (already plain-text) ticket description prefixed with a
 * cross-reference to the Gorelo number so the two systems are linked. Labels tag the
 * source product (when known) + the Gorelo number — product-agnostic: whatever key
 * the event carries, not a hardcoded source.
 */
export function buildJiraIssueInput(event: TicketCreatedEvent): JiraIssueInput {
  const ref = event.displayNumber
    ? `Gorelo ticket ${event.displayNumber}${event.number != null ? ` (#${event.number})` : ""}`
    : event.number != null
      ? `Gorelo ticket #${event.number}`
      : "";
  const body = event.descriptionText ?? "";
  const description = ref ? `${ref}\n\n${body}` : body;
  const labels: string[] = [];
  if (event.productKey) labels.push(event.productKey);
  if (event.number != null) labels.push(`gorelo-${event.number}`);
  return { summary: event.subject || "Ticket", description, labels };
}

/**
 * Mirror a ticket into a co-managed client's Jira. On success records the issue key on
 * the ledger (for the later resolution-close and as a dedup guard); on failure enqueues
 * a durable retry for the cron flush. Never throws.
 */
async function fanOutJiraCreate(
  env: Env,
  haloId: number,
  clientId: number,
  target: JiraTarget,
  input: JiraIssueInput,
): Promise<void> {
  try {
    const key = await new JiraClient(target).createIssue(input);
    await setCreatedTicketJiraKey(env.DB, haloId, key);
    breadcrumb(`JIRA created issue ${key} (halo_id=${haloId} client=${clientId})`);
  } catch (err) {
    await putPendingJira(env.DB, {
      kind: "create",
      clientId,
      haloId,
      payload: JSON.stringify(input),
      createdAt: nowIso(),
    }).catch((e) => breadcrumb(`JIRA enqueue create failed halo_id=${haloId}: ${describeError(e)}`));
    breadcrumb(`JIRA create failed (halo_id=${haloId} client=${clientId}), queued for retry: ${describeError(err)}`);
  }
}

/**
 * Close a co-managed client's Jira issue on a ticket resolution: add a resolution
 * comment and (if the target configures one) transition it to the resolved status.
 * Never throws; a failure enqueues a durable "close" retry.
 */
async function fanOutJiraClose(
  env: Env,
  clientId: number,
  target: JiraTarget,
  issueKey: string,
): Promise<void> {
  try {
    const client = new JiraClient(target);
    await client.addComment(issueKey, JIRA_RESOLVE_COMMENT);
    if (target.resolvedTransition) await client.transitionTo(issueKey, target.resolvedTransition);
    breadcrumb(`JIRA closed issue ${issueKey} (client=${clientId})`);
  } catch (err) {
    await putPendingJira(env.DB, {
      kind: "close",
      clientId,
      haloId: null,
      payload: JSON.stringify({ issueKey }),
      createdAt: nowIso(),
    }).catch((e) => breadcrumb(`JIRA enqueue close failed ${issueKey}: ${describeError(e)}`));
    breadcrumb(`JIRA close failed (issue ${issueKey} client=${clientId}), queued for retry: ${describeError(err)}`);
  }
}

/**
 * The linked issue key is NOT on the resolved event (no sink-specific field leaks into
 * the contract) — look it up from the ledger by the original ticket's id, then close.
 * A no-op when the ticket was never mirrored to Jira.
 */
async function resolveAndClose(
  env: Env,
  clientId: number,
  target: JiraTarget,
  haloId: number,
): Promise<void> {
  const original = await getCreatedTicket(env.DB, haloId);
  const issueKey = original?.jira_issue_key;
  if (!issueKey) return; // never mirrored -> nothing to close
  await fanOutJiraClose(env, clientId, target, issueKey);
}

/** The egress subscriber registered with the event spine (see index.ts). */
export const jiraSubscriber: TicketEventSubscriber = {
  onTicketCreated(event: TicketCreatedEvent, { env, ctx }: EventContext): void {
    if (!jiraEnabled(env)) return;
    const target = jiraTargetFor(env, event.clientId);
    if (!target) return; // client not enrolled -> no-op
    const input = buildJiraIssueInput(event);
    ctx?.waitUntil(fanOutJiraCreate(env, event.haloId, event.clientId, target, input));
  },

  onTicketResolved(event: TicketResolvedEvent, { env, ctx }: EventContext): void {
    if (!jiraEnabled(env)) return;
    const clientId = event.original.clientId;
    if (clientId == null) return;
    const target = jiraTargetFor(env, clientId);
    if (!target) return; // client not enrolled -> no-op
    ctx?.waitUntil(resolveAndClose(env, clientId, target, event.original.haloId));
  },
};

/**
 * Drain the Jira retry queue. Runs from the frequent (5-minute) cron alongside the
 * pending-tickets flush. Claims one stale job at a time; a create is dedup-guarded by
 * the ledger key, and a job that exhausts MAX_JIRA_ATTEMPTS is dead-lettered via
 * notifly. Returns the number completed.
 */
export async function flushPendingJira(env: Env, limit = JIRA_FLUSH_LIMIT): Promise<number> {
  const targets = parseJiraTargets(env);
  let done = 0;
  for (let i = 0; i < limit; i++) {
    const cutoff = new Date(Date.now() - JIRA_GRACE_MS).toISOString();
    const row = await takeStalePendingJira(env.DB, cutoff);
    if (!row) break; // queue drained (or nothing past the grace window yet)
    const target = targets.get(row.client_id);
    if (!target) {
      // The client's target was removed/disabled — drop the job rather than loop on it.
      breadcrumb(`JIRA flush: no target for client=${row.client_id}, dropping ${row.kind} job`);
      continue;
    }
    try {
      if (row.kind === "create") {
        // Dedup guard: if the issue already landed (key on the ledger), don't re-create.
        if (row.halo_id != null) {
          const existing = await getCreatedTicket(env.DB, row.halo_id);
          if (existing?.jira_issue_key) {
            done++;
            continue;
          }
        }
        const input = JSON.parse(row.payload) as JiraIssueInput;
        const key = await new JiraClient(target).createIssue(input);
        if (row.halo_id != null) await setCreatedTicketJiraKey(env.DB, row.halo_id, key);
        breadcrumb(`JIRA flush created issue ${key} (client=${row.client_id} halo_id=${row.halo_id})`);
      } else {
        const { issueKey } = JSON.parse(row.payload) as { issueKey: string };
        const client = new JiraClient(target);
        await client.addComment(issueKey, JIRA_RESOLVE_COMMENT);
        if (target.resolvedTransition) await client.transitionTo(issueKey, target.resolvedTransition);
        breadcrumb(`JIRA flush closed issue ${issueKey} (client=${row.client_id})`);
      }
      done++;
    } catch (err) {
      const attempts = row.attempts + 1;
      if (attempts >= MAX_JIRA_ATTEMPTS) {
        breadcrumb(
          `JIRA dead-letter ${row.kind} client=${row.client_id} after ${attempts} attempts: ${describeError(err)}`,
        );
        await postJiraDeadLetter(env, { kind: row.kind, clientId: row.client_id, attempts, error: String(err) });
      } else {
        await putPendingJira(env.DB, {
          kind: row.kind,
          clientId: row.client_id,
          haloId: row.halo_id,
          payload: row.payload,
          createdAt: nowIso(),
          attempts,
        });
        breadcrumb(`JIRA flush ${row.kind} failed client=${row.client_id} (attempt ${attempts}): ${describeError(err)}`);
      }
    }
  }
  return done;
}

/**
 * A Jira job that keeps failing is a lost mirror — the Gorelo ticket still exists, so
 * nothing is dropped on the PSA side, but the client's Jira is out of sync. Alert via
 * notifly so it's visible. No-op when NOTIFLY_URLS is unset. Logs only the client id,
 * never the target/token.
 */
async function postJiraDeadLetter(
  env: Env,
  info: { kind: string; clientId: number; attempts: number; error: string },
): Promise<void> {
  const urls = notiflyUrls(env);
  if (!urls.length) return;
  const verb = info.kind === "close" ? "close" : "create";
  const results = await notify(
    { urls },
    {
      title: `⚠️ Jira ${verb} failed for co-managed client ${info.clientId}`,
      body: [
        `Client (Gorelo id): ${info.clientId}`,
        `Action: ${info.kind}`,
        `Attempts: ${info.attempts}`,
        `Error: ${info.error}`,
        "",
        "The Gorelo ticket is unaffected; only the Jira mirror is out of sync.",
      ].join("\n"),
      type: "failure",
    },
  );
  const failed = results.filter((r) => !r.success);
  if (failed.length) {
    breadcrumb(`JIRA dead-letter notify errors: ${failed.map((f) => `${f.service}:delivery_failed`).join("; ")}`);
  }
}
