import { join } from "node:path";

import { ASSISTANT_SERVICES, type AssistantService, type AssistantSources, type CalendarEvent, type EmailHeader, type SourceAccount } from "../assistant-sources.ts";
import { audienceWithin } from "../bot-visibility.ts";
import { createAgentCard } from "../chat-widgets.ts";
import { connectorCardText } from "../connector-card-text.ts";
import type { RequestOutcome } from "../contracts.ts";
import { failure } from "../failure.ts";
import { buildNotification, type Notification } from "../notify.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { createAssistantAccounts } from "./assistant-accounts.ts";
import { cancelledCard, clockTime, emailCard, prepCard, reminderCard, todayCard, updateCard, type BuiltCard, type TodayMeeting, type TodayMeetings } from "./assistant-cards.ts";
import { clip } from "./text-clip.ts";
import {
  DAILY_TURN_CAP, emailKey, emailSince, eventsToMerge, fingerprint, keepNewest, localDate, LOOKAHEAD_MS, mergeMeetings, planMail, planMeetings, PREP_LEAD_MS, pruneMeetings,
  qualifies, todayDue, turnsLeft, type CalendarRead, type Meeting,
} from "./assistant-plan.ts";
import { calendarRecords, lineReply, prepPrompt, prepReply, replyRecords, repeatPrompt, triagePrompt, triageReply, updatePrompt, type TurnTools } from "./assistant-prompts.ts";
import {
  ASSISTANT_STATE_FILE, createAssistantState, MAX_ID_LENGTH, MAX_IN_FLIGHT, MAX_JUDGED, MAX_WORK_THREADS, type AssistantState, type AssistantStateStore, type MeetingRecord,
} from "./assistant-state.ts";
import { isAssistantJobThread, type JobResult } from "./assistant-turns.ts";
import { mausbotMayUse } from "./mausbot-intro.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WORK_THREAD_TTL_MS = 24 * HOUR;
const EMAIL_FETCH_LIMIT = 50;
const CURSOR_OVERLAP_MS = 5 * MINUTE;
const MAX_RETRY_CARDS = 100;
const MAX_REMEMBERED = 200;
const TITLE_MAX = 120;
const REASON_MAX = 300;

export const RETRY = "Retry";
export const TODAY_FAILED = "I couldn't read your calendar for Today";
const CALENDAR_UNREAD = "Google Calendar did not answer";
const CALENDAR_DISCONNECTED = "Google Calendar is not connected";
export const NO_WEB_SEARCH = "I can't search the web on this engine, so my meeting prep uses your calendar, your mail and earlier conversations only.";
export const NO_CONNECTOR_TOOLS = "My engine can't use your connected apps inside its own turns, so my prep works from the calendar details I read for you and from earlier conversations.";
const LABEL: Record<AssistantService, string> = { gmail: "Gmail", googlecalendar: "Google Calendar" };
const CUT_SHORT: Record<string, string> = {
  prep: "A meeting prep was cut short",
  repeat: "A since-last-time note was cut short",
  update: "A meeting update was cut short",
  triage: "An email check was cut short",
};
const RETRY_CLEARS: Record<string, ReadonlyArray<keyof MeetingRecord>> = {
  prep: ["failedAt", "prepStartedAt", "repeat"],
  repeat: ["failedAt", "prepStartedAt", "repeat"],
  update: ["updateStartedAt", "updateFailedAt"],
};

type Job =
  | { kind: "prep"; item: string; event: Meeting; short: boolean; turn: string; delivered?: boolean }
  | { kind: "repeat"; item: string; event: Meeting; previousStart: number; turn?: string; delivered?: boolean }
  | { kind: "update"; item: string; event: Meeting; previous: MeetingRecord; turn: string; delivered?: boolean }
  | { kind: "triage"; item: string; batch: EmailHeader[]; copies: EmailHeader[]; carded: Set<string> };

const FAILED: Record<Job["kind"], (title: string) => string> = {
  prep: (title) => `I couldn't prepare "${title}"`,
  repeat: (title) => `I couldn't check what changed since your last "${title}"`,
  update: (title) => `I couldn't write the update for "${title}"`,
  triage: () => "I couldn't check your new email",
};

type Target = { botId: string; threadId: string };
type MailRead = { account: string; cursorAtRead: number | undefined; mail: EmailHeader[] };
type Outcome = NonNullable<NonNullable<AssistantState["retryCards"]>[string]["outcome"]>;
/** `key` is absent while the card waits for its first calendar read. */
type TodayPost = { messageId: string; threadId: string; day: string; key?: string; failed?: boolean; emails: Array<{ from: string; subject: string }>; team?: { text: string; open: Target } };

export interface AssistantWatchDeps {
  store: Pick<Store, "appendMessage" | "messagesFor" | "patchMessage" | "groupByThread" | "patchTask" | "deleteTasks" | "taskByThread" | "tasks">;
  dataDir: string;
  now?: () => number;
  checkMs: number;
  hosted: boolean;
  enabled(): boolean;
  mausbot(): BotRecord | null;
  mainThread(bot: BotRecord): string | undefined;
  timeZone(): string | undefined;
  capabilities(bot: BotRecord, threadId: string): { agentsTools: boolean; mailTools: boolean };
  sources: AssistantSources;
  runJob(bot: BotRecord, title: string, prompt: string): Promise<JobResult>;
  notify(notification: Notification | null): void;
  noteCard(card: Target): void;
  team(since: number): { text: string; open: Target } | null;
  threadOf(threadId: string): { bot: Pick<BotRecord, "id" | "visibility">; cloudGuest: boolean } | null;
  threadBusy(botId: string, threadId: string): boolean;
  newId(): string;
  every?(run: () => void, ms: number): { cancel(): void };
}

const kindOf = (item: string): string => item.slice(0, item.indexOf(":"));
const subjectOf = (item: string): string => item.slice(item.indexOf(":") + 1);
const triageItem = (emails: readonly EmailHeader[]): string => `triage:${Math.min(...emails.map((email) => email.at))}:${emails.map(emailKey).join(",")}`;
const titleOf = (job: Job): string => (job.kind === "triage" ? "" : clip(job.event.title, TITLE_MAX));
const turnOf = (job: Job): string | undefined => (job.kind === "triage" ? undefined : job.turn);
const storable = (value: string | undefined): boolean => value === undefined || (value.length >= 1 && value.length <= MAX_ID_LENGTH);
const meetingsKey = (list: readonly TodayMeeting[]): string => JSON.stringify(list.map((meeting) => [meeting.title, meeting.start, meeting.end, meeting.joinUrl ?? "", meeting.allDay === true]));

function triageOf(item: string): { oldest: number; emails: Array<{ account: string; id: string }> } {
  const subject = subjectOf(item);
  const cut = subject.indexOf(":");
  const emails = subject.slice(cut + 1).split(",").map((key) => {
    const slash = key.lastIndexOf("/");
    return { account: slash < 0 ? "" : key.slice(0, slash), id: key.slice(slash + 1) };
  });
  return { oldest: Number(subject.slice(0, cut)), emails };
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}

function quietly(what: string, step: () => void): void {
  try {
    step();
  } catch (error) {
    console.warn(`assistant: ${what}: ${failure(error)}`);
  }
}

export function createAssistantWatch(deps: AssistantWatchDeps) {
  const now = deps.now ?? Date.now;
  const state: AssistantStateStore = createAssistantState(join(deps.dataDir, ASSISTANT_STATE_FILE));
  const every = deps.every ?? ((run: () => void, ms: number) => {
    const timer = setInterval(run, ms);
    timer.unref?.();
    return { cancel: () => clearInterval(timer) };
  });
  let events: Meeting[] = [];
  const calendarReads = new Map<string, CalendarRead>();
  let calendarReadAt: number | undefined;
  let todayPending = false;
  let todayRefresh: TodayPost | undefined;
  let recovered = false;
  let missedCheck = false;
  let flagged: EmailHeader[] = [];
  const cardEvents = new Map<string, Meeting>();
  const cardEmails = new Map<string, EmailHeader>();
  const sinceLastTime = new Map<string, string>();
  const queue: Job[] = [];
  let working: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  let scheduledCheck = false;
  const timers: Array<{ cancel(): void }> = [];

  const current = () => state.get();
  const meetings = (): Record<string, MeetingRecord> => current().meetings ?? {};
  const accounts = createAssistantAccounts({
    state, sources: deps.sources, now, checkMs: deps.checkMs, reconnect,
    mayUse: (service) => {
      const bot = deps.mausbot();
      return bot !== null && mausbotMayUse(bot, service);
    },
  });
  const accountNames = (meeting: Meeting): string => [...new Set(meeting.accounts.map((id) => accounts.label(id)))].join(", ");
  const accountLabels = (): string[] => [...new Set(ASSISTANT_SERVICES.flatMap((service) => accounts.usable(service)).map((account) => accounts.label(account.id)))];

  function setMeeting(id: string, changes: Partial<MeetingRecord>, event?: CalendarEvent): void {
    const base = meetings()[id] ?? (event ? { start: event.start, fingerprint: fingerprint(event), ...(event.seriesId ? { seriesId: event.seriesId } : {}) } : undefined);
    if (!base) return;
    const next: Record<string, unknown> = { ...base, ...changes };
    for (const [key, value] of Object.entries(changes)) if (value === undefined) delete next[key];
    state.patch({ meetings: { ...meetings(), [id]: next as MeetingRecord } });
  }

  function context(): { bot: BotRecord; threadId: string } | null {
    if (deps.hosted || !deps.enabled()) return null;
    const bot = deps.mausbot();
    const threadId = bot ? deps.mainThread(bot) : undefined;
    return bot && threadId ? { bot, threadId } : null;
  }

  function announce(bot: BotRecord, threadId: string, summary: string): void {
    quietly("could not mark MausBot's chat unread", () => deps.store.patchTask(bot.id, threadId, { unread: true }));
    quietly("the notification was not sent", () => deps.notify(buildNotification("assistant", bot, threadId, summary)));
  }

  function post(bot: BotRecord, threadId: string, built: BuiltCard): string | null {
    const posted = createAgentCard({ store: deps.store, bot, threadId, input: { tool: "show_widget", widget: built.card }, serverCard: true });
    if (!posted.ok) {
      console.warn(`assistant: a card was refused: ${posted.error}`);
      return null;
    }
    announce(bot, threadId, built.summary);
    quietly("the card was not noted for the open rule", () => deps.noteCard({ botId: bot.id, threadId }));
    return posted.messageId;
  }

  const say = (threadId: string, text: string): void => { deps.store.appendMessage(threadId, { role: "bot", kind: "text", text }); };

  function reconnect(account: SourceAccount, label: string | undefined, text: string): boolean {
    const here = context();
    if (!here) return false;
    const app = LABEL[account.service];
    say(here.threadId, text);
    deps.store.appendMessage(here.threadId, {
      role: "bot", kind: "connector", text: connectorCardText(app, account.alias),
      connector: {
        slug: account.service, label: app, description: `Reconnect ${app}${label ? ` (${label})` : ""} so MausBot can keep reading it.`, status: "required",
        resumeKey: `mausbot-reconnect-${deps.newId()}`, ...(account.alias ? { alias: account.alias } : {}),
      },
    });
    announce(here.bot, here.threadId, text);
    return true;
  }

  function failCard(bot: BotRecord, threadId: string, item: string, title: string, reason: string): void {
    const requestId = deps.newId();
    const message = deps.store.appendMessage(threadId, {
      role: "bot", kind: "options",
      card: { title, subtitle: `It did not finish: ${clip(reason, REASON_MAX)}. Press Retry to try once more.`, options: [RETRY], requestId, fixedOptions: true },
    });
    const kept = Object.entries(current().retryCards ?? {}).slice(-(MAX_RETRY_CARDS - 1));
    state.patch({ retryCards: { ...Object.fromEntries(kept), [requestId]: { item, threadId, messageId: message.id } } });
    announce(bot, threadId, title);
  }

  function startFlight(item: string): void {
    state.patch({ inFlight: keepNewest([...(current().inFlight ?? []).filter((flight) => flight.item !== item), { item, at: now() }], MAX_IN_FLIGHT) });
  }

  function endFlight(item: string): void {
    const flights = current().inFlight ?? [];
    if (flights.some((flight) => flight.item === item)) state.patch({ inFlight: flights.filter((flight) => flight.item !== item) });
  }

  function keepThread(threadId: string | undefined): void {
    if (threadId) state.patch({ workThreads: keepNewest([...(current().workThreads ?? []), { threadId, at: now() }], MAX_WORK_THREADS) });
  }

  const budget = () => turnsLeft({ now: now(), timeZone: deps.timeZone(), turnDay: current().turnDay, dayTurns: current().dayTurns });

  function takeTurn(): string | null {
    const { day, left } = budget();
    if (left <= 0) return null;
    state.patch({ turnDay: day, dayTurns: DAILY_TURN_CAP - left + 1 });
    return day;
  }

  function refundTurn(day: string | undefined): void {
    const { turnDay, dayTurns } = current();
    if (day !== undefined && turnDay === day && dayTurns) state.patch({ dayTurns: dayTurns - 1 });
  }

  function enqueue(job: Job): void {
    if (queue.some((queued) => queued.item === job.item)) return;
    startFlight(job.item);
    queue.push(job);
  }

  function markFailed(item: string): void {
    const kind = kindOf(item);
    if (kind === "prep" || kind === "repeat") setMeeting(subjectOf(item), { failedAt: now(), prepStartedAt: undefined });
    else if (kind === "update") setMeeting(subjectOf(item), { updateStartedAt: undefined, updateFailedAt: now() });
  }

  function reopen(item: string): void {
    const kind = kindOf(item);
    const clears = RETRY_CLEARS[kind];
    if (clears) setMeeting(subjectOf(item), Object.fromEntries(clears.map((key) => [key, undefined])) as Partial<MeetingRecord>);
    else if (kind === "today" && todayRefresh) todayRefresh.failed = false;
    else if (kind === "triage") {
      const { oldest, emails } = triageOf(item);
      const all = current().accounts ?? {};
      const next = { ...all };
      for (const account of new Set(emails.map((email) => email.account))) {
        const record = all[account];
        if (!record) continue;
        const again = new Set(emails.filter((email) => email.account === account).map((email) => email.id));
        next[account] = { ...record, judged: (record.judged ?? []).filter((id) => !again.has(id)), ...(Number.isFinite(oldest) ? { emailCursor: Math.min(record.emailCursor ?? oldest, oldest) } : {}) };
      }
      state.patch({ accounts: next, lastTriageAt: undefined });
    }
  }

  function abandon(job: Job, turn?: string): void {
    endFlight(job.item);
    reopen(job.item);
    refundTurn(turn);
  }

  function failed(bot: BotRecord, threadId: string, job: Job, reason: string): void {
    markFailed(job.item);
    failCard(bot, threadId, job.item, FAILED[job.kind](titleOf(job)), reason);
  }

  function threw(job: Job): void {
    endFlight(job.item);
    if (job.kind === "triage") {
      const uncarded = [...job.batch, ...job.copies].filter((email) => !job.carded.has(emailKey(email)));
      if (uncarded.length) reopen(triageItem(uncarded));
      return;
    }
    if (job.delivered) return;
    const here = context();
    if (!here) return abandon(job, turnOf(job));
    failed(here.bot, here.threadId, job, "something went wrong on my side");
  }

  async function run(bot: BotRecord, title: string, prompt: string): Promise<JobResult> {
    try {
      return await deps.runJob(bot, clip(title, TITLE_MAX), prompt);
    } catch (error) {
      return { ok: false, error: failure(error) };
    }
  }

  /** Security invariant: the AI's thread id is only shape-checked, so Open names a real conversation of a bot inside
   * MausBot's audience, never a hidden job thread or one a Cloud guest opened or drives. */
  function openTarget(bot: BotRecord, threadId: string | undefined): Target | undefined {
    const owner = threadId ? deps.threadOf(threadId) : null;
    if (!threadId || !owner || owner.cloudGuest || !audienceWithin(bot.visibility, owner.bot.visibility)) return undefined;
    const task = deps.store.taskByThread(owner.bot.id, threadId);
    return task && !isAssistantJobThread(task.routineRunId) ? { botId: owner.bot.id, threadId } : undefined;
  }

  function remind(bot: BotRecord, threadId: string, event: Meeting, at: number): void {
    setMeeting(event.id, { remindedAt: at }, event);
    remember(cardEvents, event.id, event);
    post(bot, threadId, reminderCard({ event, line: sinceLastTime.get(event.id), timeZone: deps.timeZone(), now: at, accounts: accountNames(event) }));
  }

  function meetingsDue(bot: BotRecord, threadId: string, remindersOnly: boolean): void {
    const at = now();
    for (const job of planMeetings({ now: at, events, meetings: meetings(), checkMs: deps.checkMs })) {
      if (job.kind === "remind") {
        remind(bot, threadId, job.event, at);
      } else if (remindersOnly) {
        continue;
      } else if (job.kind === "cancelled") {
        setMeeting(job.eventId, { cancelledAt: at });
        const allDay = events.find((event) => event.id === job.eventId)?.allDay ?? false;
        post(bot, threadId, cancelledCard({ title: job.title, start: job.start, allDay, timeZone: deps.timeZone(), now: at }));
      } else if (job.kind === "update") {
        const previous = meetings()[job.event.id]!;
        const turn = takeTurn();
        if (!turn) {
          setMeeting(job.event.id, { start: job.event.start, fingerprint: fingerprint(job.event) });
          continue;
        }
        setMeeting(job.event.id, { updateStartedAt: at });
        enqueue({ kind: "update", item: `update:${job.event.id}`, event: job.event, previous, turn });
      } else if (job.kind === "repeat") {
        setMeeting(job.event.id, { prepStartedAt: at, repeat: true }, job.event);
        enqueue({ kind: "repeat", item: `repeat:${job.event.id}`, event: job.event, previousStart: job.previousStart });
      } else {
        const turn = takeTurn();
        if (!turn) continue;
        setMeeting(job.event.id, { prepStartedAt: at }, job.event);
        enqueue({ kind: "prep", item: `prep:${job.event.id}`, event: job.event, short: job.short, turn });
      }
    }
  }

  function emailDue(answered: readonly MailRead[], at: number): void {
    const before = current();
    const all = before.accounts ?? {};
    const reads = answered.filter(({ account }) => all[account]);
    const judged = new Set(reads.flatMap(({ account }) => (all[account]?.judged ?? []).map((id) => emailKey({ account, id }))));
    const plan = planMail({ now: at, emails: reads.flatMap((read) => read.mail), judged, lastTriageAt: before.lastTriageAt, spacingMs: deps.checkMs });
    const next = { ...all };
    for (const { account, cursorAtRead } of reads) {
      const record = all[account]!;
      const own = (list: readonly EmailHeader[]) => list.filter((email) => email.account === account);
      const pending = own(plan.pending);
      const read = Math.max(0, pending.length ? Math.min(...pending.map((email) => email.at)) : at - CURSOR_OVERLAP_MS);
      const seen = [...own(plan.quiet), ...own(plan.batch), ...own(plan.copies)].map((email) => email.id);
      const emailCursor = record.emailCursor !== cursorAtRead ? Math.min(read, record.emailCursor ?? read) : read;
      next[account] = { ...record, judged: keepNewest([...(record.judged ?? []), ...seen], MAX_JUDGED), emailCursor };
    }
    state.patch({ accounts: next, ...(plan.batch.length ? { lastTriageAt: at } : {}) });
    if (plan.batch.length) enqueue({ kind: "triage", item: triageItem([...plan.batch, ...plan.copies]), batch: plan.batch, copies: plan.copies, carded: new Set() });
  }

  function meetingToday(): string[] {
    const zone = deps.timeZone();
    const day = localDate(now(), zone);
    return [...new Set(events.filter((event) => qualifies(event) && localDate(event.start, zone) === day)
      .flatMap((event) => event.attendees.filter((attendee) => !attendee.self).map((attendee) => (attendee.name ? `${attendee.name} <${attendee.email}>` : attendee.email))))];
  }

  async function prep(bot: BotRecord, threadId: string, job: Extract<Job, { kind: "prep" }>, tools: TurnTools): Promise<void> {
    const zone = deps.timeZone();
    const result = await run(bot, `Prep: ${job.event.title}`, prepPrompt({ event: job.event, short: job.short, timeZone: zone, now: now(), accounts: accountLabels(), ...tools }));
    keepThread(result.threadId);
    if (!context()) return abandon(job, job.turn);
    endFlight(job.item);
    const reply = result.ok ? prepReply(result.reply) : null;
    if (!reply) return failed(bot, threadId, job, result.ok ? "the answer could not be read" : result.error);
    const related = openTarget(bot, reply.relatedThreadId);
    remember(cardEvents, job.event.id, job.event);
    if (post(bot, threadId, prepCard({ event: job.event, brief: reply.brief, ...(related ? { related } : {}), timeZone: zone, now: now(), accounts: accountNames(job.event) }))) job.delivered = true;
    setMeeting(job.event.id, { preppedAt: now() });
    if (reply.noWebSearch && !current().notices?.noWebSearch) {
      say(threadId, NO_WEB_SEARCH);
      state.patch({ notices: { ...current().notices, noWebSearch: true } });
    }
  }

  async function repeat(bot: BotRecord, threadId: string, job: Extract<Job, { kind: "repeat" }>, tools: TurnTools): Promise<void> {
    const others = job.event.attendees.filter((attendee) => !attendee.self).map((attendee) => attendee.email);
    let wrote = false;
    for (const account of accounts.usable("gmail")) {
      wrote = await deps.sources.mailFrom(account, others, job.previousStart).catch((error: unknown) => {
        console.warn(`assistant: could not look for new mail from a recurring meeting's people: ${failure(error)}`);
        return false;
      });
      if (wrote) break;
    }
    if (!context()) return abandon(job);
    const turn = wrote ? takeTurn() : null;
    if (!turn) {
      endFlight(job.item);
      setMeeting(job.event.id, { preppedAt: now() });
      return;
    }
    job.turn = turn;
    const result = await run(bot, `Since last time: ${job.event.title}`, repeatPrompt({ event: job.event, previousStart: job.previousStart, timeZone: deps.timeZone(), now: now(), ...tools }));
    keepThread(result.threadId);
    if (!context()) return abandon(job, turn);
    endFlight(job.item);
    const line = result.ok ? lineReply(result.reply, "line") : null;
    if (line === null) return failed(bot, threadId, job, result.ok ? "the answer could not be read" : result.error);
    if (line) remember(sinceLastTime, job.event.id, line);
    job.delivered = true;
    setMeeting(job.event.id, { preppedAt: now() });
  }

  async function update(bot: BotRecord, threadId: string, job: Extract<Job, { kind: "update" }>): Promise<void> {
    const zone = deps.timeZone();
    const result = await run(bot, `Update: ${job.event.title}`, updatePrompt({ event: job.event, previous: job.previous, timeZone: zone, now: now() }));
    keepThread(result.threadId);
    if (!context()) return abandon(job, job.turn);
    endFlight(job.item);
    const text = result.ok ? lineReply(result.reply, "update") : null;
    if (!text) return failed(bot, threadId, job, result.ok ? "the answer could not be read" : result.error);
    remember(cardEvents, job.event.id, job.event);
    if (post(bot, threadId, updateCard({ event: job.event, text, timeZone: zone, now: now(), accounts: accountNames(job.event) }))) job.delivered = true;
    setMeeting(job.event.id, { start: job.event.start, fingerprint: fingerprint(job.event), updateStartedAt: undefined });
  }

  async function triage(bot: BotRecord, threadId: string, job: Extract<Job, { kind: "triage" }>): Promise<void> {
    const result = await run(bot, "Email check", triagePrompt({ emails: job.batch, meetingToday: meetingToday(), label: accounts.label }));
    keepThread(result.threadId);
    if (!context()) return abandon(job);
    endFlight(job.item);
    const picks = result.ok ? triageReply(result.reply, new Set(job.batch.map((email) => email.id))) : null;
    if (!picks) return failed(bot, threadId, job, result.ok ? "the answer could not be read" : result.error);
    for (const pick of picks) {
      for (const email of job.batch.filter((candidate) => candidate.id === pick.id)) {
        if (!post(bot, threadId, emailCard({ email, why: pick.why, action: pick.action, account: accounts.label(email.account), address: accounts.address(email.account) }))) continue;
        const copies = email.messageIdHeader === undefined ? [] : job.copies.filter((copy) => copy.messageIdHeader === email.messageIdHeader);
        for (const carded of [email, ...copies]) job.carded.add(emailKey(carded));
        flagged = keepNewest([...flagged, email], MAX_REMEMBERED);
        remember(cardEmails, emailKey(email), email);
      }
    }
  }

  const started = (event: CalendarEvent): boolean => (events.find((candidate) => candidate.id === event.id)?.start ?? event.start) <= now();

  async function perform(job: Job): Promise<void> {
    const here = context();
    if (!here || (job.kind !== "triage" && started(job.event))) return abandon(job, turnOf(job));
    const { bot, threadId } = here;
    const tools = deps.capabilities(bot, threadId);
    if (!tools.mailTools && !current().notices?.noConnectorTools) {
      say(threadId, NO_CONNECTOR_TOOLS);
      state.patch({ notices: { ...current().notices, noConnectorTools: true } });
    }
    const turnTools = { searchTools: tools.agentsTools, mailTools: tools.mailTools };
    if (job.kind === "prep") await prep(bot, threadId, job, turnTools);
    else if (job.kind === "repeat") await repeat(bot, threadId, job, turnTools);
    else if (job.kind === "update") await update(bot, threadId, job);
    else await triage(bot, threadId, job);
  }

  function work(): Promise<void> {
    working ??= (async () => {
      while (queue.length) {
        const job = queue.shift()!;
        try {
          await perform(job);
        } catch (error) {
          console.warn(`assistant: ${job.kind} failed: ${failure(error)}`);
          quietly(`a failed ${job.kind} was not settled`, () => threw(job));
        }
      }
    })().finally(() => {
      working = undefined;
      if (queue.length) void work();
    });
    return working;
  }

  function sweep(bot: BotRecord, at: number): void {
    const threads = current().workThreads ?? [];
    const mine = threads.filter((entry) => isAssistantJobThread(deps.store.taskByThread(bot.id, entry.threadId)?.routineRunId));
    const old = mine.filter((entry) => at - entry.at >= WORK_THREAD_TTL_MS && !deps.threadBusy(bot.id, entry.threadId));
    if (old.length) {
      try {
        deps.store.deleteTasks(bot.id, old.map((entry) => entry.threadId));
      } catch (error) {
        console.warn(`assistant: old work threads were not deleted: ${failure(error)}`);
        return;
      }
    }
    const gone = new Set(old.map((entry) => entry.threadId));
    const keep = mine.filter((entry) => !gone.has(entry.threadId));
    if (keep.length !== threads.length) state.patch({ workThreads: keep });
  }

  function statusOf(event: CalendarEvent, at: number, zone: string | undefined): string {
    const record = meetings()[event.id];
    if (record?.repeat && record.preppedAt !== undefined) return "Repeats: reminder with notes";
    if (record?.preppedAt !== undefined) return "Prep ready";
    if (record?.failedAt !== undefined) return "Prep did not finish";
    if (record?.prepStartedAt !== undefined) return "Preparing";
    if (event.start - at > PREP_LEAD_MS) return `Prep at ${clockTime(event.start - PREP_LEAD_MS, zone)}`;
    return "Reminder only";
  }

  function todayMeetings(day: string, at: number, zone: string | undefined): TodayMeeting[] {
    return events
      .filter((event) => qualifies(event) && localDate(event.start, zone) === day && event.end > at)
      .sort((a, b) => a.start - b.start)
      .map((event) => ({ allDay: event.allDay, title: event.title, start: event.start, end: event.end, status: statusOf(event, at, zone), ...(event.joinUrl ? { joinUrl: event.joinUrl } : {}) }));
  }

  function calendarStatus(): "checking" | "unreadable" | "read" {
    const reads = accounts.usable("googlecalendar").map((account) => accounts.readState(account.id));
    return reads.includes(undefined) ? "checking" : reads.includes("ok") ? "read" : "unreadable";
  }

  function todayRetry(bot: BotRecord, threadId: string, day: string, reason: string): void {
    if (accounts.usable("googlecalendar").some((account) => !current().accounts?.[account.id]?.reconnectShown)) failCard(bot, threadId, `today:${day}`, TODAY_FAILED, reason);
  }

  function today(bot: BotRecord, threadId: string): void {
    todayPending = false;
    const at = now();
    const zone = deps.timeZone();
    const day = todayDue({ now: at, timeZone: zone, lastTodayDate: current().lastTodayDate });
    if (!day) return;
    const calendar = accounts.usable("googlecalendar").length > 0;
    if (!calendar && !accounts.usable("gmail").length) {
      todayPending = !accounts.listed();
      return;
    }
    const status = calendar ? calendarStatus() : "read";
    const shown: TodayMeetings = status === "read" ? todayMeetings(day, at, zone) : status;
    let team: TodayPost["team"];
    try {
      team = deps.team(at - 24 * HOUR) ?? undefined;
    } catch (error) {
      console.warn(`assistant: the team line was left out of Today: ${failure(error)}`);
    }
    state.patch({ lastTodayDate: day });
    const emails = flagged.map((email) => ({ from: email.from, subject: email.subject }));
    flagged = [];
    const messageId = post(bot, threadId, todayCard({ now: at, timeZone: zone, meetings: shown, emails, ...(team ? { team } : {}) }));
    if (!messageId) return;
    const posted: TodayPost = { messageId, threadId, day, emails, ...(team ? { team } : {}) };
    if (typeof shown !== "string") {
      if (calendar && at - (calendarReadAt ?? at) > deps.checkMs) todayRefresh = { ...posted, key: meetingsKey(shown) };
      return;
    }
    todayRefresh = posted;
    if (shown === "unreadable") {
      posted.failed = true;
      todayRetry(bot, threadId, day, CALENDAR_UNREAD);
    }
  }

  function editToday(bot: BotRecord, posted: TodayPost, meetings: TodayMeetings): void {
    const widget = todayCard({ now: now(), timeZone: deps.timeZone(), meetings, emails: posted.emails, ...(posted.team ? { team: posted.team } : {}) }).card;
    const updated = createAgentCard({ store: deps.store, bot, threadId: posted.threadId, input: { tool: "update_widget", widget_id: posted.messageId, widget } });
    if (!updated.ok) console.warn(`assistant: Today was not updated: ${updated.error}`);
  }

  function refreshToday(bot: BotRecord): void {
    const posted = todayRefresh;
    todayRefresh = undefined;
    const at = now();
    const zone = deps.timeZone();
    if (!posted || localDate(at, zone) !== posted.day) return;
    const shown = todayMeetings(posted.day, at, zone);
    if (meetingsKey(shown) !== posted.key) editToday(bot, posted, shown);
  }

  function todayUnread(bot: BotRecord, reason: string): void {
    const posted = todayRefresh;
    if (!posted || posted.key !== undefined || posted.failed) return;
    posted.failed = true;
    editToday(bot, posted, "unreadable");
    todayRetry(bot, posted.threadId, posted.day, reason);
  }

  function recover(bot: BotRecord, threadId: string): void {
    const flights = current().inFlight ?? [];
    if (!flights.length) return;
    state.patch({ inFlight: [] });
    for (const flight of flights) quietly(`a cut-short ${kindOf(flight.item)} was not marked failed`, () => markFailed(flight.item));
    for (const flight of flights) {
      quietly(`a cut-short ${kindOf(flight.item)} card was not posted`, () => failCard(bot, threadId, flight.item, CUT_SHORT[kindOf(flight.item)] ?? "Something I was preparing was cut short", "the app closed before it finished"));
    }
  }

  async function readCalendars(at: number): Promise<boolean> {
    const usable = accounts.usable("googlecalendar");
    const fresh = await Promise.all(usable.map((account) => accounts.read(account, () => deps.sources.events(account, at - HOUR, at + LOOKAHEAD_MS), scheduledCheck)));
    const answered = new Set(usable.filter((_account, index) => fresh[index]).map((account) => account.id));
    usable.forEach((account, index) => {
      const read = fresh[index];
      if (read) calendarReads.set(account.id, { at, events: read });
    });
    const kept = new Set([...usable, ...accounts.unreadable("googlecalendar")].map((account) => account.id));
    for (const id of calendarReads.keys()) if (!kept.has(id)) calendarReads.delete(id);
    events = mergeMeetings(eventsToMerge(calendarReads, { now: at, fresh: answered }), accounts.addresses())
      .filter((meeting) => storable(meeting.id) && storable(meeting.seriesId));
    return answered.size > 0;
  }

  async function readMail(at: number): Promise<MailRead[]> {
    const reads = await Promise.all(accounts.usable("gmail").map(async (account): Promise<MailRead | null> => {
      const cursorAtRead = current().accounts?.[account.id]?.emailCursor;
      const since = emailSince({ now: at, emailCursor: cursorAtRead, checkMs: deps.checkMs });
      const mail = await accounts.read(account, () => deps.sources.emails(account, since, EMAIL_FETCH_LIMIT), scheduledCheck);
      return mail && { account: account.id, cursorAtRead, mail: mail.filter((email) => storable(email.id)) };
    }));
    return reads.filter((read): read is MailRead => read !== null);
  }

  async function runCheck(): Promise<void> {
    const here = context();
    missedCheck = !here;
    if (!here) return;
    const { bot, threadId } = here;
    if (!recovered) {
      recovered = true;
      quietly("jobs cut short by a restart were not settled", () => recover(bot, threadId));
    }
    try {
      if (!await accounts.refresh() || !context()) return;
      const at = now();
      const fresh = await readCalendars(at);
      if (!context()) return;
      if (fresh) {
        calendarReadAt = at;
        meetingsDue(bot, threadId, false);
        quietly("Today was not updated", () => refreshToday(bot));
      }
      const mail = await readMail(at);
      if (!context()) return;
      if (mail.length) emailDue(mail, at);
      quietly("old meetings were not forgotten", () => {
        const kept = pruneMeetings(meetings(), at);
        if (Object.keys(kept).length !== Object.keys(meetings()).length) state.patch({ meetings: kept });
      });
      quietly("old work threads were not swept", () => sweep(bot, at));
      if (todayPending) quietly("Today was not posted", () => today(bot, threadId));
      if (!fresh) quietly("Today was not updated", () => todayUnread(bot, accounts.usable("googlecalendar").length ? CALENDAR_UNREAD : CALENDAR_DISCONNECTED));
    } finally {
      void work();
    }
  }

  function check(trigger: "scheduled" | "presence" = "scheduled"): Promise<void> {
    if (deps.hosted) return Promise.resolve();
    if (trigger === "scheduled") scheduledCheck = true;
    checking ??= runCheck()
      .catch((error) => console.warn(`assistant: the check failed: ${failure(error)}`))
      .finally(() => { checking = undefined; scheduledCheck = false; });
    return checking;
  }

  async function idle(): Promise<void> {
    while (checking || working) {
      await checking;
      await working;
    }
  }

  function reminders(): void {
    quietly("the reminder clock failed", () => {
      const here = context();
      if (here && calendarReadAt !== undefined) meetingsDue(here.bot, here.threadId, true);
    });
  }

  function retryable(item: string): "yes" | "no" | "unknown" {
    if (!context()) return "no";
    const kind = kindOf(item);
    const calendars = accounts.usable("googlecalendar").length > 0;
    if (kind === "today") return todayRefresh?.day === subjectOf(item) && calendars ? "yes" : "no";
    if (kind === "triage") {
      const gmail = new Set(accounts.usable("gmail").map((account) => account.id));
      return triageOf(item).emails.some((email) => gmail.has(email.account)) ? "yes" : "no";
    }
    if (!RETRY_CLEARS[kind] || !calendars) return "no";
    if (calendarStatus() === "checking") return "unknown";
    const id = subjectOf(item);
    const event = events.find((candidate) => candidate.id === id);
    const record = meetings()[id];
    if (!event || !record || budget().left <= 0) return "no";
    const reopened: Record<string, unknown> = { ...record };
    for (const key of RETRY_CLEARS[kind]!) delete reopened[key];
    const planned = planMeetings({ now: now(), events: [event], meetings: { ...meetings(), [id]: reopened as MeetingRecord }, checkMs: deps.checkMs });
    return planned.some((job) => (kind === "update" ? job.kind === "update" : job.kind === "prep" || job.kind === "repeat")) ? "yes" : "no";
  }

  function settleCard(threadId: string, row: Message, outcome: Outcome): void {
    const { answeredText: _answeredText, ...card } = row.card!;
    const answered = outcome === "unavailable" ? { answered: "unavailable" } : { answered: "answer", answeredText: outcome === "answered" ? RETRY : "Dismissed" };
    deps.store.patchMessage(threadId, row.id, { card: { ...card, ...answered } });
  }

  /** Security invariant: only the owner or an admin may retry, as with every card MausBot raises; a refused press
   * leaves the card open and records nothing. */
  function answerCard(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown, auth: RequestAuth): RequestOutcome | undefined {
    if (deps.hosted) return undefined;
    try {
      const card = current().retryCards?.[requestId];
      if (!card || card.threadId !== threadId) return undefined;
      const row = deps.store.messagesFor(threadId).find((line: Message) => line.id === card.messageId);
      if (!row?.card) return undefined;
      if (!ownerOrAdmin(auth)) return "unavailable";
      if (card.outcome) return card.outcome;
      const again = behavior === "answer" && message === RETRY;
      const verdict = again ? retryable(card.item) : "no";
      if (verdict === "unknown") return "unavailable";
      const outcome: Outcome = !again ? "rejected" : verdict === "yes" ? "answered" : "unavailable";
      settleCard(threadId, row, outcome);
      state.patch({ retryCards: { ...current().retryCards, [requestId]: { ...card, outcome } } });
      if (outcome === "answered") {
        reopen(card.item);
        void check();
      }
      return outcome;
    } catch (error) {
      console.warn(`assistant: a Retry card was not settled: ${failure(error)}`);
      return "unavailable";
    }
  }

  /** What a press on one of MausBot's cards is about, from the watcher's own records by id: a press carries only an
   * id, and the card's text came from an invite or an email. Null for anything it does not know. */
  function pressRecords(action: { type: string; payload?: unknown }): string | null {
    if (!context()) return null;
    const payload = action.payload && typeof action.payload === "object" ? action.payload as Record<string, unknown> : {};
    if ((action.type === "prep_notes" || action.type === "draft_followup") && typeof payload.eventId === "string") {
      const event = events.find((candidate) => candidate.id === payload.eventId) ?? cardEvents.get(payload.eventId);
      return event ? calendarRecords(event, deps.timeZone(), now()) : null;
    }
    if (action.type === "draft_reply" && typeof payload.messageId === "string") {
      const id = payload.messageId;
      const email = typeof payload.account === "string" ? cardEmails.get(emailKey({ account: payload.account, id })) : [...cardEmails.values()].findLast((one) => one.id === id);
      return email ? replyRecords(email, accounts.label(email.account), current().accounts?.[email.account]?.implied ? undefined : email.account) : null;
    }
    return null;
  }

  function onPresence(event: { source: string; returned: boolean }): void {
    const here = context();
    if (!here) return;
    quietly("Today was not posted", () => today(here.bot, here.threadId));
    if (missedCheck) void Promise.resolve(checking).then(() => check("presence"));
    else if (event.returned || todayRefresh) void check("presence");
  }

  function deleteUnrecordedJobThreads(): void {
    const bot = deps.mausbot();
    if (!bot || working) return;
    const recorded = new Set((current().workThreads ?? []).map((entry) => entry.threadId));
    const leftover = deps.store.tasks(bot.id)
      .filter((task) => isAssistantJobThread(task.routineRunId) && !recorded.has(task.threadId) && !deps.threadBusy(bot.id, task.threadId));
    if (leftover.length) deps.store.deleteTasks(bot.id, leftover.map((task) => task.threadId));
  }

  function start(): void {
    if (deps.hosted || timers.length) return;
    quietly("job threads a restart cut short were not deleted", deleteUnrecordedJobThreads);
    timers.push(every(() => { void check(); }, deps.checkMs), every(reminders, MINUTE));
    void check();
  }

  function stop(): void {
    for (const timer of timers.splice(0)) timer.cancel();
  }

  return { start, stop, check, idle, reminders, onPresence, answerCard, pressRecords, state };
}
