import { describe, expect, it } from "vitest";

import { phoneAccess, phoneSystemPrompt, type PhoneBot } from "./access.ts";

const chief: PhoneBot = { id: "c", name: "Chief of Staff", chiefOfStaff: true };
const scout: PhoneBot = { id: "s", name: "Scout" };
const reader: PhoneBot = { id: "r", name: "Reader", phoneApps: { calendar: "read" } };
const onPhone = { calendar: "full", contacts: "limited" };

describe("phoneAccess", () => {
  it("the Chief gets every app the phone allows, others nothing", () => {
    expect(phoneAccess(chief, onPhone, "PHONE_CREATE_EVENT").ok).toBe(true);
    expect(phoneAccess(scout, onPhone, "PHONE_LIST_EVENTS")).toMatchObject({ ok: false, rows: [{ rule: "scope:phone:calendar:app", decision: "auto-denied" }] });
  });
  it("the phone's grant decides existence", () => {
    expect(phoneAccess(chief, onPhone, "PHONE_LIST_REMINDERS")).toMatchObject({ ok: false, rows: [{ rule: "phone:reminders:not-allowed-on-phone" }] });
    expect(phoneAccess(chief, onPhone, "PHONE_NOPE")).toMatchObject({ ok: false, rows: [{ rule: "phone:unknown" }] });
  });
  it("read grant refuses writes with the scope text", () => {
    const verdict = phoneAccess(reader, onPhone, "PHONE_CREATE_EVENT");
    expect(verdict).toMatchObject({ ok: false, rows: [{ rule: "scope:phone:calendar:write" }] });
    expect(phoneAccess(reader, onPhone, "PHONE_LIST_EVENTS").ok).toBe(true);
  });
  it("the prompt names the phone and its apps", () => {
    expect(phoneSystemPrompt(chief, [{ name: "Omkar's iPhone", platform: "ios", capabilities: onPhone }])).toContain("Omkar's iPhone");
    expect(phoneSystemPrompt(scout, [{ name: "Omkar's iPhone", platform: "ios", capabilities: onPhone }])).toBe("");
  });
});
