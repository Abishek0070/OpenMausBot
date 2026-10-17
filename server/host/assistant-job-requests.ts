// Security invariant: a MausBot job thread is hidden, nobody watches it, and its prompt carries mail and invite text. No
// card may wait there and no saved grant applies: the server answers every request in it. A web search is allowed; every
// other request, every question and every OpenMausBot or connected-app call that is not a read is declined with a reason
// the turn reads.
import { connectorCallsIn, isReadOnlyTool } from "../../shared/outbound.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { isWebSearchTool } from "../auto-approve.ts";
import type { ProviderAdapter } from "../contracts.ts";
import type { DecisionRow } from "../decision-log.ts";
import { isAssistantJobThread } from "./assistant-turns.ts";

type RequestOpened = Extract<RuntimeEvent, { type: "request.opened" }>;
export type JobRequest = Pick<RequestOpened, "threadId" | "requestType" | "tool" | "summary" | "questions" | "requiresExplicitApproval"> & { turnId?: string };
type JobAdapter = Pick<ProviderAdapter, "respondToRequest" | "interruptTurn">;
type JobSay = (message: { role: "bot"; kind: "activity"; tool: { name: string; ok: boolean } }) => unknown;
type JobBot = { id: string; name: string };

export const JOB_DECLINE = "MausBot's background work only reads: it may search the web and read its connected apps and conversations, and it asks nobody anything. Finish with what you have.";

const JOB_RULE = "mausbot-job";

/** OpenMausBot's own routes a job turn may reach: its conversation reads, the paging of its own long results, the engine's
 * hooks, and the connected-apps relay, where each call must be a read. */
const JOB_ROUTES: ReadonlySet<string> = new Set([
  "GET /api/internal/session-search",
  "GET /api/internal/session-read",
  "GET /api/internal/tool-result",
  "POST /api/internal/tool-result",
  "POST /api/internal/hook",
  "POST /api/internal/connectors/mcp",
]);

/** Composio's meta tools that only describe tools; connecting an account waits for a person. */
const TOOL_DISCOVERY: ReadonlySet<string> = new Set(["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS"]);

export function jobMayAllow(event: Pick<JobRequest, "requestType" | "tool" | "questions" | "requiresExplicitApproval">): boolean {
  return event.requestType === "permission" && !event.questions?.length && !event.requiresExplicitApproval && isWebSearchTool(event.tool);
}

/** The tool a connected-apps frame would run that is not a read, or null when it runs only reads or nothing at all. */
export function jobConnectorWrite(frame: unknown): string | null {
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return null;
  const { method, params } = frame as { method?: unknown; params?: unknown };
  if (method !== "tools/call") return null;
  const call = params && typeof params === "object" && !Array.isArray(params) ? (params as { name?: unknown; arguments?: unknown }) : {};
  if (typeof call.name !== "string" || !call.name) return "tools/call";
  if (TOOL_DISCOVERY.has(call.name)) return null;
  const calls = connectorCallsIn(call.name, call.arguments);
  if (!calls.length) return call.name;
  return calls.find((one) => !isReadOnlyTool(one.slug))?.slug ?? null;
}

export function answerJobRequest(input: {
  event: JobRequest;
  requestId: string | undefined;
  adapter: JobAdapter | undefined;
  isCurrent(): boolean;
  say: JobSay;
  log(entry: { decision: "auto-approved" | "auto-denied"; tool: string; summary: string }): void;
  release(): void;
}): void {
  const { event, adapter, requestId } = input;
  const allow = requestId !== undefined && jobMayAllow(event);
  input.say({ role: "bot", kind: "activity", tool: { name: `${allow ? "MausBot allowed" : "MausBot declined"}: ${event.summary.slice(0, 120)}`, ok: allow } });
  input.log({ decision: allow ? "auto-approved" : "auto-denied", tool: event.tool, summary: event.summary });
  void (async () => {
    try {
      if (requestId === undefined) throw new Error("no request id to answer");
      await adapter?.respondToRequest(event.threadId, requestId, allow ? { behavior: "allow" } : { behavior: "deny", message: JOB_DECLINE });
    } catch {
      if (event.turnId && input.isCurrent()) await adapter?.interruptTurn(event.threadId, event.turnId).catch(() => {});
    }
    if (input.isCurrent()) input.release();
  })().catch(() => console.error("[assistant] Could not answer a request in a MausBot job thread."));
}

export interface AssistantJobGateDeps {
  routineRunId(botId: string, threadId: string): string | undefined;
  adapter(instanceId: string): JobAdapter | undefined;
  stale(event: RequestOpened): boolean;
  decide(row: Omit<DecisionRow, "at">): void;
  release(threadId: string): void;
}

export function createAssistantJobGate(deps: AssistantJobGateDeps) {
  const isJobThread = (botId: string, threadId: string): boolean => isAssistantJobThread(deps.routineRunId(botId, threadId));
  const refuse = (bot: JobBot, threadId: string, tool: string): true => {
    deps.decide({ threadId, botId: bot.id, botName: bot.name, tool, decision: "auto-denied", source: "routine", rule: JOB_RULE });
    return true;
  };

  /** True when the request is in a job thread and was answered here, before any grant or card. */
  function answers(event: RequestOpened, asker: JobBot & { modelSelection: { instanceId: string } }, say: JobSay): boolean {
    if (!isJobThread(asker.id, event.threadId)) return false;
    answerJobRequest({
      event,
      requestId: event.requestId,
      adapter: deps.adapter(event.providerInstanceId ?? asker.modelSelection.instanceId),
      isCurrent: () => !deps.stale(event),
      say,
      log: (entry) => deps.decide({ threadId: event.threadId, requestId: event.requestId, botId: asker.id, botName: asker.name, source: "routine", rule: JOB_RULE, ...entry }),
      release: () => deps.release(event.threadId),
    });
    return true;
  }

  function refusesRoute(bot: JobBot, threadId: string, method: string, path: string): boolean {
    const route = `${method} ${path}`;
    return !JOB_ROUTES.has(route) && isJobThread(bot.id, threadId) && refuse(bot, threadId, route);
  }

  function refusesConnectorCall(bot: JobBot, threadId: string, frame: unknown): boolean {
    if (!isJobThread(bot.id, threadId)) return false;
    const write = jobConnectorWrite(frame);
    return write !== null && refuse(bot, threadId, write);
  }

  return { isJobThread, answers, refusesRoute, refusesConnectorCall };
}
