// Bots leave OpenCode's free backup once the person's own AI answers. While the backup is the new-bot default
// (server/free-fallback.ts), every bot that gets it from the app (the first bot, bots made with the default) is noted.
// When the person's own AI later passes its test message and becomes the default, each noted bot whose model is still
// that backup moves to it once, with one plain line in its chat ("Now using Claude."), even after the person has written
// to it: unlike tested-ai's following first bot, writing to a bot is no choice of the backup. A bot whose model the
// person changed is no longer noted, and nothing moves while a bot is replying.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { freeFallback, type AiTestState } from "../shared/ai-ranking.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";
import type { SelectableInstance } from "./default-model-selection.ts";
import type { Store } from "./store.ts";

export interface BackupBotsDeps {
  store(): Pick<Store, "bots" | "bot" | "tasks" | "applyModelDefault" | "appendMessage" | "onChange">;
  threadBusy(botId: string, threadId: string): boolean;
  /** The selection a bot gets when it follows the default: the new-bot effort added. */
  forBot(selection: ModelSelection): ModelSelection;
  /** The AI's name as the person sees it. */
  name(instanceId: string): string;
  /** Its test message's state (server/tested-ai.ts). */
  tested(instance: SelectableInstance): AiTestState | undefined;
  /** An organisation's models or the trial credit: not the person's own AI. */
  company?(instanceId: string): boolean;
  /** Where the noted bots are kept; none keeps them in memory. */
  file?: string;
}

const same = (a: ModelSelection, b: ModelSelection) => a.instanceId === b.instanceId && a.model === b.model;
const exactly = (a: ModelSelection, b: ModelSelection) => same(a, b) && a.effort === b.effort && a.variant === b.variant;
const keyOf = (selection: ModelSelection) => JSON.stringify([selection.instanceId, selection.model, selection.effort ?? null, selection.variant ?? null]);

function load(file: string | undefined): Record<string, ModelSelection> {
  if (!file) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { bots?: unknown };
    const bots = raw.bots && typeof raw.bots === "object" && !Array.isArray(raw.bots) ? raw.bots as Record<string, unknown> : {};
    return Object.fromEntries(Object.entries(bots).filter((entry): entry is [string, ModelSelection] => {
      const selection = entry[1] as Partial<ModelSelection> | null;
      return typeof selection?.instanceId === "string" && typeof selection.model === "string";
    }));
  } catch {
    return {};
  }
}

export function createBackupBots(deps: BackupBotsDeps) {
  const noted = load(deps.file);
  /** Each bot's model as last seen, so a change event tells a new choice from anything else. */
  const seen = new Map<string, string>();
  let backupDefault: ModelSelection | null = null;
  let listening = false;

  const save = () => {
    if (!deps.file) return;
    try {
      mkdirSync(dirname(deps.file), { recursive: true });
      writeFileAtomic(deps.file, JSON.stringify({ bots: noted }), { mode: 0o600 });
    } catch (error) {
      console.warn(`[engines] could not keep which bots are on the free backup: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** A bot given the backup while it is the default is the app's pick; any other change of model ends that. */
  const listen = () => {
    if (listening) return;
    listening = true;
    const store = deps.store();
    for (const bot of store.bots) seen.set(bot.id, keyOf(bot.modelSelection));
    store.onChange((change) => {
      if (change.type === "bot.deleted") {
        seen.delete(change.botId);
        if (noted[change.botId]) {
          delete noted[change.botId];
          save();
        }
        return;
      }
      if (change.type !== "bot") return;
      const bot = store.bot(change.botId);
      if (!bot) return;
      const key = keyOf(bot.modelSelection);
      if (seen.get(bot.id) === key) return;
      seen.set(bot.id, key);
      if (backupDefault && same(bot.modelSelection, backupDefault)) {
        noted[bot.id] = structuredClone(bot.modelSelection);
        save();
      } else if (noted[bot.id]) {
        delete noted[bot.id];
        save();
      }
    });
  };

  return {
    /** The engines the latest read found and the default chosen from them (tested-ai's settle). */
    settle(instances: readonly SelectableInstance[], selection: ModelSelection): void {
      listen();
      const to = instances.find((candidate) => candidate.instanceId === selection.instanceId);
      if (!to || !selection.model) return;
      if (freeFallback(to)) {
        backupDefault = structuredClone(selection);
        return;
      }
      backupDefault = null;
      if (deps.company?.(to.instanceId) === true || deps.tested(to) !== "passed") return;
      const store = deps.store();
      let changed = false;
      for (const [botId, was] of Object.entries(noted)) {
        const bot = store.bot(botId);
        if (!bot || !exactly(bot.modelSelection, was)) {
          delete noted[botId];
          changed = true;
          continue;
        }
        if (store.tasks(bot.id).some((task) => deps.threadBusy(bot.id, task.threadId))) continue;
        delete noted[botId];
        changed = true;
        store.applyModelDefault(bot.id, structuredClone(deps.forBot(selection)));
        store.appendMessage(bot.threadId, { role: "bot", kind: "activity", tool: { name: `Now using ${deps.name(to.instanceId)}.`, ok: true } });
      }
      if (changed) save();
    },
  };
}

export type BackupBots = ReturnType<typeof createBackupBots>;
