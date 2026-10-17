import { describe, expect, it } from "vitest";

import { MAUS_COLOR_NAMES, MAUS_COLORS, PICKABLE_MAUS_COLOR_NAMES, stateForBot } from "./mascot";

describe("stateForBot", () => {
  it("still alerts on a failed tool call when a digest receipt follows it", () => {
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "digest" },
      ],
    })).toBe("alerting");
  });

  it("keeps reading a pending card as curious behind a receipt", () => {
    expect(stateForBot({ name: "Atlas", messages: [{ kind: "options" }, { kind: "digest" }] })).toBe("curious");
  });

  it("still alerts on a failed tool call when a live call's record follows it", () => {
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "call" },
      ],
    })).toBe("alerting");
    expect(stateForBot({
      name: "Atlas",
      messages: [
        { kind: "activity", tool: { ok: false } },
        { kind: "digest" },
        { kind: "call" },
      ],
    })).toBe("alerting");
  });

  it("keeps reading a pending card as curious behind a live call's record", () => {
    expect(stateForBot({ name: "Atlas", messages: [{ kind: "options" }, { kind: "call" }] })).toBe("curious");
  });
});

describe("MausBot's silver", () => {
  it("is a colour every bot lookup can draw, and not one a person can pick", () => {
    expect(MAUS_COLOR_NAMES).toContain("silver");
    expect(MAUS_COLORS.silver).toBe("#A8ADB4");
    expect(PICKABLE_MAUS_COLOR_NAMES).not.toContain("silver");
    expect([...PICKABLE_MAUS_COLOR_NAMES, "silver"].sort()).toEqual([...MAUS_COLOR_NAMES].sort());
  });
});
