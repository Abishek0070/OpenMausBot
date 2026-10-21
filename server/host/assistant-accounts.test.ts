import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceError, type AssistantService, type SourceAccount } from "../assistant-sources.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { accountLabel, createAssistantAccounts, disconnectedText, reconnectText, type AssistantAccounts } from "./assistant-accounts.ts";
import { prunePending } from "./assistant-plan.ts";
import { createAssistantState, MAX_ACCOUNTS, MAX_ID_LENGTH, type AssistantStatePatch, type PendingEmail } from "./assistant-state.ts";
import { DISCONNECTED_TEXT, RECONNECT_TEXT } from "./assistant-watch.ts";

const MINUTE = 60_000;
const CHECK_MS = 15 * MINUTE;
const NOW = Date.parse("2026-10-21T09:00:00.000Z");
const G1: SourceAccount = { service: "gmail", id: "ca_g1", alias: "work", active: true };
const G2: SourceAccount = { service: "gmail", id: "ca_g2", active: true };
const C1: SourceAccount = { service: "googlecalendar", id: "ca_c1", active: true };
const IMPLIED_GMAIL: SourceAccount = { service: "gmail", id: "gmail", active: true, implied: true };
const failing = async (): Promise<never> => { throw new SourceError("gmail", "connected apps refused the read"); };

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function world(options: { mayUse?: (service: AssistantService) => boolean; seed?: AssistantStatePatch } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-assistant-accounts-"));
  dirs.push(dir);
  const state = createAssistantState(join(dir, "assistant.json"));
  if (options.seed) state.patch(options.seed);
  let clock = NOW;
  const live = {
    listed: [G1, C1] as SourceAccount[] | null,
    addresses: { ca_g1: "admin@example.test", ca_c1: "me@example.test" } as Record<string, string | null | Error>,
  };
  const address = vi.fn(async (account: SourceAccount) => {
    const answer = live.addresses[account.id] ?? null;
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const reconnect = vi.fn<(account: SourceAccount, label: string | undefined, text: string) => void>();
  const make = (): AssistantAccounts => createAssistantAccounts({
    state,
    sources: { accounts: async () => live.listed, address },
    now: () => clock,
    checkMs: CHECK_MS,
    mayUse: options.mayUse ?? (() => true),
    reconnect,
  });
  return {
    state,
    address,
    reconnect,
    accounts: make(),
    get listed() { return live.listed; },
    set listed(next: SourceAccount[] | null) { live.listed = next; },
    addresses: live.addresses,
    tick(ms: number) { clock += ms; },
  };
}

describe("createAssistantAccounts", () => {
  it("lists every account and reads each new address once, caching it in assistant.json", async () => {
    const w = world();
    await w.accounts.refresh(); await w.accounts.refresh();
    expect(w.address).toHaveBeenCalledTimes(2);
    expect(w.state.get().accounts).toMatchObject({ ca_g1: { service: "gmail", address: "admin@example.test", connectedSeen: true } });
    expect(w.accounts.addresses()).toEqual(new Set(["admin@example.test", "me@example.test"]));
    expect(w.accounts.listed()).toBe(true);
    expect(w.accounts.address("ca_c1")).toBe("me@example.test");
    expect(w.accounts.label("ca_g1")).toBe("admin@example.test");
  });

  it("labels an account by its address, else its alias, else a short id", () => {
    expect(accountLabel({ id: "ca_abcdef123456", alias: "work" }, "a@x.test")).toBe("a@x.test");
    expect(accountLabel({ id: "ca_abcdef123456", alias: "work" })).toBe("work");
    expect(accountLabel({ id: "ca_abcdef123456" })).toBe("account …123456");
    expect(accountLabel({ id: "gmail", implied: true })).toBeUndefined();
  });

  it("names an implied account with no address by its service", async () => {
    const w = world();
    w.listed = [IMPLIED_GMAIL, C1];
    await w.accounts.refresh();
    expect(w.accounts.label("gmail")).toBe("Gmail");
    expect(w.accounts.label("ca_c1")).toBe("me@example.test");
  });

  it("posts one Reconnect card naming the account after three failed reads in a row, and resets after a success", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    await w.accounts.refresh();
    for (let n = 0; n < 4; n++) { await w.accounts.read(G1, failing, true); w.tick(15 * MINUTE); }
    expect(w.reconnect.mock.calls.map((call) => call[2])).toEqual([reconnectText("gmail", "admin@example.test")]);
    expect(w.reconnect).toHaveBeenCalledWith(G1, "admin@example.test", expect.any(String));
    expect(w.accounts.readState("ca_g1")).toBe("failed");
    expect(await w.accounts.read(G1, async () => "ok", true)).toBe("ok");
    expect(w.state.get().accounts?.ca_g1).toMatchObject({ failures: 0, reconnectShown: false });
    expect(w.accounts.readState("ca_g1")).toBe("ok");
  });

  it("counts a presence-driven failure at most once per check interval per account", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    await w.accounts.refresh();
    await w.accounts.read(G1, failing, true); await w.accounts.read(G1, failing, false); await w.accounts.read(C1, failing, false);
    expect(w.state.get().accounts).toMatchObject({ ca_g1: { failures: 1 }, ca_c1: { failures: 1 } });
    w.tick(CHECK_MS);
    await w.accounts.read(G1, failing, false);
    expect(w.state.get().accounts?.ca_g1).toMatchObject({ failures: 2 });
  });

  it("posts one Reconnect card when an account it saw active is listed but no longer active, and again only after it came back and was lost again", async () => {
    const w = world();
    const expired = { ...G1, active: false };
    for (const listing of [G1, expired, expired, G1, expired]) {
      w.listed = [listing, C1];
      await w.accounts.refresh();
    }
    expect(w.reconnect.mock.calls.map((call) => call[2])).toEqual([disconnectedText("gmail", "admin@example.test"), disconnectedText("gmail", "admin@example.test")]);
  });

  it("posts no lost-connection card for an account whose Reconnect card is already showing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    await w.accounts.refresh();
    for (let n = 0; n < 3; n++) { await w.accounts.read(G1, failing, true); w.tick(CHECK_MS); }
    w.listed = [{ ...G1, active: false }, C1];
    await w.accounts.refresh();
    expect(w.reconnect.mock.calls.map((call) => call[2])).toEqual([reconnectText("gmail", "admin@example.test")]);
  });

  it("forgets an account no longer listed, with no card", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    await w.accounts.refresh();
    await w.accounts.read(G1, failing, true);
    w.listed = [C1];
    await w.accounts.refresh();
    expect(w.state.get().accounts?.ca_g1).toBeUndefined();
    expect(w.reconnect).not.toHaveBeenCalled();
    expect(w.accounts.usable("gmail")).toEqual([]);
    expect(w.accounts.unreadable("gmail")).toEqual([]);
    expect(w.accounts.known()).toEqual(new Set(["ca_c1"]));
    expect(w.accounts.addresses()).toEqual(new Set(["me@example.test"]));
  });

  it("keeps an account that is listed but no longer active: it is named unreadable and keeps its waiting emails, unlike a removed one", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    w.listed = [G1, G2, C1];
    w.addresses.ca_g2 = "other@example.test";
    await w.accounts.refresh();
    const waiting: PendingEmail[] = [
      { account: "ca_g1", messageId: "m1", threadId: "t1", judgedAt: NOW, needsReply: true },
      { account: "ca_g2", messageId: "m2", threadId: "t2", judgedAt: NOW, needsReply: true },
    ];
    w.state.patch({ pendingEmails: waiting });
    w.listed = [{ ...G1, active: false }, C1];
    await w.accounts.refresh();
    expect(w.state.get().accounts).toMatchObject({ ca_g1: { address: "admin@example.test", connectedSeen: false } });
    expect(w.state.get().accounts?.ca_g2).toBeUndefined();
    expect(w.reconnect.mock.calls.map((call) => [call[0].id, call[2]])).toEqual([["ca_g1", disconnectedText("gmail", "admin@example.test")]]);
    expect(w.accounts.usable("gmail")).toEqual([]);
    expect(w.accounts.unreadable("gmail").map((account) => account.id)).toEqual(["ca_g1"]);
    expect(w.accounts.addresses()).toEqual(new Set(["admin@example.test", "me@example.test"]));
    expect(w.state.get().pendingEmails).toEqual(waiting);
    expect(prunePending(waiting, { now: NOW, accounts: w.accounts.known() }).map((entry) => entry.account)).toEqual(["ca_g1"]);
    expect(w.accounts.unreadable("googlecalendar")).toEqual([]);
    await w.accounts.read(C1, failing, true);
    expect(w.accounts.unreadable("googlecalendar").map((account) => account.id)).toEqual(["ca_c1"]);
  });

  it("keeps today's Reconnect wording for an implied account with no address", () => {
    expect(reconnectText("gmail")).toBe(RECONNECT_TEXT.gmail);
    expect(reconnectText("googlecalendar")).toBe(RECONNECT_TEXT.googlecalendar);
    expect(disconnectedText("gmail")).toBe(DISCONNECTED_TEXT.gmail);
    expect(disconnectedText("googlecalendar")).toBe(DISCONNECTED_TEXT.googlecalendar);
  });

  it("names the account in its Reconnect wording", () => {
    expect(reconnectText("gmail", "admin@example.test")).toBe("Reconnect Gmail for admin@example.test: I couldn't read its email three times in a row.");
    expect(reconnectText("googlecalendar", "L")).toBe("Reconnect Calendar for L: I couldn't read its calendar three times in a row.");
    expect(disconnectedText("gmail", "L")).toBe("Reconnect Gmail for L: that Gmail connection stopped working, so I can't read its email.");
    expect(disconnectedText("googlecalendar", "L")).toBe("Reconnect Calendar for L: that Google Calendar connection stopped working, so I can't read its calendar.");
  });

  it("keeps today's lost-connection rule for an implied account, with today's wording", async () => {
    const w = world();
    w.listed = [IMPLIED_GMAIL, C1];
    await w.accounts.refresh();
    expect(w.state.get().accounts?.gmail).toMatchObject({ service: "gmail", implied: true, connectedSeen: true });
    w.listed = [{ ...IMPLIED_GMAIL, active: false }, C1];
    await w.accounts.refresh();
    expect(w.reconnect.mock.calls).toEqual([[{ ...IMPLIED_GMAIL, active: false }, undefined, DISCONNECTED_TEXT.gmail]]);
  });

  it("forgets an implied account once its service lists real accounts, with no card", async () => {
    const w = world();
    w.listed = [IMPLIED_GMAIL, C1];
    await w.accounts.refresh();
    w.listed = [G1, C1];
    await w.accounts.refresh();
    expect(w.state.get().accounts?.gmail).toBeUndefined();
    expect(w.state.get().accounts?.ca_g1).toMatchObject({ connectedSeen: true });
    expect(w.reconnect).not.toHaveBeenCalled();
  });

  it("never posts for an account of a service MausBot may not use, and offers none of its accounts", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world({ mayUse: (service) => service !== "gmail" });
    await w.accounts.refresh(); w.listed = [{ ...G1, active: false }, C1]; await w.accounts.refresh();
    for (let n = 0; n < 3; n++) { await w.accounts.read(G1, failing, true); w.tick(CHECK_MS); }
    expect(w.reconnect).not.toHaveBeenCalled();
    expect(w.accounts.usable("gmail")).toEqual([]);
    expect(w.accounts.unreadable("gmail")).toEqual([]);
    expect(w.address).not.toHaveBeenCalledWith(expect.objectContaining({ id: "ca_g1" }));
    expect(w.state.get().accounts?.ca_g1).toBeUndefined();
  });

  it("offers the accounts last seen connected before the first listing of a run", () => {
    const fresh = world({ seed: { accounts: { ca_g1: { service: "gmail", alias: "work", connectedSeen: true }, ca_g2: { service: "gmail", connectedSeen: false } } } }).accounts;
    expect(fresh.usable("gmail").map((account) => account.id)).toEqual(["ca_g1"]);
    expect(fresh.usable("gmail")[0]).toEqual(G1);
    expect(fresh.unreadable("gmail").map((account) => account.id)).toEqual(["ca_g2"]);
    expect(fresh.listed()).toBe(false);
  });

  it("leaves assistant.json alone when connected apps can't be listed", async () => {
    const w = world({ seed: { accounts: { ca_g1: { service: "gmail", connectedSeen: true } } } });
    w.listed = null;
    const before = w.state.get();
    expect(await w.accounts.refresh()).toBeNull();
    expect(w.state.get()).toBe(before);
    expect(w.accounts.listed()).toBe(false);
    expect(w.accounts.usable("gmail").map((account) => account.id)).toEqual(["ca_g1"]);
  });

  it("stores and compares every address in lower case", async () => {
    const w = world();
    w.addresses.ca_g1 = " Admin@Example.TEST ";
    await w.accounts.refresh();
    expect(w.state.get().accounts?.ca_g1?.address).toBe("admin@example.test");
    expect(w.accounts.address("ca_g1")).toBe("admin@example.test");
    expect(w.accounts.addresses()).toEqual(new Set(["admin@example.test", "me@example.test"]));
  });

  it("ignores an address answer of the wrong shape, and logs a failed address read without counting it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    w.addresses.ca_g1 = "not an address";
    w.addresses.ca_c1 = new SourceError("googlecalendar", "the calendar list did not answer", "ca_c1");
    await w.accounts.refresh();
    expect(w.state.get().accounts?.ca_g1?.address).toBeUndefined();
    expect(w.state.get().accounts?.ca_c1).toMatchObject({ failures: 0 });
    expect(w.state.get().accounts?.ca_c1?.address).toBeUndefined();
    expect(w.accounts.readState("ca_c1")).toBeUndefined();
    expect(w.accounts.label("ca_g1")).toBe("work");
    expect(warn).toHaveBeenCalledTimes(1);
    w.addresses.ca_g1 = "admin@example.test";
    w.addresses.ca_c1 = "me@example.test";
    await w.accounts.refresh();
    expect(w.address).toHaveBeenCalledTimes(4);
    expect(w.accounts.addresses()).toEqual(new Set(["admin@example.test", "me@example.test"]));
  });

  it("flags two accounts of one service that answer with the same address, as a sign the account selection is ignored, and logs it once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    w.listed = [G1, G2, C1];
    w.addresses.ca_g2 = "Admin@Example.test";
    w.addresses.ca_c1 = "admin@example.test";
    await w.accounts.refresh(); await w.accounts.refresh();
    expect(["ca_g1", "ca_g2", "ca_c1"].map((id) => w.accounts.selectionIgnored(id))).toEqual([true, true, false]);
    expect(warn).toHaveBeenCalledTimes(1);
    w.listed = [G1, C1];
    await w.accounts.refresh();
    expect(w.accounts.selectionIgnored("ca_g1")).toBe(false);
  });

  it("trusts the account selection while every account of a service has its own address", async () => {
    const w = world();
    w.listed = [G1, G2, C1];
    w.addresses.ca_g2 = "other@example.test";
    await w.accounts.refresh();
    expect(["ca_g1", "ca_g2", "ca_c1"].map((id) => w.accounts.selectionIgnored(id))).toEqual([false, false, false]);
  });

  it("never saves more account records, or a longer account id, than assistant.json holds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world();
    const many: SourceAccount[] = Array.from({ length: MAX_ACCOUNTS + 2 }, (_, n) => ({ service: "gmail", id: `ca_${n}`, active: true }));
    w.listed = [{ ...G1, id: "c".repeat(MAX_ID_LENGTH + 1) }, ...many];
    const listed = await w.accounts.refresh();
    expect(listed?.map((account) => account.id)).toEqual(many.map((account) => account.id));
    expect(Object.keys(w.state.get().accounts ?? {})).toHaveLength(MAX_ACCOUNTS);
  });
});
