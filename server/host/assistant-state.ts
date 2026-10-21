import { readFileSync } from "node:fs";
import { z } from "zod";

import { ASSISTANT_SERVICES } from "../assistant-sources.ts";
import { writeFileAtomic } from "../atomic.ts";
import { failure } from "../failure.ts";

export const ASSISTANT_STATE_FILE = "assistant.json";
export const MAX_JUDGED = 500;
export const MAX_IN_FLIGHT = 100;
export const MAX_WORK_THREADS = 1_000;
export const MAX_ID_LENGTH = 256;
export const MAX_ACCOUNTS = 12;
export const MAX_PENDING_EMAILS = 200;
export const MAX_ADDRESS_LENGTH = 320;

const at = z.number().finite().nonnegative();
const id = z.string().min(1).max(MAX_ID_LENGTH);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const item = z.string().min(1).max(8_000);

const meetingSchema = z.object({
  start: at,
  fingerprint: z.string().max(64),
  seriesId: id.optional(),
  prepStartedAt: at.optional(),
  preppedAt: at.optional(),
  /** Prepared through an earlier occurrence of the same series, so it has no prep card of its own. */
  repeat: z.boolean().optional(),
  failedAt: at.optional(),
  remindedAt: at.optional(),
  cancelledAt: at.optional(),
  updateStartedAt: at.optional(),
  updateFailedAt: at.optional(),
}).strict();

const accountRecordSchema = z.object({
  service: z.enum(ASSISTANT_SERVICES),
  address: z.string().min(1).max(MAX_ADDRESS_LENGTH).optional(),
  alias: z.string().min(1).max(MAX_ID_LENGTH).optional(),
  /** The service was reported connected without a list of accounts, so the account is the service itself. */
  implied: z.boolean().optional(),
  emailCursor: at.optional(),
  judged: z.array(id).max(MAX_JUDGED).optional(),
  failures: z.number().int().min(0).optional(),
  reconnectShown: z.boolean().optional(),
  connectedSeen: z.boolean().optional(),
}).strict();

const pendingEmailSchema = z.object({ account: id, messageId: id, threadId: id, judgedAt: at, needsReply: z.boolean() }).strict();

const perService = <T extends z.ZodType>(value: T) => z.object({ gmail: value.optional(), googlecalendar: value.optional() }).strict();

export const assistantStateSchema = z.object({
  version: z.literal(2),
  accounts: z.record(id, accountRecordSchema).refine((accounts) => Object.keys(accounts).length <= MAX_ACCOUNTS).optional(),
  pendingEmails: z.array(pendingEmailSchema).max(MAX_PENDING_EMAILS).optional(),
  lastBriefDate: day.optional(),
  lastBriefAt: at.optional(),
  meetings: z.record(id, meetingSchema).optional(),
  /** Gmail is asked for mail after this time on the next check. */
  emailCursor: at.optional(),
  /** Gmail message ids already judged, newest last. */
  judged: z.array(id).max(MAX_JUDGED).optional(),
  lastTriageAt: at.optional(),
  lastTodayDate: day.optional(),
  turnDay: day.optional(),
  dayTurns: z.number().int().min(0).optional(),
  failures: perService(z.number().int().min(0)).optional(),
  reconnectShown: perService(z.boolean()).optional(),
  /** Seen connected since its last Reconnect card for a lost connection. */
  connectedSeen: perService(z.boolean()).optional(),
  notices: z.object({ noWebSearch: z.boolean().optional(), noConnectorTools: z.boolean().optional() }).strict().optional(),
  /** AI jobs started and not finished; after a restart each becomes one error card with Retry. */
  inFlight: z.array(z.object({ item, at }).strict()).max(MAX_IN_FLIGHT).optional(),
  retryCards: z.record(id, z.object({ item, threadId: id, messageId: id, outcome: z.enum(["answered", "rejected", "unavailable"]).optional() }).strict()).optional(),
  /** Hidden job threads, deleted a day after they started. */
  workThreads: z.array(z.object({ threadId: id, at }).strict()).max(MAX_WORK_THREADS).optional(),
});

export type AssistantState = z.infer<typeof assistantStateSchema>;
export type AccountRecord = z.infer<typeof accountRecordSchema>;
export type PendingEmail = z.infer<typeof pendingEmailSchema>;
export type MeetingRecord = z.infer<typeof meetingSchema>;
export type AssistantStatePatch = Partial<Omit<AssistantState, "version">>;

export interface AssistantStateStore {
  get(): AssistantState;
  /** A key given as undefined is removed. */
  patch(changes: AssistantStatePatch): AssistantState;
}

export function createAssistantState(file: string): AssistantStateStore {
  let state: AssistantState = { version: 2 };
  try {
    const parsed = assistantStateSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) state = parsed.data;
    else console.warn(`assistant: ${file} is not an assistant state file; starting fresh`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`assistant: ${file} is unreadable; starting fresh`);
  }
  return {
    get: () => state,
    patch(changes) {
      const next: Record<string, unknown> = { ...state, ...changes };
      for (const [key, value] of Object.entries(changes)) if (value === undefined) delete next[key];
      state = assistantStateSchema.parse(next);
      try {
        writeFileAtomic(file, JSON.stringify(state) + "\n", { mode: 0o600 });
      } catch (error) {
        console.warn(`assistant: could not save ${file}: ${failure(error)}`);
      }
      return state;
    },
  };
}
