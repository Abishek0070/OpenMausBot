import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import { createPresenceRoutes } from "./presence.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

const OWNER: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const GUEST: RequestAuth = { kind: "session", scopes: ["client"], via: "bearer", session: {} as never };
const SERVICE: RequestAuth = { kind: "loopback", scopes: ["client"], trust: "service" };

async function serve(auth: RequestAuth, isOwner: (candidate: RequestAuth) => boolean = (candidate) => candidate === OWNER) {
  const deps = { isOwner, active: vi.fn(() => ({ returned: true, open: { botId: "chief", threadId: "t1" } })) };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes([createPresenceRoutes(deps)], { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { deps, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const post = (base: string, body: unknown) => fetch(`${base}/api/presence/active`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("presence route", () => {
  it("records the owner's activation with its zone and answers what to open", async () => {
    const { deps, base } = await serve(OWNER);
    const res = await post(base, { source: "desktop", timeZone: "Asia/Kolkata" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, returned: true, open: { botId: "chief", threadId: "t1" } });
    expect(deps.active).toHaveBeenCalledWith("desktop", "Asia/Kolkata");
  });

  it("drops a zone that is not an IANA name and treats an unknown source as the desktop", async () => {
    const { deps, base } = await serve(OWNER);
    await post(base, { source: "toaster", timeZone: "not a zone!" });
    expect(deps.active).toHaveBeenCalledWith("desktop", undefined);
    await post(base, "not an object");
    expect(deps.active).toHaveBeenLastCalledWith("desktop", undefined);
    await post(base, { source: "phone", timeZone: "UTC" });
    expect(deps.active).toHaveBeenLastCalledWith("phone", "UTC");
  });

  it("drops a zone that looks like an IANA name but is not a real zone", async () => {
    const { deps, base } = await serve(OWNER);
    await post(base, { source: "desktop", timeZone: "Foo/Bar" });
    expect(deps.active).toHaveBeenLastCalledWith("desktop", undefined);
    await post(base, { source: "desktop", timeZone: "America/Los_Angeles" });
    expect(deps.active).toHaveBeenLastCalledWith("desktop", "America/Los_Angeles");
  });

  it("a guest's call changes nothing", async () => {
    const { deps, base } = await serve(GUEST);
    const res = await post(base, { source: "phone" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, returned: false });
    expect(deps.active).not.toHaveBeenCalled();
  });

  it("with the real owner rule, a service-trust loopback caller or a guest changes nothing and the desktop app counts", async () => {
    for (const auth of [SERVICE, GUEST]) {
      const { deps, base } = await serve(auth, ownerOrAdmin);
      const res = await post(base, { source: "desktop", timeZone: "Asia/Kolkata" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, returned: false });
      expect(deps.active).not.toHaveBeenCalled();
    }
    const { deps, base } = await serve(OWNER, ownerOrAdmin);
    expect((await post(base, { source: "desktop" })).status).toBe(200);
    expect(deps.active).toHaveBeenCalledWith("desktop", undefined);
  });

  it("leaves other paths and methods to the next handler", async () => {
    const { deps, base } = await serve(OWNER);
    expect((await fetch(`${base}/api/presence/active`)).status).toBe(404);
    expect((await fetch(`${base}/api/presence/other`, { method: "POST" })).status).toBe(404);
    expect(deps.active).not.toHaveBeenCalled();
  });
});
