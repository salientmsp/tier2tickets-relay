import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeHost } from "../src/parse.js";

describe("normalization helpers", () => {
  it("normalizeHost strips domain and lowercases", () => {
    expect(normalizeHost("PC-01.corp.local")).toBe("pc-01");
    expect(normalizeHost("BOX02")).toBe("box02");
    expect(normalizeHost("  Host.Example.COM ")).toBe("host");
    expect(normalizeHost(undefined)).toBe("");
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  User@Corp.COM ")).toBe("user@corp.com");
    expect(normalizeEmail(null)).toBe("");
  });
});
