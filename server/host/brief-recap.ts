import { failedTurnCause } from "../../shared/failed-turn.ts";
import { liveCardKind } from "../../shared/live-approval.ts";
import type { WidgetRoot } from "../../shared/widget.ts";
import type { RoutineRun } from "../routines.ts";
import type { BotRecord, Message, TaskRecord } from "../store.ts";

export interface RecapFacts {
  since: number;
  finished: Array<{ botId: string; botName: string; threadId: string; summary: string }>;
  failed: Array<{ botId: string; botName: string; threadId: string; reason: string }>;
  running: Array<{ botId: string; botName: string; threadId: string }>;
  routineRuns: Array<{ routineId: string; name: string; status: string; count: number; threadId?: string }>;
  waitingOnYou: Array<{ botId: string; threadId: string; title: string }>;
}

export interface RecapDeps {
  store: { bots: readonly BotRecord[]; tasks(botId: string): TaskRecord[]; messagesTail(threadId: string, n: number): Message[] };
  /** What every reader of the card may open. */
  visible: { bot(id: string): boolean; room(groupId: string): boolean; thread(threadId: string): boolean };
  threadBusy(botId: string, threadId: string): boolean;
  routineRuns(since: number): RoutineRun[];
  now?: () => number;
}

/** Threads scanned per recap, rows shown per section, characters per row. */
export const RECAP_LIMITS = { threads: 200, rows: 8, text: 120 } as const;
/** Newest messages read per thread. */
export const RECAP_TAIL = 40;
export const RECAP_TITLE = "Since you last looked";
const RUN_STATUSES = new Set(["completed", "failed", "missed", "waiting", "running"]);

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const points = Array.from(flat);
  return points.length <= RECAP_LIMITS.text ? flat : `${points.slice(0, RECAP_LIMITS.text - 1).join("").trimEnd()}…`;
};
type OpenTarget = { botId: string; threadId: string } | { groupId: string; threadId: string };
export const validZone = (zone: string | undefined): string | undefined => {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
};
const touchedAt = (task: TaskRecord): number => task.updatedAt ?? task.createdAt;

export function buildRecap(deps: RecapDeps, input: { since: number; exclude?: { threadId: string }; timeZone?: string }): { facts: RecapFacts; card: WidgetRoot } | null {
  const { since } = input;
  const { visible } = deps;
  const facts: RecapFacts = { since, finished: [], failed: [], running: [], routineRuns: [], waitingOnYou: [] };
  const bots = deps.store.bots.filter((bot) => !bot.hidden && visible.bot(bot.id));
  const known = new Map(bots.map((bot) => [bot.id, bot]));
  const excluded = input.exclude?.threadId;
  const runTargets = new Map<string, OpenTarget | undefined>();
  const latest = new Map<string, { run: RoutineRun; at: number; count: number }>();
  for (const run of deps.routineRuns(since)) {
    if (!known.has(run.botId) || !RUN_STATUSES.has(run.status)) continue;
    // A run that never started (missed, ended, refused) has no thread: its room alone says who may see it.
    if (run.target === "room-goal" && !(run.groupId && visible.room(run.groupId))) continue;
    if (run.threadId && (run.threadId === excluded || !visible.thread(run.threadId))) continue;
    const at = run.finishedAt ?? run.startedAt ?? run.scheduledFor;
    const seen = latest.get(run.routineId);
    latest.set(run.routineId, { run: !seen || at >= seen.at ? run : seen.run, at: Math.max(at, seen?.at ?? 0), count: (seen?.count ?? 0) + 1 });
  }
  const routines = [...latest.values()].sort((a, b) => b.at - a.at).slice(0, RECAP_LIMITS.rows);
  const routineThreads = new Set<string>();
  for (const { run, count } of routines) {
    if (run.threadId) {
      routineThreads.add(run.threadId);
      runTargets.set(run.threadId, run.target === "room-goal" && run.groupId ? { groupId: run.groupId, threadId: run.threadId } : run.target === "bot" ? { botId: run.botId, threadId: run.threadId } : undefined);
    }
    facts.routineRuns.push({ routineId: run.routineId, name: clip(run.routineName), status: run.status, count, ...(run.threadId ? { threadId: run.threadId } : {}) });
  }
  const threads = bots
    .flatMap((bot) => deps.store.tasks(bot.id)
      .filter((task) => task.archivedAt === undefined && !task.routineRunId && touchedAt(task) >= since && task.threadId !== excluded && visible.thread(task.threadId))
      .map((task) => ({ bot, task })))
    .sort((a, b) => touchedAt(b.task) - touchedAt(a.task))
    .slice(0, RECAP_LIMITS.threads);

  for (const { bot, task } of threads) {
    if (deps.threadBusy(bot.id, task.threadId)) facts.running.push({ botId: bot.id, botName: bot.name, threadId: task.threadId });
    const recent = deps.store.messagesTail(task.threadId, RECAP_TAIL).filter((line) => line.at >= since);
    const digestAt = recent.findLastIndex((line) => line.kind === "digest" && line.digest);
    const digest = recent[digestAt];
    if (digest?.digest && !routineThreads.has(task.threadId)) {
      if (digest.turnSucceeded === false) {
        const before = recent.slice(0, digestAt);
        const turnStart = before.findLastIndex((line) => line.kind === "digest") + 1;
        const name = before.slice(turnStart).findLast((line) => line.kind === "activity" && line.tool?.ok === false)?.tool?.name;
        const reason = name === undefined ? "the turn failed" : failedTurnCause(name) ?? name;
        facts.failed.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, reason: clip(reason) });
      } else {
        facts.finished.push({ botId: bot.id, botName: bot.name, threadId: task.threadId, summary: clip(digest.digest.reply || task.title) });
      }
    }
    for (const line of recent) {
      if (line.kind === "options" && liveCardKind(line.card) !== null) {
        facts.waitingOnYou.push({ botId: bot.id, threadId: task.threadId, title: clip(line.card!.title) });
      }
    }
  }
  if (!facts.finished.length && !facts.failed.length && !facts.running.length && !facts.routineRuns.length && !facts.waitingOnYou.length) return null;
  return { facts, card: recapCard(facts, deps.now?.() ?? Date.now(), known, runTargets, validZone(input.timeZone)) };
}

type Row = Record<string, unknown>;

function openButton(target: OpenTarget): Row {
  return { type: "Button", label: "Open", style: "secondary", onClickAction: { type: "open_thread", payload: target } };
}

function row(text: string, detail: string | undefined, target: OpenTarget | undefined, badge?: { label: string; color: string }): Row {
  return {
    type: "Row", gap: 3, align: "center",
    children: [
      { type: "Col", flex: 1, children: [{ type: "Text", value: text, weight: "medium", truncate: true }, ...(detail ? [{ type: "Caption", value: detail, truncate: true }] : [])] },
      ...(badge ? [{ type: "Badge", label: badge.label, color: badge.color, variant: "dot" }] : []),
      ...(target ? [openButton(target)] : []),
    ],
  };
}

function section(title: string, rows: Row[], total: number): Row[] {
  if (!total) return [];
  return [
    { type: "Title", value: title, size: "sm" },
    { type: "Col", gap: 2, children: rows },
    ...(total > rows.length ? [{ type: "Caption", value: `and ${total - rows.length} more` }] : []),
  ];
}

function recapCard(facts: RecapFacts, now: number, bots: Map<string, BotRecord>, runTargets: Map<string, OpenTarget | undefined>, timeZone: string | undefined): WidgetRoot {
  const take = <T,>(items: T[]) => items.slice(0, RECAP_LIMITS.rows);
  const sinceText = new Date(facts.since).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
  const hours = Math.max(1, Math.round((now - facts.since) / 3_600_000));
  const children: Row[] = [
    { type: "Caption", value: `Away since ${sinceText}, about ${hours} hour${hours === 1 ? "" : "s"}.` },
    ...section("Finished", take(facts.finished).map((item) => row(item.botName, item.summary, { botId: item.botId, threadId: item.threadId })), facts.finished.length),
    ...section("Failed", take(facts.failed).map((item) => row(item.botName, item.reason, { botId: item.botId, threadId: item.threadId }, { label: "Failed", color: "danger" })), facts.failed.length),
    ...section("Still running", take(facts.running).map((item) => row(item.botName, undefined, { botId: item.botId, threadId: item.threadId }, { label: "Running", color: "info" })), facts.running.length),
    ...section("Routines", take(facts.routineRuns).map((item) => {
      return row(item.name, item.count > 1 ? `${item.count} runs` : undefined, item.threadId ? runTargets.get(item.threadId) : undefined, { label: item.status, color: item.status === "completed" ? "success" : item.status === "failed" || item.status === "missed" ? "danger" : "info" });
    }), facts.routineRuns.length),
    ...section("Waiting on you", take(facts.waitingOnYou).map((item) => row(item.title, bots.get(item.botId)?.name, { botId: item.botId, threadId: item.threadId }, { label: "Needs you", color: "warning" })), facts.waitingOnYou.length),
  ];
  return { type: "Card", id: "root", title: RECAP_TITLE, children } as unknown as WidgetRoot;
}
