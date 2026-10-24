// Real server, real installer, a fake OpenCode build served without the network (testing/fake-opencode-download.ts):
// when nothing else can answer, OpenCode is installed in the background, gets its test message on the free model that
// keeps nothing, and only then becomes the new-bot default, through tested-ai like any AI; the first bot follows. A
// restart finds the app's copy and downloads nothing. A Claude that is only untested, or a saved default, installs nothing.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { verificationServerEnvironment } from "../scripts/control-omb.ts";
import { OPENCODE_STANDALONE } from "./drivers/acp/opencode-release.ts";
import { standalonePlatformKey } from "./engine-standalone.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { buildZip } from "./testing/zip-fixture.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_CLAUDE = join(ROOT, "server/testing/fake-claude-cli.ts");
const FAKE_ACP = join(ROOT, "server/testing/fake-acp-cli.ts");
const PRELOAD = pathToFileURL(join(ROOT, "server/testing/fake-opencode-download.ts")).href;
const NO_RETENTION = "opencode/glm-5.3-flash-free";
// OpenCode's own pick comes first, as a fresh OpenCode reports it.
const ZEN_FREE = ["opencode/mimo-v2.6-flash-free", "opencode/big-pickle", NO_RETENTION, "opencode/deepseek-v4.1-flash-free"];

const homes: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) await waitForExit(child, { signal: "SIGTERM" });
  for (const home of homes.splice(0)) await removeTempDir(home);
});

/** A data folder whose Claude misses every test message, with a fake OpenCode build ready to be "downloaded". */
function freshHome(extra: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "omb-free-fallback-"));
  homes.push(home);
  mkdirSync(join(home, "tmp"), { recursive: true });
  // The build's program answers the installer's --version probe with the pinned version and is otherwise a fake OpenCode.
  const program = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${OPENCODE_STANDALONE.version}"; exit 0; fi\nexec '${process.execPath}' '${FAKE_ACP}' "$@"\n`;
  const archive = buildZip([{ name: "opencode", data: program, mode: 0o100755 }]);
  writeFileSync(join(home, "opencode.zip"), archive);
  const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
  writeFileSync(join(home, "fake-build.json"), JSON.stringify({
    key: standalonePlatformKey(), archive: join(home, "opencode.zip"), sha256: sha256(archive), executableSha256: sha256(program),
    bytes: archive.length, log: join(home, "downloads.log"),
  }));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    instances: {
      claude: { driver: "claudeAgent", displayName: "Claude", config: { cli: FAKE_CLAUDE },
        environment: { FAKE_CLAUDE_CHECK: "fail", FAKE_CLAUDE_CHECK_LOG: join(home, "claude-checks.jsonl") } },
      opencodeGo: { driver: "opencodeGo", displayName: "OpenCode",
        environment: { FAKE_ACP_MODELS: ZEN_FREE.join(","), FAKE_ACP_DUMP: join(home, "opencode-dump"), FAKE_ACP_TEXT_REPLY: "OK" } },
    },
    ...extra,
  }));
  return home;
}

async function boot(home: string) {
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--import", PRELOAD, join(ROOT, "server/index.ts")], {
    cwd: ROOT,
    // Background test messages and the free backup are both off in test fixtures unless asked for.
    env: { ...verificationServerEnvironment(process.env, home, port), OMB_AI_CHECKS: "1", OMB_FREE_FALLBACK: "1",
      // The two reads that must both find no AI able to answer: 2 seconds apart here instead of 90.
      OMB_FREE_FALLBACK_CONFIRM_MS: "2000", FAKE_OPENCODE_BUILD: join(home, "fake-build.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  child.stdout!.on("data", (chunk) => { output += chunk; });
  child.stderr!.on("data", (chunk) => { output += chunk; });
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`server exited during boot:\n${output}`);
    try { return (await fetch(base + "/api/health")).ok; } catch { return false; }
  }, { timeout: 20_000, interval: 50 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, headers: { origin: base, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return response.json() as Promise<any>;
  };
  const downloads = () => existsSync(join(home, "downloads.log")) ? readFileSync(join(home, "downloads.log"), "utf8").split("\n").filter(Boolean).length : 0;
  type Engine = { instanceId: string; aiTest?: string; snapshot: { freeFallback?: boolean; version?: string }; models: { default: string } };
  const engines = async (): Promise<Record<string, Engine>> => Object.fromEntries(((await api("GET", "/api/instances")).instances as Engine[])
    .map((instance) => [instance.instanceId, instance]));
  const tests = async () => Object.fromEntries(Object.entries(await engines()).map(([id, instance]) => [id, instance.aiTest ?? null]));
  const starter = async () => ((await api("GET", "/api/bots?messages=0")).bots as Array<{ chiefOfStaff?: boolean; modelSelection: { instanceId: string; model: string } }>)
    .find((bot) => bot.chiefOfStaff)!;
  const prompts = () => existsSync(join(home, "opencode-dump.prompts.jsonl"))
    ? readFileSync(join(home, "opencode-dump.prompts.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).model as string) : [];
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  return { api, downloads, engines, tests, starter, prompts, stop, output: () => output };
}

it.skipIf(process.platform === "win32")("installs OpenCode once Claude missed twice, tests its no-retention free model, and only then makes it the default", async () => {
  const home = freshHome();
  const server = await boot(home);
  // One miss is not "didn't answer": nothing is installed yet.
  await expect.poll(server.tests, { timeout: 30_000, interval: 250 }).toMatchObject({ claude: "failed", opencodeGo: null });
  expect(server.downloads()).toBe(0);
  expect((await server.starter()).modelSelection.instanceId).toBe("claude");
  // The second miss: Claude didn't answer, so OpenCode is installed in the background and tested.
  expect(await server.api("POST", "/api/instances/claude/check", {})).toMatchObject({ ok: false });
  await expect.poll(server.tests, { timeout: 60_000, interval: 250 }).toMatchObject({ claude: "failed", opencodeGo: "passed" });
  expect(server.downloads()).toBe(1);
  const opencode = (await server.engines()).opencodeGo!;
  expect(opencode.snapshot).toMatchObject({ freeFallback: true, version: OPENCODE_STANDALONE.version });
  expect(opencode.models.default).toBe(NO_RETENTION);
  // Its test message went to the model that keeps nothing, and only to it.
  expect(server.prompts().length).toBeGreaterThan(0);
  expect(new Set(server.prompts())).toEqual(new Set([NO_RETENTION]));
  expect(existsSync(join(home, "tools", "standalone", "opencode", "bin", "opencode"))).toBe(true);
  // The default moved because OpenCode answered and Claude didn't; the untouched first bot follows.
  await expect.poll(async () => (await server.starter()).modelSelection, { timeout: 10_000 }).toMatchObject({ instanceId: "opencodeGo", model: NO_RETENTION });
  expect((await server.api("POST", "/api/bots", { name: "Made after the test" })).bot.modelSelection).toMatchObject({ instanceId: "opencodeGo", model: NO_RETENTION });
  // A restart finds the app's copy: nothing is downloaded again.
  await server.stop();
  const again = await boot(home);
  await expect.poll(again.tests, { timeout: 30_000, interval: 250 }).toMatchObject({ opencodeGo: "passed" });
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  expect(again.downloads()).toBe(1);
  expect((await again.starter()).modelSelection.instanceId).toBe("opencodeGo");
}, 150_000);

it.skipIf(process.platform === "win32")("installs at start when no AI is ready at all", async () => {
  const home = freshHome();
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  config.instances.claude.config.cli = join(home, "no-claude-here");
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const server = await boot(home);
  await expect.poll(server.tests, { timeout: 60_000, interval: 250 }).toMatchObject({ claude: null, opencodeGo: "passed" });
  expect(server.downloads()).toBe(1);
  await expect.poll(async () => (await server.starter()).modelSelection, { timeout: 10_000 }).toMatchObject({ instanceId: "opencodeGo", model: NO_RETENTION });
}, 90_000);

it.skipIf(process.platform === "win32")("installs nothing with a saved default", async () => {
  const server = await boot(freshHome({ defaultModelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }));
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  expect(server.downloads()).toBe(0);
  expect((await server.tests()).opencodeGo).toBeNull();
}, 60_000);
