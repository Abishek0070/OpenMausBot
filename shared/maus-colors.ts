import type { MausColor } from "./wire.ts";

/** The colours a person, a new bot or an imported bot may have. */
export const PICKABLE_MAUS_COLORS = ["green", "blue", "red", "orange", "purple", "cyan", "pink", "yellow", "teal", "coral"] as const satisfies readonly MausColor[];

export type PickableMausColor = (typeof PICKABLE_MAUS_COLORS)[number];

export const MAUSBOT_COLOR = "silver" satisfies MausColor;

export function isPickableColor(value: unknown): value is PickableMausColor {
  return typeof value === "string" && (PICKABLE_MAUS_COLORS as readonly string[]).includes(value);
}
