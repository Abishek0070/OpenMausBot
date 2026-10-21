// server/host/assistant-plan.test.ts
import { describe, expect, it } from "vitest";

import type { CalendarEvent, EmailHeader } from "../assistant-sources.ts";
import {
  answered, clashes, DAILY_TURN_CAP, emailKey, emailSince, fingerprint, isMine, keepNewest, KEEP_MEETINGS_MS, localDate, meetingKey, mergeMeetings, planMail, planMeetings,
  prunePending, pruneMeetings, qualifies, todayDue, turnsLeft, type AccountEvent,
} from "./assistant-plan.ts";
import { MAX_WORK_THREADS, type MeetingRecord, type PendingEmail } from "./assistant-state.ts";

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

  it("grants no new day's turns after flying west, and keeps counting the later day", () => {
    expect(turnsLeft({ now: NOW, timeZone: "America/Los_Angeles", turnDay: "2026-10-17", dayTurns: 12 })).toEqual({ day: "2026-10-17", left: 0 });
    expect(turnsLeft({ now: NOW, timeZone: "America/Los_Angeles", turnDay: "2026-10-17", dayTurns: 5 })).toEqual({ day: "2026-10-17", left: DAILY_TURN_CAP - 5 });
    expect(turnsLeft({ now: NOW + 24 * HOUR, timeZone: "America/Los_Angeles", turnDay: "2026-10-17", dayTurns: 12 })).toEqual({ day: "2026-10-17", left: 0 });
    expect(turnsLeft({ now: NOW + 48 * HOUR, timeZone: "America/Los_Angeles", turnDay: "2026-10-17", dayTurns: 12 })).toEqual({ day: "2026-10-18", left: DAILY_TURN_CAP });
  });

  it("treats a stored day more than one day ahead as a clock jump, for turns and for Today", () => {
    expect(turnsLeft({ now: NOW, timeZone: "Asia/Kolkata", turnDay: "2026-10-18", dayTurns: 12 })).toEqual({ day: "2026-10-18", left: 0 });
    expect(turnsLeft({ now: NOW, timeZone: "Asia/Kolkata", turnDay: "2026-10-19", dayTurns: 12 })).toEqual({ day: "2026-10-17", left: DAILY_TURN_CAP });
    expect(turnsLeft({ now: NOW, timeZone: "Asia/Kolkata", turnDay: "2027-01-01", dayTurns: 12 })).toEqual({ day: "2026-10-17", left: DAILY_TURN_CAP });
    expect(todayDue({ now: NOW, timeZone: "Asia/Kolkata", lastTodayDate: "2026-10-18" })).toBeNull();
    expect(todayDue({ now: NOW, timeZone: "Asia/Kolkata", lastTodayDate: "2026-10-19" })).toBe("2026-10-17");
    expect(todayDue({ now: NOW, timeZone: "Asia/Kolkata", lastTodayDate: "2026-12-31" })).toBe("2026-10-17");
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

const DAY = 24 * HOUR;
const MINE = new Set(["me@example.test", "admin@example.test"]);
const ev = (id: string, more: Partial<AccountEvent> = {}): AccountEvent => ({
  ...event(id, HOUR, { calendarId: "me@example.test", ownedCalendar: true }), account: "c1", attendees: [ME, JAKE], ...more,
});
const header = (account: string, id: string, at: number): EmailHeader => ({ id, account, threadId: `t-${id}`, at, from: "someone@pin.example", subject: "Hello", preview: "" });
const pending = (account: string, messageId: string, judgedAt: number): PendingEmail => ({ account, messageId, threadId: `t-${messageId}`, judgedAt, needsReply: true });

describe("whose meetings count", () => {
  it("counts a meeting as the person's when one of their addresses organises or attends it, or it sits on a calendar they own", () => {
    expect(isMine(ev("a", { ownedCalendar: false, organizer: "admin@example.test", attendees: [] }), MINE)).toBe(true);
    expect(isMine(ev("b", { ownedCalendar: true, attendees: [] }), MINE)).toBe(true);
    expect(isMine(ev("c", { ownedCalendar: false, calendarId: "ada@example.test", attendees: [{ email: "ada@example.test", self: true, organizer: true }] }), MINE)).toBe(false);
    expect(isMine(ev("d", { ownedCalendar: true, attendees: [{ email: "unknown@x.test", self: true, organizer: true }] }), new Set())).toBe(true);
    expect(isMine(ev("e", { ownedCalendar: false, attendees: [{ email: "Admin@Example.test", self: false, organizer: false }] }), MINE)).toBe(true);
  });

  it("judges self by the person's addresses, so their other account is never another person", () => {
    const [mine] = mergeMeetings([ev("a", { attendees: [{ email: "me@example.test", self: true, organizer: true }, { email: "admin@example.test", self: false, organizer: false }] })], MINE);
    expect(qualifies(mine!)).toBe(false);
  });

  it("declines only when every one of the person's addresses on it declined", () => {
    const both = (second: string) => [
      { email: "me@example.test", self: true, organizer: false, response: "declined" },
      { email: "admin@example.test", self: false, organizer: false, response: second },
      { email: "jake@pin.example", self: false, organizer: true },
    ];
    expect(mergeMeetings([ev("a", { attendees: both("accepted") })], MINE)[0]!.selfDeclined).toBe(false);
    expect(mergeMeetings([ev("a", { attendees: both("declined") })], MINE)[0]!.selfDeclined).toBe(true);
  });

  it("leaves out meetings that are not the person's", () => {
    const foreign = ev("f", { ownedCalendar: false, attendees: [{ email: "ada@example.test", self: true, organizer: true }] });
    expect(mergeMeetings([foreign], MINE)).toEqual([]);
  });
});

describe("one meeting on several calendars", () => {
  it("merges by iCalUID, listing both accounts, with the copy that has the most attendees", () => {
    const merged = mergeMeetings([
      ev("x1", { iCalUID: "uid-1" }),
      { ...ev("x2", { iCalUID: "uid-1", description: "Agenda" }), account: "c2", attendees: [...ev("x").attendees, { email: "ada@pin.example", self: false, organizer: false }] },
    ], MINE);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "uid-1", accounts: ["c1", "c2"], description: "Agenda" });
    expect(merged[0]).not.toHaveProperty("account");
  });

  it("merges by title, start and end only when neither copy has an iCalUID", () => {
    expect(mergeMeetings([ev("a", { title: "Demo  with Jake" }), { ...ev("b", { title: "demo with jake" }), account: "c2" }], MINE))
      .toEqual([expect.objectContaining({ id: expect.stringMatching(/^sig:[0-9a-f]{32}$/), accounts: ["c1", "c2"] })]);
    expect(mergeMeetings([ev("a", { title: "Demo" }), { ...ev("b", { title: "Demo", iCalUID: "uid-2" }), account: "c2" }], MINE)).toHaveLength(2);
    expect(mergeMeetings([ev("a", { iCalUID: "uid-1" }), { ...ev("b", { iCalUID: "uid-2" }), account: "c2" }], MINE)).toHaveLength(2);
  });

  it("never chains two different iCalUIDs through a third copy that has none", () => {
    const merged = mergeMeetings([
      ev("a", { iCalUID: "uid-1" }), { ...ev("b", { iCalUID: "uid-2" }), account: "c2" }, { ...ev("c"), account: "c3" },
    ], MINE);
    expect(merged.map((one) => [one.id, one.accounts])).toEqual([["uid-1", ["c1"]], ["uid-2", ["c2"]], [meetingKey(ev("c")), ["c3"]]]);
  });

  it("keys a meeting with no iCalUID by its time and title, so it keeps its key when one account's copy is not read", () => {
    const copies: AccountEvent[] = [ev("a", { title: "Demo  with Jake" }), { ...ev("b", { title: "demo with jake" }), account: "c2" }];
    const [both] = mergeMeetings(copies, MINE);
    expect(mergeMeetings([copies[1]!], MINE).map((one) => one.id)).toEqual([both!.id]);
    expect(mergeMeetings([copies[0]!], MINE).map((one) => one.id)).toEqual([both!.id]);
    expect(mergeMeetings([{ ...copies[0]!, start: copies[0]!.start + MINUTE }], MINE)[0]!.id).not.toBe(both!.id);
  });

  it("keys a recurring instance by its original start, so a moved instance keeps its key and two instances never share one", () => {
    const monday = ev("s_1", { iCalUID: "uid-s", seriesId: "s", originalStart: 1_000 });
    expect(meetingKey({ ...monday, start: 5_000 })).toBe(meetingKey(monday));
    expect(meetingKey(ev("s_2", { iCalUID: "uid-s", seriesId: "s", originalStart: 2_000 }))).not.toBe(meetingKey(monday));
    expect(meetingKey(ev("s_3", { iCalUID: "uid-s", seriesId: "s" }))).toBe("uid-s#s_3");
    expect(meetingKey(ev("long", { iCalUID: "u".repeat(300) }))).toMatch(/^uid:[0-9a-f]{32}$/);
  });

  it("keeps a merged meeting unless every copy is cancelled", () => {
    expect(mergeMeetings([ev("a", { iCalUID: "u", status: "cancelled" }), { ...ev("b", { iCalUID: "u" }), account: "c2" }], MINE)[0]!.status).toBe("confirmed");
    expect(mergeMeetings([ev("a", { iCalUID: "u", status: "cancelled" }), { ...ev("b", { iCalUID: "u", status: "cancelled" }), account: "c2" }], MINE)[0]!.status).toBe("cancelled");
  });

  it("returns meetings by start and lists a repeated account once", () => {
    const merged = mergeMeetings([ev("late", { start: NOW + 3 * HOUR, end: NOW + 4 * HOUR, iCalUID: "l" }), ev("early", { iCalUID: "e" }), { ...ev("early2", { iCalUID: "e" }), calendarId: "other" }], MINE);
    expect(merged.map((one) => one.id)).toEqual(["e", "l"]);
    expect(merged[0]!.accounts).toEqual(["c1"]);
  });
});

describe("clashes", () => {
  it("finds clashes between today's meetings with another person, tentative included, and leaves out declined, solo and ended ones", () => {
    const at = (id: string, from: number, to: number, more: Partial<AccountEvent> = {}) => ({ ...ev(id), start: NOW + from * MINUTE, end: NOW + to * MINUTE, ...more });
    const list = [
      at("e", -90, -30), at("a", 30, 90), at("b", 60, 120, { status: "tentative" }), at("c", 75, 105, { selfDeclined: true }), at("d", 45, 100, { attendees: [ME] }),
    ];
    expect(clashes(list, { now: NOW, timeZone: "Asia/Kolkata" }).map(([one, two]) => [one.id, two.id])).toEqual([["a", "b"]]);
  });

  it("leaves out a meeting that starts on another local day", () => {
    const tomorrow = { ...ev("t"), start: NOW + DAY, end: NOW + DAY + HOUR };
    const tomorrowToo = { ...ev("u"), start: NOW + DAY, end: NOW + DAY + HOUR };
    expect(clashes([tomorrow, tomorrowToo], { now: NOW, timeZone: "Asia/Kolkata" })).toEqual([]);
  });
});

describe("planMail", () => {
  it("judges new mail from every account in one batch of twenty, newest first, with copies of one message judged together", () => {
    const mail = [...Array.from({ length: 15 }, (_, n) => header("g1", `p${n}`, NOW - n * MINUTE)), ...Array.from({ length: 15 }, (_, n) => header("g2", `a${n}`, NOW - n * MINUTE - 30_000))];
    const copy = { ...header("g2", "dup", NOW), messageIdHeader: "<x@y>" };
    const result = planMail({ now: NOW, emails: [...mail, { ...header("g1", "orig", NOW + 1), messageIdHeader: "<x@y>" }, copy], judged: new Set(["g1/p3"]), spacingMs: 15 * MINUTE });
    expect(result.batch).toHaveLength(20);
    expect(result.batch.map(emailKey)).not.toContain("g1/p3");
    expect(result.batch.map(emailKey)[0]).toBe("g1/orig");
    expect(result.copies.map(emailKey)).toEqual(["g2/dup"]);
    expect(new Set(result.batch.map((one) => one.account))).toEqual(new Set(["g1", "g2"]));
    expect(result.pending).toHaveLength(10);
  });

  it("keeps two copies apart when the answer carries no Message-ID", () => {
    expect(planMail({ now: NOW, emails: [header("g1", "x", NOW), header("g2", "y", NOW)], judged: new Set(), spacingMs: MINUTE }).batch).toHaveLength(2);
  });

  it("keeps the same id in two accounts apart", () => {
    const result = planMail({ now: NOW, emails: [header("g1", "same", NOW), header("g2", "same", NOW)], judged: new Set(["g1/same"]), spacingMs: MINUTE });
    expect(result.batch.map(emailKey)).toEqual(["g2/same"]);
  });

  it("holds the batch until the spacing has passed and sets old mail aside", () => {
    const emails = [header("g1", "new", NOW - MINUTE), header("g1", "old", NOW - 30 * HOUR)];
    const waiting = planMail({ now: NOW, emails, judged: new Set(), lastTriageAt: NOW - MINUTE, spacingMs: 15 * MINUTE });
    expect(waiting.batch).toEqual([]);
    expect(waiting.pending.map(emailKey)).toEqual(["g1/new"]);
    expect(waiting.quiet.map(emailKey)).toEqual(["g1/old"]);
  });
});

describe("pending emails", () => {
  it("keeps pending emails for a week, and drops those of an account no longer connected", () => {
    const list = [pending("g1", "m1", NOW - 6 * DAY), pending("g1", "m2", NOW - 8 * DAY), pending("gone", "m3", NOW)];
    expect(prunePending(list, { now: NOW, accounts: new Set(["g1"]) }).map((entry) => entry.messageId)).toEqual(["m1"]);
  });

  it("calls an email answered only for a later message from one of the person's addresses", () => {
    const sent = { at: 100 };
    expect(answered(sent, [{ id: "r", at: 200, from: "colleague@pin.example" }], MINE)).toBe(false);
    expect(answered(sent, [{ id: "r", at: 50, from: "me@example.test" }], MINE)).toBe(false);
    expect(answered(sent, [{ id: "r", at: 200, from: "admin@example.test" }], MINE)).toBe(true);
    expect(answered(sent, [{ id: "r", at: 200, from: "Admin@Example.test" }], MINE)).toBe(true);
  });
});
