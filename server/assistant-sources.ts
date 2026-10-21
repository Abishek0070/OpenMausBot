// Reads Google Calendar events and Gmail headers from the server through the connected-apps relay, with no engine turn.
// Tool names, arguments, the account selector and answer shapes follow Composio's documentation; the fixtures are not yet
// checked against the live service.
import { parseMcpResponse } from "./connector-tools-list.ts";

export const ASSISTANT_SERVICES = ["gmail", "googlecalendar"] as const;
export type AssistantService = (typeof ASSISTANT_SERVICES)[number];

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  status: "confirmed" | "tentative" | "cancelled";
  selfDeclined: boolean;
  attendees: Array<{ email: string; name?: string; self: boolean; organizer: boolean; response?: string }>;
  seriesId?: string;
  joinUrl?: string;
  location?: string;
  description?: string;
  calendarId?: string;
  ownedCalendar?: boolean;
  iCalUID?: string;
  originalStart?: number;
  organizer?: string;
}

export interface EmailHeader {
  id: string;
  account: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  preview: string;
  messageIdHeader?: string;
}

/** An implied account stands for a service reported connected without a list of its accounts; its id is the service. */
export interface SourceAccount {
  service: AssistantService;
  id: string;
  alias?: string;
  active: boolean;
  /** Composio reports the connection as INITIATED, INITIALIZING or PENDING: the person started connecting it and has not
   * finished. */
  pending?: true;
  implied?: true;
}

export interface ThreadMessage {
  id: string;
  at: number;
  /** The sender's lower-case address, or "" when the answer named none. */
  from: string;
}

export interface AssistantSources {
  accounts(): Promise<SourceAccount[] | null>;
  address(account: SourceAccount): Promise<string | null>;
  events(account: SourceAccount, fromMs: number, toMs: number): Promise<CalendarEvent[]>;
  emails(account: SourceAccount, sinceMs: number, limit: number): Promise<EmailHeader[]>;
  mailFrom(account: SourceAccount, addresses: readonly string[], sinceMs: number): Promise<boolean>;
  /** Null only when the service says the message is gone. */
  message(account: SourceAccount, messageId: string): Promise<EmailHeader | null>;
  thread(account: SourceAccount, threadId: string): Promise<ThreadMessage[]>;
}

export interface SingleAccountSources {
  connected(): Promise<Record<AssistantService, boolean> | null>;
  events(fromMs: number, toMs: number): Promise<CalendarEvent[]>;
  emails(sinceMs: number, limit: number): Promise<EmailHeader[]>;
  mailFrom(addresses: readonly string[], sinceMs: number): Promise<boolean>;
}

export class SourceError extends Error {
  readonly service: AssistantService;
  readonly account?: string;
  constructor(service: AssistantService, message: string, account?: string) {
    super(message);
    this.service = service;
    if (account !== undefined) this.account = account;
    this.name = "SourceError";
  }
}

export const CALENDAR_LIST_TOOL = "GOOGLECALENDAR_EVENTS_LIST";
export const CALENDARS_TOOL = "GOOGLECALENDAR_LIST_CALENDARS";
export const GMAIL_FETCH_TOOL = "GMAIL_FETCH_EMAILS";
export const GMAIL_PROFILE_TOOL = "GMAIL_GET_PROFILE";
export const GMAIL_MESSAGE_TOOL = "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID";
export const GMAIL_THREAD_TOOL = "GMAIL_FETCH_MESSAGE_BY_THREAD_ID";
/** The field of a Composio multi-execute tool item that names the connected account the call runs as. */
export const ACCOUNT_PARAM = "account";
/** Composio's GMAIL_FETCH_EMAILS carries each message's `payload.headers`, Message-ID among them, only with its payload. */
export const GMAIL_HEADERS_OPTION = { include_payload: true } as const;
const CALENDAR_READS_AT_ONCE = 4;
const CALENDAR_NAME_MAX = 80;
const GOOGLE_NOT_FOUND = /\brequested entity was not found\b/i;
const MESSAGE_WORD = /\b(?:message|email|thread)\b/i;
const MISSING_WORD = /\b(?:not found|deleted|no longer exists)\b/i;
const OTHER_SUBJECT = /\b(?:account|connect|o?auth|token|permission|scope|credential|tool|integration)/i;
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CALL_ID = "omb-assistant-call";
const PREVIEW_MAX = 300;
const ADDRESS = /^[\w.+][\w.+-]*@[\w-]+(?:\.[\w-]+)+$/;
const isAccountActive = /^active$/i;
const isAccountPending = /^(?:initiated|initializing|pending)$/i;
const PRIMARY_CALENDAR = { id: "primary", name: "primary", primary: true, owned: true, read: true } as const;
const GONE = Symbol("gone");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const flat = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const seconds = (ms: number): number => Math.floor(ms / 1000);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const isAddress = (value: string): boolean => ADDRESS.test(value);

/** The tool itself answered that it failed, as opposed to the relay or Composio failing around it. */
class ToolAnswerError extends Error {}

/** Whether a Gmail tool's own error says the message asked for is missing, while naming no account, connection, token,
 * permission or tool. */
export function messageGone(toolError: string): boolean {
  if (OTHER_SUBJECT.test(toolError)) return false;
  return GOOGLE_NOT_FOUND.test(toolError) || (MESSAGE_WORD.test(toolError) && MISSING_WORD.test(toolError));
}

async function inParallel<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

type ConnectedServices = Record<string, { connected: boolean; accounts?: ReadonlyArray<{ id: string; alias?: string; status: string }> }>;

export function accountsFromServices(services: ConnectedServices): SourceAccount[] {
  return ASSISTANT_SERVICES.flatMap((service): SourceAccount[] => {
    const state = services[service];
    if (!state?.accounts?.length) return [{ service, id: service, active: state?.connected === true, implied: true }];
    return state.accounts.map(({ id, alias, status }) => ({
      service, id, ...(alias ? { alias } : {}), active: isAccountActive.test(status), ...(isAccountPending.test(status) ? { pending: true as const } : {}),
    }));
  });
}

function toolItem(slug: string, args: Record<string, unknown>, account: SourceAccount): Record<string, unknown> {
  return { tool_slug: slug, arguments: args, ...(account.implied ? {} : { [ACCOUNT_PARAM]: account.id }) };
}

/** One tool's `data` from a tools/call answer, multi-execute or direct. Anything else throws. */
export function toolData(slug: string, frame: Record<string, unknown> | null): unknown {
  if (!frame) throw new Error(`${slug}: no answer`);
  const rpcError = record(frame.error)?.message;
  if (typeof rpcError === "string") throw new Error(rpcError.slice(0, 300));
  const result = record(frame.result);
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map(record).find((part) => typeof part?.text === "string")?.text as string | undefined;
  if (result?.isError === true) throw new Error(text?.slice(0, 300) || `${slug} failed`);
  if (text === undefined) throw new Error(`${slug}: the answer had no text`);
  let body: Record<string, unknown> | undefined;
  try {
    body = record(JSON.parse(text));
  } catch {
    throw new Error(`${slug}: the answer was not JSON`);
  }
  if (!body) throw new Error(`${slug}: the answer was not an object`);
  if (body.successful === false) throw new Error(String(body.error ?? `${slug} failed`).slice(0, 300));
  const results = record(body.data)?.results;
  if (Array.isArray(results)) {
    const response = record(results.map(record).find((item) => item?.tool_slug === slug)?.response);
    if (!response) throw new Error(`${slug}: missing from the answer`);
    if (response.successful === false) throw new ToolAnswerError(String(response.error ?? `${slug} failed`).slice(0, 300));
    if (!("data" in response)) throw new Error(`${slug}: the answer had no data`);
    return response.data;
  }
  if (!("data" in body)) throw new Error(`${slug}: the answer had no data`);
  return body.data;
}

function listIn(data: unknown, keys: readonly string[]): unknown[] | null {
  if (Array.isArray(data)) return data;
  for (const body of [record(data), record(record(data)?.response_data)]) {
    for (const key of keys) if (Array.isArray(body?.[key])) return body[key] as unknown[];
  }
  return null;
}

function headerValue(item: Record<string, unknown>, name: string): string | undefined {
  const headers = record(item.payload)?.headers;
  const value = (Array.isArray(headers) ? headers : []).map(record).find((header) => typeof header?.name === "string" && header.name.toLowerCase() === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sentAt(item: Record<string, unknown>): number {
  const at = typeof item.messageTimestamp === "string" ? Date.parse(item.messageTimestamp)
    : typeof item.internalDate === "string" || typeof item.internalDate === "number" ? Number(item.internalDate) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

function senderOf(item: Record<string, unknown>): string {
  return flat(item.sender ?? item.from ?? headerValue(item, "from"));
}

function oneLine(value: unknown, max: number): string {
  return Array.from(flat(typeof value === "string" ? value.replace(/[^\P{C}\s]/gu, "") : "")).slice(0, max).join("").trim();
}

function addressIn(sender: string): string {
  const candidate = (/<([^<>\s]+)>/.exec(sender)?.[1] ?? sender).trim().toLowerCase();
  return ADDRESS.test(candidate) ? candidate : "";
}

function calendarEvent(raw: unknown, calendar: { id: string; owned: boolean }): CalendarEvent | null {
  const item = record(raw);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  const start = record(item.start);
  const end = record(item.end);
  const allDay = typeof start?.date === "string" && typeof start?.dateTime !== "string";
  const startMs = Date.parse(String(start?.dateTime ?? start?.date ?? ""));
  if (!Number.isFinite(startMs)) return null;
  const endMs = Date.parse(String(end?.dateTime ?? end?.date ?? ""));
  const attendees = (Array.isArray(item.attendees) ? item.attendees : []).flatMap((rawAttendee) => {
    const attendee = record(rawAttendee);
    if (!attendee || typeof attendee.email !== "string" || attendee.resource === true) return [];
    return [{
      email: attendee.email.trim().toLowerCase(),
      ...(typeof attendee.displayName === "string" && attendee.displayName.trim() ? { name: flat(attendee.displayName) } : {}),
      self: attendee.self === true,
      organizer: attendee.organizer === true,
      ...(typeof attendee.responseStatus === "string" ? { response: attendee.responseStatus } : {}),
    }];
  });
  const video = (Array.isArray(record(item.conferenceData)?.entryPoints) ? record(item.conferenceData)!.entryPoints as unknown[] : [])
    .map(record).find((entry) => entry?.entryPointType === "video" && typeof entry.uri === "string")?.uri;
  const location = typeof item.location === "string" && item.location.trim() ? item.location.trim() : undefined;
  const original = record(item.originalStartTime);
  const originalStart = Date.parse(String(original?.dateTime ?? original?.date ?? ""));
  const organizer = record(item.organizer)?.email;
  const joinUrl = [item.hangoutLink, video, location].find((value): value is string => typeof value === "string" && /^https:\/\/\S+$/i.test(value.trim()));
  return {
    id: item.id,
    title: flat(item.summary) || "Untitled meeting",
    start: startMs,
    end: Number.isFinite(endMs) ? endMs : startMs,
    allDay,
    status: item.status === "cancelled" || item.status === "tentative" ? item.status : "confirmed",
    selfDeclined: attendees.some((attendee) => attendee.self && attendee.response === "declined"),
    attendees,
    ...(typeof item.recurringEventId === "string" ? { seriesId: item.recurringEventId } : {}),
    ...(joinUrl ? { joinUrl: joinUrl.trim() } : {}),
    ...(location ? { location } : {}),
    ...(typeof item.description === "string" && item.description.trim() ? { description: item.description } : {}),
    calendarId: calendar.id,
    ownedCalendar: calendar.owned,
    ...(typeof item.iCalUID === "string" && item.iCalUID ? { iCalUID: item.iCalUID } : {}),
    ...(Number.isFinite(originalStart) ? { originalStart } : {}),
    ...(typeof organizer === "string" && organizer.trim() ? { organizer: organizer.trim().toLowerCase() } : {}),
  };
}

export function eventsFromData(data: unknown, calendar: { id: string; owned: boolean }): CalendarEvent[] {
  const list = listIn(data, ["items", "events"]);
  if (!list) throw new Error("the calendar answer had no event list");
  let cancelledDropped = 0;
  const events = list.flatMap((raw) => {
    const event = calendarEvent(raw, calendar);
    if (!event && record(raw)?.status === "cancelled") cancelledDropped += 1;
    return event ? [event] : [];
  });
  if (list.length > cancelledDropped && events.length === 0) throw new Error("none of the calendar events could be read");
  return events;
}

function messageId(item: Record<string, unknown> | undefined): string | undefined {
  const id = item?.messageId ?? item?.id;
  return typeof id === "string" && id ? id : undefined;
}

function emailHeader(raw: unknown, account: string): EmailHeader | null {
  const item = record(raw);
  const id = messageId(item);
  if (!item || !id) return null;
  const preview = record(item.preview);
  const messageIdHeader = headerValue(item, "message-id");
  return {
    id,
    account,
    threadId: typeof item.threadId === "string" && item.threadId ? item.threadId : id,
    at: sentAt(item),
    from: senderOf(item),
    subject: flat(item.subject ?? preview?.subject ?? headerValue(item, "subject")),
    preview: flat(preview?.body ?? item.snippet ?? item.messageText).slice(0, PREVIEW_MAX),
    ...(messageIdHeader ? { messageIdHeader } : {}),
  };
}

export function emailsFromData(data: unknown, account: string): EmailHeader[] {
  const list = listIn(data, ["messages"]);
  if (!list) throw new Error("the Gmail answer had no message list");
  const headers = list.flatMap((raw) => emailHeader(raw, account) ?? []);
  if (list.length > 0 && headers.length === 0) throw new Error("none of the Gmail messages could be read");
  return headers;
}

export function messageFromData(data: unknown, account: string): EmailHeader {
  const top = record(data);
  const header = emailHeader(record(top?.message) ?? record(top?.response_data) ?? top, account);
  if (!header) throw new Error("the Gmail message could not be read");
  return header;
}

export function threadFromData(data: unknown): ThreadMessage[] {
  const list = listIn(data, ["messages"]);
  if (!list) throw new Error("the Gmail thread had no message list");
  const messages = list.flatMap((raw): ThreadMessage[] => {
    const item = record(raw);
    const id = messageId(item);
    return item && id ? [{ id, at: sentAt(item), from: addressIn(senderOf(item)) }] : [];
  });
  if (list.length > 0 && messages.length === 0) throw new Error("none of the thread's messages could be read");
  return messages;
}

export function profileFromData(data: unknown): string {
  const address = [record(data), record(record(data)?.response_data)].map((body) => body?.emailAddress).find((value) => typeof value === "string");
  const normalised = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (!ADDRESS.test(normalised)) throw new Error("the Gmail profile had no address");
  return normalised;
}

export function calendarsFromData(data: unknown): Array<{ id: string; name: string; primary: boolean; owned: boolean; read: boolean }> {
  const list = listIn(data, ["items", "calendars"]);
  if (!list) throw new Error("the answer had no calendar list");
  const calendars = list.flatMap((raw) => {
    const item = record(raw);
    if (!item || typeof item.id !== "string" || !item.id) return [];
    const primary = item.primary === true;
    return [{
      id: item.id, name: oneLine(item.summary, CALENDAR_NAME_MAX) || item.id, primary,
      owned: primary || item.accessRole === "owner", read: primary || (item.selected === true && item.hidden !== true),
    }];
  });
  if (list.length > 0 && calendars.length === 0) throw new Error("none of the calendars could be read");
  return calendars;
}

export const READ_TIMEOUT_MS = 60_000;

export interface ComposioSourceDeps {
  configured(): boolean;
  connectedServices(): Promise<ConnectedServices>;
  relay(payload: unknown, transportSessionId: string | undefined, signal: AbortSignal): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
  readTimeoutMs?: number;
}

export function createComposioSources(deps: ComposioSourceDeps): AssistantSources {
  const readTimeoutMs = deps.readTimeoutMs ?? READ_TIMEOUT_MS;

  /** One tool's data, or GONE when `gone` says the tool's own failure means the thing asked for is missing. */
  async function call(account: SourceAccount, slug: string, args: Record<string, unknown>,
    options: { signal?: AbortSignal; gone?: (toolError: string) => boolean } = {}): Promise<unknown> {
    const { gone, signal = AbortSignal.timeout(readTimeoutMs) } = options;
    try {
      signal.throwIfAborted();
      const init = await deps.relay({
        jsonrpc: "2.0", id: "omb-assistant-init", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-assistant", version: "1" } },
      }, undefined, signal);
      if (init.status !== 200) throw new Error(`connected apps answered HTTP ${init.status}`);
      const session = init.transportSessionId;
      // Streamable-HTTP MCP servers expect the initialized notification before the first request.
      await deps.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, session, signal).catch(() => undefined);
      const answer = await deps.relay({
        jsonrpc: "2.0", id: CALL_ID, method: "tools/call",
        params: { name: MULTI_EXECUTE, arguments: { tools: [toolItem(slug, args, account)] } },
      }, session, signal);
      if (answer.status !== 200) throw new Error(`${slug} answered HTTP ${answer.status}`);
      return toolData(slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), CALL_ID));
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if (gone && error instanceof ToolAnswerError && gone(error.message)) return GONE;
      if (signal.aborted) throw new SourceError(account.service, `${slug} did not answer within ${Math.round(readTimeoutMs / 1000)} seconds`, account.id);
      throw new SourceError(account.service, errorText(error), account.id);
    }
  }

  function parsed<T>(account: SourceAccount, parse: () => T): T {
    try {
      return parse();
    } catch (error) {
      throw new SourceError(account.service, errorText(error), account.id);
    }
  }

  function requireFinite(account: SourceAccount, ...times: number[]): void {
    if (times.some((time) => !Number.isFinite(time))) throw new SourceError(account.service, "the time window was not a finite time", account.id);
  }

  async function gmail(account: SourceAccount, query: string, limit: number, options: Record<string, unknown> = {}): Promise<EmailHeader[]> {
    const data = await call(account, GMAIL_FETCH_TOOL, { user_id: "me", query, max_results: limit, include_payload: false, verbose: false, ...options });
    return parsed(account, () => emailsFromData(data, account.id));
  }

  async function calendars(account: SourceAccount, signal?: AbortSignal): Promise<ReturnType<typeof calendarsFromData>> {
    const data = await call(account, CALENDARS_TOOL, {}, signal ? { signal } : {});
    return parsed(account, () => calendarsFromData(data));
  }

  let activeGmailAccounts = 0;
  const copiesAcrossInboxes = (): boolean => activeGmailAccounts >= 2;

  return {
    async accounts() {
      if (!deps.configured()) return null;
      try {
        const listed = accountsFromServices(await deps.connectedServices());
        activeGmailAccounts = listed.filter((account) => account.service === "gmail" && account.active).length;
        return listed;
      } catch {
        return null;
      }
    },
    async address(account) {
      if (account.service === "gmail") {
        const data = await call(account, GMAIL_PROFILE_TOOL, { user_id: "me" });
        return parsed(account, () => profileFromData(data));
      }
      const primary = (await calendars(account)).find((calendar) => calendar.primary)?.id.toLowerCase();
      return primary && ADDRESS.test(primary) ? primary : null;
    },
    async events(account, fromMs, toMs) {
      requireFinite(account, fromMs, toMs);
      const failed = new AbortController();
      const signal = AbortSignal.any([AbortSignal.timeout(readTimeoutMs), failed.signal]);
      const listed = await calendars(account, signal);
      const read = [...(listed.some((calendar) => calendar.primary) ? [] : [PRIMARY_CALENDAR]), ...listed.filter((calendar) => calendar.read)];
      const perCalendar = await inParallel(read, CALENDAR_READS_AT_ONCE, async (calendar) => {
        try {
          const data = await call(account, CALENDAR_LIST_TOOL, {
            calendarId: calendar.id, timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
            singleEvents: true, orderBy: "startTime", maxResults: 100, showDeleted: true,
          }, { signal });
          return eventsFromData(data, { id: calendar.id, owned: calendar.owned });
        } catch (error) {
          failed.abort();
          throw new SourceError(account.service, `calendar ${calendar.name}: ${errorText(error)}`, account.id);
        }
      });
      return perCalendar.flat();
    },
    async emails(account, sinceMs, limit) {
      requireFinite(account, sinceMs);
      return gmail(account, `in:inbox after:${seconds(sinceMs)} -category:promotions -category:social`, limit, copiesAcrossInboxes() ? GMAIL_HEADERS_OPTION : {});
    },
    async mailFrom(account, addresses, sinceMs) {
      requireFinite(account, sinceMs);
      const valid = addresses.filter((address) => ADDRESS.test(address));
      if (!valid.length) return false;
      return (await gmail(account, `from:(${valid.join(" OR ")}) after:${seconds(sinceMs)}`, 1)).length > 0;
    },
    async message(account, id) {
      const data = await call(account, GMAIL_MESSAGE_TOOL, { user_id: "me", message_id: id, format: "metadata" }, { gone: messageGone });
      return data === GONE ? null : parsed(account, () => messageFromData(data, account.id));
    },
    async thread(account, threadId) {
      const data = await call(account, GMAIL_THREAD_TOOL, { user_id: "me", thread_id: threadId });
      return parsed(account, () => threadFromData(data));
    },
  };
}

export function firstAccountSources(sources: AssistantSources): SingleAccountSources {
  let listed: SourceAccount[] | null = null;
  async function first(service: AssistantService): Promise<SourceAccount> {
    const account = (listed ?? await sources.accounts() ?? []).find((candidate) => candidate.service === service && candidate.active);
    if (!account) throw new SourceError(service, `no ${service} account is connected`);
    return account;
  }
  const anyActive = (accounts: readonly SourceAccount[], service: AssistantService) => accounts.some((account) => account.service === service && account.active);
  return {
    async connected() {
      listed = await sources.accounts();
      return listed && { gmail: anyActive(listed, "gmail"), googlecalendar: anyActive(listed, "googlecalendar") };
    },
    events: async (fromMs, toMs) => sources.events(await first("googlecalendar"), fromMs, toMs),
    emails: async (sinceMs, limit) => sources.emails(await first("gmail"), sinceMs, limit),
    mailFrom: async (addresses, sinceMs) => sources.mailFrom(await first("gmail"), addresses, sinceMs),
  };
}
