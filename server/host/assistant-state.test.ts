import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { createAssistantState, MAX_ACCOUNTS, MAX_MISSED_LISTINGS, MAX_PENDING_EMAILS } from "./assistant-state.ts";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "omb-assistant-state-")); dirs.push(dir); return dir; };

describe("createAssistantState", () => {
  it("starts empty, keeps what it is given across a reload, and drops a key set to undefined", () => {
    const file = join(folder(), "assistant.json");
    const state = createAssistantState(file);
    expect(state.get()).toEqual({ version: 2 });
    state.patch({ meetings: { m1: { start: 10, fingerprint: "abc", seriesId: "s", preppedAt: 5 } }, lastTriageAt: 7, lastTodayDate: "2026-10-17", turnDay: "2026-10-17", dayTurns: 2 });
    expect(createAssistantState(file).get()).toMatchObject({ meetings: { m1: { preppedAt: 5 } }, lastTriageAt: 7, dayTurns: 2 });
    state.patch({ lastTriageAt: undefined });
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("lastTriageAt");
  });

  it("keeps the email cursor, judged ids and connection record only per account", () => {
    const file = join(folder(), "assistant.json");
    writeFileSync(file, JSON.stringify({ version: 2, emailCursor: 3, judged: ["e1"], failures: { gmail: 1 }, reconnectShown: { gmail: true }, connectedSeen: { gmail: true } }));
    expect(createAssistantState(file).get()).toEqual({ version: 2 });
  });

  it("has no room for a subject, a body or a title", () => {
    const state = createAssistantState(join(folder(), "assistant.json"));
    expect(() => state.patch({ meetings: { m1: { start: 1, fingerprint: "x", title: "Board review" } as never } })).toThrow();
    expect(() => state.patch({ accounts: { g1: { service: "gmail", judged: [{ id: "e1", subject: "Salaries" }] } } as never })).toThrow();
    expect(state.get()).toEqual({ version: 2 });
  });

  it("writes the file owner-only and starts fresh from an unreadable or foreign one", () => {
    const dir = folder();
    const file = join(dir, "assistant.json");
    createAssistantState(file).patch({ dayTurns: 1 });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(file, "{nope");
    expect(createAssistantState(file).get()).toEqual({ version: 2 });
    writeFileSync(file, JSON.stringify({ version: 1, emailCursor: 3 }));
    expect(createAssistantState(file).get()).toEqual({ version: 2 });
  });

  it("keeps the change in memory when the disk refuses it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createAssistantState(join(folder(), "missing", "assistant.json"));
    expect(state.patch({ lastTodayDate: "2026-10-17" }).lastTodayDate).toBe("2026-10-17");
    expect(state.get().lastTodayDate).toBe("2026-10-17");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save"));
  });

  describe("per-account records and pending emails", () => {
    const pending = { account: "ca_g1", messageId: "m1", threadId: "t1", judgedAt: 5, needsReply: true };
    const setup = () => { const file = join(folder(), "assistant.json"); return { file, store: createAssistantState(file) }; };

    it("keeps per-account records and pending emails across a reload", () => {
      const { file, store } = setup();
      store.patch({
        accounts: { ca_g1: { service: "gmail", address: "admin@example.test", emailCursor: 5, judged: ["m1"], failures: 1, connectedSeen: true, implied: true, alias: "work" } },
        pendingEmails: [pending],
        lastBriefDate: "2026-10-21",
        lastBriefAt: 7,
      });
      expect(createAssistantState(file).get()).toMatchObject({ version: 2, accounts: { ca_g1: { address: "admin@example.test", implied: true, alias: "work" } }, pendingEmails: [{ messageId: "m1" }], lastBriefAt: 7 });
    });

    it("has no room for a subject, a sender or a body in an account or a pending email", () => {
      const { store } = setup();
      for (const extra of [{ subject: "Q3" }, { from: "ada@pin.example" }, { body: "x" }]) {
        expect(() => store.patch({ pendingEmails: [{ ...pending, ...extra } as never] })).toThrow();
        expect(() => store.patch({ accounts: { ca_g1: { service: "gmail", ...extra } as never } })).toThrow();
      }
    });

    it("starts fresh from a version 1 file", () => {
      const { file } = setup();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      writeFileSync(file, JSON.stringify({ version: 1, emailCursor: 3 }));
      expect(createAssistantState(file).get()).toEqual({ version: 2 });
    });

    it("holds at most twelve accounts and two hundred pending emails, a bounded address and a bounded count of missed listings", () => {
      const { store } = setup();
      const accounts = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`ca_${n}`, { service: "gmail" as const }]));
      expect(() => store.patch({ accounts: accounts(MAX_ACCOUNTS + 1) })).toThrow();
      expect(store.patch({ accounts: accounts(MAX_ACCOUNTS) }).accounts).toHaveProperty("ca_11");
      expect(() => store.patch({ pendingEmails: Array.from({ length: MAX_PENDING_EMAILS + 1 }, (_, n) => ({ ...pending, messageId: `m${n}` })) })).toThrow();
      expect(() => store.patch({ accounts: { ca_g1: { service: "gmail", address: "a".repeat(321) } } })).toThrow();
      expect(() => store.patch({ accounts: { ca_g1: { service: "gmail", missedListings: MAX_MISSED_LISTINGS + 1 } } })).toThrow();
      expect(store.patch({ accounts: { ca_g1: { service: "gmail", missedListings: MAX_MISSED_LISTINGS } } }).accounts?.ca_g1).toMatchObject({ missedListings: MAX_MISSED_LISTINGS });
    });
  });
});
