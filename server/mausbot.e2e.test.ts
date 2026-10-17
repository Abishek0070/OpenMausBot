import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

import { BRIEF_STATE_FILE } from "./host/chief-brief.ts";
import { PRESENCE_FILE } from "./host/presence.ts";
import { SessionRegistry } from "./sessions.ts";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BOSS = "boss@example.test";
const BOB = "bob@example.test";
const CAPABILITY_KEY = "mausbot-e2e-capability-key-0123456789";
const HOUR = 60 * 60_000;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** A loopback connected-apps service that knows this install and no connected account. */
async function emptyBroker(): Promise<string> {
  return `${await listen((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/broker/v1/connectors/connected") return res.end(JSON.stringify({ services: {} }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "fixture" }));
  })}/broker`;
}

/** A loopback tool-router project that records every call that reaches it. */
async function toolRouter(): Promise<{ origin: string; relayed: unknown[] }> {
  const relayed: unknown[] = [];
  let origin = "";
  origin = await listen(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/connected") return res.end(JSON.stringify({ services: { gmail: { connected: true } } }));
    if (req.url === "/api/tool_router/session/fixture-session") {
      return res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: `${origin}/mcp` },
        config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
    }
    if (req.url === "/mcp") {
      relayed.push(body);
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "relay-ok" }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  return { origin, relayed };
}

interface StartOptions {
  home?: string;
  broker?: string;
  signIn?: boolean;
  tokens?: Record<string, string>;
  hosted?: boolean;
  router?: string;
}

async function start(options: StartOptions = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "omb-mb-"));
  const dataDir = join(home, ".openmausbot");
  const tokens = options.tokens ?? {};
  if (!options.home) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({
      ...(options.signIn ? { signIn: { admins: [BOSS], members: [BOB] } } : {}),
      ...(options.router ? { composio: { apiKey: "ak_fixture", userId: "fixture-user", sessionId: "fixture-session" } } : {}),
      instances: {
        ...Object.fromEntries(["codex", "cursor", "openaiCompat", "qwen", "hermes", "pi"].map((id) => [id, { driver: "not-a-real-driver" }])),
        claude: { driver: "claudeAgent", displayName: "Verification fixture", config: { cli: join(SERVER_DIR, "testing", "fake-claude-cli.ts") } },
      },
    }));
    cleanups.push(() => removeTempDir(home));
    if (options.signIn) {
      const role = (email: string): Array<"admin" | "client"> => (email === BOSS ? ["admin", "client"] : ["client"]);
      const registry = new SessionRegistry({ file: join(dataDir, "sessions.json"), emailScopes: role });
      for (const email of [BOSS, BOB]) tokens[email] = registry.issue({ label: email, email, scopes: role(email) }).token;
      registry.close();
    }
  }
  const port = await freePortBlock([0, 1]);
  const base = `http://127.0.0.1:${port}`;
  let log = "";
  const child: ChildProcess = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: join(SERVER_DIR, ".."),
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home, TEMP: home, TMP: home, TMPDIR: home,
      OMB_DATA_DIR: dataDir, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1), OMB_TEST_SEALED_PATH: "1",
      OMB_TEST_INTERNAL_CAPABILITY_KEY: CAPABILITY_KEY,
      ...(options.broker ? { OMB_COMPOSIO_BROKER_URL: options.broker, OMB_COMPOSIO_BROKER_TOKEN: "c".repeat(64) } : {}),
      ...(options.router ? { OMB_COMPOSIO_API: `${options.router}/api`, OMB_COMPOSIO_TOOLKITS_API: `${options.router}/api` } : {}),
      ...(options.hosted ? { OMB_ADMIN_URL: "https://admin.example.test", OMB_PUBLIC_URL: "https://team.example.test", OMB_ADMIN_WORKSPACE: "acme", OMB_LOOPBACK_TRUST: "owner" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { log += chunk; });
  child.stderr?.on("data", (chunk) => { log += chunk; });
  const stop = () => waitForExit(child, { signal: "SIGTERM" });
  cleanups.push(stop);
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  await expect.poll(async () => {
    if (exited()) return true;
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  if (exited()) throw new Error(`the server exited:\n${log}`);
  const api = async (method: string, path: string, body?: unknown, as?: string, extra: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { origin: base, ...(as ? { authorization: `Bearer ${as in tokens ? tokens[as] : as}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const lines = async (threadId: string, as?: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`, undefined, as)).body.messages as any[];
  const bots = async (as?: string) => (await api("GET", "/api/bots?messages=0", undefined, as)).body.bots as any[];
  const brief = () => JSON.parse(readFileSync(join(dataDir, BRIEF_STATE_FILE), "utf8")) as Record<string, unknown>;
  const capability = async (botId: string, threadId: string) => {
    const response = await fetch(`${base}/api/testing/internal-capability`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-openmausbot-test-capability": CAPABILITY_KEY },
      body: JSON.stringify({ botId, threadId, kind: "connectors" }),
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  };
  return { home, dataDir, tokens, api, lines, bots, brief, capability, stop };
}

const patchMausBot = async (s: Awaited<ReturnType<typeof start>>, id: string, body: unknown) => (await s.api("PATCH", `/api/bots/${id}`, body)).status;

it("seeds a Chief of Staff and a silent MausBot, which introduces itself on the owner's first presence", async () => {
  const s = await start({ broker: await emptyBroker() });
  const bots = await s.bots();
  expect(bots.map((bot) => [bot.name, bot.builtIn, Boolean(bot.chiefOfStaff)])).toEqual([["Chief of Staff", undefined, true], ["MausBot", "mausbot", false]]);
  const mausbot = bots[1];
  expect(mausbot).toMatchObject({ color: "silver", mascotBody: "cursor", visibility: "admins", peers: [], approvalMode: "auto", outbound: { policy: "ask" } });
  expect(await s.lines(mausbot.threadId)).toEqual([]);
  expect((await s.api("POST", "/api/presence/active", { source: "desktop", timeZone: "Asia/Kolkata" })).body).toEqual({ ok: true, returned: false });
  await expect.poll(async () => (await s.lines(mausbot.threadId)).map((line) => line.kind), { timeout: 15_000 }).toEqual(["text", "text", "connector", "connector"]);
  const posted = await s.lines(mausbot.threadId);
  expect(posted[0].text).toContain("Before each meeting");
  expect(posted[1].text).toBe("Connect Gmail & Calendar so I can do this.");
  expect(posted.slice(2).map((line) => line.connector.slug)).toEqual(["gmail", "googlecalendar"]);
  expect(posted.some((line) => line.card?.title === "Set up a Chief of Staff?")).toBe(false);
  await expect.poll(() => s.brief(), { timeout: 15_000 }).toMatchObject({ mausbotIntro: expect.anything(), connectOffer: { shown: true } });
  await s.api("POST", "/api/presence/active", { source: "desktop" });
  await s.api("POST", "/api/presence/active", { source: "phone" });
  expect(await s.lines(mausbot.threadId)).toHaveLength(4);
}, 90_000);

it("keeps MausBot's name, look, place, access and life, keeps silver for it, and leaves it out of exports", async () => {
  const s = await start();
  const [chief, mausbot] = await s.bots();
  const other = (await s.api("POST", "/api/bots", { name: "Scout" })).body.bot;
  for (const body of [
    { name: "Maus" }, { hidden: true }, { hidden: 1 }, { section: "Sales" }, { color: "green" }, { chiefOfStaff: true }, { visibility: "everyone" },
    { approvalMode: "full" }, { approvalMode: "custom" }, { outbound: { policy: "allow", dailyCap: 5 } }, { peers: [other.id] },
  ]) {
    expect(await patchMausBot(s, mausbot.id, body), JSON.stringify(body)).toBe(409);
  }
  expect(await patchMausBot(s, mausbot.id, { peers: [] })).toBe(200);
  for (const hidden of [null, "yes", 0]) {
    expect(await patchMausBot(s, other.id, { hidden }), `other ${JSON.stringify(hidden)}`).toBe(400);
    expect(await patchMausBot(s, chief.id, { hidden }), `chief ${JSON.stringify(hidden)}`).toBe(400);
  }
  expect((await s.api("PATCH", `/api/bots/${mausbot.id}/profile`, { name: "Maus" })).status).toBe(409);
  expect((await s.api("POST", `/api/bots/${mausbot.id}/avatar/generate`, { prompt: "a cat" })).status).toBe(409);
  expect((await s.api("DELETE", `/api/bots/${mausbot.id}`)).status).toBe(409);
  expect((await s.api("PATCH", `/api/bots/${mausbot.id}/profile`, { notifications: false, soul: "Keep it short." })).status).toBe(200);
  expect((await s.api("PATCH", `/api/bots/${chief.id}`, { color: "silver" })).status).toBe(409);
  expect((await s.api("PATCH", `/api/bots/${chief.id}`, { color: "mauve" })).status).toBe(400);
  expect((await s.api("PATCH", `/api/bots/${chief.id}`, { color: "teal" })).status).toBe(200);

  // A thread of MausBot's runs at its capped level, whatever is asked.
  expect((await s.api("POST", `/api/bots/${mausbot.id}/tasks`, { approvalMode: "full" })).status).toBe(409);
  const task = (await s.api("POST", `/api/bots/${mausbot.id}/tasks`, { title: "Side thread" })).body.task;
  expect((await s.api("PATCH", `/api/bots/${mausbot.id}/tasks/${task.threadId}`, { approvalMode: "full" })).status).toBe(409);
  expect((await s.api("PATCH", `/api/bots/${mausbot.id}/tasks/${task.threadId}`, { approvalMode: "custom" })).status).toBe(409);

  // A team and a room refuse it, and a room that already holds it can still let it go.
  expect((await s.api("POST", "/api/sidebar-sections", { name: "Sales", botIds: [mausbot.id] })).status).toBe(409);
  expect((await s.api("POST", "/api/sidebar-sections", { name: "Sales", botIds: [other.id] })).status).toBe(200);
  expect((await s.api("PUT", "/api/sidebar-sections?section=Sales", { addBotIds: [mausbot.id], removeBotIds: [] })).status).toBe(409);
  expect((await s.api("POST", "/api/groups", { name: "Room", memberIds: [chief.id, mausbot.id] })).status).toBe(409);
  const room = (await s.api("POST", "/api/groups", { name: "Room", memberIds: [chief.id, other.id] })).body.group;
  expect((await s.api("PATCH", `/api/groups/${room.id}`, { memberIds: [chief.id, other.id, mausbot.id] })).status).toBe(409);
  const call = { name: "Standup", description: "", botIds: [chief.id, other.id], schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 30 };
  expect((await s.api("POST", "/api/calendar-calls", { ...call, botIds: [chief.id, mausbot.id] })).status).toBe(400);
  const created = await s.api("POST", "/api/calendar-calls", call);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await s.api("PATCH", `/api/calendar-calls/${created.body.call.id}`, { botIds: [chief.id, mausbot.id] })).status).toBe(400);

  const after = (await s.bots()).find((bot) => bot.id === mausbot.id);
  expect(after).toMatchObject({ name: "MausBot", color: "silver", notifications: false, builtIn: "mausbot", soul: "Keep it short.", approvalMode: "auto", outbound: { policy: "ask" } });
  expect(after.hidden).toBeFalsy();
  expect(after.section).toBeUndefined();
  const backup = await s.api("POST", "/api/teams/export", { format: "backup", name: "Mine" });
  expect(backup.status, JSON.stringify(backup.body)).toBe(200);
  expect(backup.body.bots.map((bot: any) => bot.key).sort()).toEqual([chief.id, other.id].sort());
  const shared = await s.api("POST", "/api/teams/export", { format: "package", name: "Mine" });
  expect(shared.status, JSON.stringify(shared.body)).toBe(200);
  expect(shared.body.members).toBe(2);
}, 90_000);

it("lets a room that already holds MausBot release it", async () => {
  const first = await start();
  const [chief, mausbot] = await first.bots();
  const other = (await first.api("POST", "/api/bots", { name: "Scout" })).body.bot;
  const room = (await first.api("POST", "/api/groups", { name: "Room", memberIds: [chief.id, other.id] })).body.group;
  await first.stop();
  const file = join(first.dataDir, "groups.json");
  const saved = JSON.parse(readFileSync(file, "utf8")) as any;
  const groups: any[] = Array.isArray(saved) ? saved : saved.groups;
  groups.find((group) => group.id === room.id).memberIds.push(mausbot.id);
  writeFileSync(file, JSON.stringify(saved));
  const s = await start({ home: first.home });
  const held = (await s.api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === room.id);
  expect(held.memberIds).toContain(mausbot.id);
  expect((await s.api("PATCH", `/api/groups/${room.id}`, { memberIds: [chief.id, other.id] })).status).toBe(200);
  const released = (await s.api("GET", "/api/bots?messages=0")).body.groups.find((group: any) => group.id === room.id);
  expect(released.memberIds).toEqual([chief.id, other.id]);
}, 90_000);

it("waits for Approve before MausBot sends, reads freely, and refuses a batch of messages", async () => {
  const router = await toolRouter();
  const s = await start({ router: router.origin });
  const [chief, mausbot] = await s.bots();
  const relay = async (token: string, message: unknown) => (await s.api("POST", "/api/internal/connectors/mcp", message, token));
  const call = (name: string, args: unknown = {}) => ({ jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } });
  const mausbotToken = await s.capability(mausbot.id, mausbot.threadId);
  const chiefToken = await s.capability(chief.id, chief.threadId);
  for (const token of [mausbotToken, chiefToken]) {
    expect(await relay(token, [call("GMAIL_SEND_EMAIL"), call("GMAIL_FETCH_EMAILS")])).toEqual({ status: 400, body: { error: "send one JSON-RPC message per request" } });
  }
  expect(router.relayed).toEqual([]);

  expect((await relay(mausbotToken, call("GMAIL_FETCH_EMAILS"))).body.result.isError).not.toBe(true);
  expect(router.relayed).toHaveLength(1);
  expect((await s.lines(mausbot.threadId)).some((line) => line.card?.outboundRequest)).toBe(false);

  const pending = async () => (await s.lines(mausbot.threadId)).findLast((line) => line.card?.outboundRequest && !line.card.answered);
  const held = relay(mausbotToken, call("GMAIL_SEND_EMAIL", { to: "someone@example.test" }));
  await expect.poll(async () => Boolean(await pending()), { timeout: 10_000 }).toBe(true);
  expect(router.relayed).toHaveLength(1);
  const card = (await pending()).card;
  expect((await s.api("POST", `/api/threads/${mausbot.threadId}/respond`, { requestId: card.requestId, behavior: "deny" })).status).toBe(200);
  expect((await held).body.result.isError).toBe(true);
  expect(router.relayed).toHaveLength(1);

  const approved = relay(mausbotToken, call("GMAIL_SEND_EMAIL", { to: "someone@example.test" }));
  await expect.poll(async () => Boolean(await pending()), { timeout: 10_000 }).toBe(true);
  const next = (await pending()).card;
  await s.api("POST", `/api/threads/${mausbot.threadId}/respond`, { requestId: next.requestId, behavior: "allow" });
  expect((await approved).body.result.isError).not.toBe(true);
  expect(router.relayed).toHaveLength(2);
}, 90_000);

it("adds MausBot to an install that had none, offers a Chief once, and lets only an admin answer", async () => {
  const first = await start({ signIn: true });
  const [starter] = await first.bots(BOSS);
  // The install as it was before this version: one bot of the person's, no Chief, no MausBot.
  expect((await first.api("PATCH", `/api/bots/${starter.id}/profile`, { name: "Tango" }, BOSS)).status).toBe(200);
  expect((await first.api("PATCH", `/api/bots/${starter.id}`, { chiefOfStaff: false }, BOSS)).status).toBe(200);
  await first.stop();
  const file = join(first.dataDir, "bots.json");
  writeFileSync(file, JSON.stringify((JSON.parse(readFileSync(file, "utf8")) as Array<{ builtIn?: string }>).filter((bot) => !bot.builtIn)));
  const s = await start({ home: first.home, tokens: first.tokens });
  const bots = await s.bots(BOSS);
  expect(bots.map((bot) => bot.name)).toEqual(["Tango", "MausBot"]);
  const mausbot = bots[1];
  expect((await s.bots(BOB)).some((bot) => bot.builtIn)).toBe(false);
  expect((await s.api("POST", "/api/presence/active", { source: "desktop" }, BOB)).status).toBe(403);
  expect(await s.lines(mausbot.threadId, BOSS)).toEqual([]);
  await s.api("POST", "/api/presence/active", { source: "desktop" }, BOSS);
  const offer = async () => (await s.lines(mausbot.threadId, BOSS)).find((line) => line.card?.title === "Set up a Chief of Staff?");
  await expect.poll(async () => Boolean(await offer()), { timeout: 15_000 }).toBe(true);
  const card = (await offer()).card;
  expect(card.options).toEqual(["Create a Chief of Staff", "Make Tango the Chief", "Not now"]);
  const asBob = await s.api("POST", `/api/threads/${mausbot.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: "Create a Chief of Staff" }, BOB);
  expect([403, 404]).toContain(asBob.status);
  const asBoss = await s.api("POST", `/api/threads/${mausbot.threadId}/respond`, { requestId: card.requestId, behavior: "answer", message: "Make Tango the Chief" }, BOSS);
  expect(asBoss.body).toEqual({ ok: true, outcome: "answered" });
  expect((await s.bots(BOSS)).filter((bot) => bot.chiefOfStaff).map((bot) => bot.name)).toEqual(["Tango"]);
  await expect.poll(() => s.brief(), { timeout: 15_000 }).toMatchObject({ mausbotIntro: expect.anything(), chiefOffer: { answered: "appoint" } });
  await s.api("POST", "/api/presence/active", { source: "phone" }, BOSS);
  expect((await s.lines(mausbot.threadId, BOSS)).filter((line) => line.card?.title === "Set up a Chief of Staff?")).toHaveLength(1);
}, 120_000);

it("seeds no MausBot or Chief and posts no recap on a hosted team workspace", async () => {
  const home = mkdtempSync(join(tmpdir(), "omb-mb-"));
  cleanups.push(() => removeTempDir(home));
  const dataDir = join(home, ".openmausbot");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, PRESENCE_FILE), JSON.stringify({ lastActiveAt: Date.now() - 9 * HOUR }));
  const s = await start({ home, hosted: true });
  const [starter, ...rest] = await s.bots();
  expect(rest).toEqual([]);
  expect([starter.builtIn, Boolean(starter.chiefOfStaff)]).toEqual([undefined, false]);
  const presence = await s.api("POST", "/api/presence/active", { source: "desktop", timeZone: "Asia/Kolkata" });
  expect(presence).toEqual({ status: 200, body: { ok: true, returned: false } });
  expect((await s.lines(starter.threadId)).some((line) => line.kind === "widget" || line.card?.title === "Set up a Chief of Staff?")).toBe(false);
  expect((await s.bots()).map((bot) => [bot.builtIn, Boolean(bot.chiefOfStaff)])).toEqual([[undefined, false]]);
  expect(existsSync(join(dataDir, BRIEF_STATE_FILE))).toBe(false);
}, 90_000);
