import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { createPresence, PRESENCE_FILE, PRESENCE_PERSIST_EVERY_MS } from "./presence.ts";

const HOUR = 60 * 60_000;
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function harness(start = Date.UTC(2026, 9, 15, 8, 0, 0), awayMs = 3 * HOUR) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-presence-"));
  dirs.push(dataDir);
  let now = start;
  const returns: number[] = [];
  const make = (onReturn: (since: number) => void = (since) => returns.push(since)) =>
    createPresence({ dataDir, now: () => now, awayMs: () => awayMs, onReturn });
  return { dataDir, returns, make, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe("createPresence", () => {
  it("counts a return only after the away threshold, once per gap", () => {
    const h = harness();
    const presence = h.make();
    expect(presence.active("desktop")).toEqual({ returned: false });
    h.tick(HOUR);
    expect(presence.active("desktop")).toEqual({ returned: false, previousActiveAt: h.now() - HOUR });
    h.tick(3 * HOUR);
    const back = presence.active("desktop");
    expect(back).toEqual({ returned: true, since: h.now() - 3 * HOUR, previousActiveAt: h.now() - 3 * HOUR });
    expect(h.returns).toEqual([h.now() - 3 * HOUR]);
    expect(presence.active("phone").returned).toBe(false);
    expect(h.returns).toHaveLength(1);
  });

  it("two activations in one moment are one return", () => {
    const h = harness();
    const presence = h.make();
    presence.active("desktop");
    h.tick(5 * HOUR);
    expect(presence.active("desktop").returned).toBe(true);
    expect(presence.active("phone").returned).toBe(false);
    expect(h.returns).toHaveLength(1);
  });

  it("remembers the last activation across a restart, so a night away is a return on the next launch", () => {
    const h = harness();
    h.make().active("desktop");
    expect(JSON.parse(readFileSync(join(h.dataDir, PRESENCE_FILE), "utf8"))).toEqual({ version: 1, lastActiveAt: h.now() });
    h.tick(9 * HOUR);
    const next = h.make();
    expect(next.lastActiveAt()).toBe(h.now() - 9 * HOUR);
    expect(next.active("desktop").returned).toBe(true);
    expect(h.returns).toEqual([h.now() - 9 * HOUR]);
  });

  it("a stored time ahead of the clock is a clock change, not an activation", () => {
    const h = harness();
    writeFileSync(join(h.dataDir, PRESENCE_FILE), JSON.stringify({ version: 1, lastActiveAt: h.now() + 2 * HOUR }));
    const presence = h.make();
    expect(presence.active("desktop")).toEqual({ returned: false, previousActiveAt: h.now() + 2 * HOUR });
    expect(presence.lastActiveAt()).toBe(h.now());
    h.tick(4 * HOUR);
    expect(presence.active("desktop").returned).toBe(true);
  });

  it("ignores an unreadable file and a return handler that throws", () => {
    const h = harness();
    writeFileSync(join(h.dataDir, PRESENCE_FILE), "{");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const presence = h.make(() => { throw new Error("recap exploded"); });
    expect(presence.active("desktop").returned).toBe(false);
    h.tick(4 * HOUR);
    expect(presence.active("desktop").returned).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("recap exploded"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("is unreadable; starting fresh"));
    warn.mockRestore();
    expect(presence.lastActiveAt()).toBe(h.now());
  });

  it("keeps the time in memory on every call but writes the file at most once a minute, and on every return", () => {
    const h = harness();
    const file = join(h.dataDir, PRESENCE_FILE);
    const saved = () => JSON.parse(readFileSync(file, "utf8")).lastActiveAt as number;
    const presence = h.make();
    const first = h.now();
    presence.active("desktop");
    expect(saved()).toBe(first);
    h.tick(10_000);
    presence.active("desktop");
    expect(saved()).toBe(first);
    expect(presence.lastActiveAt()).toBe(h.now());
    h.tick(PRESENCE_PERSIST_EVERY_MS);
    presence.active("desktop");
    expect(saved()).toBe(h.now());
    h.tick(4 * HOUR);
    expect(presence.active("desktop").returned).toBe(true);
    expect(saved()).toBe(h.now());
  });
});
