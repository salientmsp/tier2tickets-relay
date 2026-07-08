import { findClientByDomain, findDeviceByHostname, findDeviceByUpn } from "./db.js";
import { emailDomain } from "./parse.js";
import type { MatchResult, PressIdentity } from "./types.js";

/**
 * Resolve a press to a Gorelo client using the D1 mirror.
 * Order: device-by-hostname -> device-by-UPN -> email-domain -> catch-all.
 * A device match also carries locationId and the agent id (for agentAssetIds).
 */
export async function matchClient(
  db: D1Database,
  identity: PressIdentity,
  catchallClientId: number,
): Promise<MatchResult> {
  // 1. Device by hostname (agent displayName/name, normalized short-lowercase at sync time).
  const byHost = await findDeviceByHostname(db, identity.host);
  if (byHost) {
    return {
      clientId: byHost.client_id,
      locationId: byHost.location_id,
      agentId: byHost.agent_id,
      matchType: "hostname",
    };
  }

  // 2. Device by logged-on user UPN == email.
  const byUpn = await findDeviceByUpn(db, identity.email);
  if (byUpn) {
    return {
      clientId: byUpn.client_id,
      locationId: byUpn.location_id,
      agentId: byUpn.agent_id,
      matchType: "upn",
    };
  }

  // 3. Email domain -> client.
  const domain = emailDomain(identity.email);
  const byDomain = await findClientByDomain(db, domain);
  if (byDomain != null) {
    return { clientId: byDomain, locationId: null, agentId: null, matchType: "domain" };
  }

  // 4. Catch-all.
  return { clientId: catchallClientId, locationId: null, agentId: null, matchType: "catchall" };
}
