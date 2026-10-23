// The connected-apps routes (Composio): the catalog, what is connected, each app's tools for the per-bot picker, and
// connecting or removing an app or one of its accounts.
import * as composio from "../composio.ts";
import type { AppConfig } from "../config.ts";
import type { HighLevelHost } from "../highlevel/host.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface ConnectorRouteDeps {
  cfg: AppConfig;
  /** HighLevel's tools are listed beside the connected apps' in the per-bot tool picker. */
  highlevelHost: Pick<HighLevelHost, "toolListing">;
  /** The desktop app or a Cloud home: the managed service comes with this host, so a missing one is an outage. */
  managedHost: boolean;
}

export function createConnectorRoutes(deps: ConnectorRouteDeps): RouteHandler {
  const { cfg, highlevelHost, managedHost } = deps;
  return async ({ req, res, url, path, method, json, readBody }) => {
    if (method === "GET" && path === "/api/connectors/catalog") {
      const { cards, source, pagination } = await composio.listToolkits(cfg);
      return json(res, 200, {
        configured: composio.configured(cfg),
        mode: composio.connectionMode(cfg),
        setup: composio.connectorSetup(cfg, managedHost),
        source,
        cards,
        ...(pagination ? { pagination } : {}),
      });
    }
    if (method === "GET" && path === "/api/connectors/connected") {
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      const inventory = await composio.connectedServicesInventory(cfg);
      return json(res, 200, {
        configured: true,
        credentialStore: "ok",
        inventoryComplete: inventory.complete,
        services: inventory.services,
      });
    }
    if (method === "GET" && path === "/api/connectors/tools") {
      const availability = composio.connectorAvailability(cfg);
      const highlevelTools = highlevelHost.toolListing();
      if (availability !== "configured") {
        return json(res, 200, { configured: Boolean(highlevelTools), services: { ...highlevelTools } });
      }
      try {
        return json(res, 200, { configured: true, services: { ...await composio.listConnectorTools(cfg), ...highlevelTools } });
      } catch (e) {
        return json(res, 502, { configured: true, services: {}, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (method === "GET" && path === "/api/connectors") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      const availability = composio.connectorAvailability(cfg);
      if (availability !== "configured") {
        return json(res, 200, {
          configured: false,
          credentialStore: availability === "unreadable" ? "unavailable" : "ok",
          services: {},
        });
      }
      const status = await composio.connectionStatus(cfg, services.length ? services : composio.CURATED_SLUGS);
      return json(res, 200, { configured: true, services: status });
    }
    let m = path.match(/^\/api\/connectors\/([\w-]+)\/authorize$/);
    if (m && method === "POST") {
      const body = await readBody(req);
      return json(res, 200, await composio.authorizeService(cfg, m[1], body.alias));
    }
    m = path.match(/^\/api\/connectors\/([\w-]+)\/accounts\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeAccount(cfg, m[1], m[2]));
    m = path.match(/^\/api\/connectors\/([\w-]+)$/);
    if (m && method === "DELETE") return json(res, 200, await composio.removeService(cfg, m[1]));
    return PASS;
  };
}
