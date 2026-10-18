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

/** Cut to `max` UTF-16 units, the widget validator's own count, never inside a surrogate pair. Newlines stay. */
export function clip(text: string, max: number): string {
  const value = text.trim();
  if (value.length <= max) return value;
  let cut = Math.max(0, max - 1);
  if (cut > 0 && /[\ud800-\udbff]/.test(value[cut - 1]!)) cut -= 1;
  return `${value.slice(0, cut).trimEnd()}…`;
}

const oneLine = (value: string, max: number): string => clip(value.replace(/\s+/g, " "), max);
const SUMMARY_MAX = 140;
const summary = (value: string): string => oneLine(value, SUMMARY_MAX);
/** The prep brief's cap, and the most lines it shows (each line is a node; a card holds 250). */
export const BRIEF_MAX = WIDGET_LIMITS.markdown;
const BRIEF_LINES = 120;
/** isWebUrl in shared/widget.ts refuses a longer url; the constant there is private. */
const WEB_URL_MAX = 2_000;

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
// A link the widget layer would refuse (too long) fails the whole card, so it is left out instead.
function openUrl(url: string): Node | undefined {
  const payload = { url };
  return url.length <= WEB_URL_MAX && JSON.stringify(payload).length <= WIDGET_LIMITS.actionPayloadBytes ? { type: "open_url", payload } : undefined;
}

// Invites are untrusted, so only an https link without a username or password becomes a button.
function httpsLink(url: string | undefined): string | undefined {
  try {
    const parsed = url ? new URL(url) : undefined;
    return parsed?.protocol === "https:" && !parsed.username && !parsed.password && openUrl(parsed.href) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
const buttons = (items: Node[]): Node[] => (items.length ? [{ type: "Row", gap: 2, children: items }] : []);
const text = (value: string, max: number = WIDGET_LIMITS.text): Node => ({ type: "Text", value: clip(value, max) });

function root(title: string, caption: string | undefined, children: Node[]): WidgetRoot {
  return { type: "Card", id: "root", title: oneLine(title, WIDGET_LIMITS.title), ...(caption ? { caption: oneLine(caption, WIDGET_LIMITS.caption) } : {}), children } as unknown as WidgetRoot;
}

// The brief is AI text shaped by untrusted invites: plain Text nodes only, so no link, image or HTML can render.
function briefLines(brief: string): Node[] {
  const lines = clip(brief, BRIEF_MAX).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const shown = lines.length > BRIEF_LINES ? [...lines.slice(0, BRIEF_LINES - 1), lines.slice(BRIEF_LINES - 1).join("\n")] : lines;
  return shown.map((line) => text(line));
}

const join = (event: Pick<CalendarEvent, "joinUrl">, primary = true): Node[] => {
  const link = httpsLink(event.joinUrl);
  const action = link ? openUrl(link) : undefined;
  return action ? [button("Join", action, primary)] : [];
};

export function prepCard(input: { event: CalendarEvent; brief: string; related?: Target; timeZone?: string; now: number }): BuiltCard {
  const { event } = input;
  const when = meetingWhen(event.start, event.end, input.timeZone, input.now, event.allDay);
  const where = event.location && event.location !== event.joinUrl ? ` · ${event.location}` : "";
  return {
    card: root(`Prep: ${event.title}`, `${when}${where}`, [
      ...briefLines(input.brief),
      ...buttons([
        ...join(event),
        ...(input.related ? [button("Open", { type: "open_thread", payload: input.related })] : []),
        button("Draft a follow-up", { type: "draft_followup", payload: { eventId: event.id } }),
      ]),
    ]),
    summary: summary(`Prep ready: ${event.title}, ${when}`),
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
    summary: summary(title),
  };
}

// "Ada <ada@example.test>" becomes "Ada"; with no name, the address.
const SENDER_INPUT_MAX = 300;

function senderName(rawFrom: string): string {
  const from = rawFrom.slice(0, SENDER_INPUT_MAX);
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from);
  return match ? match[1]!.trim() || match[2]!.trim() : from.trim();
}

export function emailCard(input: { email: EmailHeader; why: string; action: string }): BuiltCard {
  const subject = input.email.subject || "(no subject)";
  const gmail = openUrl(gmailUrl(input.email.threadId));
  return {
    card: root(subject, `From ${input.email.from}`, [
      text(input.why),
      text(`Suggested: ${input.action}`),
      ...buttons([
        ...(gmail ? [button("Open in Gmail", gmail, true)] : []),
        button("Draft a reply", { type: "draft_reply", payload: { messageId: input.email.id } }),
      ]),
    ]),
    summary: summary(`Important email from ${senderName(input.email.from)}: ${subject}`),
  };
}

export function updateCard(input: { event: CalendarEvent; text: string; timeZone?: string; now: number }): BuiltCard {
  const title = `Changed: ${input.event.title}`;
  return {
    card: root(title, meetingWhen(input.event.start, input.event.end, input.timeZone, input.now, input.event.allDay), [text(input.text), ...buttons(join(input.event))]),
    summary: summary(`${title}. ${input.text}`),
  };
}

export function cancelledCard(input: { title: string; start: number; allDay?: boolean; timeZone?: string; now: number }): BuiltCard {
  const title = `Cancelled: ${input.title}`;
  return {
    card: root(title, input.allDay ? `Was ${meetingWhen(input.start, input.start, input.timeZone, input.now, true)}` : `Was ${dayLabel(input.start, input.timeZone, input.now, false)}, ${clockTime(input.start, input.timeZone)}`, [text("It is off your calendar.")]),
    summary: summary(title),
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
