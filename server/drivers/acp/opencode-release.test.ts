import { describe, expect, it } from "vitest";

import { parseVersionTriple, versionAtLeast } from "./version-probe.ts";
import { OPENCODE_PIN_HISTORY, OPENCODE_STANDALONE, unlistedEarlierPrograms } from "./opencode-release.ts";

const A = "a".repeat(64), B = "b".repeat(64);

// Every OpenCode pin this test has seen, oldest first. Append-only: bumping the pin fails below until the new pin is
// appended here and the one it replaces is recorded in OPENCODE_PIN_HISTORY (with its programs in previousPrograms).
const PINS_SEEN: ReadonlyArray<{ version: string; programs: Record<string, string> }> = [
  { version: "1.19.4", programs: {
    "darwin-arm64": "417af53923f3d529759ab85ce3e8dd09116f742efcd332de591d2da6ebae696b",
    "darwin-x64": "362c45dcd36a16215dce88c6b5232fe230f542c25960f01ba4e4a35588f42de9",
    "linux-x64": "538fcb1b6408c8d4608822acee19f7ff5b3a3eb3383c0633c4f06170857312a7",
    "linux-arm64": "eba0da50d9cc22f2dd062c32e0e7e58d7ece301aa50aabdad1e9dba4ffbf25b4",
    "linux-x64-musl": "ad5ae0ab7b5f0c6fec273648eb91c798fd49ffe0e3f222dcec3ab2d680b132d8",
    "linux-arm64-musl": "2a0cfa6fe7d96ebb89da8d880bd884598d5cdca10e6c3a5b2e63f92c569f1452",
    "win32-x64": "eba9fc042ac622648a66ac5764c5ad41a73244eabcd7a00527d651b7c443efbd",
    "win32-arm64": "92c6c5f6f656e60d6809c029a911ecb578204085945dd2f6e2639981ecab8749",
  } },
];

describe("bumping OpenCode's pin", () => {
  it("is the newest pin this test has seen, so a bump can't skip recording the one it replaces", () => {
    const pinned = { version: OPENCODE_STANDALONE.version, programs: Object.fromEntries(Object.entries(OPENCODE_STANDALONE.assets).map(([key, asset]) => [key, asset.executableSha256])) };
    expect(pinned, "append the new pin to PINS_SEEN in this test").toEqual(PINS_SEEN.at(-1));
  });

  it("records every pin it replaced in OPENCODE_PIN_HISTORY, with the same programs", () => {
    for (const earlier of PINS_SEEN.slice(0, -1)) {
      const recorded = OPENCODE_PIN_HISTORY.find((entry) => entry.version === earlier.version);
      expect(recorded?.programs, `record ${earlier.version} in OPENCODE_PIN_HISTORY`).toEqual(earlier.programs);
    }
  });

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
