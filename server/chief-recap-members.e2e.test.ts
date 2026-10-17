import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

import { PRESENCE_FILE } from "./host/presence.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOUR = 60 * 60_000;
const BOSS = "boss@example.test";
const BOB = "bob@example.test";
const SECRET = "SECRET-PAYROLL-77";
let home = "", dataDir = "", base = "", log = "";
let child: ChildProcess | undefined;
const tokens: Record<string, string> = {};

async function api(method: string, path: string, as: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[as]}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

beforeAll(async () => {
  // Kept short: the engine's permission socket goes under this folder (the data folder or TMPDIR), and macOS refuses a socket path over 103 bytes.
  home = mkdtempSync(join(tmpdir(), "omb-recap-m-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    signIn: { admins: [BOSS], members: [BOB] },
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: {
        driver: "claudeAgent", displayName: "Verification fixture", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") },
        environment: { FAKE_CLAUDE_REPLIES: JSON.stringify([`${SECRET} salary list`, "Drafted the newsletter."]), FAKE_CLAUDE_REPLY_STATE: join(home, "replies") },
      },
    },
  }));
  // The person was last here nine hours ago, so the owner's first call after the bots work is a return.
  writeFileSync(join(dataDir, PRESENCE_FILE), JSON.stringify({ version: 1, lastActiveAt: Date.now() - 9 * HOUR }));
  const role = (email: string) => (email === BOSS ? ["admin", "client"] as const : ["client"] as const);
  const registry = new SessionRegistry({ file: join(dataDir, "sessions.json"), emailScopes: (email) => [...role(email)] });
  for (const email of [BOSS, BOB]) tokens[email] = registry.issue({ label: `${email.split("@")[0]}'s laptop`, email, scopes: [...role(email)] }).token;
  registry.close();
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
});

afterAll(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});

it("a member reading the Chief's chat never sees a bot limited to admins in the recap", async () => {
  const exited = () => child?.exitCode !== null || child?.signalCode !== null;
  await expect.poll(async () => {
    if (exited()) return true;
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 25_000 }).toBe(true).catch((error: unknown) => { throw new Error(`the server did not start:\n${log}`, { cause: error }); });
  if (exited()) throw new Error(`the server exited:\n${log}`);
  const create = async (name: string) => {
    const created = await api("POST", "/api/bots", BOSS, { name });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return created.body.bot as { id: string; threadId: string };
  };
  const chief = await create("Chief");
  const payroll = await create("Payroll Zebra");
  const scout = await create("Scout");
  expect((await api("PATCH", `/api/bots/${chief.id}`, BOSS, { chiefOfStaff: true })).status).toBe(200);
  expect((await api("PATCH", `/api/bots/${payroll.id}`, BOSS, { visibility: "admins" })).status).toBe(200);

  const work = async (bot: { id: string; threadId: string }, text: string) => {
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, BOSS, { text, threadId: bot.threadId });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(async () => ((await api("GET", `/api/threads/${bot.threadId}/messages`, BOSS)).body.messages ?? [])
      .some((line: any) => line.kind === "digest"), { timeout: 30_000 }).toBe(true);
  };
  await work(payroll, "Prepare the salary list.");
  await work(scout, "Draft the newsletter.");
  expect(JSON.stringify((await api("GET", `/api/threads/${payroll.threadId}/messages`, BOSS)).body)).toContain(SECRET);

  const returned = await api("POST", "/api/presence/active", BOSS, { source: "desktop" });
  expect(returned.body).toMatchObject({ ok: true, returned: true, open: { botId: chief.id, threadId: chief.threadId } });

  const asBob = await api("GET", `/api/threads/${chief.threadId}/messages`, BOB);
  expect(asBob.status).toBe(200);
  const cards = (asBob.body.messages as any[]).filter((line) => line.kind === "widget");
  expect(cards).toHaveLength(1);
  const seen = JSON.stringify(asBob.body);
  expect(seen).toContain("Since you last looked");
  expect(seen).toContain("Drafted the newsletter.");
  for (const hidden of ["Payroll Zebra", SECRET, payroll.id, payroll.threadId]) expect(seen).not.toContain(hidden);
}, 120_000);
