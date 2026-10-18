// server/host/assistant-plan.ts
import { createHash } from "node:crypto";

import type { CalendarEvent, EmailHeader } from "../assistant-sources.ts";
import type { MeetingRecord } from "./assistant-state.ts";
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
export const RECONNECT_AFTER = 3;
export const KEEP_MEETINGS_MS = 35 * 24 * HOUR;
export const DEFAULT_CHECK_MS = 15 * MINUTE;

export type MeetingJob =
  | { kind: "prep"; event: CalendarEvent; short: boolean }
  | { kind: "repeat"; event: CalendarEvent; previousStart: number }
  | { kind: "update"; event: CalendarEvent; change: "time" | "attendees" | "both" }
  | { kind: "cancelled"; eventId: string; title: string; start: number }
  | { kind: "remind"; event: CalendarEvent };

export function qualifies(event: CalendarEvent): boolean {
  return event.status !== "cancelled" && !event.allDay && !event.selfDeclined && event.attendees.some((attendee) => !attendee.self);
}

export function fingerprint(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self).map((attendee) => attendee.email.toLowerCase()).sort();
  return createHash("sha256").update(others.join("\n")).digest("hex").slice(0, 32);
}

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

export function planMeetings(input: { now: number; events: CalendarEvent[]; meetings: Record<string, MeetingRecord>; checkMs: number }): MeetingJob[] {
  const { now, meetings } = input;
  const jobs: MeetingJob[] = [];
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

export function planTriage(input: { now: number; emails: EmailHeader[]; judged: ReadonlySet<string>; lastTriageAt?: number; spacingMs: number }): { batch: EmailHeader[]; quiet: string[]; pending: EmailHeader[] } {
  const fresh = input.emails.filter((email) => !input.judged.has(email.id));
  const quiet = fresh.filter((email) => input.now - email.at > EMAIL_MAX_AGE_MS).map((email) => email.id);
  const recent = fresh.filter((email) => input.now - email.at <= EMAIL_MAX_AGE_MS).sort((a, b) => b.at - a.at);
  const due = input.lastTriageAt === undefined || input.now - input.lastTriageAt >= input.spacingMs;
  const batch = due ? recent.slice(0, TRIAGE_BATCH) : [];
  return { batch, quiet, pending: recent.slice(batch.length) };
}

// Travel moves the local date back by at most one day; a stored day further ahead came from a clock jump.
function sameOrNextDay(local: string, stored: string | undefined): stored is string {
  if (stored === undefined) return false;
  const ahead = (Date.parse(stored) - Date.parse(local)) / (24 * HOUR);
  return ahead >= 0 && ahead <= 1;
}

export function todayDue(input: { now: number; timeZone?: string; lastTodayDate?: string }): string | null {
  const today = localDate(input.now, input.timeZone);
  return sameOrNextDay(today, input.lastTodayDate) ? null : today;
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
