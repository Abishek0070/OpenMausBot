import { describe, expect, it, vi } from "vitest";

import type { RequestAuth } from "../request-auth.ts";
import type { Message } from "../store.ts";
import { createQuotaSwitchHost, type HarnessCard, type QuotaSwitchHostDeps } from "./quota-switch.ts";

const owner: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };

function host(harnessCards: HarnessCard[]) {
  const card = { id: "m1", at: 1, role: "bot", kind: "options", card: { title: "Make me your Chief of Staff?", subtitle: "", options: ["Yes", "Not now"], requestId: "rq1" } } as Message;
  const store = { messagesFor: (threadId: string) => (threadId === "t1" ? [card] : []), botByThread: () => null, patchMessage: vi.fn() };
  return createQuotaSwitchHost({ store, harnessCards } as unknown as QuotaSwitchHostDeps);
}

describe("harnessCardOutcome", () => {
  it("asks the host modules' cards in order with the presser's auth, and the first answer wins", async () => {
    const notMine = vi.fn<HarnessCard>(() => undefined);
    const mine = vi.fn<HarnessCard>(() => "answered");
    const later = vi.fn<HarnessCard>(() => "rejected");
    const { harnessCardOutcome } = host([notMine, mine, later]);
    await expect(harnessCardOutcome("t1", "rq1", "answer", "Yes", owner)).resolves.toBe("answered");
    expect(notMine).toHaveBeenCalledWith("t1", "rq1", "answer", "Yes", owner);
    expect(mine).toHaveBeenCalledWith("t1", "rq1", "answer", "Yes", owner);
    expect(later).not.toHaveBeenCalled();
  });

  it("never asks about a card the thread does not hold, and falls through when no module owns it", async () => {
    const mine = vi.fn<HarnessCard>(() => "answered");
    await expect(host([mine]).harnessCardOutcome("t1", "elsewhere", "answer", "Yes", owner)).resolves.toBeUndefined();
    await expect(host([mine]).harnessCardOutcome("t2", "rq1", "answer", "Yes", owner)).resolves.toBeUndefined();
    expect(mine).not.toHaveBeenCalled();
    await expect(host([() => undefined]).harnessCardOutcome("t1", "rq1", "answer", "Yes", owner)).resolves.toBeUndefined();
  });
});
