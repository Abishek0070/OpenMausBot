import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseWidgetInput, widgetActions, type WidgetRoot } from "../../shared/widget.ts";
import type { AssistantService, EmailHeader, SourceAccount, ThreadMessage } from "../assistant-sources.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createAssistantBrief, type AssistantBrief, type AssistantBriefDeps, type TriagePick } from "./assistant-brief.ts";
import type { BuiltCard } from "./assistant-cards.ts";
import { copyGroupOf, emailKey, type Meeting } from "./assistant-plan.ts";
import { createAssistantState, MAX_ID_LENGTH, MAX_PENDING_EMAILS, type AssistantStateStore, type PendingEmail } from "./assistant-state.ts";
import type { RoutineRow } from "./brief-recap.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONE = "Asia/Kolkata";
const NOW = Date.parse("2026-10-21T02:30:00.000Z"); // 08:00 in Kolkata
const G1: SourceAccount = { service: "gmail", id: "ca_g1", active: true };
const G2: SourceAccount = { service: "gmail", id: "ca_g2", active: true };
const C1: SourceAccount = { service: "googlecalendar", id: "ca_c1", active: true };
const C2: SourceAccount = { service: "googlecalendar", id: "ca_c2", active: true };
const ADDRESSES: Record<string, string> = { ca_g1: "me@example.test", ca_c1: "me@example.test", ca_g2: "admin@example.test", ca_c2: "admin@example.test" };

const demo: Meeting = {
  id: "uid-demo", title: "Demo with Jake", start: NOW + 2 * HOUR, end: NOW + 2 * HOUR + 30 * MINUTE, allDay: false, status: "confirmed", selfDeclined: false,
  attendees: [{ email: "me@example.test", self: true, organizer: true }, { email: "jake@pin.example", name: "Jake Price", self: false, organizer: false }],
  joinUrl: "https://meet.google.com/abc-defg-hij", accounts: ["ca_c1", "ca_c2"],
};
const mail = (id: string, account = "ca_g1"): EmailHeader => ({
  id, account, threadId: `thread-${id}`, at: NOW - 10 * MINUTE, from: "Ada <ada@example.test>", subject: `Subject ${id}`, preview: "", messageIdHeader: `<${id}@example.test>`,
});
/** The email `of` as it landed in another inbox: its own id and thread, the same Message-ID. */
const copy = (id: string, account: string, of: string): EmailHeader => ({ ...mail(of), id, account, threadId: `thread-${id}` });
const pick = (id: string, needsReply: boolean): TriagePick => ({ email: mail(id), copies: [], why: `Why ${id}`, action: "Reply to it", needsReply });
const entry = (id: string, changes: Partial<PendingEmail> = {}): PendingEmail => ({ account: "ca_g1", messageId: id, threadId: `thread-${id}`, judgedAt: NOW, needsReply: true, ...changes });
const actions = (card: string) => {
  const parsed = parseWidgetInput(JSON.parse(card));
  expect(parsed.ok).toBe(true);
  return widgetActions(parsed.ok ? parsed.value : (JSON.parse(card) as WidgetRoot));
};

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function briefWorld() {
  const dir = mkdtempSync(join(tmpdir(), "omb-assistant-brief-"));
  dirs.push(dir);
  const file = join(dir, "assistant.json");
  const shared = {
    clock: NOW,
    usable: { gmail: [G1, G2], googlecalendar: [C1, C2] } as Partial<Record<AssistantService, SourceAccount[]>>,
    listed: true,
    expired: [] as SourceAccount[],
    readState: new Map<string, "ok" | "failed">([G1, G2, C1, C2].map((account) => [account.id, "ok"])),
    ignored: new Set<string>(),
    inbox: new Map<string, EmailHeader | null | Error>(),
    threads: {} as Record<string, ThreadMessage[] | Error>,
    messageReads: [] as Array<{ account: string; id: string }>,
    meetings: [demo] as Meeting[] | null,
    /** A run without `at` finished before any brief's window opened. */
    routines: [] as Array<RoutineRow & { at?: number }>,
    routinesAskedSince: [] as number[],
    postAttempts: 0,
    posts: [] as Array<{ messageId: string; threadId: string; built: BuiltCard }>,
    edits: [] as Array<{ messageId: string; threadId: string; built: BuiltCard }>,
    shown: [] as BuiltCard[],
    refuse: (_built: BuiltCard): boolean => false,
  };
  const knownAccounts = (): SourceAccount[] => [...Object.values(shared.usable).flatMap((list) => list ?? []), ...shared.expired];
  const accounts: AssistantBriefDeps["accounts"] = {
    listed: () => shared.listed,
    usable: (service) => shared.usable[service] ?? [],
    unreadable: (service) => [
      ...(shared.usable[service] ?? []).filter((account) => shared.readState.get(account.id) === "failed"),
      ...shared.expired.filter((account) => account.service === service),
    ],
    known: () => new Set(knownAccounts().map((account) => account.id)),
    async read<T>(account: SourceAccount, load: () => Promise<T>): Promise<T | null> {
      try {
        const value = await load();
        shared.readState.set(account.id, "ok");
        return value;
      } catch {
        shared.readState.set(account.id, "failed");
        return null;
      }
    },
    label: (id) => ADDRESSES[id] ?? id,
    address: (id) => ADDRESSES[id],
    addresses: () => new Set(Object.values(ADDRESSES)),
    selectionIgnored: (id) => shared.ignored.has(id),
  };
  const sources: AssistantBriefDeps["sources"] = {
    async message(account, id) {
      shared.messageReads.push({ account: account.id, id });
      const key = emailKey({ account: account.id, id });
      const answer = shared.inbox.has(key) ? shared.inbox.get(key) : mail(id, account.id);
      if (answer instanceof Error) throw answer;
      return answer ?? null;
    },
    async thread(account, threadId) {
      const answer = shared.threads[`${account.id}/${threadId}`] ?? [];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };

  function make(state: AssistantStateStore): AssistantBrief {
    const brief = createAssistantBrief({
      state,
      now: () => shared.clock,
      timeZone: () => ZONE,
      accounts,
      sources,
      meetings: () => shared.meetings,
      status: () => "Prep ready",
      routines(since) {
        shared.routinesAskedSince.push(since);
        return shared.routines.filter((row) => row.at === undefined || row.at >= since).map(({ at: _at, ...row }) => row);
      },
      post(built) {
        shared.postAttempts += 1;
        if (shared.refuse(built)) return null;
        const card = { messageId: `brief-${shared.posts.length + 1}`, threadId: "m-main" };
        shared.posts.push({ ...card, built });
        shared.shown.push(built);
        return card;
      },
      edit(card, edited) {
        const built: BuiltCard = { summary: "", ...edited };
        if (shared.refuse(built)) return false;
        shared.edits.push({ ...card, built });
        shared.shown.push(built);
        return true;
      },
      stored: (card) => [...shared.posts, ...shared.edits].findLast((one) => one.messageId === card.messageId)?.built.card,
    });
    // Gmail holds every email MausBot judged, so a re-read by id answers with it.
    const judged = (picks: TriagePick[]): TriagePick[] => {
      for (const one of picks) for (const email of [one.email, ...one.copies]) if (!shared.inbox.has(emailKey(email))) shared.inbox.set(emailKey(email), email);
      return brief.judged(picks);
    };
    return { ...brief, judged };
  }

  function view(state: AssistantStateStore) {
    return {
      state,
      brief: make(state),
      get posts() { return shared.posts; },
      get edits() { return shared.edits; },
      get routinesAskedSince() { return shared.routinesAskedSince; },
      get postAttempts() { return shared.postAttempts; },
      get messageReads() { return shared.messageReads; },
      get readState() { return shared.readState; },
      get inbox() { return shared.inbox; },
      get threads() { return shared.threads; },
      get ignored() { return shared.ignored; },
      set meetings(next: Meeting[] | null) { shared.meetings = next; },
      set routines(next: Array<RoutineRow & { at?: number }>) { shared.routines = next; },
      set usable(next: Partial<Record<AssistantService, SourceAccount[]>>) { shared.usable = next; },
      set listed(next: boolean) { shared.listed = next; },
      set expired(next: SourceAccount[]) { shared.expired = next; },
      set refuse(next: (built: BuiltCard) => boolean) { shared.refuse = next; },
      now: () => shared.clock,
      tick(ms: number) { shared.clock += ms; },
      lastCard: (): string => JSON.stringify(shared.shown.at(-1)?.card ?? null),
      /** The card of the brief posted `back` briefs ago, as a press names it. */
      briefRef: (back = 0) => ({ messageId: shared.posts.at(-1 - back)!.messageId, threadId: "m-main" }),
      lastSummary: (): string => shared.shown.at(-1)?.summary ?? "",
      pending: (): PendingEmail[] => state.get().pendingEmails ?? [],
      restart: () => view(createAssistantState(file)),
    };
  }

  return view(createAssistantState(file));
}

describe("MausBot's daily brief", () => {
  it("posts once per local day at the first presence, with every account's meetings merged, and nothing before", () => {
    const w = briefWorld();
    w.brief.refresh();
    expect(w.brief.judged([])).toEqual([]);
    expect(w.posts).toEqual([]);
    w.brief.post(); w.brief.post();
    expect(w.posts).toHaveLength(1);
    expect(w.lastCard()).toContain("Demo with Jake");
    expect(w.lastCard()).toContain("me@example.test, admin@example.test");
    w.tick(DAY); w.brief.post();
    expect(w.posts).toHaveLength(2);
  });

  it("posts at once with 'Checking your calendar…' before every calendar was read in this run, and edits that card in place once they are", () => {
    const w = briefWorld();
    w.meetings = null; w.brief.post();
    expect(w.lastCard()).toContain("Checking your calendar…");
    w.meetings = [demo]; w.brief.refresh();
    expect(w.posts).toHaveLength(1);
    expect(w.edits).toHaveLength(1);
    expect(w.edits[0]!.messageId).toBe(w.posts[0]!.messageId);
    expect(w.lastCard()).toContain("Demo with Jake");
    w.brief.refresh();
    expect(w.edits).toHaveLength(1);
  });

  it("names an account it could not read at the top of the brief, so the brief never looks complete", () => {
    const w = briefWorld();
    w.readState.set("ca_c2", "failed"); w.brief.post();
    const card = w.lastCard();
    expect(card).toContain("I couldn't read the calendar of admin@example.test.");
    expect(card.indexOf("I couldn't read")).toBeLessThan(card.indexOf("Needs you"));
    expect(card).toContain("Demo with Jake");
    expect(w.lastSummary()).not.toContain("nothing needs you");
  });

  it("replaces 'Checking your calendar…' with the account it could not read, and never says there are no meetings for it", () => {
    const w = briefWorld();
    w.brief.mailChecked(true);
    w.meetings = null; w.brief.post();
    w.readState.set("ca_c1", "failed"); w.readState.set("ca_c2", "failed"); w.meetings = [];
    w.brief.refresh();
    const card = w.lastCard();
    expect(w.edits).toHaveLength(1);
    expect(card).not.toContain("Checking your calendar…");
    expect(card).toContain("I couldn't read the calendar of me@example.test.");
    expect(card).toContain("I couldn't read the calendar of admin@example.test.");
    expect(card).not.toContain("No meetings today.");
    expect(w.lastSummary()).toBe("Daily brief: 2 accounts unreadable");
  });

  it("holds mail judged before the brief, with no card, then shows it in Needs you or Important emails", async () => {
    const w = briefWorld();
    expect(w.brief.judged([pick("m1", true), pick("m2", false)])).toEqual([]);
    expect(w.posts).toEqual([]);
    const reloaded = w.restart(); reloaded.brief.post();
    expect(reloaded.lastCard()).toContain("Checking your email…");
    expect(reloaded.lastSummary()).toContain("checking your email…");
    expect(reloaded.lastSummary()).not.toContain("nothing needs you");
    await reloaded.brief.checkPending(true);
    expect(reloaded.lastCard()).toContain("Checking your email…");
    reloaded.brief.mailChecked(true);
    const card = reloaded.lastCard();
    expect(card).toContain("Subject m1"); expect(card).toContain("Subject m2");
    expect(card.indexOf("Subject m1")).toBeLessThan(card.indexOf("Your day"));
    expect(card.indexOf("Subject m2")).toBeGreaterThan(card.indexOf("Important emails"));
    expect(card).not.toContain("Checking your email…");
  });

  it("adds every email check that lands while the mail window is open to that card in place, and hands picks back for their own cards once it closed", () => {
    const w = briefWorld();
    w.brief.post();
    expect(w.brief.judged([pick("m1", false)])).toEqual([]);
    expect(w.edits).toHaveLength(1);
    expect(w.lastCard()).toContain("Subject m1");
    expect(w.brief.judged([pick("m2", false)])).toEqual([]);
    expect(w.edits).toHaveLength(2);
    expect(w.lastCard()).toContain("Subject m2");
    w.brief.mailChecked(true);
    expect(w.brief.judged([pick("m3", false)]).map((one) => one.email.id)).toEqual(["m3"]);
    expect(w.edits).toHaveLength(2);
  });

  it("says it is still checking email, never that nothing needs you, until the first email check of a cold start has finished", () => {
    const w = briefWorld();
    w.brief.post();
    expect(w.lastCard()).toContain("Checking your email…");
    expect(w.lastCard()).not.toContain("Nothing needs you right now.");
    expect(w.lastSummary()).toContain("checking your email…");
    w.brief.mailChecked(false);
    expect(w.edits).toHaveLength(1);
    expect(w.lastCard()).toContain("Nothing needs you right now.");
    expect(w.brief.judged([pick("m1", false)])).toEqual([]);
    const warm = w.restart();
    warm.brief.mailChecked(true);
    warm.tick(DAY); warm.brief.post();
    expect(warm.lastCard()).not.toContain("Checking your email…");
  });

  it("closes the mail window when an email check after the brief finds nothing to judge", () => {
    const w = briefWorld();
    w.brief.post(); w.brief.mailChecked(true);
    expect(w.brief.judged([pick("m1", false)])).toHaveLength(1);
  });

  it("keeps a reply that waits in Needs you day after day until it is answered from any address, dismissed, or a week old", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true), pick("m2", true), pick("m3", true)]);
    for (const _day of [1, 2, 3]) {
      w.tick(DAY); w.brief.post(); await w.brief.checkPending(true);
      expect(w.lastCard()).toContain("Subject m1");
    }
    w.threads["ca_g1/thread-m1"] = [{ id: "r", at: w.now(), from: "admin@example.test" }];
    w.brief.dismiss("ca_g1", "m2", w.briefRef());
    w.tick(5 * DAY); w.brief.post(); await w.brief.checkPending(true);
    expect(w.pending()).toEqual([]); // m1 answered, m2 dismissed, m3 older than a week
  });

  it("keeps a reply when a later message in its thread comes from someone else", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true)]);
    w.threads["ca_g1/thread-m1"] = [{ id: "r", at: w.now(), from: "colleague@example.test" }];
    w.brief.post(); await w.brief.checkPending(true);
    expect(w.pending().map((one) => one.messageId)).toEqual(["m1"]);
  });

  it("re-reads waiting emails by id after a restart so they show and Draft a reply works, and drops one that is gone", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m1"), entry("m2")] });
    w.inbox.set("ca_g1/m2", null);
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    expect(again.brief.emailsWithId("m1").map((one) => [one.account, one.subject])).toEqual([["ca_g1", "Subject m1"]]);
    expect(again.pending().map((one) => one.messageId)).toEqual(["m1"]);
    const draft = actions(again.lastCard()).find((one) => one.action.type === "draft_reply");
    expect(draft?.action.payload).toEqual({ messageId: "m1", account: "ca_g1" });
  });

  it("keeps an email that seems gone when the account's reads may be landing on another account", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m1")] });
    w.inbox.set("ca_g1/m1", null); w.ignored.add("ca_g1");
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    expect(again.pending().map((one) => one.messageId)).toEqual(["m1"]);
  });

  it("keeps an entry whose re-read failed and names its account", async () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), email: mail("m1", "ca_g2") }, { ...pick("m2", true), email: mail("m2", "ca_g2") }]);
    w.inbox.set("ca_g2/m1", new Error("token expired")); w.inbox.set("ca_g2/m2", new Error("token expired"));
    w.brief.post(); await w.brief.checkPending(true);
    expect(w.pending().filter((one) => one.account === "ca_g2").map((one) => one.messageId)).toEqual(["m1", "m2"]);
    expect(w.lastCard()).toContain("I couldn't read the email of admin@example.test.");
    expect(w.messageReads.filter((read) => read.account === "ca_g2")).toHaveLength(1);
  });

  it("shows one message in two inboxes once, and drops both copies when either thread holds the reply", async () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), copies: [copy("m1b", "ca_g2", "m1")] }]); w.brief.post(); await w.brief.checkPending(true);
    expect(w.lastCard().match(/Subject m1/g)).toHaveLength(1);
    expect(w.pending()).toHaveLength(2);
    w.threads["ca_g2/thread-m1b"] = [{ id: "r", at: w.now(), from: "admin@example.test" }];
    w.tick(DAY); w.brief.post(); await w.brief.checkPending(true);
    expect(w.pending()).toEqual([]);
  });

  it("finds a waiting email under the account that received it, so its reply is drafted from that account", () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), copies: [copy("m1b", "ca_g2", "m1")] }]); w.brief.post();
    expect(w.brief.emailsWithId("m1b").map((one) => one.account)).toEqual(["ca_g2"]);
    expect(w.brief.emailsWithId("m1").map((one) => one.account)).toEqual(["ca_g1"]);
    expect(actions(w.lastCard()).filter((one) => one.action.type === "draft_reply").map((one) => one.action.payload)).toEqual([{ messageId: "m1", account: "ca_g1" }]);
  });

  it("shows an important email that needs no reply in one brief only", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m2", false)]); w.brief.post(); await w.brief.checkPending(true);
    expect(w.lastCard()).toContain("Subject m2");
    expect(w.lastCard()).toContain("Why m2");
    w.tick(DAY); w.brief.post();
    expect(w.lastCard()).not.toContain("Subject m2");
  });

  it("releases every copy of a held important email once a delivered card shows it", () => {
    const w = briefWorld();
    w.brief.judged([pick("m2", false)]);
    w.brief.judged([{ ...pick("m2b", false), email: copy("m2b", "ca_g2", "m2") }]);
    expect(w.pending().map((one) => one.messageId)).toEqual(["m2", "m2b"]);
    w.brief.post();
    expect(w.lastCard().match(/Subject m2/g)).toHaveLength(1);
    expect(w.pending()).toEqual([]);
  });

  it("holds an important email for the next brief when it could not be re-read for this one", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m2", { needsReply: false })] });
    w.inbox.set("ca_g1/m2", new Error("Gmail did not answer"));
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    expect(again.lastCard()).not.toContain("Subject m2");
    expect(again.pending()).toEqual([entry("m2", { needsReply: false })]);
    again.inbox.delete("ca_g1/m2");
    again.tick(DAY); again.brief.post(); await again.brief.checkPending(true);
    expect(again.lastCard()).toContain("Subject m2");
    expect(again.pending()).toEqual([]);
  });

  it("checks the waiting emails once per brief", async () => {
    const w = briefWorld();
    await w.brief.checkPending(true);
    w.brief.judged([pick("m1", true)]); w.brief.post();
    await Promise.all([w.brief.checkPending(true), w.brief.checkPending(true)]);
    await w.brief.checkPending(true);
    expect(w.messageReads).toEqual([{ account: "ca_g1", id: "m1" }]);
  });

  it("lists routine results since the last brief: failures in Needs you, the rest under Routines", () => {
    const w = briefWorld();
    w.routines = [{ name: "Broken", status: "failed", line: "Token expired" }, { name: "Overnight numbers", status: "completed", line: "Revenue is up 4%." }];
    w.brief.post();
    const card = w.lastCard();
    expect(card.indexOf("Broken failed")).toBeLessThan(card.indexOf("Your day"));
    expect(card.indexOf("Overnight numbers")).toBeGreaterThan(card.indexOf("Routines"));
    expect(card.match(/Broken/g)).toHaveLength(1);
    expect(w.routinesAskedSince).toEqual([NOW - DAY]);
  });

  it("keeps the routine rows it was posted with, so a run that finishes later shows once, in the next brief", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true)]);
    w.meetings = null; w.brief.post();
    w.routines = [{ name: "Late run", status: "failed", line: "It failed", at: NOW + HOUR }];
    w.tick(2 * HOUR); w.meetings = [demo]; w.brief.refresh();
    expect(w.edits).toHaveLength(1);
    expect(w.lastCard()).not.toContain("Late run");
    await w.brief.checkPending(true);
    w.tick(5 * HOUR); w.brief.dismiss("ca_g1", "m1", w.briefRef());
    expect(w.lastCard()).not.toContain("Subject m1");
    expect(w.lastCard()).not.toContain("Late run");
    expect(w.routinesAskedSince).toEqual([NOW - DAY]);
    w.tick(DAY); w.brief.post();
    expect(w.lastCard().match(/Late run/g)).toHaveLength(1);
    expect(w.routinesAskedSince.at(-1)).toBe(NOW);
  });

  it("posts for routine results alone when no Google account is connected, and posts nothing when there is nothing at all", () => {
    const w = briefWorld();
    w.usable = {}; w.listed = true; w.routines = [];
    w.brief.post();
    expect(w.posts).toEqual([]);
    expect(w.brief.waiting()).toBe(false);
    w.routines = [{ name: "Overnight numbers", status: "completed", line: "Revenue is up 4%." }];
    w.brief.post();
    expect(w.posts).toHaveLength(1);
    expect(w.lastCard()).not.toContain("Your day");
  });

  it("dismisses an email from whichever card was pressed, and takes its row off today's brief", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true), pick("m2", true)]); w.brief.post(); await w.brief.checkPending(true);
    const today = w.posts.at(-1)!.messageId;
    const edits = w.edits.length;
    w.brief.dismiss("ca_g1", "m1", w.briefRef());
    expect(w.edits).toHaveLength(edits + 1);
    expect(w.lastCard()).not.toContain("Subject m1");
    w.brief.dismiss("ca_g1", "m2", w.briefRef());
    expect(w.edits).toHaveLength(edits + 2);
    expect(w.edits.slice(edits).map((edit) => edit.messageId)).toEqual([today, today]);
    expect(w.lastCard()).not.toContain("Subject m2");
    expect(w.pending()).toEqual([]);
  });

  it("dismisses an email still waiting from yesterday, with its copies, and takes the row off today's brief", async () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), copies: [copy("m1b", "ca_g2", "m1")] }]); w.brief.post(); await w.brief.checkPending(true);
    w.tick(DAY); w.brief.post(); await w.brief.checkPending(true);
    const today = w.posts.at(-1)!.messageId;
    expect(w.lastCard()).toContain("Subject m1");
    const edits = w.edits.length;
    w.brief.dismiss("ca_g1", "m1", w.briefRef(1));
    expect(w.pending()).toEqual([]);
    expect(w.edits.slice(edits).map((edit) => edit.messageId)).toEqual([today]);
    expect(w.lastCard()).not.toContain("Subject m1");
  });

  it("dismisses every copy of an email and an important one", async () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), copies: [copy("m1b", "ca_g2", "m1")] }, pick("m2", false)]); w.brief.post(); await w.brief.checkPending(true);
    w.brief.dismiss("ca_g2", "m1b", w.briefRef());
    expect(w.pending()).toEqual([]);
    w.brief.dismiss("ca_g1", "m2", w.briefRef());
    expect(w.lastCard()).not.toContain("Subject m");
  });

  it("edits only today's brief: a Dismiss on yesterday's drops the record and leaves that card as it was", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true)]); w.brief.post(); await w.brief.checkPending(true);
    const edits = w.edits.length;
    w.tick(DAY);
    w.brief.dismiss("ca_g1", "m1", w.briefRef());
    expect(w.edits).toHaveLength(edits);
    expect(w.pending()).toEqual([]);
  });

  it("changes nothing on a second Dismiss of the same email", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true)]); w.brief.post(); await w.brief.checkPending(true);
    w.brief.dismiss("ca_g1", "m1", w.briefRef());
    const edits = w.edits.length;
    w.brief.dismiss("ca_g1", "m1", w.briefRef());
    expect(w.edits).toHaveLength(edits);
  });

  it("after a restart, takes a dismissed row off today's brief and keeps the rest of that card, and drops every copy of the email", async () => {
    const w = briefWorld();
    w.routines = [{ name: "Overnight numbers", status: "completed", line: "Revenue is up 4%." }];
    w.brief.judged([{ ...pick("m1", true), copies: [copy("m1b", "ca_g2", "m1")] }, pick("m3", true), pick("m2", false)]);
    w.brief.post(); await w.brief.checkPending(true);
    const today = w.briefRef();
    const again = w.restart();
    again.brief.dismiss("ca_g1", "m1", today);
    expect(again.pending().map((one) => one.messageId)).toEqual(["m3"]);
    expect(again.edits.at(-1)!.messageId).toBe(today.messageId);
    const card = again.lastCard();
    expect(card).not.toContain("Subject m1");
    for (const kept of ["Subject m3", "Subject m2", "Demo with Jake", "Overnight numbers"]) expect(card).toContain(kept);
    expect(actions(card).filter((one) => one.action.type === "dismiss_email").map((one) => one.action.payload)).toEqual([{ messageId: "m3", account: "ca_g1" }, { messageId: "m2", account: "ca_g1" }]);
  });

  it("after a restart, says nothing needs you once the last row of Needs you is dismissed, and drops an emptied Important emails", async () => {
    const w = briefWorld();
    w.brief.mailChecked(true);
    w.brief.judged([pick("m1", true)]); w.brief.post(); await w.brief.checkPending(true);
    const again = w.restart();
    again.brief.dismiss("ca_g1", "m1", w.briefRef());
    expect(again.lastCard()).toContain("Nothing needs you right now.");
    const important = briefWorld();
    important.brief.judged([pick("m2", false)]); important.brief.post(); await important.brief.checkPending(true);
    const restarted = important.restart();
    restarted.brief.dismiss("ca_g1", "m2", important.briefRef());
    expect(restarted.lastCard()).not.toContain("Important emails");
    expect(restarted.lastCard()).not.toContain("Subject m2");
  });

  it("after a restart, leaves yesterday's brief as it was on a Dismiss pressed on it, and still drops the email", async () => {
    const w = briefWorld();
    w.brief.judged([pick("m1", true)]); w.brief.post(); await w.brief.checkPending(true);
    const yesterday = w.briefRef();
    w.tick(DAY);
    const again = w.restart();
    again.brief.dismiss("ca_g1", "m1", yesterday);
    expect(again.edits).toHaveLength(w.edits.length);
    expect(again.pending()).toEqual([]);
  });

  it("drops the waiting emails of an account no longer connected", async () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), email: mail("m1", "ca_g2") }]);
    w.usable = { gmail: [G1], googlecalendar: [C1] }; // ca_g2 removed in Settings
    w.brief.post(); await w.brief.checkPending(true);
    expect(w.pending()).toEqual([]);
    expect(w.messageReads.filter((read) => read.account === "ca_g2")).toEqual([]);
    expect(w.lastCard()).not.toContain("I couldn't read");
  });

  it("keeps the waiting emails of an account that is still listed but stopped working, names it, and does not read it", async () => {
    const w = briefWorld();
    w.brief.judged([{ ...pick("m1", true), email: mail("m1", "ca_g2") }]);
    w.usable = { gmail: [G1], googlecalendar: [C1, C2] }; w.expired = [{ ...G2, active: false }];
    w.brief.post(); await w.brief.checkPending(true);
    expect(w.pending().map((one) => one.account)).toEqual(["ca_g2"]);
    expect(w.messageReads).toEqual([]);
    expect(w.lastCard()).toContain("I couldn't read the email of admin@example.test.");
  });

  it("waits for the first account listing after a restart when nothing was seen connected before", () => {
    const w = briefWorld();
    w.listed = false; w.usable = {}; w.brief.post();
    expect(w.brief.waiting()).toBe(true);
    expect(w.posts).toEqual([]);
    w.listed = true; w.usable = { gmail: [G1], googlecalendar: [C1] }; w.brief.post();
    expect(w.brief.waiting()).toBe(false);
    expect(w.posts).toHaveLength(1);
  });

  it("keeps the local day and the routine window across midnight and a restart", () => {
    const w = briefWorld();
    const lateCall: Meeting = { ...demo, id: "late", title: "Late call", start: Date.parse("2026-10-21T18:00:00.000Z"), end: Date.parse("2026-10-21T19:00:00.000Z") }; // 23:30 to 00:30 local
    const earlyCall: Meeting = { ...demo, id: "early", title: "Early call", start: Date.parse("2026-10-21T19:00:00.000Z"), end: Date.parse("2026-10-21T19:30:00.000Z") }; // 00:30 local on the 22nd
    w.meetings = [lateCall, earlyCall];
    w.brief.post();
    const firstPostAt = w.now();
    expect(w.lastCard()).toContain("Late call");
    expect(w.lastCard()).not.toContain("Early call");
    const again = w.restart();
    again.tick(Date.parse("2026-10-21T18:20:00.000Z") - firstPostAt); // 23:50 local
    again.brief.post();
    expect(again.posts).toHaveLength(1);
    again.tick(25 * MINUTE); // 00:15 local on the 22nd, still the 21st in UTC
    again.brief.post();
    expect(again.posts).toHaveLength(2);
    expect(again.routinesAskedSince.at(-1)).toBe(firstPostAt);
    expect(again.lastCard()).toContain("Early call");
    expect(again.lastCard()).not.toContain("Late call");
  });

  it("posts the brief as plain text when its card is refused, and counts the day only once a brief has posted", () => {
    const w = briefWorld();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    w.refuse = () => true;
    w.brief.judged([pick("m1", true)]); w.brief.post();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the daily brief was not posted"));
    expect(w.posts).toEqual([]);
    expect(w.state.get().lastBriefDate).toBeUndefined();
    expect(w.brief.due()).toBe(true);
    w.refuse = (built) => JSON.stringify(built.card).includes('"Button"');
    w.tick(15 * MINUTE); w.brief.post();
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("so its plain version was posted"));
    expect(w.posts).toHaveLength(1);
    expect(w.lastCard()).toContain("Subject m1");
    expect(w.lastCard()).not.toContain('"Button"');
    expect(w.state.get().lastBriefDate).toBe("2026-10-21");
    w.brief.dismiss("ca_g1", "m1", w.briefRef());
    expect(w.edits).toHaveLength(1);
    expect(w.lastCard()).not.toContain("Subject m1");
    expect(w.lastCard()).not.toContain('"Button"');
  });

  it("waits a quarter of an hour after a brief could not be posted before it tries again", () => {
    const w = briefWorld();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    w.refuse = () => true;
    w.brief.post();
    const attempts = w.postAttempts;
    w.tick(MINUTE); w.brief.post();
    w.tick(MINUTE); w.brief.post();
    expect(w.postAttempts).toBe(attempts);
    expect(warn).toHaveBeenCalledTimes(1);
    w.refuse = () => false;
    w.tick(13 * MINUTE); w.brief.post();
    expect(w.posts).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("closes the mail window half an hour after the brief posts, so later mail gets its own card", () => {
    const w = briefWorld();
    w.brief.post();
    w.tick(2 * HOUR);
    expect(w.brief.judged([pick("m1", false)]).map((one) => one.email.id)).toEqual(["m1"]);
    expect(w.edits).toEqual([]);
  });

  it("shows the calendar read before a check ends the in-place window, whatever order the check reports in", () => {
    const w = briefWorld();
    w.meetings = null; w.brief.post();
    w.meetings = [demo]; w.brief.checked(NOW);
    expect(w.lastCard()).toContain("Demo with Jake");
    expect(w.lastCard()).not.toContain("Checking your calendar…");
    w.meetings = []; w.brief.checked(NOW); w.brief.refresh();
    expect(w.edits).toHaveLength(1);
  });

  it("keeps a held important email in assistant.json until a delivered card has shown it, across a restart", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m2", { needsReply: false })] });
    const again = w.restart(); again.brief.post();
    expect(again.lastCard()).not.toContain("Subject m2");
    expect(again.restart().pending()).toEqual([entry("m2", { needsReply: false })]);
    await again.brief.checkPending(true);
    expect(again.lastCard()).toContain("Subject m2");
    expect(again.pending()).toEqual([]);
  });

  it("keeps mail folded into the brief held when the edit that would show it is refused", () => {
    const w = briefWorld();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    w.brief.post(); w.refuse = () => true;
    expect(w.brief.judged([pick("m3", false)])).toEqual([]);
    expect(w.pending()).toEqual([entry("m3", { needsReply: false, copyGroup: copyGroupOf("<m3@example.test>") })]);
  });

  it("counts the waiting emails it cannot show for an account it cannot read, and never says nothing needs you", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m1", { account: "ca_g2" }), entry("m2", { account: "ca_g2" })] });
    w.inbox.set("ca_g2/m1", new Error("token expired"));
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    expect(again.lastCard()).toContain("2 emails waiting in admin@example.test, which can't be read right now");
    expect(again.lastCard()).not.toContain("Nothing needs you right now.");
    expect(again.lastSummary()).not.toContain("nothing needs you");
    const expired = w.restart();
    expired.usable = { gmail: [G1], googlecalendar: [C1, C2] }; expired.expired = [{ ...G2, active: false }];
    expired.tick(DAY); expired.brief.post();
    expect(expired.lastCard()).toContain("2 emails waiting in admin@example.test, which can't be read right now");
  });

  it("keeps counting a waiting email whose re-read failed after a restart, and names its account, though a later inbox read of that account succeeds", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m1")] });
    w.inbox.set("ca_g1/m1", new Error("Gmail did not answer"));
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    again.readState.set("ca_g1", "ok");
    again.brief.checked(NOW);
    const card = again.lastCard();
    expect(card).toContain("1 email waiting in me@example.test, which can't be read right now");
    expect(card).toContain("I couldn't read the email of me@example.test.");
    expect(card).not.toContain("Nothing needs you right now.");
    expect(again.lastSummary()).not.toContain("nothing needs you");
  });

  it("reads a waiting email it could not re-read again at the next check, shows its row once it can, then stops reading it", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m1")] });
    w.inbox.set("ca_g1/m1", new Error("Gmail did not answer"));
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    again.readState.set("ca_g1", "ok");
    again.inbox.delete("ca_g1/m1");
    again.tick(15 * MINUTE); await again.brief.checkPending(true);
    const card = again.lastCard();
    expect(card).toContain("Subject m1");
    expect(card).not.toContain("can't be read right now");
    expect(card).not.toContain("I couldn't read the email");
    again.tick(15 * MINUTE); await again.brief.checkPending(true);
    expect(again.messageReads.filter((read) => read.id === "m1")).toHaveLength(2);
  });

  it("names the account of a held important email it could not re-read, so the brief never looks complete", async () => {
    const w = briefWorld();
    w.state.patch({ pendingEmails: [entry("m2", { needsReply: false })] });
    w.inbox.set("ca_g1/m2", new Error("Gmail did not answer"));
    const again = w.restart(); again.brief.post(); await again.brief.checkPending(true);
    again.readState.set("ca_g1", "ok");
    again.brief.checked(NOW);
    expect(again.lastCard()).toContain("I couldn't read the email of me@example.test.");
  });

  it("edits the brief in place only until a check that started after it has finished, unless email or Dismiss changes it", async () => {
    const w = briefWorld();
    w.meetings = null; w.brief.post();
    w.brief.checked(NOW - MINUTE);
    w.meetings = [demo]; w.brief.refresh();
    expect(w.edits).toHaveLength(1);
    w.brief.checked(NOW);
    w.meetings = []; w.brief.refresh();
    expect(w.edits).toHaveLength(1);
    expect(w.brief.judged([pick("m1", false)])).toEqual([]);
    expect(w.edits).toHaveLength(2);
  });

  it("keeps the newest waiting emails assistant.json can hold, and hands back an email it cannot store", () => {
    const w = briefWorld();
    const many = Array.from({ length: MAX_PENDING_EMAILS + 30 }, (_, n) => pick(`m${n}`, true));
    expect(w.brief.judged(many)).toEqual([]);
    expect(w.pending()).toHaveLength(MAX_PENDING_EMAILS);
    expect(w.pending().at(-1)!.messageId).toBe(`m${MAX_PENDING_EMAILS + 29}`);
    const long = { ...pick("long", true), email: { ...mail("long"), threadId: "t".repeat(MAX_ID_LENGTH + 1) } };
    expect(w.brief.judged([long])).toEqual([long]);
    expect(w.pending().some((one) => one.messageId === "long")).toBe(false);
  });
});
