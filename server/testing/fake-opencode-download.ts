// Test only, loaded with `node --import` before server/index.ts: the OpenCode build this app pins for this computer
// becomes a fake one, served from a file instead of GitHub. A real server's background install then downloads, checks,
// unpacks, probes and activates it exactly as it would the real build, without the network or the real hashes.
// FAKE_OPENCODE_BUILD names a JSON file the test wrote: { key, archive, sha256, executableSha256, bytes, log }.
// Every download served appends its URL to `log`.
import { appendFileSync, readFileSync } from "node:fs";

import { OPENCODE_STANDALONE } from "../drivers/acp/opencode-release.ts";

interface FakeBuild {
  key: string;
  archive: string;
  sha256: string;
  executableSha256: string;
  bytes: number;
  log: string;
}

const build = JSON.parse(readFileSync(process.env.FAKE_OPENCODE_BUILD!, "utf8")) as FakeBuild;
const real = (OPENCODE_STANDALONE.assets as Record<string, { url: string } | undefined>)[build.key];
if (!real) throw new Error(`OpenCode pins no build for ${build.key}`);
const url = real.url;
OPENCODE_STANDALONE.assets = {
  [build.key]: { url, archive: "zip", executable: "opencode", approxBytes: build.bytes, sha256: build.sha256, executableSha256: build.executableSha256 },
};
// The fake is not signed by Anomaly.
delete OPENCODE_STANDALONE.macTeamId;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const asked = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (asked !== url) return realFetch(input, init);
  appendFileSync(build.log, `${asked}\n`);
  const body = readFileSync(build.archive);
  return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
}) as typeof fetch;
