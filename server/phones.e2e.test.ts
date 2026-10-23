// A real server with the fake engine left hanging, so a turn stays live: a phone pairs as a session and registers its
// apps, the Chief's turn mounts the device tools, a tool call becomes a phone job the phone polls, leases and answers,
// and the phone hears of the job over SSE. A bot without a grant sees no phone tools, and a read-and-draft run gets no
// phone at all.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-omb.ts";
import { PHONE_MCP_SERVER } from "../shared/phone-apps.ts";
import { harnessMcpTokenEnv } from "./harness-mcp-token.ts";
import { PHONE_INTERNAL_MCP_PATH } from "./phones/rpc.ts";
import { READ_AND_DRAFT_REFUSAL } from "./read-and-draft.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse, type SseRecorder } from "./testing/sse.ts";

const key = "isolated-phone-capability";
const PHONE_NAME = "Omkar's iPhone";
const CALENDAR_TOOLS = ["PHONE_LIST_EVENTS", "PHONE_GET_EVENT", "PHONE_FIND_FREE_TIME", "PHONE_CREATE_EVENT", "PHONE_UPDATE_EVENT", "PHONE_DELETE_EVENT", "PHONE_RESPOND_TO_INVITE"];
let fixture: VerificationServer;
let child: ChildProcess;
let url: string;
let chief: { id: string; threadId: string };
let pairing: { token: string; session: { id: string } };
let events: SseRecorder | undefined;

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const response = await fetch(url + path, {
    method, headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const phone = (method: string, path: string, body?: unknown) => api(method, path, body, pairing.token);
const rpc = async (token: string, method: string, params: unknown = {}) => {
  const response = await fetch(url + PHONE_INTERNAL_MCP_PATH, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.json() as any };
};
const mint = async (botId: string, threadId: string) => {
  const response = await fetch(url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-openmausbot-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind: "device" }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
/** Starts whatever begins a turn and returns that turn's launch: its MCP servers and its system prompt. */
const launched = async (start: () => Promise<void>) => {
  rmSync(fixture.fixtureDumpPath, { force: true });
  await start();
  await vi.waitFor(() => expect(existsSync(fixture.fixtureDumpPath)).toBe(true), { timeout: 15_000 });
  return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")) as { mcpConfig: { mcpServers: Record<string, { env: Record<string, string> }> }; systemPrompt: string | null };
};
const turn = (bot: { id: string; threadId: string }, text: string) => launched(async () => {
  expect((await api("POST", `/api/bots/${bot.id}/messages`, { threadId: bot.threadId, text })).status).toBe(202);
});

beforeAll(async () => {
  fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  url = fixture.info.url;
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, fixture.info.dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: key },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  for (const deadline = Date.now() + 20_000; ;) {
    try { if ((await fetch(url + "/api/health")).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("isolated phone server did not start");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const found = (await api("GET", "/api/bots")).body.bots.find((bot: { chiefOfStaff?: boolean }) => bot.chiefOfStaff);
  chief = { id: found.id, threadId: found.mainThreadId ?? found.threadId };
  // The owner's own phone: paired from the desktop with the owner's scopes, so it also hears the owner-only job nudge.
  const opened = await api("POST", "/api/auth/pairing", { label: PHONE_NAME, scopes: ["admin", "client"] });
  expect(opened.status).toBe(200);
  pairing = (await api("POST", "/api/auth/pair", { code: opened.body.code })).body;
  expect(pairing.token).toMatch(/^omb_sess_/u);
}, 60_000);

afterAll(async () => {
  events?.close();
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture?.close();
});

it("a registered phone's tools reach the bot and a job round-trips", async () => {
  const phoneKey = `session:${pairing.session.id}`;
  events = await openSse(`${url}/api/events`, { authorization: `Bearer ${pairing.token}`, origin: url });
  const registered = await phone("PUT", "/api/phones/self", {
    installId: "install-0001", name: PHONE_NAME, platform: "ios", appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" },
  });
  expect(registered).toMatchObject({ status: 200, body: { phone: { key: phoneKey, online: true, registration: { name: PHONE_NAME } } } });
  // The per-bot grants picker lists the phone's tools once a phone is registered.
  expect((await api("GET", "/api/connectors/tools")).body.services.phone.map((tool: { name: string }) => tool.name)).toContain("PHONE_LIST_EVENTS");

  // The Chief may use every app by default: its turn mounts the device server and its prompt names the phone.
  const launch = await turn(chief, "What is on my calendar today?");
  const device = launch.mcpConfig.mcpServers[PHONE_MCP_SERVER];
  expect(device?.env.OMB_HARNESS_URL).toBe(`http://127.0.0.1:${new URL(url).port}`);
  expect(launch.systemPrompt).toContain(`${PHONE_NAME} is an iPhone; this bot may use: Calendar.`);
  const token = device!.env[harnessMcpTokenEnv("device")]!;
  expect(token).toBeTruthy();

  const listed = await rpc(token, "tools/list");
  expect(listed.status).toBe(200);
  expect(listed.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(CALENDAR_TOOLS);

  const range = { from: "2026-10-23T00:00:00+05:30", to: "2026-10-24T00:00:00+05:30" };
  const answer = rpc(token, "tools/call", { name: "PHONE_LIST_EVENTS", arguments: range });
  const { job } = (await phone("GET", "/api/phones/self/jobs")).body;
  expect(job).toMatchObject({ id: expect.any(String), tool: "PHONE_LIST_EVENTS", arguments: range });
  expect(await events.until((frame) => frame.kind === "device.job" && frame.id === job.id, 10_000)).toMatchObject({ kind: "device.job", phone: phoneKey, id: job.id });
  expect((await phone("POST", `/api/phones/self/jobs/${job.id}/lease`)).body).toEqual({ active: true });
  expect((await phone("POST", `/api/phones/self/jobs/${job.id}/result`, { ok: true, result: { events: [] } })).body).toEqual({ ok: true });
  const { status, body } = await answer;
  expect(status).toBe(200);
  expect(body.result.isError).toBeUndefined();
  expect(body.result.content[0].text).toContain(PHONE_NAME);
  expect(body.result.structuredContent).toEqual({ phone: { name: PHONE_NAME, platform: "ios" }, events: [] });
}, 60_000);

it("a bot without a grant sees no phone tools", async () => {
  const scout = (await api("POST", "/api/bots", { name: "Scout" })).body.bot;
  const launch = await turn({ id: scout.id, threadId: scout.threadId }, "What is on my calendar today?");
  expect(launch.mcpConfig.mcpServers[PHONE_MCP_SERVER]).toBeUndefined();
  const token = await mint(scout.id, scout.threadId);
  expect((await rpc(token, "tools/list")).body.result.tools).toEqual([]);
  // The owner's own turn, refused for the grant alone.
  const refused = (await rpc(token, "tools/call", { name: "PHONE_LIST_EVENTS", arguments: { from: "2026-10-23T00:00:00+05:30", to: "2026-10-24T00:00:00+05:30" } })).body.result;
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toBe("OpenMausBot did not run this: Scout has not been given access to Phone Calendar. Ask the user to allow it under the bot's Access settings, and do not retry.");
}, 60_000);

it("a confined run has no device integration", async () => {
  const schedule = { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 60 * 60_000 };
  const routine = async (name: string, access?: "read-and-draft") => {
    const created = await api("POST", "/api/routines", { name, prompt: `${name}: look at my calendar.`, botId: chief.id, schedule, ...(access ? { access } : {}) });
    expect(created.status).toBe(201);
    return created.body.routine.id as string;
  };
  const run = async (id: string) => {
    let runId = "";
    const launch = await launched(async () => {
      const started = await api("POST", `/api/routines/${id}/run`);
      expect(started.status).toBe(201);
      runId = started.body.run.id;
    });
    const threadId = (await api("GET", "/api/routines")).body.runs.find((one: { id: string }) => one.id === runId).threadId as string;
    return { launch, threadId };
  };
  // The same routine at the bot's own level reaches the phone, so the read-and-draft run below loses it to the fence alone.
  expect(Object.keys((await run(await routine("Calendar look"))).launch.mcpConfig.mcpServers)).toContain(PHONE_MCP_SERVER);
  const confined = await run(await routine("Calendar watch", "read-and-draft"));
  expect(Object.keys(confined.launch.mcpConfig.mcpServers)).not.toContain(PHONE_MCP_SERVER);
  const refused = await rpc(await mint(chief.id, confined.threadId), "tools/list");
  expect(refused).toEqual({ status: 403, body: { error: READ_AND_DRAFT_REFUSAL } });
}, 60_000);
