import { readFileSync } from "node:fs";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";

const id = z.string().min(1).max(128);

const cardSchema = z.object({
  at: z.number().finite().nonnegative(),
  botId: id,
  threadId: id,
  kind: z.enum(["recap"]),
}).strict();

export const briefStateSchema = z.object({
  version: z.literal(1),
  /** The IANA zone the owner's device last reported. */
  timeZone: z.string().min(1).max(128).optional(),
  /** The newest recap card the server posted, so a client that was away can open on it. */
  lastCard: cardSchema.optional(),
});

export type BriefState = z.infer<typeof briefStateSchema>;
export type BriefStatePatch = Partial<Omit<BriefState, "version">>;

export interface BriefStateStore {
  get(): BriefState;
  /** A key given as undefined is removed. */
  patch(changes: BriefStatePatch): BriefState;
}

export function createBriefState(file: string): BriefStateStore {
  let state: BriefState = { version: 1 };
  try {
    const parsed = briefStateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`brief: ${file} is not a brief state file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`brief: ${file} is unreadable; starting fresh`);
  }
  return {
    get: () => state,
    patch(changes) {
      const next: Record<string, unknown> = { ...state, ...changes };
      for (const [key, value] of Object.entries(changes)) if (value === undefined) delete next[key];
      const clean = briefStateSchema.parse(next);
      writeFileAtomic(file, JSON.stringify(clean) + "\n", { mode: 0o600 });
      state = clean;
      return state;
    },
  };
}
