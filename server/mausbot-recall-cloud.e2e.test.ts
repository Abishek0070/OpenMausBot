// On a Cloud home MausBot's recall reaches every bot's conversations, but a conversation a guest left behind stays out.
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cloudPairingSignature } from "./cloud-home.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { markLeftBehind } from "./testing/cloud-left-behind.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const secret = randomBytes(32).toString("base64url");
let home = "", dataDir = "", base = "", log = "";
let owner = "";
let child: ChildProcess | undefined;
let boot: () => Promise<void> = async () => {};
const proxies: ChildProcess[] = [];
const dump = () => join(home, "held.json");

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}`,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function adminPairing(): Promise<string> {
  const body = JSON.stringify({ label: "OpenMausBot app (Cloud)", ttlSeconds: 300 });
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(16).toString("base64url");
  const response = await fetch(`${base}/api/cloud/pairing`, { method: "POST", headers: {
    host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", "content-type": "application/json",
    "x-omb-cloud-timestamp": timestamp, "x-omb-cloud-nonce": nonce, "x-omb-cloud-signature": `v1=${cloudPairingSignature(secret, timestamp, nonce, body)}`,
  }, body });
  const granted = await response.json() as { code: string };
  return (await api("POST", "/api/auth/pair", { body: { code: granted.code } })).body.token;
}

const stop = async (botId: string, threadId: string) =>
  expect((await api("POST", `/api/bots/${botId}/interrupt`, { token: owner, body: { threadId } })).status).toBe(200);
const say = async (botId: string, text: string, threadId: string) =>
  expect((await api("POST", `/api/bots/${botId}/messages`, { token: owner, body: { text, threadId } })).status).toBe(202);
const newThread = async (botId: string, title: string) => {
  const created = await api("POST", `/api/bots/${botId}/tasks`, { token: owner, body: { title } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.task.threadId as string;
};

async function toolsFor(start: () => Promise<void>) {
  rmSync(dump(), { force: true });
  await start();
  let held: any;
  await expect.poll(() => {
    try { held = JSON.parse(readFileSync(dump(), "utf8")); return true; } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  const agents = held.mcpConfig.mcpServers.agents;
  const proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: home, ...agents.env }, stdio: ["pipe", "pipe", "pipe"] });
  proxies.push(proxy);
  const replies = new Map<number, (value: any) => void>();
  createInterface({ input: proxy.stdout! }).on("line", (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result); replies.delete(msg.id); });
  let next = 0;
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve) => {
    const id = ++next; replies.set(id, resolve);
    proxy.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  await request("initialize", { protocolVersion: "2024-11-05" });
  return (name: string, args: unknown = {}) => request("tools/call", { name, arguments: args });
}

beforeAll(async () => {
  // Kept short: the engine's permission socket goes under this folder, and macOS refuses a socket path over 103 bytes.
  home = mkdtempSync(join(tmpdir(), "omb-mr-c-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  const fake = pathToFileURL(join(SERVER_DIR, "testing", "fake-claude-cli.ts")).href;
  const held = join(home, "held-claude.mjs");
  writeFileSync(held, `#!/usr/bin/env node
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true, email: "person@example.test" })); process.exit(0); }
process.env.FAKE_CLAUDE_VERSION = "2.1.284";
if (process.argv[2] !== "--version") { process.env.FAKE_CLAUDE_DUMP = ${JSON.stringify(dump())}; process.env.FAKE_CLAUDE_MODE = "hang"; }
await import(${JSON.stringify(fake)});
`, { mode: 0o755 });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi", "claude"].map((id) => [id, { driver: "not-a-real-driver" }])),
      held: { driver: "claudeAgent", displayName: "Held", config: { cli: held } },
    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  boot = async () => {
    log = "";
    child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
      cwd: join(SERVER_DIR, ".."),
      env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home,
        OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => { log += chunk; });
    child.stderr?.on("data", (chunk) => { log += chunk; });
    const deadline = Date.now() + 25_000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the Cloud home exited:\n${log}`);
      try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error(`the Cloud home did not start:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await boot();
  owner = await adminPairing();
}, 40_000);

afterAll(async () => {
  for (const proxy of proxies) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("MausBot finds the owner's conversations on a Cloud home, never one a guest left behind", async () => {
  const bots = (await api("GET", "/api/bots?messages=0", { token: owner })).body.bots as Array<{ id: string; builtIn?: string }>;
  const mausbot = bots.find((bot) => bot.builtIn === "mausbot")!;
  expect(mausbot).toBeDefined();
  const patched = await api("PATCH", `/api/bots/${mausbot.id}`, { token: owner, body: { modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } });
  expect(patched.status, JSON.stringify(patched.body)).toBe(200);
  const scout = (await api("POST", "/api/bots", { token: owner, body: { name: "Scout", modelSelection: { instanceId: "held", model: "claude-sonnet-5" } } })).body.bot as { id: string };
  const guests = await newThread(scout.id, "Guest notes");
  const mine = await newThread(scout.id, "Owner notes");
  // A turn in a conversation a guest left behind may not use the lent Mac, so only the owner-only guard keeps guest text out of its recall.
  const turnThread = await newThread(mausbot.id, "Guest chat");
  await say(scout.id, "The guestsecret passphrase is marmalade.", guests);
  await say(scout.id, "The ownermark passphrase is pumpernickel.", mine);
  for (const threadId of [guests, mine]) await stop(scout.id, threadId);
  for (const proxy of proxies.splice(0)) proxy.kill();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  markLeftBehind(dataDir, { threadIds: [guests, turnThread] });
  await boot();
  const tools = await toolsFor(() => say(mausbot.id, "Look around.", turnThread));
  const found = JSON.stringify(await tools("session_search", { query: "ownermark passphrase" }));
  expect(found).toContain("pumpernickel");
  expect(found).toContain("Scout");
  expect(JSON.stringify(await tools("session_search", { query: "guestsecret passphrase" }))).not.toContain("marmalade");
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages`, { token: owner })).body.messages as Array<{ id: string; role: string }>;
  const ownerLine = (await messages(mine)).find((message) => message.role === "user")!;
  expect(JSON.stringify(await tools("session_read", { thread_id: mine, message_id: ownerLine.id }))).toContain("pumpernickel");
  const guestLine = (await messages(guests)).find((message) => message.role === "user")!;
  expect(JSON.stringify(await tools("session_read", { thread_id: guests, message_id: guestLine.id }))).not.toContain("marmalade");
}, 90_000);
