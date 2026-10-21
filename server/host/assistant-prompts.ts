import { THREAD_ID } from "../../shared/widget.ts";
import type { CalendarEvent, EmailHeader } from "../assistant-sources.ts";
import { clean, recordsBlock } from "../records-block.ts";
import { BRIEF_MAX, meetingWhen } from "./assistant-cards.ts";
import { CARDS_PER_TRIAGE } from "./assistant-plan.ts";
import type { MeetingRecord } from "./assistant-state.ts";
import { clip } from "./text-clip.ts";

const PEOPLE_MAX = 30;
const NEVER_ACT = "Never send, book, accept, decline, delete or change anything; you may read, and you may only draft.";

export interface TurnTools {
  searchTools: boolean;
  mailTools: boolean;
}

export function jobMarker(kind: "prep" | "update" | "since last time" | "email check", id?: string): string {
  const safe = id?.replace(/[^\w.-]/g, "").slice(0, 100);
  return `[MausBot ${kind}${safe ? ` ${safe}` : ""}]`;
}

export function calendarRecords(event: CalendarEvent, timeZone: string | undefined, now: number): string {
  const people = event.attendees.filter((attendee) => !attendee.self)
    .map((attendee) => `${attendee.name ? `${clean(attendee.name, 80)} ` : ""}<${clean(attendee.email, 120)}>${attendee.organizer ? " (organizer)" : ""}`);
  return recordsBlock("Google Calendar", [
    `Title: ${clean(event.title, 200)}`,
    `When: ${meetingWhen(event.start, event.end, timeZone, now, event.allDay)}`,
    ...(event.location ? [`Where: ${clean(event.location, 200)}`] : []),
    `Attendees: ${people.join(", ")}`,
    ...(event.description ? [`Invite text: ${clean(event.description, 2_000)}`] : []),
  ]);
}

function historyLine(tools: TurnTools): string {
  const sources = [
    tools.mailTools ? "earlier email with them (Gmail, read only)" : "",
    tools.searchTools ? "earlier meetings and anything the person's bots did that mentions them or their company (session_search searches every conversation the person can see)" : "",
  ].filter(Boolean);
  return sources.length ? `- the person's history with them: ${sources.join("; ")};` : "- the person's history with them, from what the records above say;";
}

export function prepPrompt(input: { event: CalendarEvent; short: boolean; timeZone?: string; now: number; accounts?: string[] } & TurnTools): string {
  const words = input.short ? 150 : 350;
  const accounts = input.accounts && input.accounts.length >= 2
    ? [`The person's Google accounts: ${input.accounts.map((label) => clean(label, 120)).join(", ")}. Name the account in every Gmail or Calendar call.`]
    : [];
  return [
    jobMarker("prep", input.event.id),
    input.short ? "Prepare the person for this meeting. It starts soon, so keep it short: who, why, one next step." : "Prepare the person for this meeting.",
    calendarRecords(input.event, input.timeZone, input.now),
    ...accounts,
    "Find out:",
    "- who the attendees are: role, company, and anything recent about them on the web;",
    "- why the meeting exists, from the invite text;",
    historyLine(input),
    "- what is still open, and one suggested next step.",
    NEVER_ACT,
    "Answer with one JSON object and nothing else:",
    `{"brief": "<plain text, at most ${words} words, with the sections Who, Why, History, Open questions, Next step>", ${input.searchTools ? '"relatedThreadId": "<the thread id of the conversation most about this meeting, from a search hit, or an empty string>", ' : ""}"noWebSearch": <true if you had no web search tool, else false>}`,
  ].join("\n");
}

export function repeatPrompt(input: { event: CalendarEvent; previousStart: number; timeZone?: string; now: number } & TurnTools): string {
  return [
    jobMarker("since last time", input.event.id),
    `This meeting repeats. The person last met the same people ${meetingWhen(input.previousStart, input.previousStart, input.timeZone, input.now, input.event.allDay).replace(/ to .*$/, "")}, and one of them has emailed since.`,
    calendarRecords(input.event, input.timeZone, input.now),
    input.mailTools || input.searchTools
      ? `Write one sentence on what changed since last time${input.mailTools ? ", from their recent email" : ""}${input.searchTools ? `${input.mailTools ? " and" : ", from"} earlier conversations` : ""}. No web research.`
      : "You have no mail or search tools: work only from the meeting and any previous notes in the records. Write one sentence on what changed since last time. No web research.",
    NEVER_ACT,
    'Answer with one JSON object and nothing else: {"line": "<one sentence, or an empty string if nothing changed>"}',
  ].join("\n");
}

export function updatePrompt(input: { event: CalendarEvent; previous: MeetingRecord; timeZone?: string; now: number }): string {
  const was = meetingWhen(input.previous.start, input.previous.start + (input.event.end - input.event.start), input.timeZone, input.now, input.event.allDay);
  return [
    jobMarker("update", input.event.id),
    `A meeting the person was prepared for changed. It used to be ${was}; the records below are how it is now.`,
    calendarRecords(input.event, input.timeZone, input.now),
    "Write one or two sentences for the person: what changed, and whether anything in the prep needs another look.",
    NEVER_ACT,
    'Answer with one JSON object and nothing else: {"update": "<one or two sentences>"}',
  ].join("\n");
}

export function emailRecords(emails: readonly EmailHeader[], label?: (accountId: string) => string): string {
  return recordsBlock("Gmail", emails.map((email) => `id ${clean(email.id, 120)}${label ? ` · account ${clean(label(email.account), 120)}` : ""} · from ${clean(email.from, 120)} · subject ${clean(email.subject, 200)} · preview ${clean(email.preview, 300)}`));
}

/** The records, plus where the draft must come from: the account that received the email. */
export function replyRecords(email: EmailHeader, label: string, accountId?: string): string {
  return [
    emailRecords([email], () => label),
    `Draft the reply from ${clean(label, 120)}${accountId ? ` (connected account ${clean(accountId, 120)})` : ""}, and name that account in the draft call.`,
  ].join("\n");
}

export function triagePrompt(input: { emails: EmailHeader[]; meetingToday: string[]; label?: (accountId: string) => string }): string {
  return [
    jobMarker("email check"),
    "Decide which of these new emails the person must not miss: one that needs a reply from them, one from someone they meet today, or one that carries a deadline. Everything else is not important. Judge from the sender, the subject and the preview only.",
    emailRecords(input.emails, input.label),
    ...(input.meetingToday.length
      ? [
        "The people the person meets today, from their calendar:",
        recordsBlock("Google Calendar", input.meetingToday.slice(0, PEOPLE_MAX).map((person) => clean(person, 120))),
        ...(input.meetingToday.length > PEOPLE_MAX ? [`(${input.meetingToday.length - PEOPLE_MAX} more people are not listed.)`] : []),
      ]
      : ["The person meets nobody today."]),
    "Do not open, send, label, archive or change any email.",
    `Answer with one JSON object and nothing else: {"important": [{"id": "<an id from the records>", "why": "<one sentence>", "action": "<one suggested action>", "needsReply": <true when the person must reply>}]} — at most ${CARDS_PER_TRIAGE}, and an empty list when nothing matters.`,
  ].join("\n");
}

export function jsonReply(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function prepReply(text: string): { brief: string; relatedThreadId?: string; noWebSearch: boolean } | null {
  const json = jsonReply(text);
  if (json && typeof json.brief === "string" && json.brief.trim()) {
    const related = typeof json.relatedThreadId === "string" && THREAD_ID.test(json.relatedThreadId) ? json.relatedThreadId : undefined;
    return { brief: clip(json.brief, BRIEF_MAX), ...(related ? { relatedThreadId: related } : {}), noWebSearch: json.noWebSearch === true };
  }
  // A reply that is a JSON object we could not use is unreadable, never a brief of raw JSON.
  if (/^\s*(?:```[\w-]*\s*)?\{/.test(text)) return null;
  const plain = clip(text, BRIEF_MAX);
  return plain ? { brief: plain, noWebSearch: false } : null;
}

export function triageReply(text: string, ids: ReadonlySet<string>): Array<{ id: string; why: string; action: string; needsReply: boolean }> | null {
  const json = jsonReply(text);
  if (!json || !Array.isArray(json.important)) return null;
  const seen = new Set<string>();
  return json.important.flatMap((raw) => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (typeof item.id !== "string" || seen.has(item.id) || !ids.has(item.id) || typeof item.why !== "string" || typeof item.action !== "string") return [];
    seen.add(item.id);
    return [{ id: item.id, why: clean(item.why, 240), action: clean(item.action, 240), needsReply: item.needsReply === true }];
  }).slice(0, CARDS_PER_TRIAGE);
}

export function lineReply(text: string, key: "update" | "line"): string | null {
  const json = jsonReply(text);
  const value = json?.[key];
  return typeof value === "string" ? clean(value, 400) : null;
}
