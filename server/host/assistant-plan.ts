import { createHash } from "node:crypto";

import type { CalendarEvent, EmailHeader, ThreadMessage } from "../assistant-sources.ts";
import { COPY_GROUP_LENGTH, type MeetingRecord, type PendingEmail } from "./assistant-state.ts";
import { validZone } from "./brief-recap.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const PREP_LEAD_MS = 4 * HOUR;
export const REMINDER_LEAD_MS = 10 * MINUTE;
export const LOOKAHEAD_MS = 36 * HOUR;
export const DAILY_TURN_CAP = 12;
export const TRIAGE_BATCH = 20;
export const CARDS_PER_TRIAGE = 5;
export const EMAIL_MAX_AGE_MS = 24 * HOUR;
export const PENDING_MAX_AGE_MS = 7 * 24 * HOUR;
export const RECONNECT_AFTER = 3;
export const KEPT_READ_MS = 24 * HOUR;
export const KEEP_MEETINGS_MS = 35 * 24 * HOUR;
export const DEFAULT_CHECK_MS = 15 * MINUTE;

export type MeetingJob<T extends CalendarEvent = CalendarEvent> =
  | { kind: "prep"; event: T; short: boolean }
  | { kind: "repeat"; event: T; previousStart: number }
  | { kind: "update"; event: T; change: "time" | "attendees" | "both" }
  | { kind: "cancelled"; eventId: string; title: string; start: number }
  | { kind: "remind"; event: T };

export function qualifies(event: CalendarEvent): boolean {
  return event.status !== "cancelled" && !event.allDay && !event.selfDeclined && event.attendees.some((attendee) => !attendee.self);
}

export function fingerprint(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self).map((attendee) => attendee.email.toLowerCase()).sort();
  return createHash("sha256").update(others.join("\n")).digest("hex").slice(0, 32);
}

export const copyGroupOf = (messageIdHeader: string): string => createHash("sha256").update(messageIdHeader).digest("hex").slice(0, COPY_GROUP_LENGTH);

export function localDate(ms: number, timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: validZone(timeZone) ?? "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function earlierOccurrence(meetings: Record<string, MeetingRecord>, event: CalendarEvent, print: string): MeetingRecord | undefined {
  if (!event.seriesId) return undefined;
  return Object.values(meetings)
    .filter((record) => record.seriesId === event.seriesId && record.fingerprint === print && record.preppedAt !== undefined && record.start < event.start)
    .sort((a, b) => b.start - a.start)[0];
}

export function planMeetings<T extends CalendarEvent>(input: { now: number; events: readonly T[]; meetings: Record<string, MeetingRecord>; checkMs: number }): MeetingJob<T>[] {
  const { now, meetings } = input;
  const jobs: MeetingJob<T>[] = [];
  for (const event of input.events) {
    const record = meetings[event.id];
    if (event.allDay) continue;
    if (event.status === "cancelled") {
      if (record?.preppedAt !== undefined && !record.repeat && record.cancelledAt === undefined && record.start > now) {
        jobs.push({ kind: "cancelled", eventId: event.id, title: event.title, start: record.start });
      }
      continue;
    }
    if (!qualifies(event) || event.start <= now) continue;
    const print = fingerprint(event);
    if (record?.preppedAt !== undefined && !record.repeat && record.updateStartedAt === undefined && record.updateFailedAt === undefined) {
      const time = record.start !== event.start;
      const people = record.fingerprint !== print;
      if (time || people) jobs.push({ kind: "update", event, change: time && people ? "both" : time ? "time" : "attendees" });
    }
    const untouched = !record || (record.preppedAt === undefined && record.prepStartedAt === undefined && record.failedAt === undefined);
    if (untouched && event.start - now <= PREP_LEAD_MS) {
      const previous = earlierOccurrence(meetings, event, print);
      jobs.push(previous
        ? { kind: "repeat", event, previousStart: previous.start }
        : { kind: "prep", event, short: now - (event.start - PREP_LEAD_MS) > input.checkMs });
    }
    const reminded = record?.remindedAt !== undefined && record.remindedAt >= event.start - REMINDER_LEAD_MS;
    if (!reminded && event.start - now <= REMINDER_LEAD_MS) jobs.push({ kind: "remind", event });
  }
  return jobs;
}

// Travel moves the local date back by at most one day; a stored day further ahead came from a clock jump.
function sameOrNextDay(local: string, stored: string | undefined): stored is string {
  if (stored === undefined) return false;
  const ahead = (Date.parse(stored) - Date.parse(local)) / (24 * HOUR);
  return ahead >= 0 && ahead <= 1;
}

export function briefDue(input: { now: number; timeZone?: string; lastBriefDate?: string }): string | null {
  const today = localDate(input.now, input.timeZone);
  return sameOrNextDay(today, input.lastBriefDate) ? null : today;
}

export function turnsLeft(input: { now: number; timeZone?: string; turnDay?: string; dayTurns?: number }): { day: string; left: number } {
  const local = localDate(input.now, input.timeZone);
  const day = sameOrNextDay(local, input.turnDay) ? input.turnDay : local;
  const used = day === input.turnDay ? input.dayTurns ?? 0 : 0;
  return { day, left: Math.max(0, DAILY_TURN_CAP - used) };
}

export function pruneMeetings(meetings: Record<string, MeetingRecord>, now: number): Record<string, MeetingRecord> {
  return Object.fromEntries(Object.entries(meetings).filter(([, record]) => now - record.start <= KEEP_MEETINGS_MS));
}

export function keepNewest<T>(list: readonly T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : [...list];
}

export function emailSince(input: { now: number; emailCursor?: number; checkMs: number }): number {
  if (input.emailCursor === undefined) return input.now - input.checkMs;
  return Math.max(input.emailCursor, input.now - EMAIL_MAX_AGE_MS);
}

export type AccountEvent = CalendarEvent & { account: string; kept?: true };
export type Meeting = CalendarEvent & { accounts: string[] };
export interface CalendarRead { at: number; events: readonly CalendarEvent[] }

const MEETING_KEY_MAX = 256;

export function isMine(event: CalendarEvent, addresses: ReadonlySet<string>): boolean {
  if (event.ownedCalendar === true) return true;
  if (event.organizer !== undefined && addresses.has(event.organizer.toLowerCase())) return true;
  return event.attendees.some((attendee) => addresses.has(attendee.email.toLowerCase()));
}

const hashed = (kind: string, value: string): string => `${kind}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;

export function meetingKey(event: CalendarEvent): string {
  if (!event.iCalUID) return hashed("sig", JSON.stringify([event.title.toLowerCase().replace(/\s+/g, " ").trim(), event.start, event.end]));
  const key = event.seriesId ? `${event.iCalUID}#${event.originalStart ?? event.id}` : event.iCalUID;
  return key.length > MEETING_KEY_MAX ? hashed("uid", key) : key;
}

const copyOrder = (copy: AccountEvent): string => `${copy.account}\n${copy.id}`;

function mergeGroup(group: readonly AccountEvent[], id: string, addresses: ReadonlySet<string>): Meeting {
  const fresh = group.filter((copy) => !copy.kept);
  const deciding = fresh.length > 0 ? fresh : group;
  const live = deciding.filter((copy) => copy.status !== "cancelled");
  const pool = live.length > 0 ? live : deciding;
  const lead = pool.reduce((best, copy) => {
    const more = copy.attendees.length - best.attendees.length;
    return more > 0 || (more === 0 && copyOrder(copy) < copyOrder(best)) ? copy : best;
  });
  const { account: _account, kept: _kept, ...details } = lead;
  const attendees = lead.attendees.map((attendee) => ({ ...attendee, self: addresses.has(attendee.email.toLowerCase()) || (attendee.self && lead.ownedCalendar === true) }));
  const mine = attendees.filter((attendee) => attendee.self);
  return {
    ...details,
    id,
    attendees,
    selfDeclined: mine.length > 0 ? mine.every((attendee) => attendee.response === "declined") : lead.selfDeclined,
    accounts: [...new Set(group.map((copy) => copy.account))].sort(),
  };
}

export function mergeMeetings(events: readonly AccountEvent[], addresses: ReadonlySet<string>): Meeting[] {
  const withUid = new Map<string, AccountEvent[]>();
  const withoutUid = new Map<string, AccountEvent[]>();
  for (const event of events.filter((one) => isMine(one, addresses))) {
    const groups = event.iCalUID ? withUid : withoutUid;
    const key = meetingKey(event);
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...withUid, ...withoutUid].map(([key, group]) => mergeGroup(group, key, addresses))
    .sort((a, b) => a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function eventsToMerge(reads: ReadonlyMap<string, CalendarRead>, input: { now: number; fresh: ReadonlySet<string> }): AccountEvent[] {
  return [...reads].flatMap(([account, read]): AccountEvent[] => {
    if (input.fresh.has(account)) return read.events.map((event) => ({ ...event, account }));
    if (input.now - read.at > KEPT_READ_MS) return [];
    return read.events.filter((event) => event.end > input.now).map((event) => ({ ...event, account, kept: true }));
  });
}

export function clashes<T extends CalendarEvent>(meetings: readonly T[], input: { now: number; timeZone?: string }): Array<[T, T]> {
  const today = localDate(input.now, input.timeZone);
  const open = meetings
    .filter((meeting) => qualifies(meeting) && meeting.end > input.now && localDate(meeting.start, input.timeZone) === today)
    .sort((a, b) => a.start - b.start);
  const pairs: Array<[T, T]> = [];
  open.forEach((first, index) => {
    for (const second of open.slice(index + 1)) {
      if (second.start < first.end && first.start < second.end) pairs.push([first, second]);
    }
  });
  return pairs;
}

export const emailKey = (email: Pick<EmailHeader, "account" | "id">): string => `${email.account}/${email.id}`;

export function planMail(input: { now: number; emails: readonly EmailHeader[]; judged: ReadonlySet<string>; lastTriageAt?: number; spacingMs: number }):
  { batch: EmailHeader[]; copies: EmailHeader[]; quiet: EmailHeader[]; pending: EmailHeader[] } {
  const fresh = input.emails.filter((email) => !input.judged.has(emailKey(email)));
  const quiet = fresh.filter((email) => input.now - email.at > EMAIL_MAX_AGE_MS);
  const recent = fresh.filter((email) => input.now - email.at <= EMAIL_MAX_AGE_MS).sort((a, b) => b.at - a.at);
  const firstWithHeader = new Map<string, EmailHeader>();
  const originals: EmailHeader[] = [];
  const copiesOf = new Map<EmailHeader, EmailHeader[]>();
  for (const email of recent) {
    const original = email.messageIdHeader === undefined ? undefined : firstWithHeader.get(email.messageIdHeader);
    if (original) {
      copiesOf.set(original, [...(copiesOf.get(original) ?? []), email]);
      continue;
    }
    if (email.messageIdHeader !== undefined) firstWithHeader.set(email.messageIdHeader, email);
    originals.push(email);
  }
  const due = input.lastTriageAt === undefined || input.now - input.lastTriageAt >= input.spacingMs;
  const batch = due ? originals.slice(0, TRIAGE_BATCH) : [];
  const rest = originals.slice(batch.length);
  return {
    batch,
    copies: batch.flatMap((email) => copiesOf.get(email) ?? []),
    quiet,
    pending: [...rest, ...rest.flatMap((email) => copiesOf.get(email) ?? [])].sort((a, b) => b.at - a.at),
  };
}

export function answered(email: Pick<EmailHeader, "at">, thread: readonly ThreadMessage[], addresses: ReadonlySet<string>): boolean {
  return thread.some((message) => message.at > email.at && addresses.has(message.from.toLowerCase()));
}

export function prunePending(list: readonly PendingEmail[], input: { now: number; accounts: ReadonlySet<string> }): PendingEmail[] {
  return list.filter((entry) => input.accounts.has(entry.account) && input.now - entry.judgedAt <= PENDING_MAX_AGE_MS);
}
