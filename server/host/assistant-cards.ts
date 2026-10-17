// server/host/assistant-cards.ts
import { WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import type { CalendarEvent, EmailHeader } from "../assistant-sources.ts";
import { localDate } from "./assistant-plan.ts";
import { validZone } from "./brief-recap.ts";

export interface BuiltCard {
  card: WidgetRoot;
  summary: string;
}

export interface TodayMeeting {
  allDay?: boolean;
  title: string;
  start: number;
  end: number;
  status: string;
  joinUrl?: string;
}

type Node = Record<string, unknown>;
type Target = { botId: string; threadId: string };
const DAY = 24 * 60 * 60_000;

function clip(text: string, max: number): string {
  const points = Array.from(text.trim());
  return points.length <= max ? points.join("") : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

const zoneOf = (timeZone: string | undefined): string => validZone(timeZone) ?? "UTC";
// ICU puts a narrow no-break space before AM/PM; cards and tests read plain spaces.
const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, " ");

export function clockTime(ms: number, timeZone: string | undefined): string {
  return plain(new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zoneOf(timeZone) }));
}

// An all-day event starts at UTC midnight whatever the zone, so it is read by that date, never as a clock time.
function dayLabel(start: number, timeZone: string | undefined, now: number, allDay: boolean): string {
  const date = allDay ? new Date(start).toISOString().slice(0, 10) : localDate(start, timeZone);
  if (date === localDate(now, timeZone)) return "Today";
  if (date === localDate(now + DAY, timeZone)) return "Tomorrow";
  return plain(new Date(start).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: allDay ? "UTC" : zoneOf(timeZone) }));
}

export function meetingWhen(start: number, end: number, timeZone: string | undefined, now: number, allDay = false): string {
  const day = dayLabel(start, timeZone, now, allDay);
  return allDay ? `${day}, all day` : `${day}, ${clockTime(start, timeZone)} to ${clockTime(end, timeZone)}`;
}

export function attendeeNames(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self);
  const name = (attendee: CalendarEvent["attendees"][number]) => attendee.name ?? attendee.email.split("@")[0]!;
  if (others.length <= 1) return others[0] ? name(others[0]) : "your meeting";
  return `${name(others[0]!)} and ${others.length - 1} other${others.length === 2 ? "" : "s"}`;
}

export const gmailUrl = (threadId: string): string => `https://mail.google.com/mail/#all/${encodeURIComponent(threadId)}`;

const button = (label: string, onClickAction: Node, primary = false): Node => ({ type: "Button", label, style: primary ? "primary" : "secondary", onClickAction });
const openUrl = (url: string): Node => ({ type: "open_url", payload: { url } });

// Invites are untrusted, so only an https link becomes a button.
function httpsLink(url: string | undefined): string | undefined {
  try {
    const parsed = url ? new URL(url) : undefined;
    return parsed?.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
const buttons = (items: Node[]): Node[] => (items.length ? [{ type: "Row", gap: 2, children: items }] : []);
const text = (value: string, max: number = WIDGET_LIMITS.text): Node => ({ type: "Text", value: clip(value, max) });

function root(title: string, caption: string | undefined, children: Node[]): WidgetRoot {
  return { type: "Card", id: "root", title: clip(title, WIDGET_LIMITS.title), ...(caption ? { caption: clip(caption, WIDGET_LIMITS.caption) } : {}), children } as unknown as WidgetRoot;
}

const join = (event: Pick<CalendarEvent, "joinUrl">, primary = true): Node[] => {
  const link = httpsLink(event.joinUrl);
  return link ? [button("Join", openUrl(link), primary)] : [];
};

export function prepCard(input: { event: CalendarEvent; brief: string; related?: Target; timeZone?: string; now: number }): BuiltCard {
  const { event } = input;
  const when = meetingWhen(event.start, event.end, input.timeZone, input.now, event.allDay);
  const where = event.location && event.location !== event.joinUrl ? ` · ${event.location}` : "";
  return {
    card: root(`Prep: ${event.title}`, `${when}${where}`, [
      { type: "Markdown", value: clip(input.brief, WIDGET_LIMITS.markdown) },
      ...buttons([
        ...join(event),
        ...(input.related ? [button("Open", { type: "open_thread", payload: input.related })] : []),
        button("Draft a follow-up", { type: "draft_followup", payload: { eventId: event.id } }),
      ]),
    ]),
    summary: `Prep ready: ${event.title}, ${when}`,
  };
}

export function reminderCard(input: { event: CalendarEvent; line?: string; timeZone?: string; now: number }): BuiltCard {
  const { event } = input;
  const minutes = Math.max(1, Math.round((event.start - input.now) / 60_000));
  const title = `Call with ${attendeeNames(event)} in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return {
    card: root(title, meetingWhen(event.start, event.end, input.timeZone, input.now, event.allDay), [
      text(event.title),
      ...(input.line ? [text(`Since last time: ${input.line}`)] : []),
      ...buttons([...join(event), button("Prep notes", { type: "prep_notes", payload: { eventId: event.id } })]),
    ]),
    summary: title,
  };
}

export function emailCard(input: { email: EmailHeader; why: string; action: string }): BuiltCard {
  const subject = input.email.subject || "(no subject)";
  return {
    card: root(subject, `From ${input.email.from}`, [
      text(input.why),
      text(`Suggested: ${input.action}`),
      ...buttons([
        button("Open in Gmail", openUrl(gmailUrl(input.email.threadId)), true),
        button("Draft a reply", { type: "draft_reply", payload: { messageId: input.email.id } }),
      ]),
    ]),
    summary: `Important email from ${input.email.from}: ${subject}`,
  };
}

export function updateCard(input: { event: CalendarEvent; text: string; timeZone?: string; now: number }): BuiltCard {
  const title = `Changed: ${input.event.title}`;
  return {
    card: root(title, meetingWhen(input.event.start, input.event.end, input.timeZone, input.now, input.event.allDay), [text(input.text), ...buttons(join(input.event))]),
    summary: `${title}. ${input.text}`,
  };
}

export function cancelledCard(input: { title: string; start: number; allDay?: boolean; timeZone?: string; now: number }): BuiltCard {
  const title = `Cancelled: ${input.title}`;
  return {
    card: root(title, input.allDay ? `Was ${meetingWhen(input.start, input.start, input.timeZone, input.now, true)}` : `Was ${dayLabel(input.start, input.timeZone, input.now, false)}, ${clockTime(input.start, input.timeZone)}`, [text("It is off your calendar.")]),
    summary: title,
  };
}

export function todayCard(input: { now: number; timeZone?: string; meetings: TodayMeeting[]; emails: Array<{ from: string; subject: string }>; team?: { text: string; open: Target } }): BuiltCard {
  const date = plain(new Date(input.now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zoneOf(input.timeZone) }));
  const meetings = input.meetings.slice(0, 12).map((meeting): Node => ({
    type: "Row", gap: 3, align: "center",
    children: [
      { type: "Col", flex: 1, children: [
        { type: "Text", value: clip(`${meeting.allDay ? "All day" : clockTime(meeting.start, input.timeZone)} · ${meeting.title}`, 200), weight: "medium", truncate: true },
        { type: "Caption", value: clip(meeting.status, 120) },
      ] },
      ...join(meeting, false),
    ],
  }));
  const children: Node[] = [
    { type: "Title", value: "Meetings", size: "sm" },
    ...(meetings.length ? meetings : [text("No meetings today.")]),
    ...(input.emails.length ? [{ type: "Title", value: "Email", size: "sm" }, ...input.emails.slice(0, 5).map((email) => ({ type: "Text", value: clip(`${email.from}: ${email.subject}`, 200), truncate: true }))] : []),
    ...(input.team ? [{ type: "Title", value: "Team", size: "sm" }, {
      type: "Row", gap: 3, align: "center",
      children: [{ type: "Col", flex: 1, children: [text(input.team.text, 200)] }, button("Open", { type: "open_thread", payload: input.team.open })],
    }] : []),
  ];
  const meetingCount = `${input.meetings.length} meeting${input.meetings.length === 1 ? "" : "s"}`;
  const emailCount = input.emails.length ? `, ${input.emails.length} important email${input.emails.length === 1 ? "" : "s"}` : "";
  return { card: root("Today", date, children), summary: `Today: ${meetingCount}${emailCount}` };
}
