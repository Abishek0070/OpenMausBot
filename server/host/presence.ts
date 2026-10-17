import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "../atomic.ts";

export type PresenceSource = "desktop" | "phone";

export interface PresenceOutcome {
  /** This activation ended an absence of `awayMs` or more. */
  returned: boolean;
  /** When the absence began, on a return. */
  since?: number;
  /** The activation before this one, whatever the gap. */
  previousActiveAt?: number;
}

export interface PresenceDeps {
  dataDir: string;
  now?: () => number;
  awayMs: () => number;
  onReturn: (since: number) => void;
}

export const PRESENCE_FILE = "presence.json";
/** A stored activation this far ahead of the clock means the clock moved back, so it is replaced, not compared. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** The file only has to say whether the person was away for hours, so a stale-by-a-minute time is enough. */
export const PRESENCE_PERSIST_EVERY_MS = 60_000;

function readLastActive(file: string): number | undefined {
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { lastActiveAt?: unknown };
    const at = saved.lastActiveAt;
    if (typeof at === "number" && Number.isFinite(at) && at >= 0) return at;
    console.warn(`presence: ${file} is not a presence file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`presence: ${file} is unreadable; starting fresh`);
  }
  return undefined;
}

export function createPresence(deps: PresenceDeps) {
  const file = join(deps.dataDir, PRESENCE_FILE);
  const now = deps.now ?? Date.now;
  let lastActiveAt = readLastActive(file);
  let persistedAt: number | undefined;

  function persist(): void {
    persistedAt = lastActiveAt;
    try {
      writeFileAtomic(file, JSON.stringify({ version: 1, lastActiveAt }) + "\n", { mode: 0o600, durable: false });
    } catch (error) {
      console.warn(`presence: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    active(_source: PresenceSource): PresenceOutcome {
      const at = now();
      const previous = lastActiveAt;
      lastActiveAt = at;
      if (previous === undefined) {
        persist();
        return { returned: false };
      }
      if (previous > at + CLOCK_SKEW_MS) {
        persist();
        return { returned: false, previousActiveAt: previous };
      }
      const returned = at - previous >= deps.awayMs();
      if (returned || persistedAt === undefined || at - persistedAt >= PRESENCE_PERSIST_EVERY_MS) persist();
      if (returned) {
        try {
          deps.onReturn(previous);
        } catch (error) {
          console.warn(`presence: return handler failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return { returned, ...(returned ? { since: previous } : {}), previousActiveAt: previous };
    },
    lastActiveAt: () => lastActiveAt,
  };
}
