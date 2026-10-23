import { describe, expect, it } from "vitest";

import { effectivePhoneApps, nextPhoneApps, phoneAppChips, phoneAppRows, phoneNames, phonePlatformLabel, phoneRemovePath, type PublicPhone } from "./phones";

function phone(name: string, capabilities: PublicPhone["registration"]["capabilities"]): PublicPhone {
  return {
    key: name,
    registration: { installId: name, name, platform: "ios", appVersion: "1", timeZone: "UTC", capabilities },
    registeredAt: 0,
    seen: 0,
    lastUsedAt: null,
    online: true,
    busy: false,
  };
}

describe("phone apps card decisions", () => {
  it("lists six rows and marks none on the phone when no phone is registered", () => {
    const rows = phoneAppRows({}, []);
    expect(rows.map((r) => r.cap)).toEqual(["calendar", "reminders", "contacts", "location", "home", "messages"]);
    expect(rows.every((r) => !r.onPhone && r.grant === null)).toBe(true);
  });

  it("defaults the Chief to every grant and a plain bot to none", () => {
    expect(Object.keys(effectivePhoneApps({ chiefOfStaff: true }))).toHaveLength(6);
    expect(effectivePhoneApps({ chiefOfStaff: true }).home).toBe("write");
    expect(effectivePhoneApps({})).toEqual({});
    expect(effectivePhoneApps({ chiefOfStaff: true, phoneApps: { calendar: "read" } })).toEqual({ calendar: "read" });
  });

  it("flags rows the phone allows", () => {
    const rows = phoneAppRows({ phoneApps: { calendar: "read" } }, [phone("A", { calendar: "granted" })]);
    expect(rows[0]).toEqual({ cap: "calendar", grant: "read", onPhone: true });
    expect(rows[1]!.onPhone).toBe(false);
  });

  it("raises calendar to write keeping the other defaults, and Off deletes the key", () => {
    const raised = nextPhoneApps({ chiefOfStaff: true, phoneApps: { contacts: "read" } }, "calendar", "write");
    expect(raised).toEqual({ contacts: "read", calendar: "write" });
    const chief = nextPhoneApps({ chiefOfStaff: true }, "location", null);
    expect(chief.location).toBeUndefined();
    expect(chief.calendar).toBe("write");
    expect("location" in chief).toBe(false);
  });

  it("joins phone names", () => {
    expect(phoneNames([phone("Pixel", {}), phone("iPhone", {})])).toBe("Pixel, iPhone");
  });
});

describe("phone list helpers", () => {
  it("lists allowed apps in capability order", () => {
    expect(phoneAppChips(phone("P", { messages: "x", calendar: "y", home: "z" }))).toEqual(["calendar", "home", "messages"]);
    expect(phoneAppChips(phone("P", {}))).toEqual([]);
  });

  it("labels platforms", () => {
    expect(phonePlatformLabel("ios")).toBe("iPhone");
    expect(phonePlatformLabel("android")).toBe("Android");
  });

  it("encodes the key in the remove path", () => {
    expect(phoneRemovePath("session:abc")).toBe("/api/phones/session%3Aabc");
    expect(phoneRemovePath("companion:d1")).toBe("/api/phones/companion%3Ad1");
  });
});
