import { describe, expect, it } from "vitest";

import { isPickableColor, MAUSBOT_COLOR, PICKABLE_MAUS_COLORS } from "./maus-colors.ts";

describe("mascot colours", () => {
  it("offers the ten palette colours and keeps silver for MausBot", () => {
    expect(PICKABLE_MAUS_COLORS).toEqual(["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"]);
    expect(MAUSBOT_COLOR).toBe("silver");
    for (const color of PICKABLE_MAUS_COLORS) expect(isPickableColor(color)).toBe(true);
    for (const value of ["silver", "mauve", "", null, 3, undefined]) expect(isPickableColor(value)).toBe(false);
  });
});
