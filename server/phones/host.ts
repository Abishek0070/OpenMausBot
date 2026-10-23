// What server/index.ts needs from the phone integration, in one object so the host file gains only a few lines: the
// per-turn mount, the prompt part and the internal MCP handler (owner check, per-bot verdict, decision rows, the send
// hold, the phone job, write activity).
import { PHONE_MCP_SERVER, phoneToolCapability, phoneToolSends, type PhoneCapability } from "../../shared/phone-apps.ts";
import { outboundCallsIn } from "../../shared/outbound.ts";
import { appendDecision } from "../decision-log.ts";
import { harnessMcpTokenEnv } from "../harness-mcp-token.ts";
import type { OutboundHold } from "../outbound-hold.ts";
import { AGENTS_NODE_FLAG, SPAWNED_PROXIES } from "../proxy-paths.ts";
import type { BotRecord } from "../store.ts";
import { capName, phoneAccess, phoneAppsFor, phoneSystemPrompt, type PhoneAccess, type PhoneBot } from "./access.ts";
import { PHONE_NO_PHONE_TEXT } from "./instructions.ts";
import { PHONE_JOB_TIMEOUT_MS, PHONE_SEND_TIMEOUT_MS, type PhoneJobs } from "./jobs.ts";
import type { PhoneRecord, PhoneRegistry } from "./registry.ts";
import { phoneRpc, type PhoneTarget, type PhoneToolsList } from "./rpc.ts";
import { PHONE_TOOLS, type PhoneToolResult } from "./tools.ts";

type TurnCapability = { botId: string; threadId: string; generation: string };

export interface PhoneHostDeps {
  registry: PhoneRegistry;
  jobs: PhoneJobs;
  dataDir: string;
  /** The live store bot, re-read on every check so a permission change wins over a call already under way. */
  bot(id: string): BotRecord | undefined | null;
  /** The owner whose phones a turn may use, or null when the turn is not provably the owner's (spec §2 "Whose phone"). */
  turnOwner(capability: TurnCapability): string | null;
  /** True when the thread is a room, so the activity row names its author. */
  inRoom(threadId: string): boolean;
  appendMessage(threadId: string, message: Record<string, unknown>): void;
  outboundHold: OutboundHold;
  /** Full access: a send skips the "Send on your behalf?" card, as on the connectors route. */
  sendsFreely(capability: { botId: string; threadId: string }): boolean;
  active(capability: TurnCapability): boolean;
}

export interface PhoneHost {
  /** The owner has a phone that allows an app this bot was granted. */
  mounts(bot: PhoneBot, owner: string | null): boolean;
  integration(bot: PhoneBot, owner: string | null, mint: () => string, harnessUrl: string): { command: string; args: string[]; env: Record<string, string> } | null;
  prompt(bot: PhoneBot, owner: string | null): string;
  handle(body: unknown, capability: TurnCapability, assertActive: () => void): Promise<PhoneToolsList | PhoneToolResult>;
  /** The PHONE_* names for the per-bot tool grants picker (/api/connectors/tools); null when no phone is registered. */
  toolListing(): { phone: Array<{ name: string; description: string }> } | null;
}

const NOT_OWNER_TEXT = "This conversation can't use a phone: only the owner's own turns can.";
const GONE_TEXT = "This bot no longer exists.";

const recency = (phone: PhoneRecord) => phone.lastUsedAt ?? phone.seen;
const allows = (phone: PhoneRecord, cap: PhoneCapability) => Boolean(phone.registration.capabilities[cap]);
const target = (phone: PhoneRecord): PhoneTarget => ({ key: phone.key, name: phone.registration.name, platform: phone.registration.platform });
const denied = (name: string, text: string, rule: string, summary: string): PhoneAccess =>
  ({ ok: false, text, rows: [{ tool: name, summary, decision: "auto-denied", rule }] });

export function createPhoneHost(deps: PhoneHostDeps): PhoneHost {
  const { registry, jobs } = deps;
  /** The owner's phones that allow at least one app, the most recently used first (the default phone). */
  const phonesOf = (owner: string) => registry.forOwner(owner)
    .filter((phone) => Object.values(phone.registration.capabilities).some(Boolean))
    .sort((a, b) => recency(b) - recency(a));
  /** The apps any of the owner's phones allows: what exists for the verdict. The chosen phone's own apps decide at run. */
  const merged = (phones: PhoneRecord[]) => Object.assign({}, ...phones.map((phone) => phone.registration.capabilities)) as Partial<Record<PhoneCapability, string>>;
  const mounts = (bot: PhoneBot, owner: string | null) => {
    if (owner === null) return false;
    const grants = phoneAppsFor(bot);
    const granted = (Object.keys(grants) as PhoneCapability[]).filter((cap) => grants[cap]);
    return phonesOf(owner).some((phone) => granted.some((cap) => allows(phone, cap)));
  };
  return {
    mounts,
    integration(bot, owner, mint, harnessUrl) {
      if (!mounts(bot, owner)) return null;
      const token = mint();
      return {
        command: process.execPath, args: [SPAWNED_PROXIES.harnessMcp, PHONE_MCP_SERVER],
        env: { ...AGENTS_NODE_FLAG, [harnessMcpTokenEnv("device")]: token, OMB_HARNESS_URL: harnessUrl },
      };
    },
    prompt: (bot, owner) => (owner === null ? "" : phoneSystemPrompt(bot, phonesOf(owner).map(({ registration }) => registration))),
    toolListing: () => (registry.list(null, () => false).length === 0 ? null : { phone: PHONE_TOOLS.map(({ name, description }) => ({ name, description })) }),
    async handle(body, capability, assertActive) {
      const active = () => deps.active(capability);
      return phoneRpc(body as { method?: unknown; params?: unknown }, {
        assertActive,
        // Re-read the live bot and the turn's owner on every call, so a permission change wins over a request
        // authenticated under the old one.
        authorize: (name) => {
          const bot = deps.bot(capability.botId);
          if (!bot) return { ok: false, text: GONE_TEXT };
          const owner = deps.turnOwner(capability);
          const phones = owner === null ? [] : phonesOf(owner);
          const verdict = owner === null ? denied(name, NOT_OWNER_TEXT, "phone:not-owner", "not the owner's own turn")
            : phones.length === 0 ? denied(name, PHONE_NO_PHONE_TEXT, "phone:no-phone", "no phone paired with its apps allowed")
              : phoneAccess(bot, merged(phones), name);
          for (const row of verdict.rows) {
            appendDecision(deps.dataDir, { threadId: capability.threadId, botId: bot.id, botName: bot.name, tool: row.tool, decision: row.decision, source: "connector-scope", rule: row.rule, ...(row.summary ? { summary: row.summary } : {}) });
          }
          return verdict.ok ? { ok: true } : { ok: false, text: verdict.text };
        },
        phone: (preferred) => {
          const owner = deps.turnOwner(capability);
          const phones = owner === null ? [] : phonesOf(owner);
          if (phones.length === 0) return null;
          if (preferred === undefined) return target(phones[0]!);
          const wanted = preferred.trim().toLowerCase();
          const match = phones.find((phone) => phone.registration.name.trim().toLowerCase() === wanted);
          return match ? target(match) : { ok: false, text: `${PHONE_NO_PHONE_TEXT} Available phones: ${phones.map((phone) => phone.registration.name).join(", ")}.` };
        },
        holdSend: async (name, args) => {
          const bot = deps.bot(capability.botId);
          if (!bot) return { ok: false, text: GONE_TEXT };
          const send = { threadId: capability.threadId, tool: name, calls: outboundCallsIn(name, args), opaque: false };
          const fullAccess = deps.sendsFreely(capability);
          const held = await deps.outboundHold.hold({ bot, ...send, fullAccess, active });
          if (!held.ok) return held;
          // At dispatch, as the connectors route does: the live bot's policy, and Full access only if it still holds.
          const fresh = deps.bot(capability.botId);
          if (!fresh) return { ok: false, text: GONE_TEXT };
          try { deps.outboundHold.reserve({ bot: fresh, ...send, fullAccess: fullAccess && deps.sendsFreely(capability), approved: held.approved }); }
          catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
          return { ok: true };
        },
        run: async (phone, name, args) => {
          const record = registry.get(phone.key);
          if (!record) return { ok: false, error: PHONE_NO_PHONE_TEXT };
          const cap = phoneToolCapability(name);
          if (!allows(record, cap)) return { ok: false, code: "denied", error: `${phone.name} does not allow ${capName(cap)}.` };
          const outcome = await jobs.request(phone.key, name, args, {
            active, timeoutMs: phoneToolSends(name) ? PHONE_SEND_TIMEOUT_MS : PHONE_JOB_TIMEOUT_MS,
            offlineText: `${phone.name} is offline. Open the MausBot app on it.`, online: () => registry.online(phone.key),
          });
          if (outcome.ok) registry.used(phone.key);
          return outcome;
        },
        onWrite: (record) => {
          const bot = deps.bot(capability.botId);
          deps.appendMessage(capability.threadId, {
            role: "bot", kind: "activity",
            tool: { name: `mcp__${PHONE_MCP_SERVER}__${record.tool}`, ok: true, summary: record.summary },
            ...(bot && deps.inRoom(capability.threadId) ? { from: { botId: bot.id, name: bot.name, color: bot.color } } : {}),
          });
        },
      });
    },
  };
}
