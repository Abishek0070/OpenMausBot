import { describe, expect, it } from "vitest";

import { PHONE_TOOL_NAMES } from "../../shared/phone-apps.ts";
import { PHONE_TOOLS, phoneToolCallProblem } from "./tools.ts";

describe("phone tools", () => {
  it("lists one schema per tool name and validates arguments", () => {
    expect(PHONE_TOOLS.map((t) => t.name)).toEqual([...PHONE_TOOL_NAMES]);
    expect(phoneToolCallProblem("PHONE_CREATE_EVENT", { title: "Lunch", start: "2026-10-24T12:00:00+05:30", end: "2026-10-24T13:00:00+05:30" })).toBeNull();
    expect(phoneToolCallProblem("PHONE_CREATE_EVENT", { title: "Lunch" })).toMatch(/start/);
    expect(phoneToolCallProblem("PHONE_SEND_MESSAGE", { to: "Rahul", text: "x", extra: 1 })).toMatch(/extra/);
    expect(phoneToolCallProblem("PHONE_NOPE", {})).toMatch(/Unknown phone tool/);
  });
});
