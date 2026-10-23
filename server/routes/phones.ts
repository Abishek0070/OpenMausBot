// /api/phones: a paired phone offering its own apps (calendar, contacts, ...) to this server's bots. The phone is known by
// what authenticated it (a Cloud session, or the companion sidecar's device header), never by anything in the body.
import type { IncomingMessage } from "node:http";

import { phoneJobOutcome, type PhoneJobs } from "../phones/jobs.ts";
import { phoneRegistration, type PhoneRegistry } from "../phones/registry.ts";
import type { RequestAuth } from "../request-auth.ts";
import { responseGone } from "../shared-computers.ts";
import { PASS, type RouteContext, type RouteHandler } from "./table.ts";

const DEVICE_ID = /^[\w-]{1,128}$/;
const SELF_ONLY = "Only a paired phone can register its apps, and only for itself.";

/** Keyed by what authenticated the request, never by the body: a Cloud session, or the sidecar's device header. */
export function phoneKey(req: IncomingMessage, auth: RequestAuth): string | null {
  if (auth.kind === "session" && !auth.session.cookieOnly) return `session:${auth.session.id}`;
  if (req.headers["x-openmausbot-companion"] !== "1") return null;
  const device = req.headers["x-openmausbot-companion-device"];
  return typeof device === "string" && DEVICE_ID.test(device) ? `companion:${device}` : null;
}

/** Long polls are held open on purpose; Task 10's idle-timeout exemption asks this. */
export function isLongPollPath(path: string): boolean {
  return path.startsWith("/api/shared-computers/") || path === "/api/phones/self/jobs";
}

export interface PhoneRouteDeps {
  registry: PhoneRegistry;
  jobs: PhoneJobs;
  /** The owner this phone belongs to, or null when phones are not offered here (team Cloud, hosted workspace, guest session). */
  owner: (auth: RequestAuth) => string | null;
  isAdmin: (auth: RequestAuth) => boolean;
}

export function createPhoneRoutes(deps: PhoneRouteDeps): RouteHandler {
  const { registry, jobs } = deps;
  return async ({ req, res, path, method, auth, json, readBody }: RouteContext): Promise<typeof PASS | void> => {
    if (path !== "/api/phones" && !path.startsWith("/api/phones/")) return PASS;
    res.setHeader("Cache-Control", "no-store");

    if (path === "/api/phones" && method === "GET") {
      if (!deps.isAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can list phones." });
      return json(res, 200, { phones: registry.list(deps.owner(auth), (key) => jobs.busy(key)) });
    }

    if (path === "/api/phones/self" || path.startsWith("/api/phones/self/")) {
      const key = phoneKey(req, auth);
      const owner = deps.owner(auth);
      if (!key || !owner) return json(res, 403, { error: SELF_ONLY });
      registry.seen(key);
      if (path === "/api/phones/self") {
        if (method === "PUT") {
          if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
          const parsed = phoneRegistration.safeParse(await readBody(req, 16_384));
          if (!parsed.success) return json(res, 400, { error: "Invalid phone registration" });
          registry.register(key, owner, parsed.data);
          const [phone] = registry.list(owner, (k) => jobs.busy(k)).filter((p) => p.key === key);
          return json(res, 200, { phone });
        }
        if (method === "GET") return json(res, 200, { phone: registry.list(owner, (k) => jobs.busy(k)).find((p) => p.key === key) ?? null });
        if (method === "DELETE") return json(res, 200, { removed: registry.remove(key) });
      }
      if (path === "/api/phones/self/jobs" && method === "GET") {
        if (!registry.get(key)) return json(res, 404, { error: "Register this phone first" });
        return json(res, 200, { job: await jobs.poll(key, responseGone(res)) });
      }
      const act = /^\/api\/phones\/self\/jobs\/([\w-]+)\/(lease|result)$/.exec(path);
      if (act && method === "POST") {
        const [, id, action] = act;
        if (action === "lease") return json(res, 200, { active: jobs.lease(key, id!) });
        if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) return json(res, 415, { error: "JSON required" });
        const outcome = phoneJobOutcome.safeParse(await readBody(req, 1_000_000));
        if (!outcome.success) return json(res, 400, { error: "Send { ok: true, result } or { ok: false, error, code? }." });
        jobs.complete(key, id!, outcome.data);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "not found" });
    }

    const one = /^\/api\/phones\/([^/]+)$/.exec(path);
    if (one && method === "DELETE") {
      if (!deps.isAdmin(auth)) return json(res, 403, { error: "Only the owner or an admin can remove phones." });
      return json(res, 200, { removed: registry.remove(decodeURIComponent(one[1]!)) });
    }
    return json(res, 404, { error: "not found" });
  };
}
