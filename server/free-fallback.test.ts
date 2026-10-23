import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import type { SelectableInstance } from "./default-model-selection.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";
import { createFreeFallback, freeFallbackInstalls, type FreeFallbackDeps, type FreeFallbackPlace } from "./free-fallback.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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
const runningOpenCode = (version: string, snapshot: Partial<ProviderSnapshot> = {}): SelectableInstance => ({
  ...ready("opencodeGo", "opencodeGo", { version, freeFallback: true, ...snapshot }),
  models: { default: "opencode/glm-5.3-flash-free", options: [{ id: "opencode/glm-5.3-flash-free", label: "Zen · GLM-5.3-Flash Free" }] },
});
const older = (version: string) => {
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return patch > 0 ? `${major}.${minor}.${patch - 1}` : minor > 0 ? `${major}.${minor - 1}.99` : `${major - 1}.99.99`;
};
const newer = (version: string) => {
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + 1}`;
};

describe("OpenCode's free backup, installed without a word when nothing else can answer", () => {
  let instances: SelectableInstance[];
  let answered: Record<string, boolean | undefined>;
  let saved: ModelSelection | undefined;
  let profile: ModelSelection | undefined;
  let place: FreeFallbackPlace;
  let onPath: string[];
  let clis: Record<string, string>;
  let clock: number;
  let timers: Array<{ at: number; run: () => void; cancelled: boolean }>;
  let installOutcome: () => Promise<boolean>;
  let registry: { installRuntime: ReturnType<typeof vi.fn>; refreshModels: ReturnType<typeof vi.fn>; cliTarget: (id: string) => { driverKind: string; cli: string | null } | null };
  let changed: ReturnType<typeof vi.fn>;
  let logged: string[];

  /** What a real install does: the app's copy goes on PATH after everything else and OpenCode starts. */
  const installsTheAppCopy = async () => {
    onPath = [...onPath, APP_BIN];
    instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? runningOpenCode(OPENCODE_STANDALONE.version) : instance);
    return true;
  };
  const make = (extra: Partial<FreeFallbackDeps> = {}) => createFreeFallback({
    registry: registry as unknown as FreeFallbackDeps["registry"],
    context: { answered: (instance) => answered[instance.instanceId], company: (instanceId) => instanceId === "trial-credit" },
    saved: () => [saved, profile],
    place: () => place,
    changed: changed as unknown as FreeFallbackDeps["changed"],
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
    clock = 1_000_000;
    timers = [];
    installOutcome = installsTheAppCopy;
    registry = {
      installRuntime: vi.fn(() => installOutcome()),
      refreshModels: vi.fn(async () => true),
      cliTarget: (id) => ({ driverKind: id === "opencodeGo" ? "opencodeGo" : "other", cli: clis[id] ?? (id === "opencodeGo" ? "opencode" : null) }),
    };
    changed = vi.fn();
    logged = [];
  });

  it("installs OpenCode when no AI is ready and no copy of OpenCode exists, then reads its models and the engines again", async () => {
    const fallback = make();
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledExactlyOnceWith("opencodeGo");
    expect(registry.refreshModels).toHaveBeenCalledExactlyOnceWith("opencodeGo");
    expect(changed).toHaveBeenCalledOnce();
    // Only a line in the server log says so.
    expect(logged.join("\n")).toMatch(/OpenCode/);
  });

  it("installs once every ready AI of the person's own missed its test message twice", async () => {
    instances = [ready("claude", "claudeAgent"), ready("codex", "codex"), missingOpenCode()];
    answered = { claude: false, codex: false };
    await make().settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it.each([
    ["it answered", true],
    ["it is not tested yet, or missed only once", undefined],
  ])("installs nothing while an AI of the person's own is ready and %s", async (_label, result) => {
    instances = [ready("claude", "claudeAgent"), ready("codex", "codex"), missingOpenCode()];
    answered = { claude: false, codex: result };
    expect(await make().settle(instances)).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("does not count the trial credit's models, a signed-out AI or one with no model as able to answer", async () => {
    instances = [
      ready("trial-credit", "openai-compat"),
      ready("claude", "claudeAgent", { authenticated: false }),
      { ...ready("grok", "grokAgent"), models: { default: "", options: [] } },
      missingOpenCode(),
    ];
    await make().settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledOnce();
  });

  it.each<[string, () => void]>([
    ["a saved default model", () => { saved = { instanceId: "claude", model: "claude-sonnet-5" }; }],
    ["a saved New Bot model", () => { profile = { instanceId: "claude", model: "claude-sonnet-5" }; }],
    ["a hosted workspace", () => { place = { hostedWorkspace: true }; }],
    ["a Cloud home with trial credit", () => { place = { trialCredit: true }; }],
    ["a Team Cloud member", () => { place = { teamCloud: true }; }],
    ["a branded build", () => { place = { branded: true }; }],
    ["an organisation-managed computer", () => { place = { organisationManaged: true }; }],
    ["the person's own OpenCode on PATH", () => { onPath = [OWN_BIN]; }],
    ["the app's own copy already there", () => { onPath = [APP_BIN]; }],
    ["an OpenCode set to a program of the person's choosing", () => { clis = { opencodeGo: "/opt/tools/opencode-dev" }; }],
    ["OpenCode turned off", () => { instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? { ...instance, enabled: false } : instance); }],
    ["no OpenCode in the engine list", () => { instances = instances.filter((instance) => instance.driverKind !== "opencodeGo"); }],
  ])("installs nothing with %s", async (_label, arrange) => {
    arrange();
    expect(await make().settle(instances)).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("installs nothing on a computer OpenCode has no build of its own for (never npm in the background)", async () => {
    expect(await make({ buildHere: false }).settle(instances)).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  it("runs one install at a time however often the engines are read", async () => {
    let finish!: (ok: boolean) => void;
    installOutcome = () => new Promise<boolean>((resolve) => { finish = resolve; });
    const fallback = make();
    const first = fallback.settle(instances);
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
    await fallback.settle(instances);
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

  it("reads the engines again when a wait ends, so a retry needs no visitor", async () => {
    installOutcome = async () => false;
    const fallback = make();
    await fallback.settle(instances);
    expect(changed).toHaveBeenCalledTimes(1);
    // The read the install asked for finds it still missing: a wait starts, and its end reads the engines again.
    await fallback.settle(instances);
    advance(10 * MINUTE - 1);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    advance(1);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(2);
  });

  it("backs off too when an install says it worked but no copy turned up", async () => {
    installOutcome = async () => true;
    const fallback = make();
    await fallback.settle(instances);
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
    await fallback.settle(instances);
    clock += 10 * MINUTE;
    fail = false;
    await fallback.settle(instances);
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(2);
    // The app's copy disappears (the person cleared the data folder's tools): the next install runs at once.
    onPath = [];
    instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? missingOpenCode() : instance);
    await fallback.settle(instances);
    expect(registry.installRuntime).toHaveBeenCalledTimes(3);
  });

  it("does nothing at all when turned off", async () => {
    expect(await make({ enabled: false }).settle(instances)).toBeUndefined();
    instances = instances.map((instance) => instance.driverKind === "opencodeGo" ? runningOpenCode(older(OPENCODE_STANDALONE.version)) : instance);
    onPath = [APP_BIN];
    expect(await make({ enabled: false }).settle(instances)).toBeUndefined();
    expect(registry.installRuntime).not.toHaveBeenCalled();
  });

  describe("keeping the app's copy current", () => {
    it("installs the version this app pins when the app's copy is older, whatever else answers", async () => {
      onPath = [APP_BIN];
      instances = [ready("claude", "claudeAgent"), runningOpenCode(older(OPENCODE_STANDALONE.version))];
      answered = { claude: true };
      saved = { instanceId: "claude", model: "claude-model" };
      await make().settle(instances);
      expect(registry.installRuntime).toHaveBeenCalledExactlyOnceWith("opencodeGo");
    });

    it("also when OpenCode runs the app's copy by its full path", async () => {
      clis = { opencodeGo: APP_BIN };
      instances = [runningOpenCode(older(OPENCODE_STANDALONE.version))];
      await make().settle(instances);
      expect(registry.installRuntime).toHaveBeenCalledOnce();
    });

    it.each<[string, () => void]>([
      ["the app's copy is the pinned version", () => { onPath = [APP_BIN]; instances = [runningOpenCode(OPENCODE_STANDALONE.version)]; }],
      ["the app's copy is newer than the pin", () => { onPath = [APP_BIN]; instances = [runningOpenCode(newer(OPENCODE_STANDALONE.version))]; }],
      ["its version is unknown", () => { onPath = [APP_BIN]; instances = [runningOpenCode("")]; }],
      ["the person's own older OpenCode runs", () => { onPath = [OWN_BIN, APP_BIN]; instances = [runningOpenCode(older(OPENCODE_STANDALONE.version))]; }],
      ["OpenCode runs a program of the person's choosing", () => {
        clis = { opencodeGo: "/opt/tools/opencode-dev" };
        instances = [runningOpenCode(older(OPENCODE_STANDALONE.version))];
      }],
    ])("changes nothing when %s", async (_label, arrange) => {
      arrange();
      expect(await make().settle(instances)).toBeUndefined();
      expect(registry.installRuntime).not.toHaveBeenCalled();
    });

    it("backs off when the new version does not take", async () => {
      onPath = [APP_BIN];
      instances = [runningOpenCode(older(OPENCODE_STANDALONE.version))];
      installOutcome = async () => true;
      const fallback = make();
      await fallback.settle(instances);
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
});
