// Whose turn may use the desktop owner's phones, off a Cloud home: the Cloud lending test (server/cloud-lending.ts) with
// the desktop's owner in place of the Cloud owner. The owner is whoever works at this machine or holds an admin session;
// a bot's ask counts only as this turn's own request, and only while the work it carries came from the user; a routine's
// run and its reports are the owner's only while the owner wrote it and nobody else has changed it since; a webhook's
// payload and an outside event's run stay someone else's words.
import type { CloudLendingTurn } from "../cloud-lending.ts";
import type { LoopbackTrust } from "../request-auth.ts";

type Line = CloudLendingTurn["thread"][number];
/** The lines as the store keeps them: what they say about where their words came from, beyond the lending test's fields. */
export type DesktopLine = Line & {
  kind?: string;
  webhookPost?: boolean;
  /** An external interface (the Slack worker) relayed it: nobody typed it at this machine or in one of its sessions. */
  relayed?: boolean;
  automation?: { routineId?: string };
  routineRun?: { routineId?: string };
};
export type DesktopTurn = Omit<CloudLendingTurn, "thread"> & { thread: readonly DesktopLine[] };

export interface DesktopOwnerDeps {
  /** Person keys of the live admin sessions: the owner's own paired devices. */
  adminPersons(): ReadonlySet<string>;
  /** The harness's record says this turn's work came from the user, not handed on from a webhook or another outside run. */
  originIsUser(): boolean;
  /** The owner wrote this routine (at this machine or from an admin session) and nobody else has changed it since. */
  ownerWrote(routineId: string): boolean;
}

/** A person no owner test accepts: a bot's ask outside the user's work, a relayed line, a worker's answer, or a session
 * answer with no recorded person. Never a session's person key, which is a hash. */
export const NOT_THE_OWNER = "not-the-owner";

/** One desktop owner exists only where one person uses this server: never where sign-in lets several people in (each
 * admin would reach every admin's phones), and never where a request from this machine is a service, not the owner. */
export function desktopPhonesOffered(server: { sharedMembership: boolean; loopbackTrust: LoopbackTrust }): boolean {
  return !server.sharedMembership && server.loopbackTrust !== "service";
}

/** The routine a report or run card speaks for; an outside event's run names its trigger, which is no routine. */
const routineOf = (line: DesktopLine): string | undefined =>
  line.automation?.routineId ?? (line.kind === "routine.run" ? line.routineRun?.routineId : undefined);

export function desktopLendingTurn(base: DesktopTurn, deps: DesktopOwnerDeps): CloudLendingTurn {
  let admins: ReadonlySet<string> | undefined;
  const ownerPerson = (person: string | undefined) => person === undefined || (admins ??= deps.adminPersons()).has(person);
  // A bot's ask names no person, so only the work's origin can vouch for it, and only for this turn's own request: an
  // earlier ask in the conversation may have carried another chain's work, which nothing recorded.
  const vouched = deps.originIsUser() ? base.request?.messageId : undefined;
  // A relayed line names no person either, and nobody here vouches for it.
  const thread = base.thread.map((line) =>
    (line.role === "user" && (line.relayed === true || (line.peerAsk && line.id !== vouched)) ? { ...line, peerAsk: undefined, sender: { id: NOT_THE_OWNER } } : line));
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
      return routine !== undefined && !deps.ownerWrote(routine);
    }),
    // Written comes from the harness's record of who wrote the routine (server/index.ts). Started: a schedule or a restart
    // starts it on its writer's behalf; by hand, only the owner's own start counts; a webhook never.
    routineRun: () => {
      const run = base.routineRun();
      return run && { ...run, ownerStarted: run.triggerSource === "manual" ? run.ownerStarted : run.triggerSource !== "webhook" };
    },
  };
}
