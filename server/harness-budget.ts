/** How long the agent's stdio proxy waits for the harness to answer one browser, computer or data call. */
export const HARNESS_PROXY_TIMEOUT_MS = 130_000;
/** Everything the harness does for one call fits in this, so its answer reaches the proxy before the proxy gives up. */
export const HARNESS_CALL_BUDGET_MS = 120_000;

// A held send waits on the person, up to the nine-minute outbound hold.
export const HARNESS_PROXY_TIMEOUTS_MS: Partial<Record<"browser" | "computer" | "data" | "highlevel" | "device", number>> = { device: 10 * 60_000 };
