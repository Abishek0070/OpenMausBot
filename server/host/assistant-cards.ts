import { WEB_URL_MAX, WIDGET_LIMITS, type WidgetRoot } from "../../shared/widget.ts";
import type { CalendarEvent, EmailHeader } from "../assistant-sources.ts";
import { localDate } from "./assistant-plan.ts";
import { validZone, type RoutineRow } from "./brief-recap.ts";
import { clip, oneLine } from "./text-clip.ts";

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

const SUMMARY_MAX = 140;
const summary = (value: string): string => oneLine(value, SUMMARY_MAX);
/** The prep brief's cap, and the most lines it shows (each line is a node; a card holds 250). */
export const BRIEF_MAX = WIDGET_LIMITS.markdown;
const BRIEF_LINES = 120;

const zoneOf = (timeZone: string | undefined): string => validZone(timeZone) ?? "UTC";
// ICU puts a narrow no-break space before AM/PM; cards and tests read plain spaces.
const plain = (text: string): string => text.replace(/[\u202f\u00a0]/g, " ");

const bareClock = (ms: number, timeZone: string | undefined): string =>
  plain(new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zoneOf(timeZone) }));

/** Labelled UTC when no zone is known. */
export function clockTime(ms: number, timeZone: string | undefined): string {
  return validZone(timeZone) ? bareClock(ms, timeZone) : `${bareClock(ms, timeZone)} UTC`;
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
  return allDay ? `${day}, all day` : `${day}, ${bareClock(start, timeZone)} to ${clockTime(end, timeZone)}`;
}

export function attendeeNames(event: CalendarEvent): string {
  const others = event.attendees.filter((attendee) => !attendee.self);
  const name = (attendee: CalendarEvent["attendees"][number]) => attendee.name ?? attendee.email.split("@")[0]!;
  if (others.length <= 1) return others[0] ? name(others[0]) : "your meeting";
  return `${name(others[0]!)} and ${others.length - 1} other${others.length === 2 ? "" : "s"}`;
}

/** With the account's address the link opens that account's mailbox; without one, whichever is signed in first. */
export const gmailUrl = (threadId: string, address?: string): string =>
  `https://mail.google.com/mail/${address ? `u/${encodeURIComponent(address)}/` : ""}#all/${encodeURIComponent(threadId)}`;

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
const withAccounts = (caption: string, accounts: string | undefined): string => (accounts ? `${caption} · ${accounts}` : caption);
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

export function prepCard(input: { event: CalendarEvent; brief: string; related?: Target; timeZone?: string; now: number; accounts?: string }): BuiltCard {
  const { event } = input;
  const when = meetingWhen(event.start, event.end, input.timeZone, input.now, event.allDay);
  const where = event.location && event.location !== event.joinUrl ? ` · ${event.location}` : "";
  return {
    card: root(`Prep: ${event.title}`, withAccounts(`${when}${where}`, input.accounts), [
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

export function reminderCard(input: { event: CalendarEvent; line?: string; timeZone?: string; now: number; accounts?: string }): BuiltCard {
  const { event } = input;
  const minutes = Math.max(1, Math.round((event.start - input.now) / 60_000));
  const title = `Call with ${attendeeNames(event)} in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return {
    card: root(title, withAccounts(meetingWhen(event.start, event.end, input.timeZone, input.now, event.allDay), input.accounts), [
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

export function emailCard(input: { email: EmailHeader; why: string; action: string; account?: string; address?: string }): BuiltCard {
  const subject = input.email.subject || "(no subject)";
  const gmail = openUrl(gmailUrl(input.email.threadId, input.address));
  return {
    card: root(subject, `From ${input.email.from}${input.account ? ` · to ${input.account}` : ""}`, [
      text(input.why),
      text(`Suggested: ${input.action}`),
      ...buttons([
        ...(gmail ? [button("Open in Gmail", gmail, true)] : []),
        button("Draft a reply", { type: "draft_reply", payload: { messageId: input.email.id, account: input.email.account } }),
      ]),
    ]),
    summary: summary(`Important email from ${senderName(input.email.from)}: ${subject}`),
  };
}

export function updateCard(input: { event: CalendarEvent; text: string; timeZone?: string; now: number; accounts?: string }): BuiltCard {
  const title = `Changed: ${input.event.title}`;
  return {
    card: root(title, withAccounts(meetingWhen(input.event.start, input.event.end, input.timeZone, input.now, input.event.allDay), input.accounts), [text(input.text), ...buttons(join(input.event))]),
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

/** Today's meetings, or why they are not shown yet: the calendar is being read, or could not be read. */
export type TodayMeetings = TodayMeeting[] | "checking" | "unreadable";
const TODAY_CALENDAR = { checking: "Checking your calendar…", unreadable: "I couldn't read your calendar." } as const;
const TODAY_CALENDAR_SUMMARY = { checking: "checking your calendar…", unreadable: "your calendar could not be read" } as const;

const longDate = (now: number, timeZone: string | undefined): string =>
  plain(new Date(now).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: zoneOf(timeZone) }));

export function todayCard(input: { now: number; timeZone?: string; meetings: TodayMeetings; emails: Array<{ from: string; subject: string }>; team?: { text: string; open: Target } }): BuiltCard {
  const date = longDate(input.now, input.timeZone);
  const list = typeof input.meetings === "string" ? [] : input.meetings;
  const meetings = list.slice(0, 12).map((meeting): Node => ({
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
    ...(typeof input.meetings === "string" ? [text(TODAY_CALENDAR[input.meetings])] : meetings.length ? meetings : [text("No meetings today.")]),
    ...(input.emails.length ? [{ type: "Title", value: "Email", size: "sm" }, ...input.emails.slice(0, 5).map((email) => ({ type: "Text", value: clip(`${email.from}: ${email.subject}`, 200), truncate: true }))] : []),
    ...(input.team ? [{ type: "Title", value: "Team", size: "sm" }, {
      type: "Row", gap: 3, align: "center",
      children: [{ type: "Col", flex: 1, children: [text(input.team.text, 200)] }, button("Open", { type: "open_thread", payload: input.team.open })],
    }] : []),
  ];
  const meetingCount = typeof input.meetings === "string" ? TODAY_CALENDAR_SUMMARY[input.meetings] : `${list.length} meeting${list.length === 1 ? "" : "s"}`;
  const emailCount = input.emails.length ? `, ${input.emails.length} important email${input.emails.length === 1 ? "" : "s"}` : "";
  return { card: root("Today", date, children), summary: `Today: ${meetingCount}${emailCount}` };
}

export const BRIEF_TITLE = "Daily brief";
export const BRIEF_ROWS = 6;
export const DISMISS_ACTION = "dismiss_email";

export interface BriefMeeting { title: string; start: number; end: number; accounts: string; status: string; joinUrl?: string }
export interface BriefEmail { accountId: string; account: string; address?: string; messageId: string; threadId: string; from: string; subject: string; why?: string }
export interface BriefClash { first: { title: string; start: number; accounts: string }; second: { title: string; start: number; accounts: string } }
export interface BriefFacts {
  now: number;
  timeZone?: string;
  missing: Array<{ account: string; what: "calendar" | "email" }>;
  replies: BriefEmail[];
  repliesChecking: boolean;
  failedRoutines: RoutineRow[];
  clashes: BriefClash[];
  /** null: no Calendar account, so Your day is left out. */
  meetings: BriefMeeting[] | "checking" | null;
  important: BriefEmail[];
  routines: RoutineRow[];
}

/** UTF-16 units per field and the longest link a row carries: a brief with every section full stays under the widget's byte cap. */
const BRIEF_TEXT = { line: 120, caption: 160, half: 52, account: 80, sender: 40, labelName: 32, labelAccount: 16, link: 600 } as const;
const CHECKING_EMAIL = "Checking your email…";

const caption = (value: string): Node => ({ type: "Caption", value: clip(value, BRIEF_TEXT.caption) });
const briefLink = (url: string | undefined): Node | undefined => (url && url.length <= BRIEF_TEXT.link ? openUrl(url) : undefined);
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
const sender = (email: BriefEmail, max: number): string => oneLine(senderName(email.from), max) || "(no sender)";

const rowLines = (value: string, note: string): Node[] => [{ type: "Text", value: clip(value, BRIEF_TEXT.line), weight: "medium" }, caption(note)];
const rowWithPressesBeside = (value: string, note: string, presses: Node[]): Node =>
  ({ type: "Row", gap: 3, align: "center", children: [{ type: "Col", flex: 1, children: rowLines(value, note) }, ...presses] });
const rowWithPressesUnder = (value: string, note: string, presses: Node[]): Node =>
  ({ type: "Col", gap: 1, children: [...rowLines(value, note), ...(presses.length ? [{ type: "Row", gap: 2, wrap: true, children: presses }] : [])] });
function capped(rows: Node[], total: number): Node[] {
  const shown = rows.slice(0, BRIEF_ROWS);
  return total > shown.length ? [...shown, caption(`and ${total - shown.length} more`)] : shown;
}

const briefSection = (title: string, rows: Node[], total: number, empty?: string): Node[] =>
  [{ type: "Title", value: title, size: "sm" }, ...(rows.length ? capped(rows, total) : empty ? [text(empty)] : [])];

function distinctLabels(wanted: ReadonlyArray<{ base: string; account: string }>): string[] {
  const local = (account: string): string => oneLine(account.split("@")[0]!, BRIEF_TEXT.labelAccount) || "account";
  const accounts = new Map<string, Set<string>>();
  for (const { base, account } of wanted) accounts.set(base, (accounts.get(base) ?? new Set<string>()).add(local(account)));
  const taken = new Set<string>();
  return wanted.map(({ base, account }) => {
    const named = accounts.get(base)!.size > 1 ? `${base} (${local(account)})` : base;
    let label = named;
    for (let n = 2; taken.has(label); n += 1) label = `${named} (${n})`;
    taken.add(label);
    return label;
  });
}

function buildBrief(facts: BriefFacts, presses: boolean): BuiltCard {
  const zone = facts.timeZone;
  const needs = [
    ...facts.replies.map((reply) => ({ reply })),
    ...facts.failedRoutines.map((routine) => ({ routine })),
    ...facts.clashes.map((clash) => ({ clash })),
  ];
  const shownNeeds = needs.slice(0, BRIEF_ROWS);
  const replies = shownNeeds.flatMap((need) => ("reply" in need ? [need.reply] : []));
  const important = facts.important.slice(0, BRIEF_ROWS);
  const drafts = distinctLabels(replies.map((email) => ({ base: `Draft a reply to ${sender(email, BRIEF_TEXT.labelName)}`, account: email.account })));
  const dismisses = distinctLabels([...replies, ...important].map((email) => ({ base: `Dismiss ${sender(email, BRIEF_TEXT.labelName)}'s email`, account: email.account })));

  const offer = (items: Array<Node | undefined | false>): Node[] => (presses ? items.filter((item): item is Node => Boolean(item)) : []);
  const gmail = (email: BriefEmail): Node | undefined => {
    const action = briefLink(gmailUrl(email.threadId, email.address));
    return action && button("Open in Gmail", action);
  };
  const dismiss = (email: BriefEmail, label: string): Node => button(label, { type: DISMISS_ACTION, payload: { messageId: email.messageId, account: email.accountId } });
  const open = (row: RoutineRow): Node | undefined => row.open && button("Open", { type: "open_thread", payload: row.open });
  const emailText = (email: BriefEmail): string => `${sender(email, BRIEF_TEXT.sender)}: ${email.subject || "(no subject)"}`;
  const account = (email: BriefEmail): string => clip(email.account, BRIEF_TEXT.account);

  let reply = 0;
  const needRows = shownNeeds.map((need): Node => {
    if ("reply" in need) {
      const email = need.reply;
      const index = reply++;
      return rowWithPressesUnder(emailText(email), `${account(email)} · waiting on your reply`, offer([
        button(drafts[index]!, { type: "draft_reply", payload: { messageId: email.messageId, account: email.accountId } }),
        gmail(email),
        dismiss(email, dismisses[index]!),
      ]));
    }
    if ("routine" in need) {
      const { routine } = need;
      const outcome = routine.status === "missed" ? " was missed" : " failed";
      return rowWithPressesBeside(`${clip(routine.name, BRIEF_TEXT.line - outcome.length)}${outcome}`, routine.line, offer([open(routine)]));
    }
    const { first, second } = need.clash;
    return rowWithPressesBeside(
      `${clip(first.title, BRIEF_TEXT.half)} and ${clip(second.title, BRIEF_TEXT.half)} overlap`,
      `${clockTime(first.start, zone)} on ${clip(first.accounts, BRIEF_TEXT.half)} and ${clockTime(second.start, zone)} on ${clip(second.accounts, BRIEF_TEXT.half)}`,
      [],
    );
  });

  const meetings = Array.isArray(facts.meetings) ? [...facts.meetings].sort((a, b) => a.start - b.start) : [];
  const meetingRows = meetings.slice(0, BRIEF_ROWS).map((meeting) => {
    const join = briefLink(httpsLink(meeting.joinUrl));
    return rowWithPressesBeside(`${clockTime(meeting.start, zone)} · ${meeting.title}`, withAccounts(meeting.status, meeting.accounts), offer([join && button("Join", join)]));
  });
  const importantRows = important.map((email, index) =>
    rowWithPressesUnder(emailText(email), email.why ? `${account(email)} · ${email.why}` : account(email), offer([gmail(email), dismiss(email, dismisses[replies.length + index]!)])));
  const routineRows = facts.routines.slice(0, BRIEF_ROWS).map((routine) => rowWithPressesBeside(routine.name, routine.line, offer([open(routine)])));
  const missing = facts.missing.map(({ account: name, what }) => text(`I couldn't read the ${what} of ${clip(name, BRIEF_TEXT.account)}.`));

  const children: Node[] = [
    ...capped(missing, missing.length),
    ...briefSection("Needs you", needRows, needs.length, facts.repliesChecking ? CHECKING_EMAIL : "Nothing needs you right now."),
    ...(needRows.length && facts.repliesChecking ? [caption(CHECKING_EMAIL)] : []),
    ...(facts.meetings === null ? [] : briefSection("Your day", meetingRows, meetings.length, facts.meetings === "checking" ? "Checking your calendar…" : "No meetings today.")),
    ...(importantRows.length ? briefSection("Important emails", importantRows, facts.important.length) : []),
    ...(routineRows.length ? briefSection("Routines", routineRows, facts.routines.length) : []),
  ];
  const parts = [
    facts.missing.length && `${plural(facts.missing.length, "account")} unreadable`,
    needs.length && `${needs.length} ${needs.length === 1 ? "needs" : "need"} you`,
    facts.repliesChecking && CHECKING_EMAIL.toLowerCase(),
    facts.meetings === "checking" ? "checking your calendar…" : facts.meetings && plural(facts.meetings.length, "meeting"),
    facts.important.length && plural(facts.important.length, "important email"),
    facts.routines.length && plural(facts.routines.length, "routine result"),
  ].filter(Boolean);
  return { card: root(BRIEF_TITLE, longDate(facts.now, zone), children), summary: summary(`${BRIEF_TITLE}: ${parts.length ? parts.join(", ") : "nothing needs you right now"}`) };
}

export const briefCard = (facts: BriefFacts): BuiltCard => buildBrief(facts, true);
export const briefFallbackCard = (facts: BriefFacts): BuiltCard => buildBrief(facts, false);
