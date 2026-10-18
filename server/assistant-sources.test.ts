import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { CALENDAR_LIST_TOOL, createComposioSources, emailsFromData, eventsFromData, GMAIL_FETCH_TOOL, READ_TIMEOUT_MS, SourceError, toolData } from "./assistant-sources.ts";

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

describe("eventsFromData", () => {
  it("reads Google event resources: times, attendees without rooms, series, declines, all-day and a join link from data only", () => {
    const events = eventsFromData(fixture("composio-calendar-events.json"));
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
    expect(eventsFromData([{ id: "a", start: { dateTime: "2026-10-17T10:00:00Z" } }])).toHaveLength(1);
    expect(eventsFromData({ response_data: { items: [] } })).toEqual([]);
    expect(() => eventsFromData({ message: "Calendar API has not been used in project" })).toThrow(/no event list/);
  });
});

describe("unreadable lists", () => {
  it("a non-empty list where nothing parses is an error, an empty list is empty, a mixed list keeps what parses", () => {
    expect(() => eventsFromData({ items: [{ event_id: "a", start: { dateTime: "2026-10-17T10:00:00Z" } }] })).toThrow(/none of the calendar events/);
    expect(() => emailsFromData({ messages: [{ message_id: "m", subject: "hi" }] })).toThrow(/none of the Gmail messages/);
    expect(eventsFromData({ items: [] })).toEqual([]);
    expect(emailsFromData({ messages: [] })).toEqual([]);
    expect(eventsFromData({ items: [{ event_id: "a" }, { id: "b", start: { dateTime: "2026-10-17T10:00:00Z" } }] }).map((event) => event.id)).toEqual(["b"]);
    expect(emailsFromData({ messages: [{ message_id: "m" }, { id: "n" }] }).map((email) => email.id)).toEqual(["n"]);
  });

  it("a calendar of only cancelled instances without a start is empty; any other unreadable item still throws", () => {
    expect(eventsFromData({ items: [{ id: "c1", status: "cancelled" }, { id: "c2", status: "cancelled" }] })).toEqual([]);
    expect(() => eventsFromData({ items: [{ id: "c1", status: "cancelled" }, { event_id: "x" }] })).toThrow(/none of the calendar events/);
  });

  it("drops a cancelled instance without a start, keeps tentative, and ends a missing end at the start", () => {
    const start = { dateTime: "2026-10-17T10:00:00Z" };
    const events = eventsFromData({ items: [{ id: "c", status: "cancelled" }, { id: "t", status: "tentative", start }] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "t", status: "tentative", start: Date.parse(start.dateTime), end: Date.parse(start.dateTime) });
  });
});

describe("emailsFromData", () => {
  it("keeps the id, thread, time, sender, subject and a short preview, whatever the field names", () => {
    expect(emailsFromData(fixture("composio-gmail-fetch.json"))).toEqual([
      { id: "important-1", threadId: "thread-important", at: Date.parse("2026-10-17T05:50:00Z"), from: "Ada <ada@example.test>", subject: "Q3 numbers due Friday", preview: "Can you send the Q3 numbers by Friday? Thanks" },
      { id: "newsletter-1", threadId: "thread-news", at: 1792216200000, from: "News <news@example.test>", subject: "This week in tech", preview: "Top stories" },
    ]);
    expect(() => emailsFromData({ error: "nope" })).toThrow(/no message list/);
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
  const services = async () => ({ gmail: { connected: true }, googlecalendar: { connected: false }, slack: { connected: true } });

  it("walks the MCP handshake and asks for the calendar window through the multi-execute tool", async () => {
    const { relay, calls } = relayWith(() => ({ body: multi(CALENDAR_LIST_TOOL, { successful: true, data: fixture("composio-calendar-events.json") }) }));
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay });
    const events = await sources.events(Date.parse("2026-10-17T00:00:00Z"), Date.parse("2026-10-18T12:00:00Z"));
    expect(events).toHaveLength(4);
    expect(calls.map((call) => call.payload.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(calls[2]).toEqual({ session: "s1", payload: { jsonrpc: "2.0", id: "omb-assistant-call", method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{
      tool_slug: "GOOGLECALENDAR_EVENTS_LIST",
      arguments: { calendarId: "primary", timeMin: "2026-10-17T00:00:00.000Z", timeMax: "2026-10-18T12:00:00.000Z", singleEvents: true, orderBy: "startTime", maxResults: 100, showDeleted: true },
    }] } } } });
  });

  it("asks Gmail for the inbox since a time, without promotions or social, headers only", async () => {
    const { relay, calls } = relayWith(() => ({ body: multi(GMAIL_FETCH_TOOL, { successful: true, data: fixture("composio-gmail-fetch.json") }) }));
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay });
    expect(await sources.emails(Date.parse("2026-10-16T06:00:00Z"), 50)).toHaveLength(2);
    expect(calls[2].payload.params.arguments.tools[0]).toEqual({ tool_slug: "GMAIL_FETCH_EMAILS",
      arguments: { user_id: "me", query: "in:inbox after:1792130400 -category:promotions -category:social", max_results: 50, include_payload: false, verbose: false } });
  });

  it("asks whether attendees wrote since a time, with only well-formed addresses in the query", async () => {
    const { relay, calls } = relayWith(() => ({ body: multi(GMAIL_FETCH_TOOL, { successful: true, data: { messages: [] } }) }));
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay });
    expect(await sources.mailFrom(["ada@example.test", "x) OR (in:sent", "jake@pin.example"], Date.parse("2026-10-10T00:00:00Z"))).toBe(false);
    expect(calls[2].payload.params.arguments.tools[0].arguments.query).toBe("from:(ada@example.test OR jake@pin.example) after:1791590400");
    expect(await sources.mailFrom(["x) OR (in:sent"], 0)).toBe(false);
    const before = relay.mock.calls.length;
    expect(await sources.mailFrom(["-ada@example.test"], 0)).toBe(false);
    expect(relay.mock.calls.length).toBe(before);
  });

  it("names the service in every failure: a refused handshake, an HTTP error, an unreadable answer", async () => {
    for (const answer of [() => ({ status: 429, body: { error: "rate limited" } }), () => ({ body: "<html>" })]) {
      const sources = createComposioSources({ configured: () => true, connectedServices: services, relay: relayWith(answer).relay });
      await expect(sources.emails(0, 20)).rejects.toMatchObject({ name: "SourceError", service: "gmail" });
      await expect(sources.events(0, 1)).rejects.toBeInstanceOf(SourceError);
    }
    const refused = createComposioSources({ configured: () => true, connectedServices: services, relay: async () => ({ status: 401, bytes: encode({}) }) });
    await expect(refused.events(0, 1)).rejects.toMatchObject({ service: "googlecalendar" });
  });

  it("gives every relay call of one read the read's own short deadline, and a read past it fails as that service's", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const stalled = vi.fn((payload: any, _session?: string, signal?: AbortSignal) => {
      signals.push(signal);
      if (payload.method !== "tools/call") return Promise.resolve({ status: 200, bytes: encode({ jsonrpc: "2.0", id: payload.id, result: {} }), transportSessionId: "s1" });
      return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
    });
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay: stalled, readTimeoutMs: 20 });
    await expect(sources.events(0, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar", message: expect.stringContaining("did not answer") });
    await expect(sources.emails(0, 20)).rejects.toMatchObject({ service: "gmail", message: expect.stringContaining("did not answer") });
    expect(signals).toHaveLength(6);
    expect(new Set(signals.slice(0, 3)).size).toBe(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[3]).not.toBe(signals[0]);
    expect(READ_TIMEOUT_MS).toBe(60_000);
  });

  it("refuses a non-finite time before any relay call", async () => {
    const { relay } = relayWith(() => ({ body: {} }));
    const sources = createComposioSources({ configured: () => true, connectedServices: services, relay });
    await expect(sources.events(Number.NaN, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar" });
    await expect(sources.events(0, Number.POSITIVE_INFINITY)).rejects.toMatchObject({ service: "googlecalendar" });
    await expect(sources.emails(Number.NaN, 20)).rejects.toMatchObject({ service: "gmail" });
    await expect(sources.mailFrom(["ada@example.test"], Number.NaN)).rejects.toMatchObject({ service: "gmail" });
    expect(relay).not.toHaveBeenCalled();
  });

  it("an unreadable list is a SourceError naming its service", async () => {
    const calendar = createComposioSources({ configured: () => true, connectedServices: services, relay: relayWith(() => ({ body: multi(CALENDAR_LIST_TOOL, { successful: true, data: { items: [{ event_id: "a" }] } }) })).relay });
    await expect(calendar.events(0, 1)).rejects.toMatchObject({ name: "SourceError", service: "googlecalendar" });
    const mail = createComposioSources({ configured: () => true, connectedServices: services, relay: relayWith(() => ({ body: multi(GMAIL_FETCH_TOOL, { successful: true, data: { messages: [{ message_id: "m" }] } }) })).relay });
    await expect(mail.emails(0, 20)).rejects.toMatchObject({ name: "SourceError", service: "gmail" });
  });

  it("reports connected services, and null when connected apps are not set up or cannot be reached", async () => {
    const { relay } = relayWith(() => ({ body: {} }));
    expect(await createComposioSources({ configured: () => true, connectedServices: services, relay }).connected()).toEqual({ gmail: true, googlecalendar: false });
    expect(await createComposioSources({ configured: () => false, connectedServices: services, relay }).connected()).toBeNull();
    expect(await createComposioSources({ configured: () => true, connectedServices: async () => { throw new Error("down"); }, relay }).connected()).toBeNull();
  });
});
