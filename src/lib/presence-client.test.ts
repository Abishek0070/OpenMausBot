import { describe, expect, it } from "vitest";

import { duePing, openTarget, PRESENCE_MIN_INTERVAL_MS, presenceBody, presenceSkipped } from "./presence-client";

describe("presence client", () => {
  it("sends the device's zone with the desktop source", () => {
    expect(presenceBody("Asia/Kolkata")).toEqual({ source: "desktop", timeZone: "Asia/Kolkata" });
    expect(presenceBody("")).toEqual({ source: "desktop" });
    expect(presenceBody().source).toBe("desktop");
  });

  it("pings once a minute at most, and at once the first time", () => {
    expect(duePing(null, 1_000)).toBe(true);
    expect(duePing(1_000, 1_000 + PRESENCE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(duePing(1_000, 1_000 + PRESENCE_MIN_INTERVAL_MS)).toBe(true);
  });

  it("stays quiet in companion client mode, where the route does not exist yet", () => {
    expect(presenceSkipped(undefined)).toBe(false);
    expect(presenceSkipped({ remoteClient: { active: false } })).toBe(false);
    expect(presenceSkipped({ remoteClient: { active: true } })).toBe(true);
  });

  it("reads only a well-formed open target from the answer", () => {
    expect(openTarget({ ok: true, returned: true, open: { botId: "chief", threadId: "t1" } })).toEqual({ botId: "chief", threadId: "t1" });
    expect(openTarget({ ok: true, returned: false })).toBeNull();
    expect(openTarget({ ok: true, returned: true, open: { botId: 5, threadId: "t1" } })).toBeNull();
    expect(openTarget(null)).toBeNull();
    expect(openTarget("nope")).toBeNull();
  });
});
