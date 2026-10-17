import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("leaves MausBot out of the workspace bot limit", async () => {
  const fixture = await launchVerificationServer({});
  const create = (name: string) => fetch(fixture.info.url + "/api/bots", {
    method: "POST",
    headers: { "content-type": "application/json", origin: fixture.info.url },
    body: JSON.stringify({ name }),
  });
  try {
    const created = await Promise.all(Array.from({ length: 99 }, (_, index) => create(`Plain ${index + 1}`)));
    expect(created.map((response) => response.status)).toEqual(Array(99).fill(201));
    const refused = await create("One too many");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "this workspace is limited to 100 bots" });
    const bots = ((await (await fetch(fixture.info.url + "/api/bots?messages=0", { headers: { origin: fixture.info.url } })).json()) as { bots: Array<{ builtIn?: string }> }).bots;
    expect(bots.filter((bot) => bot.builtIn === undefined)).toHaveLength(100);
    expect(bots.filter((bot) => bot.builtIn === "mausbot")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
}, 60_000);
