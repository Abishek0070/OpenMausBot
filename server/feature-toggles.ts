import type { AppConfig } from "./config.ts";

export function routinesInConversationEnabled(cfg: AppConfig): boolean {
  return cfg.features?.routinesInConversation === true;
}

export function builtInBrowserEnabled(cfg: AppConfig, _env: NodeJS.ProcessEnv = process.env): boolean {
  return cfg.features?.browser !== false;
}
