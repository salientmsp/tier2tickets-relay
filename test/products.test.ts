import { describe, expect, it } from "vitest";
import { PRODUCTS, ipAllowed, matchProduct } from "../src/products.js";
import type { Env } from "../src/types.js";

const TIER2_IP = [...PRODUCTS.tier2!.ips][0]!;
const HUNTRESS_IP = "52.4.130.244";
const HUNTRESS_UA = "Huntress Halo Integration";

/** A request carrying (or omitting) a CF-Connecting-IP header and optional User-Agent. */
function reqFrom(ip?: string, ua?: string): Request {
  const headers: Record<string, string> = {};
  if (ip) headers["CF-Connecting-IP"] = ip;
  if (ua) headers["User-Agent"] = ua;
  return new Request("https://haloapi.example.com/tickets", { headers });
}

/** A Huntress request: its source IP AND its self-declared User-Agent. */
function huntressReq(ip: string = HUNTRESS_IP): Request {
  return reqFrom(ip, HUNTRESS_UA);
}

/** Minimal Env carrying the allowlist vars (undefined => unset => product default). */
function envWith(enforce?: string, flags?: { tier2?: string; huntress?: string }): Env {
  return {
    ENFORCE_IP_ALLOWLIST: enforce,
    ENABLE_TIER2: flags?.tier2,
    ENABLE_HUNTRESS: flags?.huntress,
  } as unknown as Env;
}

describe("ipAllowed — fail closed (audit F2)", () => {
  it("ENFORCES when the var is unset (the key F2 fix)", () => {
    expect(ipAllowed(reqFrom(TIER2_IP), envWith(undefined))).toBe(true);
    expect(ipAllowed(reqFrom("9.9.9.9"), envWith(undefined))).toBe(false);
    expect(ipAllowed(reqFrom(undefined), envWith(undefined))).toBe(false); // absent header fails closed
  });

  it("ENFORCES on 'true' and any non-disabling value (incl. mixed case)", () => {
    for (const v of ["true", "True", "TRUE", "yes", "on", "1", "enforce"]) {
      expect(ipAllowed(reqFrom("9.9.9.9"), envWith(v))).toBe(false);
      expect(ipAllowed(reqFrom(TIER2_IP), envWith(v))).toBe(true);
    }
  });

  it("only disables on an explicit, normalized false / 0 / empty", () => {
    for (const v of ["false", "False", "  FALSE  ", "0", "", "   "]) {
      expect(ipAllowed(reqFrom("9.9.9.9"), envWith(v))).toBe(true);
    }
  });
});

describe("per-product ENABLE_* flags", () => {
  it("defaults (unset flags) to tier2 on, Huntress off", () => {
    expect(ipAllowed(reqFrom(TIER2_IP), envWith("true"))).toBe(true);
    expect(ipAllowed(huntressReq(), envWith("true"))).toBe(false);
    // An empty flag string also falls back to the product default.
    expect(ipAllowed(huntressReq(), envWith("true", { huntress: "" }))).toBe(false);
  });

  it("enables Huntress (exact IPs) only when ENABLE_HUNTRESS is on", () => {
    for (const ip of [...PRODUCTS.huntress!.ips]) {
      expect(ipAllowed(huntressReq(ip), envWith("true", { huntress: "true" }))).toBe(true);
    }
    // tier2 still works alongside it (its flag left at the default).
    expect(ipAllowed(reqFrom(TIER2_IP), envWith("true", { huntress: "true" }))).toBe(true);
  });

  it("can disable tier2 explicitly (Huntress-only)", () => {
    const huntressOnly = { tier2: "false", huntress: "true" };
    expect(ipAllowed(huntressReq(), envWith("true", huntressOnly))).toBe(true);
    expect(ipAllowed(reqFrom(TIER2_IP), envWith("true", huntressOnly))).toBe(false);
  });

  it("accepts assorted truthy spellings and treats other values as off", () => {
    for (const on of ["true", "TRUE", " True ", "1", "yes", "on"]) {
      expect(ipAllowed(huntressReq(), envWith("true", { huntress: on }))).toBe(true);
    }
    for (const off of ["false", "0", "no", "off", "nope"]) {
      expect(ipAllowed(huntressReq(), envWith("true", { huntress: off }))).toBe(false);
    }
  });

  it("fails closed when every product is disabled", () => {
    const allOff = { tier2: "false", huntress: "false" };
    expect(ipAllowed(reqFrom(TIER2_IP), envWith("true", allOff))).toBe(false);
    expect(ipAllowed(huntressReq(), envWith("true", allOff))).toBe(false);
  });
});

describe("User-Agent second gate (Huntress)", () => {
  const ENABLED = envWith("true", { huntress: "true" });

  it("requires BOTH the Huntress IP and its User-Agent", () => {
    // IP + correct UA -> allowed.
    expect(ipAllowed(huntressReq(), ENABLED)).toBe(true);
    // Right IP but missing/wrong UA -> rejected (the second gate).
    expect(ipAllowed(reqFrom(HUNTRESS_IP), ENABLED)).toBe(false);
    expect(ipAllowed(reqFrom(HUNTRESS_IP, "curl/8.4.0"), ENABLED)).toBe(false);
  });

  it("matches the UA case-insensitively and as a substring (version suffixes ok)", () => {
    expect(ipAllowed(reqFrom(HUNTRESS_IP, "huntress halo integration"), ENABLED)).toBe(true);
    expect(ipAllowed(reqFrom(HUNTRESS_IP, "Huntress Halo Integration/1.4.2"), ENABLED)).toBe(true);
  });

  it("does not let a correct UA in from a non-Huntress IP (IP stays mandatory)", () => {
    expect(ipAllowed(reqFrom("9.9.9.9", HUNTRESS_UA), ENABLED)).toBe(false);
  });

  it("leaves tier2 IP-only (no UA requirement)", () => {
    expect(ipAllowed(reqFrom(TIER2_IP), ENABLED)).toBe(true); // no UA header
    expect(ipAllowed(reqFrom(TIER2_IP, "anything"), ENABLED)).toBe(true);
  });
});

describe("Huntress /28 CIDR ranges (when enabled)", () => {
  const ENABLED = envWith("true", { huntress: "true" });
  // In-range IPs must still carry the Huntress UA to pass the second gate.
  const inRange = (ip: string) => ipAllowed(huntressReq(ip), ENABLED);

  it("allows IPs inside the ranges and rejects those just outside", () => {
    // 4.150.82.176/28 -> 4.150.82.176 .. 4.150.82.191
    expect(inRange("4.150.82.176")).toBe(true);
    expect(inRange("4.150.82.185")).toBe(true);
    expect(inRange("4.150.82.191")).toBe(true);
    expect(inRange("4.150.82.175")).toBe(false);
    expect(inRange("4.150.82.192")).toBe(false);
    // 172.200.220.176/28 -> 172.200.220.176 .. 172.200.220.191
    expect(inRange("172.200.220.176")).toBe(true);
    expect(inRange("172.200.220.191")).toBe(true);
    expect(inRange("172.200.220.175")).toBe(false);
    expect(inRange("172.200.220.192")).toBe(false);
  });

  it("rejects a malformed CF-Connecting-IP", () => {
    for (const bad of ["not-an-ip", "4.150.82", "999.1.1.1", "4.150.82.176.1"]) {
      expect(inRange(bad)).toBe(false);
    }
  });
});

describe("matchProduct — returns which product matched (for future routing)", () => {
  const BOTH = envWith("true", { huntress: "true" });

  it("identifies the matching enabled product", () => {
    expect(matchProduct(reqFrom(TIER2_IP), BOTH)?.key).toBe("tier2");
    expect(matchProduct(huntressReq(), BOTH)?.key).toBe("huntress");
    expect(matchProduct(huntressReq("4.150.82.180"), BOTH)?.key).toBe("huntress");
  });

  it("returns null when no enabled product matches", () => {
    // Huntress IP but Huntress disabled (default) -> null.
    expect(matchProduct(huntressReq(), envWith("true"))).toBeNull();
    // Huntress IP but wrong UA -> null (second gate).
    expect(matchProduct(reqFrom(HUNTRESS_IP), BOTH)).toBeNull();
    expect(matchProduct(reqFrom("9.9.9.9"), BOTH)).toBeNull();
    expect(matchProduct(reqFrom(undefined), BOTH)).toBeNull();
  });
});
