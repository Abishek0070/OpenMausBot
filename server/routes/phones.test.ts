import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { PhoneJobs } from "../phones/jobs.ts";
import { PhoneRegistry } from "../phones/registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { createPhoneRoutes } from "./phones.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(dirs.splice(0).map(removeTempDir));
});

const ADMIN: RequestAuth = { kind: "loopback", scopes: ["admin", "client"] };
const clientSession = (id: string): RequestAuth => ({
  kind: "session", via: "bearer", scopes: ["client"],
  session: { id, cookieOnly: false } as unknown as Extract<RequestAuth, { kind: "session" }>["session"],
});
const registration = {
  installId: "install-0001", name: "Maus's iPhone", platform: "ios", appVersion: "1.5.0", timeZone: "Asia/Kolkata", capabilities: { calendar: "full" },
};
const fromPhone = (device = "d1") => ({ "x-openmausbot-companion": "1", "x-openmausbot-companion-device": device });

async function setup(options: { auth?: RequestAuth; owner?: () => string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "phones-routes-"));
  dirs.push(dir);
  const registry = new PhoneRegistry(join(dir, "phones.json"));
  const jobs = new PhoneJobs();
  const auth = options.auth ?? ADMIN;
  const routes = [createPhoneRoutes({
    registry, jobs, owner: options.owner ?? (() => "owner"), isAdmin: (a) => a.scopes.includes("admin"),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      // index.ts turns an error carrying a status into JSON.
      json(res, (error as { status?: number }).status ?? 500, { error: (error as Error).message });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { registry, jobs, call };
}

describe("phone routes", () => {
  it("a loopback request without the companion marker has no phone key", async () => {
    const { call } = await setup();
    const out = await call("PUT", "/api/phones/self", registration, { "x-openmausbot-companion-device": "d1" });
    expect(out.status).toBe(403);
    expect(out.body.error).toBe("Only a paired phone can register its apps, and only for itself.");
  });

  it("registers from the companion header and lists for the owner", async () => {
    const { call } = await setup();
    const put = await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    expect(put.status).toBe(200);
    expect(put.body.phone.key).toBe("companion:d1");
    expect((await call("GET", "/api/phones/self", undefined, fromPhone("d1"))).body.phone.key).toBe("companion:d1");
    const list = await call("GET", "/api/phones");
    expect(list.status).toBe(200);
    expect(list.body.phones).toHaveLength(1);
    expect((await call("PUT", "/api/phones/self", { nope: 1 }, fromPhone("d1"))).status).toBe(400);
  });

  it("a client session registers under its session id", async () => {
    const { call, registry } = await setup({ auth: clientSession("s1") });
    const put = await call("PUT", "/api/phones/self", registration);
    expect(put.status).toBe(200);
    expect(put.body.phone.key).toBe("session:s1");
    expect(registry.get("session:s1")).toBeDefined();
    expect((await call("DELETE", "/api/phones/self")).body).toEqual({ removed: true });
  });

  it("long-polls a job, leases and answers it", async () => {
    const { call, jobs } = await setup();
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const outcome = jobs.request("companion:d1", "PHONE_LIST_EVENTS", { days: 1 }, { active: () => true, timeoutMs: 10_000, offlineText: "offline", online: () => true });
    const polled = await call("GET", "/api/phones/self/jobs", undefined, fromPhone("d1"));
    expect(polled.status).toBe(200);
    expect(polled.body.job.tool).toBe("PHONE_LIST_EVENTS");
    const id = polled.body.job.id as string;
    expect((await call("POST", `/api/phones/self/jobs/${id}/lease`, {}, fromPhone("d1"))).body).toEqual({ active: true });
    expect((await call("POST", `/api/phones/self/jobs/${id}/result`, { ok: true, result: { events: [] } }, fromPhone("d1"))).body).toEqual({ ok: true });
    expect(await outcome).toEqual({ ok: true, result: { events: [] } });
  });

  it("refuses a result for an unknown job with 409", async () => {
    const { call } = await setup();
    await call("PUT", "/api/phones/self", registration, fromPhone("d1"));
    const out = await call("POST", "/api/phones/self/jobs/nope/result", { ok: true, result: 1 }, fromPhone("d1"));
    expect(out.status).toBe(409);
    expect((await call("POST", "/api/phones/self/jobs/nope/result", { bad: true }, fromPhone("d1"))).status).toBe(400);
  });

  it("GET /api/phones needs an admin", async () => {
    const { call } = await setup({ auth: clientSession("s1") });
    expect((await call("GET", "/api/phones")).status).toBe(403);
  });

  it("a team Cloud offers no phones", async () => {
    const { call } = await setup({ owner: () => null });
    expect((await call("PUT", "/api/phones/self", registration, fromPhone("d1"))).status).toBe(403);
  });
});
