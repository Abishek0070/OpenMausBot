// Whose turn may use the desktop owner's phones, off a Cloud home: the Cloud lending test (server/cloud-lending.ts) with
// the desktop's owner in place of the Cloud owner. The owner is whoever works at this machine or holds an admin session;
// a bot's ask counts only as this turn's own request, and only while the work it carries came from the user; every real
// routine is the owner's, but a webhook's payload and an outside event's run stay someone else's words.
import type { CloudLendingTurn } from "../cloud-lending.ts";

type Line = CloudLendingTurn["thread"][number];
/** The lines as the store keeps them: what they say about where their words came from, beyond the lending test's fields. */
export type DesktopLine = Line & {
  kind?: string;
  webhookPost?: boolean;
  automation?: { routineId?: string };
  routineRun?: { routineId?: string };
};
export type DesktopTurn = Omit<CloudLendingTurn, "thread"> & { thread: readonly DesktopLine[] };

export interface DesktopOwnerDeps {
  /** Person keys of the live admin sessions: the owner's own paired devices. */
  adminPersons(): ReadonlySet<string>;
  /** The harness's record says this turn's work came from the user, not handed on from a webhook or another outside run. */
  originIsUser(): boolean;
  isRealRoutine(id: string): boolean;
}

/** A person no owner test accepts: a bot's ask outside the user's work, a worker's answer, or a session answer with no
 * recorded person. Never a session's person key, which is a hash. */
export const NOT_THE_OWNER = "not-the-owner";

/** The routine a report or run card speaks for; an outside event's run names its trigger, which is no routine. */
const routineOf = (line: DesktopLine): string | undefined =>
  line.automation?.routineId ?? (line.kind === "routine.run" ? line.routineRun?.routineId : undefined);

export function desktopLendingTurn(base: DesktopTurn, deps: DesktopOwnerDeps): CloudLendingTurn {
  let admins: ReadonlySet<string> | undefined;
  const ownerPerson = (person: string | undefined) => person === undefined || (admins ??= deps.adminPersons()).has(person);
  // A bot's ask names no person, so only the work's origin can vouch for it, and only for this turn's own request: an
  // earlier ask in the conversation may have carried another chain's work, which nothing recorded.
  const vouched = deps.originIsUser() ? base.request?.messageId : undefined;
  const thread = base.thread.map((line) =>
    (line.role === "user" && line.peerAsk && line.id !== vouched ? { ...line, peerAsk: undefined, sender: { id: NOT_THE_OWNER } } : line));
  return {
    ...base,
    thread,
    ownerPerson,
    cardAnswerer: (card) => {
      const by = card.answeredBy;
      if (!by) return base.cardAnswerer(card);
      if (by.kind === "loopback") return undefined;
      return by.kind === "session" && by.person ? by.person : NOT_THE_OWNER;
    },
    reportsFromOthers: base.thread.some((line) => {
      if (line.webhookPost === true) return true;
      const routine = routineOf(line);
      return routine !== undefined && !deps.isRealRoutine(routine);
    }),
    routineRun: () => {
      const run = base.routineRun();
      const owners = run !== null && run.triggerSource !== "webhook";
      return run && { ...run, ownerStarted: owners, ownerAuthored: owners };
    },
  };
}
