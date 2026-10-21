// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale, t } from "@/lib/i18n";
import { ConnectorCard } from "./ConnectorCard";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
vi.mock("@/lib/connector-oauth", () => ({
  reserveConnectionPage: () => ({ open: async () => true, cancel: () => {} }),
  reusableConnectionUrl: () => null,
}));

let host: HTMLDivElement;
let root: Root;
const message = {
  id: "c1", role: "bot", kind: "connector", at: 1,
  connector: { slug: "gmail", label: "Gmail", description: "Read mail", status: "connected", resumed: true, resumeKey: "k", addAccount: true },
};
const render = () => flushSync(() => root.render(createElement(ConnectorCard, { botId: "m", threadId: "m-main", message: message as never })));
const button = (name: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes(name))!;
const input = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const click = (el: HTMLElement) => flushSync(() => el.click());
const submit = () => flushSync(() => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
const type = (el: HTMLInputElement, value: string) => flushSync(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});

beforeEach(() => {
  vi.clearAllMocks();
  setLocale("en");
  fixture.api.mockResolvedValue({ url: "https://connect.example.test/auth" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("ConnectorCard Add another account", () => {
  it("asks for a label the way Settings does, and authorizes the new account with it", async () => {
    click(button(t("connectors.card.addAccount")));
    submit();
    expect(host.textContent).toContain(t("connectors.aliasRequired"));
    expect(fixture.api).not.toHaveBeenCalled();
    type(input(t("connectors.aliasAriaAnother", { service: "Gmail" })), "admin");
    submit();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledWith("/api/bots/m/connector-cards/c1/authorize", {
      method: "POST",
      body: JSON.stringify({ threadId: "m-main", alias: "admin" }),
    }));
  });

  it("closes the form and forgets its label once the card leaves connected, so it never reopens with the old label", async () => {
    const at = (status: string) => flushSync(() => root.render(createElement(ConnectorCard, {
      botId: "m", threadId: "m-main", message: { ...message, connector: { ...message.connector, status } } as never,
    })));
    const aliasInput = () => input(t("connectors.aliasAriaAnother", { service: "Gmail" }));
    click(button(t("connectors.card.addAccount")));
    type(aliasInput(), "Work");
    submit();
    await vi.waitFor(() => expect(fixture.api).toHaveBeenCalledTimes(1));
    at("authorizing");
    at("connected");
    expect(aliasInput()).toBeNull();
    await vi.waitFor(() => expect(button(t("connectors.card.addAccount")).disabled).toBe(false));
    click(button(t("connectors.card.addAccount")));
    expect(aliasInput().value).toBe("");
  });
});
