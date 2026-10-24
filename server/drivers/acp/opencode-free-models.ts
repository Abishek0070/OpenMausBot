// Zen's free models whose provider keeps no prompt and trains on none (opencode.ai/docs/zen, 2026-10-24), best first.
// Big Pickle and MiMo may use prompts to improve their models; Beam keeps them for 30 days. The free backup runs only
// these (opencode-go.ts), and nothing the app picks on the person's behalf is another free Zen model.
import type { ModelCatalog } from "../../contracts.ts";

export const NO_RETENTION_FREE_MODELS = ["opencode/glm-5.3-flash-free", "opencode/deepseek-v4.1-flash-free"] as const;

/** OpenCode's own providers: Zen (some models free without a login) and Go (a subscription). */
export const OPENCODE_OWN_MODEL = /^opencode(?:-go)?\//u;

export const keepsNothing = (id: string): boolean => (NO_RETENTION_FREE_MODELS as readonly string[]).includes(id);

/** The best offered model that keeps nothing. */
export const keepingNothing = (offered: readonly string[]): string | undefined => NO_RETENTION_FREE_MODELS.find((id) => offered.includes(id));

/** An OpenCode ready only through Zen's free models, without the ones that may keep what they are sent: other providers'
 * and local models stay. Its default moves to one that keeps nothing, or none. */
export function withoutModelsThatMayKeep(models: ModelCatalog): ModelCatalog {
  const options = models.options.filter((option) => !OPENCODE_OWN_MODEL.test(option.id) || keepsNothing(option.id));
  const ids = options.map((option) => option.id);
  return { ...models, options, default: ids.includes(models.default) ? models.default : keepingNothing(ids) ?? "" };
}
