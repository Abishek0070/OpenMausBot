// Reads Google Calendar events and Gmail headers from the server through the connected-apps relay, with no engine turn.
// Tool names, arguments and answer shapes follow Composio's documentation; the fixtures are not yet checked against the live service.
import { parseMcpResponse } from "./connector-tools-list.ts";

export type AssistantService = "gmail" | "googlecalendar";

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
}

export interface EmailHeader {
  id: string;
  threadId: string;
  at: number;
  from: string;
  subject: string;
  preview: string;
}

export interface AssistantSources {
  connected(): Promise<Record<AssistantService, boolean> | null>;
  events(fromMs: number, toMs: number): Promise<CalendarEvent[]>;
  emails(sinceMs: number, limit: number): Promise<EmailHeader[]>;
  mailFrom(addresses: readonly string[], sinceMs: number): Promise<boolean>;
}

export class SourceError extends Error {
  readonly service: AssistantService;
  constructor(service: AssistantService, message: string) {
    super(message);
    this.service = service;
    this.name = "SourceError";
  }
}

export const CALENDAR_LIST_TOOL = "GOOGLECALENDAR_EVENTS_LIST";
export const GMAIL_FETCH_TOOL = "GMAIL_FETCH_EMAILS";
const MULTI_EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
const CALL_ID = "omb-assistant-call";
const PREVIEW_MAX = 300;
const ADDRESS = /^[\w.+][\w.+-]*@[\w-]+(?:\.[\w-]+)+$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const flat = (value: unknown): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");
const seconds = (ms: number): number => Math.floor(ms / 1000);

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
    if (response.successful === false) throw new Error(String(response.error ?? `${slug} failed`).slice(0, 300));
    if (!("data" in response)) throw new Error(`${slug}: the answer had no data`);
    return response.data;
  }
  if (!("data" in body)) throw new Error(`${slug}: the answer had no data`);
  return body.data;
}

function eventList(data: unknown): unknown[] {
  const top = record(data);
  for (const candidate of [data, top?.items, record(top?.response_data)?.items, top?.events]) if (Array.isArray(candidate)) return candidate;
  throw new Error("the calendar answer had no event list");
}

function calendarEvent(raw: unknown): CalendarEvent | null {
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
  };
}

export function eventsFromData(data: unknown): CalendarEvent[] {
  const list = eventList(data);
  let cancelledDropped = 0;
  const events = list.flatMap((raw) => {
    const event = calendarEvent(raw);
    if (!event && record(raw)?.status === "cancelled") cancelledDropped += 1;
    return event ? [event] : [];
  });
  if (list.length > cancelledDropped && events.length === 0) throw new Error("none of the calendar events could be read");
  return events;
}

export function emailsFromData(data: unknown): EmailHeader[] {
  const top = record(data);
  const list = Array.isArray(top?.messages) ? top.messages : Array.isArray(data) ? data : null;
  if (!list) throw new Error("the Gmail answer had no message list");
  const headers = list.flatMap((raw) => {
    const item = record(raw);
    const id = item?.messageId ?? item?.id;
    if (!item || typeof id !== "string" || !id) return [];
    const preview = record(item.preview);
    const at = typeof item.messageTimestamp === "string" ? Date.parse(item.messageTimestamp)
      : typeof item.internalDate === "string" || typeof item.internalDate === "number" ? Number(item.internalDate) : Number.NaN;
    return [{
      id,
      threadId: typeof item.threadId === "string" && item.threadId ? item.threadId : id,
      at: Number.isFinite(at) ? at : 0,
      from: flat(item.sender ?? item.from),
      subject: flat(item.subject ?? preview?.subject),
      preview: flat(preview?.body ?? item.snippet ?? item.messageText).slice(0, PREVIEW_MAX),
    }];
  });
  if (list.length > 0 && headers.length === 0) throw new Error("none of the Gmail messages could be read");
  return headers;
}

export interface ComposioSourceDeps {
  configured(): boolean;
  connectedServices(): Promise<Record<string, { connected: boolean }>>;
  relay(payload: unknown, transportSessionId?: string): Promise<{ status: number; bytes: Uint8Array; transportSessionId?: string }>;
}

export function createComposioSources(deps: ComposioSourceDeps): AssistantSources {
  async function call(service: AssistantService, slug: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const init = await deps.relay({
        jsonrpc: "2.0", id: "omb-assistant-init", method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openmausbot-assistant", version: "1" } },
      });
      if (init.status !== 200) throw new Error(`connected apps answered HTTP ${init.status}`);
      const session = init.transportSessionId;
      // Streamable-HTTP MCP servers expect the initialized notification before the first request.
      await deps.relay({ jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => undefined);
      const answer = await deps.relay({
        jsonrpc: "2.0", id: CALL_ID, method: "tools/call",
        params: { name: MULTI_EXECUTE, arguments: { tools: [{ tool_slug: slug, arguments: args }] } },
      }, session);
      if (answer.status !== 200) throw new Error(`${slug} answered HTTP ${answer.status}`);
      return toolData(slug, parseMcpResponse(new TextDecoder().decode(answer.bytes), CALL_ID));
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError(service, error instanceof Error ? error.message : String(error));
    }
  }

  function requireFinite(service: AssistantService, ...times: number[]): void {
    if (times.some((time) => !Number.isFinite(time))) throw new SourceError(service, "the time window was not a finite time");
  }

  async function gmail(query: string, limit: number): Promise<EmailHeader[]> {
    const data = await call("gmail", GMAIL_FETCH_TOOL, { user_id: "me", query, max_results: limit, include_payload: false, verbose: false });
    try {
      return emailsFromData(data);
    } catch (error) {
      throw new SourceError("gmail", error instanceof Error ? error.message : String(error));
    }
  }

  return {
    async connected() {
      if (!deps.configured()) return null;
      try {
        const services = await deps.connectedServices();
        return { gmail: services.gmail?.connected === true, googlecalendar: services.googlecalendar?.connected === true };
      } catch {
        return null;
      }
    },
    async events(fromMs, toMs) {
      requireFinite("googlecalendar", fromMs, toMs);
      const data = await call("googlecalendar", CALENDAR_LIST_TOOL, {
        calendarId: "primary", timeMin: new Date(fromMs).toISOString(), timeMax: new Date(toMs).toISOString(),
        singleEvents: true, orderBy: "startTime", maxResults: 100, showDeleted: true,
      });
      try {
        return eventsFromData(data);
      } catch (error) {
        throw new SourceError("googlecalendar", error instanceof Error ? error.message : String(error));
      }
    },
    async emails(sinceMs, limit) {
      requireFinite("gmail", sinceMs);
      return gmail(`in:inbox after:${seconds(sinceMs)} -category:promotions -category:social`, limit);
    },
    async mailFrom(addresses, sinceMs) {
      requireFinite("gmail", sinceMs);
      const valid = addresses.filter((address) => ADDRESS.test(address));
      if (!valid.length) return false;
      return (await gmail(`from:(${valid.join(" OR ")}) after:${seconds(sinceMs)}`, 1)).length > 0;
    },
  };
}
