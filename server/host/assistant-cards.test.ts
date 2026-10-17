// server/host/assistant-cards.test.ts
import { describe, expect, it } from "vitest";

import { parseWidgetInput, WIDGET_LIMITS, widgetActions } from "../../shared/widget.ts";
import type { CalendarEvent } from "../assistant-sources.ts";
import { attendeeNames, cancelledCard, emailCard, gmailUrl, meetingWhen, prepCard, reminderCard, todayCard, updateCard, type BuiltCard } from "./assistant-cards.ts";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 17, 11, 0, 0); // 16:30 in Kolkata
const ZONE = "Asia/Kolkata";
const demo: CalendarEvent = {
  id: "demo-1", title: "Supamaus demo with Jake", start: Date.UTC(2026, 9, 17, 17, 0), end: Date.UTC(2026, 9, 17, 17, 30), allDay: false, status: "confirmed", selfDeclined: false,
  attendees: [{ email: "me@example.test", self: true, organizer: true }, { email: "jake@pin.example", name: "Jake Price", self: false, organizer: false }],
  joinUrl: "https://meet.google.com/abc-defg-hij",
};

function valid(built: BuiltCard) {
  const parsed = parseWidgetInput(built.card);
  expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  expect(JSON.stringify(built.card).length).toBeLessThan(WIDGET_LIMITS.bytes);
  return { root: built.card as any, actions: widgetActions(parsed.ok ? parsed.value : built.card) };
}

describe("MausBot's cards", () => {
  it("words the time in the person's zone with plain spaces", () => {
    expect(meetingWhen(demo.start, demo.end, ZONE, NOW)).toBe("Today, 10:30 PM to 11:00 PM");
    expect(meetingWhen(demo.start + 24 * 60 * MINUTE, demo.end + 24 * 60 * MINUTE, ZONE, NOW)).toBe("Tomorrow, 10:30 PM to 11:00 PM");
    expect(attendeeNames(demo)).toBe("Jake Price");
    expect(attendeeNames({ ...demo, attendees: [...demo.attendees, { email: "ada@example.test", self: false, organizer: false }, { email: "bo@example.test", self: false, organizer: false }] })).toBe("Jake Price and 2 others");
  });

  it("preps with the brief, Join from the calendar, Open for a known chat and Draft a follow-up", () => {
    const built = prepCard({ event: demo, brief: "## Who\nJake Price, Head of Customer Success at Pin.", related: { botId: "scout", threadId: "scout-main" }, timeZone: ZONE, now: NOW });
    const { root, actions } = valid(built);
    expect(root.title).toBe("Prep: Supamaus demo with Jake");
    expect(root.caption).toBe("Today, 10:30 PM to 11:00 PM");
    expect(actions.map((entry) => [entry.label, entry.action.type])).toEqual([["Join", "open_url"], ["Open", "open_thread"], ["Draft a follow-up", "draft_followup"]]);
    expect(actions[0]!.action.payload).toEqual({ url: "https://meet.google.com/abc-defg-hij" });
    expect(built.summary).toBe("Prep ready: Supamaus demo with Jake, Today, 10:30 PM to 11:00 PM");
    const bare = valid(prepCard({ event: { ...demo, joinUrl: undefined }, brief: "x".repeat(9_000), timeZone: ZONE, now: NOW }));
    expect(bare.actions.map((entry) => entry.label)).toEqual(["Draft a follow-up"]);
    expect(JSON.stringify(bare.root).length).toBeLessThan(WIDGET_LIMITS.bytes);
  });

  it("reminds with the minutes left, Join and Prep notes, and the since-last-time line when there is one", () => {
    const { root, actions } = valid(reminderCard({ event: demo, line: "Jake asked for pricing.", timeZone: ZONE, now: demo.start - 10 * MINUTE }));
    expect(root.title).toBe("Call with Jake Price in 10 minutes");
    expect(JSON.stringify(root)).toContain("Since last time: Jake asked for pricing.");
    expect(actions.map((entry) => entry.label)).toEqual(["Join", "Prep notes"]);
    expect(valid(reminderCard({ event: demo, timeZone: ZONE, now: demo.start - 30_000 })).root.title).toBe("Call with Jake Price in 1 minute");
  });

  it("flags an email with why and what to do, Open in Gmail on its own thread, and Draft a reply", () => {
    const built = emailCard({ email: { id: "important-1", threadId: "thread/1", at: NOW, from: "Ada <ada@example.test>", subject: "Q3 numbers due Friday", preview: "" }, why: "Ada needs the numbers by Friday.", action: "Send the Q3 numbers." });
    const { root, actions } = valid(built);
    expect([root.title, root.caption]).toEqual(["Q3 numbers due Friday", "From Ada <ada@example.test>"]);
    expect(actions.map((entry) => entry.label)).toEqual(["Open in Gmail", "Draft a reply"]);
    expect(actions[0]!.action.payload).toEqual({ url: gmailUrl("thread/1") });
    expect(gmailUrl("thread/1")).toBe("https://mail.google.com/mail/#all/thread%2F1");
    expect(built.summary).toBe("Important email from Ada <ada@example.test>: Q3 numbers due Friday");
  });

  it("updates and cancels in a line, with no buttons a cancelled meeting cannot use", () => {
    expect(valid(updateCard({ event: demo, text: "Moved to 11 PM; Ada joins.", timeZone: ZONE, now: NOW })).root.title).toBe("Changed: Supamaus demo with Jake");
    const cancelled = valid(cancelledCard({ title: "Supamaus demo with Jake", start: demo.start, timeZone: ZONE, now: NOW }));
    expect(cancelled.root.title).toBe("Cancelled: Supamaus demo with Jake");
    expect(cancelled.actions).toEqual([]);
  });

  it("lays out Today: meetings with prep status, flagged email, and one team line that opens the Chief", () => {
    const built = todayCard({
      now: NOW, timeZone: ZONE,
      meetings: [{ title: "Supamaus demo with Jake", start: demo.start, end: demo.end, status: "Prep ready", joinUrl: demo.joinUrl }],
      emails: [{ from: "Ada <ada@example.test>", subject: "Q3 numbers due Friday" }],
      team: { text: "Chief of Staff: 3 finished · 1 waiting on you", open: { botId: "chief", threadId: "chief-main" } },
    });
    const { root, actions } = valid(built);
    expect(root.title).toBe("Today");
    expect(root.caption).toBe("Saturday, October 17");
    const text = JSON.stringify(root);
    for (const shown of ["10:30 PM · Supamaus demo with Jake", "Prep ready", "Ada <ada@example.test>: Q3 numbers due Friday", "Chief of Staff: 3 finished · 1 waiting on you"]) expect(text).toContain(shown);
    expect(actions.map((entry) => [entry.label, entry.action.type])).toEqual([["Join", "open_url"], ["Open", "open_thread"]]);
    expect(built.summary).toBe("Today: 1 meeting, 1 important email");
    expect(JSON.stringify(valid(todayCard({ now: NOW, timeZone: ZONE, meetings: [], emails: [] })).root)).toContain("No meetings today.");
  });
});

describe("untrusted links and all-day events", () => {
  const refused = ["javascript:alert(1)", "data:text/html,<b>x</b>", "http://meet.example.test/a", "file:///etc/passwd", "ftp://meet.example.test/a", "not a url", "//meet.example.test/a", ""];

  it("shows Join only for an https joinUrl, on every card that has one", () => {
    for (const joinUrl of refused) {
      const event = { ...demo, joinUrl };
      const labels = (built: BuiltCard) => valid(built).actions.map((entry) => entry.label);
      expect(labels(prepCard({ event, brief: "x", timeZone: ZONE, now: NOW })), joinUrl).toEqual(["Draft a follow-up"]);
      expect(labels(reminderCard({ event, timeZone: ZONE, now: demo.start - 10 * MINUTE })), joinUrl).toEqual(["Prep notes"]);
      expect(labels(updateCard({ event, text: "Moved.", timeZone: ZONE, now: NOW })), joinUrl).toEqual([]);
      const today = todayCard({ now: NOW, timeZone: ZONE, meetings: [{ title: "Demo", start: demo.start, end: demo.end, status: "Prep ready", joinUrl }], emails: [] });
      expect(labels(today), joinUrl).toEqual([]);
    }
  });

  it("keeps a thread id from changing the Gmail link", () => {
    for (const id of ["thread/1", "../../x?y=1#z", "a b%2F", "\u202eevil", "javascript:1"]) {
      const url = gmailUrl(id);
      const tail = url.slice("https://mail.google.com/mail/#all/".length);
      expect(url.startsWith("https://mail.google.com/mail/#all/"), id).toBe(true);
      expect(tail, id).not.toMatch(/[/?#\s\u202e]/);
      expect(decodeURIComponent(tail)).toBe(id);
      const parsed = new URL(url);
      expect([parsed.origin, parsed.pathname, parsed.search]).toEqual(["https://mail.google.com", "/mail/", ""]);
    }
  });

  it("words an all-day event by its date in the person's zone, never as a clock time", () => {
    const allDay = { ...demo, allDay: true, start: Date.UTC(2026, 9, 17), end: Date.UTC(2026, 9, 18), joinUrl: undefined };
    for (const zone of [ZONE, "America/Los_Angeles"]) {
      expect(meetingWhen(allDay.start, allDay.end, zone, NOW, true), zone).toBe("Today, all day");
      expect(meetingWhen(allDay.start + DAY_MS, allDay.end + DAY_MS, zone, NOW, true), zone).toBe("Tomorrow, all day");
      const text = JSON.stringify(valid(todayCard({ now: NOW, timeZone: zone, meetings: [{ title: "Offsite", start: allDay.start, end: allDay.end, status: "All day", allDay: true }], emails: [] })).root);
      expect(text, zone).toContain("All day \u00b7 Offsite");
      expect(text, zone).not.toMatch(/\d:\d\d/);
    }
    expect(valid(updateCard({ event: allDay, text: "Renamed.", timeZone: "America/Los_Angeles", now: NOW })).root.caption).toBe("Today, all day");
    expect(valid(cancelledCard({ title: "Offsite", start: allDay.start, allDay: true, timeZone: ZONE, now: NOW })).root.caption).toBe("Was Today, all day");
  });
});
