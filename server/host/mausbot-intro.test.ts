import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { BotRecord, Message } from "../store.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createBriefState } from "./brief-state.ts";
import {
  appointOption, CHIEF_OFFER_TITLE, CONNECT_LINE, CREATE_CHIEF, createMausBotIntro, MAUSBOT_INTRO, MAUSBOT_NO_APPS, mausbotMayUse, NOT_NOW, type MausBotIntroDeps,
} from "./mausbot-intro.ts";

const NOW = Date.UTC(2026, 9, 17, 9, 0, 0);
const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const admin: RequestAuth = { kind: "session", scopes: ["admin", "client"], via: "bearer", session: {} as never };
const member: RequestAuth = { kind: "session", scopes: ["client"], via: "cookie", session: {} as never };
const service: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function world(options: { bots?: Array<Partial<BotRecord> & { id: string; name: string }>; mausbot?: Partial<BotRecord>; turns?: Array<[string, number]>;
  configured?: boolean; connected?: Record<string, { connected: boolean }> | Error; hosted?: boolean } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-mausbot-intro-"));
  dirs.push(dataDir);
  const bots = [...(options.bots ?? []), { id: "m", name: "MausBot", builtIn: "mausbot", visibility: "admins", ...options.mausbot }]
    .map((bot) => ({ threadId: `${bot.id}-main`, ...bot })) as BotRecord[];
  const messages = new Map<string, Message[]>();
  let ids = 0;
  let connected = options.connected ?? {};
  const store = {
    bots,
    bot: (id: string) => bots.find((bot) => bot.id === id) ?? null,
    appendMessage: vi.fn((threadId: string, message: Omit<Message, "id" | "at">) => {
      const list = messages.get(threadId) ?? [];
      const full = { id: `${threadId}-${list.length}`, at: NOW, ...message } as Message;
      messages.set(threadId, [...list, full]);
      return full;
    }),
    messagesFor: (threadId: string) => messages.get(threadId) ?? [],
    patchMessage: (threadId: string, id: string, patch: Partial<Message>) => {
      const list = messages.get(threadId) ?? [];
      const index = list.findIndex((line) => line.id === id);
      if (index < 0) return null;
      list[index] = { ...list[index]!, ...patch } as Message;
      return list[index]!;
    },
    patchTask: vi.fn(() => null),
    createBot: vi.fn((profile?: { name?: string }) => {
      const bot = { id: `new${bots.length}`, name: profile?.name ?? "Random", threadId: `new${bots.length}-main` } as BotRecord;
      bots.unshift(bot);
      return bot;
    }),
    setChiefOfStaff: vi.fn((id: string) => { for (const bot of bots) bot.chiefOfStaff = bot.id === id; return []; }),
  };
  const file = join(dataDir, "brief.json");
  const state = createBriefState(file);
  const checks = vi.fn(async () => { if (connected instanceof Error) throw connected; return connected; });
  const intro = createMausBotIntro({
    store: store as unknown as MausBotIntroDeps["store"], state, hosted: options.hosted ?? false,
    mainThread: (bot) => bot.threadId, turnsByBot: () => new Map(options.turns ?? []),
    configured: () => options.configured ?? true,
    connected: checks,
    newId: () => `id${++ids}`, now: () => NOW,
  });
  const thread = () => messages.get("m-main") ?? [];
  const offer = () => thread().find((line) => line.card?.title === CHIEF_OFFER_TITLE)!;
  const saved = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  return {
    intro, store, state, thread, offer, saved, checks,
    reconnect: (value: Record<string, { connected: boolean }> | Error) => { connected = value; },
  };
}

describe("MausBot's intro", () => {
  it("posts its first message once, the Chief offer naming the most-used bot, and the connect card for what is missing", async () => {
    const w = world({ bots: [{ id: "pepper", name: "Pepper" }, { id: "tango", name: "Tango" }], turns: [["tango", 5], ["pepper", 1], ["m", 50]], connected: { gmail: { connected: true } } });
    await w.intro.introduce();
    const lines = w.thread();
    expect(lines[0]).toMatchObject({ role: "bot", kind: "text", text: MAUSBOT_INTRO });
    expect(w.offer().card).toMatchObject({ options: [CREATE_CHIEF, appointOption("Tango"), NOT_NOW], fixedOptions: true, requestId: "id1" });
    expect(lines.filter((line) => line.kind === "text").map((line) => line.text)).toEqual([MAUSBOT_INTRO, CONNECT_LINE]);
    expect(lines.filter((line) => line.kind === "connector").map((line) => line.connector)).toEqual([
      expect.objectContaining({ slug: "googlecalendar", label: "Google Calendar", status: "required", resumeKey: "mausbot-connect-id2" }),
    ]);
    expect(w.store.patchTask).toHaveBeenCalledWith("m", "m-main", { unread: true });
    expect(w.saved()).toMatchObject({
      mausbotIntro: { at: NOW, threadId: "m-main" },
      chiefOffer: { requestId: "id1", threadId: "m-main", messageId: w.offer().id, candidateId: "tango" },
      connectOffer: { at: NOW, threadId: "m-main", shown: true },
    });
    await w.intro.introduce();
    expect(w.thread()).toHaveLength(lines.length);
  });

  it("offers no Chief when one exists, and no connect card when both are connected", async () => {
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], connected: { gmail: { connected: true }, googlecalendar: { connected: true } } });
    await w.intro.introduce();
    expect(w.thread().map((line) => line.kind)).toEqual(["text"]);
    expect(w.state.get().connectOffer).toMatchObject({ shown: false });
  });

  it("says so, and offers nothing to connect, on a server without connected apps", async () => {
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], configured: false });
    await w.intro.introduce();
    expect(w.thread().map((line) => line.text)).toEqual([`${MAUSBOT_INTRO}\n\n${MAUSBOT_NO_APPS}`]);
    expect(w.state.get().connectOffer).toBeUndefined();
    expect(w.checks).not.toHaveBeenCalled();
  });

  it("offers the connect card on a server with connected apps whatever MausBot's engine, and none on a server without them", async () => {
    const engine = { modelSelection: { instanceId: "engine-without-connected-app-tools", model: "plain" } } as Partial<BotRecord>;
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], mausbot: engine });
    await w.intro.introduce();
    expect(w.thread().filter((line) => line.kind === "connector").map((line) => line.connector?.slug)).toEqual(["gmail", "googlecalendar"]);
    expect(w.state.get().connectOffer).toMatchObject({ shown: true });
    const bare = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], mausbot: engine, configured: false });
    await bare.intro.introduce();
    expect(bare.thread().some((line) => line.kind === "connector" || line.text === CONNECT_LINE)).toBe(false);
    expect(bare.checks).not.toHaveBeenCalled();
  });

  it("waits out a failed connected-apps check and offers the card on a later presence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], connected: new Error("broker down") });
    await w.intro.introduce();
    expect(w.thread().some((line) => line.kind === "connector")).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broker down"));
    w.reconnect({});
    await w.intro.introduce();
    expect(w.thread().filter((line) => line.kind === "connector").map((line) => line.connector?.slug)).toEqual(["gmail", "googlecalendar"]);
  });

  it("checks connected apps once for presences that arrive together", async () => {
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }] });
    await Promise.all([w.intro.introduce(), w.intro.introduce()]);
    expect(w.checks).toHaveBeenCalledTimes(1);
    expect(w.thread().map((line) => line.text)).toEqual([MAUSBOT_INTRO, CONNECT_LINE, "Connect Gmail to continue.", "Connect Google Calendar to continue."]);
  });

  it("offers only the services MausBot may use", async () => {
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], mausbot: { connectorTools: { gmail: { tools: "*" } } as unknown as BotRecord["connectorTools"] } });
    await w.intro.introduce();
    expect(w.thread().filter((line) => line.kind === "connector").map((line) => line.connector?.slug)).toEqual(["gmail"]);
    expect(mausbotMayUse({ composio: false }, "gmail")).toBe(false);
    expect(mausbotMayUse({}, "googlecalendar")).toBe(true);
    expect(mausbotMayUse({ connectorTools: {} }, "gmail")).toBe(false);
  });

  it("does nothing on a hosted workspace", async () => {
    const w = world({ hosted: true });
    await w.intro.introduce();
    expect(w.thread()).toEqual([]);
    expect(w.checks).not.toHaveBeenCalled();
  });

  it("never rejects: a failing store is logged and the intro is tried again on the next presence", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ bots: [{ id: "chief", name: "Chief of Staff", chiefOfStaff: true }], configured: false });
    w.store.appendMessage.mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(w.intro.introduce()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(w.state.get().mausbotIntro).toBeUndefined();
    await w.intro.introduce();
    expect(w.thread().map((line) => line.text)).toEqual([`${MAUSBOT_INTRO}\n\n${MAUSBOT_NO_APPS}`]);
  });

  it("logs a failed brief.json save and still posts each line once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ bots: [{ id: "tango", name: "Tango" }] });
    vi.spyOn(w.state, "patch").mockImplementation(() => { throw new Error("read-only file system"); });
    await expect(w.intro.introduce()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("read-only file system"));
    const lines = w.thread().length;
    expect(lines).toBe(5);
    await w.intro.introduce();
    expect(w.thread()).toHaveLength(lines);
    expect(w.intro.answerCard("m-main", w.offer().card!.requestId!, "answer", NOT_NOW, owner)).toBe("rejected");
    expect(w.offer().card).toMatchObject({ answered: "answer", answeredText: NOT_NOW });
  });
});

describe("the Chief offer", () => {
  const answer = (w: ReturnType<typeof world>, choice: string, auth: RequestAuth, behavior: "allow" | "deny" | "answer" = "answer") =>
    w.intro.answerCard("m-main", w.offer().card!.requestId!, behavior, choice, auth);

  it("creates a Chief of Staff for the owner, once", async () => {
    const w = world({ bots: [{ id: "tango", name: "Tango" }], connected: {} });
    await w.intro.introduce();
    expect(answer(w, CREATE_CHIEF, owner)).toBe("answered");
    expect(w.store.createBot).toHaveBeenCalledWith({ name: "Chief of Staff" });
    expect(w.store.bots.find((bot) => bot.chiefOfStaff)?.name).toBe("Chief of Staff");
    expect(w.offer().card).toMatchObject({ answered: "answer", answeredText: CREATE_CHIEF });
    expect(w.saved()).toMatchObject({ chiefOffer: { answered: "create" } });
    expect(answer(w, NOT_NOW, owner)).toBe("answered");
    expect(w.store.createBot).toHaveBeenCalledTimes(1);
  });

  it("appoints the named bot for an admin, never MausBot", async () => {
    const w = world({ bots: [{ id: "tango", name: "Tango" }], turns: [["tango", 3], ["m", 9]] });
    await w.intro.introduce();
    expect(answer(w, appointOption("Tango"), admin)).toBe("answered");
    expect(w.store.setChiefOfStaff).toHaveBeenCalledWith("tango");
    expect(w.store.setChiefOfStaff).toHaveBeenCalledTimes(1);
    expect(w.state.get().chiefOffer?.answered).toBe("appoint");
  });

  it("changes nothing for a member, records nothing and keeps the card open", async () => {
    const w = world({ bots: [{ id: "tango", name: "Tango" }] });
    await w.intro.introduce();
    const before = w.saved();
    expect(answer(w, CREATE_CHIEF, member)).toBe("unavailable");
    expect(answer(w, NOT_NOW, member, "deny")).toBe("unavailable");
    expect(w.store.createBot).not.toHaveBeenCalled();
    expect(w.offer().card?.answered).toBeUndefined();
    expect(w.saved()).toEqual(before);
    expect(answer(w, NOT_NOW, owner)).toBe("rejected");
    expect(answer(w, CREATE_CHIEF, member)).toBe("unavailable");
  });

  it("changes nothing for a service-trust caller, whose decline reaches the card, and keeps the card open", async () => {
    const w = world({ bots: [{ id: "tango", name: "Tango" }], turns: [["tango", 2]] });
    await w.intro.introduce();
    const before = w.saved();
    expect(answer(w, NOT_NOW, service, "deny")).toBe("unavailable");
    expect(answer(w, appointOption("Tango"), service)).toBe("unavailable");
    expect(w.store.setChiefOfStaff).not.toHaveBeenCalled();
    expect(w.offer().card?.answered).toBeUndefined();
    expect(w.state.get().chiefOffer?.answered).toBeUndefined();
    expect(w.saved()).toEqual(before);
  });

  it("records Not now, settles a card whose Chief appeared meanwhile without a second Chief, and ignores other cards", async () => {
    const w = world({ bots: [{ id: "tango", name: "Tango" }] });
    await w.intro.introduce();
    expect(w.intro.answerCard("m-main", "someone-else", "answer", CREATE_CHIEF, owner)).toBeUndefined();
    expect(w.intro.answerCard("other-thread", w.offer().card!.requestId!, "answer", CREATE_CHIEF, owner)).toBeUndefined();
    w.store.bots[0]!.chiefOfStaff = true;
    expect(answer(w, CREATE_CHIEF, owner)).toBe("rejected");
    expect(w.store.createBot).not.toHaveBeenCalled();
    const fresh = world({ bots: [{ id: "tango", name: "Tango" }] });
    await fresh.intro.introduce();
    expect(answer(fresh, NOT_NOW, owner)).toBe("rejected");
    expect(fresh.state.get().chiefOffer?.answered).toBe("no");
  });

  it("answers nothing on a hosted workspace, even for an offer left in brief.json", () => {
    const w = world({ hosted: true });
    const card = w.store.appendMessage("m-main", { role: "bot", kind: "options", card: { title: CHIEF_OFFER_TITLE, subtitle: "", options: [CREATE_CHIEF, NOT_NOW], requestId: "id1", fixedOptions: true } });
    w.state.patch({ chiefOffer: { requestId: "id1", threadId: "m-main", messageId: card.id, at: NOW } });
    expect(w.intro.answerCard("m-main", "id1", "answer", CREATE_CHIEF, owner)).toBeUndefined();
    expect(w.store.createBot).not.toHaveBeenCalled();
  });
});
