// OpenCode's free backup, installed without a word. When no AI of the person's own can answer (none is ready, or every
// ready one missed its test message twice) on two reads of the engines at least 90 seconds apart (on the first read when no
// AI program is installed at all and nothing says this is a company's computer), and there is no OpenCode on this computer
// at all, the app installs its own copy of OpenCode's build (no Node.js) in the background so the first
// bot can still reply through a free model that keeps nothing (drivers/acp/opencode-go.ts). Nothing here picks a default:
// the new copy is read, gets its test message and ranks last like any free backup (server/tested-ai.ts,
// shared/ai-ranking.ts), so it becomes the default only when nothing else answered.
//
// Never on a saved default, a hosted workspace, any Cloud home, a server people sign in to, a branded build, an
// organisation-managed computer, or an OpenCode the person set up themselves; never before the company runtime has
// started. A copy the app installed is kept on its pinned version while a bot uses it or nothing else can answer
// (the installer swaps versions in place), never on a managed computer. Nothing is ever removed: once a real AI answers,
// the backup just ranks last.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { freeFallback } from "../shared/ai-ranking.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";
import { standaloneLookupPath } from "./engine-install.ts";
import { isAppStandaloneCopy, standaloneAssetFor, standaloneStaleCopy } from "./engine-standalone.ts";
import { findCliCandidates } from "./env-path.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

const DRIVER = "opencodeGo";
const COMMAND = "opencode";
/** Nothing can answer on two reads this far apart, every engine probed afresh for the second: a CLI slow on a cold start,
 * or a company connection that arrives after start-up, is seen before anything is installed. */
const CONFIRM_MS = 90_000;

/** OMB_DESKTOP_ENROLLED=1: the desktop app found its company connection when it started this server. */
export function companyDesktopHint(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OMB_DESKTOP_ENROLLED === "1";
}

/** 90 seconds; a sealed test fixture (env-path.ts) may shorten it with OMB_FREE_FALLBACK_CONFIRM_MS, never below a second. */
export function confirmWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const asked = Number(env.OMB_FREE_FALLBACK_CONFIRM_MS);
  return env.OMB_TEST_SEALED_PATH === "1" && Number.isFinite(asked) && asked > 0 ? Math.max(1_000, asked) : CONFIRM_MS;
}
/** Between attempts that left OpenCode missing or old: 10 minutes, an hour, then once a day. */
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;

/** Where the person's AI is not the app's to choose, or the app runs on behalf of other people. */
export interface FreeFallbackPlace {
  hostedWorkspace?: boolean;
  /** Any Cloud home, personal or team, with trial credit or not. */
  cloudHome?: boolean;
  /** A server people sign in to (an allow-list of sign-ins). */
  sharedSignIn?: boolean;
  branded?: boolean;
  organisationManaged?: boolean;
}

export interface FreeFallbackDeps {
  registry: Pick<ProviderRegistry, "installRuntime" | "refreshModels" | "cliTarget" | "forgetSnapshots">;
  /** The new-bot default's context: refusals, company models and test results (server/tested-ai.ts). */
  context: DefaultSelectionContext;
  /** The defaults the person saved: the default model and the New Bot defaults' model. */
  saved(): ReadonlyArray<ModelSelection | undefined>;
  place(): FreeFallbackPlace;
  /** An install finished or a wait ended: the server reads the engines again, which settles here. */
  changed(): Promise<unknown> | void;
  /** Nothing is decided before this settles: the company runtime has started. */
  ready?: Promise<unknown>;
  /** Nothing is decided from these engines while the start-up read is unfinished or they come from the last run's status
   * (registry.provisional()). */
  provisional?(instances: readonly SelectableInstance[]): boolean;
  /** Whether any bot runs on this engine. */
  botsOn?(instanceId: string): boolean;
  /** Where the wait between attempts is kept; none keeps it in memory. */
  file?: string;
  /** freeFallbackInstalls() unless given. */
  enabled?: boolean;
  /** Whether OpenCode has a build of its own for this computer; never npm in the background. */
  buildHere?: boolean;
  /** Every copy of a command on the app's PATH (findCliCandidates). */
  copies?(cli: string): string[];
  /** Whether a command runs the app's own copy, found the way OpenCode's processes find it (isAppStandaloneCopy). */
  appCopy?(cli: string): boolean;
  /** The app's own copy left on an older pin (standaloneStaleCopy). */
  staleCopy?(): { version: string } | null;
  /** Whether an AI program's command is installed here (findCliCandidates, files that exist). */
  installed?(cli: string): boolean;
  /** This desktop is enrolled with a company (companyDesktopHint unless given). */
  companyHint?: boolean;
  now?(): number;
  after?(ms: number, run: () => void): { cancel(): void };
  log?(line: string): void;
}

/** On unless OMB_FREE_FALLBACK=0. Under vitest or a sealed test fixture (env-path.ts) only with OMB_FREE_FALLBACK=1, as
 * tested-ai's OMB_AI_CHECKS: a test never downloads OpenCode unless it asks to. */
export function freeFallbackInstalls(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.OMB_FREE_FALLBACK?.trim();
  if (flag === "0") return false;
  return (env.VITEST !== "true" && env.OMB_TEST_SEALED_PATH !== "1") || flag === "1";
}

type Need = { instanceId: string; kind: "install" | "update" };
type Kept = { attempts: number; lastAttemptAt: number };

const empty = (selection: ModelSelection | undefined) => !selection?.instanceId && !selection?.model;
const hasModel = (instance: SelectableInstance) =>
  Boolean(instance.models.default.trim() || instance.models.options.some((option) => option.id.trim()));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function load(file: string | undefined): Kept {
  if (!file) return { attempts: 0, lastAttemptAt: -Infinity };
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Kept>;
    if (typeof raw.attempts === "number" && raw.attempts > 0 && Number.isInteger(raw.attempts) && typeof raw.lastAttemptAt === "number") {
      return { attempts: raw.attempts, lastAttemptAt: raw.lastAttemptAt };
    }
  } catch {}
  return { attempts: 0, lastAttemptAt: -Infinity };
}

export function createFreeFallback(deps: FreeFallbackDeps) {
  const enabled = deps.enabled ?? freeFallbackInstalls();
  const buildHere = deps.buildHere ?? standaloneAssetFor(OPENCODE_STANDALONE) !== null;
  const copies = deps.copies ?? findCliCandidates;
  const appCopy = deps.appCopy ?? ((cli: string) => isAppStandaloneCopy(cli, undefined, standaloneLookupPath()));
  const staleCopy = deps.staleCopy ?? (() => standaloneStaleCopy(OPENCODE_STANDALONE));
  const installed = deps.installed ?? ((cli: string) => findCliCandidates(cli).some((path) => existsSync(path)));
  const companyHint = deps.companyHint ?? companyDesktopHint();
  const now = deps.now ?? Date.now;
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const log = deps.log ?? ((line: string) => console.warn(line));
  const confirmMs = confirmWaitMs();
  const kept = load(deps.file);
  let started = deps.ready === undefined;
  let running: Promise<void> | null = null;
  /** When the current need was first seen, and which it was. */
  let seen: { kind: Need["kind"]; at: number } | null = null;
  let wake: { at: number; timer: { cancel(): void } } | null = null;

  const save = () => {
    if (!deps.file) return;
    try {
      mkdirSync(dirname(deps.file), { recursive: true });
      writeFileAtomic(deps.file, JSON.stringify(kept), { mode: 0o600 });
    } catch (error) {
      log(`[engines] could not keep the wait for OpenCode's free backup: ${message(error)}`);
    }
  };
  const readAgain = () => void Promise.resolve().then(deps.changed)
    .catch((error: unknown) => log(`[engines] reading the engines again for OpenCode's free backup: ${message(error)}`));

  if (deps.ready) {
    void deps.ready.then(() => {
      started = true;
      readAgain();
    }, () => {});
  }

  const cliOf = (instanceId: string) => deps.registry.cliTarget(instanceId)?.cli ?? COMMAND;

  /** Some AI of the person's own may still answer: ready, with a model, and not shown twice not to. */
  const ownMayAnswer = (instances: readonly SelectableInstance[]) => instances.some((instance) =>
    readyToRun(instance, deps.context) && hasModel(instance) && deps.context.company?.(instance.instanceId) !== true
    && !freeFallback(instance) && deps.context.answered?.(instance) !== false);

  /** Any AI program installed here other than OpenCode, signed in or not: one may only be slow to start. */
  const anyProgram = (instances: readonly SelectableInstance[]) => instances.some((instance) => {
    if (instance.driverKind === DRIVER) return false;
    const cli = deps.registry.cliTarget(instance.instanceId)?.cli;
    return Boolean(cli) && installed(cli!);
  });

  /** Where the app may put a backup in at all, and no AI of the person's can answer. */
  const backupWanted = (instances: readonly SelectableInstance[]) => {
    const place = deps.place();
    if (place.hostedWorkspace || place.cloudHome || place.sharedSignIn || place.branded || place.organisationManaged) return false;
    if (deps.saved().some((selection) => !empty(selection))) return false;
    return !ownMayAnswer(instances);
  };

  const needed = (instances: readonly SelectableInstance[]): Need | null => {
    // Only OpenCode's own build is ever installed here, never npm.
    if (!buildHere) return null;
    const openCodes = instances.filter((instance) => instance.driverKind === DRIVER);
    const target = openCodes.find((instance) => instance.enabled !== false);
    if (!target) return null;
    // A program the person chose is left alone. The app's own copy by its full path (Settings' install points OpenCode
    // there past a broken copy) is not the person's choice.
    if (openCodes.some((instance) => cliOf(instance.instanceId) !== COMMAND && !appCopy(cliOf(instance.instanceId)))) return null;
    const found = copies(COMMAND);
    // The person's own OpenCode runs: nothing of theirs is installed, updated or removed.
    if (found.length && !appCopy(COMMAND)) return null;
    // The app's copy left on an older pin (off PATH unless the code lists it): replaced while a bot uses it or nothing
    // else can answer, never on a managed computer.
    if (staleCopy()) {
      if (deps.place().organisationManaged) return null;
      return deps.botsOn?.(target.instanceId) === true || backupWanted(instances) ? { instanceId: target.instanceId, kind: "update" } : null;
    }
    if (found.length) return null;
    return backupWanted(instances) ? { instanceId: target.instanceId, kind: "install" } : null;
  };

  const sleepUntil = (at: number, probe: boolean) => {
    if (wake?.at === at) return;
    wake?.timer.cancel();
    wake = {
      at,
      timer: after(Math.max(0, at - now()), () => {
        wake = null;
        // The confirming read probes every engine afresh: a CLI that missed its first status read on a cold start answers now.
        if (probe) deps.registry.forgetSnapshots();
        readAgain();
      }),
    };
  };
  const rest = () => {
    wake?.timer.cancel();
    wake = null;
  };

  /** Server log lines only: the person sees nothing. */
  const run = async (need: Need) => {
    const update = need.kind === "update";
    log(update
      ? `[engines] Updating the app's copy of OpenCode to ${OPENCODE_STANDALONE.version} in the background.`
      : "[engines] No AI can answer yet: installing OpenCode in the background for its free models.");
    try {
      if (!(await deps.registry.installRuntime(need.instanceId))) throw new Error("this server has no way to install OpenCode");
      await deps.registry.refreshModels(need.instanceId);
      log(update ? `[engines] The app's copy of OpenCode is updated.` : "[engines] OpenCode is installed; its free models are tested next.");
    } catch (error) {
      const wait = BACKOFF_MS[Math.min(kept.attempts, BACKOFF_MS.length) - 1]!;
      log(`[engines] OpenCode could not be ${update ? "updated" : "installed"} (trying again in ${Math.round(wait / 60_000)} minutes): ${message(error)}`);
    }
  };

  const decide = (instances: readonly SelectableInstance[]): Promise<void> | undefined => {
    const need = needed(instances);
    if (!need) {
      seen = null;
      rest();
      if (kept.attempts) {
        kept.attempts = 0;
        kept.lastAttemptAt = -Infinity;
        save();
      }
      return undefined;
    }
    if (seen?.kind !== need.kind) seen = { kind: need.kind, at: now() };
    // With no AI program that could be slow to start and no sign of a company, the first reply shouldn't wait 90 seconds.
    const atOnce = need.kind === "install" && !companyHint && !anyProgram(instances);
    if (!atOnce && now() < seen.at + confirmMs) {
      sleepUntil(seen.at + confirmMs, true);
      return undefined;
    }
    if (kept.attempts > 0) {
      const due = kept.lastAttemptAt + BACKOFF_MS[Math.min(kept.attempts, BACKOFF_MS.length) - 1]!;
      if (now() < due) {
        sleepUntil(due, false);
        return undefined;
      }
    }
    rest();
    kept.attempts += 1;
    kept.lastAttemptAt = now();
    save();
    const current: Promise<void> = run(need).then(() => {
      running = null;
      return deps.changed();
    }).then(() => undefined, (error: unknown) => {
      log(`[engines] reading the engines again after OpenCode's free backup: ${message(error)}`);
    });
    running = current;
    return current;
  };

  return {
    /** The engines the latest read found (tested-ai's settle). Starts an install or update when one is due and returns
     * it; never throws into the read that called it. */
    settle(instances: readonly SelectableInstance[]): Promise<void> | undefined {
      if (!enabled || !started || running) return undefined;
      try {
        if (deps.provisional?.(instances) === true) return undefined;
        return decide(instances);
      } catch (error) {
        log(`[engines] OpenCode's free backup was not checked: ${message(error)}`);
        return undefined;
      }
    },
  };
}

export type FreeFallback = ReturnType<typeof createFreeFallback>;
