import type {
  CreatePublicTicketCommand,
  Env,
  MatchResult,
  PressIdentity,
  PublicTicketPriority,
  TicketSource,
} from "./types.js";

/**
 * Build the ticket description: the clean (tag-stripped) client-facing body,
 * plus a small triage footer carrying endpoint identity. mac/ip are triage-note
 * only (Gorelo has no MAC to match on; IP is unreliable under DHCP/NAT).
 * On a catch-all match the footer is flagged so a tech knows to reassign.
 */
export function buildDescription(
  cleanBody: string,
  identity: PressIdentity,
  match: MatchResult,
): string {
  const lines: string[] = [];
  if (match.matchType === "catchall") {
    lines.push("[triage] No matching Gorelo client — routed to the catch-all. Please reassign.");
  }
  const detail: string[] = [];
  if (identity.host) detail.push(`host: ${identity.host}`);
  if (identity.mac) detail.push(`mac: ${identity.mac}`);
  if (identity.ip) detail.push(`ip: ${identity.ip}`);
  if (identity.email) detail.push(`requester: ${identity.email}`);
  detail.push(`match: ${match.matchType}`);

  const footer = ["--- Helpdesk Buttons endpoint identity ---", ...detail].join("\n");
  const body = (cleanBody ?? "").trim();
  return [body, lines.join("\n"), footer].filter((s) => s.length > 0).join("\n\n");
}

/** Assemble the CreatePublicTicketCommand from env defaults + match + resolved contact. */
export function buildTicketCommand(
  env: Env,
  identity: PressIdentity,
  match: MatchResult,
  contactId: number | null,
  subject: string,
  description: string,
): CreatePublicTicketCommand {
  return {
    title: subject || "(no subject)",
    createdByName: identity.name || identity.email || "Helpdesk Buttons",
    clientId: match.clientId,
    locationId: match.locationId,
    contactId,
    description,
    groupId: Number(env.DEFAULT_GROUP_ID),
    typeId: Number(env.DEFAULT_TYPE_ID),
    priorityId: Number(env.DEFAULT_PRIORITY) as PublicTicketPriority,
    sourceId: Number(env.DEFAULT_SOURCE) as TicketSource,
    agentAssetIds: match.agentId ? [match.agentId] : [],
    sendTicketCreatedEmail: false,
  };
}
