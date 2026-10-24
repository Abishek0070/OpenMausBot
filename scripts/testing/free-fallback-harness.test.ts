// A server started outside vitest and outside a sealed fixture installs OpenCode's free backup on its own when no AI can
// answer (server/free-fallback.ts): a real download from GitHub. Every script that boots such a server for a check, the
// release workflow's smokes among them, turns it off.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../../", import.meta.url);
const HARNESSES = [
  "scripts/smoke-packaged-server.mjs",
  "scripts/smoke-linux-package.mjs",
  "scripts/smoke-login-handoff.cjs",
  "scripts/smoke-approval-modes.cjs",
  "scripts/smoke-phone-relay-auth.cjs",
  "scripts/verify-company-backups.mjs",
  "scripts/verify-server-recovery.mjs",
  "scripts/verify-workspace-backup.ts",
];

describe("scripts that boot a server for a check", () => {
  it.each(HARNESSES)("%s starts it with the free backup off", (file) => {
    expect(readFileSync(fileURLToPath(new URL(file, ROOT)), "utf8")).toMatch(/OMB_FREE_FALLBACK: "0"/);
  });
});
