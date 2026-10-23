import { afterEach, describe, expect, it, vi } from "vitest";

import { PHONE_RESULT_MAX_BYTES, PhoneJobs } from "./jobs.ts";

afterEach(() => vi.useRealTimers());
const KEY = "phone-key";
const turn = (extra: Partial<{ active: () => boolean; timeoutMs: number; online: () => boolean; background: boolean }> = {}) =>
  ({ active: () => true, timeoutMs: 45_000, offlineText: "Phone is offline.", online: () => true, ...extra });

describe("phone jobs", () => {
  it("delivers one job to the poll, leases it and returns the result", async () => {
    const jobs = new PhoneJobs();
    const outcome = jobs.request(KEY, "PHONE_LIST_EVENTS", { days: 3 }, turn());
    const job = await jobs.poll(KEY);
    expect(job).toMatchObject({ tool: "PHONE_LIST_EVENTS", arguments: { days: 3 } });
    expect(typeof job!.expiresAt).toBe("number");
    expect(jobs.busy(KEY)).toBe(true);
    expect(jobs.lease(KEY, job!.id)).toBe(true);
    jobs.complete(KEY, job!.id, { ok: true, result: { events: [] } });
    await expect(outcome).resolves.toEqual({ ok: true, result: { events: [] } });
    expect(jobs.busy(KEY)).toBe(false);
  });

  it("re-delivers a job that was polled but never leased after 10 s", async () => {
    vi.useFakeTimers();
    const jobs = new PhoneJobs();
    const outcome = jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn());
    const first = await jobs.poll(KEY);
    await vi.advanceTimersByTimeAsync(10_000);
    const second = await jobs.poll(KEY);
    expect(second?.tool).toBe("PHONE_LIST_EVENTS");
    expect(second!.id).not.toBe(first!.id);
    expect(() => jobs.complete(KEY, first!.id, { ok: true, result: 1 })).toThrow(/expired/);
    jobs.lease(KEY, second!.id);
    jobs.complete(KEY, second!.id, { ok: true, result: 1 });
    await expect(outcome).resolves.toEqual({ ok: true, result: 1 });
  });

  it("answers the offline sentence when nobody polls", async () => {
    vi.useFakeTimers();
    const jobs = new PhoneJobs();
    const outcome = jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn({ online: () => false }));
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(outcome).resolves.toEqual({ ok: false, code: "offline", error: "Phone is offline." });
    expect(jobs.busy(KEY)).toBe(false);
  });

  it("a late result is refused", async () => {
    vi.useFakeTimers();
    const jobs = new PhoneJobs();
    const outcome = jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn());
    const job = await jobs.poll(KEY);
    jobs.lease(KEY, job!.id);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(outcome).resolves.toEqual({ ok: false, code: "timeout",
      error: "PHONE_LIST_EVENTS did not finish on the phone within 45 seconds. It may still have run; check before repeating." });
    expect(() => jobs.complete(KEY, job!.id, { ok: true, result: 1 })).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => jobs.complete(KEY, "nope", { ok: true, result: 1 })).toThrow(/This job expired; it will not be replayed\./);
  });

  it("runs one job at a time per phone and nudges on queue", async () => {
    const onQueued = vi.fn();
    const jobs = new PhoneJobs(onQueued);
    const first = jobs.request(KEY, "PHONE_LIST_EVENTS", { n: 1 }, turn());
    const second = jobs.request(KEY, "PHONE_LIST_EVENTS", { n: 2 }, turn());
    expect(onQueued).toHaveBeenCalledTimes(1);
    const a = await jobs.poll(KEY);
    expect(a?.arguments).toEqual({ n: 1 });
    expect(onQueued).toHaveBeenCalledWith(KEY, a!.id);
    expect(onQueued).toHaveBeenCalledTimes(1);
    jobs.lease(KEY, a!.id);
    jobs.complete(KEY, a!.id, { ok: true, result: "one" });
    await expect(first).resolves.toEqual({ ok: true, result: "one" });
    expect(onQueued).toHaveBeenCalledTimes(2);
    const b = await jobs.poll(KEY);
    expect(b?.arguments).toEqual({ n: 2 });
    expect(onQueued).toHaveBeenLastCalledWith(KEY, b!.id);
    jobs.lease(KEY, b!.id);
    jobs.complete(KEY, b!.id, { ok: true, result: "two" });
    await expect(second).resolves.toEqual({ ok: true, result: "two" });
  });

  it("truncates nothing: an oversized result becomes too_large", async () => {
    const jobs = new PhoneJobs();
    const outcome = jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn());
    const job = await jobs.poll(KEY);
    jobs.lease(KEY, job!.id);
    const big = "x".repeat(300_000);
    expect(JSON.stringify(big).length).toBeGreaterThan(PHONE_RESULT_MAX_BYTES);
    jobs.complete(KEY, job!.id, { ok: true, result: big });
    await expect(outcome).resolves.toEqual({ ok: false, code: "too_large", error: "The phone's answer was over 256 KB; ask for a narrower range." });
  });

  it("close fails every waiting request as offline", async () => {
    const jobs = new PhoneJobs();
    const queued = jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn());
    const delivered = jobs.request("other", "PHONE_LIST_EVENTS", {}, turn());
    await jobs.poll("other");
    jobs.close();
    const text = "This server is restarting. Phone jobs resume by themselves once it is back.";
    await expect(queued).resolves.toEqual({ ok: false, code: "offline", error: text });
    await expect(delivered).resolves.toEqual({ ok: false, code: "offline", error: text });
  });

  it("in-turn jobs go first and a background job survives its turn ending", async () => {
    vi.useFakeTimers();
    const jobs = new PhoneJobs();
    const background = jobs.request(KEY, "PHONE_LIST_EVENTS", { who: "bg" }, turn({ background: true, active: () => false, timeoutMs: 900_000 }));
    const inTurn = jobs.request(KEY, "PHONE_LIST_EVENTS", { who: "turn" }, turn());
    const settled = vi.fn();
    void background.then(settled);
    const first = await jobs.poll(KEY);
    expect(first?.arguments).toEqual({ who: "turn" });
    jobs.lease(KEY, first!.id);
    jobs.complete(KEY, first!.id, { ok: true, result: 1 });
    await expect(inTurn).resolves.toEqual({ ok: true, result: 1 });
    const second = await jobs.poll(KEY);
    expect(second?.arguments).toEqual({ who: "bg" });
    expect(jobs.lease(KEY, second!.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(settled).not.toHaveBeenCalled();
    jobs.complete(KEY, second!.id, { ok: true, result: 2 });
    await expect(background).resolves.toEqual({ ok: true, result: 2 });
  });

  it("an in-turn job queued behind another times out on its own clock", async () => {
    vi.useFakeTimers();
    const jobs = new PhoneJobs();
    void jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn({ timeoutMs: 100_000 }));
    const second = jobs.request(KEY, "PHONE_LIST_EVENTS", {}, turn());
    await jobs.poll(KEY);
    await vi.advanceTimersByTimeAsync(45_000);
    await expect(second).resolves.toMatchObject({ ok: false, code: "timeout" });
    jobs.close();
  });

  it("a background write is refused as unsupported", async () => {
    const jobs = new PhoneJobs();
    const outcome = await jobs.request(KEY, "PHONE_CREATE_EVENT", {}, turn({ background: true }));
    expect(outcome).toEqual({ ok: false, code: "unsupported", error: "Background checks only read the phone." });
    expect(jobs.busy(KEY)).toBe(false);
    expect(jobs.polling(KEY)).toBe(false);
  });
});
