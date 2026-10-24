import { describe, expect, it } from "vitest";

import { phoneAccess, phoneSystemPrompt, phoneWithheldPrompt, type PhoneBot } from "./access.ts";

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

  it("a phone named after its kind is not described as itself", () => {
    const text = phoneSystemPrompt(chief, [{ name: "iPhone", platform: "ios", capabilities: onPhone }]);
    expect(text).not.toContain("iPhone is an iPhone");
    expect(text).toContain("The iPhone");
  });

  it("says the USB phone tools are a different phone", () => {
    expect(phoneSystemPrompt(chief, [{ name: "Omkar's iPhone", platform: "ios", capabilities: onPhone }])).toMatch(/USB/);
  });

  it("when this conversation may not use the phone, the bot hears that it exists and how to reach it, not nothing", () => {
    const text = phoneWithheldPrompt(chief, [{ name: "Omkar's iPhone", platform: "ios" }]);
    expect(text).toContain("Omkar's iPhone");
    expect(text).toMatch(/new conversation/);
    expect(text).toMatch(/USB/);
    expect(phoneWithheldPrompt(scout, [{ name: "Omkar's iPhone", platform: "ios" }])).toBe("");
    expect(phoneWithheldPrompt(chief, [])).toBe("");
  });
});
