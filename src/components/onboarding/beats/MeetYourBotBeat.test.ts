import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Bot } from "@/state/store";
import { MeetYourBotBeat } from "./MeetYourBotBeat";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas", threadId: "thread-atlas", name: "Atlas", title: "", description: "", notifications: true,
  color: "green", unread: false, modelSelection: { instanceId: "claude", model: "test" }, messages: [], ...overrides,
}) as Bot;

const nameInput = (value: Bot) => {
  const html = renderToStaticMarkup(createElement(MeetYourBotBeat, { bot: value, onFinish: () => {}, setMascot: () => {}, bump: () => {} }));
  const match = html.match(/<input[^>]*id="welcome-bot-name"[^>]*>/);
  expect(match).not.toBeNull();
  return match![0];
};

describe("MeetYourBotBeat name", () => {
  it("locks the name for a built-in bot", () => {
    expect(nameInput(bot({ name: "MausBot", builtIn: "mausbot" }))).toMatch(/disabled/);
  });
  it("keeps the name editable for other bots", () => {
    expect(nameInput(bot())).not.toMatch(/disabled/);
  });
});
