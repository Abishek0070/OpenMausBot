import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BotVisibility, ThreadOwner } from "../bot-visibility.ts";
import type { ModelSelection } from "../contracts.ts";
import type { RoutineRun } from "../routines.ts";
import { Store, type Message } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { usageFileFor } from "../usage-ledger.ts";
import { activePathTail, createChiefBrief, presenceOwner, type ChiefBriefDeps } from "./chief-brief.ts";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 9, 15, 8, 0, 0);
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

type WorldBot = { id: string; name: string; section?: string; chiefOfStaff?: boolean; hidden?: boolean; visibility?: BotVisibility };
type WorldRoom = { id: string; threadId: string; memberIds: string[]; audienceFloor?: BotVisibility };

function world(bots: WorldBot[], options: {
  recap?: boolean; runs?: (since: number) => RoutineRun[]; patchTaskFails?: boolean; rooms?: WorldRoom[]; hosted?: boolean; mausbot?: string;
  onPresence?: ChiefBriefDeps["onPresence"]; beforePresence?: ChiefBriefDeps["beforePresence"];
} = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-chief-brief-"));
  dirs.push(dataDir);
  const messages = new Map<string, Message[]>();
  const tasks = new Map(bots.map((bot) => [bot.id, [{ threadId: `${bot.id}-main`, title: "Main", createdAt: 1, updatedAt: NOW - 30 * 60_000 }]]));
  const rooms = options.rooms ?? [];
  const leaves = new Map<string, string>();
  const unread: string[] = [];
  const store = {
    bots: bots.map((bot) => ({ ...bot, threadId: `${bot.id}-main`, color: "green" })),
    bot: (id: string) => store.bots.find((bot) => bot.id === id) ?? null,
    tasks: (id: string) => tasks.get(id) ?? [],
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    messagesTail: (threadId: string, n: number) => {
      const all = messages.get(threadId) ?? [];
      return { messages: all.slice(-n), hasMore: all.length > n, activeLeafId: leaves.get(threadId) ?? all.at(-1)?.id ?? null };
    },
    appendMessage: (threadId: string, message: Omit<Message, "id" | "at">) => {
      const before = messages.get(threadId) ?? [];
      const full = { id: `m${messages.size}-${before.length}`, at: NOW, parentId: before.at(-1)?.id ?? null, ...message } as Message;
      messages.set(threadId, [...before, full]);
      return full;
    },
    patchMessage: () => null,
    patchTask: (_botId: string, threadId: string) => {
      if (options.patchTaskFails) throw new Error("bots.json is read-only");
      unread.push(threadId);
      return null;
    },
    group: (id: string) => rooms.find((room) => room.id === id),
    groupByThread: (threadId: string) => rooms.find((room) => room.threadId === threadId),
  } as unknown as Store;
  const threadOwner = (threadId: string): ThreadOwner | undefined => {
    const owner = bots.find((bot) => (tasks.get(bot.id) ?? []).some((task) => task.threadId === threadId) || threadId.startsWith(`${bot.id}-`));
    if (owner) return { bot: owner.id };
    const room = rooms.find((candidate) => candidate.threadId === threadId);
    return room ? { group: room.id } : undefined;
  };
  let now = NOW;
  const start = () => createChiefBrief({
    store, dataDir, now: () => now,
    settings: () => ({ recap: options.recap ?? true, awayMs: 3 * HOUR }),
    threadOwner, hosted: options.hosted ?? false,
    threadBusy: () => false,
    routineRuns: options.runs ?? (() => []),
    mausbot: () => (options.mausbot ? store.bot(options.mausbot) : null),
    onPresence: options.onPresence,
    beforePresence: options.beforePresence,
  });
  const brief = start();
  // A finished turn: its digest row, and the thread's `updatedAt` moved to it, as the store does on append.
  const digest = (botId: string, at: number, reply: string, id = `d-${botId}`, parentId: string | null = null) =>
    ({ id, at, parentId, role: "bot", kind: "digest", text: "[digest]", turnSucceeded: true, digest: { turnId: "t", botId, threadId: `${botId}-main`, at, durationMs: 1, tools: [], memory: [], reply, hookCoverage: "none" } } as unknown as Message);
  const digestFor = (botId: string, at: number) => {
    tasks.get(botId)![0]!.updatedAt = at;
    messages.set(`${botId}-main`, [digest(botId, at, `${botId} finished a job.`)]);
  };
  // Two turns forked from one message; the person switched back to the older branch.
  const branchesFor = (botId: string, at: number) => {
    tasks.get(botId)![0]!.updatedAt = at + 1;
    const root = { id: `r-${botId}`, at: at - 1, parentId: null, role: "user", kind: "text", text: "go" } as Message;
    messages.set(`${botId}-main`, [root, digest(botId, at, "kept branch work", "kept", root.id), digest(botId, at + 1, "abandoned branch work", "abandoned", root.id)]);
    leaves.set(`${botId}-main`, "kept");
  };
  const usage = (rows: Array<[string, number]>) => {
    mkdirSync(join(dataDir, "usage"), { recursive: true });
    writeFileSync(usageFileFor(dataDir, new Date(NOW)), rows.flatMap(([botId, turns]) => Array.from({ length: turns }, () =>
      JSON.stringify({ at: new Date(NOW - HOUR).toISOString(), botId, botName: botId, threadId: "t", instanceId: "i", driverKind: "fake", model: "m", input: 1, output: 1, costUsd: null, trigger: { kind: "owner" } }))).join("\n") + "\n");
  };
  const widgets = (threadId: string) => (messages.get(threadId) ?? []).filter((line) => line.kind === "widget");
  return { brief, restart: start, store, messages, widgets, digestFor, branchesFor, usage, unreadThreads: () => unread, tick: (ms: number) => { now += ms; }, dataDir };
}

describe("presenceOwner", () => {
  it("is the desktop app or an admin session, never a service, a bot's shell or a guest", () => {
    expect(presenceOwner({ kind: "loopback", scopes: ["admin", "client"] })).toBe(true);
    expect(presenceOwner({ kind: "loopback", scopes: ["client"], trust: "service" })).toBe(false);
    expect(presenceOwner({ kind: "loopback", scopes: ["admin", "client"], trust: "service" })).toBe(false);
    expect(presenceOwner({ kind: "session", scopes: ["admin", "client"], via: "bearer", session: {} as never })).toBe(true);
    expect(presenceOwner({ kind: "session", scopes: ["client"], via: "cookie", session: {} as never })).toBe(false);
  });
});

describe("activePathTail", () => {
  const row = (id: string, parentId: string | null, at: number): Message => ({ id, parentId, at, role: "bot", kind: "text", text: id } as Message);

  it("keeps only the rows on the branch the person is looking at, oldest first", () => {
    // root → a1 → a2 is the old branch; an edit forked root → b1 → b2 later, so both branches share the tail.
    const rows = [row("root", null, 1), row("a1", "root", 2), row("a2", "a1", 3), row("b1", "root", 4), row("b2", "b1", 5)];
    const store = (activeLeafId: string | null) => ({ messagesTail: (_threadId: string, n: number) => ({ messages: rows.slice(-n), hasMore: rows.length > n, activeLeafId }) });
    expect(activePathTail(store("b2"), "t", 40).map((line) => line.id)).toEqual(["root", "b1", "b2"]);
    expect(activePathTail(store("a2"), "t", 40).map((line) => line.id)).toEqual(["root", "a1", "a2"]);
    expect(activePathTail(store("b2"), "t", 3).map((line) => line.id)).toEqual(["b1", "b2"]);
    expect(activePathTail(store("a2"), "t", 2)).toEqual([]);
    expect(activePathTail(store(null), "t", 40)).toEqual([]);
  });

  it("follows the real store across an edit, cached and freshly loaded", () => {
    const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
    const store = new Store(selection);
    const bot = store.createBot();
    const greeting = store.messagesFor(bot.threadId).map((line) => line.text);
    const original = store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "v1" });
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v1" });
    store.branchMessage(bot.threadId, original.id, "v2");
    store.appendMessage(bot.threadId, { role: "bot", kind: "text", text: "answer to v2" });
    expect(store.messagesTail(bot.threadId, 40).messages.map((line) => line.text)).toEqual(expect.arrayContaining(["v1", "answer to v1"]));
    const texts = (from: Pick<Store, "messagesTail">) => activePathTail(from, bot.threadId, 40).map((line) => line.text);
    expect(texts(store)).toEqual([...greeting, "v2", "answer to v2"]);
    expect(texts(new Store(selection))).toEqual([...greeting, "v2", "answer to v2"]);
  });
});

describe("createChiefBrief", () => {
  it("picks the General team's Chief, else the Chief of the team used most", () => {
    const w = world([{ id: "a", name: "A", section: "Sales", chiefOfStaff: true }, { id: "b", name: "B", section: "Dev", chiefOfStaff: true }, { id: "c", name: "C", section: "Dev" }]);
    w.usage([["c", 5], ["a", 2]]);
    expect(w.brief.chief()?.id).toBe("b");
    expect([...w.brief.turnsByBot().entries()]).toEqual([["c", 5], ["a", 2]]);
    const general = world([{ id: "g", name: "G", chiefOfStaff: true }, { id: "a", name: "A", section: "Sales", chiefOfStaff: true }]);
    expect(general.brief.chief()?.id).toBe("g");
    expect(world([{ id: "x", name: "X" }]).brief.chief()).toBeNull();
  });

  it("keeps the turn counts for ten minutes, and reads them again when the clock moves back", () => {
    const w = world([{ id: "a", name: "A", section: "Sales", chiefOfStaff: true }, { id: "b", name: "B", section: "Dev", chiefOfStaff: true }]);
    w.usage([["a", 2]]);
    expect(w.brief.chief()?.id).toBe("a");
    w.usage([["b", 3]]);
    w.tick(10 * 60_000 - 1);
    expect(w.brief.chief()?.id).toBe("a");
    expect([...w.brief.turnsByBot()]).toEqual([["a", 2]]);
    w.tick(1);
    expect(w.brief.chief()?.id).toBe("b");
    expect([...w.brief.turnsByBot()]).toEqual([["b", 3]]);
    w.usage([["a", 4]]);
    w.tick(-1);
    expect([...w.brief.turnsByBot()]).toEqual([["a", 4]]);
  });

  it("posts one recap card as the Chief on a return, marks the chat unread and remembers the card", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    expect(w.brief.active("desktop", "Asia/Kolkata")).toEqual({ returned: false });
    expect(w.brief.state.get().timeZone).toBe("Asia/Kolkata");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open: { botId: "chief", threadId: "chief-main" } });
    const cards = w.widgets("chief-main");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.text).toContain("**Since you last looked**");
    expect(cards[0]!.text).toContain("Scout · scout finished a job.");
    expect(cards[0]).not.toHaveProperty("from");
    expect(cards[0]).toMatchObject({ serverCard: true });
    expect(w.unreadThreads()).toEqual(["chief-main"]);
    expect(w.brief.state.get().lastCard).toMatchObject({ botId: "chief", threadId: "chief-main", kind: "recap" });
    // the other client returning a moment later gets the same card to open, and no second card
    expect(w.brief.active("phone")).toEqual({ returned: false, open: { botId: "chief", threadId: "chief-main" } });
    expect(w.widgets("chief-main")).toHaveLength(1);
    // a later ping, with nothing new, opens nothing
    w.tick(60_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
    expect(w.brief.active("phone")).toEqual({ returned: false });
  });

  it("tells each client once about the card a return posted, whatever activations come between", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    const open = { botId: "chief", threadId: "chief-main" };
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("phone")).toEqual({ returned: true, open });
    w.tick(1_000);
    expect(w.brief.active("phone")).toEqual({ returned: false });
    w.tick(1_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false, open });
    w.tick(60_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
    expect(w.brief.active("phone")).toEqual({ returned: false });
    expect(w.widgets("chief-main")).toHaveLength(1);
  });

  it("after a restart with no return since, offers no card older than the last activation", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toMatchObject({ returned: true, open: { botId: "chief", threadId: "chief-main" } });
    w.tick(2 * 60_000);
    w.brief.active("desktop");
    w.tick(60_000);
    const restarted = w.restart();
    expect(restarted.active("desktop")).toEqual({ returned: false });
    expect(restarted.active("phone")).toEqual({ returned: false });
  });

  it("posts nothing with no Chief, with the recap off, or when nothing happened", () => {
    const quiet = world([{ id: "chief", name: "Chief", chiefOfStaff: true }]);
    quiet.brief.active("desktop");
    quiet.tick(4 * HOUR);
    expect(quiet.brief.active("desktop")).toEqual({ returned: true });
    expect(quiet.messages.get("chief-main") ?? []).toEqual([]);
    const headless = world([{ id: "scout", name: "Scout" }]);
    headless.brief.active("desktop");
    headless.tick(4 * HOUR);
    headless.digestFor("scout", NOW + HOUR);
    expect(headless.brief.active("desktop")).toEqual({ returned: true });
    expect(headless.messages.get("scout-main")!.some((line) => line.kind === "widget")).toBe(false);
  });

  it("posts nothing when the recap setting is off", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }], { recap: false });
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true });
    expect(w.widgets("chief-main")).toEqual([]);
    expect(w.brief.state.get().lastCard).toBeUndefined();
  });

  it("never reports the Chief's own conversation as finished work", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("chief", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true });
    expect(w.widgets("chief-main")).toEqual([]);
  });

  it("reports only the branch of a conversation the person is viewing", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.branchesFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toMatchObject({ returned: true });
    const text = w.widgets("chief-main")[0]!.text!;
    expect(text).toContain("kept branch work");
    expect(text).not.toContain("abandoned branch work");
  });

  it("writes the away time in the person's own zone and lists the routine runs it is given since the absence began", () => {
    const run = { id: "run1", routineId: "rt1", routineName: "Inbox check", status: "completed", target: "bot", botId: "scout", threadId: "scout-run", scheduledFor: NOW - HOUR, finishedAt: NOW + HOUR } as RoutineRun;
    const runs = vi.fn((_since: number) => [run]);
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }], { runs });
    w.brief.active("desktop", "America/Los_Angeles");
    w.tick(4 * HOUR);
    expect(w.brief.active("desktop")).toMatchObject({ returned: true });
    expect(runs).toHaveBeenCalledWith(NOW);
    const text = w.widgets("chief-main")[0]!.text!;
    expect(text).toMatch(/Away since Thu 1:00\sAM/);
    expect(text).toContain("Inbox check");
  });

  it("still posts the card, and answers the client, when the state file cannot be saved", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.brief.active("desktop");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const patch = vi.spyOn(w.brief.state, "patch").mockImplementation(() => { throw new Error("disk full"); });
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop", "Asia/Kolkata")).toEqual({ returned: true, open: { botId: "chief", threadId: "chief-main" } });
    expect(patch).toHaveBeenCalledTimes(2);
    expect(w.widgets("chief-main")).toHaveLength(1);
    expect(w.unreadThreads()).toEqual(["chief-main"]);
    expect(w.brief.postRecap(NOW)).toBe(true);
    expect(w.widgets("chief-main")).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(w.brief.state.get().lastCard).toBeUndefined();
  });

  it("records the card and still offers it when marking the chat unread fails", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }], { patchTaskFails: true });
    w.brief.active("desktop");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open: { botId: "chief", threadId: "chief-main" } });
    expect(w.widgets("chief-main")).toHaveLength(1);
    expect(w.brief.state.get().lastCard).toEqual({ at: NOW + 4 * HOUR, botId: "chief", threadId: "chief-main", kind: "recap" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bots.json is read-only"));
  });

  it("leaves a bot limited to admins out of the recap of a Chief everyone can see, and keeps it for a Chief limited to admins", () => {
    const room: WorldRoom = { id: "room1", threadId: "room1-main", memberIds: ["scout", "payroll"] };
    const run = { id: "run1", routineId: "rt1", routineName: "Payslip standup", status: "completed", target: "room-goal", groupId: "room1", botId: "scout", threadId: "room1-main", scheduledFor: NOW + HOUR, finishedAt: NOW + HOUR } as RoutineRun;
    const recapFor = (chiefVisibility: BotVisibility | undefined) => {
      const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true, visibility: chiefVisibility }, { id: "scout", name: "Scout" }, { id: "payroll", name: "Payroll", visibility: "admins" }], { rooms: [room], runs: () => [run] });
      w.brief.active("desktop");
      w.tick(4 * HOUR);
      w.digestFor("scout", NOW + HOUR);
      w.digestFor("payroll", NOW + HOUR);
      w.messages.get("payroll-main")!.push({ id: "card", parentId: "d-payroll", at: NOW + HOUR, role: "bot", kind: "options", card: { title: "Send the payslips?", subtitle: "", options: ["Allow", "Deny"], requestId: "r1", tool: "Bash" } } as Message);
      expect(w.brief.active("desktop")).toMatchObject({ returned: true });
      return w.widgets("chief-main").map((line) => `${line.text} ${JSON.stringify(line.widget)}`).join("\n");
    };
    const everyone = recapFor(undefined);
    expect(everyone).toContain("scout finished a job.");
    for (const hidden of ["Payroll", "payroll finished a job.", "payroll-main", "Send the payslips?", "Payslip standup", "room1"]) expect(everyone).not.toContain(hidden);
    const admins = recapFor("admins");
    for (const shown of ["Payroll", "payroll finished a job.", "Send the payslips?", "Payslip standup"]) expect(admins).toContain(shown);
    const named = recapFor({ people: ["ada@example.test"] });
    expect(named).toContain("scout finished a job.");
    expect(named).not.toContain("Payroll");
  });

  it("keeps a room-goal run that never got a thread only when everyone who can see the Chief can see its room", () => {
    // Created as missed after a long sleep: newRun never set a thread, so only the room can say who may see it.
    const missed = (groupId: string) => ({ id: `run-${groupId}`, routineId: `rt-${groupId}`, routineName: `Standup in ${groupId}`, status: "missed", target: "room-goal", groupId, botId: "scout", scheduledFor: NOW + HOUR, finishedAt: NOW + HOUR }) as RoutineRun;
    const rooms: WorldRoom[] = [
      { id: "open", threadId: "open-main", memberIds: ["scout"] },
      { id: "floored", threadId: "floored-main", memberIds: ["scout"], audienceFloor: "admins" },
      { id: "mixed", threadId: "mixed-main", memberIds: ["scout", "payroll"] },
    ];
    const recapFor = (chiefVisibility: BotVisibility | undefined) => {
      const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true, visibility: chiefVisibility }, { id: "scout", name: "Scout" }, { id: "payroll", name: "Payroll", visibility: "admins" }],
        { rooms, runs: () => [missed("open"), missed("floored"), missed("mixed"), missed("gone")] });
      w.brief.active("desktop");
      w.tick(4 * HOUR);
      expect(w.brief.active("desktop")).toMatchObject({ returned: true });
      return w.widgets("chief-main").map((line) => line.text).join("\n");
    };
    const everyone = recapFor(undefined);
    expect(everyone).toContain("Standup in open");
    for (const hidden of ["Standup in floored", "Standup in mixed", "Standup in gone"]) expect(everyone).not.toContain(hidden);
    const admins = recapFor("admins");
    for (const shown of ["Standup in open", "Standup in floored", "Standup in mixed"]) expect(admins).toContain(shown);
    expect(admins).not.toContain("Standup in gone");
  });

  it("leaves out a routine run whose thread has no owner, even for a Chief limited to admins", () => {
    const run = (id: string, threadId: string) => ({ id, routineId: `rt-${id}`, routineName: `Run in ${threadId}`, status: "completed", target: "bot", botId: "scout", threadId, scheduledFor: NOW + HOUR, finishedAt: NOW + HOUR }) as RoutineRun;
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true, visibility: "admins" }, { id: "scout", name: "Scout" }], { runs: () => [run("owned", "scout-run"), run("orphan", "orphan-thread")] });
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    expect(w.brief.active("desktop")).toMatchObject({ returned: true });
    const text = w.widgets("chief-main").map((line) => `${line.text} ${JSON.stringify(line.widget)}`).join("\n");
    expect(text).toContain("Run in scout-run");
    expect(text).not.toContain("orphan-thread");
  });

  it("is off on a hosted workspace: no recap, and nothing to open", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }], { hosted: true });
    expect(w.brief.active("desktop", "Asia/Kolkata")).toEqual({ returned: false });
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
    expect(w.brief.postRecap(NOW)).toBe(false);
    expect(w.widgets("chief-main")).toEqual([]);
    expect(w.brief.state.get().lastCard).toBeUndefined();
  });

  it("does not offer a card posted while the desktop is active to the desktop's next ping", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true });
    w.tick(2 * 60_000);
    w.digestFor("scout", NOW + 4 * HOUR + 60_000);
    expect(w.brief.postRecap(NOW + 4 * HOUR)).toBe(true);
    w.tick(60_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
  });

  it("offers that card to the phone, whose own last activation is older than the away time", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    const open = { botId: "chief", threadId: "chief-main" };
    w.brief.active("phone");
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true });
    w.tick(2 * 60_000);
    w.digestFor("scout", NOW + 4 * HOUR + 60_000);
    expect(w.brief.postRecap(NOW + 4 * HOUR)).toBe(true);
    w.tick(60_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
    expect(w.brief.active("phone")).toEqual({ returned: false, open });
    w.tick(60_000);
    expect(w.brief.active("phone")).toEqual({ returned: false });
  });

  it("still opens the card a return posts", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.brief.active("desktop");
    w.tick(60_000);
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open: { botId: "chief", threadId: "chief-main" } });
  });

  it("refuses a time zone the state file would reject without failing the call", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(w.brief.active("desktop", `Zone/${"x".repeat(200)}`)).toEqual({ returned: false });
    expect(w.brief.state.get().timeZone).toBeUndefined();
  });
});

describe("MausBot in the recap composition", () => {
  const MAUSBOT = { id: "mausbot", name: "MausBot", visibility: "admins" as const };

  it("posts the recap as MausBot when there is no Chief, covering what only admins see", () => {
    const w = world([MAUSBOT, { id: "scout", name: "Scout" }, { id: "payroll", name: "Payroll", visibility: "admins" }], { mausbot: "mausbot" });
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    w.digestFor("payroll", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open: { botId: "mausbot", threadId: "mausbot-main" } });
    const text = w.widgets("mausbot-main").map((line) => line.text).join("\n");
    expect(text).toContain("scout finished a job.");
    expect(text).toContain("payroll finished a job.");
  });

  it("leaves the recap to the Chief when there is one", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, MAUSBOT, { id: "scout", name: "Scout" }], { mausbot: "mausbot" });
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open: { botId: "chief", threadId: "chief-main" } });
    expect(w.widgets("mausbot-main")).toEqual([]);
  });

  it("opens MausBot's new card before the recap, once per client", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, MAUSBOT, { id: "scout", name: "Scout" }], {
      mausbot: "mausbot",
      onPresence: ({ returned }) => { if (returned) w.brief.noteAssistantCard({ botId: "mausbot", threadId: "mausbot-main" }); },
    });
    const open = { botId: "mausbot", threadId: "mausbot-main" };
    w.brief.active("desktop");
    w.brief.active("phone");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open });
    expect(w.brief.active("phone")).toEqual({ returned: false, open });
    expect(w.widgets("chief-main")).toHaveLength(1);
    expect(w.brief.state.get().assistantCard).toMatchObject({ botId: "mausbot", threadId: "mausbot-main", kind: "assistant" });
    w.tick(60_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
    expect(w.brief.active("phone")).toEqual({ returned: false });
  });

  it("tells each client about MausBot's card or the recap, never one and then the other", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, MAUSBOT, { id: "scout", name: "Scout" }], { mausbot: "mausbot" });
    const open = { botId: "mausbot", threadId: "mausbot-main" };
    w.brief.active("desktop");
    w.tick(2 * HOUR);
    w.brief.noteAssistantCard({ botId: "mausbot", threadId: "mausbot-main" });
    w.tick(2 * HOUR);
    w.digestFor("scout", NOW + 3 * HOUR);
    expect(w.brief.active("desktop")).toEqual({ returned: true, open });
    expect(w.widgets("chief-main")).toHaveLength(1);
    w.tick(HOUR);
    expect(w.brief.active("phone")).toEqual({ returned: false, open });
    for (const step of [HOUR, HOUR]) {
      w.tick(step);
      expect(w.brief.active("phone")).toEqual({ returned: false });
    }
    w.tick(HOUR / 2);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
  });

  it("never moves a client that is already here when MausBot posts", () => {
    const w = world([MAUSBOT], { mausbot: "mausbot" });
    w.brief.active("desktop");
    w.tick(60_000);
    w.brief.noteAssistantCard({ botId: "mausbot", threadId: "mausbot-main" });
    w.tick(60_000);
    expect(w.brief.active("desktop")).toEqual({ returned: false });
  });

  it("calls onPresence on each owner activation, survives it throwing, and never on a hosted workspace", () => {
    const seen: unknown[] = [];
    const w = world([MAUSBOT], { mausbot: "mausbot", onPresence: (event) => { seen.push(event); } });
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.brief.active("phone");
    expect(seen).toEqual([{ source: "desktop", returned: false }, { source: "phone", returned: true }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = world([MAUSBOT], { mausbot: "mausbot", onPresence: () => { throw new Error("intro exploded"); } });
    expect(failing.brief.active("desktop")).toEqual({ returned: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("intro exploded"));
    const hosted = vi.fn();
    world([MAUSBOT], { mausbot: "mausbot", hosted: true, onPresence: hosted }).brief.active("desktop");
    expect(hosted).not.toHaveBeenCalled();
  });

  it("runs beforePresence first on each owner activation, so MausBot's intro precedes the recap it posts, survives it throwing, and never on a hosted workspace", () => {
    const order: string[] = [];
    const w = world([MAUSBOT, { id: "scout", name: "Scout" }], {
      mausbot: "mausbot",
      beforePresence: () => { order.push("before"); w.store.appendMessage("mausbot-main", { role: "bot", kind: "text", text: "Hi, I'm MausBot." }); },
      onPresence: () => { order.push("presence"); },
    });
    w.brief.active("desktop");
    w.tick(4 * HOUR);
    w.digestFor("scout", NOW + HOUR);
    expect(w.brief.active("desktop")).toMatchObject({ returned: true, open: { botId: "mausbot", threadId: "mausbot-main" } });
    expect(order).toEqual(["before", "presence", "before", "presence"]);
    const rows = w.store.messagesFor("mausbot-main");
    expect(rows.map((row) => row.kind)).toEqual(["text", "text", "widget"]);
    expect(rows[2]!.text).toContain("**Since you last looked**");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = world([MAUSBOT], { mausbot: "mausbot", beforePresence: () => { throw new Error("intro exploded"); } });
    expect(failing.brief.active("desktop")).toEqual({ returned: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("intro exploded"));
    const hosted = vi.fn();
    world([MAUSBOT], { mausbot: "mausbot", hosted: true, beforePresence: hosted }).brief.active("desktop");
    expect(hosted).not.toHaveBeenCalled();
  });

  it("opens a card MausBot posted while the person was away, even when the state file cannot be saved", () => {
    const w = world([MAUSBOT], { mausbot: "mausbot" });
    w.brief.active("desktop");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(w.brief.state, "patch").mockImplementation(() => { throw new Error("disk full"); });
    w.tick(4 * HOUR);
    w.brief.noteAssistantCard({ botId: "mausbot", threadId: "mausbot-main" });
    expect(w.brief.active("phone")).toEqual({ returned: true, open: { botId: "mausbot", threadId: "mausbot-main" } });
    expect(w.brief.active("desktop")).toEqual({ returned: false, open: { botId: "mausbot", threadId: "mausbot-main" } });
    expect(w.brief.state.get().assistantCard).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });

  it("notes no MausBot card on a hosted workspace", () => {
    const w = world([MAUSBOT], { mausbot: "mausbot", hosted: true });
    w.brief.noteAssistantCard({ botId: "mausbot", threadId: "mausbot-main" });
    expect(w.brief.state.get().assistantCard).toBeUndefined();
    expect(existsSync(join(w.dataDir, "brief.json"))).toBe(false);
  });
});

describe("the team line for MausBot's Today", () => {
  it("counts what the Chief's audience may see since a time, and opens the Chief's chat", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "scout", name: "Scout" }]);
    w.digestFor("scout", NOW + HOUR);
    w.tick(2 * HOUR);
    expect(w.brief.teamLine(NOW)).toEqual({ text: "Chief: 1 finished", open: { botId: "chief", threadId: "chief-main" } });
    expect(w.brief.teamLine(NOW + 3 * HOUR)).toEqual({ text: "Chief: nothing new from the team", open: { botId: "chief", threadId: "chief-main" } });
    expect(world([{ id: "scout", name: "Scout" }]).brief.teamLine(NOW)).toBeNull();
    expect(world([{ id: "chief", name: "Chief", chiefOfStaff: true }], { hosted: true }).brief.teamLine(NOW)).toBeNull();
  });

  it("leaves out what the Chief's audience may not see", () => {
    const w = world([{ id: "chief", name: "Chief", chiefOfStaff: true }, { id: "payroll", name: "Payroll", visibility: "admins" }]);
    w.digestFor("payroll", NOW + HOUR);
    w.tick(2 * HOUR);
    expect(w.brief.teamLine(NOW)).toEqual({ text: "Chief: nothing new from the team", open: { botId: "chief", threadId: "chief-main" } });
  });
});
