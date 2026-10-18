// A loopback stand-in for the managed connected-apps service (cloudflare/composio-broker): the connected list, and an MCP
// endpoint that answers the two Google read tools the way Composio's multi-execute tool does.
import { createServer } from "node:http";

export interface FakeConnectedApps {
  url: string;
  token: string;
  connected: Record<string, boolean>;
  /** Google Calendar event resources. */
  events: unknown[];
  /** Composio GMAIL_FETCH_EMAILS messages. */
  emails: unknown[];
  calls: Array<{ tool: string; arguments: unknown }>;
  /** While set, calendar reads wait for it before they answer. */
  holdCalendar?: Promise<void>;
  close(): Promise<void>;
}

type Frame = { id?: unknown; method?: string; params?: { name?: string; arguments?: { tools?: Array<{ tool_slug?: string; arguments?: unknown }> } } };

export async function startFakeConnectedApps(): Promise<FakeConnectedApps> {
  const fake: Omit<FakeConnectedApps, "url" | "token" | "close"> = { connected: { gmail: true, googlecalendar: true }, events: [], emails: [], calls: [] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/broker/v1/connectors/connected") {
      return res.end(JSON.stringify({ services: Object.fromEntries(Object.entries(fake.connected).map(([slug, connected]) => [slug, { connected }])) }));
    }
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
        const tool = body.params?.name === "COMPOSIO_MULTI_EXECUTE_TOOL" ? body.params.arguments?.tools?.[0] : { tool_slug: body.params?.name, arguments: body.params?.arguments };
        const slug = String(tool?.tool_slug ?? "");
        fake.calls.push({ tool: slug, arguments: tool?.arguments });
        if (slug === "GOOGLECALENDAR_EVENTS_LIST" && fake.holdCalendar) await fake.holdCalendar;
        const data = slug === "GOOGLECALENDAR_EVENTS_LIST" ? { items: fake.events } : slug === "GMAIL_FETCH_EMAILS" ? { messages: fake.emails } : {};
        const text = JSON.stringify({ successful: true, data: { results: [{ tool_slug: slug, response: { successful: true, data, error: null } }] }, error: null });
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
