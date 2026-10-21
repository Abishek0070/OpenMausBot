import { describe, expect, it } from "vitest";

import { parseWidgetInput, WIDGET_LIMITS, widgetActions, widgetToText } from "../../shared/widget.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Message, TaskRecord } from "../store.ts";
import { buildRecap, firstSentence, RECAP_LIMITS, RECAP_TAIL, RECAP_TITLE, ROUTINE_LINE_MAX, routineRows, type RecapDeps } from "./brief-recap.ts";

const SINCE = Date.UTC(2026, 9, 14, 22, 0, 0);
const AFTER = SINCE + 60_000;

const bot = (id: string, name: string, hidden = false): BotRecord =>
  ({ id, name, threadId: `${id}-main`, color: "green", hidden, tasks: [] } as unknown as BotRecord);
const task = (threadId: string, updatedAt: number, more: Partial<TaskRecord> = {}): TaskRecord =>
  ({ threadId, title: `Task ${threadId}`, createdAt: SINCE - 1, updatedAt, ...more } as TaskRecord);
const digest = (at: number, reply: string, succeeded = true): Message =>
  ({ id: `d-${at}`, at, role: "bot", kind: "digest", text: "[digest]", turnSucceeded: succeeded, digest: { turnId: "t", botId: "b", threadId: "x", at, durationMs: 1, tools: [], memory: [], reply, hookCoverage: "none" } } as unknown as Message);
const failure = (at: number, name: string): Message => ({ id: `a-${at}`, at, role: "bot", kind: "activity", tool: { name, ok: false } } as Message);
const openCard = (at: number, title: string): Message => ({ id: `c-${at}`, at, role: "bot", kind: "options", card: { title, subtitle: "", options: ["Allow", "Deny"], requestId: `r-${at}`, tool: "Bash" } } as Message);

function deps(world: { bots: BotRecord[]; tasks: Record<string, TaskRecord[]>; messages: Record<string, Message[]>; busy?: string[]; runs?: RoutineRun[]; hiddenThreads?: string[]; hiddenRooms?: string[] }): RecapDeps {
  return {
    store: { bots: world.bots, tasks: (id) => world.tasks[id] ?? [], messagesTail: (threadId, n) => (world.messages[threadId] ?? []).slice(-n) },
    visible: { bot: () => true, room: (groupId) => !(world.hiddenRooms ?? []).includes(groupId), thread: (threadId) => !(world.hiddenThreads ?? []).includes(threadId) },
    threadBusy: (_bot, threadId) => (world.busy ?? []).includes(threadId),
    routineRuns: () => world.runs ?? [],
    now: () => AFTER + 3 * 60 * 60_000,
  };
}

describe("buildRecap", () => {
  it("is null when nothing happened since", () => {
    expect(buildRecap(deps({ bots: [bot("scout", "Scout")], tasks: { scout: [task("t1", SINCE - 5)] }, messages: { t1: [digest(SINCE - 5, "old news")] } }), { since: SINCE })).toBeNull();
  });

  it("reads finished, failed, running, routine runs and open cards from records, only in visible threads", () => {
    const runs = [{ id: "run1", routineId: "rt1", routineName: "Inbox check", status: "completed", target: "bot", botId: "scout", threadId: "t-run", scheduledFor: AFTER } as RoutineRun];
    const recap = buildRecap(deps({
      bots: [bot("scout", "Scout"), bot("atlas", "Atlas"), bot("ghost", "Ghost", true)],
      tasks: { scout: [task("t1", AFTER), task("t2", AFTER + 1)], atlas: [task("t3", AFTER + 2), task("t4", AFTER + 3)], ghost: [task("t5", AFTER)] },
      messages: {
        t1: [digest(AFTER, "Pushed the branch and opened #12.")],
        t2: [failure(AFTER, "Bash: pnpm test"), digest(AFTER + 1, "", false)],
        t3: [openCard(AFTER + 2, "Run rm -rf build?")],
        t4: [digest(AFTER + 3, "Drafted the newsletter.")],
        t5: [digest(AFTER, "hidden bot work")],
      },
      busy: ["t3"], runs, hiddenThreads: ["t4"],
    }), { since: SINCE })!;
    expect(recap.facts).toEqual({
      since: SINCE,
      finished: [{ botId: "scout", botName: "Scout", threadId: "t1", summary: "Pushed the branch and opened #12." }],
      failed: [{ botId: "scout", botName: "Scout", threadId: "t2", reason: "Bash: pnpm test" }],
      running: [{ botId: "atlas", botName: "Atlas", threadId: "t3" }],
      routineRuns: [{ routineId: "rt1", name: "Inbox check", status: "completed", count: 1, threadId: "t-run" }],
      waitingOnYou: [{ botId: "atlas", threadId: "t3", title: "Run rm -rf build?" }],
    });
    const parsed = parseWidgetInput(recap.card);
    expect(parsed.ok, (parsed as { error?: string }).error).toBe(true);
    expect(recap.card.title).toBe(RECAP_TITLE);
    const actions = widgetActions(parsed.ok ? parsed.value : recap.card);
    expect(actions.every((entry) => entry.client && entry.action.type === "open_thread")).toBe(true);
    expect(actions.map((entry) => entry.action.payload)).toEqual([
      { botId: "scout", threadId: "t1" }, { botId: "scout", threadId: "t2" }, { botId: "atlas", threadId: "t3" }, { botId: "scout", threadId: "t-run" }, { botId: "atlas", threadId: "t3" },
    ]);
    const text = widgetToText(parsed.ok ? parsed.value : recap.card);
    expect(text).toContain("Pushed the branch");
    expect(text).not.toContain("newsletter");
    expect(text).not.toContain("hidden bot work");
  });

  it("stays one card for 300 busy threads over a week away, scanning only threads touched since", () => {
    const bots = Array.from({ length: 40 }, (_, i) => bot(`b${i}`, `Bot ${i}`));
    const tasks: Record<string, TaskRecord[]> = {};
    const messages: Record<string, Message[]> = {};
    let scanned = 0;
    for (const [i, b] of bots.entries()) {
      tasks[b.id] = Array.from({ length: 10 }, (_, j) => task(`${b.id}-t${j}`, j < 8 ? AFTER + i * 10 + j : SINCE - 10));
      for (let j = 0; j < 10; j++) messages[`${b.id}-t${j}`] = [digest(AFTER + j, `Finished job ${j} ${"x".repeat(500)}`, j % 3 !== 0)];
    }
    const world = deps({ bots, tasks, messages });
    world.store.messagesTail = (threadId) => { scanned += 1; return messages[threadId] ?? []; };
    const recap = buildRecap(world, { since: SINCE })!;
    expect(scanned).toBeLessThanOrEqual(RECAP_LIMITS.threads);
    expect(recap.facts.finished.length + recap.facts.failed.length).toBe(RECAP_LIMITS.threads);
    const parsed = parseWidgetInput(recap.card);
    expect(parsed.ok, (parsed as { error?: string }).error).toBe(true);
    expect(JSON.stringify(recap.card).length).toBeLessThan(WIDGET_LIMITS.bytes);
    const text = widgetToText(parsed.ok ? parsed.value : recap.card);
    expect(text).toMatch(/and \d+ more/);
    expect(widgetActions(parsed.ok ? parsed.value : recap.card).length).toBeLessThanOrEqual(RECAP_LIMITS.rows * 5);
  });

  const one = (messages: Message[], extra: Partial<Parameters<typeof deps>[0]> = {}) =>
    deps({ bots: [bot("scout", "Scout")], tasks: { scout: [task("t1", AFTER)] }, messages: { t1: messages }, ...extra });
  const view = { since: SINCE };

  it("opens a room-goal run in its room and never as a bot thread", () => {
    const runs = [{ id: "r1", routineId: "rt", routineName: "Standup", status: "completed", target: "room-goal", groupId: "room1", botId: "scout", threadId: "room-t", scheduledFor: AFTER } as RoutineRun];
    const recap = buildRecap(one([], { runs }), view)!;
    const parsed = parseWidgetInput(recap.card);
    const found = widgetActions(parsed.ok ? parsed.value : recap.card).map((entry) => entry.action.payload);
    expect(found).toEqual([{ groupId: "room1", threadId: "room-t" }]);
  });

  it("lists no routine run whose thread the viewer cannot open", () => {
    const runs = [{ id: "r1", routineId: "rt", routineName: "Secret", status: "completed", target: "bot", botId: "scout", threadId: "t-run", scheduledFor: AFTER } as RoutineRun];
    expect(buildRecap(one([], { runs, hiddenThreads: ["t-run"] }), view)).toBeNull();
  });

  it("lists a room-goal run only when its room is visible, with or without a thread", () => {
    const missed = { id: "r1", routineId: "rt", routineName: "Standup", status: "missed", target: "room-goal", groupId: "room1", botId: "scout", scheduledFor: AFTER } as RoutineRun;
    expect(buildRecap(one([], { runs: [missed], hiddenRooms: ["room1"] }), view)).toBeNull();
    expect(buildRecap(one([], { runs: [missed] }), view)!.facts.routineRuns).toEqual([{ routineId: "rt", name: "Standup", status: "missed", count: 1 }]);
    expect(buildRecap(one([], { runs: [{ ...missed, threadId: "room-t" }], hiddenRooms: ["room1"] }), view)).toBeNull();
    expect(buildRecap(one([], { runs: [{ ...missed, groupId: undefined }] }), view)).toBeNull();
  });

  it("skips the excluded thread in every section", () => {
    const messages = [digest(AFTER, "my own brief"), openCard(AFTER, "Allow?")];
    expect(buildRecap(one(messages, { busy: ["t1"] }), { ...view, exclude: { threadId: "t1" } })).toBeNull();
  });

  it("reads at most RECAP_TAIL messages per thread", () => {
    let asked = 0;
    const world = one([digest(AFTER, "done")]);
    world.store.messagesTail = (_id, n) => { asked = n; return []; };
    buildRecap(world, view);
    expect(asked).toBe(RECAP_TAIL);
    expect(RECAP_TAIL).toBe(40);
  });

  it("collapses a routine that ran 50 times to one entry with a count", () => {
    const runs = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, routineId: "rt", routineName: "Poll", status: "completed", target: "bot", botId: "scout", threadId: `run-${i}`, scheduledFor: AFTER + i } as RoutineRun));
    const recap = buildRecap(one([], { runs }), view)!;
    expect(recap.facts.routineRuns).toEqual([{ routineId: "rt", name: "Poll", status: "completed", count: 50, threadId: "run-49" }]);
  });

  it("does not split an emoji when clipping", () => {
    const recap = buildRecap(one([digest(AFTER, "😀".repeat(200))]), view)!;
    const summary = recap.facts.finished[0]!.summary;
    expect(Array.from(summary).length).toBe(RECAP_LIMITS.text);
    expect(() => encodeURIComponent(summary)).not.toThrow();
  });

  it("takes a failure only from its own turn and words it without the error marker", () => {
    const older = [failure(AFTER, "error: old boom"), digest(AFTER + 1, "fine")];
    expect(buildRecap(one([...older, digest(AFTER + 2, "", true)]), view)!.facts.failed).toEqual([]);
    const own = [digest(AFTER, "fine"), failure(AFTER + 1, "error: provider down"), digest(AFTER + 2, "", false)];
    expect(buildRecap(one(own), view)!.facts.failed[0]!.reason).toBe("provider down");
    const stale = [failure(AFTER, "error: old boom"), digest(AFTER + 1, "fine"), digest(AFTER + 2, "", false)];
    expect(buildRecap(one(stale), view)!.facts.failed[0]!.reason).toBe("the turn failed");
  });

  it("does not list a routine run's thread as finished work as well", () => {
    const runs = [{ id: "r1", routineId: "rt", routineName: "Poll", status: "completed", target: "bot", botId: "scout", threadId: "t1", scheduledFor: AFTER } as RoutineRun];
    const recap = buildRecap(one([digest(AFTER, "polled")], { runs }), view)!;
    expect(recap.facts.finished).toEqual([]);
    expect(recap.facts.routineRuns).toHaveLength(1);
  });

  it("words the away caption in the given time zone", () => {
    const text = (timeZone?: string) => widgetToText(buildRecap(one([digest(AFTER, "x")]), { ...view, timeZone })!.card);
    expect(text("Asia/Kolkata")).toContain("Away since Thu 3:30 AM");
    expect(() => text("Not/AZone")).not.toThrow();
  });
});

describe("routineRows", () => {
  const run = (id: string, more: Partial<RoutineRun>): RoutineRun =>
    ({ id, routineId: `rt-${id}`, routineName: id, status: "completed", target: "bot", botId: "scout", scheduledFor: AFTER, finishedAt: AFTER, ...more } as RoutineRun);
  const withRuns = (runs: RoutineRun[], more: { messages?: Record<string, Message[]>; hiddenThreads?: string[] } = {}) =>
    deps({ bots: [bot("scout", "Scout")], tasks: {}, messages: more.messages ?? {}, runs, hiddenThreads: more.hiddenThreads });
  const withOutput = (output: string) => withRuns([run("r", { routineName: "Nightly", output })]);

  it("lists one row per finished run since a time, newest first: a completed run's first sentence, a failed run's error, a missed run's reason", () => {
    const world = withRuns([
      run("a", { routineName: "Overnight numbers", threadId: "run-1", finishedAt: AFTER + 1 }),
      run("b", { routineName: "Broken", status: "failed", error: "Token expired", threadId: "run-2", finishedAt: AFTER + 2 }),
      run("c", { routineName: "Missed one", status: "missed", finishedAt: undefined, scheduledFor: AFTER + 3 }),
    ], { messages: { "run-1": [digest(AFTER, "Revenue is up 4%. Costs flat.")] } });
    expect(routineRows(world, SINCE)).toEqual([
      { name: "Missed one", status: "missed", line: "It did not run" },
      { name: "Broken", status: "failed", line: "Token expired", open: { botId: "scout", threadId: "run-2" } },
      { name: "Overnight numbers", status: "completed", line: "Revenue is up 4%.", open: { botId: "scout", threadId: "run-1" } }]);
  });

  it("takes a completed run's line from its thread's last digest, else from its output", () => {
    const world = withRuns([
      run("a", { threadId: "run-1", output: "ignored output", finishedAt: AFTER + 1 }),
      run("b", { output: "Sent 12 invoices! Done.", finishedAt: AFTER + 2 }),
      run("c", { threadId: "run-3", output: "Fell back to output. More.", finishedAt: AFTER + 3 }),
    ], { messages: { "run-1": [digest(AFTER, "Old reply."), digest(AFTER + 1, "Revenue is up 4%. Costs flat.")], "run-3": [] } });
    expect(routineRows(world, SINCE).map((row) => row.line)).toEqual(["Fell back to output.", "Sent 12 invoices!", "Revenue is up 4%."]);
  });

  it("says Finished or It failed when a run has no text", () => {
    const world = withRuns([run("a", { output: "  ", finishedAt: AFTER + 1 }), run("b", { status: "failed", finishedAt: AFTER + 2 })]);
    expect(routineRows(world, SINCE).map((row) => row.line)).toEqual(["It failed", "Finished"]);
  });

  it("leaves out a run its readers may not see, and running, waiting and cancelled runs", () => {
    const world = withRuns([
      run("Hidden one", { threadId: "t-hidden" }),
      run("Busy", { status: "running" }), run("Parked", { status: "waiting" }), run("Dropped", { status: "cancelled" }),
      run("Visible one", { threadId: "t-ok" }),
      run("Before", { finishedAt: SINCE - 1 }),
    ], { hiddenThreads: ["t-hidden"] });
    expect(routineRows(world, SINCE).map((row) => row.name)).toEqual(["Visible one"]);
  });

  it("writes one readable line for an empty, endless or emoji reply", () => {
    expect(firstSentence("")).toBe("");
    expect(routineRows(withOutput(""), SINCE)[0]!.line).toBe("Finished");
    const endless = routineRows(withOutput("word ".repeat(400)), SINCE)[0]!.line;
    expect(endless.length).toBeLessThanOrEqual(ROUTINE_LINE_MAX);
    expect(endless.endsWith("…")).toBe(true);
    const emoji = routineRows(withOutput("\u{1F600}".repeat(200)), SINCE)[0]!.line;
    expect(emoji.length).toBeLessThanOrEqual(ROUTINE_LINE_MAX);
    expect(/[\ud800-\udbff]$/.test(emoji.replace(/…$/, ""))).toBe(false);
    expect(routineRows(withOutput("All good \u{1F389}"), SINCE)[0]!.line).toBe("All good \u{1F389}");
  });

  it("cuts a sentence at . ! or ? followed by a space or the end, else at the first line", () => {
    expect(firstSentence("Version 2.5 shipped. More.")).toBe("Version 2.5 shipped.");
    expect(firstSentence("Really? Yes.")).toBe("Really?");
    expect(firstSentence("No stop here\nsecond line")).toBe("No stop here");
    expect(firstSentence("Done!")).toBe("Done!");
  });

  it("lists no routine runs in the recap when told to leave them out, and still lists chats and tasks", () => {
    const world = deps({
      bots: [bot("scout", "Scout")], tasks: { scout: [task("t1", AFTER)] }, messages: { t1: [digest(AFTER, "Pushed the branch.")] },
      runs: [run("a", { threadId: "t-run" })],
    });
    const recap = buildRecap(world, { since: SINCE, routines: false })!;
    expect(recap.facts.routineRuns).toEqual([]);
    expect(recap.facts.finished.length).toBeGreaterThan(0);
    expect(buildRecap(world, { since: SINCE })!.facts.routineRuns.length).toBe(1);
  });
});
