import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { createBriefState } from "./brief-state.ts";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });
const file = () => { const dir = mkdtempSync(join(tmpdir(), "omb-brief-state-")); dirs.push(dir); return join(dir, "brief.json"); };

describe("createBriefState", () => {
  it("starts empty, keeps what it is given across a reload, and drops a key set to undefined", () => {
    const path = file();
    const state = createBriefState(path);
    expect(state.get()).toEqual({ version: 1 });
    state.patch({ timeZone: "Asia/Kolkata", lastCard: { at: 5, botId: "chief", threadId: "t1", kind: "recap" } });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 1, timeZone: "Asia/Kolkata", lastCard: { at: 5, botId: "chief", threadId: "t1", kind: "recap" } });
    expect(createBriefState(path).get().lastCard?.threadId).toBe("t1");
    state.patch({ lastCard: undefined });
    expect(createBriefState(path).get()).toEqual({ version: 1, timeZone: "Asia/Kolkata" });
  });

  it("writes the file owner-only", () => {
    if (process.platform === "win32") return;
    const path = file();
    createBriefState(path).patch({ timeZone: "UTC" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("starts fresh from an unreadable or foreign file instead of throwing", () => {
    const path = file();
    writeFileSync(path, "{not json");
    expect(createBriefState(path).get()).toEqual({ version: 1 });
    writeFileSync(path, JSON.stringify({ version: 2, lastCard: "nope" }));
    expect(createBriefState(path).get()).toEqual({ version: 1 });
  });

  it("refuses a value the schema rejects and keeps the previous state", () => {
    const path = file();
    const state = createBriefState(path);
    state.patch({ timeZone: "UTC" });
    expect(() => state.patch({ timeZone: "x".repeat(200) })).toThrow();
    expect(state.get()).toEqual({ version: 1, timeZone: "UTC" });
  });
});
