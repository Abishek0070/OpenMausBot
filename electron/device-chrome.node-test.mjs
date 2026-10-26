import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect as tcpConnect } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { chromeDataDirs, createChromeDoor, MAX_HEAD, parseDevtoolsActivePort, rewriteHandshake } from "./device-chrome.mjs";

const { WebSocketServer, WebSocket } = createRequire(import.meta.url)("ws");

const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
};

// A stand-in for Chrome: upgrades only its own browser path, and records what each request looked like.
async function fakeChrome() {
  const seen = [];
  const wss = new WebSocketServer({ noServer: true });
  const server = createHttpServer((_req, res) => { res.statusCode = 404; res.end(); });
  server.on("upgrade", (req, socket, head) => {
    seen.push({ url: req.url, host: req.headers.host, origin: req.headers.origin });
    if (req.url !== "/devtools/browser/REAL-ID") { socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on("message", (data) => ws.send(data.toString())));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { seen, port: server.address().port, close: () => { wss.clients.forEach((c) => c.terminate()); server.close(); } };
}

const withDir = async (text, body) => {
  const dir = await mkdtemp(join(tmpdir(), "chrome-door-"));
  try { if (text !== null) await writeFile(join(dir, "DevToolsActivePort"), text); return await body(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("reads DevToolsActivePort: a port and Chrome's browser path, nothing else", () => {
  assert.deepEqual(parseDevtoolsActivePort("9222\n/devtools/browser/abc-1\n"), { port: 9222, path: "/devtools/browser/abc-1" });
  for (const text of ["", "0\n/devtools/browser/x", "70000\n/devtools/browser/x", "9222\n/json/new", "9222\n/devtools/browser/../x"]) assert.equal(parseDevtoolsActivePort(text), null, JSON.stringify(text));
});

test("looks only in Chrome's own folders, in agent-browser's order", () => {
  assert.deepEqual(chromeDataDirs({ platform: "darwin", home: "/U" }), ["/U/Library/Application Support/Google/Chrome", "/U/Library/Application Support/Google/Chrome Canary", "/U/Library/Application Support/BraveSoftware/Brave-Browser"]);
  assert.deepEqual(chromeDataDirs({ platform: "win32", localAppData: "/L" }), ["/L/Google/Chrome/User Data", "/L/Google/Chrome SxS/User Data", "/L/BraveSoftware/Brave-Browser/User Data"]);
  assert.deepEqual(chromeDataDirs({ platform: "linux", home: "/h" }), ["/h/.config/google-chrome", "/h/.config/google-chrome-unstable", "/h/.config/BraveSoftware/Brave-Browser"]);
});

test("rewrites only a WebSocket upgrade to Chrome's browser or a page, with Chrome's own host and no Origin", () => {
  const target = { port: 9222, path: "/devtools/browser/REAL-ID" };
  const head = (line, ...rest) => [line, "Host: 127.0.0.1:5555", "Origin: https://evil.test", ...rest].join("\r\n");
  const upgrade = ["Upgrade: websocket", "Connection: Upgrade"];
  assert.equal(rewriteHandshake(head("GET /devtools/browser/TOKEN HTTP/1.1", ...upgrade), target),
    "GET /devtools/browser/REAL-ID HTTP/1.1\r\nHost: 127.0.0.1:9222\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  assert.match(rewriteHandshake(head("GET /devtools/browser?x=1 HTTP/1.1", "upgrade: WebSocket"), target), /^GET \/devtools\/browser\/REAL-ID HTTP/);
  assert.match(rewriteHandshake(head("GET /devtools/page/AB12 HTTP/1.1", ...upgrade), target), /^GET \/devtools\/page\/AB12 HTTP/);
  assert.equal(rewriteHandshake(head("GET /json/new?https://x HTTP/1.1", ...upgrade), target), null);
  assert.equal(rewriteHandshake(head("POST /devtools/browser/x HTTP/1.1", ...upgrade), target), null);
  assert.equal(rewriteHandshake(head("GET /devtools/browser/x HTTP/1.1"), target), null);
});

test("a door to a running Chrome upgrades end to end and passes frames unchanged", async () => {
  const chrome = await fakeChrome();
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const opened = await createChromeDoor({ dirs: [dir] }).open();
    assert.ok(opened.socket);
    const local = createServer((client) => { client.pipe(opened.socket); opened.socket.pipe(client); });
    await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${local.address().port}/devtools/browser/TOKEN`, { origin: "https://evil.test" });
    const reply = await new Promise((resolve, reject) => { ws.on("open", () => ws.send('{"id":1,"method":"Browser.getVersion"}')); ws.on("message", (d) => resolve(d.toString())); ws.on("error", reject); });
    assert.equal(reply, '{"id":1,"method":"Browser.getVersion"}');
    assert.deepEqual(chrome.seen, [{ url: "/devtools/browser/REAL-ID", host: `127.0.0.1:${chrome.port}`, origin: undefined }]);
    ws.terminate(); local.close();
  });
  chrome.close();
});

test("a request that is not a WebSocket upgrade gets 403 and never reaches Chrome", async () => {
  const chrome = await fakeChrome();
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await new Promise((resolve) => socket.write("GET /json/new?https://x HTTP/1.1\r\nHost: a\r\n\r\n", resolve));
    await closed;
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 403 Forbidden\r\n/);
    assert.deepEqual(chrome.seen, []);
  });
  chrome.close();
});

test("an oversized head is dropped", async () => {
  const chrome = await fakeChrome();
  await withDir(`${chrome.port}\n/devtools/browser/REAL-ID\n`, async (dir) => {
    const { socket } = await createChromeDoor({ dirs: [dir] }).open();
    socket.on("error", () => {});
    socket.write(Buffer.alloc(MAX_HEAD + 1, 0x61));
    await until(() => socket.destroyed, "the guard to be destroyed");
    assert.deepEqual(chrome.seen, []);
  });
  chrome.close();
});

test("no DevToolsActivePort, or a stale one whose port refuses, is no-chrome", async () => {
  await withDir(null, async (dir) => assert.deepEqual(await createChromeDoor({ dirs: [dir] }).open(), { failed: "no-chrome" }));
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  await withDir(`${port}\n/devtools/browser/REAL-ID\n`, async (dir) => assert.deepEqual(await createChromeDoor({ dirs: [dir] }).open(), { failed: "no-chrome" }));
});
