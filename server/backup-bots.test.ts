import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiTestState } from "../shared/ai-ranking.ts";
import { createBackupBots, type BackupBotsDeps } from "./backup-bots.ts";
import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import type { SelectableInstance } from "./default-model-selection.ts";
import { removeTempDir } from "./testing/cleanup.ts";

type Task = { threadId: string; modelSelection?: ModelSelection };
type Bot = { id: string; name: string; threadId: string; chiefOfStaff?: boolean; modelSelection: ModelSelection; tasks: Task[] };
type Change = { type: string; botId?: string };
type Line = { threadId: string; message: { role: string; kind?: string; tool?: { name: string; ok: boolean } } };

const BACKUP: ModelSelection = { instanceId: "opencodeGo", model: "opencode/glm-5.3-flash-free" };
const CLAUDE: ModelSelection = { instanceId: "claude", model: "claude-sonnet-5" };
const instance = (instanceId: string, driverKind: string, model: string, snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
  instanceId, driverKind, snapshot: { state: "available", authenticated: true, ...snapshot }, models: { default: model, options: [{ id: model, label: model }] },
});
const backup = instance("opencodeGo", "opencodeGo", BACKUP.model, { freeFallback: true });
const claude = instance("claude", "claudeAgent", CLAUDE.model);

/** The store's bots, their conversations' model choices, chat lines and change events. */
class FakeStore {
  bots: Bot[] = [];
  lines: Line[] = [];
  private listeners = new Set<(change: Change) => void>();
  bot(id: string) { return this.bots.find((bot) => bot.id === id); }
  tasks(botId: string) { return this.bot(botId)?.tasks ?? []; }
  /** A bot made with the default, as the New Bot form and the Chief make them. */
  create(id: string, modelSelection: ModelSelection, extra: Partial<Bot> = {}) {
    this.bots.push({ id, name: id, threadId: `${id}-main`, modelSelection: structuredClone(modelSelection), tasks: [{ threadId: `${id}-main` }], ...extra });
    this.emit({ type: "bot", botId: id });
  }
  applyModelDefault = vi.fn((botId: string, selection: ModelSelection) => this.choose(botId, selection));
  /** Anything that sets a bot's model: the person's picker, a team setup, the app's own default. */
  choose(botId: string, selection: ModelSelection) {
    const bot = this.bot(botId)!;
    bot.modelSelection = structuredClone(selection);
    this.emit({ type: "bot", botId });
    return bot;
  }
  remove(botId: string) {
    this.bots = this.bots.filter((bot) => bot.id !== botId);
    this.emit({ type: "bot.deleted", botId });
  }
  appendMessage(threadId: string, message: Line["message"]) {
    this.lines.push({ threadId, message });
    return message;
  }
  onChange(listener: (change: Change) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(change: Change) { for (const listener of this.listeners) listener(change); }
}

describe("bots leave the free backup once the person's own AI answers", () => {
  let store: FakeStore;
  let states: Record<string, AiTestState | undefined>;
  let busy: Set<string>;
  let data: string;

  const make = (extra: Partial<BackupBotsDeps> = {}) => createBackupBots({
    store: () => store as unknown as ReturnType<BackupBotsDeps["store"]>,
    threadBusy: (botId, threadId) => busy.has(`${botId}/${threadId}`),
    forBot: (selection) => ({ ...selection, effort: "high" }),
    name: (instanceId) => instanceId === "claude" ? "Claude" : instanceId,
    tested: (candidate) => states[candidate.instanceId],
    company: (instanceId) => instanceId.startsWith("company"),
    file: join(data, "providers", "backup-bots.json"),
    ...extra,
  });
  /** The backup is the default: what server/index.ts hands on while nothing else answers. */
  const onBackup = (bots: ReturnType<typeof make>) => bots.settle([backup], BACKUP);
  /** A bot the app gives the default: made without a model, or filled in when it had none. */
  const appMade = (bots: ReturnType<typeof make>, id: string, extra: Partial<Bot> = {}) => {
    store.create(id, BACKUP, extra);
    bots.assigned(id, BACKUP);
  };
  const nowUsing = (botId: string) => store.lines.filter((line) => line.threadId === `${botId}-main`).map((line) => line.message.tool?.name);

  beforeEach(() => {
    store = new FakeStore();
    states = {};
    busy = new Set();
    data = mkdtempSync(join(tmpdir(), "omb-backup-bots-"));
  });
  afterEach(async () => {
    await removeTempDir(data);
  });

  it("moves a bot made while the backup was the default to the person's AI once it passes, with one line in its chat", () => {
    const bots = make();
    onBackup(bots);
    appMade(bots, "helper");
    // Claude is connected and its test message is under way: nothing moves yet.
    states.claude = "testing";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual({ ...CLAUDE, effort: "high" });
    expect(store.lines).toEqual([{ threadId: "helper-main", message: { role: "bot", kind: "activity", tool: { name: "Now using Claude.", ok: true } } }]);
    // Once.
    bots.settle([claude, backup], CLAUDE);
    expect(store.lines).toHaveLength(1);
  });

  it("moves the first bot too, after the person has written to it", () => {
    store.create("chief", { instanceId: "", model: "" }, { chiefOfStaff: true });
    const bots = make();
    onBackup(bots);
    // The app gives the first bot the default once one can run (tested-ai, or the unset-model refresh).
    store.applyModelDefault("chief", BACKUP);
    bots.assigned("chief", BACKUP);
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("chief")!.modelSelection).toEqual({ ...CLAUDE, effort: "high" });
    expect(nowUsing("chief")).toEqual(["Now using Claude."]);
  });

  it("leaves a bot the person put on the backup's model themselves while it was the default", () => {
    const bots = make();
    onBackup(bots);
    store.create("helper", { instanceId: "grok", model: "grok-5" });
    store.choose("helper", BACKUP);
    // And one the person made with that model picked in the New Bot form.
    store.create("chosen", BACKUP);
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
    expect(store.bot("chosen")!.modelSelection).toEqual(BACKUP);
    expect(store.lines).toEqual([]);
  });

  it("notes nothing the app assigns while the backup isn't the default", () => {
    const bots = make();
    states.claude = "testing";
    bots.settle([claude, backup], CLAUDE);
    store.create("helper", BACKUP);
    bots.assigned("helper", BACKUP);
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
  });

  it("leaves a bot whose model the person chose, and a bot made on another AI", () => {
    const bots = make();
    onBackup(bots);
    appMade(bots, "picked");
    store.choose("picked", { instanceId: "grok", model: "grok-5" });
    store.create("elsewhere", { instanceId: "grok", model: "grok-5" });
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("picked")!.modelSelection).toEqual({ instanceId: "grok", model: "grok-5" });
    expect(store.bot("elsewhere")!.modelSelection).toEqual({ instanceId: "grok", model: "grok-5" });
    expect(store.lines).toEqual([]);
  });

  it("leaves a bot the person put back on the backup themselves once it was no longer the default", () => {
    const bots = make();
    onBackup(bots);
    appMade(bots, "helper");
    store.choose("helper", { instanceId: "grok", model: "grok-5" });
    // Claude is the default now, still being tested, and the person picks the free model again on purpose.
    states.claude = "testing";
    bots.settle([claude, backup], CLAUDE);
    store.choose("helper", BACKUP);
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
    expect(store.lines).toEqual([]);
  });

  it("leaves a bot the person moved off the backup while the app was closed", () => {
    const first = make();
    onBackup(first);
    appMade(first, "helper");
    // The app restarts with the bot on another model.
    const reopened = new FakeStore();
    reopened.bots = [{ id: "helper", name: "helper", threadId: "helper-main", modelSelection: { instanceId: "grok", model: "grok-5" }, tasks: [{ threadId: "helper-main" }] }];
    store = reopened;
    states.claude = "passed";
    make().settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual({ instanceId: "grok", model: "grok-5" });
    expect(store.lines).toEqual([]);
  });

  it("waits until a bot's reply is done, then moves it without waiting for another read of the engines", () => {
    const timers: Array<{ ms: number; run: () => void; cancelled: boolean }> = [];
    const bots = make({ after: (ms, run) => {
      const timer = { ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    } });
    onBackup(bots);
    appMade(bots, "helper");
    busy.add("helper/helper-main");
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
    // Still replying when the retry comes: it tries again later.
    expect(timers.filter((timer) => !timer.cancelled)).toHaveLength(1);
    timers.at(-1)!.run();
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
    busy.clear();
    timers.filter((timer) => !timer.cancelled).at(-1)!.run();
    expect(store.bot("helper")!.modelSelection).toEqual({ ...CLAUDE, effort: "high" });
    expect(nowUsing("helper")).toEqual(["Now using Claude."]);
    expect(timers.every((timer) => timer.ms === 5_000)).toBe(true);
  });

  it.each<[string, () => [SelectableInstance[], ModelSelection]]>([
    ["the new default didn't answer its test", () => { states.claude = "failed"; return [[claude, backup], CLAUDE]; }],
    ["the new default has no one-off call to test with", () => { states.claude = "untestable"; return [[claude, backup], CLAUDE]; }],
    ["the default is still a free backup", () => { states.opencodeGo = "passed"; return [[backup], BACKUP]; }],
    ["the default is company models", () => {
      states["company-claude"] = "passed";
      return [[instance("company-claude", "claudeAgent", "claude-sonnet-5"), backup], { instanceId: "company-claude", model: "claude-sonnet-5" }];
    }],
    ["there is no default", () => [[backup], { instanceId: "", model: "" }]],
  ])("moves nothing while %s", (_label, arrange) => {
    const bots = make();
    onBackup(bots);
    appMade(bots, "helper");
    bots.settle(...arrange());
    expect(store.bot("helper")!.modelSelection).toEqual(BACKUP);
    expect(store.lines).toEqual([]);
  });

  it("remembers which bots the app put on the backup across a restart", () => {
    const first = make();
    onBackup(first);
    appMade(first, "helper");
    const again = make();
    states.claude = "passed";
    again.settle([claude, backup], CLAUDE);
    expect(store.bot("helper")!.modelSelection).toEqual({ ...CLAUDE, effort: "high" });
  });

  it("forgets a bot that was deleted", () => {
    const bots = make();
    onBackup(bots);
    appMade(bots, "helper");
    store.remove("helper");
    // A new bot that happens to reuse the id is not one the app put on the backup.
    store.bots.push({ id: "helper", name: "helper", threadId: "helper-main", modelSelection: structuredClone(BACKUP), tasks: [{ threadId: "helper-main" }] });
    states.claude = "passed";
    bots.settle([claude, backup], CLAUDE);
    expect(store.lines).toEqual([]);
  });
});
