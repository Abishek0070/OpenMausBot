// The lent computer's own way to its Chrome, for a bot on My Cloud. It finds Chrome's DevTools port itself, from the
// DevToolsActivePort file Chrome writes, connects to 127.0.0.1 only, and lets through nothing but the WebSocket upgrade.
import { readFile as readFileFs } from "node:fs/promises";
import { connect as tcpConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";

export const DEVTOOLS_FILE = "DevToolsActivePort";
export const MAX_HEAD = 16 * 1024;
const CONNECT_MS = 10_000;
const FORBIDDEN = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
const BROWSER_PATH = /^\/devtools\/browser(?:[/?].*)?$/;
const PAGE_PATH = /^\/devtools\/page\/[A-Za-z0-9-]+$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Chrome's own profile folders, in the order agent-browser looks. */
export function chromeDataDirs({ platform, home = "", localAppData = "" }) {
  if (platform === "win32") return ["Google/Chrome/User Data", "Google/Chrome SxS/User Data", "BraveSoftware/Brave-Browser/User Data"].map((dir) => join(localAppData, dir));
  if (platform === "darwin") return ["Google/Chrome", "Google/Chrome Canary", "BraveSoftware/Brave-Browser"].map((dir) => join(home, "Library/Application Support", dir));
  return ["google-chrome", "google-chrome-unstable", "BraveSoftware/Brave-Browser"].map((dir) => join(home, ".config", dir));
}

/** Chrome's DevToolsActivePort file: the port, then its `/devtools/browser/<id>` path. Anything else is null. */
export function parseDevtoolsActivePort(text) {
  const [first, second] = String(text).split(/\r?\n/);
  if (!/^\d{1,5}$/.test(first ?? "")) return null;
  const port = Number(first);
  if (port < 1 || port > 65535 || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(second ?? "")) return null;
  return { port, path: second };
}

/**
 * The request head (request line and headers, no final blank line) as Chrome should see it, or null to refuse. Only a
 * WebSocket upgrade to the browser or a page passes. Chrome answers 404 to a browser path that isn't its own, so that
 * path becomes Chrome's; Host is Chrome's and Origin goes, or Chrome refuses a connection that did not come from a page.
 */
export function rewriteHandshake(head, target) {
  const [requestLine, ...headers] = head.split("\r\n");
  const request = /^GET (\S+) HTTP\/1\.1$/.exec(requestLine);
  if (!request) return null;
  let path = request[1];
  if (BROWSER_PATH.test(path)) path = target.path;
  else if (!PAGE_PATH.test(path)) return null;
  const kept = [];
  let upgrade = false;
  let host = false;
  for (const line of headers) {
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon) : "";
    if (!HEADER_NAME.test(name)) return null;
    const key = name.toLowerCase();
    if (key === "origin") continue;
    if (key === "upgrade" && line.slice(colon + 1).trim().toLowerCase() === "websocket") upgrade = true;
    if (key === "host") { if (!host) kept.push(`Host: 127.0.0.1:${target.port}`); host = true; continue; }
    kept.push(line);
  }
  if (!upgrade) return null;
  if (!host) kept.unshift(`Host: 127.0.0.1:${target.port}`);
  return `GET ${path} HTTP/1.1\r\n${kept.join("\r\n")}\r\n\r\n`;
}

// The stream the link sees. Writes wait in `head` until the request is whole; then they either reach Chrome rewritten
// or get a 403. Chrome's side ending or closing closes this one, and the reverse.
function createGuard(chrome, target) {
  let head = Buffer.alloc(0);
  let state = "head";
  const guard = new Duplex({
    write(chunk, _encoding, callback) {
      if (state === "open") { chrome.write(chunk, callback); return; }
      if (state === "refused") { callback(); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > MAX_HEAD) guard.destroy();
        else callback();
        return;
      }
      const rewritten = end <= MAX_HEAD ? rewriteHandshake(head.subarray(0, end).toString("latin1"), target) : null;
      if (rewritten === null) {
        // Not ours to forward: answer, and let go of Chrome without that closing the answer's stream.
        state = "refused";
        chrome.removeAllListeners();
        chrome.on("error", () => {});
        chrome.destroy();
        guard.push(FORBIDDEN);
        guard.push(null);
        callback();
        process.nextTick(() => { if (!guard.writableEnded) guard.end(); });
        return;
      }
      state = "open";
      const rest = head.subarray(end + 4);
      head = Buffer.alloc(0);
      chrome.write(Buffer.concat([Buffer.from(rewritten, "latin1"), rest]), callback);
    },
    final(callback) { if (state === "open") chrome.end(); callback(); },
    read() { chrome.resume(); },
    destroy(error, callback) { chrome.destroy(); callback(error); },
  });
  chrome.on("data", (data) => { if (!guard.push(data)) chrome.pause(); });
  chrome.on("end", () => guard.push(null));
  chrome.on("close", () => guard.destroy());
  chrome.on("error", (error) => guard.destroy(error));
  return guard;
}

async function findChrome(dirs, readFile) {
  for (const dir of dirs) {
    try {
      const found = parseDevtoolsActivePort(await readFile(join(dir, DEVTOOLS_FILE), "utf8"));
      if (found) return found;
    } catch { /* no file here */ }
  }
  return null;
}

/**
 * `open()` answers `{ socket }` once connected to Chrome, or `{ failed }`: "no-chrome" (no file, or Chrome closed and
 * left it behind), "timeout" or "unreachable". `dirs`, `readFile` and `connect` are injectable for tests.
 */
export function createChromeDoor({
  dirs = chromeDataDirs({ platform: process.platform, home: homedir(), localAppData: process.env.LOCALAPPDATA }),
  readFile = readFileFs, connect = tcpConnect, connectMs = CONNECT_MS,
} = {}) {
  return {
    async open() {
      const target = await findChrome(dirs, readFile);
      if (!target) return { failed: "no-chrome" };
      return new Promise((settle) => {
        const socket = connect({ host: "127.0.0.1", port: target.port });
        const done = (result) => { clearTimeout(timer); socket.off("connect", opened); socket.off("error", failed); settle(result); };
        const opened = () => done({ socket: createGuard(socket, target) });
        const failed = (error) => { socket.destroy(); done({ failed: error?.code === "ECONNREFUSED" ? "no-chrome" : "unreachable" }); };
        const timer = setTimeout(() => { socket.destroy(); done({ failed: "timeout" }); }, connectMs);
        socket.once("connect", opened);
        socket.once("error", failed);
      });
    },
  };
}
