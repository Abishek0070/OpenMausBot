import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PRESENCE_FILE } from "./host/presence.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";
import { openSse } from "./testing/sse.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const HOST = "omb-t-0123456789ab.fly.dev";
const HOUR = 60 * 60_000;
const secret = randomBytes(32).toString("base64url");
let home = "", dataDir = "", base = "", port = 0, log = "";
let child: ChildProcess | undefined;
let cloud = false;

async function api(method: string, path: string, options: { body?: unknown; token?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cloud ? { host: HOST, "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https", origin: `https://${HOST}` } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) as any };
}

async function boot(asCloud: boolean) {
  log = "";
  cloud = asCloud;
  const offlinePrelude = `data:text/javascript,${encodeURIComponent('const real = globalThis.fetch; globalThis.fetch = async (url, init) => String(url).startsWith("http://127.0.0.1:") ? real(url, init) : new Response("offline fixture", { status: 503 });')}`;
  child = spawn(process.execPath, ["--import", offlinePrelude, join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home, OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1),
      ...(asCloud ? {
        OMB_CLOUD_ROLE: "home", OMB_CLOUD_MACHINE_ID: "3f9c2a4e-8b1d-4c6e-9a7f-2d5e8c1b0a93", OMB_CLOUD_ADMIN_URL: "https://cloud.example.test",
        OMB_CLOUD_BOOTSTRAP_SECRET: secret, OMB_PUBLIC_URL: `https://${HOST}`,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  await expect.poll(async () => {
    if (child?.exitCode !== null) return true;
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 25_000 }).toBe(true);
  if (child?.exitCode !== null) throw new Error(`the server exited:\n${log}`);
}
async function shutdown() { if (child) await waitForExit(child, { signal: "SIGTERM" }); child = undefined; }

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "omb-chief-recap-cloud-"));
  dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    instances: {
      ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
      claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } },
    },
  }));
  port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await shutdown();
  if (home) await removeTempDir(home);
});

it("only the owner's presence calls count as the person coming back, never an event stream, at home or on a Cloud home", async () => {
  await boot(false);
  const pair = async (scopes: string[]) => {
    const opened = await api("POST", "/api/auth/pairing", { body: { label: scopes.join("+"), scopes } });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    return (await api("POST", "/api/auth/pair", { body: { code: opened.body.code } })).body.token as string;
  };
  const owner = await pair(["admin", "client"]);
  const guest = await pair(["client"]);
  const chief = (await api("POST", "/api/bots", { token: owner, body: { name: "Chief" } })).body.bot;
  expect((await api("PATCH", `/api/bots/${chief.id}`, { token: owner, body: { chiefOfStaff: true } })).status).toBe(200);
  const presenceFile = join(dataDir, PRESENCE_FILE);
  const lastActiveAt = () => JSON.parse(readFileSync(presenceFile, "utf8")).lastActiveAt as number;
  const awayNineHours = () => writeFileSync(presenceFile, JSON.stringify({ version: 1, lastActiveAt: lastActiveAt() - 9 * HOUR }));

  expect((await api("POST", "/api/presence/active", { token: owner, body: { source: "desktop", timeZone: "Asia/Kolkata" } })).body).toEqual({ ok: true, returned: false });
  const ownersActivation = lastActiveAt();
  expect(ownersActivation).toBeGreaterThan(0);
  // A client-only session never reaches the route: it is admin-scoped like every unlisted route.
  expect((await api("POST", "/api/presence/active", { token: guest, body: { source: "phone" } })).status).toBe(403);
  expect(lastActiveAt()).toBe(ownersActivation);

  // Nine hours later a guest's event stream opens first: it is not the person coming back, so the owner's return is still theirs.
  await shutdown();
  awayNineHours();
  await boot(false);
  const guestStream = await openSse(`${base}/api/events`, { authorization: `Bearer ${guest}` });
  await guestStream.until((frame) => frame.kind === "hello");
  guestStream.close();
  expect((await api("POST", "/api/presence/active", { token: owner, body: { source: "desktop" } })).body).toEqual({ ok: true, returned: true });
  // Neither does a session-less local stream (a bot's shell, `openmausbot events`) nor the signed-in owner's own: an
  // always-on phone service or an open browser tab keeps one connected while nobody is there. Clients report
  // themselves through the route.
  const streams: Array<Record<string, string>> = [{}, { authorization: `Bearer ${owner}` }];
  for (const headers of streams) {
    await shutdown();
    awayNineHours();
    const away = lastActiveAt();
    await boot(false);
    const stream = await openSse(`${base}/api/events`, headers);
    await stream.until((frame) => frame.kind === "hello");
    stream.close();
    expect(lastActiveAt()).toBe(away);
    expect((await api("POST", "/api/presence/active", { token: owner, body: { source: "desktop" } })).body).toEqual({ ok: true, returned: true });
  }

  // On a Cloud home only the owner's own devices connect: the client-only session is signed out at boot, and a
  // session-less local caller (a bot's shell) is a service there, never the person.
  await shutdown();
  awayNineHours();
  const beforeCloud = lastActiveAt();
  await boot(true);
  expect((await api("POST", "/api/presence/active", { token: guest, body: { source: "phone" } })).status).toBe(401);
  const local = await fetch(`${base}/api/presence/active`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "desktop" }) });
  expect(local.status).toBe(403);
  expect(lastActiveAt()).toBe(beforeCloud);
  expect((await api("POST", "/api/presence/active", { token: owner, body: { source: "desktop" } })).body).toEqual({ ok: true, returned: true });
  expect((await api("GET", `/api/threads/${chief.threadId}/messages`, { token: guest })).status).toBe(401);
  expect((await api("GET", `/api/threads/${chief.threadId}/messages`, { token: owner })).status).toBe(200);
}, 120_000);
