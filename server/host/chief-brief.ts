import { join } from "node:path";

import type { WidgetRoot } from "../../shared/widget.ts";
import { audienceWithin, roomFeeds, type ThreadOwner } from "../bot-visibility.ts";
import { createAgentCard } from "../chat-widgets.ts";
import { mainThread } from "../main-thread.ts";
import type { RoutineRun } from "../routines.ts";
import { sectionKey, type BotRecord, type Message, type Store } from "../store.ts";
import { readUsage } from "../usage-ledger.ts";
import { buildRecap, type RecapDeps } from "./brief-recap.ts";
import { createBriefState, type BriefState, type BriefStateStore } from "./brief-state.ts";
import { createPresence, type PresenceSource } from "./presence.ts";

export { ownerOrAdmin as presenceOwner } from "../request-auth.ts";

export interface ChiefBriefDeps {
  store: Pick<Store, "bots" | "bot" | "group" | "tasks" | "messagesFor" | "messagesTail" | "appendMessage" | "patchMessage" | "patchTask" | "groupByThread">;
  dataDir: string;
  now?: () => number;
  settings(): { recap: boolean; awayMs: number };
  threadOwner(threadId: string): ThreadOwner | undefined;
  hosted: boolean;
  threadBusy: RecapDeps["threadBusy"];
  /** Runs that finished at or after `since`, or have not finished, whenever they were scheduled. */
  routineRuns(since: number): RoutineRun[];
  /** MausBot, which posts the recap when there is no Chief. */
  mausbot?(): BotRecord | null;
  /** Each owner activation, after a return's recap and before the answer chooses what to open. */
  onPresence?(event: { source: PresenceSource; returned: boolean }): void;
}

export interface PresenceAnswer {
  returned: boolean;
  /** MausBot's newest card, else the latest recap card, sent once to each client (desktop, phone) when it was posted at
   * or after the start of the absence the latest return ended (before any return since start-up, at or after the
   * previous activation), and only to a client arriving: on a return, or when that client's own last activation is
   * missing or older than the away time. */
  open?: { botId: string; threadId: string };
}

export const BRIEF_STATE_FILE = "brief.json";
const USAGE_WINDOW_MS = 30 * 24 * 60 * 60_000;
const TURNS_CACHE_MS = 10 * 60_000;

export function activePathTail(store: Pick<Store, "messagesTail">, threadId: string, n: number): Message[] {
  const { messages, activeLeafId } = store.messagesTail(threadId, n);
  const byId = new Map(messages.map((line) => [line.id, line]));
  const path: Message[] = [];
  let line = activeLeafId ? byId.get(activeLeafId) : undefined;
  while (line && path.length < messages.length) {
    path.push(line);
    line = line.parentId ? byId.get(line.parentId) : undefined;
  }
  return path.reverse();
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function createChiefBrief(deps: ChiefBriefDeps) {
  const now = deps.now ?? Date.now;
  const state: BriefStateStore = createBriefState(join(deps.dataDir, BRIEF_STATE_FILE));
  let unsavedCard: BriefState["lastCard"];
  let unsavedAssistantCard: BriefState["assistantCard"];

  function savePatch(changes: Parameters<BriefStateStore["patch"]>[0]): boolean {
    try {
      state.patch(changes);
      return true;
    } catch (error) {
      console.warn(`brief: could not save ${BRIEF_STATE_FILE}: ${failure(error)}`);
      return false;
    }
  }

  function lastCard(): BriefState["lastCard"] {
    const saved = state.get().lastCard;
    return unsavedCard && (!saved || unsavedCard.at > saved.at) ? unsavedCard : saved;
  }

  function lastAssistantCard(): BriefState["assistantCard"] {
    const saved = state.get().assistantCard;
    return unsavedAssistantCard && (!saved || unsavedAssistantCard.at > saved.at) ? unsavedAssistantCard : saved;
  }

  function noteAssistantCard(card: { botId: string; threadId: string }): void {
    if (deps.hosted) return;
    const noted = { at: now(), botId: card.botId, threadId: card.threadId, kind: "assistant" as const };
    unsavedAssistantCard = savePatch({ assistantCard: noted }) ? undefined : noted;
  }

  let turnsCache: { at: number; counts: Map<string, number> } | undefined;
  function turnsByBot(): Map<string, number> {
    const at = now();
    if (turnsCache && at >= turnsCache.at && at - turnsCache.at < TURNS_CACHE_MS) return turnsCache.counts;
    const counts = new Map<string, number>();
    for (const row of readUsage(deps.dataDir, { from: new Date(at - USAGE_WINDOW_MS), to: new Date(at) })) {
      counts.set(row.botId, (counts.get(row.botId) ?? 0) + 1);
    }
    turnsCache = { at, counts };
    return counts;
  }

  function chief(): BotRecord | null {
    const chiefs = deps.store.bots.filter((bot) => bot.chiefOfStaff && !bot.hidden);
    const general = chiefs.find((bot) => sectionKey(bot.section) === "");
    if (general || chiefs.length === 0) return general ?? null;
    const turns = turnsByBot();
    const perTeam = new Map<string, number>();
    for (const bot of deps.store.bots) perTeam.set(sectionKey(bot.section), (perTeam.get(sectionKey(bot.section)) ?? 0) + (turns.get(bot.id) ?? 0));
    return [...chiefs].sort((a, b) => (perTeam.get(sectionKey(b.section)) ?? 0) - (perTeam.get(sectionKey(a.section)) ?? 0))[0] ?? null;
  }

  const chiefThread = (bot: BotRecord): string | undefined => mainThread(deps.store.tasks(bot.id), bot.threadId);

  /** Only what everyone who can see the poster may also see: its card lands in a chat all of them can read. */
  function seenWith(poster: BotRecord): RecapDeps["visible"] {
    const bot = (id: string): boolean => {
      const other = deps.store.bot(id);
      return other !== null && audienceWithin(poster.visibility, other.visibility);
    };
    const room = (groupId: string): boolean => {
      const group = deps.store.group(groupId);
      if (!group) return false;
      const members = group.memberIds.flatMap((id) => {
        const member = deps.store.bot(id);
        return member ? [member.visibility] : [];
      });
      return roomFeeds([...members, group.audienceFloor], poster.visibility);
    };
    return {
      bot,
      room,
      thread: (threadId) => {
        const owner = deps.threadOwner(threadId);
        if (owner?.bot !== undefined) return bot(owner.bot);
        return owner?.group !== undefined && room(owner.group);
      },
    };
  }

  const recapInputs = (visible: RecapDeps["visible"]): RecapDeps => ({
    store: {
      bots: deps.store.bots,
      tasks: (botId) => deps.store.tasks(botId),
      messagesTail: (thread, n) => activePathTail(deps.store, thread, n),
    },
    visible, threadBusy: deps.threadBusy, routineRuns: deps.routineRuns, now,
  });

  function postCard(bot: BotRecord, threadId: string, card: WidgetRoot): boolean {
    const posted = createAgentCard({ store: deps.store, bot, threadId, input: { tool: "show_widget", widget: card }, serverCard: true });
    if (!posted.ok) {
      console.warn(`brief: the card was refused: ${posted.error}`);
      return false;
    }
    try {
      deps.store.patchTask(bot.id, threadId, { unread: true });
    } catch (error) {
      console.warn(`brief: could not mark the chat unread: ${failure(error)}`);
    }
    return true;
  }

  function postRecap(since: number): boolean {
    if (deps.hosted || !deps.settings().recap) return false;
    const bot = chief() ?? deps.mausbot?.() ?? null;
    const threadId = bot && chiefThread(bot);
    if (!bot || !threadId) return false;
    const recap = buildRecap(recapInputs(seenWith(bot)), { since, exclude: { threadId }, timeZone: state.get().timeZone });
    if (!recap) return false;
    if (!postCard(bot, threadId, recap.card)) return false;
    const card = { at: now(), botId: bot.id, threadId, kind: "recap" as const };
    unsavedCard = savePatch({ lastCard: card }) ? undefined : card;
    return true;
  }

  /** Security invariant: counts only what everyone who can see the Chief may also see. */
  function teamLine(since: number): { text: string; open: { botId: string; threadId: string } } | null {
    if (deps.hosted) return null;
    const bot = chief();
    const threadId = bot && chiefThread(bot);
    if (!bot || !threadId) return null;
    const facts = buildRecap(recapInputs(seenWith(bot)), { since, exclude: { threadId } })?.facts;
    const parts = facts
      ? [facts.finished.length && `${facts.finished.length} finished`, facts.failed.length && `${facts.failed.length} failed`, facts.waitingOnYou.length && `${facts.waitingOnYou.length} waiting on you`].filter(Boolean)
      : [];
    return { text: parts.length ? `${bot.name}: ${parts.join(" · ")}` : `${bot.name}: nothing new from the team`, open: { botId: bot.id, threadId } };
  }

  let absenceStart: number | undefined;
  const presence = createPresence({
    dataDir: deps.dataDir, now, awayMs: () => deps.settings().awayMs,
    onReturn: (since) => {
      absenceStart = since;
      postRecap(since);
    },
  });

  const openedBy = new Map<PresenceSource, number>();
  const sourceActiveAt = new Map<PresenceSource, number>();

  function active(source: PresenceSource, timeZone?: string): PresenceAnswer {
    if (deps.hosted) return { returned: false };
    if (timeZone && timeZone !== state.get().timeZone) savePatch({ timeZone });
    const outcome = presence.active(source);
    try {
      deps.onPresence?.({ source, returned: outcome.returned });
    } catch (error) {
      console.warn(`brief: the presence hook failed: ${failure(error)}`);
    }
    const at = now();
    const sourcePrevious = sourceActiveAt.get(source);
    sourceActiveAt.set(source, at);
    const arriving = outcome.returned || sourcePrevious === undefined || at - sourcePrevious >= deps.settings().awayMs;
    const floor = absenceStart ?? outcome.previousActiveAt ?? -Infinity;
    const told = openedBy.get(source) ?? -Infinity;
    const fresh = (card: BriefState["lastCard"] | BriefState["assistantCard"]) => card !== undefined && card.at >= floor && card.at > told;
    const assistant = lastAssistantCard();
    const recap = lastCard();
    const card = fresh(assistant) ? assistant : fresh(recap) ? recap : undefined;
    if (!arriving || !card) return { returned: outcome.returned };
    openedBy.set(source, Math.max(assistant?.at ?? -Infinity, recap?.at ?? -Infinity));
    return { returned: outcome.returned, open: { botId: card.botId, threadId: card.threadId } };
  }

  return { state, presence, chief, chiefThread, turnsByBot, postRecap, active, noteAssistantCard, teamLine };
}
