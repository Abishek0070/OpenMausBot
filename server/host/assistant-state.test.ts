import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { createAssistantState } from "./assistant-state.ts";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const folder = () => { const dir = mkdtempSync(join(tmpdir(), "omb-assistant-state-")); dirs.push(dir); return dir; };

describe("createAssistantState", () => {
  it("starts empty, keeps what it is given across a reload, and drops a key set to undefined", () => {
    const file = join(folder(), "assistant.json");
    const state = createAssistantState(file);
    expect(state.get()).toEqual({ version: 1 });
    state.patch({ meetings: { m1: { start: 10, fingerprint: "abc", seriesId: "s", preppedAt: 5 } }, judged: ["e1"], lastTodayDate: "2026-10-17", turnDay: "2026-10-17", dayTurns: 2 });
    expect(createAssistantState(file).get()).toMatchObject({ meetings: { m1: { preppedAt: 5 } }, judged: ["e1"], dayTurns: 2 });
    state.patch({ judged: undefined });
    expect(JSON.parse(readFileSync(file, "utf8"))).not.toHaveProperty("judged");
  });

  it("has no room for a subject, a body or a title", () => {
    const state = createAssistantState(join(folder(), "assistant.json"));
    expect(() => state.patch({ meetings: { m1: { start: 1, fingerprint: "x", title: "Board review" } as never } })).toThrow();
    expect(() => state.patch({ judged: [{ id: "e1", subject: "Salaries" }] as never })).toThrow();
    expect(state.get()).toEqual({ version: 1 });
  });

  it("writes the file owner-only and starts fresh from an unreadable or foreign one", () => {
    const dir = folder();
    const file = join(dir, "assistant.json");
    createAssistantState(file).patch({ dayTurns: 1 });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(file, "{nope");
    expect(createAssistantState(file).get()).toEqual({ version: 1 });
    writeFileSync(file, JSON.stringify({ version: 2 }));
    expect(createAssistantState(file).get()).toEqual({ version: 1 });
  });

  it("keeps the change in memory when the disk refuses it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const state = createAssistantState(join(folder(), "missing", "assistant.json"));
    expect(state.patch({ lastTodayDate: "2026-10-17" }).lastTodayDate).toBe("2026-10-17");
    expect(state.get().lastTodayDate).toBe("2026-10-17");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not save"));
  });
});
