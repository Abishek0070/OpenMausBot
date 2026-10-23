import { describe, expect, it } from "vitest";

import { cloudHomeLendingRefusal, type CloudLendingTurn } from "../cloud-lending.ts";
import { desktopLendingTurn, NOT_THE_OWNER, type DesktopTurn } from "./owner.ts";

const ADMIN = "p_admin", MEMBER = "p_member", ROUTINE = "routine-1", WEBHOOK = "webhook-1";
const said = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "user", ...extra });
const reply = (id: string, extra: Record<string, unknown> = {}) => ({ id, role: "bot", ...extra });
const card = (answeredBy?: { kind: string; person?: string; name?: string }) =>
  reply("c1", { card: { requestId: "q1", answered: "answer", answeredText: "Yes", ...(answeredBy ? { answeredBy } : {}) } });
/** What server/index.ts hands over off a Cloud home: the Cloud test's own owner, which knows nobody here. */
const base = (overrides: Partial<DesktopTurn> = {}): DesktopTurn => ({
  request: { messageId: "m1", generations: new Set(["g1"]) }, generation: "g1", thread: [said("m1"), reply("r1")],
  ownerPerson: () => false, cardAnswerer: (c) => (c.answeredBy?.kind === "session" ? c.answeredBy.person : undefined),
  routineRun: () => null, reportsFromOthers: true, ...overrides,
});
const deps = (overrides: { originIsUser?: boolean; routines?: string[] } = {}) => ({
  adminPersons: () => new Set([ADMIN]), originIsUser: () => overrides.originIsUser ?? true,
  isRealRoutine: (id: string) => (overrides.routines ?? [ROUTINE]).includes(id),
});
const owners = (turn: DesktopTurn, d = deps()) => cloudHomeLendingRefusal(desktopLendingTurn(turn, d)) === null;

describe("whose turn may use the desktop owner's phones", () => {
  it("a line typed at this machine, with no person on it, is the owner's", () => {
    expect(owners(base())).toBe(true);
  });

  it("a live admin session's line is the owner's; a client session's is not", () => {
    expect(owners(base({ thread: [said("m1", { sender: { id: ADMIN } })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1", { sender: { id: MEMBER } })] }))).toBe(false);
    expect(owners(base({ thread: [said("m0", { sender: { id: MEMBER } }), reply("r0"), said("m1")] }))).toBe(false);
    expect(owners(base({ starters: [MEMBER] }))).toBe(false);
    expect(owners(base({ starters: [ADMIN] }))).toBe(true);
  });

  it("a bot's ask is the owner's only as this turn's request, and only while the work it carries came from the user", () => {
    const asked = base({ thread: [said("m1", { peerAsk: { botId: "chief" } })] });
    expect(owners(asked, deps({ originIsUser: true }))).toBe(true);
    expect(owners(asked, deps({ originIsUser: false }))).toBe(false);
    // An earlier ask in the conversation carried work nothing recorded, whatever this turn's origin.
    const earlier = base({ thread: [said("m0", { peerAsk: { botId: "chief" } }), reply("r0"), said("m1")] });
    expect(owners(earlier, deps({ originIsUser: true }))).toBe(false);
    expect(owners(earlier, deps({ originIsUser: false }))).toBe(false);
  });

  it("a card answer is the owner's from this machine or an admin session, never a client session, a worker or an unrecorded session", () => {
    expect(owners(base({ thread: [said("m1"), card({ kind: "loopback" })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1"), card({ kind: "session", name: "Me", person: ADMIN })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1"), card({ kind: "session", name: "Desk", person: MEMBER })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), card({ kind: "worker" })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), card({ kind: "session", name: "Old answer" })] }))).toBe(false);
    // Answered, answerer not written yet: whoever is answering right now decides.
    const inFlight = (who: string | undefined) => base({ thread: [said("m1"), card()], cardAnswerer: () => who });
    expect(owners(inFlight(undefined))).toBe(true);
    expect(owners(inFlight(ADMIN))).toBe(true);
    expect(owners(inFlight(MEMBER))).toBe(false);
    expect(owners(inFlight(NOT_THE_OWNER))).toBe(false);
  });

  it("a webhook's posted payload and an outside event's run report are someone else's words; a real routine's report is the owner's", () => {
    expect(owners(base({ thread: [said("m1"), reply("w1", { webhookPost: true })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { automation: { routineId: WEBHOOK } })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { kind: "routine.run", routineRun: { routineId: WEBHOOK } })] }))).toBe(false);
    expect(owners(base({ thread: [said("m1"), reply("a1", { automation: { routineId: ROUTINE } })] }))).toBe(true);
    expect(owners(base({ thread: [said("m1"), reply("a1", { kind: "routine.run", routineRun: { routineId: ROUTINE } })] }))).toBe(true);
  });

  it("a routine's run is the owner's, started and written, unless a webhook started it", () => {
    const runTurn = (triggerSource: "schedule" | "manual" | "startup" | "webhook") => desktopLendingTurn(base({
      request: { messageId: "m1", generations: new Set(["g1"]), automation: triggerSource },
      routineRun: () => ({ triggerSource, ownerStarted: false, ownerAuthored: false }),
    }), deps());
    for (const trigger of ["schedule", "manual", "startup"] as const) {
      expect(runTurn(trigger).routineRun()).toEqual({ triggerSource: trigger, ownerStarted: true, ownerAuthored: true });
      expect(cloudHomeLendingRefusal(runTurn(trigger))).toBeNull();
    }
    expect(runTurn("webhook").routineRun()).toEqual({ triggerSource: "webhook", ownerStarted: false, ownerAuthored: false });
    expect(cloudHomeLendingRefusal(runTurn("webhook"))).toBe("not-owner");
    const none: CloudLendingTurn = desktopLendingTurn(base(), deps());
    expect(none.routineRun()).toBeNull();
  });
});
