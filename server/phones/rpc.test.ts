// The device kind's MCP entry: tools/list follows the phone's apps and the bot's grant, a call becomes a job that a
// scripted phone leases and answers, a send waits on the hold and is checked again after it, and only the owner's own
// turns reach a phone.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PHONE_TOOL_NAMES, phoneToolCapability } from "../../shared/phone-apps.ts";
import { flushDecisionLog, readDecisions } from "../decision-log.ts";
import type { OutboundHold, OutboundHoldAnswer } from "../outbound-hold.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { BotRecord } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhoneHost } from "./host.ts";
import { PHONE_INSTRUCTIONS, PHONE_NO_PHONE_TEXT } from "./instructions.ts";
import { PHONE_JOB_TIMEOUT_MS, PHONE_SEND_TIMEOUT_MS, PhoneJobs, type PhoneJobDelivery, type PhoneJobOutcome } from "./jobs.ts";
import { PhoneRegistry, type PhoneRegistration } from "./registry.ts";
import { phoneRpc, type PhoneRpcDeps, type PhoneToolsList } from "./rpc.ts";
import type { PhoneToolResult } from "./tools.ts";

const OWNER = "owner";
const IPHONE = "companion:iphone";
const PIXEL = "companion:pixel";
const TURN = { botId: "chief", threadId: "thread-1", generation: "gen-1" };
const RANGE = { from: "2026-10-24T00:00:00+05:30", to: "2026-10-25T00:00:00+05:30" };
const NOT_OWNER_TEXT = "This conversation can't use a phone: only the owner's own turns can.";

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) { await flushDecisionLog(dir); await removeTempDir(dir); }
});

const bot = (fields: Partial<BotRecord>) => ({ id: "chief", name: "MausBot", color: "teal", ...fields }) as BotRecord;
const chief = bot({ chiefOfStaff: true });
const registration = (name: string, capabilities: PhoneRegistration["capabilities"], platform: "ios" | "android" = "ios"): PhoneRegistration =>
  ({ installId: `install-${name.replace(/\W+/g, "-")}`, name, platform, appVersion: "1.6.0", timeZone: "Asia/Kolkata", capabilities });
const call = (name: string, args: Record<string, unknown> = {}) => ({ method: "tools/call", params: { name, arguments: args } });
const text = (result: PhoneToolsList | PhoneToolResult) => (result as PhoneToolResult).content[0]!.text;

function harness(options: { bot?: () => BotRecord | null; hold?: Partial<OutboundHold> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-phone-rpc-"));
  dirs.push(dir);
  const clock = { now: 1_800_000_000_000 };
  const registry = new PhoneRegistry(join(dir, "phones.json"), () => clock.now);
  const jobs = new PhoneJobs();
  const state = { owner: OWNER as string | null, inRoom: false };
  const messages: Array<{ threadId: string; message: Record<string, unknown> }> = [];
  const host = createPhoneHost({
    registry, jobs, dataDir: dir,
    bot: (id) => (id === TURN.botId ? (options.bot?.() ?? chief) : undefined),
    turnOwner: () => state.owner,
    inRoom: () => state.inRoom,
    appendMessage: (threadId, message) => { messages.push({ threadId, message }); },
    outboundHold: { hold: async () => ({ ok: true, approved: true }), reserve: () => {}, ...options.hold },
    sendsFreely: () => false,
    active: () => true,
  });
  let checks = 0;
  const handle = (body: unknown) => host.handle(body, TURN, () => { checks++; });
  const rows = async () => { await flushDecisionLog(dir); return readDecisions(dir, 200); };
  return { dir, clock, registry, jobs, state, messages, host, handle, rows, checks: () => checks };
}

/** The phone's side of one job: take it from the long poll, lease it and answer. */
async function answerNext(jobs: PhoneJobs, key: string, answer: (job: PhoneJobDelivery) => PhoneJobOutcome): Promise<PhoneJobDelivery> {
  const job = await jobs.poll(key);
  if (!job) throw new Error("no job reached the phone");
  expect(jobs.lease(key, job.id)).toBe(true);
  jobs.complete(key, job.id, answer(job));
  return job;
}

describe("phone MCP host", () => {
  it("tools/list shows what the bot may run on the paired phone", async () => {
    const h = harness();
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { calendar: "full" }));
    h.registry.register("companion:guest", "someone-else", registration("Guest Pixel", { contacts: "full", messages: "send" }, "android"));
    const listed = await h.handle({ method: "tools/list" }) as PhoneToolsList;
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(PHONE_TOOL_NAMES.filter((name) => phoneToolCapability(name) === "calendar"));
    expect(names.every((name) => name.startsWith("PHONE_"))).toBe(true);
    expect(listed.instructions).toBe(PHONE_INSTRUCTIONS);
    expect(h.checks()).toBe(1);
    // A bot with no grant sees nothing and mounts nothing.
    const scout = harness({ bot: () => bot({ name: "Scout" }) });
    scout.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { calendar: "full" }));
    expect((await scout.handle({ method: "tools/list" }) as PhoneToolsList).tools).toEqual([]);
    expect(scout.host.mounts(bot({ name: "Scout" }), OWNER)).toBe(false);
    expect(scout.host.integration(bot({ name: "Scout" }), OWNER, () => "tok", "http://127.0.0.1:1")).toBeNull();
    // The mount, the prompt and the tools picker for the paired phone.
    expect(h.host.mounts(chief, OWNER)).toBe(true);
    expect(h.host.mounts(chief, "someone-else")).toBe(true);
    expect(h.host.mounts(bot({ phoneApps: { messages: "write" } }), OWNER)).toBe(false);
    expect(h.host.integration(chief, OWNER, () => "turn-token", "http://127.0.0.1:1")).toEqual({
      command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, "device"],
      env: { ...AGENTS_NODE_FLAG, OMB_MCP_TOKEN_DEVICE: "turn-token", OMB_HARNESS_URL: "http://127.0.0.1:1" },
    });
    expect(h.host.prompt(chief, OWNER)).toContain("Omkar's iPhone is an iPhone; this bot may use: Calendar.");
    expect(h.host.prompt(chief, OWNER)).not.toContain("Guest Pixel");
    expect(h.host.toolListing()?.phone.map((tool) => tool.name)).toEqual([...PHONE_TOOL_NAMES]);
    const rows = await h.rows();
    expect(rows.filter((row) => row.decision === "auto-approved").map((row) => row.tool)).toEqual(names);
    expect(rows[0]).toMatchObject({ threadId: TURN.threadId, botId: "chief", botName: "MausBot", source: "connector-scope", rule: "scope:phone:calendar" });
  });

  it("a read runs on the phone and the result names the phone", async () => {
    const h = harness();
    h.registry.register(PIXEL, OWNER, registration("Work Pixel", { contacts: "full" }, "android"));
    h.clock.now += 1_000;
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { calendar: "full" }));
    const request = vi.spyOn(h.jobs, "request");
    const pending = h.handle(call("PHONE_LIST_EVENTS", RANGE));
    const job = await answerNext(h.jobs, IPHONE, () => ({ ok: true, result: { events: [] } }));
    expect(job).toMatchObject({ tool: "PHONE_LIST_EVENTS", arguments: RANGE });
    const result = await pending as PhoneToolResult;
    expect(result.isError).toBeUndefined();
    expect(text(result)).toContain("Omkar's iPhone");
    expect(text(result)).toContain("events");
    expect(result.structuredContent).toEqual({ phone: { name: "Omkar's iPhone", platform: "ios" }, events: [] });
    expect(request.mock.calls[0]![3]).toMatchObject({ timeoutMs: PHONE_JOB_TIMEOUT_MS, offlineText: "Omkar's iPhone is offline. Open the MausBot app on it." });
    expect(h.registry.get(IPHONE)!.lastUsedAt).toBe(h.clock.now);
    expect(h.messages).toEqual([]);
    expect(h.checks()).toBe(2);
    // Named by the bot (any case), the other phone runs it; the phone argument is not passed on.
    const named = h.handle(call("PHONE_SEARCH_CONTACTS", { query: "Asha", phone: "WORK PIXEL" }));
    const pixelJob = await answerNext(h.jobs, PIXEL, () => ({ ok: true, result: { contacts: [{ id: "c1", name: "Asha" }] } }));
    expect(pixelJob.arguments).toEqual({ query: "Asha" });
    expect((await named as PhoneToolResult).structuredContent).toMatchObject({ phone: { name: "Work Pixel", platform: "android" } });
    // The chosen phone's own apps decide: the Pixel never allowed Calendar, though the iPhone did.
    request.mockClear();
    const refused = await h.handle(call("PHONE_LIST_EVENTS", { ...RANGE, phone: "Work Pixel" })) as PhoneToolResult;
    expect(refused).toMatchObject({ isError: true, structuredContent: { code: "denied" } });
    expect(text(refused)).toBe("Work Pixel does not allow Calendar.");
    expect(request).not.toHaveBeenCalled();
  });

  it("a write records an activity row", async () => {
    const h = harness();
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { calendar: "full" }));
    const event = { title: "Dentist", start: "2026-10-24T10:00:00+05:30", end: "2026-10-24T11:00:00+05:30" };
    const pending = h.handle(call("PHONE_CREATE_EVENT", event));
    await answerNext(h.jobs, IPHONE, () => ({ ok: true, result: { id: "evt-1" } }));
    expect((await pending as PhoneToolResult).isError).toBeUndefined();
    expect(h.messages).toEqual([{ threadId: TURN.threadId, message: {
      role: "bot", kind: "activity", tool: { name: "mcp__device__PHONE_CREATE_EVENT", ok: true, summary: "Create event on Omkar's iPhone" },
    } }]);
    // In a room the row names its author.
    h.state.inRoom = true;
    const again = h.handle(call("PHONE_DELETE_EVENT", { id: "evt-1" }));
    await answerNext(h.jobs, IPHONE, () => ({ ok: true, result: { deleted: true } }));
    await again;
    expect(h.messages[1]!.message).toEqual({
      role: "bot", kind: "activity", tool: { name: "mcp__device__PHONE_DELETE_EVENT", ok: true, summary: "Delete event on Omkar's iPhone" },
      from: { botId: "chief", name: "MausBot", color: "teal" },
    });
    // A write the phone refused records no row and reaches the bot with the phone's reason.
    const failed = h.handle(call("PHONE_UPDATE_EVENT", { id: "evt-1", title: "Dentist (moved)" }));
    await answerNext(h.jobs, IPHONE, () => ({ ok: false, code: "not_found", error: "No event with that id." }));
    const result = await failed as PhoneToolResult;
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "not_found" } });
    expect(text(result)).toBe("No event with that id.");
    expect(h.messages).toHaveLength(2);
    expect((await h.rows()).map((row) => [row.tool, row.decision, row.rule])).toEqual([
      ["PHONE_CREATE_EVENT", "auto-approved", "scope:phone:calendar"],
      ["PHONE_DELETE_EVENT", "auto-approved", "scope:phone:calendar"],
      ["PHONE_UPDATE_EVENT", "auto-approved", "scope:phone:calendar"],
    ]);
  });

  it("a send waits on the hold and a refusal reaches the bot", async () => {
    const holds: Array<Parameters<OutboundHold["hold"]>[0]> = [];
    const reserves: Array<Parameters<OutboundHold["reserve"]>[0]> = [];
    let answer: ((value: OutboundHoldAnswer) => void) | undefined;
    let reserveRefusal: string | undefined;
    const h = harness({ hold: {
      hold: (input) => { holds.push(input); return new Promise((resolve) => { answer = resolve; }); },
      reserve: (input) => { reserves.push(input); if (reserveRefusal) throw new Error(reserveRefusal); },
    } });
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { messages: "send" }));
    const request = vi.spyOn(h.jobs, "request");
    const message = { to: "Mom", text: "On my way" };
    const pending = h.handle(call("PHONE_SEND_MESSAGE", message));
    await vi.waitFor(() => expect(holds).toHaveLength(1));
    expect(holds[0]).toMatchObject({ bot: { id: "chief" }, threadId: TURN.threadId, tool: "PHONE_SEND_MESSAGE",
      calls: [{ slug: "PHONE_SEND_MESSAGE", arguments: message }], opaque: false, fullAccess: false });
    expect(holds[0]!.active()).toBe(true);
    expect(request).not.toHaveBeenCalled();
    answer!({ ok: false, text: "declined" });
    const declined = await pending as PhoneToolResult;
    expect(declined).toMatchObject({ isError: true, structuredContent: { code: "refused" } });
    expect(text(declined)).toBe("declined");
    expect(reserves).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    // The dispatch-time reservation can refuse too, and its text reaches the bot.
    reserveRefusal = "This bot has reached its daily outbound limit. Nothing was sent.";
    const capped = h.handle(call("PHONE_SEND_MESSAGE", message));
    await vi.waitFor(() => expect(holds).toHaveLength(2));
    answer!({ ok: true, approved: false });
    expect(text(await capped)).toBe(reserveRefusal);
    expect(reserves[0]).toMatchObject({ tool: "PHONE_SEND_MESSAGE", approved: false, fullAccess: false });
    expect(request).not.toHaveBeenCalled();
    // Approved: the phone gets it with the send timeout, and the send shows as an activity row.
    reserveRefusal = undefined;
    const approved = h.handle(call("PHONE_SEND_WHATSAPP", message));
    await vi.waitFor(() => expect(holds).toHaveLength(3));
    answer!({ ok: true, approved: true });
    await answerNext(h.jobs, IPHONE, () => ({ ok: true, result: { status: "sheet_opened" } }));
    expect((await approved as PhoneToolResult).isError).toBeUndefined();
    expect(reserves[1]).toMatchObject({ tool: "PHONE_SEND_WHATSAPP", approved: true });
    expect(request.mock.calls[0]![3]).toMatchObject({ timeoutMs: PHONE_SEND_TIMEOUT_MS });
    expect(h.messages.map(({ message: row }) => (row.tool as { summary: string }).summary)).toEqual(["Send whatsapp on Omkar's iPhone"]);
  });

  it("grant lowered during the hold refuses the send", async () => {
    let held = false;
    const reserve = vi.fn();
    const h = harness({
      bot: () => bot({ name: "Scout", phoneApps: { messages: held ? "read" : "write" } }),
      hold: { hold: async () => { held = true; return { ok: true, approved: true }; }, reserve },
    });
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { messages: "send" }));
    const request = vi.spyOn(h.jobs, "request");
    const result = await h.handle(call("PHONE_SEND_MESSAGE", { to: "Mom", text: "On my way" })) as PhoneToolResult;
    expect(held).toBe(true);
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "refused" } });
    expect(text(result)).toBe("OpenMausBot did not run this: Phone Messages is read-only for Scout, and Send message would write to it. Ask the user before trying again.");
    expect(request).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
    expect((await h.rows()).map((row) => [row.decision, row.rule])).toEqual([
      ["auto-approved", "scope:phone:messages"],
      ["auto-denied", "scope:phone:messages:write"],
    ]);
  });

  it("no phone paired answers the no-phone sentence", async () => {
    const h = harness();
    expect(h.host.toolListing()).toBeNull();
    expect(h.host.mounts(chief, OWNER)).toBe(false);
    const mint = vi.fn(() => "tok");
    expect(h.host.integration(chief, OWNER, mint, "http://127.0.0.1:1")).toBeNull();
    expect(mint).not.toHaveBeenCalled();
    expect(h.host.prompt(chief, OWNER)).toBe("");
    // Another person's phone, or one of the owner's with every app off, is not one this turn can use.
    h.registry.register("companion:guest", "someone-else", registration("Guest Pixel", { location: "when_in_use" }, "android"));
    h.registry.register(PIXEL, OWNER, registration("Work Pixel", {}, "android"));
    expect(h.host.toolListing()?.phone).toHaveLength(PHONE_TOOL_NAMES.length);
    expect(h.host.mounts(chief, OWNER)).toBe(false);
    expect((await h.handle({ method: "tools/list" }) as PhoneToolsList).tools).toEqual([]);
    const request = vi.spyOn(h.jobs, "request");
    const result = await h.handle(call("PHONE_GET_LOCATION")) as PhoneToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(PHONE_NO_PHONE_TEXT);
    expect((await h.rows()).at(-1)).toMatchObject({ tool: "PHONE_GET_LOCATION", decision: "auto-denied", rule: "phone:no-phone" });
    // A phone the bot names that is not paired: the same sentence, with the phones there are.
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { location: "when_in_use" }));
    const named = await h.handle(call("PHONE_GET_LOCATION", { phone: "Work Laptop" })) as PhoneToolResult;
    expect(named).toMatchObject({ isError: true, structuredContent: { code: "no_phone" } });
    expect(text(named)).toBe(`${PHONE_NO_PHONE_TEXT} Available phones: Omkar's iPhone.`);
    expect(request).not.toHaveBeenCalled();
    // The rpc's own branch when no phone is left to pick.
    const run = vi.fn<PhoneRpcDeps["run"]>();
    const bare = await phoneRpc(call("PHONE_GET_LOCATION"), {
      assertActive: () => {}, authorize: () => ({ ok: true }), phone: () => null, holdSend: async () => ({ ok: true }), run,
    }) as PhoneToolResult;
    expect(bare).toMatchObject({ isError: true, structuredContent: { code: "no_phone" } });
    expect(text(bare)).toBe(PHONE_NO_PHONE_TEXT);
    expect(run).not.toHaveBeenCalled();
  });

  it("a turn that is not the owner's sees no tools", async () => {
    const h = harness();
    h.state.owner = null;
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { calendar: "full", messages: "send" }));
    expect(h.host.mounts(chief, null)).toBe(false);
    expect(h.host.integration(chief, null, () => "tok", "http://127.0.0.1:1")).toBeNull();
    expect(h.host.prompt(chief, null)).toBe("");
    expect((await h.handle({ method: "tools/list" }) as PhoneToolsList).tools).toEqual([]);
    const request = vi.spyOn(h.jobs, "request");
    const result = await h.handle(call("PHONE_LIST_EVENTS", RANGE)) as PhoneToolResult;
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "refused" } });
    expect(text(result)).toBe(NOT_OWNER_TEXT);
    expect(request).not.toHaveBeenCalled();
    const rows = await h.rows();
    expect(rows).toHaveLength(PHONE_TOOL_NAMES.length + 1);
    expect(rows.every((row) => row.decision === "auto-denied" && row.rule === "phone:not-owner" && row.source === "connector-scope")).toBe(true);
    expect(rows.at(-1)).toMatchObject({ tool: "PHONE_LIST_EVENTS", threadId: TURN.threadId, botId: "chief" });
    // The owner's own turn on the same phone sees them.
    h.state.owner = OWNER;
    expect(h.host.mounts(chief, OWNER)).toBe(true);
    expect((await h.handle({ method: "tools/list" }) as PhoneToolsList).tools.length).toBeGreaterThan(0);
  });

  it("an offline phone answers the offline sentence with the phone's name", async () => {
    const h = harness();
    h.registry.register(IPHONE, OWNER, registration("Omkar's iPhone", { calendar: "full" }));
    h.clock.now += 61_000;
    vi.useFakeTimers();
    const pending = h.handle(call("PHONE_LIST_EVENTS", RANGE));
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending as PhoneToolResult;
    expect(result).toMatchObject({ isError: true, structuredContent: { code: "offline" } });
    expect(text(result)).toBe("Omkar's iPhone is offline. Open the MausBot app on it.");
    expect(h.jobs.busy(IPHONE)).toBe(false);
    expect(h.registry.get(IPHONE)!.lastUsedAt).toBeNull();
  });
});
