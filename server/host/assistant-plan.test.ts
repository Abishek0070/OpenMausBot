// server/host/assistant-plan.test.ts
import { describe, expect, it } from "vitest";

import type { CalendarEvent, EmailHeader } from "../assistant-sources.ts";
import {
  DAILY_TURN_CAP, emailSince, fingerprint, keepNewest, KEEP_MEETINGS_MS, localDate, MAX_WORK_THREADS, planMeetings, planTriage, pruneMeetings, qualifies, todayDue, turnsLeft,
} from "./assistant-plan.ts";
import type { MeetingRecord } from "./assistant-state.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 17, 4, 0, 0);
const CHECK = 15 * MINUTE;
const ME = { email: "me@example.test", self: true, organizer: true };
const JAKE = { email: "jake@pin.example", name: "Jake Price", self: false, organizer: false };

const event = (id: string, startIn: number, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: `Meeting ${id}`, start: NOW + startIn, end: NOW + startIn + 30 * MINUTE, allDay: false, status: "confirmed", selfDeclined: false, attendees: [ME, JAKE], ...more,
});
const plan = (events: CalendarEvent[], meetings: Record<string, MeetingRecord> = {}, now = NOW) => planMeetings({ now, events, meetings, checkMs: CHECK });
const kinds = (events: CalendarEvent[], meetings: Record<string, MeetingRecord> = {}, now = NOW) => plan(events, meetings, now).map((job) => job.kind);
const prepped = (item: CalendarEvent, more: Partial<MeetingRecord> = {}): MeetingRecord => ({ start: item.start, fingerprint: fingerprint(item), preppedAt: NOW - HOUR, ...more });

describe("which meetings qualify", () => {
  it("needs another person, an accepted or open invite, a time of day and not cancelled", () => {
    expect(qualifies(event("a", HOUR))).toBe(true);
    expect(qualifies(event("solo", HOUR, { attendees: [ME] }))).toBe(false);
    expect(qualifies(event("declined", HOUR, { selfDeclined: true }))).toBe(false);
    expect(qualifies(event("holiday", HOUR, { allDay: true }))).toBe(false);
    expect(qualifies(event("gone", HOUR, { status: "cancelled" }))).toBe(false);
  });

  it("fingerprints the other attendees, whatever their order or case", () => {
    const twice = event("a", HOUR, { attendees: [JAKE, ME, { email: "ada@example.test", self: false, organizer: false }] });
    const again = event("b", HOUR, { attendees: [{ email: "ADA@Example.test", self: false, organizer: false }, ME, JAKE] });
    expect(fingerprint(twice)).toBe(fingerprint(again));
    expect(fingerprint(twice)).toMatch(/^[0-9a-f]{32}$/);
    expect(fingerprint(twice)).not.toBe(fingerprint(event("c", HOUR)));
  });
});

describe("planMeetings", () => {
  it("preps a meeting once it starts within four hours, and not before", () => {
    expect(kinds([event("a", 4 * HOUR + MINUTE)])).toEqual([]);
    expect(plan([event("a", 4 * HOUR)])).toEqual([{ kind: "prep", event: event("a", 4 * HOUR), short: false }]);
    expect(kinds([event("a", 3 * HOUR)], { a: { start: NOW + 3 * HOUR, fingerprint: "x", prepStartedAt: NOW } })).toEqual([]);
    expect(kinds([event("a", 3 * HOUR)], { a: { start: NOW + 3 * HOUR, fingerprint: "x", failedAt: NOW } })).toEqual([]);
  });

  it("gives a meeting found late, booked late or seen after the app was closed, the shorter brief at once", () => {
    expect(plan([event("a", 4 * HOUR - 10 * MINUTE)])[0]).toMatchObject({ kind: "prep", short: false });
    expect(plan([event("a", HOUR)])[0]).toMatchObject({ kind: "prep", short: true });
  });

  it("does not research a recurring meeting again with the same people, and does with new ones", () => {
    const earlier = { start: NOW - 7 * 24 * HOUR, fingerprint: fingerprint(event("w", HOUR)), seriesId: "weekly", preppedAt: NOW - 7 * 24 * HOUR };
    const next = event("w2", 2 * HOUR, { seriesId: "weekly" });
    expect(plan([next], { w1: earlier })).toEqual([{ kind: "repeat", event: next, previousStart: earlier.start }]);
    const bigger = event("w2", 2 * HOUR, { seriesId: "weekly", attendees: [ME, JAKE, { email: "ada@example.test", self: false, organizer: false }] });
    expect(kinds([bigger], { w1: earlier })).toEqual(["prep"]);
  });

  it("posts one update per change after prep, and none once the meeting started", () => {
    const original = event("a", 3 * HOUR);
    const moved = event("a", 3 * HOUR + 30 * MINUTE);
    expect(plan([moved], { a: prepped(original) })).toEqual([{ kind: "update", event: moved, change: "time" }]);
    const crowded = event("a", 3 * HOUR, { attendees: [ME, JAKE, { email: "ada@example.test", self: false, organizer: false }] });
    expect(plan([crowded], { a: prepped(original) })[0]).toMatchObject({ kind: "update", change: "attendees" });
    expect(plan([{ ...crowded, start: moved.start, end: moved.end }], { a: prepped(original) })[0]).toMatchObject({ change: "both" });
    expect(kinds([moved], { a: prepped(moved) })).toEqual([]);
    expect(kinds([moved], { a: prepped(original, { updateStartedAt: NOW }) })).toEqual([]);
    expect(kinds([moved], { a: prepped(original, { updateFailedAt: NOW }) })).toEqual([]);
    expect(kinds([moved], { a: prepped(original) }, moved.start + MINUTE)).toEqual([]);
    expect(kinds([moved], { a: prepped(original, { repeat: true }) })).toEqual([]);
  });

  it("reports a prepped meeting that was cancelled once, before it would have started", () => {
    const item = event("a", 2 * HOUR);
    const cancelled = { ...item, status: "cancelled" as const, title: "Untitled meeting" };
    expect(plan([cancelled], { a: prepped(item) })).toEqual([{ kind: "cancelled", eventId: "a", title: "Untitled meeting", start: item.start }]);
    expect(kinds([cancelled], { a: prepped(item, { cancelledAt: NOW }) })).toEqual([]);
    expect(kinds([cancelled], { a: prepped(item, { repeat: true }) })).toEqual([]);
    expect(kinds([cancelled])).toEqual([]);
    expect(kinds([cancelled], { a: prepped(item) }, item.start + MINUTE)).toEqual([]);
  });

  it("reminds about ten minutes before, once, never after the start and never for a meeting that does not qualify", () => {
    const item = event("a", 10 * MINUTE);
    expect(kinds([event("a", 11 * MINUTE)], { a: prepped(event("a", 11 * MINUTE)) })).toEqual([]);
    expect(kinds([item], { a: prepped(item) })).toEqual(["remind"]);
    expect(kinds([item], { a: prepped(item, { remindedAt: NOW }) })).toEqual([]);
    expect(kinds([event("a", -MINUTE)], { a: prepped(event("a", -MINUTE)) })).toEqual([]);
    expect(kinds([event("solo", 5 * MINUTE, { attendees: [ME] })])).toEqual([]);
    expect(kinds([item])).toEqual(["prep", "remind"]);
  });
});

describe("planTriage", () => {
  const mail = (id: string, ago: number): EmailHeader => ({ id, threadId: `t-${id}`, at: NOW - ago, from: id, subject: id, preview: "" });

  it("sends the 20 newest unjudged emails of the last day, judges older ones silently and keeps the rest for later", () => {
    const recent = Array.from({ length: 25 }, (_, index) => mail(`r${index}`, (index + 1) * MINUTE));
    const old = [mail("old1", 25 * HOUR), mail("old2", 48 * HOUR)];
    const result = planTriage({ now: NOW, emails: [...old, ...recent, mail("seen", MINUTE)], judged: new Set(["seen"]), spacingMs: CHECK });
    expect(result.batch.map((item) => item.id)).toEqual(recent.slice(0, 20).map((item) => item.id));
    expect(result.quiet).toEqual(["old1", "old2"]);
    expect(result.pending.map((item) => item.id)).toEqual(recent.slice(20).map((item) => item.id));
  });

  it("waits fifteen minutes between batches, and still judges old mail meanwhile", () => {
    const result = planTriage({ now: NOW, emails: [mail("new", MINUTE), mail("old", 30 * HOUR)], judged: new Set(), lastTriageAt: NOW - 14 * MINUTE, spacingMs: CHECK });
    expect(result).toEqual({ batch: [], quiet: ["old"], pending: [mail("new", MINUTE)] });
    expect(planTriage({ now: NOW, emails: [mail("new", MINUTE)], judged: new Set(), lastTriageAt: NOW - CHECK, spacingMs: CHECK }).batch).toHaveLength(1);
  });
});

describe("days in the person's zone", () => {
  it("names the local day, across zones and a DST change, and falls back to UTC", () => {
    expect(localDate(Date.UTC(2026, 9, 17, 20, 0), "Asia/Kolkata")).toBe("2026-10-18");
    expect(localDate(Date.UTC(2026, 9, 17, 20, 0), "America/Los_Angeles")).toBe("2026-10-17");
    expect(localDate(Date.UTC(2026, 10, 1, 7, 30), "America/Los_Angeles")).toBe("2026-11-01");
    expect(localDate(Date.UTC(2026, 10, 1, 6, 30), "America/Los_Angeles")).toBe("2026-10-31");
    // the clocks went back at 09:00 UTC on 1 November: 07:30 UTC the next day is 23:30 PST, still the 1st
    expect(localDate(Date.UTC(2026, 10, 2, 7, 30), "America/Los_Angeles")).toBe("2026-11-01");
    expect(localDate(Date.UTC(2026, 9, 17, 23, 0), "Not/AZone")).toBe("2026-10-17");
    expect(localDate(Date.UTC(2026, 9, 17, 23, 0), undefined)).toBe("2026-10-17");
  });

  it("makes Today due once per later local day, not again after flying west", () => {
    expect(todayDue({ now: NOW, timeZone: "Asia/Kolkata" })).toBe("2026-10-17");
    expect(todayDue({ now: NOW, timeZone: "Asia/Kolkata", lastTodayDate: "2026-10-17" })).toBeNull();
    expect(todayDue({ now: NOW, timeZone: "America/Los_Angeles", lastTodayDate: "2026-10-17" })).toBeNull();
    expect(todayDue({ now: NOW + 24 * HOUR, timeZone: "Asia/Kolkata", lastTodayDate: "2026-10-17" })).toBe("2026-10-18");
  });

  it("counts AI turns per local day and resets at local midnight", () => {
    expect(turnsLeft({ now: NOW, timeZone: "Asia/Kolkata" })).toEqual({ day: "2026-10-17", left: DAILY_TURN_CAP });
    expect(turnsLeft({ now: NOW, timeZone: "Asia/Kolkata", turnDay: "2026-10-17", dayTurns: 12 })).toEqual({ day: "2026-10-17", left: 0 });
    expect(turnsLeft({ now: Date.UTC(2026, 9, 17, 18, 31), timeZone: "Asia/Kolkata", turnDay: "2026-10-17", dayTurns: 12 })).toEqual({ day: "2026-10-18", left: DAILY_TURN_CAP });
  });

  it("forgets meetings more than five weeks old", () => {
    const kept = pruneMeetings({ old: { start: NOW - KEEP_MEETINGS_MS - 1, fingerprint: "x" }, recent: { start: NOW - HOUR, fingerprint: "y" } }, NOW);
    expect(Object.keys(kept)).toEqual(["recent"]);
  });
});

describe("all-day events", () => {
  it("never prepares or reminds about an all-day event, whatever its UTC midnight start", () => {
    const holiday = event("h", 10 * MINUTE, { allDay: true });
    expect(kinds([holiday])).toEqual([]);
    expect(kinds([event("h", HOUR, { allDay: true })], { h: { start: NOW + HOUR, fingerprint: "x", preppedAt: NOW } })).toEqual([]);
    expect(kinds([event("h", HOUR, { allDay: true, status: "cancelled" })], { h: { start: NOW + HOUR, fingerprint: "x", preppedAt: NOW } })).toEqual([]);
  });
});

describe("bounded state and the first run", () => {
  it("keeps the newest entries of a list", () => {
    expect(keepNewest([1, 2, 3, 4], 2)).toEqual([3, 4]);
    expect(keepNewest([1], 2)).toEqual([1]);
    expect(keepNewest(Array.from({ length: 1_200 }, (_, index) => index), MAX_WORK_THREADS)).toHaveLength(1_000);
  });

  it("never reads the mail backlog when there is no cursor", () => {
    expect(emailSince({ now: NOW, checkMs: CHECK })).toBe(NOW - CHECK);
    expect(emailSince({ now: NOW, emailCursor: NOW - 2 * HOUR, checkMs: CHECK })).toBe(NOW - 2 * HOUR);
    expect(emailSince({ now: NOW, emailCursor: NOW - 3 * 24 * HOUR, checkMs: CHECK })).toBe(NOW - 24 * HOUR);
  });
});
