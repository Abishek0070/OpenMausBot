import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RenameTitle } from "./RenameTitle";

describe("RenameTitle", () => {
  it("does not expose an inert profile button when onActivate is absent", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Maus",
      onCommit: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).not.toContain("Open Maus&#x27;s profile");
    expect(markup).toContain('aria-label="Rename Maus"');
  });

  it("exposes the profile button when onActivate is provided", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Maus",
      onCommit: vi.fn(),
      onActivate: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).toContain("Open Maus&#x27;s profile");
  });

  it("draws a locked title as plain text with no rename control", () => {
    for (const showEditButton of [false, true]) {
      const markup = renderToStaticMarkup(createElement(RenameTitle, { value: "MausBot", onCommit: vi.fn(), locked: true, showEditButton }));
      expect(markup).toContain("MausBot");
      expect(markup).not.toContain("Rename MausBot");
      expect(markup).not.toContain("<button");
    }
  });
});
