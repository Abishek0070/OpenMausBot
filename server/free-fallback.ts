// OpenCode's free backup, installed without a word. When no AI of the person's own can answer (none is ready, or every
// ready one missed its test message twice) and there is no OpenCode on this computer at all, the app installs its own
// copy of OpenCode's build (no Node.js) in the background so the first bot can still reply through a free model. Nothing
// here picks a default: the new copy is read, gets its test message and ranks last like any free backup
// (server/tested-ai.ts, shared/ai-ranking.ts), so it becomes the default only when nothing else answered.
//
// Never on a saved default, a hosted or company workspace, a Cloud home with trial credit, a Team Cloud, a branded build,
// or an OpenCode the person set up themselves. A copy the app installed is kept on its pinned version: one older than
// this app's pin is installed again (the installer swaps versions in place). Nothing is ever removed: once a real AI
// answers, the backup just ranks last.
import { freeFallback } from "../shared/ai-ranking.ts";
import type { ModelSelection } from "./contracts.ts";
import { readyToRun, type DefaultSelectionContext, type SelectableInstance } from "./default-model-selection.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";
import { parseVersionTriple, versionAtLeast } from "./drivers/acp/version-probe.ts";
import { isAppStandaloneCopy, standaloneAssetFor } from "./engine-standalone.ts";
import { findCliCandidates } from "./env-path.ts";
import type { ProviderRegistry } from "./harness/registry.ts";

const DRIVER = "opencodeGo";
const COMMAND = "opencode";
/** Between attempts that left OpenCode missing or old: 10 minutes, an hour, then once a day. */
const BACKOFF_MS = [10 * 60_000, 60 * 60_000, 24 * 60 * 60_000] as const;

/** Where the person's AI is not the app's to choose. */
export interface FreeFallbackPlace {
  hostedWorkspace?: boolean;
  /** A Cloud home whose trial credit still lasts. */
  trialCredit?: boolean;
  teamCloud?: boolean;
  branded?: boolean;
  organisationManaged?: boolean;
}

export interface FreeFallbackDeps {
  registry: Pick<ProviderRegistry, "installRuntime" | "refreshModels" | "cliTarget">;
  /** The new-bot default's context: refusals, company models and test results (server/tested-ai.ts). */
  context: DefaultSelectionContext;
  /** The defaults the person saved: the default model and the New Bot defaults' model. */
  saved(): ReadonlyArray<ModelSelection | undefined>;
  place(): FreeFallbackPlace;
  /** An install finished or a wait ended: the server reads the engines again, which settles here. */
  changed(): Promise<unknown> | void;
  /** freeFallbackInstalls() unless given. */
  enabled?: boolean;
  /** Whether OpenCode has a build of its own for this computer; never npm in the background. */
  buildHere?: boolean;
  /** Every copy of a command on the app's PATH, first one wins (findCliCandidates). */
  copies?(cli: string): string[];
  /** Whether a command runs the app's own copy (isAppStandaloneCopy). */
  appCopy?(cli: string): boolean;
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

const empty = (selection: ModelSelection | undefined) => !selection?.instanceId && !selection?.model;
const hasModel = (instance: SelectableInstance) =>
  Boolean(instance.models.default.trim() || instance.models.options.some((option) => option.id.trim()));
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createFreeFallback(deps: FreeFallbackDeps) {
  const enabled = deps.enabled ?? freeFallbackInstalls();
  const buildHere = deps.buildHere ?? standaloneAssetFor(OPENCODE_STANDALONE) !== null;
  const copies = deps.copies ?? findCliCandidates;
  const appCopy = deps.appCopy ?? ((cli: string) => isAppStandaloneCopy(cli));
  const now = deps.now ?? Date.now;
  const after = deps.after ?? ((ms: number, run: () => void) => {
    const timer = setTimeout(run, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const log = deps.log ?? ((line: string) => console.warn(line));
  const pinned = parseVersionTriple(OPENCODE_STANDALONE.version);
  let running: Promise<void> | null = null;
  let attempts = 0;
  let lastAttemptAt = -Infinity;
  let wake: { at: number; timer: { cancel(): void } } | null = null;

  const cliOf = (instanceId: string) => deps.registry.cliTarget(instanceId)?.cli ?? COMMAND;

  /** Some AI of the person's own may still answer: ready, with a model, and not shown twice not to. */
  const ownMayAnswer = (instances: readonly SelectableInstance[]) => instances.some((instance) =>
    readyToRun(instance, deps.context) && hasModel(instance) && deps.context.company?.(instance.instanceId) !== true
    && !freeFallback(instance) && deps.context.answered?.(instance) !== false);

  const needed = (instances: readonly SelectableInstance[]): Need | null => {
    const openCodes = instances.filter((instance) => instance.driverKind === DRIVER);
    // The app's copy in use and older than this app's pin: the pinned version replaces it.
    for (const instance of openCodes) {
      if (instance.enabled === false || !appCopy(cliOf(instance.instanceId))) continue;
      const version = parseVersionTriple(instance.snapshot.version ?? "");
      if (version && pinned && !versionAtLeast(version, pinned)) return { instanceId: instance.instanceId, kind: "update" };
    }
    const target = openCodes.find((instance) => instance.enabled !== false);
    if (!target || !buildHere) return null;
    // A program the person chose, or any copy already on the app's PATH (theirs or the app's), is left alone.
    if (openCodes.some((instance) => cliOf(instance.instanceId) !== COMMAND)) return null;
    if (copies(COMMAND).length) return null;
    const place = deps.place();
    if (place.hostedWorkspace || place.trialCredit || place.teamCloud || place.branded || place.organisationManaged) return null;
    if (deps.saved().some((selection) => !empty(selection))) return null;
    if (ownMayAnswer(instances)) return null;
    return { instanceId: target.instanceId, kind: "install" };
  };

  const sleepUntil = (at: number) => {
    if (wake?.at === at) return;
    wake?.timer.cancel();
    wake = {
      at,
      timer: after(Math.max(0, at - now()), () => {
        wake = null;
        void Promise.resolve().then(deps.changed).catch((error: unknown) => log(`[engines] reading the engines again for OpenCode's free backup: ${message(error)}`));
      }),
    };
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
      const wait = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
      log(`[engines] OpenCode could not be ${update ? "updated" : "installed"} (trying again in ${Math.round(wait / 60_000)} minutes): ${message(error)}`);
    }
  };

  return {
    /** The engines the latest read found (tested-ai's settle). Starts an install or update when one is due; returns it. */
    settle(instances: readonly SelectableInstance[]): Promise<void> | undefined {
      if (!enabled || running) return undefined;
      const need = needed(instances);
      if (!need) {
        attempts = 0;
        wake?.timer.cancel();
        wake = null;
        return undefined;
      }
      if (attempts > 0) {
        const due = lastAttemptAt + BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length) - 1]!;
        if (now() < due) {
          sleepUntil(due);
          return undefined;
        }
      }
      attempts += 1;
      lastAttemptAt = now();
      const current: Promise<void> = run(need).then(() => {
        running = null;
        return deps.changed();
      }).then(() => undefined, (error: unknown) => {
        log(`[engines] reading the engines again after OpenCode's free backup: ${message(error)}`);
      });
      running = current;
      return current;
    },
  };
}

export type FreeFallback = ReturnType<typeof createFreeFallback>;
