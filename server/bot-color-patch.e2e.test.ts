import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");

let child: ChildProcess | undefined;
let home = "";
let data = "";
let base = "";
let output = "";

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

async function start() {
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const staticDir = join(home, "static");
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home,
      OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_STATIC_DIR: staticDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (chunk) => (output += chunk));
  child.stderr!.on("data", (chunk) => (output += chunk));
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${output}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) return;
    } catch {
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const stop = async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  child = undefined;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-color-"));
  data = join(home, ".openmausbot");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, "static", "assets"), { recursive: true });
  writeFileSync(join(home, "static", "index.html"), "<!doctype html><title>Colour test</title>");
  writeFileSync(join(home, "static", "assets", "smoke.css"), "body{}");
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: { fixture: { driver: "claudeAgent", displayName: "Fixture", config: { cli: FAKE_CLAUDE }, environment: { FAKE_CLAUDE_MODE: "happy" } } },
  }));
  await start();
}, 30_000);

afterAll(async () => {
  await stop();
  if (home) await removeTempDir(home);
});

describe("PATCH /api/bots/:id colour", { timeout: 60_000 }, () => {
  it("accepts the ten palette colours only, and keeps silver for MausBot's unchanged value", async () => {
    const bot = (await api("POST", "/api/bots", { modelSelection: { instanceId: "fixture", model: "claude-sonnet-5" } })).body.bot;
    for (const color of ["silver", "mauve", "", 3, null]) {
      const refused = await api("PATCH", `/api/bots/${bot.id}`, { color });
      expect(refused.status, String(color)).toBe(400);
      expect(refused.body.error).toMatch(/color/);
    }
    expect((await api("PATCH", `/api/bots/${bot.id}`, { color: "coral" })).body.bot.color).toBe("coral");

    await stop();
    const file = join(data, "bots.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.push({ ...saved[0], id: "mausbot-fixture", threadId: "mausbot-thread", name: "MausBot", color: "silver", builtIn: "mausbot", peers: [], visibility: "admins" });
    writeFileSync(file, JSON.stringify(saved));
    await start();

    const builtIn = "mausbot-fixture";
    expect((await api("PATCH", `/api/bots/${builtIn}`, { color: "silver" })).status).toBe(200);
    const listed = (await api("GET", "/api/bots?messages=0")).body.bots.find((entry: { id: string }) => entry.id === builtIn);
    expect(listed).toMatchObject({ color: "silver", builtIn: "mausbot" });
    expect((await api("PATCH", `/api/bots/${bot.id}`, { color: "silver" })).status).toBe(400);
  });
});
