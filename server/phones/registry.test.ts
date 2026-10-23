import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { MAX_PHONES, PHONE_ONLINE_MS, PhoneRegistry, type PhoneRegistration } from "./registry.ts";

const reg = (over: Partial<PhoneRegistration> = {}): PhoneRegistration => ({ installId: "inst-aaaaaaaa", name: "Omkar's iPhone", platform: "ios", appVersion: "1.9.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full", contacts: "limited" }, ...over });

describe("PhoneRegistry", () => {
  let dir: string;
  let file: string;
  let at: number;
  const now = () => at;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omb-phones-")); file = join(dir, "phones.json"); at = 1_000_000; });
  afterEach(async () => { await removeTempDir(dir); });

  it("registers, lists online, and persists across a reload", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", reg());
    const listed = registry.list(null, () => false);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key: "companion:d1", online: true, busy: false, registeredAt: at });
    expect(listed[0]).not.toHaveProperty("owner");
    at += 61_000;
    const reloaded = new PhoneRegistry(file, now);
    expect(reloaded.get("companion:d1")?.owner).toBe("owner");
    const again = reloaded.list(null, () => false);
    expect(again).toHaveLength(1);
    expect(again[0]!.online).toBe(false);
    expect(PHONE_ONLINE_MS).toBe(60_000);
  });

  it("re-registration under a new key replaces the old record", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("session:s1", "owner", reg());
    registry.used("session:s1");
    const first = registry.get("session:s1")!;
    at += 5_000;
    registry.register("session:s2", "owner", reg());
    const listed = registry.list(null, () => false);
    expect(listed.map((phone) => phone.key)).toEqual(["session:s2"]);
    expect(registry.get("session:s1")).toBeUndefined();
    expect(listed[0]).toMatchObject({ registeredAt: first.registeredAt, lastUsedAt: first.lastUsedAt });
  });

  it("keeps another owner's phone with the same installId", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("session:s1", "a", reg());
    registry.register("session:s2", "b", reg());
    expect(registry.list(null, () => false)).toHaveLength(2);
    expect(registry.forOwner("a")).toHaveLength(1);
    expect(registry.list("b", () => false).map((phone) => phone.key)).toEqual(["session:s2"]);
  });

  it("refuses the 21st phone with 409", () => {
    const registry = new PhoneRegistry(file, now);
    for (let i = 0; i < MAX_PHONES; i++) registry.register(`session:s${i}`, `o${i}`, reg({ installId: `inst-${String(i).padStart(8, "0")}` }));
    expect(() => registry.register("session:extra", "x", reg({ installId: "inst-extra000" }))).toThrow(expect.objectContaining({ message: "Too many phones", status: 409 }));
    expect(() => registry.register("session:s0", "o0", reg({ installId: "inst-00000000", name: "renamed" }))).not.toThrow();
  });

  it("marks busy from the callback", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", reg());
    expect(registry.list(null, () => true)[0]!.busy).toBe(true);
    expect(registry.list(null, (key) => key === "other")[0]!.busy).toBe(false);
  });

  it("remove drops the record and the mirror line", () => {
    const registry = new PhoneRegistry(file, now);
    registry.register("companion:d1", "owner", reg());
    expect(registry.remove("companion:d1")).toBe(true);
    expect(registry.remove("companion:d1")).toBe(false);
    expect(registry.get("companion:d1")).toBeUndefined();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, phones: [] });
    expect(new PhoneRegistry(file, now).list(null, () => false)).toEqual([]);
  });
});
