import { describe, expect, it } from "vitest";

import { assistantHitTitle, assistantRecallThreads } from "./mausbot-recall.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

const bot = (id: string, more: Partial<BotRecord> = {}): BotRecord => ({
  id, name: `${id[0]!.toUpperCase()}${id.slice(1)}`, threadId: `${id}-main`,
  tasks: [{ threadId: `${id}-main`, title: "Main" }, { threadId: `${id}-2`, title: "Second" }], ...more,
}) as unknown as BotRecord;
const world = (bots: BotRecord[], groups: GroupRecord[] = []) => ({
  bots, groups,
  bot: (id: string) => bots.find((candidate) => candidate.id === id) ?? null,
  botByThread: (threadId: string) => bots.find((candidate) => candidate.tasks?.some((task) => task.threadId === threadId)) ?? null,
  taskByThread: (botId: string, threadId: string) => bots.find((candidate) => candidate.id === botId)?.tasks?.find((task) => task.threadId === threadId),
});

describe("MausBot's search scope", () => {
  const mausbot = bot("mausbot", { builtIn: "mausbot", visibility: "admins" });

  it("covers every bot's and room's threads when MausBot is admins-only", () => {
    const room = { id: "room", threadId: "room-main", memberIds: ["scout", "payroll"], tasks: [{ threadId: "room-main", title: "Room" }] } as unknown as GroupRecord;
    const scope = assistantRecallThreads(world([mausbot, bot("scout"), bot("payroll", { visibility: "admins" }), bot("bob", { visibility: { people: ["bob@example.test"] } })], [room]), mausbot);
    expect(scope.sort()).toEqual(["bob-2", "bob-main", "mausbot-2", "mausbot-main", "payroll-2", "payroll-main", "room-main", "scout-2", "scout-main"]);
  });

  it("never reaches past a narrower audience", () => {
    const narrow = bot("mausbot", { builtIn: "mausbot", visibility: { people: ["ada@example.test"] } });
    const room = { id: "room", threadId: "room-main", memberIds: ["payroll"], tasks: [] } as unknown as GroupRecord;
    expect(assistantRecallThreads(world([narrow, bot("payroll", { visibility: "admins" }), bot("open")], [room]), narrow).sort())
      .toEqual(["mausbot-2", "mausbot-main", "open-2", "open-main"]);
  });

  it("leaves out MausBot's hidden job threads, in a bot or a room", () => {
    const withJobs = bot("mausbot", {
      builtIn: "mausbot", visibility: "admins",
      tasks: [{ threadId: "mausbot-main", title: "Main" }, { threadId: "job-1", title: "Job", routineRunId: "mausbot-abc" }, { threadId: "run-1", title: "Routine", routineRunId: "run-1" }],
    } as Partial<BotRecord>);
    const room = { id: "room", threadId: "room-main", memberIds: ["scout"], tasks: [{ threadId: "room-job", title: "Job", routineRunId: "mausbot-x" }] } as unknown as GroupRecord;
    const scope = assistantRecallThreads(world([withJobs, bot("scout")], [room]), withJobs);
    expect(scope).toContain("run-1");
    expect(scope).toContain("room-main");
    expect(scope).not.toContain("job-1");
    expect(scope).not.toContain("room-job");
  });

  it("keeps archived threads, as session_search does for other bots", () => {
    const archived = bot("scout", { tasks: [{ threadId: "scout-main", title: "Main" }, { threadId: "scout-old", title: "Old", archivedAt: 1 }] } as Partial<BotRecord>);
    expect(assistantRecallThreads(world([mausbot, archived]), mausbot)).toContain("scout-old");
  });

  it("titles another bot's thread with that bot's name, and its own as it is", () => {
    const store = world([mausbot, bot("scout")]);
    expect(assistantHitTitle(store, mausbot, "scout-2")).toBe("Scout · Second");
    expect(assistantHitTitle(store, mausbot, "mausbot-main")).toBe("Main");
    expect(assistantHitTitle(store, mausbot, "nowhere")).toBeUndefined();
  });
});
