import type { AppConfig } from "./config.ts";

export function builtInBrowserEnabled(cfg: AppConfig, _env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.features?.browser !== false;
}
