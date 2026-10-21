import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  ACCOUNT_PARAM,
  accountsFromServices,
  CALENDAR_LIST_TOOL,
  CALENDARS_TOOL,
  calendarsFromData,
  createComposioSources,
  emailsFromData,
  eventsFromData,
  firstAccountSources,
  GMAIL_FETCH_TOOL,
  GMAIL_HEADERS_OPTION,
  GMAIL_MESSAGE_TOOL,
  GMAIL_PROFILE_TOOL,
  GMAIL_THREAD_TOOL,
  messageFromData,
  messageGone,
  profileFromData,
  READ_TIMEOUT_MS,
  SourceError,
  threadFromData,
  toolData,
  type SourceAccount,
} from "./assistant-sources.ts";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./testing/fixtures/${name}`, import.meta.url), "utf8"));
const encode = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
/** A tools/call answer as Composio's multi-execute relays it. */
const multi = (slug: string, response: unknown) => ({ jsonrpc: "2.0", id: "omb-assistant-call", result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response }] }, error: null }) }] } });

function relayWith(answer: (payload: any) => { status?: number; body: unknown }) {
  const calls: any[] = [];
  const relay = vi.fn(async (payload: any, session?: string) => {
    calls.push({ payload, session });
    if (payload.method === "initialize") return { status: 200, bytes: encode({ jsonrpc: "2.0", id: payload.id, result: {} }), transportSessionId: "s1" };
    if (payload.method === "notifications/initialized") return { status: 202, bytes: new Uint8Array() };
    const { status = 200, body } = answer(payload);
    return { status, bytes: encode(body) };
  });
  return { relay, calls };
}

const PRIMARY = { id: "primary", owned: true };
const G1: SourceAccount = { service: "gmail", id: "ca_g1", active: true };
const C1: SourceAccount = { service: "googlecalendar", id: "ca_c1", active: true };
const services = async () => ({
  gmail: { connected: true, accounts: [{ id: "ca_g1", status: "ACTIVE" }] },
  googlecalendar: { connected: true, accounts: [{ id: "ca_c1", status: "ACTIVE" }] },
  slack: { connected: true, accounts: [] },
});
const ANSWERS: Record<string, string> = {
  [GMAIL_PROFILE_TOOL]: "composio-gmail-profile.json",
  [CALENDARS_TOOL]: "composio-calendar-list.json",
  [CALENDAR_LIST_TOOL]: "composio-calendar-events.json",
  [GMAIL_FETCH_TOOL]: "composio-gmail-fetch.json",
  [GMAIL_MESSAGE_TOOL]: "composio-gmail-message.json",
  [GMAIL_THREAD_TOOL]: "composio-gmail-thread.json",
};

/** Sources over a relay that answers each tool from its fixture, unless `answer` returns another response for that item. */
function google(options: { answer?: (item: any) => unknown; connectedServices?: Parameters<typeof createComposioSources>[0]["connectedServices"] } = {}) {
  const { relay, calls } = relayWith((payload) => {
    const item = payload.params.arguments.tools[0];
    return { body: multi(item.tool_slug, options.answer?.(item) ?? { successful: true, data: fixture(ANSWERS[item.tool_slug]!) }) };
  });
  const sources = createComposioSources({ configured: () => true, connectedServices: options.connectedServices ?? services, relay });
  const toolItems = (): any[] => calls.filter((call) => call.payload.method === "tools/call").map((call) => call.payload.params.arguments.tools[0]);
  const eventsListArgs = () => toolItems().filter((item) => item.tool_slug === CALENDAR_LIST_TOOL).map((item) => item.arguments);
  return { sources, relay, calls, toolItems, eventsListArgs };
}

describe("eventsFromData", () => {
  it("reads Google event resources: times, attendees without rooms, series, declines, all-day and a join link from data only", () => {
    const events = eventsFromData(fixture("composio-calendar-events.json"), PRIMARY);
    expect(events.map((event) => event.id)).toEqual(["demo-1", "weekly-2_20261017", "holiday", "gone"]);
    expect(events[0]).toMatchObject({ title: "Supamaus demo with Jake", start: Date.parse("2026-10-17T17:00:00.000Z"), allDay: false, status: "confirmed", selfDeclined: false,
      joinUrl: "https://meet.google.com/abc-defg-hij", description: "Walk Pin through the bot dashboard." });
    expect(events[0]!.attendees).toEqual([
      { email: "me@example.test", self: true, organizer: true, response: "accepted" },
      { email: "jake@pin.example", name: "Jake Price", self: false, organizer: false, response: "accepted" },
    ]);
    expect(events[1]).toMatchObject({ seriesId: "weekly-2", selfDeclined: true, joinUrl: "https://zoom.us/j/1", start: Date.parse("2026-10-17T03:30:00Z") });
    expect(events[2]).toMatchObject({ allDay: true });
    expect(events[3]).toMatchObject({ status: "cancelled", title: "Untitled meeting" });
  });

  it("takes a list wherever the tool put it, and refuses an answer with none", () => {
    expect(eventsFromData([{ id: "a", start: { dateTime: "2026-10-17T10:00:00Z" } }], PRIMARY)).toHaveLength(1);
    expect(eventsFromData({ response_data: { items: [] } }, PRIMARY)).toEqual([]);
    expect(() => eventsFromData({ message: "Calendar API has not been used in project" }, PRIMARY)).toThrow(/no event list/);
  });
});

describe("unreadable lists", () => {
  it("a non-empty list where nothing parses is an error, an empty list is empty, a mixed list keeps what parses", () => {
    expect(() => eventsFromData({ items: [{ event_id: "a", start: { dateTime: "2026-10-17T10:00:00Z" } }] }, PRIMARY)).toThrow(/none of the calendar events/);
    expect(() => emailsFromData({ messages: [{ message_id: "m", subject: "hi" }] }, "ca_g1")).toThrow(/none of the Gmail messages/);
    expect(eventsFromData({ items: [] }, PRIMARY)).toEqual([]);
    expect(emailsFromData({ messages: [] }, "ca_g1")).toEqual([]);
    expect(eventsFromData({ items: [{ event_id: "a" }, { id: "b", start: { dateTime: "2026-10-17T10:00:00Z" } }] }, PRIMARY).map((event) => event.id)).toEqual(["b"]);
    expect(emailsFromData({ messages: [{ message_id: "m" }, { id: "n" }] }, "ca_g1").map((email) => email.id)).toEqual(["n"]);
  });

  it("a calendar of only cancelled instances without a start is empty; any other unreadable item still throws", () => {
    expect(eventsFromData({ items: [{ id: "c1", status: "cancelled" }, { id: "c2", status: "cancelled" }] }, PRIMARY)).toEqual([]);
    expect(() => eventsFromData({ items: [{ id: "c1", status: "cancelled" }, { event_id: "x" }] }, PRIMARY)).toThrow(/none of the calendar events/);
  });

  it("drops a cancelled instance without a start, keeps tentative, and ends a missing end at the start", () => {
    const start = { dateTime: "2026-10-17T10:00:00Z" };
    const events = eventsFromData({ items: [{ id: "c", status: "cancelled" }, { id: "t", status: "tentative", start }] }, PRIMARY);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "t", status: "tentative", start: Date.parse(start.dateTime), end: Date.parse(start.dateTime) });
  });
});

describe("emailsFromData", () => {
  it("keeps the id, thread, time, sender, subject and a short preview, whatever the field names", () => {
    expect(emailsFromData(fixture("composio-gmail-fetch.json"), "ca_g1")).toEqual([
      { id: "important-1", account: "ca_g1", threadId: "thread-important", at: Date.parse("2026-10-17T05:50:00Z"), from: "Ada <ada@example.test>", subject: "Q3 numbers due Friday", preview: "Can you send the Q3 numbers by Friday? Thanks" },
      { id: "newsletter-1", account: "ca_g1", threadId: "thread-news", at: 1792216200000, from: "News <news@example.test>", subject: "This week in tech", preview: "Top stories" },
    ]);
    expect(() => emailsFromData({ error: "nope" }, "ca_g1")).toThrow(/no message list/);
  });

  it("keeps a message's Message-ID header when the answer carries one", () => {
    const [email] = emailsFromData({ messages: [{ id: "m", payload: { headers: [{ name: "Message-Id", value: " <x@y.example> " }] } }] }, "ca_g2");
    expect(email).toMatchObject({ id: "m", account: "ca_g2", messageIdHeader: "<x@y.example>" });
    expect(emailsFromData({ messages: [{ id: "n" }] }, "ca_g2")[0]).not.toHaveProperty("messageIdHeader");
  });
});

describe("messageGone", () => {
  it("calls a message gone only when the answer says the message itself is missing, never for an account, a tool or a stray 404", () => {
    for (const text of ["Requested entity was not found.", "Message not found", "The email was deleted", "Thread no longer exists"]) expect(messageGone(text), text).toBe(true);
    for (const text of [
      "Connected account ca_g1 not found", "Connected account has been deleted", "Tool GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID not found",
      "Rate limit exceeded for message 18c404ab", "404", "Not found", "Message not found: the OAuth token was revoked",
      "Message not found: missing permission", "Messages not found", "Rate limit exceeded",
    ]) expect(messageGone(text), text).toBe(false);
  });
});

describe("accountsFromServices", () => {
  it("lists each Gmail and Calendar account with its status, and one implied account when a connected service lists none", () => {
    expect(accountsFromServices({
      gmail: { connected: true, accounts: [{ id: "ca_g1", status: "ACTIVE" }, { id: "ca_g2", alias: "admin", status: "EXPIRED" }] },
      googlecalendar: { connected: true }, slack: { connected: true, accounts: [{ id: "ca_s", status: "ACTIVE" }] },
    })).toEqual([{ service: "gmail", id: "ca_g1", active: true }, { service: "gmail", id: "ca_g2", alias: "admin", active: false },
      { service: "googlecalendar", id: "googlecalendar", active: true, implied: true }]);
    expect(accountsFromServices({}).map((account) => [account.id, account.active])).toEqual([["gmail", false], ["googlecalendar", false]]);
  });

  it("implies one account for a service that sends an empty account list, as the managed connected apps do", () => {
    expect(accountsFromServices({ gmail: { connected: true, accounts: [] }, googlecalendar: { connected: false, accounts: [] } })).toEqual([
      { service: "gmail", id: "gmail", active: true, implied: true },
      { service: "googlecalendar", id: "googlecalendar", active: false, implied: true },
    ]);
  });
});

describe("Google resource parsers", () => {
  it("keeps each event's iCalUID, original start and organizer", () => {
    const [event] = eventsFromData({ items: [{ id: "e_20261021T100000Z", iCalUID: "uid-1@google.com", recurringEventId: "e",
      originalStartTime: { dateTime: "2026-10-21T10:00:00Z" }, organizer: { email: "Ada@Pin.Example" },
      start: { dateTime: "2026-10-21T11:00:00Z" }, end: { dateTime: "2026-10-21T11:30:00Z" } }] }, { id: "admin@example.test", owned: true });
    expect(event).toMatchObject({ iCalUID: "uid-1@google.com", originalStart: Date.parse("2026-10-21T10:00:00Z"), organizer: "ada@pin.example",
      calendarId: "admin@example.test", ownedCalendar: true });
  });

  it("marks the primary calendar and the selected, visible ones to read, and the primary and owner ones as owned", () => {
    expect(calendarsFromData(fixture("composio-calendar-list.json"))).toEqual([
      { id: "admin@example.test", name: "admin@example.test", primary: true, owned: true, read: true },
      { id: "team@group.calendar.google.com", name: "Team", primary: false, owned: true, read: true },
      { id: "ada@example.test", name: "Ada", primary: false, owned: false, read: true },
      { id: "en.indian#holiday@group.v.calendar.google.com", name: "Holidays in India", primary: false, owned: false, read: false },
      { id: "hidden@group.calendar.google.com", name: "Hidden", primary: false, owned: true, read: false },
    ]);
    expect(calendarsFromData({ calendars: [{ id: "a@x.test", primary: true, hidden: true }] })).toEqual([{ id: "a@x.test", name: "a@x.test", primary: true, owned: true, read: true }]);
  });

  it("names a calendar by its summary on one plain line of at most 80 characters, else by its id", () => {
    const [named, unnamed] = calendarsFromData({ items: [
      { id: "c1", summary: `Board\u202e\u001b[31m\n  room ${"\u{1F600}".repeat(100)}` },
      { id: "c2", summary: " \u200b " },
    ] });
    expect(named!.name).toBe(`Board[31m room ${"\u{1F600}".repeat(65)}`);
    expect(unnamed!.name).toBe("c2");
  });

  it("an unreadable profile, calendar list, message or thread answer is an error, never empty data", () => {
    expect(() => profileFromData({ messagesTotal: 3 })).toThrow(/no address/);
    expect(() => profileFromData({ emailAddress: "not an address" })).toThrow(/no address/);
    expect(() => calendarsFromData({ message: "nope" })).toThrow(/no calendar list/);
    expect(() => calendarsFromData({ items: [{ summary: "x" }] })).toThrow(/none of the calendars/);
    expect(() => messageFromData({ snippet: "x" }, "ca_g1")).toThrow(/message could not be read/);
    expect(() => threadFromData({ id: "t" })).toThrow(/no message list/);
    expect(() => threadFromData({ messages: [{ snippet: "x" }] })).toThrow(/none of the thread's messages/);
  });
});

describe("toolData", () => {
  it("unwraps one tool's data from a multi-execute answer, or a direct answer", () => {
    expect(toolData(GMAIL_FETCH_TOOL, multi(GMAIL_FETCH_TOOL, { successful: true, data: { messages: [] } }))).toEqual({ messages: [] });
    const direct = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ successful: true, data: { items: [] } }) }] } };
    expect(toolData(CALENDAR_LIST_TOOL, direct)).toEqual({ items: [] });
  });

  it("an answer it cannot read is an error, never empty data", () => {
    const text = (body: string) => ({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: body }] } });
    for (const frame of [
      null,
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "session expired" } },
      text("<html>Bad gateway</html>"),
      { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "USER_NOT_LOGGED_IN" }], isError: true } },
      text(JSON.stringify({ successful: false, error: "Multiple gmail accounts are connected; select one" })),
      text(JSON.stringify({ successful: true, data: { results: [{ tool_slug: "OTHER_TOOL", response: { successful: true, data: {} } }] } })),
      multi(GMAIL_FETCH_TOOL, { successful: false, error: "insufficient authentication scopes" }),
      text(JSON.stringify({ successful: true })),
    ]) {
      expect(() => toolData(GMAIL_FETCH_TOOL, frame as Record<string, unknown> | null), JSON.stringify(frame)).toThrow();
    }
  });
});

describe("createComposioSources", () => {
  it("walks the MCP handshake for each call, and asks for each calendar's window through the multi-execute tool", async () => {
    const { sources, calls, toolItems } = google({ answer: (item) => item.tool_slug === CALENDARS_TOOL ? { successful: true, data: { items: [{ id: "admin@example.test", primary: true, accessRole: "owner" }] } } : undefined });
    const events = await sources.events(C1, Date.parse("2026-10-17T00:00:00Z"), Date.parse("2026-10-18T12:00:00Z"));
    expect(events).toHaveLength(4);
    expect(calls.map((call) => call.payload.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "initialize", "notifications/initialized", "tools/call"]);
    expect(calls[5]).toEqual({ session: "s1", payload: { jsonrpc: "2.0", id: "omb-assistant-call", method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{
      tool_slug: "GOOGLECALENDAR_EVENTS_LIST",
      arguments: { calendarId: "admin@example.test", timeMin: "2026-10-17T00:00:00.000Z", timeMax: "2026-10-18T12:00:00.000Z", singleEvents: true, orderBy: "startTime", maxResults: 100, showDeleted: true },
      account: "ca_c1",
    }] } } } });
    expect(toolItems()[0]).toEqual({ tool_slug: "GOOGLECALENDAR_LIST_CALENDARS", arguments: {}, account: "ca_c1" });
  });

  it("asks Gmail for the inbox since a time, without promotions or social, without payloads while one Gmail account is active", async () => {
    const { sources, toolItems } = google();
    await sources.accounts();
    expect(await sources.emails(G1, Date.parse("2026-10-16T06:00:00Z"), 50)).toHaveLength(2);
    expect(toolItems()[0]).toEqual({ tool_slug: "GMAIL_FETCH_EMAILS", account: "ca_g1",
      arguments: { user_id: "me", query: "in:inbox after:1792130400 -category:promotions -category:social", max_results: 50, include_payload: false, verbose: false } });
  });

  it("asks for each message's headers only while two or more Gmail accounts are active, the one case where copies can exist", async () => {
    let gmail = [{ id: "ca_g1", status: "ACTIVE" }, { id: "ca_g2", status: "ACTIVE" }];
    const { sources, toolItems } = google({ connectedServices: async () => ({ gmail: { connected: true, accounts: gmail } }) });
    const payload = async () => {
      await sources.emails(G1, 0, 5);
      return toolItems().at(-1).arguments.include_payload;
    };
    expect(await payload()).toBe(false);
    await sources.accounts();
    expect(await payload()).toBe(GMAIL_HEADERS_OPTION.include_payload);
    gmail = [{ id: "ca_g1", status: "ACTIVE" }, { id: "ca_g2", status: "EXPIRED" }];
    await sources.accounts();
    expect(await payload()).toBe(false);
  });

  it("asks whether attendees wrote since a time, with only well-formed addresses in the query", async () => {
    const { sources, relay, toolItems } = google({ answer: () => ({ successful: true, data: { messages: [] } }) });
    expect(await sources.mailFrom(G1, ["ada@example.test", "x) OR (in:sent", "jake@pin.example"], Date.parse("2026-10-10T00:00:00Z"))).toBe(false);
    expect(toolItems()[0]).toEqual({ tool_slug: "GMAIL_FETCH_EMAILS", account: "ca_g1",
      arguments: { user_id: "me", query: "from:(ada@example.test OR jake@pin.example) after:1791590400", max_results: 1, include_payload: false, verbose: false } });
    expect(await sources.mailFrom(G1, ["x) OR (in:sent"], 0)).toBe(false);
    const before = relay.mock.calls.length;
    expect(await sources.mailFrom(G1, ["-ada@example.test"], 0)).toBe(false);
    expect(relay.mock.calls.length).toBe(before);
  });

  it("names the service and the account in every failure: a refused handshake, an HTTP error, an unreadable answer", async () => {
    for (const answer of [() => ({ status: 429, body: { error: "rate limited" } }), () => ({ body: "<html>" })]) {
      const sources = createComposioSources({ configured: () => true, connectedServices: services, relay: relayWith(answer).relay });
      await expect(sources.emails(G1, 0, 20)).rejects.toMatchObject({ name: "SourceError", service: "gmail", account: "ca_g1" });
      await expect(sources.events(C1, 0, 1)).rejects.toBeInstanceOf(SourceError);
    }
    const refused = createComposioSources({ configured: () => true, connectedServices: services, relay: async () => ({ status: 401, bytes: encode({}) }) });
    await expect(refused.events(C1, 0, 1)).rejects.toMatchObject({ service: "googlecalendar", account: "ca_c1" });
  });

  it("gives every relay call of one read the read's own short deadline, and a read past it fails as that account's", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const stalled = vi.fn((payload: any, _session?: string, signal?: AbortSignal) => {
      signals.push(signal);
      if (payload.method !== "tools/call") return Promise.resolve({ status: 200, bytes: encode({ jsonrpc: "2.0", id: payload.id, result: {} }), transportSessionId: "s1" });
      return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    });
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay: stalled, readTimeoutMs: 20 });
    await expect(sources.events(C1, 0, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar", account: "ca_c1", message: expect.stringContaining("did not answer") });
    await expect(sources.emails(G1, 0, 20)).rejects.toMatchObject({ service: "gmail", account: "ca_g1", message: expect.stringContaining("did not answer") });
    expect(signals).toHaveLength(6);
    expect(new Set(signals.slice(0, 3)).size).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[3]).not.toBe(signals[0]);
    expect(READ_TIMEOUT_MS).toBe(60_000);
  });

  it("refuses a non-finite time before any relay call", async () => {
    const { sources, relay } = google();
    await expect(sources.events(C1, Number.NaN, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar", account: "ca_c1" });
    await expect(sources.events(C1, 0, Number.POSITIVE_INFINITY)).rejects.toMatchObject({ service: "googlecalendar" });
    await expect(sources.emails(G1, Number.NaN, 20)).rejects.toMatchObject({ service: "gmail", account: "ca_g1" });
    await expect(sources.mailFrom(G1, ["ada@example.test"], Number.NaN)).rejects.toMatchObject({ service: "gmail" });
    expect(relay).not.toHaveBeenCalled();
  });

  it("an unreadable list is a SourceError naming its service and account", async () => {
    const calendar = google({ answer: (item) => item.tool_slug === CALENDAR_LIST_TOOL ? { successful: true, data: { items: [{ event_id: "a" }] } } : undefined });
    await expect(calendar.sources.events(C1, 0, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar", account: "ca_c1" });
    const mail = google({ answer: () => ({ successful: true, data: { messages: [{ message_id: "m" }] } }) });
    await expect(mail.sources.emails(G1, 0, 20)).rejects.toMatchObject({ name: "SourceError", service: "gmail", account: "ca_g1" });
  });

  it("lists accounts, and null when connected apps are not set up or cannot be reached", async () => {
    const { relay } = relayWith(() => ({ body: {} }));
    expect(await createComposioSources({ configured: () => true, connectedServices: services, relay }).accounts()).toEqual([
      { service: "gmail", id: "ca_g1", active: true }, { service: "googlecalendar", id: "ca_c1", active: true }]);
    expect(await createComposioSources({ configured: () => false, connectedServices: services, relay }).accounts()).toBeNull();
    expect(await createComposioSources({ configured: () => true, connectedServices: async () => { throw new Error("down"); }, relay }).accounts()).toBeNull();
    expect(relay).not.toHaveBeenCalled();
  });

  it("names the account in every call, and no account for an implied one", async () => {
    const { sources, toolItems } = google();
    await sources.emails(G1, 0, 5);
    await sources.mailFrom(G1, ["ada@pin.example"], 0);
    await sources.address(G1);
    await sources.message(G1, "m-1");
    await sources.thread(G1, "t-1");
    await sources.events(C1, 0, 1);
    await sources.address(C1);
    expect(new Set(toolItems().map((item) => item.tool_slug))).toEqual(new Set([GMAIL_FETCH_TOOL, GMAIL_PROFILE_TOOL, GMAIL_MESSAGE_TOOL, GMAIL_THREAD_TOOL, CALENDARS_TOOL, CALENDAR_LIST_TOOL]));
    for (const item of toolItems()) expect(item[ACCOUNT_PARAM]).toBe(item.tool_slug.startsWith("GMAIL_") ? "ca_g1" : "ca_c1");
    await sources.emails({ service: "gmail", id: "gmail", active: true, implied: true }, 0, 5);
    expect(toolItems().at(-1)).not.toHaveProperty(ACCOUNT_PARAM);
    const before = toolItems().length;
    await sources.events({ service: "googlecalendar", id: "googlecalendar", active: true, implied: true }, 0, 1);
    for (const item of toolItems().slice(before)) expect(item).not.toHaveProperty(ACCOUNT_PARAM);
  });

  it("reads a Gmail account's address from its profile and a Calendar account's from its primary calendar", async () => {
    const { sources, toolItems } = google();
    expect(await sources.address(G1)).toBe("admin@example.test");
    expect(await sources.address(C1)).toBe("admin@example.test");
    expect(toolItems().map((item) => [item.tool_slug, item.arguments])).toEqual([[GMAIL_PROFILE_TOOL, { user_id: "me" }], [CALENDARS_TOOL, {}]]);
    const unnamed = google({ answer: () => ({ successful: true, data: { items: [{ id: "team@group.calendar.google.com", accessRole: "owner", selected: true }] } }) });
    expect(await unnamed.sources.address(C1)).toBeNull();
  });

  it("reads the primary calendar and every selected calendar that is not hidden, and marks the ones the account owns", async () => {
    const { sources, eventsListArgs } = google();
    const events = await sources.events(C1, Date.parse("2026-10-21T00:00:00Z"), Date.parse("2026-10-22T12:00:00Z"));
    expect(eventsListArgs().map((args) => args.calendarId)).toEqual(["admin@example.test", "team@group.calendar.google.com", "ada@example.test"]);
    expect(new Set(events.map((event) => `${event.calendarId}:${event.ownedCalendar}`)))
      .toEqual(new Set(["admin@example.test:true", "team@group.calendar.google.com:true", "ada@example.test:false"]));
  });

  it("still reads the primary calendar when the calendar list names none as primary", async () => {
    const { sources, eventsListArgs } = google({ answer: (item) => item.tool_slug === CALENDARS_TOOL
      ? { successful: true, data: { items: [{ id: "team@group.calendar.google.com", accessRole: "owner", selected: true }] } } : undefined });
    const events = await sources.events(C1, 0, 1);
    expect(eventsListArgs().map((args) => args.calendarId)).toEqual(["primary", "team@group.calendar.google.com"]);
    expect(events.find((event) => event.calendarId === "primary")).toMatchObject({ ownedCalendar: true });
  });

  it("fails the whole account when any one of its calendars cannot be read, naming that calendar", async () => {
    const { sources } = google({ answer: (item) => item.arguments.calendarId === "team@group.calendar.google.com" ? { successful: false, error: "insufficient authentication scopes" } : undefined });
    await expect(sources.events(C1, 0, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar", account: "ca_c1",
      message: "calendar Team: insufficient authentication scopes" });
  });

  it("reads an account's calendars at most four at a time under one deadline, so a slow calendar does not multiply the time", async () => {
    const extra = Array.from({ length: 6 }, (_, n) => ({ id: `c${n}@group.calendar.google.com`, accessRole: "reader", selected: true }));
    const held: Array<() => void> = [];
    const signals = new Set<AbortSignal | undefined>();
    const relay = vi.fn(async (payload: any, _session?: string, signal?: AbortSignal) => {
      signals.add(signal);
      if (payload.method === "initialize") return { status: 200, bytes: encode({ jsonrpc: "2.0", id: payload.id, result: {} }), transportSessionId: "s1" };
      if (payload.method === "notifications/initialized") return { status: 202, bytes: new Uint8Array() };
      const item = payload.params.arguments.tools[0];
      if (item.tool_slug === CALENDARS_TOOL) return { status: 200, bytes: encode(multi(CALENDARS_TOOL, { successful: true, data: { items: [{ id: "admin@example.test", primary: true }, ...extra] } })) };
      await new Promise<void>((resolve) => held.push(resolve));
      return { status: 200, bytes: encode(multi(CALENDAR_LIST_TOOL, { successful: true, data: { items: [{ id: `e-${item.arguments.calendarId}`, start: { dateTime: "2026-10-21T10:00:00Z" } }] } })) };
    });
    const reading = createComposioSources({ configured: () => true, connectedServices: services, relay }).events(C1, 0, 1);
    await expect.poll(() => held.length).toBe(4);
    await new Promise((resolve) => setImmediate(resolve));
    expect(held.length).toBe(4);
    held.splice(0).forEach((release) => release());
    await expect.poll(() => held.length).toBe(3);
    held.splice(0).forEach((release) => release());
    expect((await reading).map((event) => event.calendarId)).toEqual(["admin@example.test", ...extra.map((calendar) => calendar.id)]);
    expect(signals.size).toBe(1);
  });

  it("fails the whole account once its one deadline passes, naming the calendar that did not answer", async () => {
    const relay = vi.fn(async (payload: any, _session?: string, signal?: AbortSignal) => {
      if (payload.method === "initialize") return { status: 200, bytes: encode({ jsonrpc: "2.0", id: payload.id, result: {} }), transportSessionId: "s1" };
      if (payload.method === "notifications/initialized") return { status: 202, bytes: new Uint8Array() };
      const item = payload.params.arguments.tools[0];
      if (item.tool_slug === CALENDAR_LIST_TOOL && item.arguments.calendarId === "ada@example.test") {
        return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      }
      return { status: 200, bytes: encode(multi(item.tool_slug, { successful: true, data: fixture(ANSWERS[item.tool_slug]!) })) };
    });
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay, readTimeoutMs: 20 });
    await expect(sources.events(C1, 0, 1)).rejects.toMatchObject({ name: "SourceError", account: "ca_c1",
      message: expect.stringMatching(/^calendar Ada: GOOGLECALENDAR_EVENTS_LIST did not answer within/) });
  });

  it("reads one message by id with its Message-ID header, and null only when the service says it is gone", async () => {
    const { sources, toolItems } = google({ answer: (item) => ({
      "m-9": { successful: false, error: "Requested entity was not found." },
      "m-7": { successful: false, error: "Message not found" },
      "m-8": { successful: false, error: "Rate limit exceeded" },
      "m-6": { successful: false, error: "Connected account ca_g1 not found" },
      "m-5": { successful: false, error: "Tool GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID not found" },
      "m-4": { successful: false, error: "Rate limit exceeded for message 18c404ab" },
    } as Record<string, unknown>)[item.arguments.message_id] });
    expect(await sources.message(G1, "m-1")).toMatchObject({ id: "m-1", threadId: "t-1", account: "ca_g1", subject: "Q3 numbers", messageIdHeader: "<q3@pin.example>" });
    expect(toolItems()[0]).toEqual({ tool_slug: GMAIL_MESSAGE_TOOL, account: "ca_g1", arguments: { user_id: "me", message_id: "m-1", format: "metadata" } });
    expect(await sources.message(G1, "m-9")).toBeNull();
    expect(await sources.message(G1, "m-7")).toBeNull();
    for (const id of ["m-8", "m-6", "m-5", "m-4"]) {
      await expect(sources.message(G1, id), id).rejects.toMatchObject({ name: "SourceError", service: "gmail", account: "ca_g1" });
    }
  });

  it("never calls a message gone for a failure around the tool, however it is worded", async () => {
    const notFound = createComposioSources({ configured: () => true, connectedServices: services, relay: relayWith(() => ({ status: 404, body: { error: "Not found" } })).relay });
    await expect(notFound.message(G1, "m-1")).rejects.toMatchObject({ name: "SourceError", account: "ca_g1" });
    const meta = { jsonrpc: "2.0", id: "omb-assistant-call", result: { content: [{ type: "text", text: JSON.stringify({ successful: false, error: "Connected account not found" }) }] } };
    const refused = createComposioSources({ configured: () => true, connectedServices: services, relay: relayWith(() => ({ body: meta })).relay });
    await expect(refused.message(G1, "m-1")).rejects.toMatchObject({ name: "SourceError", account: "ca_g1" });
  });

  it("reads a thread's messages with each sender's address and time", async () => {
    const { sources, toolItems } = google();
    expect(await sources.thread(G1, "t-1")).toEqual([
      { id: "m-1", at: Date.parse("2026-10-21T02:00:00Z"), from: "ada@pin.example" },
      { id: "m-2", at: Date.parse("2026-10-21T03:00:00Z"), from: "omkar@example.test" }]);
    expect(toolItems()[0]).toEqual({ tool_slug: GMAIL_THREAD_TOOL, account: "ca_g1", arguments: { user_id: "me", thread_id: "t-1" } });
  });

  it("a refusal to pick an account is that account's read failure, never empty data", async () => {
    const { sources } = google({ answer: () => ({ successful: false, error: "Multiple connected accounts found for gmail. Specify which account to use." }) });
    await expect(sources.emails(G1, 0, 5)).rejects.toMatchObject({ name: "SourceError", service: "gmail", account: "ca_g1" });
  });
});

describe("firstAccountSources", () => {
  it("reads the first active account of each service for a single-account reader", async () => {
    const { sources, toolItems } = google({ connectedServices: async () => ({
      gmail: { connected: true, accounts: [{ id: "ca_g0", status: "EXPIRED" }, { id: "ca_g1", status: "ACTIVE" }] },
      googlecalendar: { connected: true, accounts: [{ id: "ca_c1", status: "ACTIVE" }] },
    }) });
    const single = firstAccountSources(sources);
    expect(await single.connected()).toEqual({ gmail: true, googlecalendar: true });
    await single.emails(0, 5);
    expect(toolItems().at(-1)?.[ACCOUNT_PARAM]).toBe("ca_g1");
    await single.events(0, 1);
    expect(toolItems().at(-1)?.[ACCOUNT_PARAM]).toBe("ca_c1");
    await single.mailFrom(["ada@pin.example"], 0);
    expect(toolItems().at(-1)).toMatchObject({ tool_slug: GMAIL_FETCH_TOOL, [ACCOUNT_PARAM]: "ca_g1" });
  });

  it("reports no service as connected without an active account, null when listing fails, and refuses to read a service with none", async () => {
    const none = firstAccountSources(google({ connectedServices: async () => ({ gmail: { connected: false, accounts: [{ id: "ca_g0", status: "EXPIRED" }] } }) }).sources);
    expect(await none.connected()).toEqual({ gmail: false, googlecalendar: false });
    await expect(none.emails(0, 5)).rejects.toMatchObject({ name: "SourceError", service: "gmail" });
    await expect(none.events(0, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar" });
    const down = firstAccountSources(google({ connectedServices: async () => { throw new Error("down"); } }).sources);
    expect(await down.connected()).toBeNull();
  });
});
