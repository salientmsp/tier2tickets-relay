import { describe, expect, it } from "vitest";
import { adfDoc, buildJiraIssueInput, jiraEnabled, jiraTargetFor, parseJiraTargets } from "../src/egress/jira/index.js";
import type { Env } from "../src/core/types.js";
import type { TicketCreatedEvent } from "../src/core/events.js";

// These exercise the pure config/parsing/building helpers only (no network), so they
// don't need the outbound fetch stub or the D1 seed the integration specs use.
const mkEnv = (over: Partial<Env>): Env => ({ ...over }) as Env;

describe("jiraEnabled", () => {
  it("is off by default / for false-ish values, on for true-ish ones", () => {
    expect(jiraEnabled(mkEnv({}))).toBe(false);
    expect(jiraEnabled(mkEnv({ ENABLE_JIRA: "false" }))).toBe(false);
    expect(jiraEnabled(mkEnv({ ENABLE_JIRA: "" }))).toBe(false);
    for (const v of ["true", "1", "yes", "on", "TRUE", "On"]) {
      expect(jiraEnabled(mkEnv({ ENABLE_JIRA: v }))).toBe(true);
    }
  });
});

describe("parseJiraTargets", () => {
  const good = JSON.stringify([
    {
      clientId: 10,
      baseUrl: "https://acme.atlassian.net/",
      projectKey: "SEC",
      email: "svc@acme.com",
      apiToken: "tok",
      resolvedTransition: "Done",
    },
  ]);

  it("indexes valid entries by clientId, trims the trailing slash, defaults issueType", () => {
    const m = parseJiraTargets(mkEnv({ JIRA_TARGETS: good }));
    const t = m.get(10)!;
    expect(t.baseUrl).toBe("https://acme.atlassian.net"); // trailing slash stripped
    expect(t.projectKey).toBe("SEC");
    expect(t.issueType).toBe("Task"); // defaulted
    expect(t.resolvedTransition).toBe("Done");
    expect(t.auth).toEqual({ mode: "basic", email: "svc@acme.com", apiToken: "tok" });
  });

  it("skips entries missing a required field but keeps the valid ones", () => {
    const raw = JSON.stringify([
      { clientId: 1 }, // missing everything else
      { clientId: 2, baseUrl: "https://x.atlassian.net", projectKey: "P", email: "e@x.com" }, // no token
      { clientId: 3, baseUrl: "https://y.atlassian.net", projectKey: "Q", email: "e@y.com", apiToken: "t" },
    ]);
    const m = parseJiraTargets(mkEnv({ JIRA_TARGETS: raw }));
    expect(m.has(1)).toBe(false);
    expect(m.has(2)).toBe(false);
    expect(m.has(3)).toBe(true);
  });

  it("recognizes a service-account OAuth 2.0 credential (oauthClientId + oauthClientSecret) as an alternative to email/apiToken", () => {
    const raw = JSON.stringify([
      {
        clientId: 20,
        baseUrl: "https://acme.atlassian.net",
        projectKey: "SEC",
        oauthClientId: "oauth-id",
        oauthClientSecret: "oauth-secret",
      },
    ]);
    const m = parseJiraTargets(mkEnv({ JIRA_TARGETS: raw }));
    const t = m.get(20)!;
    expect(t.auth).toEqual({ mode: "oauth", oauthClientId: "oauth-id", oauthClientSecret: "oauth-secret" });
  });

  it("skips an entry with neither auth shape complete, even with an unrelated field set", () => {
    const raw = JSON.stringify([
      { clientId: 30, baseUrl: "https://x.atlassian.net", projectKey: "P", email: "e@x.com" }, // no token, no oauth secret either
      { clientId: 31, baseUrl: "https://x.atlassian.net", projectKey: "P", oauthClientId: "id-only" }, // no secret
    ]);
    const m = parseJiraTargets(mkEnv({ JIRA_TARGETS: raw }));
    expect(m.has(30)).toBe(false);
    expect(m.has(31)).toBe(false);
  });

  it("returns an empty map for unset / malformed / non-array input", () => {
    expect(parseJiraTargets(mkEnv({})).size).toBe(0);
    expect(parseJiraTargets(mkEnv({ JIRA_TARGETS: "" })).size).toBe(0);
    expect(parseJiraTargets(mkEnv({ JIRA_TARGETS: "{ not json" })).size).toBe(0);
    expect(parseJiraTargets(mkEnv({ JIRA_TARGETS: '{"clientId":1}' })).size).toBe(0); // object, not array
  });

  it("jiraTargetFor returns the target only for an enrolled, non-null client id", () => {
    const e = mkEnv({ JIRA_TARGETS: good });
    expect(jiraTargetFor(e, 10)).not.toBeNull();
    expect(jiraTargetFor(e, 999)).toBeNull();
    expect(jiraTargetFor(e, null)).toBeNull();
    expect(jiraTargetFor(e, undefined)).toBeNull();
  });
});

describe("adfDoc", () => {
  it("wraps each text line in an ADF paragraph, preserving blank lines", () => {
    const doc = adfDoc("first\n\nsecond") as { type: string; content: unknown[] };
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(3);
    expect(doc.content[0]).toMatchObject({ type: "paragraph", content: [{ type: "text", text: "first" }] });
    expect(doc.content[1]).toEqual({ type: "paragraph" }); // blank line -> empty paragraph
    expect(doc.content[2]).toMatchObject({ content: [{ type: "text", text: "second" }] });
  });

  it("still yields at least one paragraph for empty text", () => {
    const doc = adfDoc("") as { content: unknown[] };
    expect(doc.content).toEqual([{ type: "paragraph" }]);
  });
});

describe("buildJiraIssueInput (from a ticket-created event)", () => {
  const baseEvent: TicketCreatedEvent = {
    type: "ticket.created",
    goreloId: "guid-1",
    haloId: 700900,
    number: 700900,
    displayNumber: "T-700900",
    productKey: "huntress",
    clientId: 10,
    locationId: null,
    contactId: null,
    deviceAssetIds: [],
    subject: "Suspicious login",
    descriptionText: "An anomalous login was detected.",
    timestamp: "2026-07-31T00:00:00.000Z",
  };

  it("cross-references the Gorelo number and labels by product key (not a hardcoded source)", () => {
    const input = buildJiraIssueInput(baseEvent);
    expect(input.summary).toBe("Suspicious login");
    expect(input.description).toBe(
      "Gorelo ticket T-700900 (#700900)\n\nAn anomalous login was detected.",
    );
    // Labels use the event's productKey — the module doesn't hardcode "huntress".
    expect(input.labels).toEqual(["huntress", "gorelo-700900"]);
  });

  it("carries a different product key straight through to the label", () => {
    const input = buildJiraIssueInput({ ...baseEvent, productKey: "tier2" });
    expect(input.labels).toEqual(["tier2", "gorelo-700900"]);
  });

  it("omits the ref/number label when no human number resolved", () => {
    const input = buildJiraIssueInput({ ...baseEvent, number: null, displayNumber: null });
    expect(input.description).toBe("An anomalous login was detected.");
    expect(input.labels).toEqual(["huntress"]);
  });
});
