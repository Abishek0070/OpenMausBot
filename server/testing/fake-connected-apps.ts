// A loopback stand-in for the managed connected-apps service (cloudflare/composio-broker): the connected list, and an MCP
// endpoint that answers the Google read tools the way Composio's multi-execute tool does.
import { createServer } from "node:http";

import {
  ACCOUNT_PARAM, CALENDAR_LIST_TOOL, CALENDARS_TOOL, GMAIL_FETCH_TOOL, GMAIL_MESSAGE_TOOL, GMAIL_PROFILE_TOOL, GMAIL_THREAD_TOOL,
} from "../assistant-sources.ts";

type Toolkit = "gmail" | "googlecalendar";

export interface FakeAccount {
  id: string;
  alias?: string;
  /** Composio's connection status; ACTIVE when unset. */
  status?: string;
  address: string;
  /** Google Calendar calendar list entries; unset, the primary calendar named by the address. */
  calendars?: unknown[];
  /** Every read naming this account fails. */
  failing?: boolean;
}

export interface FakeConnectedApps {
  url: string;
  token: string;
  connected: Record<string, boolean>;
  /** An app listed here reports these accounts, and a call to it must name one of them once there are several. */
  accounts: Partial<Record<Toolkit, FakeAccount[]>>;
  /** Google Calendar event resources of an app reported with no accounts. */
  events: unknown[];
  /** Composio GMAIL_FETCH_EMAILS messages of an app reported with no accounts. */
  emails: unknown[];
  /** Google Calendar calendar list entries of an app reported with no accounts. */
  calendars: unknown[];
  /** Event resources by `<account>/<calendarId>`. */
  calendarEvents: Record<string, unknown[]>;
  /** GMAIL_FETCH_EMAILS messages by account. */
  inbox: Record<string, unknown[]>;
  /** Messages read by id, by `<account>/<messageId>`; a message in the inbox is found there too. */
  messages: Record<string, unknown>;
  /** A thread's messages by `<account>/<threadId>`; unset, the messages and inbox entries with that thread id. */
  threads: Record<string, unknown[]>;
  /** The account is the id the call named, absent when it named none. */
  calls: Array<{ tool: string; account?: string; arguments: unknown }>;
  /** While set, calendar reads wait for it before they answer. */
  holdCalendar?: Promise<void>;
  close(): Promise<void>;
}

type ToolItem = { tool_slug?: string; arguments?: unknown; [ACCOUNT_PARAM]?: unknown };
type Frame = { id?: unknown; method?: string; params?: { name?: string; arguments?: { tools?: ToolItem[] } } };

class ToolFailure extends Error {}

const ACTIVE = "ACTIVE";
// Google's own answer for a message that is gone, as Composio passes it on.
const NOT_FOUND = "Requested entity was not found.";

const toolkitOf = (slug: string): Toolkit | undefined => (slug.startsWith("GMAIL_") ? "gmail" : slug.startsWith("GOOGLECALENDAR_") ? "googlecalendar" : undefined);
const field = (value: unknown, name: string): unknown => (value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined);

export async function startFakeConnectedApps(): Promise<FakeConnectedApps> {
  const fake: Omit<FakeConnectedApps, "url" | "token" | "close"> = {
    connected: { gmail: true, googlecalendar: true }, accounts: {}, events: [], emails: [], calls: [],
    calendars: [{ id: "me@example.test", primary: true, accessRole: "owner", selected: true }],
    calendarEvents: {}, inbox: {}, messages: {}, threads: {},
  };

  function services(): Record<string, unknown> {
    const slugs = new Set([...Object.keys(fake.connected), ...Object.keys(fake.accounts)]);
    return Object.fromEntries([...slugs].map((slug) => {
      const listed = fake.accounts[slug as Toolkit];
      if (!listed) return [slug, { connected: fake.connected[slug] === true }];
      return [slug, {
        connected: listed.some((account) => (account.status ?? ACTIVE) === ACTIVE),
        accounts: listed.map(({ id, alias, status }) => ({ id, ...(alias ? { alias } : {}), status: status ?? ACTIVE })),
      }];
    }));
  }

  /** The account a call runs as: undefined for an app reported with no accounts. */
  function accountFor(toolkit: Toolkit | undefined, named: string | undefined): FakeAccount | undefined {
    const listed = toolkit && fake.accounts[toolkit];
    if (!listed) return undefined;
    if (named === undefined) {
      if (listed.length > 1) throw new ToolFailure(`Multiple connected accounts found for ${toolkit}. Specify which account to use.`);
      return listed[0];
    }
    const account = listed.find((candidate) => candidate.id === named || candidate.alias === named);
    if (!account) throw new ToolFailure(`No connected account ${named} for ${toolkit}.`);
    return account;
  }

  function inboxOf(key: string, account: FakeAccount | undefined): unknown[] {
    return fake.inbox[key] ?? (account ? [] : fake.emails);
  }

  function messagesOf(key: string, account: FakeAccount | undefined): unknown[] {
    const byId = Object.entries(fake.messages).filter(([at]) => at.startsWith(`${key}/`)).map(([, message]) => message);
    const ids = new Set(byId.map((message) => field(message, "messageId")));
    return [...byId, ...inboxOf(key, account).filter((message) => !ids.has(field(message, "messageId")))];
  }

  function answer(slug: string, args: unknown, toolkit: Toolkit | undefined, account: FakeAccount | undefined): unknown {
    if (account?.failing) throw new ToolFailure(`${slug}: the connection to ${account.address} failed`);
    const key = account?.id ?? toolkit ?? "";
    if (slug === CALENDAR_LIST_TOOL) return { items: fake.calendarEvents[`${key}/${String(field(args, "calendarId"))}`] ?? (account ? [] : fake.events) };
    if (slug === CALENDARS_TOOL) return { items: account ? account.calendars ?? [{ id: account.address, primary: true, accessRole: "owner", selected: true }] : fake.calendars };
    if (slug === GMAIL_FETCH_TOOL) return { messages: inboxOf(key, account) };
    if (slug === GMAIL_PROFILE_TOOL) return { emailAddress: account?.address ?? "me@example.test" };
    if (slug === GMAIL_MESSAGE_TOOL) {
      const id = field(args, "message_id");
      const message = fake.messages[`${key}/${String(id)}`] ?? inboxOf(key, account).find((one) => field(one, "messageId") === id);
      if (!message) throw new ToolFailure(NOT_FOUND);
      return message;
    }
    if (slug === GMAIL_THREAD_TOOL) {
      const threadId = field(args, "thread_id");
      return { messages: fake.threads[`${key}/${String(threadId)}`] ?? messagesOf(key, account).filter((message) => field(message, "threadId") === threadId) };
    }
    return {};
  }

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/broker/v1/connectors/connected") return res.end(JSON.stringify({ services: services() }));
    if (req.method === "POST" && req.url === "/broker/v1/mcp") {
      const body = (raw ? JSON.parse(raw) : {}) as Frame;
      if (body.method === "initialize") {
        res.setHeader("mcp-session-id", "fake-session");
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fake-connected-apps", version: "1" } } }));
      }
      if (body.method === "notifications/initialized") {
        res.statusCode = 202;
        return res.end();
      }
      if (body.method === "tools/call") {
        const tool: ToolItem | undefined = body.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL" ? body.params.arguments?.tools?.[0] : { tool_slug: body.params?.name, arguments: body.params?.arguments };
        const slug = String(tool?.tool_slug ?? "");
        const named = typeof tool?.[ACCOUNT_PARAM] === "string" ? tool[ACCOUNT_PARAM] : undefined;
        fake.calls.push({ tool: slug, ...(named === undefined ? {} : { account: named }), arguments: tool?.arguments });
        if (slug === CALENDAR_LIST_TOOL && fake.holdCalendar) await fake.holdCalendar;
        let response: { successful: boolean; data: unknown; error: string | null };
        try {
          const toolkit = toolkitOf(slug);
          response = { successful: true, data: answer(slug, tool?.arguments, toolkit, accountFor(toolkit, named)), error: null };
        } catch (error) {
          if (!(error instanceof ToolFailure)) throw error;
          response = { successful: false, data: null, error: error.message };
        }
        const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response }] }, error: null });
        return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } }));
      }
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "fake connected apps: unknown path" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}/broker`,
    token: "c".repeat(64),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  });
}
