import { randomUUID } from "node:crypto";

export const JOB_DEADLINE_MS = 15 * 60_000;
const JOB_PREFIX = "mausbot-";

export type JobResult = { ok: true; threadId: string; reply: string } | { ok: false; threadId?: string; error: string };

export const jobRoutineRunId = (jobId: string): string => `${JOB_PREFIX}${jobId}`;
export const isAssistantJobThread = (routineRunId: string | undefined): boolean => routineRunId?.startsWith(JOB_PREFIX) === true;

export interface AssistantTurnsDeps {
  /** Creates the thread already hidden: `routineRunId` set and `unread` false, in one store write. */
  createJobThread(botId: string, title: string, routineRunId: string): { threadId: string } | null;
  start(botId: string, threadId: string, prompt: string): Promise<unknown>;
  replyOf(threadId: string, turnId: string | undefined): string;
  interrupt(botId: string, threadId: string): Promise<void>;
  deadlineMs?: number;
  setTimer?(run: () => void, ms: number): { cancel(): void };
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createAssistantTurns(deps: AssistantTurnsDeps) {
  const deadlineMs = deps.deadlineMs ?? JOB_DEADLINE_MS;
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const waiting = new Map<string, (outcome: { ok: boolean; turnId?: string } | "late") => void>();

  async function run(botId: string, title: string, prompt: string): Promise<JobResult> {
    const task = deps.createJobThread(botId, title, jobRoutineRunId(randomUUID()));
    if (!task) return { ok: false, error: "MausBot could not open a work thread" };
    const { threadId } = task;
    let timer: { cancel(): void } | undefined;
    const finished = new Promise<{ ok: boolean; turnId?: string } | "late">((resolve) => {
      waiting.set(threadId, resolve);
      timer = setTimer(() => resolve("late"), deadlineMs);
    });
    try {
      await deps.start(botId, threadId, prompt);
    } catch (error) {
      waiting.delete(threadId);
      timer?.cancel();
      return { ok: false, threadId, error: failure(error) };
    }
    const outcome = await finished;
    waiting.delete(threadId);
    timer?.cancel();
    if (outcome === "late") {
      await Promise.resolve().then(() => deps.interrupt(botId, threadId)).catch(() => undefined);
      return { ok: false, threadId, error: `it took longer than ${Math.round(deadlineMs / 60_000)} minutes` };
    }
    if (!outcome.ok) return { ok: false, threadId, error: "the turn did not finish" };
    try {
      return { ok: true, threadId, reply: deps.replyOf(threadId, outcome.turnId) };
    } catch (error) {
      return { ok: false, threadId, error: failure(error) };
    }
  }

  function completed(threadId: string, ok: boolean, turnId?: string): void {
    waiting.get(threadId)?.({ ok, ...(turnId ? { turnId } : {}) });
  }

  return { run, completed };
}
