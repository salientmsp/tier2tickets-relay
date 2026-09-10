import { describe, expect, it } from "vitest";
import { signToken, verifyToken, verifyTokenResult } from "../src/core/token.js";

const SECRET = "halo-test-secret";
const now = (): number => Math.floor(Date.now() / 1000);

describe("token sign/verify", () => {
  it("round-trips a valid, unexpired token", async () => {
    const token = await signToken(SECRET, { exp: now() + 3600 });
    expect(token.split(".")).toHaveLength(2);
    const payload = await verifyToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(typeof payload?.exp).toBe("number");
  });

  it("carries and returns arbitrary payload claims", async () => {
    const token = await signToken(SECRET, { exp: now() + 60, sub: "tier2" });
    const payload = await verifyToken(SECRET, token);
    expect(payload?.sub).toBe("tier2");
  });

  it("rejects a token signed with a different secret (invalid)", async () => {
    const token = await signToken(SECRET, { exp: now() + 3600 });
    expect(await verifyToken("other-secret", token)).toBeNull();
    expect(await verifyTokenResult("other-secret", token)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a tampered payload (invalid)", async () => {
    const token = await signToken(SECRET, { exp: now() + 3600 });
    const [, sig] = token.split(".");
    const forged = `${btoa('{"exp":9999999999}').replace(/=+$/, "")}.${sig}`;
    expect(await verifyToken(SECRET, forged)).toBeNull();
  });

  it("rejects an expired token (expired)", async () => {
    const token = await signToken(SECRET, { exp: now() - 1 });
    expect(await verifyToken(SECRET, token)).toBeNull();
    expect(await verifyTokenResult(SECRET, token)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed tokens (invalid, no throw)", async () => {
    for (const bad of ["", "no-dot", ".", "a.", ".b", "not.base64!!"]) {
      expect(await verifyTokenResult(SECRET, bad)).toMatchObject({ ok: false });
    }
  });

  it("treats a token without a numeric exp as invalid", async () => {
    // Sign a payload whose exp is not a number, then verify.
    const token = await signToken(SECRET, { exp: "soon" as unknown as number });
    expect(await verifyTokenResult(SECRET, token)).toEqual({ ok: false, reason: "invalid" });
  });
});
