import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import type { WidgetAction } from "../../shared/widget.ts";
import { createComposioSources } from "../assistant-sources.ts";
import { audienceWithin } from "../bot-visibility.ts";
import { assistantActsEnabled } from "../brief-settings.ts";
import type * as Composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { findMausBot, isMausBot } from "../mausbot.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message, Store } from "../store.ts";
import { hostTimeZone } from "../turn-clock.ts";
import type { UsageTrigger } from "../usage-ledger.ts";
import { DEFAULT_CHECK_MS } from "./assistant-plan.ts";
import { createAssistantTurns } from "./assistant-turns.ts";
import { createAssistantWatch, type AssistantWatchDeps } from "./assistant-watch.ts";
import type { createChiefBrief } from "./chief-brief.ts";
import { createMausBotIntro, type MausBotIntroDeps } from "./mausbot-intro.ts";
import type { HarnessCard } from "./quota-switch.ts";

const MIN_CHECK_MS = 1_000;
const JOB_TRIGGER: UsageTrigger = { kind: "routine", label: "MausBot" };
const TOO_LONG = "MausBot's work took too long";

/** `OMB_ASSISTANT_CHECK_MS`: how often the watcher reads Calendar and Gmail, at least once a second. */
export function assistantCheckMs(raw: string | undefined): number {
  return Math.max(MIN_CHECK_MS, Number(raw) || DEFAULT_CHECK_MS);
}

/** Security invariant: a job's answer is only the bot's own text in that turn, never a tool's output or the prompt. */
export function jobReply(lines: readonly Message[], turnId: string | undefined): string {
  if (!turnId) return "";
  return lines.filter((line) => line.role === "bot" && line.kind === "text" && line.turnId === turnId).map((line) => line.text ?? "").join("\n\n");
}

export interface MausBotHostDeps {
  store: AssistantWatchDeps["store"] & MausBotIntroDeps["store"] & Pick<Store, "botByThread" | "createTask">;
  cfg: AppConfig;
  composio: Pick<typeof Composio, "configured" | "connectedServices" | "relayMcp">;
  registry: Pick<ProviderRegistry, "get">;
  brief: Pick<ReturnType<typeof createChiefBrief>, "state" | "chiefThread" | "turnsByBot" | "noteAssistantCard" | "routineRows">;
  dataDir: string;
  hosted: boolean;
  cloudHome: boolean;
  maxBots: number;
  notify: AssistantWatchDeps["notify"];
  threadBusy: AssistantWatchDeps["threadBusy"];
  newId(): string;
  startTurn(botId: string, text: string, opts: { threadId: string; unattended: true; trigger: UsageTrigger }): Promise<unknown>;
  interruptDirectThread(botId: string, threadId: string, cause: string): Promise<void>;
  /** Asked only on a Cloud home: true when no guest started or drove the conversation. */
  cloudOwnerOnlyThread(threadId: string): boolean;
  /** True when someone other than an admin can sign in or holds a session. */
  othersMaySee(): boolean;
  checkMs?: number;
}

export function createMausBotHost(deps: MausBotHostDeps) {
  const { store, cfg, composio, brief } = deps;
  const intro = createMausBotIntro({
    store, state: brief.state, hosted: deps.hosted, maxBots: deps.maxBots, mainThread: (bot) => brief.chiefThread(bot), turnsByBot: brief.turnsByBot,
    configured: () => composio.configured(cfg), connected: () => composio.connectedServices(cfg), newId: deps.newId,
  });
  const turns = createAssistantTurns({
    createJobThread: (botId, title, routineRunId) => store.createTask(botId, title, false, undefined, undefined, "ask", undefined, undefined, routineRunId),
    start: (botId, threadId, prompt) => deps.startTurn(botId, prompt, { threadId, unattended: true, trigger: JOB_TRIGGER }),
    interrupt: (botId, threadId) => deps.interruptDirectThread(botId, threadId, TOO_LONG),
    replyOf: (threadId, turnId) => jobReply(store.messagesFor(threadId), turnId),
  });
  const enabled = (): boolean => assistantActsEnabled(cfg.features) && brief.state.get().mausbotIntro !== undefined;
  const visibleMausBot = (): BotRecord | null => findMausBot(store.bots.filter((bot) => !bot.hidden));
  const watch = createAssistantWatch({
    store, dataDir: deps.dataDir, hosted: deps.hosted, notify: deps.notify, threadBusy: deps.threadBusy, newId: deps.newId,
    checkMs: deps.checkMs ?? assistantCheckMs(process.env.OMB_ASSISTANT_CHECK_MS),
    enabled,
    mausbot: visibleMausBot,
    routines: (since) => {
      const bot = visibleMausBot();
      return bot ? brief.routineRows(bot, since) : [];
    },
    mainThread: (bot) => brief.chiefThread(bot),
    timeZone: () => brief.state.get().timeZone ?? (deps.cloudHome ? undefined : hostTimeZone()),
    capabilities: (bot) => {
      const engine = deps.registry.get(bot.modelSelection.instanceId)?.adapter.capabilities;
      return { agentsTools: engine?.agentsMcp === true, mailTools: engine?.composioMcp === true };
    },
    sources: createComposioSources({
      configured: () => composio.configured(cfg),
      connectedServices: () => composio.connectedServices(cfg),
      relay: (payload, session, signal) => composio.relayMcp(cfg, payload as Parameters<typeof composio.relayMcp>[1], session, undefined, signal),
    }),
    runJob: (bot, title, prompt) => turns.run(bot.id, title, prompt),
    noteCard: (card) => brief.noteAssistantCard(card),
    threadOf: (threadId) => {
      const owner = store.botByThread(threadId);
      return owner ? { bot: owner, cloudGuest: deps.cloudHome && !deps.cloudOwnerOnlyThread(threadId) } : null;
    },
  });

  /** The records a press on one of MausBot's cards is about; a press anywhere else, or one MausBot cannot place, stays
   * the person's plain answer to the card. */
  function pressRecords(bot: Pick<BotRecord, "builtIn">, action: WidgetAction): string | null {
    return isMausBot(bot) ? watch.pressRecords(action) : null;
  }

  function serverPress(bot: Pick<BotRecord, "builtIn">, threadId: string, messageId: string, action: WidgetAction, auth: RequestAuth): "handled" | "refused" | null {
    return isMausBot(bot) ? watch.serverPress(threadId, messageId, action, auth) : null;
  }

  /** True when MausBot's brief reports routine runs in place of `poster`'s recap: everyone who reads that recap can see MausBot. */
  function takesRoutines(poster: Pick<BotRecord, "visibility">): boolean {
    const mausbot = visibleMausBot();
    return !deps.hosted && enabled() && mausbot !== null && (audienceWithin(poster.visibility, mausbot.visibility) || !deps.othersMaySee());
  }

  function introduce(): void {
    void intro.introduce();
  }

  function onPresence(event: { source: string; returned: boolean }): void {
    watch.onPresence(event);
  }

  function onEvent(event: RuntimeEvent): void {
    if (event.type === "turn.completed") turns.completed(event.threadId, event.ok, event.turnId);
  }

  const harnessCards: HarnessCard[] = [intro.answerCard, watch.answerCard];
  return { start: watch.start, stop: watch.stop, introduce, onPresence, onEvent, pressRecords, serverPress, takesRoutines, harnessCards };
}
