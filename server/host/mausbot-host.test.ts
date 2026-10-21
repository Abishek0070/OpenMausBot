import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { CALENDARS_TOOL } from "../assistant-sources.ts";
import { DATA_DIR, type AppConfig } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { findMausBot, seedBots } from "../mausbot.ts";
import type { RequestAuth } from "../request-auth.ts";
import { Store, type Message } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { DEFAULT_CHECK_MS } from "./assistant-plan.ts";
import { createBriefState } from "./brief-state.ts";
import { assistantCheckMs, createMausBotHost, jobReply, type MausBotHostDeps } from "./mausbot-host.ts";

const sonnet: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const HOUR = 60 * 60_000;
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const member = { kind: "session", scopes: ["client"], via: "bearer", session: { id: "s1" } } as unknown as RequestAuth;
const dirs: string[] = [];
const hosts: Array<{ stop(): void }> = [];
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const line = (fields: Partial<Message>): Message => ({ id: `m${Math.random()}`, at: 1, role: "bot", kind: "text", ...fields }) as Message;

describe("jobReply", () => {
  it("is the bot's text in that turn only: never the prompt, a tool's output or another turn's words", () => {
    const thread = [
      line({ role: "user", text: "[MausBot prep demo-1] the prompt", turnId: "turn-1" }),
      line({ text: "an earlier turn", turnId: "turn-0" }),
      line({ kind: "activity", text: "tool output", tool: { name: "WebSearch", ok: true }, turnId: "turn-1" }),
      line({ text: "Looking it up.", turnId: "turn-1" }),
      line({ text: '{"brief": "Who: Jake"}', turnId: "turn-1" }),
    ];
    expect(jobReply(thread, "turn-1")).toBe('Looking it up.\n\n{"brief": "Who: Jake"}');
  });

  it("is empty when the turn cannot be named", () => {
    expect(jobReply([line({ text: "a line from no turn" }), line({ text: '{"brief": "Who: Jake"}', turnId: "turn-1" })], undefined)).toBe("");
  });
});

describe("assistantCheckMs", () => {
  it("reads OMB_ASSISTANT_CHECK_MS, never below a second, and fifteen minutes when it is unset or not a number", () => {
    expect([assistantCheckMs(undefined), assistantCheckMs("abc"), assistantCheckMs("0"), assistantCheckMs("500"), assistantCheckMs("2500")])
      .toEqual([DEFAULT_CHECK_MS, DEFAULT_CHECK_MS, DEFAULT_CHECK_MS, 1_000, 2_500]);
  });
});

/** A calendar with one meeting an hour out, served the way Composio's multi-execute tool answers. */
function connectedApps(): MausBotHostDeps["composio"] {
  const event = {
    id: "demo-1", iCalUID: "demo-1", status: "confirmed", summary: "Supamaus demo with Jake",
    start: { dateTime: new Date(Date.now() + HOUR).toISOString() }, end: { dateTime: new Date(Date.now() + 2 * HOUR).toISOString() },
    attendees: [{ email: "me@example.test", self: true }, { email: "jake@pin.example", displayName: "Jake Price" }],
  };
  const answer = (id: unknown, result: unknown) => ({ status: 200, contentType: "application/json", bytes: new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id, result })) });
  return {
    configured: () => true,
    connectedServices: async () => ({ googlecalendar: { connected: true, pending: false, status: "ACTIVE", accounts: [] }, gmail: { connected: false, pending: false, status: "not_connected", accounts: [] } }),
    relayMcp: async (_cfg, payload) => {
      const frame = payload as { id?: unknown; method?: string; params?: { arguments?: { tools?: Array<{ tool_slug?: string }> } } };
      if (frame.method !== "tools/call") return answer(frame.id, {});
      const slug = frame.params?.arguments?.tools?.[0]?.tool_slug;
      const data = slug === CALENDARS_TOOL ? { items: [{ id: "me@example.test", primary: true, accessRole: "owner" }] } : { items: [event] };
      const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response: { successful: true, data, error: null } }] } });
      return answer(frame.id, { content: [{ type: "text", text }] });
    },
  };
}

function setup(options: { cloudHome?: boolean; ownerOnly?: (threadId: string) => boolean; introduced?: boolean; hosted?: boolean } = {}) {
  const store = new Store(() => sonnet);
  seedBots(store, { hosted: false });
  const mausbot = findMausBot(store.bots)!;
  const scout = store.createBot({ name: "Scout" });
  const dataDir = mkdtempSync(join(tmpdir(), "omb-mausbot-host-"));
  dirs.push(dataDir);
  const briefState = createBriefState(join(dataDir, "brief.json"));
  briefState.patch({ timeZone: "UTC", ...(options.introduced === false ? {} : { mausbotIntro: { at: 1, threadId: mausbot.threadId } }) });
  const composio = connectedApps();
  const connectedServices = vi.spyOn(composio, "connectedServices");
  const started: Array<{ botId: string; text: string; opts: { threadId: string; unattended: true; trigger: unknown } }> = [];
  const createTask = vi.spyOn(store, "createTask");
  const patchTask = vi.spyOn(store, "patchTask");
  const cfg = { features: {} } as AppConfig;
  let othersMaySee = false;
  const host = createMausBotHost({
    store, cfg, composio, dataDir, hosted: options.hosted ?? false, cloudHome: options.cloudHome ?? false, maxBots: 50,
    registry: { get: () => ({ adapter: { capabilities: { agentsMcp: true, composioMcp: true } } }) } as unknown as MausBotHostDeps["registry"],
    brief: { state: briefState, chiefThread: (bot) => bot.threadId, turnsByBot: () => new Map(), noteAssistantCard: vi.fn(), routineRows: () => [] },
    notify: vi.fn(), threadBusy: () => false, newId: () => `id-${Math.random().toString(36).slice(2)}`,
    startTurn: async (botId, text, opts) => { started.push({ botId, text, opts }); },
    interruptDirectThread: vi.fn(async () => {}),
    cloudOwnerOnlyThread: options.ownerOnly ?? (() => true),
    othersMaySee: () => othersMaySee,
    checkMs: HOUR,
  });
  hosts.push(host);
  const cards = () => store.messagesFor(mausbot.threadId).filter((row) => row.kind === "widget").map((row) => row.widget!.root as unknown as { title: string });
  /** Plays the job turn the host started: its prompt, an earlier turn's words, a tool's output, then the reply. */
  const finish = (threadId: string, reply: string) => {
    store.appendMessage(threadId, { role: "user", kind: "text", text: started[0]!.text });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: '{"brief": "an earlier turn"}', turnId: "turn-0" });
    store.appendMessage(threadId, { role: "bot", kind: "activity", tool: { name: "WebSearch", ok: true }, turnId: "turn-1" });
    store.appendMessage(threadId, { role: "bot", kind: "text", text: reply, turnId: "turn-1" });
    host.onEvent({ type: "turn.completed", threadId, turnId: "turn-1", ok: true } as RuntimeEvent);
  };
  const membersSignIn = () => { othersMaySee = true; };
  const switchOff = () => { cfg.features = { ...cfg.features, assistantActs: false }; };
  return { store, mausbot, scout, host, started, createTask, patchTask, cards, finish, connectedServices, briefState, membersSignIn, switchOff };
}

describe("createMausBotHost", () => {
  it("stays silent until its intro is posted, then the first presence posts the intro before any watcher card", async () => {
    const w = setup({ introduced: false });
    w.host.start();
    expect(w.connectedServices).not.toHaveBeenCalled();
    expect(w.store.messagesFor(w.mausbot.threadId)).toEqual([]);
    w.host.introduce();
    expect(w.briefState.get().mausbotIntro).toMatchObject({ threadId: w.mausbot.threadId });
    w.host.onPresence({ source: "desktop", returned: false });
    await expect.poll(() => w.started.length).toBe(1);
    w.finish(w.started[0]!.opts.threadId, JSON.stringify({ brief: "Who: Jake Price.", relatedThreadId: "", noWebSearch: false }));
    await expect.poll(() => w.cards().map((card) => card.title)).toContain("Prep: Supamaus demo with Jake");
    const rows = w.store.messagesFor(w.mausbot.threadId);
    expect(rows[0]).toMatchObject({ kind: "text", text: expect.stringContaining("Hi, I'm MausBot") });
    expect(rows.findIndex((row) => row.kind === "widget")).toBeGreaterThan(0);
  });

  it("runs a job in one hidden Ask thread created in a single write, unattended, and posts the card from that turn's reply alone", async () => {
    const w = setup();
    w.host.start();
    await expect.poll(() => w.started.length).toBe(1);
    const [job] = w.started;
    expect(w.createTask).toHaveBeenCalledTimes(1);
    expect(w.createTask.mock.calls[0]).toEqual([w.mausbot.id, "Prep: Supamaus demo with Jake", false, undefined, undefined, "ask", undefined, undefined, expect.stringMatching(/^mausbot-/)]);
    expect(w.patchTask.mock.calls.some(([, threadId]) => threadId === job!.opts.threadId)).toBe(false);
    expect(job).toMatchObject({ botId: w.mausbot.id, opts: { unattended: true, trigger: { kind: "routine", label: "MausBot" } } });
    expect(job!.text).toContain("[MausBot prep demo-1]");
    const task = w.store.taskByThread(w.mausbot.id, job!.opts.threadId)!;
    expect(task).toMatchObject({ routineRunId: expect.stringMatching(/^mausbot-/), approvalMode: "ask", unread: false });
    expect(w.store.bot(w.mausbot.id)!.threadId).not.toBe(job!.opts.threadId);

    w.finish(job!.opts.threadId, JSON.stringify({ brief: "Who: Jake Price, from this turn.", relatedThreadId: "", noWebSearch: false }));
    await expect.poll(() => w.cards().map((card) => card.title)).toEqual(["Prep: Supamaus demo with Jake"]);
    const card = JSON.stringify(w.cards()[0]);
    expect(card).toContain("from this turn");
    expect(card).not.toContain("an earlier turn");
  });

  it.each([
    { cloudHome: false, guest: false, opens: true },
    { cloudHome: true, guest: false, opens: true },
    { cloudHome: true, guest: true, opens: false },
  ])("opens a related chat on a Cloud home=$cloudHome only when no guest drove it (guest=$guest)", async ({ cloudHome, guest, opens }) => {
    let related = "";
    const w = setup({ cloudHome, ownerOnly: (threadId) => !(guest && threadId === related) });
    related = w.scout.threadId;
    w.host.start();
    await expect.poll(() => w.started.length).toBe(1);
    w.finish(w.started[0]!.opts.threadId, JSON.stringify({ brief: "Who: Jake Price.", relatedThreadId: related, noWebSearch: false }));
    await expect.poll(() => w.cards().length).toBe(1);
    expect(JSON.stringify(w.cards()[0]).includes(`"threadId":"${related}"`)).toBe(opens);
  });

  it("answers a press with MausBot's records only on MausBot's own cards", async () => {
    const w = setup();
    w.host.start();
    await expect.poll(() => w.started.length).toBe(1);
    const action = { type: "prep_notes", payload: { eventId: "demo-1" } };
    expect(w.host.pressRecords(w.mausbot, action)).toContain("Records from Google Calendar");
    expect(w.host.pressRecords(w.scout, action)).toBeNull();
    expect(w.host.pressRecords(w.mausbot, { type: "prep_notes", payload: { eventId: "not-on-the-calendar" } })).toBeNull();
  });

  it("answers a Dismiss on MausBot's brief itself for the owner or an admin, refuses a member, and leaves every other press alone", () => {
    const w = setup();
    const dismiss = { type: "dismiss_email", payload: { messageId: "m1", account: "g1" } };
    expect(w.host.serverPress(w.mausbot, w.mausbot.threadId, "brief-1", dismiss, owner)).toBe("handled");
    expect(w.host.serverPress(w.mausbot, w.mausbot.threadId, "brief-1", dismiss, member)).toBe("refused");
    expect(w.host.serverPress(w.scout, w.scout.threadId, "card-1", dismiss, owner)).toBeNull();
    expect(w.host.serverPress(w.mausbot, w.mausbot.threadId, "brief-1", { type: "draft_reply", payload: { messageId: "m1", account: "g1" } }, owner)).toBeNull();
    expect(w.store.messagesFor(w.mausbot.threadId)).toEqual([]);
    expect(w.started).toEqual([]);
  });

  it("moves routine runs to MausBot's brief on a single-person install with no sign-in, whoever can see the recap's poster", () => {
    const w = setup();
    expect(w.host.takesRoutines({ visibility: "admins" })).toBe(true);
    expect(w.host.takesRoutines({ visibility: "everyone" })).toBe(true);
  });

  it("keeps routine runs in the recap on a self-hosted server where members can see the Chief", () => {
    const w = setup();
    w.membersSignIn();
    expect(w.host.takesRoutines({ visibility: "everyone" })).toBe(false);
    expect(w.host.takesRoutines({ visibility: { people: ["bob@example.test"] } })).toBe(false);
    expect(w.host.takesRoutines({ visibility: "admins" })).toBe(true);
  });

  it("keeps routine runs in the recap with MausBot's switch off, before its intro, and on a hosted workspace", () => {
    const off = setup();
    off.switchOff();
    expect(off.host.takesRoutines({ visibility: "admins" })).toBe(false);
    expect(setup({ introduced: false }).host.takesRoutines({ visibility: "admins" })).toBe(false);
    expect(setup({ hosted: true }).host.takesRoutines({ visibility: "admins" })).toBe(false);
  });
});
