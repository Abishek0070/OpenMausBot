import { describe, expect, it, vi } from "vitest";

import { createAssistantTurns, isAssistantJobThread, jobRoutineRunId, type AssistantTurnsDeps } from "./assistant-turns.ts";

function harness(overrides: Partial<AssistantTurnsDeps> = {}) {
  let threads = 0;
  const deadlines: Array<() => void> = [];
  const deps: AssistantTurnsDeps = {
    createJobThread: vi.fn(() => ({ threadId: `job-${++threads}` })),
    start: vi.fn(async () => undefined),
    replyOf: vi.fn((threadId: string, turnId?: string) => `reply in ${threadId} for ${turnId}`),
    interrupt: vi.fn(async () => undefined),
    setTimer: (run) => { deadlines.push(run); return { cancel: () => {} }; },
    ...overrides,
  };
  return { deps, turns: createAssistantTurns(deps), deadlines };
}

describe("createAssistantTurns", () => {
  it("runs a job in a fresh hidden MausBot thread and answers with that turn's reply", async () => {
    const { deps, turns } = harness();
    const pending = turns.run("m", "Prep: Demo", "[MausBot prep demo-1]\n…");
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled());
    turns.completed("someone-else", true, "x");
    turns.completed("job-1", true, "turn-7");
    await expect(pending).resolves.toEqual({ ok: true, threadId: "job-1", reply: "reply in job-1 for turn-7" });
    expect(deps.createJobThread).toHaveBeenCalledTimes(1);
    const [botId, title, marker] = vi.mocked(deps.createJobThread).mock.calls[0]!;
    expect([botId, title]).toEqual(["m", "Prep: Demo"]);
    expect(isAssistantJobThread(marker)).toBe(true);
    expect(deps.start).toHaveBeenCalledWith("m", "job-1", "[MausBot prep demo-1]\n…");
  });

  it("gives every job its own marker", async () => {
    const { deps, turns } = harness({ start: vi.fn(async () => { throw new Error("no"); }) });
    await turns.run("m", "a", "p");
    await turns.run("m", "b", "p");
    const markers = vi.mocked(deps.createJobThread).mock.calls.map((call) => call[2]);
    expect(new Set(markers).size).toBe(2);
  });

  it("reports a refused start and a failed turn without waiting", async () => {
    const refused = harness({ start: vi.fn(async () => { throw new Error("this bot's approval level is still being confirmed"); }) });
    await expect(refused.turns.run("m", "Email check", "p")).resolves.toEqual({ ok: false, threadId: "job-1", error: "this bot's approval level is still being confirmed" });
    const failed = harness();
    const pending = failed.turns.run("m", "Email check", "p");
    await vi.waitFor(() => expect(failed.deps.start).toHaveBeenCalled());
    failed.turns.completed("job-1", false, "t");
    await expect(pending).resolves.toEqual({ ok: false, threadId: "job-1", error: "the turn did not finish" });
    expect((await harness({ createJobThread: () => null }).turns.run("m", "x", "p")).ok).toBe(false);
  });

  it("stops a turn that runs past the deadline and reports it", async () => {
    const { deps, turns, deadlines } = harness();
    const pending = turns.run("m", "Prep: Demo", "p");
    await vi.waitFor(() => expect(deps.start).toHaveBeenCalled());
    deadlines[0]!();
    await expect(pending).resolves.toEqual({ ok: false, threadId: "job-1", error: "it took longer than 15 minutes" });
    expect(deps.interrupt).toHaveBeenCalledWith("m", "job-1");
  });

  it("names its threads so the server can tell a job thread from any other", () => {
    expect(jobRoutineRunId("abc")).toBe("mausbot-abc");
    expect(isAssistantJobThread("mausbot-abc")).toBe(true);
    expect(isAssistantJobThread("run-1")).toBe(false);
    expect(isAssistantJobThread(undefined)).toBe(false);
  });
});
