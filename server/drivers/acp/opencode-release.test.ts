import { describe, expect, it } from "vitest";

import { parseVersionTriple, versionAtLeast } from "./version-probe.ts";
import { OPENCODE_PIN_HISTORY, OPENCODE_STANDALONE, unlistedEarlierPrograms } from "./opencode-release.ts";

const A = "a".repeat(64), B = "b".repeat(64);

describe("bumping OpenCode's pin", () => {
  it("lists every earlier pin's program for every platform, so the copies installed from it keep running", () => {
    expect(unlistedEarlierPrograms(OPENCODE_STANDALONE, OPENCODE_PIN_HISTORY)).toEqual([]);
  });

  it("names an earlier pin whose program is missing from previousPrograms, or was never recorded", () => {
    const platforms = Object.keys(OPENCODE_STANDALONE.assets);
    const history = [{ version: "1.0.0", programs: Object.fromEntries(platforms.map((key) => [key, key === "linux-x64" ? B : A])) }];
    const listed = { ...OPENCODE_STANDALONE, previousPrograms: Object.fromEntries(platforms.map((key) => [key, [A]])) };
    expect(unlistedEarlierPrograms(listed, history)).toEqual(["1.0.0 linux-x64"]);
    const unrecorded = [{ version: "1.0.0", programs: { "darwin-arm64": A } }];
    expect(unlistedEarlierPrograms(listed, unrecorded)).toEqual(platforms.filter((key) => key !== "darwin-arm64").map((key) => `1.0.0 ${key} (no hash recorded)`));
  });

  it("keeps only earlier versions in the history", () => {
    const pinned = parseVersionTriple(OPENCODE_STANDALONE.version)!;
    for (const earlier of OPENCODE_PIN_HISTORY) expect(versionAtLeast(parseVersionTriple(earlier.version)!, pinned)).toBe(false);
  });
});
