import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import type { SelectableInstance } from "./default-model-selection.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";
import { enginesBinDir } from "./engine-install.ts";
import { standaloneEngineDir } from "./engine-standalone.ts";
import { registerFallbackPathDir, registerPathDir, resetPathCacheForTests } from "./env-path.ts";
import { confirmWaitMs, createFreeFallback, freeFallbackInstalls, type FreeFallbackDeps, type FreeFallbackPlace } from "./free-fallback.ts";
import { removeTempDir } from "./testing/cleanup.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Nothing can answer on two reads this far apart before anything is installed. */
const CONFIRM = 90_000;
const APP_BIN = "/data/tools/standalone/opencode/bin/opencode";
const OWN_BIN = "/Users/someone/.opencode/bin/opencode";

const ready = (instanceId: string, driverKind: string, snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
  instanceId, driverKind, snapshot: { state: "available", authenticated: true, ...snapshot },
  models: { default: `${instanceId}-model`, options: [{ id: `${instanceId}-model`, label: instanceId }] },
});
const missingOpenCode = (): SelectableInstance => ({
  instanceId: "opencodeGo", driverKind: "opencodeGo",
  snapshot: { state: "unavailable", reason: "`opencode` isn't installed, or isn't on this app's PATH." }, models: { default: "", options: [] },
});
const runningOpenCode = (snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
  ...ready("opencodeGo", "opencodeGo", { version: OPENCODE_STANDALONE.version, freeFallback: true, ...snapshot }),
  models: { default: "opencode/glm-5.3-flash-free", options: [{ id: "opencode/glm-5.3-flash-free", label: "Zen · GLM-5.3-Flash Free" }] },
});

describe("OpenCode's free backup, installed without a word when nothing else can answer", () => {
  let instances: SelectableInstance[];
  let answered: Record<string, boolean | undefined>;
  let saved: ModelSelection | undefined;
  let profile: ModelSelection | undefined;
  let place: FreeFallbackPlace;
  let onPath: string[];
  let clis: Record<string, string>;
  let stale: { version: string } | null;
  let backupBots: Set<string>;
  let clock: number;
  let timers: Array<{ at: number; run: () => void; cancelled: boolean }>;
  let installOutcome: () => Promise<boolean | { useCli: string }>;
  let registry: {
    installRuntime: ReturnType<typeof vi.fn>; refreshModels: ReturnType<typeof vi.fn>; forgetSnapshots: ReturnType<typeof vi.fn>;
    cliTarget: (id: string) => { driverKind: string; cli: string | null } | null;
  };
  let changed: ReturnType<typeof vi.fn>;
  let logged: string[];
  let data: string;

  /** What a real install does: the app's copy goes on PATH after everything else and OpenCode starts. */
  const installsTheAppCopy = async () => {
    onPath = [...onPath, APP_BIN];
    stale = null;
    instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? runningOpenCode() : instance);
    return true;
  };
  const make = (extra: Partial<FreeFallbackDeps> = {}) => createFreeFallback({
    registry: registry as unknown as FreeFallbackDeps["registry"],
    context: { answered: (instance) => answered[instance.instanceId], company: (instanceId) => instanceId === "company-claude" },
    saved: () => [saved, profile],
    place: () => place,
    changed: changed as unknown as FreeFallbackDeps["changed"],
    botsOn: (instanceId) => backupBots.has(instanceId),
    staleCopy: () => stale,
    enabled: true,
    buildHere: true,
    copies: (cli) => cli.includes("/") ? [cli] : onPath,
    appCopy: (cli) => (cli.includes("/") ? cli : onPath[0]) === APP_BIN,
    now: () => clock,
    after: (ms, run) => {
      const timer = { at: clock + ms, run, cancelled: false };
      timers.push(timer);
      return { cancel: () => { timer.cancelled = true; } };
    },
    log: (line) => logged.push(line),
    ...extra,
  });
  /** What the server does: a read now, and the read the wait asks for once it ends. */
  const twoReads = async (fallback: ReturnType<typeof make>) => {
    await fallback.settle(instances);
    clock += CONFIRM;
    return fallback.settle(instances);
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of timers.splice(0)) {
      if (timer.cancelled) continue;
      if (timer.at <= clock) timer.run();
      else timers.push(timer);
    }
  };

  beforeEach(() => {
    instances = [ready("claude", "claudeAgent", { state: "unavailable", authenticated: undefined }), missingOpenCode()];
    answered = {};
    saved = undefined;
    profile = undefined;
    place = {};
    onPath = [];
    clis = {};
    stale = null;
    backupBots = new Set();
    clock = 1_000_000;
    timers = [];
    installOutcome = installsTheAppCopy;
    registry = {
      installRuntime: vi.fn(() => installOutcome()),
      refreshModels: vi.fn(async () => true),
      forgetSnapshots: vi.fn(),
      cliTarget: (id) => ({ driverKind: id === "opencodeGo" ? "opencodeGo" : "other", cli: clis[id] ?? (id === "opencodeGo" ? "opencode" : null) }),
    };
    changed = vi.fn();
    logged = [];
    data = mkdtempSync(join(tmpdir(), "omb-free-fallback-"));
  });
  afterEach(async () => {
    await removeTempDir(data);
  });

  it("installs OpenCode once no AI could answer on two reads 90 seconds apart, then reads its models and the engines again", async () => {
    const fallback = make();
    expect(await fallback.settle(instances)).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
    // The wait ends: every engine is probed afresh (a CLI slow on a cold start gets a second chance) and read again.
    advance(CONFIRM - 1);
    expect(registry.forgetSnapshots).not.toHaveBeenCalled();
    advance(1);
    expect(registry.forgetSnapshots).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledExactlyOnceWith("opencodeGo");
    expect(registry.refreshModels).toHaveBeenCalledExactlyOnceWith("opencodeGo");
    expect(changed).toHaveBeenCalledTimes(2);
    // Only a line in the server log says so.
    expect(logged.join("\n")).toMatch(/OpenCode/);
  });

  it("installs nothing when an AI turns up on the second read, a slow one included", async () => {
    const fallback = make();
    await fallback.settle(instances);
    clock += CONFIRM;
    instances = [ready("claude", "claudeAgent"), missingOpenCode()];
    expect(await fallback.settle(instances)).toBeUndefined();
    // It went away again: the 90 seconds start over.
    instances = [ready("claude", "claudeAgent", { state: "unavailable", authenticated: undefined }), missingOpenCode()];
    await fallback.settle(instances);
    clock += CONFIRM - 1;
    await fallback.settle(instances);
    expect(registry.installRuntime).not.toHaveBeenCalled();
    clock += 1;
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it("decides nothing until the company runtime has started, then reads the engines", async () => {
    let start!: () => void;
    const fallback = make({ ready: new Promise<void>((resolve) => { start = resolve; }) });
    await twoReads(fallback);
    expect(registry.installRuntime).not.toHaveBeenCalled();
    expect(timers).toEqual([]);
    start();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    await twoReads(fallback);
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it("installs nothing when the company connection arrives during the wait", async () => {
    const fallback = make();
    await fallback.settle(instances);
    place = { organisationManaged: true };
    clock += CONFIRM;
    expect(await fallback.settle(instances)).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("installs once every ready AI of the person's own missed its test message twice", async () => {
    instances = [ready("claude", "claudeAgent"), ready("codex", "codex"), missingOpenCode()];
    answered = { claude: false, codex: false };
    await twoReads(make());
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    ["it answered", true],
    ["it is not tested yet, or missed only once", undefined],
  ])("installs nothing while an AI of the person's own is ready and %s", async (_label, result) => {
    instances = [ready("claude", "claudeAgent"), ready("codex", "codex"), missingOpenCode()];
    answered = { claude: false, codex: result };
    expect(await twoReads(make())).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("does not count company models, a signed-out AI or one with no model as able to answer", async () => {
    instances = [
      ready("company-claude", "claudeAgent"),
      ready("claude", "claudeAgent", { authenticated: false }),
      { ...ready("grok", "grokAgent"), models: { default: "", options: [] } },
      missingOpenCode(),
    ];
    await twoReads(make());
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it.each<[string, () => void]>([
    ["a saved default model", () => { saved = { instanceId: "claude", model: "claude-sonnet-5" }; }],
    ["a saved New Bot model", () => { profile = { instanceId: "claude", model: "claude-sonnet-5" }; }],
    ["a hosted workspace", () => { place = { hostedWorkspace: true }; }],
    ["any Cloud home (personal or team, with trial credit or not)", () => { place = { cloudHome: true }; }],
    ["a server people sign in to", () => { place = { sharedSignIn: true }; }],
    ["a branded build", () => { place = { branded: true }; }],
    ["an organisation-managed computer", () => { place = { organisationManaged: true }; }],
    ["the person's own OpenCode on PATH", () => { onPath = [OWN_BIN]; }],
    ["the app's own copy already there", () => { onPath = [APP_BIN]; }],
    ["an OpenCode set to a program of the person's choosing", () => { clis = { opencodeGo: "/opt/tools/opencode-dev" }; }],
    ["OpenCode turned off", () => { instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? { ...instance, enabled: false } : instance); }],
    ["no OpenCode in the engine list", () => { instances = instances.filter((instance) => instance.driverKind !== "opencodeGo"); }],
  ])("installs nothing with %s", async (_label, arrange) => {
    arrange();
    expect(await twoReads(make())).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("installs again when OpenCode was pointed at the app's own copy (Settings' install does that) and that copy is gone", async () => {
    clis = { opencodeGo: APP_BIN };
    await twoReads(make());
    expect(registry.installRuntime).toHaveBeenCalledExactlyOnceWith("opencodeGo");
  });

  it("installs nothing on a computer OpenCode has no build of its own for (never npm in the background)", async () => {
    expect(await twoReads(make({ buildHere: false }))).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("runs one install at a time however often the engines are read", async () => {
    let finish!: (ok: boolean) => void;
    installOutcome = () => new Promise<boolean>((resolve) => { finish = resolve; });
    const fallback = make();
    await fallback.settle(instances);
    clock += CONFIRM;
    const first = fallback.settle(instances);
    expect(first).toBeInstanceOf(Promise);
    expect(fallback.settle(instances)).toBeUndefined();
    // A slow download outlasts any wait: still the one install.
    clock += 2 * 24 * HOUR;
    expect(fallback.settle(instances)).toBeUndefined();
    finish(true);
    await first;
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it("waits 10 minutes, then an hour, then a day between failed installs, never a tight loop", async () => {
    installOutcome = async () => { throw new Error("OpenCode couldn't be downloaded. Check the internet connection and try again."); };
    const fallback = make();
    await twoReads(fallback);
    expect(registry.installRuntime).toHaveBeenCalledTimes(1);
    expect(registry.refreshModels).not.toHaveBeenCalled();
    expect(logged.join("\n")).toMatch(/couldn't be downloaded/);
    const attemptsAfter = async (ms: number) => {
      clock += ms - 1;
      await fallback.settle(instances);
      const before = registry.installRuntime.mock.calls.length;
      clock += 1;
      await fallback.settle(instances);
      return [before, registry.installRuntime.mock.calls.length];
    };
    expect(await attemptsAfter(10 * MINUTE)).toEqual([1, 2]);
    expect(await attemptsAfter(HOUR)).toEqual([2, 3]);
    expect(await attemptsAfter(24 * HOUR)).toEqual([3, 4]);
    expect(await attemptsAfter(24 * HOUR)).toEqual([4, 5]);
  });

  it("keeps its wait across a restart, so a relaunch does not try again at once", async () => {
    installOutcome = async () => { throw new Error("offline"); };
    const file = join(data, "providers", "free-fallback.json");
    await twoReads(make({ file }));
    expect(registry.installRuntime).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ attempts: 1, lastAttemptAt: clock });
    // The app restarts five minutes later.
    clock += 5 * MINUTE;
    const again = make({ file });
    await twoReads(again);
    expect(registry.installRuntime).toHaveBeenCalledTimes(1);
    clock += 5 * MINUTE;
    await again.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(2);
  });

  it("reads a damaged or missing record as no wait at all", async () => {
    const file = join(data, "providers", "free-fallback.json");
    mkdirSync(join(data, "providers"), { recursive: true });
    writeFileSync(file, "{not json");
    await twoReads(make({ file }));
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it("reads the engines again when a wait ends, so a retry needs no visitor", async () => {
    installOutcome = async () => false;
    const fallback = make();
    await twoReads(fallback);
    const reads = changed.mock.calls.length;
    // The read the install asked for finds it still missing: a wait starts, and its end reads the engines again.
    await fallback.settle(instances);
    advance(10 * MINUTE - 1);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(reads);
    advance(1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(reads + 1));
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(2);
  });

  it("backs off too when an install says it worked but no copy turned up", async () => {
    installOutcome = async () => true;
    const fallback = make();
    await twoReads(fallback);
    await fallback.settle(instances);
    clock += 5 * MINUTE;
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(1);
  });

  it("starts afresh once OpenCode is there: a later need is not held back by old failures", async () => {
    let fail = true;
    installOutcome = async () => {
      if (fail) throw new Error("offline");
      return installsTheAppCopy();
    };
    const fallback = make();
    await twoReads(fallback);
    clock += 10 * MINUTE;
    fail = false;
    await fallback.settle(instances);
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(2);
    // The app's copy disappears (the person cleared the data folder's tools): it is installed again, after the usual wait.
    onPath = [];
    instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? missingOpenCode() : instance);
    await twoReads(fallback);
    expect(registry.installRuntime).toHaveBeenCalledTimes(3);
  });

  it("never throws into the engine read that called it", async () => {
    const fallback = make({ place: () => { throw new Error("brand.json unreadable"); } });
    expect(() => fallback.settle(instances)).not.toThrow();
    expect(logged.join("\n")).toMatch(/brand\.json unreadable/);
  });

  it("does nothing at all when turned off", async () => {
    expect(await twoReads(make({ enabled: false }))).toBeUndefined();
    stale = { version: "1.0.0" };
    backupBots.add("opencodeGo");
    expect(await twoReads(make({ enabled: false }))).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  describe("keeping the app's copy current", () => {
    beforeEach(() => {
      // An earlier pin's copy: off PATH, since the code lists no hash for it.
      stale = { version: "1.0.0" };
      instances = [ready("claude", "claudeAgent"), missingOpenCode()];
      answered = { claude: true };
    });

    it("installs the pinned version while any bot is on the backup, even when another AI answers", async () => {
      backupBots.add("opencodeGo");
      saved = { instanceId: "claude", model: "claude-model" };
      await twoReads(make());
      expect(registry.installRuntime).toHaveBeenCalledExactlyOnceWith("opencodeGo");
      expect(logged.join("\n")).toMatch(/Updating the app's copy of OpenCode/);
    });

    it("installs the pinned version when nothing else can answer, with no bot on it yet", async () => {
      instances = [missingOpenCode()];
      await twoReads(make());
      expect(registry.installRuntime).toHaveBeenCalledOnce();
    });

    it.each<[string, () => void]>([
      ["no bot is on the backup and another AI answers", () => {}],
      ["the computer is organisation-managed", () => { backupBots.add("opencodeGo"); place = { organisationManaged: true }; }],
      ["the person's own OpenCode runs", () => { backupBots.add("opencodeGo"); onPath = [OWN_BIN]; }],
      ["OpenCode runs a program of the person's choosing", () => { backupBots.add("opencodeGo"); clis = { opencodeGo: "/opt/tools/opencode-dev" }; }],
      ["OpenCode is turned off", () => {
        backupBots.add("opencodeGo");
        instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? { ...instance, enabled: false } : instance);
      }],
      ["there is no build for this computer", () => { backupBots.add("opencodeGo"); }],
      ["the app's copy is on the pinned version", () => { backupBots.add("opencodeGo"); stale = null; onPath = [APP_BIN]; }],
    ])("changes nothing when %s", async (label, arrange) => {
      arrange();
      expect(await twoReads(make(label.includes("no build") ? { buildHere: false } : {}))).toBeUndefined();
      expect(registry.installRuntime).not.toHaveBeenCalled();
    });

    it.skipIf(process.platform === "win32")("finds the app's copy the way OpenCode runs it, ahead of an older npm copy in the app's folder", async () => {
      const original = process.env.PATH;
      const put = (folder: string) => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      };
      put(enginesBinDir());
      put(join(standaloneEngineDir("opencode"), "bin"));
      resetPathCacheForTests();
      registerPathDir(enginesBinDir());
      registerFallbackPathDir(join(standaloneEngineDir("opencode"), "bin"));
      try {
        backupBots.add("opencodeGo");
        await twoReads(make({ copies: undefined, appCopy: undefined }));
        expect(registry.installRuntime).toHaveBeenCalledExactlyOnceWith("opencodeGo");
      } finally {
        process.env.PATH = original;
        resetPathCacheForTests();
        await removeTempDir(enginesBinDir());
        await removeTempDir(standaloneEngineDir("opencode"));
      }
    });

    it("backs off when the new version does not take", async () => {
      backupBots.add("opencodeGo");
      installOutcome = async () => true;
      const fallback = make();
      await twoReads(fallback);
      await fallback.settle(instances);
      clock += 9 * MINUTE;
      await fallback.settle(instances);
      expect(registry.installRuntime).toHaveBeenCalledTimes(1);
      clock += MINUTE;
      await fallback.settle(instances);
      expect(registry.installRuntime).toHaveBeenCalledTimes(2);
    });
  });
});

describe("whether the free backup may install on its own", () => {
  it("is on unless OMB_FREE_FALLBACK=0", () => {
    expect(freeFallbackInstalls({})).toBe(true);
    expect(freeFallbackInstalls({ OMB_FREE_FALLBACK: "0" })).toBe(false);
    expect(freeFallbackInstalls({ OMB_FREE_FALLBACK: " 0 " })).toBe(false);
  });

  it("is off under tests and sealed fixtures unless OMB_FREE_FALLBACK=1", () => {
    expect(freeFallbackInstalls({ VITEST: "true" })).toBe(false);
    expect(freeFallbackInstalls({ OMB_TEST_SEALED_PATH: "1" })).toBe(false);
    expect(freeFallbackInstalls({ VITEST: "true", OMB_FREE_FALLBACK: "1" })).toBe(true);
    expect(freeFallbackInstalls({ OMB_TEST_SEALED_PATH: "1", OMB_FREE_FALLBACK: "1" })).toBe(true);
    expect(freeFallbackInstalls({ OMB_TEST_SEALED_PATH: "1", OMB_FREE_FALLBACK: "0" })).toBe(false);
  });

  it("is off in this test run by default", () => {
    expect(freeFallbackInstalls()).toBe(false);
  });

  it("waits 90 seconds between the two reads; only a sealed test fixture may shorten that, never below a second", () => {
    expect(confirmWaitMs({})).toBe(90_000);
    expect(confirmWaitMs({ OMB_FREE_FALLBACK_CONFIRM_MS: "2000" })).toBe(90_000);
    expect(confirmWaitMs({ OMB_TEST_SEALED_PATH: "1", OMB_FREE_FALLBACK_CONFIRM_MS: "2000" })).toBe(2_000);
    expect(confirmWaitMs({ OMB_TEST_SEALED_PATH: "1", OMB_FREE_FALLBACK_CONFIRM_MS: "5" })).toBe(1_000);
    expect(confirmWaitMs({ OMB_TEST_SEALED_PATH: "1", OMB_FREE_FALLBACK_CONFIRM_MS: "soon" })).toBe(90_000);
  });
});
