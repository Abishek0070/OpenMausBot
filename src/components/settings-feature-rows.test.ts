import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigStatus } from "@/state/store";
import { AssistantActsRow } from "./settings-feature-rows";
import { Switch } from "./SettingsPrimitives";

const fixture = vi.hoisted(() => ({
  values: [] as unknown[], index: 0,
  config: {} as Pick<ConfigStatus, "features">,
  api: vi.fn(), dispatch: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = fixture.index++;
    if (!(index in fixture.values)) fixture.values[index] = initial;
    return [fixture.values[index], (next: unknown) => { fixture.values[index] = next; }];
  },
}));
vi.mock("@/state/store", () => ({
  api: fixture.api,
  useStore: () => ({ state: { config: fixture.config }, dispatch: fixture.dispatch }),
}));

type Node = ReactElement<Record<string, unknown> & { children?: ReactNode }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render(Row: () => ReactNode) {
  let tree: ReactNode = null;
  function Capture() {
    fixture.index = 0;
    const row = Row() as Node;
    tree = (row.type as (props: Node["props"]) => ReactNode)(row.props);
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, toggle: nodes(tree).find((node) => node.type === Switch)! };
}
const click = (node: Node) => (node.props.onClick as () => void)();
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => {
  fixture.values = [];
  fixture.config = {};
  fixture.api.mockReset();
  fixture.dispatch.mockReset();
});

describe("AssistantActsRow", () => {
  it("shows MausBot acting on its own until the server says it may not", () => {
    expect(render(AssistantActsRow).toggle.props.checked).toBe(true);
    fixture.config = { features: { skillAuthoring: true, assistantActs: false } };
    expect(render(AssistantActsRow).toggle.props.checked).toBe(false);
  });

  it("saves the opposite setting and shows the config the server returns", async () => {
    const saved = { features: { skillAuthoring: true, assistantActs: false } };
    fixture.api.mockResolvedValue(saved);
    click(render(AssistantActsRow).toggle);
    await flush();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", { method: "PATCH", body: JSON.stringify({ features: { assistantActs: false } }) });
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: saved });
  });

  it("keeps the switch and says why when the save fails", async () => {
    fixture.api.mockRejectedValue(new Error("Disk is full"));
    click(render(AssistantActsRow).toggle);
    await flush();
    const after = render(AssistantActsRow);
    expect(after.html).toContain("Disk is full");
    expect(after.toggle.props.checked).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});
