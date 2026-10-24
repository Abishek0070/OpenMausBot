// The free backup: the app's own copy of OpenCode with no key the person gave the app (server/free-fallback.ts). What it
// offers, how it is found and how it runs: only Zen's free models that keep nothing and the local models the app found.
import { DATA_DIR, OPENCODE_PROVIDER_ENV } from "../../config.ts";
import type { ModelCatalog } from "../../contracts.ts";
import { standaloneLookupPath } from "../../engine-install.ts";
import { isAppStandaloneCopy } from "../../engine-standalone.ts";
import { decodeInjectId, localHost } from "../local-inject.ts";
import { keepingNothing, keepsNothing, NO_RETENTION_FREE_MODELS } from "./opencode-free-models.ts";

/** An OpenCode key or provider key the person gave the app (Settings): what makes the app's copy their own OpenCode. */
export function signedInThroughApp(environment: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(environment.OPENCODE_API_KEY?.trim()) || OPENCODE_PROVIDER_ENV.some((key) => Boolean(environment[key]?.trim()));
}

export const appCopy = (cli: string) => isAppStandaloneCopy(cli, DATA_DIR, standaloneLookupPath());

/** The free backup (server/free-fallback.ts): the app's own copy, found the way OpenCode's processes find it, with no key
 * the person gave the app. Read from a spawn environment, where this copy keeps only such keys (applyBackupEnv). A key in
 * the server's own environment or a login left on the computer is not the person giving the app anything. */
export function backupCopy(env: Readonly<Record<string, string | undefined>>, cli: string): boolean {
  return !signedInThroughApp(env) && appCopy(cli);
}

export const BACKUP_NOT_PRIVATE = "OpenCode isn't offering a free model that keeps nothing you send right now, so the app doesn't use it.";
export const BACKUP_MAY_KEEP = "This free OpenCode model may keep what you send, so the app doesn't use it. Choose another model for this bot.";

/** A local model the app's own probe found on this computer (local-inject.ts); never an Ollama cloud model, which only
 * looks local. */
export function foundLocally(id: string): { host: string; model: string } | null {
  const inject = decodeInjectId(id);
  return inject && !inject.model.endsWith("-cloud") ? inject : null;
}

/** The backup offers only what keeps nothing: Zen's no-retention models and the local models the app found. With none of
 * the first it has no default, and its status says it isn't ready. */
export function backupCatalog(catalog: ModelCatalog): ModelCatalog {
  const options = catalog.options.filter((option) => keepsNothing(option.id) || foundLocally(option.id));
  return { ...catalog, options, default: keepingNothing(options.map((option) => option.id)) ?? "" };
}

/** Per local server the backup may use, the models found on it. */
export function localModelsOf(catalog: ModelCatalog): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const option of catalog.options) {
    const inject = foundLocally(option.id);
    if (inject) (found[inject.host] ??= []).push(inject.model);
  }
  return found;
}

const objectOr = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The backup runs with no key or login the person never gave the app, and OpenCode itself is held to Zen and the local
 * servers the app found, each pinned to its own address on this computer and to the models found there, to Zen's
 * no-retention models, and to one of them for titles and summaries (checked on OpenCode 1.19.4: enabled_providers,
 * provider whitelists and OPENCODE_AUTH_CONTENT are honoured, unknown keys ignored). The person's own
 * OPENCODE_CONFIG_CONTENT is kept underneath. */
export function applyBackupEnv(env: Record<string, string | undefined>, smallModel: string, local: Readonly<Record<string, readonly string[]>>): void {
  for (const key of ["OPENCODE_API_KEY", ...OPENCODE_PROVIDER_ENV]) delete env[key];
  env.OPENCODE_AUTH_CONTENT = "{}";
  let config: Record<string, unknown> = {};
  try {
    config = objectOr(JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? ""));
  } catch {}
  const provider = objectOr(config.provider);
  const servers = Object.entries(local).flatMap(([id, models]) => {
    const host = localHost(id);
    if (!host || !models.length) return [];
    const own = objectOr(provider[id]);
    return [[id, { ...own, options: { ...objectOr(own.options), baseURL: host.baseUrl }, whitelist: [...models] }] as const];
  });
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...config,
    enabled_providers: ["opencode", ...servers.map(([id]) => id)],
    provider: {
      ...provider,
      opencode: { ...objectOr(provider.opencode), whitelist: NO_RETENTION_FREE_MODELS.map((id) => id.slice("opencode/".length)) },
      ...Object.fromEntries(servers),
    },
    small_model: smallModel,
  });
}
