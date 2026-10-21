import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SourceError, type CalendarEvent, type EmailHeader, type SourceAccount, type ThreadMessage } from "../assistant-sources.ts";
import type { BotVisibility } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { disconnectedText, reconnectText } from "./assistant-accounts.ts";
import { fingerprint, meetingKey } from "./assistant-plan.ts";
import { MAX_JUDGED, type AssistantStatePatch, type PendingEmail } from "./assistant-state.ts";
import type { JobResult } from "./assistant-turns.ts";
import { createAssistantWatch, NO_CONNECTOR_TOOLS, NO_WEB_SEARCH, RETRY, type AssistantWatchDeps } from "./assistant-watch.ts";
import type { RoutineRow } from "./brief-recap.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 17, 4, 0, 0); // 09:30 in Kolkata
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member: RequestAuth = { kind: "session", scopes: ["client"], via: "cookie", session: {} as never };
const ME = { email: "me@example.test", self: true, organizer: true };
const JAKE = { email: "jake@pin.example", name: "Jake Price", self: false, organizer: false };
const ADMIN = "admin@example.test";
const G1: SourceAccount = { service: "gmail", id: "g1", active: true };
const G2: SourceAccount = { service: "gmail", id: "g2", active: true };
const C1: SourceAccount = { service: "googlecalendar", id: "c1", active: true };
const C2: SourceAccount = { service: "googlecalendar", id: "c2", active: true };
/** g1 and c1 as an earlier run left them: seen connected, with their address. */
const SEEN: AssistantStatePatch = {
  accounts: { g1: { service: "gmail", address: "me@example.test", connectedSeen: true }, c1: { service: "googlecalendar", address: "me@example.test", connectedSeen: true } },
};
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });

const meeting = (id: string, start: number, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, iCalUID: id, title: `Meeting ${id}`, start, end: start + 30 * MINUTE, allDay: false, status: "confirmed", selfDeclined: false, attendees: [ME, JAKE],
  joinUrl: "https://meet.google.com/abc-defg-hij", calendarId: "me@example.test", ownedCalendar: true, ...more,
});
const mail = (id: string, at: number): EmailHeader => ({ id, account: "g1", threadId: `thread-${id}`, at, from: `${id} <${id}@example.test>`, subject: `Subject ${id}`, preview: `Preview ${id}` });

function defaultReply(title: string, prompt: string): JobResult {
  if (title.startsWith("Prep: ")) return { ok: true, threadId: "", reply: JSON.stringify({ brief: `Brief for ${title.slice(6)}`, relatedThreadId: "scout-main", noWebSearch: false }) };
  if (title === "Email check") {
    const ids = [...prompt.matchAll(/id (\S+) ·/g)].map((match) => match[1]!).filter((id) => id.startsWith("important"));
    return { ok: true, threadId: "", reply: JSON.stringify({ important: ids.map((id) => ({ id, why: `${id} needs a reply.`, action: "Reply today." })) }) };
  }
  if (title.startsWith("Update: ")) return { ok: true, threadId: "", reply: JSON.stringify({ update: "It moved by half an hour." }) };
  if (title.startsWith("Since last time: ")) return { ok: true, threadId: "", reply: JSON.stringify({ line: "Jake asked about pricing." }) };
  return { ok: false, error: `unexpected job ${title}` };
}

type Owner = NonNullable<ReturnType<AssistantWatchDeps["threadOf"]>>;

function gate(): { closed: Promise<void>; open(): void } {
  let open = () => {};
  const closed = new Promise<void>((resolve) => { open = resolve; });
  return { closed, open };
}

function world(options: {
  /** c1's events and g1's mail; other accounts' go in `live.calendars` and `live.inboxes`. */
  events?: CalendarEvent[]; emails?: EmailHeader[]; listed?: SourceAccount[] | null;
  /** The first `live.reply`. */
  reply?: (title: string, prompt: string) => JobResult | Promise<JobResult>; hosted?: boolean; tools?: { agentsTools: boolean; mailTools: boolean };
  notifications?: boolean; routines?: RoutineRow[]; threads?: Record<string, Owner>; visibility?: BotVisibility;
  connectorTools?: BotRecord["connectorTools"];
  /** When Gmail received a message, if not when it was sent: Gmail's `after:` counts arrival. */
  arrivals?: Record<string, number>;
  deps?: Partial<Pick<AssistantWatchDeps, "capabilities" | "routines" | "threadBusy">>;
  /** Today's brief went out before this run, so mail judged now gets a card of its own. */
  briefed?: boolean;
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-assistant-watch-"));
  dirs.push(dataDir);
  let now = NOW;
  let zone = "Asia/Kolkata";
  let enabled = true;
  const live = {
    listed: (options.listed === undefined ? [G1, C1] : options.listed) as SourceAccount[] | null,
    addresses: { g1: "me@example.test", c1: "me@example.test" } as Record<string, string>,
    events: options.events ?? [], emails: options.emails ?? [], arrivals: options.arrivals ?? {},
    calendars: {} as Record<string, CalendarEvent[]>, inboxes: {} as Record<string, EmailHeader[]>, threads: {} as Record<string, ThreadMessage[]>,
    /** Accounts whose every read fails. */
    broken: new Set<string>(),
    calendarFailures: 0, newMailFromAttendees: false,
    reply: options.reply ?? defaultReply,
    refuseAppend: undefined as ((message: Omit<Message, "id" | "at">) => boolean) | undefined,
  };
  const eventsOf = (id: string): CalendarEvent[] => live.calendars[id] ?? (id === "c1" ? live.events : []);
  const emailsOf = (id: string): EmailHeader[] => (live.inboxes[id] ?? (id === "g1" ? live.emails : [])).map((email) => ({ ...email, account: id }));
  const refuse = (account: SourceAccount): void => { if (live.broken.has(account.id)) throw new SourceError(account.service, "token expired", account.id); };
  const messages: Message[] = [];
  const tasks = new Map<string, { routineRunId?: string }>([["m-main", {}], ["scout-main", {}]]);
  const bot = { id: "m", name: "MausBot", threadId: "m-main", builtIn: "mausbot", color: "silver", visibility: options.visibility ?? "admins", notifications: options.notifications ?? true, connectorTools: options.connectorTools } as BotRecord;
  const threads: Record<string, Owner> = options.threads ?? { "scout-main": { bot: { id: "scout", visibility: "everyone" }, cloudGuest: false } };
  let ids = 0;
  const store = {
    appendMessage: (_threadId: string, message: Omit<Message, "id" | "at">) => {
      if (live.refuseAppend?.(message)) throw new Error("messages.jsonl is read-only");
      const full = { id: `msg${messages.length}`, at: now, ...message } as Message;
      messages.push(full);
      return full;
    },
    messagesFor: () => messages,
    patchMessage: (_threadId: string, id: string, patch: Partial<Message>) => {
      const index = messages.findIndex((line) => line.id === id);
      if (index < 0) return null;
      messages[index] = { ...messages[index]!, ...patch } as Message;
      return messages[index]!;
    },
    groupByThread: () => undefined,
    patchTask: vi.fn(() => null),
    deleteTasks: vi.fn((_botId: string, threadIds: string[]) => { for (const id of threadIds) tasks.delete(id); return null; }),
    taskByThread: (_botId: string, threadId: string) => tasks.get(threadId),
    tasks: () => [...tasks].map(([threadId, task]) => ({ threadId, ...task })),
  };
  const sources = {
    accounts: vi.fn(async () => live.listed),
    address: vi.fn(async (account: SourceAccount) => live.addresses[account.id] ?? null),
    events: vi.fn(async (account: SourceAccount, _fromMs: number, _toMs: number) => {
      refuse(account);
      if (live.calendarFailures > 0) { live.calendarFailures -= 1; throw new SourceError("googlecalendar", "token expired", account.id); }
      return eventsOf(account.id);
    }),
    emails: vi.fn(async (account: SourceAccount, since: number, _limit: number) => {
      refuse(account);
      return emailsOf(account.id).filter((email) => (live.arrivals[email.id] ?? email.at) >= since);
    }),
    mailFrom: vi.fn(async (_account: SourceAccount, _addresses: readonly string[], _sinceMs: number) => live.newMailFromAttendees),
    message: vi.fn(async (account: SourceAccount, messageId: string) => { refuse(account); return emailsOf(account.id).find((email) => email.id === messageId) ?? null; }),
    thread: vi.fn(async (account: SourceAccount, threadId: string) => { refuse(account); return live.threads[`${account.id}/${threadId}`] ?? []; }),
  };
  const jobs: Array<{ title: string; prompt: string }> = [];
  let jobThreads = 0;
  const runJob = vi.fn(async (_bot: BotRecord, title: string, prompt: string): Promise<JobResult> => {
    jobs.push({ title, prompt });
    const threadId = `job-${++jobThreads}`;
    tasks.set(threadId, { routineRunId: `mausbot-${threadId}` });
    return { ...(await live.reply(title, prompt)), threadId };
  });
  const notify = vi.fn();
  const noteCard = vi.fn();
  const clocks: Array<() => void> = [];
  const make = () => createAssistantWatch({
    store: store as unknown as AssistantWatchDeps["store"], dataDir, now: () => now, checkMs: 15 * MINUTE, hosted: options.hosted ?? false,
    enabled: () => enabled, mausbot: () => bot, mainThread: () => "m-main", timeZone: () => zone,
    capabilities: () => options.tools ?? { agentsTools: true, mailTools: true }, sources, runJob, notify, noteCard,
    routines: () => options.routines ?? [], threadOf: (threadId) => threads[threadId] ?? null,
    threadBusy: () => false, newId: () => `rq${++ids}`, every: (run) => { clocks.push(run); return { cancel: () => {} }; },
    ...options.deps,
  });
  const watch = make();
  if (options.briefed) watch.state.patch({ lastBriefDate: "2026-10-17" });
  const widgets = () => messages.filter((line) => line.kind === "widget").map((line) => line.widget!.root as unknown as { title: string; caption?: string });
  return {
    watch, make, live, store, sources, jobs, runJob, notify, noteCard, clocks, messages, tasks, dataDir,
    widgets,
    titles: () => widgets().map((card) => card.title),
    retries: () => messages.filter((line) => line.kind === "options" && line.card?.options.includes(RETRY)),
    answerRetry: (row: Message) => watch.answerCard("m-main", row.card!.requestId!, "answer", RETRY, owner),
    briefs: () => messages.filter((line) => line.kind === "widget" && (line.widget!.root as unknown as { title: string }).title === "Daily brief"),
    texts: () => messages.filter((line) => line.kind === "text").map((line) => line.text),
    tick: (ms: number) => { now += ms; }, now: () => now, setZone: (next: string) => { zone = next; }, switchOff: () => { enabled = false; }, switchOn: () => { enabled = true; },
    settle: async () => { await watch.check(); await watch.idle(); },
  };
}

describe("meeting prep", () => {
  it("preps a meeting once it starts within four hours, once, with a card, a notification and a note for the open rule", async () => {
    const w = world({ events: [meeting("a", NOW + 5 * HOUR)] });
    await w.settle();
    expect(w.jobs).toEqual([]);
    w.tick(HOUR + MINUTE);
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a"]);
    expect(w.jobs[0]!.prompt).toContain("[MausBot prep a]");
    expect(w.titles()).toEqual(["Prep: Meeting a"]);
    expect(JSON.stringify(w.widgets()[0])).toContain('"open_thread"');
    expect(w.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "assistant", title: "MausBot", threadId: "m-main" }));
    expect(w.noteCard).toHaveBeenCalledWith({ botId: "m", threadId: "m-main" });
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.jobs).toHaveLength(1);
  });

  it("gives a late booking the shorter brief at once, and leaves alone what does not qualify", async () => {
    const w = world({ events: [meeting("late", NOW + HOUR), meeting("solo", NOW + HOUR, { attendees: [ME] }), meeting("declined", NOW + HOUR, { selfDeclined: true, attendees: [{ ...ME, response: "declined" }, JAKE] }), meeting("holiday", NOW + HOUR, { allDay: true })] });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting late"]);
    expect(w.jobs[0]!.prompt).toContain("keep it short");
  });

  it("does not research a recurring meeting again: a since-last-time line only when the same people wrote, shown in the reminder", async () => {
    const earlier = meeting("w1", NOW - 7 * 24 * HOUR, { seriesId: "weekly" });
    const next = meeting("w2", NOW + 2 * HOUR, { seriesId: "weekly" });
    const seed = { w1: { start: earlier.start, fingerprint: fingerprint(earlier), seriesId: "weekly", preppedAt: earlier.start - HOUR } };
    const quiet = world({ events: [next] });
    quiet.watch.state.patch({ meetings: seed });
    await quiet.settle();
    expect(quiet.jobs).toEqual([]);
    expect(quiet.sources.mailFrom).toHaveBeenCalledWith(G1, ["jake@pin.example"], earlier.start);
    const busy = world({ events: [next] });
    busy.watch.state.patch({ meetings: seed });
    busy.live.newMailFromAttendees = true;
    await busy.settle();
    expect(busy.jobs.map((job) => job.title)).toEqual(["Since last time: Meeting w2"]);
    expect(busy.titles()).toEqual([]);
    busy.tick(2 * HOUR - 10 * MINUTE);
    busy.watch.reminders();
    expect(busy.titles()).toEqual(["Call with Jake Price in 10 minutes"]);
    expect(JSON.stringify(busy.widgets()[0])).toContain("Since last time: Jake asked about pricing.");
  });

  it("marks a repeat as started and prepared, so the next check starts nothing", async () => {
    const earlier = meeting("w1", NOW - 7 * 24 * HOUR, { seriesId: "weekly" });
    const next = meeting("w2", NOW + 2 * HOUR, { seriesId: "weekly" });
    const w = world({ events: [next] });
    w.watch.state.patch({ meetings: { w1: { start: earlier.start, fingerprint: fingerprint(earlier), seriesId: "weekly", preppedAt: earlier.start - HOUR } } });
    await w.settle();
    expect(w.watch.state.get().meetings?.[meetingKey(next)]).toMatchObject({ repeat: true, prepStartedAt: NOW, preppedAt: NOW });
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.sources.mailFrom).toHaveBeenCalledTimes(1);
    expect(w.jobs).toEqual([]);
  });

  it("posts one short update per change after prep, a cancellation without a turn, and nothing once the meeting started", async () => {
    const original = meeting("a", NOW + 3 * HOUR);
    const w = world({ events: [original] });
    await w.settle();
    w.live.events = [{ ...original, start: original.start + 30 * MINUTE, end: original.end + 30 * MINUTE }];
    await w.settle();
    expect(w.watch.state.get().meetings?.a).toMatchObject({ start: original.start + 30 * MINUTE, fingerprint: fingerprint(original) });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a", "Update: Meeting a"]);
    expect(w.titles()).toEqual(["Prep: Meeting a", "Changed: Meeting a"]);
    w.live.events = [{ ...original, status: "cancelled" }];
    await w.settle();
    expect(w.titles().at(-1)).toBe("Cancelled: Meeting a");
    expect(w.jobs).toHaveLength(2);
    w.tick(4 * HOUR);
    w.live.events = [{ ...original, start: original.start + HOUR, end: original.end + HOUR }];
    await w.settle();
    expect(w.jobs).toHaveLength(2);
  });
});

describe("reminders", () => {
  it("reminds about ten minutes before from the minute clock, once, never after the start", async () => {
    const w = world({ events: [meeting("a", NOW + 3 * HOUR), meeting("past", NOW - MINUTE)] });
    await w.settle();
    w.tick(3 * HOUR - 11 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting a"]);
    w.tick(2 * MINUTE);
    w.watch.reminders();
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Call with Jake Price in 9 minutes"]);
  });

  it("gives a meeting moved later no reminder at its old time, and one before its new time", async () => {
    const original = meeting("a", NOW + 3 * HOUR);
    const w = world({ events: [original] });
    await w.settle();
    w.live.events = [{ ...original, start: original.start + HOUR, end: original.end + HOUR }];
    await w.settle();
    w.tick(3 * HOUR - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Changed: Meeting a"]);
    w.tick(HOUR);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Changed: Meeting a", "Call with Jake Price in 9 minutes"]);
  });

  it("reminds again before the new time when a meeting moves later after its reminder, but not for a slip its reminder still covers", async () => {
    const original = meeting("a", NOW + 3 * HOUR);
    const w = world({ events: [original] });
    await w.settle();
    w.tick(3 * HOUR - 9 * MINUTE);
    w.watch.reminders();
    const reminders = () => w.titles().filter((title) => title.startsWith("Call with"));
    expect(reminders()).toEqual(["Call with Jake Price in 9 minutes"]);
    w.live.events = [{ ...original, start: original.start + MINUTE, end: original.end + MINUTE }];
    await w.settle();
    w.watch.reminders();
    expect(reminders()).toHaveLength(1);
    w.live.events = [{ ...original, start: original.start + 30 * MINUTE, end: original.end + 30 * MINUTE }];
    await w.settle();
    w.watch.reminders();
    expect(reminders()).toHaveLength(1);
    w.tick(30 * MINUTE);
    w.watch.reminders();
    w.watch.reminders();
    expect(reminders()).toEqual(["Call with Jake Price in 9 minutes", "Call with Jake Price in 9 minutes"]);
  });
});

describe("email", () => {
  it("judges at most twenty new emails a turn, once per fifteen minutes, and cards only what matters", async () => {
    const recent = Array.from({ length: 25 }, (_, index) => mail(index === 3 ? "important-3" : index === 22 ? "important-22" : `plain-${index}`, NOW - (index + 1) * MINUTE));
    const w = world({ emails: [...recent, mail("ancient", NOW - 30 * HOUR)], arrivals: { ancient: NOW - MINUTE }, briefed: true });
    w.watch.state.patch({ accounts: { g1: { service: "gmail", connectedSeen: true, emailCursor: NOW - 2 * HOUR } } });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Email check"]);
    expect([...w.jobs[0]!.prompt.matchAll(/id (\S+) ·/g)]).toHaveLength(20);
    expect(w.jobs[0]!.prompt).not.toContain("ancient");
    expect(w.titles()).toEqual(["Subject important-3"]);
    await w.settle();
    expect(w.jobs).toHaveLength(1);
    w.tick(15 * MINUTE);
    await w.settle();
    expect([...w.jobs[1]!.prompt.matchAll(/id (\S+) ·/g)].map((match) => match[1])).toEqual(["plain-20", "plain-21", "important-22", "plain-23", "plain-24"]);
    expect(w.titles()).toEqual(["Subject important-3", "Subject important-22"]);
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.jobs).toHaveLength(2);
    expect(w.watch.state.get().accounts?.g1?.judged).toContain("ancient");
  });

  it("never judges the backlog on a first run: it asks only for mail from one check back", async () => {
    const w = world({ emails: [mail("important-old", NOW - 2 * HOUR), mail("important-new", NOW - 5 * MINUTE)], briefed: true });
    await w.settle();
    expect(w.sources.emails).toHaveBeenCalledWith(G1, NOW - 15 * MINUTE, expect.any(Number));
    expect(w.jobs[0]!.prompt).toContain("important-new");
    expect(w.jobs[0]!.prompt).not.toContain("important-old");
    expect(w.titles()).toEqual(["Subject important-new"]);
  });

  it("posts nothing, and notifies nobody, when nothing matters", async () => {
    const w = world({ emails: [mail("plain-1", NOW - MINUTE)] });
    await w.settle();
    expect(w.jobs).toHaveLength(1);
    expect(w.widgets()).toEqual([]);
    expect(w.notify).not.toHaveBeenCalled();
  });
});

describe("every account", () => {
  /** g1 and c1 as me@example.test, plus c2 as admin@example.test holding a copy of the same meeting. */
  const onTwoCalendars = (shared: CalendarEvent, listed = [G1, C1, C2]) => {
    const w = world({ listed, events: [shared] });
    w.live.addresses.c2 = ADMIN;
    w.live.calendars.c2 = [{ ...shared, id: `${shared.id}-on-c2`, calendarId: ADMIN }];
    return w;
  };
  const twoInboxes = (more: Parameters<typeof world>[0] = {}) => {
    const w = world({ listed: [G1, G2, C1], ...more });
    w.live.addresses.g2 = ADMIN;
    return w;
  };
  const ORDERS = [{ order: "c1 listed first", listed: [G1, C1, C2] }, { order: "c2 listed first", listed: [G1, C2, C1] }];
  /** One message in g1 and in g2: Gmail gives each inbox its own id, and both carry the same Message-ID header. */
  const IN_G1 = { ...mail("important-1", NOW - MINUTE), messageIdHeader: "<q3@pin.example>" };
  const IN_G2 = { ...mail("important-1-copy", NOW - 2 * MINUTE), messageIdHeader: "<q3@pin.example>" };

  it("reads every calendar account, and preps a meeting on two of them once, naming both accounts", async () => {
    const w = onTwoCalendars(meeting("a", NOW + 2 * HOUR, { iCalUID: "uid-1" }));
    await w.settle();
    expect(w.sources.events.mock.calls.map(([account]) => account.id)).toEqual(["c1", "c2"]);
    expect(w.jobs.filter((job) => job.title.startsWith("Prep: "))).toHaveLength(1);
    expect(w.jobs[0]!.prompt).toContain("The person's Google accounts: me@example.test, admin@example.test.");
    expect(w.widgets().find((card) => card.title.startsWith("Prep: "))).toMatchObject({ caption: expect.stringContaining("me@example.test, admin@example.test") });
  });

  it("judges new mail from every account in one email check, and cards an important one with its account", async () => {
    const w = twoInboxes({ emails: [mail("important-1", NOW - MINUTE)], briefed: true });
    w.live.inboxes.g2 = [mail("important-2", NOW - 2 * MINUTE)];
    await w.settle();
    expect(w.jobs.filter((job) => job.title === "Email check")).toHaveLength(1);
    expect(w.jobs[0]!.prompt).toContain("account admin@example.test");
    expect(w.widgets().map((card) => card.caption)).toContain("From important-2 <important-2@example.test> · to admin@example.test");
    expect(w.widgets().map((card) => card.caption)).toContain("From important-1 <important-1@example.test> · to me@example.test");
  });

  it("keeps each account's email cursor and judged ids, and Retry on an email check judges those emails again in each account", async () => {
    const w = twoInboxes({ emails: [mail("important-1", NOW - 10 * MINUTE)], reply: () => ({ ok: true, threadId: "", reply: "I looked at your mail." }), briefed: true });
    w.live.inboxes.g2 = [mail("important-2", NOW - 5 * MINUTE)];
    await w.settle();
    expect(w.watch.state.get().accounts).toMatchObject({ g1: { judged: ["important-1"] }, g2: { judged: ["important-2"] } });
    expect(w.answerRetry(w.retries()[0]!)).toBe("answered");
    expect(w.watch.state.get().accounts?.g1?.judged ?? []).toEqual([]);
    expect(w.watch.state.get().accounts?.g2?.judged ?? []).toEqual([]);
    expect(w.watch.state.get().accounts?.g2?.emailCursor).toBeLessThanOrEqual(NOW - 10 * MINUTE);
    w.live.reply = defaultReply;
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.jobs.filter((job) => job.title === "Email check").at(-1)!.prompt).toMatch(/id important-1 .*\n.*id important-2|id important-2 .*\n.*id important-1/);
    expect(w.titles()).toEqual(["Subject important-2", "Subject important-1"]);
  });

  it("answers a Draft a reply press with that email's own account, and never another's", async () => {
    const w = twoInboxes({ emails: [mail("important-1", NOW - MINUTE)] });
    w.live.inboxes.g2 = [mail("important-2", NOW - 2 * MINUTE)];
    await w.settle();
    expect(w.watch.pressRecords({ type: "draft_reply", payload: { messageId: "important-2", account: "g2" } }))
      .toContain("Draft the reply from admin@example.test (connected account g2)");
    expect(w.watch.pressRecords({ type: "draft_reply", payload: { messageId: "important-1", account: "g1" } }))
      .toContain("Draft the reply from me@example.test (connected account g1)");
    expect(w.watch.pressRecords({ type: "draft_reply", payload: { messageId: "important-2", account: "g1" } })).toBeNull();
  });

  it("counts one prep against the daily cap for a meeting on several accounts", async () => {
    const w = onTwoCalendars(meeting("a", NOW + 2 * HOUR, { iCalUID: "uid-1" }));
    await w.settle();
    expect(w.watch.state.get().dayTurns).toBe(1);
  });

  it("keeps the key of a meeting with no iCalUID when a restart can read only one of its accounts, so it is not prepped again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = onTwoCalendars(meeting("a", NOW + 2 * HOUR, { iCalUID: undefined }));
    await w.settle();
    w.live.broken.add("c1");
    const restarted = w.make();
    await restarted.check();
    await restarted.idle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a"]);
    expect(restarted.state.get().dayTurns).toBe(1);
  });

  it("keeps an account's last events while it cannot be read, so its meeting still gets its reminder", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ listed: [G1, C1, C2] });
    w.live.addresses.c2 = ADMIN;
    w.live.calendars.c2 = [meeting("b", NOW + 3 * HOUR, { calendarId: ADMIN })];
    await w.settle();
    w.live.broken.add("c2");
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.watch.state.get().accounts?.c2?.failures).toBe(1);
    w.tick(3 * HOUR - 15 * MINUTE - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting b", "Call with Jake Price in 9 minutes"]);
    expect(w.widgets().at(-1)?.caption).toContain("admin@example.test");
  });

  it.each(ORDERS)("takes a moved meeting's time from the account read this time, not another account's kept copy ($order)", async ({ listed }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const shared = meeting("a", NOW + 3 * HOUR, { iCalUID: "uid-1" });
    const w = onTwoCalendars(shared, listed);
    await w.settle();
    w.live.broken.add("c1");
    w.live.calendars.c2 = [{ ...w.live.calendars.c2![0]!, start: shared.start + 30 * MINUTE, end: shared.end + 30 * MINUTE }];
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Changed: Meeting a"]);
    w.tick(3 * HOUR - 15 * MINUTE - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toHaveLength(2);
    w.tick(30 * MINUTE);
    w.watch.reminders();
    expect(w.titles().at(-1)).toBe("Call with Jake Price in 9 minutes");
  });

  it.each(ORDERS)("keeps a meeting cancelled when the account read this time cancelled it, whatever another account's kept copy says ($order)", async ({ listed }) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = onTwoCalendars(meeting("a", NOW + 3 * HOUR, { iCalUID: "uid-1" }), listed);
    await w.settle();
    w.live.broken.add("c1");
    w.live.calendars.c2 = [{ ...w.live.calendars.c2![0]!, status: "cancelled" }];
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Cancelled: Meeting a"]);
    w.tick(3 * HOUR - 15 * MINUTE - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toHaveLength(2);
  });

  it("keeps the meetings of an account that is listed but no longer active, so they still get their reminder", async () => {
    const w = world({ listed: [G1, C1, C2] });
    w.live.addresses.c2 = ADMIN;
    w.live.calendars.c2 = [meeting("b", NOW + 3 * HOUR, { calendarId: ADMIN })];
    await w.settle();
    w.live.listed = [G1, C1, { ...C2, active: false }];
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.sources.events.mock.calls.map(([account]) => account.id)).toEqual(["c1", "c2", "c1"]);
    expect(w.texts()).toEqual([disconnectedText("googlecalendar", ADMIN)]);
    w.tick(3 * HOUR - 15 * MINUTE - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting b", "Call with Jake Price in 9 minutes"]);
  });

  it("drops an account's meetings once it is removed in Settings and forgotten", async () => {
    const w = world({ listed: [G1, C1, C2] });
    w.live.addresses.c2 = ADMIN;
    w.live.calendars.c2 = [meeting("b", NOW + 3 * HOUR, { calendarId: ADMIN })];
    await w.settle();
    w.live.listed = [G1, C1];
    for (let check = 0; check < 2; check += 1) {
      w.tick(15 * MINUTE);
      await w.settle();
    }
    expect(w.watch.state.get().accounts?.c2).toBeUndefined();
    w.tick(3 * HOUR - 30 * MINUTE - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting b"]);
  });

  it("posts the Reconnect card at the next failed read when the switch went off just before the card", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ listed: [G1, C1, C2] });
    w.live.addresses.c2 = ADMIN;
    w.live.broken.add("c2");
    const read = w.sources.events.getMockImplementation()!;
    let c2Reads = 0;
    w.sources.events.mockImplementation(async (account, fromMs, toMs) => {
      if (account.id === "c2" && ++c2Reads === 3) w.switchOff();
      return read(account, fromMs, toMs);
    });
    for (let check = 0; check < 3; check += 1) {
      await w.settle();
      w.tick(15 * MINUTE);
    }
    expect(w.texts()).toEqual([]);
    expect(w.watch.state.get().accounts?.c2).toMatchObject({ failures: 3 });
    expect(w.watch.state.get().accounts?.c2?.reconnectShown).toBeFalsy();
    w.switchOn();
    await w.settle();
    expect(w.texts()).toEqual([reconnectText("googlecalendar", ADMIN)]);
    expect(w.watch.state.get().accounts?.c2).toMatchObject({ failures: 4, reconnectShown: true });
  });

  it("judges one email in two inboxes in one item, cards it once, and marks both copies judged", async () => {
    let flights: string[] = [];
    const w = twoInboxes({ emails: [IN_G1], briefed: true, reply: (title, prompt) => {
      flights = (w.watch.state.get().inFlight ?? []).map((flight) => flight.item);
      return defaultReply(title, prompt);
    } });
    w.live.inboxes.g2 = [IN_G2];
    await w.settle();
    expect(flights).toEqual([`triage:${NOW - 2 * MINUTE}:g1/important-1,g2/important-1-copy`]);
    expect(w.jobs.map((job) => job.title)).toEqual(["Email check"]);
    expect(w.jobs[0]!.prompt).not.toContain("important-1-copy");
    expect(w.titles()).toEqual(["Subject important-1"]);
    expect(w.watch.state.get().accounts).toMatchObject({ g1: { judged: ["important-1"] }, g2: { judged: ["important-1-copy"] } });
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.jobs).toHaveLength(1);
  });

  it("un-judges both copies of an email in two inboxes on Retry, and cards it once", async () => {
    const w = twoInboxes({ emails: [IN_G1], reply: () => ({ ok: true, threadId: "", reply: "I looked at your mail." }), briefed: true });
    w.live.inboxes.g2 = [IN_G2];
    await w.settle();
    expect(w.answerRetry(w.retries()[0]!)).toBe("answered");
    expect(w.watch.state.get().accounts?.g1?.judged ?? []).toEqual([]);
    expect(w.watch.state.get().accounts?.g2?.judged ?? []).toEqual([]);
    w.live.reply = defaultReply;
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.titles()).toEqual(["Subject important-1"]);
    expect(w.watch.state.get().accounts).toMatchObject({ g1: { judged: ["important-1"] }, g2: { judged: ["important-1-copy"] } });
  });

  it("moves the email cursor of an account it read, and leaves a failed account's where it was", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = twoInboxes();
    const cursor = NOW - 2 * HOUR;
    w.watch.state.patch({ accounts: { g1: { service: "gmail", connectedSeen: true, emailCursor: cursor }, g2: { service: "gmail", connectedSeen: true, emailCursor: cursor } } });
    w.live.broken.add("g2");
    await w.settle();
    expect(w.sources.emails.mock.calls.map(([account, since]) => [account.id, since])).toEqual([["g1", cursor], ["g2", cursor]]);
    expect(w.watch.state.get().accounts?.g1?.emailCursor).toBe(NOW - 5 * MINUTE);
    expect(w.watch.state.get().accounts?.g2).toMatchObject({ emailCursor: cursor, failures: 1 });
  });

  it("still reads the other accounts when one fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ listed: [G1, C1, C2], events: [meeting("a", NOW + 2 * HOUR)] });
    w.live.addresses.c2 = ADMIN;
    w.live.broken.add("c2");
    await w.settle();
    expect(w.titles()).toContain("Prep: Meeting a");
    expect(w.sources.emails).toHaveBeenCalled();
    expect(w.watch.state.get().accounts?.c2?.failures).toBe(1);
  });

  it("posts a Reconnect line and card naming the account, with its alias, after three failed reads of it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ listed: [G1, C1, { ...C2, alias: "work" }] });
    w.live.addresses.c2 = ADMIN;
    w.live.broken.add("c2");
    for (let check = 0; check < 4; check += 1) {
      await w.settle();
      w.tick(15 * MINUTE);
    }
    expect(w.texts()).toEqual([reconnectText("googlecalendar", ADMIN)]);
    expect(w.messages.filter((line) => line.kind === "connector").map((line) => line.connector)).toEqual([expect.objectContaining({
      slug: "googlecalendar", label: "Google Calendar", description: "Reconnect Google Calendar (admin@example.test) so MausBot can keep reading it.", status: "required", addAccount: true, alias: "work",
    })]);
    expect(w.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "assistant", body: reconnectText("googlecalendar", ADMIN) }));
  });

  it("reads nothing for an account removed in Settings", async () => {
    const w = world({ listed: [G1, C1, C2] });
    w.live.addresses.c2 = ADMIN;
    await w.settle();
    w.live.listed = [G1, C1];
    w.sources.events.mockClear();
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.sources.events.mock.calls.map(([account]) => account.id)).toEqual(["c1"]);
    expect(w.texts().some((text) => text?.startsWith("Reconnect"))).toBe(false);
  });
});

describe("the daily cap", () => {
  it("runs at most twelve prep turns a local day, then reminders only, and starts again the next local day", async () => {
    const w = world({ events: Array.from({ length: 13 }, (_, index) => meeting(`m${index}`, NOW + 3 * HOUR + index * MINUTE)) });
    await w.settle();
    expect(w.jobs).toHaveLength(12);
    expect(w.watch.state.get()).toMatchObject({ turnDay: "2026-10-17", dayTurns: 12 });
    expect(w.watch.state.get().meetings?.m12).toBeUndefined();
    w.setZone("America/Los_Angeles");
    w.live.events = [...w.live.events, meeting("west", NOW + 2 * HOUR)];
    await w.settle();
    expect(w.jobs).toHaveLength(12);
    w.setZone("Asia/Kolkata");
    w.tick(Date.UTC(2026, 9, 17, 19, 0) - NOW);
    w.live.events = [meeting("tomorrow", w.now() + HOUR)];
    await w.settle();
    expect(w.jobs.at(-1)?.title).toBe("Prep: Meeting tomorrow");
  });
});

describe("a prep that would start late", () => {
  it("drops a queued prep whose meeting started before its turn began, gives the turn back, and posts no error", async () => {
    const hold = gate();
    const w = world({
      events: [meeting("first", NOW + 20 * MINUTE), meeting("second", NOW + 30 * MINUTE)],
      reply: async (title, prompt) => { if (title === "Prep: Meeting first") await hold.closed; return defaultReply(title, prompt); },
    });
    void w.watch.check();
    await expect.poll(() => w.jobs.length).toBe(1);
    expect(w.watch.state.get().dayTurns).toBe(2);
    w.tick(31 * MINUTE);
    hold.open();
    await w.watch.idle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting first"]);
    expect(w.titles()).toEqual(["Prep: Meeting first"]);
    expect(w.retries()).toEqual([]);
    expect(w.watch.state.get().dayTurns).toBe(1);
    expect(w.watch.state.get().inFlight).toEqual([]);
    expect(w.watch.state.get().meetings?.second).not.toHaveProperty("prepStartedAt");
    await w.settle();
    expect(w.jobs).toHaveLength(1);
  });
});

describe("past the daily cap", () => {
  it("only reminds once the day's turns are used up", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)] });
    w.watch.state.patch({ turnDay: "2026-10-17", dayTurns: 12 });
    await w.settle();
    expect(w.jobs).toEqual([]);
    expect(w.watch.state.get().meetings?.a).toBeUndefined();
    w.tick(2 * HOUR - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Call with Jake Price in 9 minutes"]);
  });
});

describe("catch-up", () => {
  it("checks at once on start and on a return, and not on an ordinary presence", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)] });
    w.watch.start();
    await w.watch.idle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a"]);
    expect(w.sources.events).toHaveBeenCalledTimes(1);
    w.watch.onPresence({ source: "desktop", returned: false });
    await w.watch.idle();
    expect(w.sources.events).toHaveBeenCalledTimes(1);
    w.watch.onPresence({ source: "desktop", returned: true });
    await w.watch.idle();
    expect(w.sources.events).toHaveBeenCalledTimes(2);
    w.watch.stop();
  });

  it("reads at once on the first presence after a check it was held back from, so an intro posted at that presence is not left waiting", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)] });
    w.switchOff();
    w.watch.start();
    w.switchOn();
    w.watch.onPresence({ source: "desktop", returned: false });
    await expect.poll(() => w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a"]);
    await w.watch.idle();
    expect(w.sources.events).toHaveBeenCalledTimes(1);
    w.watch.onPresence({ source: "desktop", returned: false });
    await w.watch.idle();
    expect(w.sources.events).toHaveBeenCalledTimes(1);
    w.watch.stop();
  });
});

describe("the daily brief", () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => { w = world({ emails: [mail("important-1", NOW - MINUTE)] }); });
  const dismiss = { type: "dismiss_email", payload: { messageId: "important-1", account: "g1" } };

  it("posts the brief at the first presence of the day, with one notification and a note for the open rule", async () => {
    await w.settle(); w.watch.onPresence({ source: "desktop", returned: false });
    expect(w.titles().filter((title) => title === "Daily brief")).toHaveLength(1);
    expect(w.notify).toHaveBeenCalledTimes(1); expect(w.noteCard).toHaveBeenCalledTimes(1);
  });

  it("holds mail judged before the day's brief, and cards mail judged after the brief's first email check", async () => {
    // important-1 arrives overnight: judged before any presence
    await w.settle();
    expect(w.titles()).not.toContain("Subject important-1");
    w.watch.onPresence({ source: "desktop", returned: false }); await w.settle();
    expect(JSON.stringify(w.widgets().find((card) => card.title === "Daily brief"))).toContain("Subject important-1");
    w.live.emails.push(mail("important-2", w.now())); w.tick(15 * MINUTE); await w.settle();
    expect(w.titles()).toContain("Subject important-2");
  });

  it("closes the brief's mail window when its first email check fails, so later mail gets a card of its own", async () => {
    let fail = true;
    const day = world({ emails: [mail("important-1", NOW - MINUTE)], reply: (title, prompt) => (fail ? { ok: false, error: "engine down" } : defaultReply(title, prompt)) });
    day.watch.state.patch(SEEN);
    day.watch.onPresence({ source: "desktop", returned: false });
    await day.settle();
    expect(day.retries().map((line) => line.card?.title)).toEqual(["I couldn't check your new email"]);
    fail = false;
    day.live.emails.push(mail("important-2", day.now()));
    day.tick(15 * MINUTE);
    await day.settle();
    expect(day.titles()).toEqual(["Daily brief", "Subject important-2"]);
  });

  it("dismisses an email from the brief without a turn, and refuses a dismiss from someone who is not the owner or an admin", async () => {
    await w.settle(); w.watch.onPresence({ source: "desktop", returned: false }); await w.settle();
    const briefId = w.briefs()[0]!.id;
    const jobsBefore = w.runJob.mock.calls.length;
    expect(w.watch.serverPress("m-main", briefId, dismiss, member)).toBe("refused");
    expect(JSON.stringify(w.briefs()[0]!.widget)).toContain("Subject important-1");
    expect(w.watch.serverPress("m-main", briefId, dismiss, owner)).toBe("handled");
    expect(JSON.stringify(w.briefs()[0]!.widget)).not.toContain("Subject important-1");
    expect(w.runJob).toHaveBeenCalledTimes(jobsBefore);
    expect(w.watch.serverPress("m-main", briefId, { type: "draft_reply", payload: {} }, owner)).toBeNull();
    expect(w.watch.serverPress("scout-main", briefId, dismiss, owner)).toBeNull();
  });

  it("posts no brief and answers no press with the switch off or on a hosted workspace", async () => {
    for (const quiet of [world({ hosted: true }), (() => { const off = world(); off.switchOff(); return off; })()]) {
      quiet.watch.onPresence({ source: "desktop", returned: false }); await quiet.settle();
      expect(quiet.titles()).toEqual([]);
      expect(quiet.watch.serverPress("m-main", "any", { type: "dismiss_email", payload: { messageId: "x", account: "g1" } }, owner)).toBeNull();
    }
  });

  it("lists today's timed meetings in Your day with their prep status, a solo block as Just you, and no all-day event", async () => {
    const day = world({ events: [meeting("soon", NOW + 2 * HOUR), meeting("later", NOW + 9 * HOUR), meeting("focus", NOW + 3 * HOUR, { attendees: [ME] }), meeting("holiday", NOW, { allDay: true }), meeting("tomorrow", NOW + 24 * HOUR)] });
    await day.settle(); day.watch.onPresence({ source: "desktop", returned: false });
    const brief = JSON.stringify(day.briefs()[0]!.widget);
    for (const shown of ["Meeting soon", "Prep ready", "Meeting later", "Prep at 2:30 PM", "Meeting focus", "Just you"]) expect(brief).toContain(shown);
    for (const left of ["Meeting holiday", "Meeting tomorrow"]) expect(brief).not.toContain(left);
  });

  it("lists the meetings of the calendars it read and names the one it could not, so 'Checking your calendar…' never stays", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const two = world({ listed: [G1, C1, C2], events: [meeting("a", NOW + 6 * HOUR)] });
    two.live.addresses.c2 = ADMIN;
    two.live.broken.add("c2");
    two.watch.state.patch({ accounts: { ...SEEN.accounts, c2: { service: "googlecalendar", address: ADMIN, connectedSeen: true } } });
    two.watch.onPresence({ source: "desktop", returned: false });
    expect(JSON.stringify(two.briefs()[0]!.widget)).toContain("Checking your calendar…");
    await two.settle();
    const brief = JSON.stringify(two.briefs()[0]!.widget);
    expect(brief).toContain("Meeting a");
    expect(brief).toContain("I couldn't read the calendar of admin@example.test.");
    expect(brief).not.toContain("Checking your calendar…");
    expect(two.briefs()).toHaveLength(1);
    expect(two.retries()).toEqual([]);
  });

  it("names a calendar that turns out to be disconnected on the brief, with its Reconnect card and no Retry", async () => {
    const day = world({ events: [meeting("b", NOW + 6 * HOUR)] });
    day.watch.state.patch(SEEN);
    day.live.listed = [G1, { ...C1, active: false }];
    day.watch.onPresence({ source: "desktop", returned: false });
    expect(JSON.stringify(day.briefs()[0]!.widget)).toContain("Checking your calendar…");
    await day.settle();
    const brief = JSON.stringify(day.briefs()[0]!.widget);
    expect(brief).toContain("I couldn't read the calendar of me@example.test.");
    expect(brief).not.toContain("Checking your calendar…");
    expect(day.texts()).toContain(disconnectedText("googlecalendar", "me@example.test"));
    expect(day.retries()).toEqual([]);
  });

  it("counts one failed read of an account in a check, though the brief's re-read and the email read both fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const down = world();
    const waiting: PendingEmail = { account: "g1", messageId: "waiting-1", threadId: "thread-waiting-1", judgedAt: NOW - HOUR, needsReply: true };
    down.watch.state.patch({ ...SEEN, pendingEmails: [waiting] });
    down.watch.onPresence({ source: "desktop", returned: false });
    down.live.broken.add("g1");
    await down.settle();
    expect(down.sources.message).toHaveBeenCalledTimes(1);
    expect(down.sources.emails).toHaveBeenCalledTimes(1);
    expect(down.watch.state.get().accounts?.g1?.failures).toBe(1);
    down.tick(15 * MINUTE);
    await down.settle();
    expect(down.watch.state.get().accounts?.g1?.failures).toBe(2);
  });

  it("posts the brief at once from the last calendar read, so the presence can open it, then corrects that card in place without another notification", async () => {
    const day = world({ events: [meeting("a", NOW + 2 * HOUR)] });
    await day.settle();
    day.notify.mockClear();
    day.noteCard.mockClear();
    day.tick(24 * HOUR);
    day.live.events = [meeting("overnight", day.now() + 5 * HOUR)];
    day.watch.onPresence({ source: "desktop", returned: true });
    expect(day.briefs()).toHaveLength(1);
    expect(day.noteCard).toHaveBeenCalledWith({ botId: "m", threadId: "m-main" });
    const id = day.briefs()[0]!.id;
    expect(JSON.stringify(day.briefs()[0]!.widget)).not.toContain("Meeting overnight");
    await day.watch.idle();
    expect(day.briefs()).toHaveLength(1);
    expect(day.briefs()[0]!.id).toBe(id);
    expect(day.briefs()[0]!.widget).toMatchObject({ rev: 1 });
    expect(JSON.stringify(day.briefs()[0]!.widget)).toContain("Meeting overnight");
    expect(day.notify).toHaveBeenCalledTimes(1);
    expect(day.noteCard).toHaveBeenCalledTimes(1);
  });

  it("after a restart posts the brief at the first presence while the calendar is still being read, then fills that same card in, with one notification", async () => {
    const day = world({ events: [meeting("a", NOW + 2 * HOUR)] });
    await day.settle();
    day.notify.mockClear();
    day.noteCard.mockClear();
    day.tick(24 * HOUR);
    day.live.events = [meeting("b", day.now() + 6 * HOUR)];
    const connected = gate();
    const calendar = gate();
    day.sources.accounts.mockImplementationOnce(async () => { await connected.closed; return day.live.listed; });
    day.sources.events.mockImplementationOnce(async () => { await calendar.closed; return day.live.events; });
    const restarted = day.make();
    restarted.start();
    restarted.onPresence({ source: "desktop", returned: false });
    expect(day.briefs()).toHaveLength(1);
    const placeholder = day.briefs()[0]!;
    expect(JSON.stringify(placeholder.widget)).toContain("Checking your calendar…");
    expect(day.notify).toHaveBeenCalledTimes(1);
    expect(day.noteCard).toHaveBeenCalledWith({ botId: "m", threadId: "m-main" });
    connected.open();
    calendar.open();
    await restarted.idle();
    expect(day.briefs()).toHaveLength(1);
    expect(day.briefs()[0]!.id).toBe(placeholder.id);
    expect(day.briefs()[0]!.widget).toMatchObject({ rev: 1 });
    expect(JSON.stringify(day.briefs()[0]!.widget)).toContain("Meeting b");
    expect(JSON.stringify(day.briefs()[0]!.widget)).not.toContain("Checking your calendar");
    expect(day.notify).toHaveBeenCalledTimes(1);
    expect(day.noteCard).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(day.dataDir, "assistant.json"), "utf8")).not.toContain("Meeting b");
    restarted.stop();
  });

  it("posts the brief for routine results alone, under Routines", async () => {
    const run: RoutineRow = { name: "Overnight numbers", status: "completed", line: "Revenue is up four percent.", open: { botId: "scout", threadId: "run-1" } };
    const routines = world({ listed: [], routines: [run] });
    await routines.settle();
    routines.watch.onPresence({ source: "desktop", returned: false });
    const brief = JSON.stringify(routines.briefs()[0]!.widget);
    for (const shown of ['"Routines"', "Overnight numbers", "Revenue is up four percent."]) expect(brief).toContain(shown);
  });

  it("posts no brief when no Google account is connected and there are no routine results", async () => {
    const none = world({ listed: [{ ...G1, active: false }, { ...C1, active: false }] });
    await none.settle();
    none.watch.onPresence({ source: "desktop", returned: false });
    expect(none.titles()).toEqual([]);
  });
});

describe("a failed AI turn", () => {
  it("leaves one error card with Retry, never runs again on its own, and Retry is the owner's", async () => {
    let fail = true;
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], reply: (title, prompt) => (fail ? { ok: false, error: "engine down" } : defaultReply(title, prompt)) });
    await w.settle();
    expect(w.retries()).toHaveLength(1);
    expect(w.retries()[0]!.card).toMatchObject({ title: "I couldn't prepare \"Meeting a\"", options: [RETRY], fixedOptions: true });
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.jobs).toHaveLength(1);
    const requestId = w.retries()[0]!.card!.requestId!;
    expect(w.watch.answerCard("m-main", requestId, "answer", RETRY, member)).toBe("unavailable");
    expect(w.watch.answerCard("m-main", "someone-else", "answer", RETRY, owner)).toBeUndefined();
    fail = false;
    expect(w.watch.answerCard("m-main", requestId, "answer", RETRY, owner)).toBe("answered");
    await w.watch.idle();
    expect(w.jobs).toHaveLength(2);
    expect(w.titles()).toEqual(["Prep: Meeting a"]);
    expect(w.watch.answerCard("m-main", requestId, "answer", RETRY, owner)).toBe("answered");
    await w.watch.idle();
    expect(w.jobs).toHaveLength(2);
  });

  it("Retry on an email check judges those emails again, even after later checks moved past them", async () => {
    let fail = true;
    const w = world({ emails: [mail("important-1", NOW - MINUTE)], reply: (title, prompt) => (fail ? { ok: false, error: "engine down" } : defaultReply(title, prompt)), briefed: true });
    await w.settle();
    for (let check = 0; check < 8; check += 1) {
      w.tick(15 * MINUTE);
      await w.settle();
    }
    expect(w.jobs).toHaveLength(1);
    fail = false;
    expect(w.watch.answerCard("m-main", w.retries()[0]!.card!.requestId!, "answer", RETRY, owner)).toBe("answered");
    await w.watch.idle();
    expect(w.titles()).toEqual(["Subject important-1"]);
  });

  it("turns a job that threw into the same error card, not a prep that stays in progress", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], reply: () => { throw new Error("engine crashed"); } });
    await w.settle();
    expect(w.retries().map((line) => line.card?.title)).toEqual(["I couldn't prepare \"Meeting a\""]);
    expect(w.watch.state.get().meetings?.a).toMatchObject({ failedAt: NOW });
    expect(w.watch.state.get().meetings?.a?.prepStartedAt).toBeUndefined();
    expect(w.watch.state.get().inFlight).toEqual([]);
  });

  it("turns a job left running by a restart into one error card, without running it again", async () => {
    const first = world({ events: [meeting("a", NOW + 2 * HOUR)], reply: () => new Promise<JobResult>(() => {}) });
    void first.watch.check();
    await vi.waitFor(() => expect(first.jobs).toHaveLength(1));
    const restarted = first.make();
    restarted.start();
    await restarted.idle();
    expect(first.retries().map((line) => line.card?.title)).toEqual(["A meeting prep was cut short"]);
    expect(first.jobs).toHaveLength(1);
    expect(restarted.state.get().inFlight).toEqual([]);
    expect(restarted.state.get().meetings?.a?.failedAt).toBeDefined();
  });
});

describe("Retry settles honestly", () => {
  const failing = (more: Parameters<typeof world>[0] = {}) => world({ events: [meeting("a", NOW + 2 * HOUR)], reply: () => ({ ok: false, error: "engine down" }), ...more });
  const press = (w: ReturnType<typeof world>, behavior: "answer" | "deny" = "answer") => w.watch.answerCard("m-main", w.retries()[0]!.card!.requestId!, behavior, behavior === "answer" ? RETRY : undefined, owner);
  const unavailable = async (w: ReturnType<typeof world>) => {
    const jobs = w.jobs.length;
    expect(press(w)).toBe("unavailable");
    await w.watch.idle();
    expect(w.jobs).toHaveLength(jobs);
    expect(w.retries()[0]!.card).toMatchObject({ answered: "unavailable" });
    expect(w.retries()[0]!.card?.answeredText).toBeUndefined();
    expect(w.watch.state.get().meetings?.a?.failedAt).toBe(NOW);
    expect(press(w)).toBe("unavailable");
  };

  it("is unavailable when the day's turns are used up", async () => {
    const w = failing();
    await w.settle();
    w.watch.state.patch({ dayTurns: 12 });
    await unavailable(w);
  });

  it("is unavailable once the meeting has started", async () => {
    const w = failing();
    await w.settle();
    w.tick(2 * HOUR + MINUTE);
    await unavailable(w);
  });

  it("is unavailable once the meeting has left the calendar", async () => {
    const w = failing();
    await w.settle();
    w.live.events = [];
    await w.settle();
    await unavailable(w);
  });

  it("is unavailable with the switch off, and reads nothing", async () => {
    const w = failing();
    await w.settle();
    w.switchOff();
    await unavailable(w);
    expect(w.sources.accounts).toHaveBeenCalledTimes(1);
  });

  it("answers a dismissed card with its recorded outcome, never a fresh one", async () => {
    const w = failing();
    await w.settle();
    expect(press(w, "deny")).toBe("rejected");
    expect(w.retries()[0]!.card).toMatchObject({ answered: "answer", answeredText: "Dismissed" });
    expect(press(w)).toBe("rejected");
    await w.watch.idle();
    expect(w.jobs).toHaveLength(1);
  });

  it("keeps a cut-short card open until this start has read the calendar", async () => {
    let hang = true;
    const first = world({ events: [meeting("a", NOW + 2 * HOUR)], reply: (title, prompt) => {
      if (!hang) return defaultReply(title, prompt);
      hang = false;
      return new Promise<JobResult>(() => {});
    } });
    void first.watch.check();
    await vi.waitFor(() => expect(first.jobs).toHaveLength(1));
    const restarted = first.make();
    restarted.start();
    const requestId = first.retries()[0]!.card!.requestId!;
    expect(restarted.answerCard("m-main", requestId, "answer", RETRY, owner)).toBe("unavailable");
    expect(first.retries()[0]!.card?.answered).toBeUndefined();
    await restarted.idle();
    expect(restarted.answerCard("m-main", requestId, "answer", RETRY, owner)).toBe("answered");
    await restarted.idle();
    expect(first.titles()).toEqual(["Prep: Meeting a"]);
  });
});

describe("a throw inside a job or a step", () => {
  it("turns a throw inside a job into the usual error card with Retry", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let explode = true;
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], deps: { capabilities: () => {
      if (explode) {
        explode = false;
        throw new Error("the engine list is reloading");
      }
      return { agentsTools: true, mailTools: true };
    } } });
    await w.settle();
    expect(w.jobs).toEqual([]);
    expect(w.retries().map((line) => line.card?.title)).toEqual(["I couldn't prepare \"Meeting a\""]);
    expect(w.watch.state.get().meetings?.a).toMatchObject({ failedAt: NOW });
    expect(w.watch.state.get().inFlight).toEqual([]);
    expect(w.watch.answerCard("m-main", w.retries()[0]!.card!.requestId!, "answer", RETRY, owner)).toBe("answered");
    await w.watch.idle();
    expect(w.titles()).toEqual(["Prep: Meeting a"]);
  });

  it("puts back the emails of a check that threw, but not the ones it already carded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ emails: [mail("important-1", NOW - MINUTE), mail("important-2", NOW - 2 * MINUTE)], briefed: true });
    let refuse = true;
    w.live.refuseAppend = (message) => refuse && message.kind === "widget" && JSON.stringify(message.widget).includes("Subject important-2");
    await w.settle();
    expect(w.titles()).toEqual(["Subject important-1"]);
    expect(w.watch.state.get().accounts?.g1?.judged).toEqual(["important-1"]);
    refuse = false;
    w.tick(15 * MINUTE);
    await w.settle();
    expect([...w.jobs[1]!.prompt.matchAll(/id (\S+) ·/g)].map((match) => match[1])).toEqual(["important-2"]);
    expect(w.titles()).toEqual(["Subject important-1", "Subject important-2"]);
  });

  it("settles every job cut short by a restart, even when one card cannot be posted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ events: [meeting("a", NOW + 2 * HOUR), meeting("b", NOW + 2 * HOUR)] });
    const started = { start: NOW + 2 * HOUR, fingerprint: fingerprint(meeting("a", 0)), prepStartedAt: NOW - MINUTE };
    w.watch.state.patch({ meetings: { a: started, b: started }, inFlight: [{ item: "prep:a", at: NOW - MINUTE }, { item: "prep:b", at: NOW - MINUTE }] });
    let refusals = 1;
    w.live.refuseAppend = (message) => message.kind === "options" && refusals-- > 0;
    await w.settle();
    expect(w.watch.state.get().meetings?.a?.failedAt).toBe(NOW);
    expect(w.watch.state.get().meetings?.b?.failedAt).toBe(NOW);
    expect(w.retries().map((line) => line.card?.title)).toEqual(["A meeting prep was cut short"]);
    expect(w.jobs).toEqual([]);
  });

  it("still reads and plans when settling the cut-short jobs throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ events: [meeting("b", NOW + 2 * HOUR)] });
    w.watch.state.patch({ inFlight: [{ item: "prep:a", at: NOW - MINUTE }] });
    vi.spyOn(w.watch.state, "patch").mockImplementationOnce(() => { throw new Error("disk full"); });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting b"]);
  });

  it("still posts the brief and runs queued jobs when sweeping throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], deps: { threadBusy: () => { throw new Error("the busy list is gone"); } } });
    w.tasks.set("job-old", { routineRunId: "mausbot-job-old" });
    w.watch.state.patch({ workThreads: [{ threadId: "job-old", at: NOW - 25 * HOUR }] });
    w.watch.onPresence({ source: "desktop", returned: false });
    await w.settle();
    expect(w.titles()).toEqual(["Daily brief", "Prep: Meeting a"]);
  });

  it("still runs queued jobs when the brief throws, and a return still reads", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)] });
    w.live.refuseAppend = (message) => message.kind === "widget" && JSON.stringify(message.widget).includes('"title":"Daily brief"');
    w.watch.onPresence({ source: "desktop", returned: false });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a"]);
    expect(w.briefs()).toEqual([]);
    w.tick(24 * HOUR);
    w.watch.onPresence({ source: "desktop", returned: true });
    await w.watch.idle();
    expect(w.sources.events).toHaveBeenCalledTimes(2);
  });
});

describe("a failing piece after delivery", () => {
  it("still posts the brief, without routine results, when they cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], deps: { routines: () => { throw new Error("the run log is unreadable"); } } });
    w.watch.onPresence({ source: "desktop", returned: false });
    await w.settle();
    expect(w.briefs()).toHaveLength(1);
    const brief = JSON.stringify(w.briefs()[0]!.widget);
    expect(brief).toContain("Meeting a");
    expect(brief).not.toContain('"Routines"');
  });

  it("adds no Retry card to a prep that posted its card and then threw, whether or not the switch went off", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const switchOff of [false, true]) {
      const w = world({ events: [meeting("a", NOW + 2 * HOUR)], reply: () => ({ ok: true, threadId: "", reply: JSON.stringify({ brief: "Brief", noWebSearch: true }) }) });
      w.live.refuseAppend = (message) => {
        if (message.text !== NO_WEB_SEARCH) return false;
        if (switchOff) w.switchOff();
        return true;
      };
      await w.settle();
      expect(w.titles()).toEqual(["Prep: Meeting a"]);
      expect(w.retries()).toEqual([]);
      expect(w.watch.state.get().meetings?.a?.preppedAt).toBe(NOW);
      expect(w.watch.state.get().meetings?.a?.failedAt).toBeUndefined();
      expect(w.watch.state.get().dayTurns).toBe(1);
    }
  });

  it("gives back the turn of a since-last-time note that threw while the switch was off", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const earlier = meeting("w1", NOW - 7 * 24 * HOUR, { seriesId: "weekly" });
    const next = meeting("w2", NOW + 2 * HOUR, { seriesId: "weekly" });
    const w = world({ events: [next], reply: (title, prompt) => { w.switchOff(); return defaultReply(title, prompt); } });
    w.watch.state.patch({ meetings: { w1: { start: earlier.start, fingerprint: fingerprint(earlier), seriesId: "weekly", preppedAt: earlier.start - HOUR } } });
    w.live.newMailFromAttendees = true;
    const patch = w.watch.state.patch.bind(w.watch.state);
    vi.spyOn(w.watch.state, "patch").mockImplementation((changes) => {
      if (changes.workThreads) throw new Error("disk full");
      return patch(changes);
    });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Since last time: Meeting w2"]);
    expect(w.watch.state.get().dayTurns).toBe(0);
    expect(w.retries()).toEqual([]);
    expect(w.watch.state.get().meetings?.[meetingKey(next)]?.prepStartedAt).toBeUndefined();
  });
});

describe("checks running together", () => {
  it("joins a second check to the one running, so one check reads once", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], emails: [mail("plain-1", NOW - MINUTE)] });
    const first = w.watch.check();
    expect(w.watch.check()).toBe(first);
    await w.watch.idle();
    expect(w.sources.accounts).toHaveBeenCalledTimes(1);
    expect(w.sources.events).toHaveBeenCalledTimes(1);
    expect(w.sources.emails).toHaveBeenCalledTimes(1);
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a", "Email check"]);
  });

  it("reminds once when the minute clock fires during a check", async () => {
    const w = world({ events: [meeting("a", NOW + 3 * HOUR)] });
    await w.settle();
    w.tick(3 * HOUR - 9 * MINUTE);
    const reading = gate();
    const entered = gate();
    w.sources.events.mockImplementationOnce(async () => {
      entered.open();
      await reading.closed;
      return w.live.events;
    });
    const running = w.watch.check();
    await entered.closed;
    w.watch.reminders();
    reading.open();
    await running;
    await w.watch.idle();
    w.watch.reminders();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Call with Jake Price in 9 minutes"]);
  });

  it("keeps a cursor moved back by Retry when a Gmail read that started earlier finishes", async () => {
    let fail = true;
    const w = world({ emails: [mail("important-1", NOW - MINUTE)], reply: (title, prompt) => (fail ? { ok: false, error: "engine down" } : defaultReply(title, prompt)), briefed: true });
    await w.settle();
    for (let check = 0; check < 2; check += 1) {
      w.tick(15 * MINUTE);
      await w.settle();
    }
    fail = false;
    const reading = gate();
    const entered = gate();
    w.sources.emails.mockImplementationOnce(async () => {
      entered.open();
      await reading.closed;
      return [];
    });
    w.tick(15 * MINUTE);
    const running = w.watch.check();
    await entered.closed;
    expect(w.watch.answerCard("m-main", w.retries()[0]!.card!.requestId!, "answer", RETRY, owner)).toBe("answered");
    reading.open();
    await running;
    await w.watch.idle();
    await w.settle();
    expect(w.titles()).toEqual(["Subject important-1"]);
  });
});

describe("cards and the open rule", () => {
  it("sends exactly one notification and one note per new card, and none for the brief's edits", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], emails: [mail("important-1", NOW - MINUTE)] });
    w.watch.onPresence({ source: "desktop", returned: false });
    await w.settle();
    expect(JSON.stringify(w.briefs()[0]!.widget)).toContain("Subject important-1");
    w.live.emails.push(mail("important-2", w.now()));
    w.tick(15 * MINUTE);
    await w.settle();
    w.tick(2 * HOUR - 15 * MINUTE - 9 * MINUTE);
    w.watch.reminders();
    expect(w.titles()).toEqual(["Daily brief", "Prep: Meeting a", "Subject important-2", "Call with Jake Price in 9 minutes"]);
    expect(w.notify).toHaveBeenCalledTimes(4);
    expect(w.noteCard).toHaveBeenCalledTimes(4);
    expect(w.messages.filter((line) => line.kind === "widget").map((line) => line.serverCard)).toEqual([true, true, true, true]);
  });

  it("notes each newly posted card once, and never a Retry card or its answer", async () => {
    let fail = true;
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], emails: [mail("important-1", NOW - MINUTE)], briefed: true,
      reply: (title, prompt) => (fail && title.startsWith("Prep: ") ? { ok: false, error: "engine down" } : defaultReply(title, prompt)) });
    await w.settle();
    expect(w.titles()).toEqual(["Subject important-1"]);
    expect(w.noteCard).toHaveBeenCalledTimes(1);
    fail = false;
    expect(w.watch.answerCard("m-main", w.retries()[0]!.card!.requestId!, "answer", RETRY, owner)).toBe("answered");
    await w.watch.idle();
    expect(w.titles()).toEqual(["Subject important-1", "Prep: Meeting a"]);
    expect(w.noteCard).toHaveBeenCalledTimes(2);
  });

  it("opens a related chat only when it is a real conversation MausBot's audience may see, never a job thread or a guest's", async () => {
    const related = (relatedThreadId: string, threads: Record<string, Owner>, visibility?: BotVisibility) => {
      const w = world({ events: [meeting("a", NOW + 2 * HOUR)], threads, visibility,
        reply: () => ({ ok: true, threadId: "", reply: JSON.stringify({ brief: "Brief", relatedThreadId, noWebSearch: false }) }) });
      w.tasks.set("job-old", { routineRunId: "mausbot-job-old" });
      return w.settle().then(() => JSON.stringify(w.widgets()[0]));
    };
    const scout = { bot: { id: "scout", visibility: "everyone" as const }, cloudGuest: false };
    expect(await related("scout-main", { "scout-main": scout })).toContain('"threadId":"scout-main"');
    expect(await related("scout-gone", { "scout-gone": scout })).not.toContain("open_thread");
    expect(await related("job-old", { "job-old": { bot: { id: "m", visibility: "admins" }, cloudGuest: false } })).not.toContain("open_thread");
    expect(await related("scout-main", { "scout-main": { ...scout, cloudGuest: true } })).not.toContain("open_thread");
    expect(await related("scout-main", {})).not.toContain("open_thread");
    expect(await related("scout-main", { "scout-main": { bot: { id: "scout", visibility: "admins" }, cloudGuest: false } }, "everyone")).not.toContain("open_thread");
  });

  it("answers a card press from its own records by id, never from card text, and ignores an unknown id", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR, { description: "Agenda: pricing" })], emails: [mail("important-1", NOW - MINUTE)], briefed: true });
    await w.settle();
    const prep = w.watch.pressRecords({ type: "prep_notes", payload: { eventId: "a" } });
    expect(prep).toContain("Title: Meeting a");
    expect(prep).toContain("Agenda: pricing");
    expect(prep).toContain("[end of records]");
    expect(w.watch.pressRecords({ type: "draft_followup", payload: { eventId: "a" } })).toContain("Title: Meeting a");
    expect(w.watch.pressRecords({ type: "draft_reply", payload: { messageId: "important-1" } })).toContain("subject Subject important-1");
    expect(w.watch.pressRecords({ type: "draft_reply", payload: { messageId: "plain-9" } })).toBeNull();
    expect(w.watch.pressRecords({ type: "prep_notes", payload: { eventId: "nope" } })).toBeNull();
    expect(w.watch.pressRecords({ type: "prep_notes", payload: { eventId: 7 } })).toBeNull();
    expect(w.watch.pressRecords({ type: "draft_reply", payload: { eventId: "a" } })).toBeNull();
    expect(w.watch.pressRecords({ type: "send_now", payload: { eventId: "a" } })).toBeNull();
    w.tick(5 * HOUR);
    w.live.events = [];
    await w.settle();
    expect(w.watch.pressRecords({ type: "draft_followup", payload: { eventId: "a" } })).toContain("Title: Meeting a");
  });
});

describe("bounded state", () => {
  it("keeps the newest judged ids and job threads, and never overflows the state file", async () => {
    const w = world({ events: [meeting("a", NOW + 2 * HOUR)], emails: [mail("important-1", NOW - MINUTE)], briefed: true });
    const oldThreads = Array.from({ length: 1_000 }, (_, index) => ({ threadId: `job-old-${index}`, at: NOW }));
    for (const entry of oldThreads) w.tasks.set(entry.threadId, { routineRunId: `mausbot-${entry.threadId}` });
    w.watch.state.patch({ accounts: { g1: { service: "gmail", connectedSeen: true, judged: Array.from({ length: MAX_JUDGED }, (_, index) => `seen-${index}`) } }, workThreads: oldThreads });
    await w.settle();
    expect(w.titles()).toEqual(["Prep: Meeting a", "Subject important-1"]);
    const state = w.watch.state.get();
    expect(state.accounts?.g1?.judged).toHaveLength(MAX_JUDGED);
    expect(state.accounts?.g1?.judged?.at(-1)).toBe("important-1");
    expect(state.accounts?.g1?.judged).not.toContain("seen-0");
    expect(state.workThreads).toHaveLength(1_000);
    expect(state.workThreads?.slice(-2).map((entry) => entry.threadId)).toEqual(["job-1", "job-2"]);
    expect(state.workThreads?.map((entry) => entry.threadId)).not.toContain("job-old-1");
  });

  it("keeps the newest hundred jobs in flight when more start at once", async () => {
    const earlier = (index: number) => meeting(`r${index}-1`, NOW - 7 * 24 * HOUR, { seriesId: `series-${index}` });
    const w = world({ events: Array.from({ length: 101 }, (_, index) => meeting(`r${index}-2`, NOW + 2 * HOUR, { seriesId: `series-${index}` })) });
    w.watch.state.patch({
      meetings: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`r${index}-1`, { start: earlier(index).start, fingerprint: fingerprint(earlier(index)), seriesId: `series-${index}`, preppedAt: earlier(index).start - HOUR }])),
    });
    const inFlight: number[] = [];
    const patch = w.watch.state.patch.bind(w.watch.state);
    vi.spyOn(w.watch.state, "patch").mockImplementation((changes) => { if (changes.inFlight) inFlight.push(changes.inFlight.length); return patch(changes); });
    await w.settle();
    expect(Math.max(...inFlight)).toBe(100);
    expect(w.watch.state.get().inFlight).toEqual([]);
    expect(Object.values(w.watch.state.get().meetings ?? {}).filter((record) => record.repeat && record.preppedAt !== undefined)).toHaveLength(101);
  });
});

describe("when MausBot may not act, or says what it cannot do", () => {
  it("reads and posts nothing with the switch off or on a hosted workspace", async () => {
    const off = world({ events: [meeting("a", NOW + HOUR)], emails: [mail("important-1", NOW - MINUTE)] });
    off.switchOff();
    off.watch.start();
    await off.settle();
    off.watch.onPresence({ source: "desktop", returned: true });
    await off.watch.idle();
    expect(off.sources.accounts).not.toHaveBeenCalled();
    expect(off.messages).toEqual([]);
    const hosted = world({ hosted: true, events: [meeting("a", NOW + HOUR)] });
    hosted.watch.start();
    await hosted.settle();
    hosted.watch.onPresence({ source: "desktop", returned: true });
    hosted.watch.reminders();
    await hosted.watch.idle();
    expect(hosted.sources.accounts).not.toHaveBeenCalled();
    expect(hosted.clocks).toEqual([]);
    expect(hosted.messages).toEqual([]);
    expect(existsSync(join(hosted.dataDir, "assistant.json"))).toBe(false);
  });

  it("reads no Gmail, not even for a recurring meeting, when MausBot may not use it", async () => {
    const earlier = meeting("w1", NOW - 7 * 24 * HOUR, { seriesId: "weekly" });
    const next = meeting("w2", NOW + 2 * HOUR, { seriesId: "weekly" });
    const w = world({ events: [next], emails: [mail("important-1", NOW - MINUTE)], connectorTools: { googlecalendar: { tools: "*" } } });
    w.watch.state.patch({ meetings: { w1: { start: earlier.start, fingerprint: fingerprint(earlier), seriesId: "weekly", preppedAt: earlier.start - HOUR } } });
    w.live.newMailFromAttendees = true;
    await w.settle();
    expect(w.sources.emails).not.toHaveBeenCalled();
    expect(w.sources.mailFrom).not.toHaveBeenCalled();
    expect(w.jobs).toEqual([]);
    expect(w.watch.state.get().meetings?.[meetingKey(next)]?.preppedAt).toBe(NOW);
  });

  it("posts nothing from a job running when the switch goes off, gives its turn back, and plans it again once on", async () => {
    let first = true;
    const w = world({ events: [meeting("a", NOW + HOUR), meeting("b", NOW + 2 * HOUR)], emails: [mail("important-1", NOW - MINUTE)], briefed: true,
      reply: (title, prompt) => {
        if (first) w.switchOff();
        first = false;
        return title.startsWith("Prep: ") ? { ok: true, threadId: "", reply: JSON.stringify({ brief: `Brief for ${title}`, noWebSearch: true }) } : defaultReply(title, prompt);
      } });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a"]);
    expect(w.messages).toEqual([]);
    expect(w.notify).not.toHaveBeenCalled();
    expect(w.noteCard).not.toHaveBeenCalled();
    expect(w.watch.state.get()).toMatchObject({ dayTurns: 0, inFlight: [] });
    expect(w.watch.state.get().meetings?.a?.prepStartedAt).toBeUndefined();
    expect(w.watch.state.get().meetings?.b?.prepStartedAt).toBeUndefined();
    expect(w.watch.state.get().workThreads?.map((entry) => entry.threadId)).toEqual(["job-1"]);
    w.switchOn();
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a", "Prep: Meeting a", "Prep: Meeting b", "Email check"]);
    expect(w.titles()).toEqual(["Prep: Meeting a", "Prep: Meeting b", "Subject important-1"]);
    expect(w.watch.state.get().dayTurns).toBe(2);
  });

  it("gives a failed turn no Retry card when the switch went off while it ran", async () => {
    const w = world({ events: [meeting("a", NOW + HOUR)], reply: () => { w.switchOff(); return { ok: false, error: "engine down" }; } });
    await w.settle();
    expect(w.retries()).toEqual([]);
    expect(w.watch.state.get().meetings?.a?.failedAt).toBeUndefined();
    expect(w.watch.state.get().dayTurns).toBe(0);
  });

  it("posts no email card from a check running when the switch goes off, and judges those emails again once on", async () => {
    let first = true;
    const w = world({ emails: [mail("important-1", NOW - MINUTE)], briefed: true, reply: (title, prompt) => {
      if (first) w.switchOff();
      first = false;
      return defaultReply(title, prompt);
    } });
    await w.settle();
    expect(w.messages).toEqual([]);
    expect(w.watch.state.get().accounts?.g1?.judged ?? []).not.toContain("important-1");
    w.switchOn();
    w.tick(15 * MINUTE);
    await w.settle();
    expect(w.titles()).toEqual(["Subject important-1"]);
  });

  it("posts no update and no since-last-time note from a turn running when the switch goes off, and gives the turn back", async () => {
    const original = meeting("a", NOW + 3 * HOUR);
    const moving = world({ events: [original], reply: (title, prompt) => {
      if (title.startsWith("Update: ")) moving.switchOff();
      return defaultReply(title, prompt);
    } });
    await moving.settle();
    moving.live.events = [{ ...original, start: original.start + 30 * MINUTE, end: original.end + 30 * MINUTE }];
    await moving.settle();
    expect(moving.titles()).toEqual(["Prep: Meeting a"]);
    expect(moving.watch.state.get().dayTurns).toBe(1);
    expect(moving.watch.state.get().meetings?.a).toMatchObject({ start: original.start });
    expect(moving.watch.state.get().meetings?.a?.updateStartedAt).toBeUndefined();
    const earlier = meeting("w1", NOW - 7 * 24 * HOUR, { seriesId: "weekly" });
    const next = meeting("w2", NOW + 2 * HOUR, { seriesId: "weekly" });
    const repeating = world({ events: [next], reply: (title, prompt) => { repeating.switchOff(); return defaultReply(title, prompt); } });
    repeating.watch.state.patch({ meetings: { w1: { start: earlier.start, fingerprint: fingerprint(earlier), seriesId: "weekly", preppedAt: earlier.start - HOUR } } });
    repeating.live.newMailFromAttendees = true;
    await repeating.settle();
    expect(repeating.jobs.map((job) => job.title)).toEqual(["Since last time: Meeting w2"]);
    expect(repeating.watch.state.get().dayTurns).toBe(0);
    expect(repeating.watch.state.get().meetings?.[meetingKey(next)]?.prepStartedAt).toBeUndefined();
    expect(repeating.watch.state.get().meetings?.[meetingKey(next)]?.preppedAt).toBeUndefined();
  });

  it("skips an event whose series id, or an email whose id, the state file could not hold, and carries on with the rest", async () => {
    const long = "x".repeat(300);
    const w = world({ events: [meeting("long", NOW + HOUR, { seriesId: long }), meeting("a", NOW + HOUR)], emails: [mail(long, NOW - MINUTE), mail("important-1", NOW - MINUTE)], briefed: true });
    await w.settle();
    expect(w.jobs.map((job) => job.title)).toEqual(["Prep: Meeting a", "Email check"]);
    expect(w.jobs[1]!.prompt).not.toContain(long);
    expect(w.titles()).toEqual(["Prep: Meeting a", "Subject important-1"]);
  });

  it("answers no card and no press on a hosted workspace", async () => {
    const w = world({ hosted: true });
    w.watch.state.patch({ retryCards: { rq1: { item: "prep:a", threadId: "m-main", messageId: "msg0" } } });
    w.store.appendMessage("m-main", { role: "bot", kind: "options", card: { title: "x", subtitle: "", options: [RETRY], requestId: "rq1", fixedOptions: true } });
    expect(w.watch.answerCard("m-main", "rq1", "answer", RETRY, owner)).toBeUndefined();
    expect(w.watch.pressRecords({ type: "prep_notes", payload: { eventId: "a" } })).toBeNull();
  });

  it("says once that its engine has no connected-app tools, and once that it had no web search", async () => {
    const w = world({ events: [meeting("a", NOW + HOUR), meeting("b", NOW + 2 * HOUR)], tools: { agentsTools: false, mailTools: false },
      reply: (title) => ({ ok: true, threadId: "", reply: JSON.stringify({ brief: `Brief ${title}`, noWebSearch: true }) }) });
    await w.settle();
    expect(w.texts()).toEqual([NO_CONNECTOR_TOOLS, NO_WEB_SEARCH]);
    expect(w.jobs[0]!.prompt).not.toContain("session_search");
  });

  it("still posts a muted MausBot's cards, without a notification", async () => {
    const w = world({ events: [meeting("a", NOW + HOUR)], notifications: false });
    await w.settle();
    expect(w.titles()).toEqual(["Prep: Meeting a"]);
    expect(w.notify).toHaveBeenCalledWith(null);
  });

  it("deletes its own job threads a day later, and never another thread", async () => {
    const w = world({ events: [meeting("a", NOW + HOUR)] });
    await w.settle();
    w.tasks.set("person-thread", {});
    w.watch.state.patch({ workThreads: [...(w.watch.state.get().workThreads ?? []), { threadId: "person-thread", at: NOW }] });
    w.tick(24 * HOUR);
    await w.settle();
    expect(w.store.deleteTasks).toHaveBeenCalledWith("m", ["job-1"]);
    expect(w.tasks.has("person-thread")).toBe(true);
  });

  it("deletes on start the job threads a restart left unrecorded, never a recorded one, a busy one or another thread", () => {
    const busy = new Set(["job-running"]);
    const w = world({ deps: { threadBusy: (_botId, threadId) => busy.has(threadId) } });
    for (const id of ["job-cut-short", "job-finished", "job-running"]) w.tasks.set(id, { routineRunId: `mausbot-${id}` });
    w.tasks.set("routine-thread", { routineRunId: "routine-run-1" });
    w.watch.state.patch({ workThreads: [{ threadId: "job-finished", at: NOW }] });
    w.make().start();
    expect(w.store.deleteTasks).toHaveBeenCalledTimes(1);
    expect(w.store.deleteTasks).toHaveBeenCalledWith("m", ["job-cut-short"]);
    expect([...w.tasks.keys()]).toEqual(["m-main", "scout-main", "job-finished", "job-running", "routine-thread"]);
  });

  it("leaves the thread of a job already running when it starts, which a presence can begin before the start", async () => {
    const running = gate();
    const entered = gate();
    const w = world({ events: [meeting("a", NOW + HOUR)], reply: async (title, prompt) => { entered.open(); await running.closed; return defaultReply(title, prompt); } });
    const settled = w.watch.check();
    await entered.closed;
    w.watch.start();
    expect(w.store.deleteTasks).not.toHaveBeenCalled();
    running.open();
    await settled;
    await w.watch.idle();
    expect(w.titles()).toEqual(["Prep: Meeting a"]);
  });

  it("deletes nothing on start on a hosted workspace", () => {
    const w = world({ hosted: true });
    w.tasks.set("job-cut-short", { routineRunId: "mausbot-job-cut-short" });
    w.watch.start();
    expect(w.store.deleteTasks).not.toHaveBeenCalled();
  });

  it("keeps the thread of a job whose start was refused, so it is deleted later", async () => {
    const w = world({ events: [meeting("a", NOW + HOUR)], reply: () => ({ ok: false, error: "this bot's approval level is still being confirmed" }) });
    await w.settle();
    expect(w.watch.state.get().workThreads?.map((entry) => entry.threadId)).toEqual(["job-1"]);
  });
});
