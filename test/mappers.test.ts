import { describe, expect, it } from "vitest";
import { helpdeskButtonsMapper } from "../src/ingress/mappers/index.js";
import type { MapperDeviceContext } from "../src/ingress/mappers/index.js";

// Golden-fixture tests for the per-product mapper seam: a captured-shape inbound
// payload in → the parsed routing signals + rendered description out. Onboarding a new
// vendor is one mapper + one fixture like these, with no change to existing paths.
//
// The Helpdesk Buttons mapper is shared by Tier2 (an HDB <td> report table) and
// Huntress (free text) — the two fixtures below prove BOTH shapes route through it:
// the report-table branch for HDB, the free-text branch for Huntress.

const NO_DEVICE: MapperDeviceContext = { agent: null, device: null };

// --- Fixture 1: Helpdesk Buttons (Tier2) — the HDB "Report Summary" <td> table ----
// Captured shape: Tier2 files under the catch-all user and puts the real reporter
// identity in the details_html report table; a press can be flagged an emergency.
const HDB_TICKET = {
  summary: "Computer won't start",
  user_id: 999999999, // the synthetic unregistered catch-all user
  client_id: 999, // the catch-all client
  site_id: 0,
  details_html: `
    <table><tbody>
      <tr><td>Name:</td><td>Jane Doe</td></tr>
      <tr><td>Email:</td><td>Jane.Doe@Corp.com</td></tr>
      <tr><td>Hostname:</td><td>PC-01.corp.local</td></tr>
      <tr><td>Selections:</td><td>My screen is frozen<br>This affects only me<br>Connect directly to my computer as soon as available</td></tr>
      <tr><td>Notes:</td><td>This is an emergency, please help</td></tr>
    </tbody></table>`,
};

describe("helpdeskButtons mapper — HDB report-table payload", () => {
  it("parse() extracts reporter email, hostname, name, and the emergency flag", () => {
    const parsed = helpdeskButtonsMapper.parse(HDB_TICKET);
    expect(parsed.email).toBe("jane.doe@corp.com"); // normalized (lowercased)
    expect(parsed.hostname).toBe("pc-01"); // domain stripped, lowercased
    expect(parsed.reporterName).toBe("Jane Doe");
    expect(parsed.isEmergency).toBe(true);
    // The parsed report is the lowercased-label table dict.
    expect(parsed.report.email).toBe("Jane.Doe@Corp.com");
    expect(parsed.report.hostname).toBe("PC-01.corp.local");
  });

  it("buildDescription() renders the report table under the product heading", () => {
    const desc = helpdeskButtonsMapper.buildDescription(HDB_TICKET, NO_DEVICE, "Report Summary");
    expect(desc).toContain("<b>Report Summary</b>");
    expect(desc).toContain("Email: Jane.Doe@Corp.com");
    expect(desc).toContain("Hostname: PC-01.corp.local");
    // Non-default selection kept as a bullet; the two default selections are stripped.
    expect(desc).toContain("&bull; My screen is frozen");
    expect(desc).not.toContain("This affects only me");
    expect(desc).not.toContain("Connect directly to my computer");
    // Line breaks are HTML <br>, not raw newlines (Gorelo collapses newlines).
    expect(desc).toContain("<br>");
  });

  it("buildDescription() appends a Device section when device detail is present", () => {
    const withDevice: MapperDeviceContext = {
      agent: null,
      device: {
        hostname: "pc-01",
        agent_id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        asset_num: 1,
        client_id: 10,
        location_id: 100,
        display_name: "PC-01",
        serial: "SN123",
        local_ip: "10.0.0.5",
        public_ip: "",
        os: "Windows 11",
      },
    };
    const desc = helpdeskButtonsMapper.buildDescription(HDB_TICKET, withDevice, "Report Summary");
    expect(desc).toContain("<b>Device</b>");
    expect(desc).toContain("SN SN123");
    expect(desc).toContain("Local IP 10.0.0.5");
  });
});

// --- Fixture 2: Huntress — a free-text alert (no HDB report table) -----------------
// Captured shape: Huntress sends the whole alert as free-text `details` with an
// explicit reporter field and a bare escalation URL; there is no <td> report table.
const HUNTRESS_TICKET = {
  summary: "Suspicious login",
  client_id: 10,
  reportedby: "SOC@huntress.io",
  details:
    "Huntress detected one or more logins from United Kingdom.<br><br>" +
    "Identity Provider: Microsoft 365<br>" +
    "Escalation: https://salient.huntress.io/org/638042/escalations/818208",
};

describe("helpdeskButtons mapper — Huntress free-text payload (same mapper)", () => {
  it("parse() takes the email from the explicit field; no report table, no hostname", () => {
    const parsed = helpdeskButtonsMapper.parse(HUNTRESS_TICKET);
    expect(parsed.email).toBe("soc@huntress.io"); // requesterEmail from the explicit field
    expect(parsed.hostname).toBe(""); // no report table -> no hostname
    expect(parsed.reporterName).toBe("");
    expect(parsed.isEmergency).toBe(false);
    expect(parsed.report).toEqual({}); // free text -> empty report
  });

  it("buildDescription() renders free text under the product heading and linkifies URLs", () => {
    const desc = helpdeskButtonsMapper.buildDescription(HUNTRESS_TICKET, NO_DEVICE, "Details");
    expect(desc).toContain("<b>Details</b>");
    expect(desc).toContain("Huntress detected one or more logins");
    // The bare escalation URL becomes a clickable anchor.
    expect(desc).toContain(
      '<a href="https://salient.huntress.io/org/638042/escalations/818208">' +
        "https://salient.huntress.io/org/638042/escalations/818208</a>",
    );
    // Section structure survives as <br>, not one flattened paragraph.
    expect(desc).toContain("<br>");
  });
});
