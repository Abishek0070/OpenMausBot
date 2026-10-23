// The JSON-RPC entry the harness proxy reaches for the device kind: tools/list (filtered to what this bot may run on the
// owner's phones) and tools/call (validate → verdict → pick the phone → hold a send → verdict again → run as a phone job).
// The turn's capability must still be live before and after the call.
import { isPhoneToolName, isPhoneWrite, phoneToolSends, type PhonePlatform, type PhoneToolName } from "../../shared/phone-apps.ts";
import { describeAction } from "./access.ts";
import { PHONE_INSTRUCTIONS, PHONE_NO_PHONE_TEXT } from "./instructions.ts";
import type { PhoneJobOutcome } from "./jobs.ts";
import { PHONE_TOOLS, phoneErrorResult, phoneOkResult, phoneToolCallProblem, type PhoneToolResult } from "./tools.ts";

export const PHONE_INTERNAL_MCP_PATH = "/api/internal/device/mcp";

export type PhoneTarget = { key: string; name: string; platform: PhonePlatform };

export interface PhoneRpcDeps {
  assertActive(): void;
  /** The per-bot verdict for one tool name; a refusal's text is returned to the bot as a failed call. */
  authorize(name: string): { ok: true } | { ok: false; text: string };
  /** Which phone runs it: null when none is paired with its apps allowed, a refusal when the named one is not paired. */
  phone(preferred?: string): PhoneTarget | { ok: false; text: string } | null;
  /** A send waits on the hold first; refusal text comes back to the bot. */
  holdSend(name: string, args: Record<string, unknown>): Promise<{ ok: true } | { ok: false; text: string }>;
  run(phone: PhoneTarget, name: PhoneToolName, args: Record<string, unknown>): Promise<PhoneJobOutcome>;
  /** A successful write (sends included): the handler records it in the bot's activity. */
  onWrite?(record: { tool: PhoneToolName; phone: string; summary: string }): void;
}

export type PhoneToolsList = { tools: (typeof PHONE_TOOLS)[number][]; instructions: string };

export async function phoneRpc(
  request: { method?: unknown; params?: unknown } | null | undefined,
  deps: PhoneRpcDeps,
): Promise<PhoneToolsList | PhoneToolResult> {
  if (request?.method === "tools/list") {
    deps.assertActive();
    return { tools: PHONE_TOOLS.filter((tool) => deps.authorize(tool.name).ok), instructions: PHONE_INSTRUCTIONS };
  }
  if (request?.method !== "tools/call") throw Object.assign(new Error("unsupported device method"), { status: 400 });
  const params = (request.params && typeof request.params === "object" ? request.params : {}) as { name?: unknown; arguments?: unknown };
  const args = params.arguments ?? {};
  const problem = phoneToolCallProblem(params.name, args);
  if (problem || !isPhoneToolName(params.name)) return phoneErrorResult(problem ?? "Unknown phone tool.", { code: "invalid_input" });
  const name = params.name;
  const { phone: preferred, ...jobArgs } = args as Record<string, unknown>;
  deps.assertActive();
  const verdict = deps.authorize(name);
  if (!verdict.ok) return phoneErrorResult(verdict.text, { code: "refused" });
  const target = deps.phone(typeof preferred === "string" && preferred.trim() ? preferred : undefined);
  if (!target || "text" in target) return phoneErrorResult(target?.text ?? PHONE_NO_PHONE_TEXT, { code: "no_phone" });
  if (phoneToolSends(name)) {
    const held = await deps.holdSend(name, args as Record<string, unknown>);
    if (!held.ok) return phoneErrorResult(held.text, { code: "refused" });
    // The hold can wait minutes: a grant lowered meanwhile stops the send, as the connectors route re-checks at dispatch.
    const again = deps.authorize(name);
    if (!again.ok) return phoneErrorResult(again.text, { code: "refused" });
  }
  const outcome = await deps.run(target, name, jobArgs);
  deps.assertActive();
  if (!outcome.ok) return phoneErrorResult(outcome.error, outcome.code ? { code: outcome.code } : {});
  if (isPhoneWrite(name)) deps.onWrite?.({ tool: name, phone: target.name, summary: `${describeAction(name)} on ${target.name}`.slice(0, 240) });
  return phoneOkResult(outcome.result, { name: target.name, platform: target.platform });
}
