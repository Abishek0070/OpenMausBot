import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { PRESENCE_FILE } from "./host/presence.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { openSse } from "./testing/sse.ts";

const HOUR = 60 * 60_000;

function findNode(node: any, match: (node: any) => boolean): any {
  if (!node || typeof node !== "object") return undefined;
  if (match(node)) return node;
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const found = findNode(child, match);
    if (found) return found;
  }
  return undefined;
}

it("posts one recap card in the Chief's chat when the person comes back after a night away", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, expected = 200) => {
    const response = await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json", origin: url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", url]);
  const bot = async (id: string) => (await api("GET", "/api/bots?messages=0")).bots.find((candidate: any) => candidate.id === id);
  try {
    const chief = await bot(((await control(["new-bot", "--name", "Chief"])) as any).bot.id);
    const scout = await bot(((await control(["new-bot", "--name", "Scout"])) as any).bot.id);
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    expect((await bot(chief.id)).chiefOfStaff).toBe(true);
    const chiefUnread = async () => (await bot(chief.id)).tasks.find((task: any) => task.threadId === chief.threadId).unread === true;
    await api("POST", `/api/bots/${chief.id}/read`, { threadId: chief.threadId });
    expect(await chiefUnread()).toBe(false);

    // The person is here now (nothing to recap yet), then Scout works while they are away.
    expect(await api("POST", "/api/presence/active", { source: "desktop", timeZone: "Asia/Kolkata" })).toEqual({ ok: true, returned: false });
    await control(["send", "--bot", scout.id, "--task", scout.threadId, "--text", "Finish the report."]);
    await control(["wait", "--bot", scout.id, "--task", scout.threadId]);
    const scoutLines = (await api("GET", `/api/threads/${scout.threadId}/messages`)).messages;
    expect(scoutLines.some((line: any) => line.kind === "digest")).toBe(true);
    const { routine } = await api("POST", "/api/routines", {
      name: "Overnight numbers", prompt: "Count the numbers.", botId: scout.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + HOUR },
    }, 201);
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, undefined, 201);
    await expect.poll(async () => (await api("GET", "/api/routines")).runs.find((candidate: any) => candidate.id === run.id)?.status, { timeout: 15_000 }).toBe("completed");

    // Nine hours pass with the app closed: the stored activation is moved back and the server restarted on the same data.
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const presenceFile = join(dataDir, PRESENCE_FILE);
    const saved = JSON.parse(readFileSync(presenceFile, "utf8"));
    const awaySince = saved.lastActiveAt - 9 * HOUR;
    writeFileSync(presenceFile, JSON.stringify({ ...saved, lastActiveAt: awaySince }));
    // The routine run started before the person left and finished after: it belongs in the recap.
    const routinesFile = join(dataDir, "routines.json");
    const routines = JSON.parse(readFileSync(routinesFile, "utf8"));
    const savedRun = routines.runs.find((candidate: any) => candidate.id === run.id);
    expect(savedRun.finishedAt).toBeGreaterThan(awaySince);
    Object.assign(savedRun, { scheduledFor: awaySince - HOUR, createdAt: awaySince - HOUR, startedAt: awaySince - HOUR });
    writeFileSync(routinesFile, JSON.stringify(routines));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      if (restarted?.exitCode !== null) return true;
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
    if (restarted.exitCode !== null) throw new Error(`the restarted server exited; see ${logPath}`);

    // An open event stream is not the person, so the desktop's call ends the absence: one recap, both clients told to open it.
    const events = await openSse(`${url}/api/events`);
    const open = { botId: chief.id, threadId: chief.threadId };
    const desktop = await api("POST", "/api/presence/active", { source: "desktop", timeZone: "Asia/Kolkata" });
    const phone = await api("POST", "/api/presence/active", { source: "phone" });
    expect(desktop).toMatchObject({ ok: true, returned: true, open });
    expect(phone).toMatchObject({ ok: true, returned: false, open });
    await events.until((frame) => frame.kind === "message" && frame.threadId === chief.threadId && frame.message?.kind === "widget");
    events.close();
    const cards = (await api("GET", `/api/threads/${chief.threadId}/messages`)).messages.filter((line: any) => line.kind === "widget");
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toContain("**Since you last looked**");
    expect(cards[0].text).toContain("Scout");
    expect(cards[0].text).toContain("Overnight numbers");
    expect(JSON.stringify(cards[0].widget.root)).toContain(`"open_thread"`);
    expect(JSON.stringify(cards[0].widget.root)).toContain(scout.threadId);
    expect(await chiefUnread()).toBe(true);
    const button = findNode(cards[0].widget.root, (node) => node.type === "Button" && node.onClickAction?.payload?.threadId === scout.threadId);
    expect(button?.id).toBeTruthy();
    expect(await api("POST", `/api/bots/${chief.id}/messages`, { threadId: chief.threadId, widgetAction: { messageId: cards[0].id, ref: button.id, rev: 0 } }, 400)).toEqual({ error: "That action opens on the device and is not sent." });
    expect(await api("POST", "/api/presence/active", { source: "desktop" })).toEqual({ ok: true, returned: false });
    expect((await api("GET", `/api/threads/${chief.threadId}/messages`)).messages.filter((line: any) => line.kind === "widget")).toHaveLength(1);
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
