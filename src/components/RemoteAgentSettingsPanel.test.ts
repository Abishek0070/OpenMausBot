import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";

vi.mock("@/state/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/state/store")>()),
  useStore: () => ({ dispatch: () => {} }),
}));
vi.mock("@/components/DesktopCapabilities", () => ({
  useCaptionChrome: () => ({ padClass: "", dragProps: {} }),
}));
vi.mock("./VoiceSettings", () => ({ VoiceSettings: () => null }));
vi.mock("./Avatar", () => ({ BotAvatar: () => null }));

import { RemoteAgentSettingsPanel } from "./RemoteAgentSettingsPanel";

const bot = (overrides: Partial<Bot> = {}): Bot => ({
  id: "atlas",
  threadId: "thread-atlas",
  name: "Atlas",
  title: "",
  description: "",
  notifications: true,
  color: "green",
  unread: false,
  modelSelection: { instanceId: "claude", model: "test" },
  messages: [],
  ...overrides,
}) as Bot;

const nameInput = (value: Bot) => {
  const html = renderToStaticMarkup(createElement(RemoteAgentSettingsPanel, { bot: value }));
  const match = html.match(/Name<input[^>]*>/);
  expect(match).not.toBeNull();
  return match![0];
};

describe("RemoteAgentSettingsPanel name", () => {
  it("locks the name for a built-in bot", () => {
    expect(nameInput(bot({ name: "MausBot", builtIn: "mausbot" }))).toMatch(/disabled/);
  });

  it("keeps the name editable for other bots", () => {
    expect(nameInput(bot())).not.toMatch(/disabled/);
  });
});
