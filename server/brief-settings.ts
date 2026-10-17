import { z } from "zod";

export const DEFAULT_BRIEF_AWAY_HOURS = 3;

/** Joined to the `features` group in server/config.ts. */
export const briefSettings = {
  /** Post "Since you last looked" in the Chief's chat when the person returns. On unless false; OMB_BRIEF_RECAP=1 or 0 overrides. */
  briefRecap: z.boolean().optional(),
  /** Hours away before the next activation counts as a return. */
  briefAwayHours: z.number().positive().max(168).optional(),
  /** "MausBot can act on its own": it reads the calendar and the inbox and prepares cards without being asked. On unless false. */
  assistantActs: z.boolean().optional(),
};

export interface BriefFeatureSettings {
  briefRecap?: boolean;
  briefAwayHours?: number;
  assistantActs?: boolean;
}

export function briefRecapEnabled(features: BriefFeatureSettings | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = env.OMB_BRIEF_RECAP?.trim();
  if (override === "1") return true;
  if (override === "0") return false;
  return features?.briefRecap !== false;
}

export function briefAwayMs(features: BriefFeatureSettings | undefined): number {
  const hours = features?.briefAwayHours;
  const chosen = typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_BRIEF_AWAY_HOURS;
  return chosen * 60 * 60_000;
}

export function assistantActsEnabled(features: BriefFeatureSettings | undefined): boolean {
  return features?.assistantActs !== false;
}
