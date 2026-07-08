import { describe, expect, it } from "vitest";
import {
  buildIdentity,
  emailDomain,
  normalizeEmail,
  normalizeHost,
  parseHdbTag,
  parseInbound,
  stripHdbTag,
} from "../src/parse.js";

describe("parseHdbTag", () => {
  it("parses host/mac/ip from the tag block", () => {
    const msg = "My PC is broken.\n\n[[hdb host=PC-01.corp.local mac=AA:BB:CC:DD:EE:FF ip=10.0.0.5]]";
    expect(parseHdbTag(msg)).toEqual({
      host: "PC-01.corp.local",
      mac: "AA:BB:CC:DD:EE:FF",
      ip: "10.0.0.5",
    });
  });

  it("tolerates whitespace, reordering, and the `hostname` alias", () => {
    const msg = "[[hdb   ip=1.2.3.4   hostname=box01   mac=00-11-22-33-44-55 ]]";
    expect(parseHdbTag(msg)).toEqual({
      host: "box01",
      mac: "00-11-22-33-44-55",
      ip: "1.2.3.4",
    });
  });

  it("handles quoted values", () => {
    expect(parseHdbTag('[[hdb host="my host" ip=1.1.1.1]]')).toEqual({
      host: "my host",
      ip: "1.1.1.1",
    });
  });

  it("returns empty when no tag present", () => {
    expect(parseHdbTag("just a normal message")).toEqual({});
  });
});

describe("stripHdbTag", () => {
  it("removes the tag and leaves a clean body", () => {
    const msg = "The printer is on fire.\n\n[[hdb host=pc01 mac=x ip=y]]";
    expect(stripHdbTag(msg)).toBe("The printer is on fire.");
  });

  it("removes an inline tag without mangling surrounding text", () => {
    expect(stripHdbTag("before [[hdb host=pc01]] after")).toBe("before  after");
  });

  it("is a no-op when there is no tag", () => {
    expect(stripHdbTag("hello world")).toBe("hello world");
  });
});

describe("normalization helpers", () => {
  it("normalizeHost strips domain and lowercases", () => {
    expect(normalizeHost("PC-01.corp.local")).toBe("pc-01");
    expect(normalizeHost("BOX02")).toBe("box02");
    expect(normalizeHost("  Host.Example.COM ")).toBe("host");
    expect(normalizeHost(undefined)).toBe("");
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail("  User@Corp.COM ")).toBe("user@corp.com");
  });

  it("emailDomain extracts lowercased domain", () => {
    expect(emailDomain("a@Corp.Com")).toBe("corp.com");
    expect(emailDomain("nodomain")).toBe("");
  });
});

describe("parseInbound", () => {
  it("parses JSON bodies, preferring message over msg", async () => {
    const req = new Request("https://relay/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Jane", email: "jane@corp.com", subject: "Help", message: "hi" }),
    });
    expect(await parseInbound(req)).toEqual({
      name: "Jane",
      email: "jane@corp.com",
      subject: "Help",
      message: "hi",
    });
  });

  it("falls back to msg when message is absent (Dispatcher target)", async () => {
    const req = new Request("https://relay/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Jane", email: "jane@corp.com", subject: "Help", msg: "in msg" }),
    });
    expect((await parseInbound(req)).message).toBe("in msg");
  });

  it("parses form-encoded bodies", async () => {
    const body = new URLSearchParams({
      name: "Bob",
      email: "bob@corp.com",
      subject: "Broken",
      msg: "tag here [[hdb host=pc01]]",
    });
    const req = new Request("https://relay/", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const parsed = await parseInbound(req);
    expect(parsed.name).toBe("Bob");
    expect(parsed.message).toBe("tag here [[hdb host=pc01]]");
  });
});

describe("buildIdentity", () => {
  it("normalizes fields from inbound + tag", () => {
    const id = buildIdentity(
      { name: " Jane ", email: "Jane@Corp.COM", subject: "s", message: "m" },
      { host: "PC-01.corp.local", mac: "AA:BB", ip: "10.0.0.1" },
    );
    expect(id).toEqual({
      email: "jane@corp.com",
      name: "Jane",
      host: "pc-01",
      mac: "AA:BB",
      ip: "10.0.0.1",
    });
  });
});
