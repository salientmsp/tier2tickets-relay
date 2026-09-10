import { afterEach, describe, expect, it } from "vitest";
import { GoreloClient, clampPageSize, extractTicketNumber, firstNotificationCode, retryDelayMs } from "../src/core/gorelo.js";
import type { CreatePublicTicketCommand, Env } from "../src/core/types.js";

describe("extractTicketNumber", () => {
  it("reads the live create-response `id` field", () => {
    expect(extractTicketNumber({ id: "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a" })).toBe(
      "cb83b6cf-959c-4eed-afb8-ba3e18a3c53a",
    );
  });

  it("still tolerates the earlier `ticketId` field name", () => {
    expect(extractTicketNumber({ ticketId: "abc" })).toBe("abc");
  });

  it("unwraps a nested envelope and returns null when nothing matches", () => {
    expect(extractTicketNumber({ data: { id: "nested" } })).toBe("nested");
    expect(extractTicketNumber({ nope: 1 })).toBeNull();
    expect(extractTicketNumber(null)).toBeNull();
  });
});

describe("firstNotificationCode", () => {
  it("pulls the 6-digit Code off the standard error envelope (Notifications[])", () => {
    const body = JSON.stringify({
      StatusCode: 400,
      IsSuccess: false,
      Data: null,
      DataContext: { TraceId: "abc" },
      Notifications: [{ Code: "070101", Message: "StatusId is required." }],
    });
    expect(firstNotificationCode(body)).toBe("070101");
  });

  it("returns null for a non-envelope / codeless / unparseable body", () => {
    expect(firstNotificationCode(JSON.stringify({ error: "boom" }))).toBeNull();
    expect(firstNotificationCode(JSON.stringify({ Notifications: [{ Message: "no code" }] }))).toBeNull();
    expect(firstNotificationCode("not json")).toBeNull();
    expect(firstNotificationCode("")).toBeNull();
  });

  it("ignores a malformed (non 6-digit) code", () => {
    expect(firstNotificationCode(JSON.stringify({ Notifications: [{ Code: "12" }] }))).toBeNull();
  });
});

describe("GoreloClient (2026-08 envelope + PascalCase wire format)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const client = (): GoreloClient =>
    new GoreloClient({ GORELO_BASE_URL: "https://gorelo.test", GORELO_API_KEY: "k" } as unknown as Env);
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("listTickets hoists paging from DataContext.Pagination and camelizes Data rows", async () => {
    globalThis.fetch = (async () =>
      json(200, {
        StatusCode: 200,
        IsSuccess: true,
        Data: [{ Id: "u1", Number: 42, DisplayNumber: "T-42" }],
        DataContext: { Pagination: { NextCursor: "next", PreviousCursor: null, HasMore: true, HasPrevious: false, TotalCount: 7 } },
        Notifications: [],
      })) as typeof fetch;
    const page = await client().listTickets({ pageSize: 50 });
    expect(page.data).toEqual([{ id: "u1", number: 42, displayNumber: "T-42" }]);
    expect(page.nextCursor).toBe("next");
    expect(page.hasMore).toBe(true);
    expect(page.totalCount).toBe(7);
  });

  it("createTicket sends a PascalCase body and reads the created id out of the envelope", async () => {
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(200, { StatusCode: 200, IsSuccess: true, Data: { Id: "new-uuid" }, DataContext: null, Notifications: [] });
    }) as typeof fetch;
    const cmd = {
      title: "Hi",
      createdByName: "Bot",
      clientId: 10,
      locationId: null,
      contactId: null,
      description: "d",
      statusId: 1,
      groupId: 7,
      typeId: 3,
      priorityId: 2,
      sourceId: 6,
      agentAssetIds: [],
      sendTicketCreatedEmail: false,
    } as CreatePublicTicketCommand;
    const result = await client().createTicket(cmd);
    expect(extractTicketNumber(result)).toBe("new-uuid");
    expect(sent).toMatchObject({ Title: "Hi", StatusId: 1, ClientId: 10, SendTicketCreatedEmail: false });
    expect(sent).not.toHaveProperty("title"); // no camelCase key survives (would be a 400)
  });

  it("createTicket throws a GoreloError carrying the 6-digit Notifications code", async () => {
    globalThis.fetch = (async () =>
      json(400, {
        StatusCode: 400,
        IsSuccess: false,
        Data: null,
        DataContext: { TraceId: "t1" },
        Notifications: [{ Code: "070101", Message: "StatusId is required." }],
      })) as typeof fetch;
    await expect(client().createTicket({} as CreatePublicTicketCommand)).rejects.toMatchObject({
      name: "GoreloError",
      status: 400,
      code: "070101",
    });
  });

  it("updateTicket PATCHes a PascalCase body against /v1/tickets/{id}", async () => {
    let sent: { method?: string; url?: string; body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent = { method: init?.method, url: String(input), body: JSON.parse(String(init?.body)) };
      return json(200, { StatusCode: 200, IsSuccess: true, Data: { Id: "ticket-uuid" }, DataContext: null, Notifications: [] });
    }) as typeof fetch;
    await client().updateTicket("ticket-uuid", { statusId: 5 });
    expect(sent.method).toBe("PATCH");
    expect(sent.url).toBe("https://gorelo.test/v1/tickets/ticket-uuid");
    expect(sent.body).toEqual({ StatusId: 5 });
  });

  it("updateTicket throws a GoreloError carrying the 6-digit Notifications code", async () => {
    globalThis.fetch = (async () =>
      json(400, {
        StatusCode: 400,
        IsSuccess: false,
        Data: null,
        DataContext: { TraceId: "t1" },
        Notifications: [{ Code: "070101", Message: "Ticket not found." }],
      })) as typeof fetch;
    await expect(client().updateTicket("missing-uuid", { statusId: 5 })).rejects.toMatchObject({
      name: "GoreloError",
      status: 400,
      code: "070101",
    });
  });

  it("addTicketComment POSTs a Public comment (ConversationTypeId 1) with the HTML body", async () => {
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(200, { StatusCode: 200, IsSuccess: true, Data: { Id: "comment-uuid" }, DataContext: null, Notifications: [] });
    }) as typeof fetch;
    await client().addTicketComment("ticket-uuid", "<b>Resolved</b>");
    expect(sent).toEqual({ ConversationTypeId: 1, Body: "<b>Resolved</b>" });
  });

  it("addTicketComment includes CreatedByName when given, so the comment shows which integration posted it", async () => {
    let sent: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json(200, { StatusCode: 200, IsSuccess: true, Data: { Id: "comment-uuid" }, DataContext: null, Notifications: [] });
    }) as typeof fetch;
    await client().addTicketComment("ticket-uuid", "<b>Resolved</b>", "Huntress via API");
    expect(sent).toEqual({ ConversationTypeId: 1, Body: "<b>Resolved</b>", CreatedByName: "Huntress via API" });
  });

  it("addTicketComment throws a GoreloError on non-2xx", async () => {
    globalThis.fetch = (async () => json(500, { StatusCode: 500, IsSuccess: false, Data: null, DataContext: null, Notifications: [] })) as typeof fetch;
    await expect(client().addTicketComment("ticket-uuid", "hi")).rejects.toMatchObject({
      name: "GoreloError",
      status: 500,
    });
  });

  it("listAgents follows the envelope and camelizes device fields", async () => {
    globalThis.fetch = (async () =>
      json(200, {
        StatusCode: 200,
        IsSuccess: true,
        Data: [{ Id: "a1", DisplayName: "PC", LocalIPAddress: "10.0.0.1", OsName: "Win" }],
        DataContext: { Pagination: { NextCursor: null, HasMore: false } },
        Notifications: [],
      })) as typeof fetch;
    const agents = await client().listAgents();
    expect(agents).toEqual([{ id: "a1", displayName: "PC", localIPAddress: "10.0.0.1", osName: "Win" }]);
  });
});

describe("clampPageSize", () => {
  it("clamps to the accepted 1–200 range (was silently clamped, now a 400)", () => {
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(-5)).toBe(1);
    expect(clampPageSize(500)).toBe(200);
    expect(clampPageSize(200)).toBe(200);
    expect(clampPageSize(50)).toBe(50);
  });

  it("falls back to 50 for a non-finite size", () => {
    expect(clampPageSize(NaN)).toBe(50);
    expect(clampPageSize(Infinity)).toBe(50);
  });
});

const withRetryAfter = (value: string | null): Response =>
  new Response("", { status: 429, headers: value == null ? {} : { "retry-after": value } });

describe("retryDelayMs", () => {
  it("honors a numeric Retry-After (delta-seconds)", () => {
    expect(retryDelayMs(withRetryAfter("5"), 1)).toBe(5000);
  });

  it("honors an HTTP-date Retry-After", () => {
    const when = new Date(Date.now() + 4000).toUTCString(); // ~4s out
    const ms = retryDelayMs(withRetryAfter(when), 1);
    // Allow for sub-second clock drift between building the date and reading it.
    expect(ms).toBeGreaterThan(2500);
    expect(ms).toBeLessThanOrEqual(4000);
  });

  it("caps an over-long Retry-After", () => {
    expect(retryDelayMs(withRetryAfter("9999"), 1)).toBe(15_000);
  });

  it("treats a negative Retry-After as no wait", () => {
    expect(retryDelayMs(withRetryAfter("-5"), 1)).toBe(0);
  });

  it("falls back to exponential backoff (with jitter) when no header", () => {
    // attempt 1 -> base 500ms; jitter adds [0,250).
    const ms = retryDelayMs(withRetryAfter(null), 1);
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(750);
    // attempt 3 -> base 2000ms.
    const ms3 = retryDelayMs(withRetryAfter(null), 3);
    expect(ms3).toBeGreaterThanOrEqual(2000);
    expect(ms3).toBeLessThan(2250);
  });

  it("caps exponential backoff at 8s (+jitter) for high attempt counts", () => {
    const ms = retryDelayMs(withRetryAfter(null), 10);
    expect(ms).toBeGreaterThanOrEqual(8000);
    expect(ms).toBeLessThan(8250);
  });

  it("falls back to backoff when Retry-After is unparseable", () => {
    const ms = retryDelayMs(withRetryAfter("soon"), 1);
    expect(ms).toBeGreaterThanOrEqual(500);
    expect(ms).toBeLessThan(750);
  });
});
