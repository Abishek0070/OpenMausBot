import { describe, expect, it } from "vitest";

import { parseWidgetInput, WIDGET_LIMITS, widgetActions } from "../../shared/widget.ts";
import type { CalendarEvent } from "../assistant-sources.ts";
import {
  attendeeNames, BRIEF_MAX, BRIEF_ROWS, briefCard, briefFallbackCard, clockTime, cancelledCard, DISMISS_ACTION, emailCard, gmailUrl, meetingWhen, prepCard, reminderCard, updateCard,
  type BriefEmail, type BriefFacts, type BriefMeeting, type BuiltCard,
} from "./assistant-cards.ts";
import { clip } from "./text-clip.ts";

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 17, 11, 0, 0); // 16:30 in Kolkata
const ZONE = "Asia/Kolkata";
const demo: CalendarEvent = {
  id: "demo-1", title: "Supamaus demo with Jake", start: Date.UTC(2026, 9, 17, 17, 0), end: Date.UTC(2026, 9, 17, 17, 30), allDay: false, status: "confirmed", selfDeclined: false,
  attendees: [{ email: "me@example.test", self: true, organizer: true }, { email: "jake@pin.example", name: "Jake Price", self: false, organizer: false }],
  joinUrl: "https://meet.google.com/abc-defg-hij",
};
const EMPTY_BRIEF: BriefFacts = { now: NOW, missing: [], replies: [], repliesChecking: false, repliesUnreadable: [], failedRoutines: [], clashes: [], meetings: [], important: [], routines: [] };
const briefMeeting = (more: Partial<BriefMeeting> = {}): BriefMeeting => ({ title: "Demo", start: demo.start, end: demo.end, accounts: "", status: "Prep ready", ...more });

function valid(built: BuiltCard) {
  const parsed = parseWidgetInput(built.card);
  expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
  expect(JSON.stringify(built.card).length).toBeLessThan(WIDGET_LIMITS.bytes);
  return { root: built.card as any, actions: widgetActions(parsed.ok ? parsed.value : built.card) };
}

describe("MausBot's cards", () => {
  it("words the time in the person's zone with plain spaces", () => {
    expect(meetingWhen(demo.start, demo.end, ZONE, NOW)).toBe("Today, 10:30 PM to 11:00 PM");
    expect(meetingWhen(demo.start + 24 * 60 * MINUTE, demo.end + 24 * 60 * MINUTE, ZONE, NOW)).toBe("Tomorrow, 10:30 PM to 11:00 PM");
    expect(attendeeNames(demo)).toBe("Jake Price");
    expect(attendeeNames({ ...demo, attendees: [...demo.attendees, { email: "ada@example.test", self: false, organizer: false }, { email: "bo@example.test", self: false, organizer: false }] })).toBe("Jake Price and 2 others");
  });

  it("labels a time UTC when no zone is known, once per meeting, and never a time in a known zone", () => {
    expect(meetingWhen(demo.start, demo.end, undefined, NOW)).toBe("Today, 5:00 PM to 5:30 PM UTC");
    expect(meetingWhen(demo.start, demo.end, "Not/A_Zone", NOW)).toBe("Today, 5:00 PM to 5:30 PM UTC");
    expect(clockTime(demo.start, undefined)).toBe("5:00 PM UTC");
    expect(clockTime(demo.start, "UTC")).toBe("5:00 PM");
    expect(clockTime(demo.start, ZONE)).toBe("10:30 PM");
    expect(JSON.stringify(valid(briefCard({ ...EMPTY_BRIEF, meetings: [briefMeeting()] })).root)).toContain("5:00 PM UTC · Demo");
    expect(JSON.stringify(valid(cancelledCard({ title: "Demo", start: demo.start, now: NOW })).root)).toContain("Was Today, 5:00 PM UTC");
  });

  it("preps with the brief, Join from the calendar, Open for a known chat and Draft a follow-up", () => {
    const built = prepCard({ event: demo, brief: "## Who\nJake Price, Head of Customer Success at Pin.", related: { botId: "scout", threadId: "scout-main" }, timeZone: ZONE, now: NOW });
    const { root, actions } = valid(built);
    expect(root.title).toBe("Prep: Supamaus demo with Jake");
    expect(root.caption).toBe("Today, 10:30 PM to 11:00 PM");
    expect(actions.map((entry) => [entry.label, entry.action.type])).toEqual([["Join", "open_url"], ["Open", "open_thread"], ["Draft a follow-up", "draft_followup"]]);
    expect(actions[0]!.action.payload).toEqual({ url: "https://meet.google.com/abc-defg-hij" });
    expect(built.summary).toBe("Prep ready: Supamaus demo with Jake, Today, 10:30 PM to 11:00 PM");
    const bare = valid(prepCard({ event: { ...demo, joinUrl: undefined }, brief: "x".repeat(9_000), timeZone: ZONE, now: NOW }));
    expect(bare.actions.map((entry) => entry.label)).toEqual(["Draft a follow-up"]);
    expect(JSON.stringify(bare.root).length).toBeLessThan(WIDGET_LIMITS.bytes);
  });

  it("reminds with the minutes left, Join and Prep notes, and the since-last-time line when there is one", () => {
    const { root, actions } = valid(reminderCard({ event: demo, line: "Jake asked for pricing.", timeZone: ZONE, now: demo.start - 10 * MINUTE }));
    expect(root.title).toBe("Call with Jake Price in 10 minutes");
    expect(JSON.stringify(root)).toContain("Since last time: Jake asked for pricing.");
    expect(actions.map((entry) => entry.label)).toEqual(["Join", "Prep notes"]);
    expect(valid(reminderCard({ event: demo, timeZone: ZONE, now: demo.start - 30_000 })).root.title).toBe("Call with Jake Price in 1 minute");
  });

  it("flags an email with why and what to do, Open in Gmail on its own thread, and Draft a reply", () => {
    const built = emailCard({ email: { id: "important-1", account: "g1", threadId: "thread/1", at: NOW, from: "Ada <ada@example.test>", subject: "Q3 numbers due Friday", preview: "" }, why: "Ada needs the numbers by Friday.", action: "Send the Q3 numbers." });
    const { root, actions } = valid(built);
    expect([root.title, root.caption]).toEqual(["Q3 numbers due Friday", "From Ada <ada@example.test>"]);
    expect(actions.map((entry) => entry.label)).toEqual(["Open in Gmail", "Draft a reply"]);
    expect(actions[0]!.action.payload).toEqual({ url: gmailUrl("thread/1") });
    expect(gmailUrl("thread/1")).toBe("https://mail.google.com/mail/#all/thread%2F1");
    expect(built.summary).toBe("Important email from Ada: Q3 numbers due Friday");
  });

  it("updates and cancels in a line, with no buttons a cancelled meeting cannot use", () => {
    expect(valid(updateCard({ event: demo, text: "Moved to 11 PM; Ada joins.", timeZone: ZONE, now: NOW })).root.title).toBe("Changed: Supamaus demo with Jake");
    const cancelled = valid(cancelledCard({ title: "Supamaus demo with Jake", start: demo.start, timeZone: ZONE, now: NOW }));
    expect(cancelled.root.title).toBe("Cancelled: Supamaus demo with Jake");
    expect(cancelled.actions).toEqual([]);
  });
});

describe("untrusted links and all-day events", () => {
  const refused = ["javascript:alert(1)", "data:text/html,<b>x</b>", "http://meet.example.test/a", "file:///etc/passwd", "ftp://meet.example.test/a", "not a url", "//meet.example.test/a", ""];

  it("shows Join only for an https joinUrl, on every card that has one", () => {
    for (const joinUrl of refused) {
      const event = { ...demo, joinUrl };
      const labels = (built: BuiltCard) => valid(built).actions.map((entry) => entry.label);
      expect(labels(prepCard({ event, brief: "x", timeZone: ZONE, now: NOW })), joinUrl).toEqual(["Draft a follow-up"]);
      expect(labels(reminderCard({ event, timeZone: ZONE, now: demo.start - 10 * MINUTE })), joinUrl).toEqual(["Prep notes"]);
      expect(labels(updateCard({ event, text: "Moved.", timeZone: ZONE, now: NOW })), joinUrl).toEqual([]);
      expect(labels(briefCard({ ...EMPTY_BRIEF, timeZone: ZONE, meetings: [briefMeeting({ joinUrl })] })), joinUrl).toEqual([]);
    }
  });

  it("keeps a thread id from changing the Gmail link", () => {
    for (const id of ["thread/1", "../../x?y=1#z", "a b%2F", "\u202eevil", "javascript:1"]) {
      const url = gmailUrl(id);
      const tail = url.slice("https://mail.google.com/mail/#all/".length);
      expect(url.startsWith("https://mail.google.com/mail/#all/"), id).toBe(true);
      expect(tail, id).not.toMatch(/[/?#\s\u202e]/);
      expect(decodeURIComponent(tail)).toBe(id);
      const parsed = new URL(url);
      expect([parsed.origin, parsed.pathname, parsed.search]).toEqual(["https://mail.google.com", "/mail/", ""]);
    }
  });

  it("words an all-day event by its date in the person's zone, never as a clock time", () => {
    const allDay = { ...demo, allDay: true, start: Date.UTC(2026, 9, 17), end: Date.UTC(2026, 9, 18), joinUrl: undefined };
    for (const zone of [ZONE, "America/Los_Angeles"]) {
      expect(meetingWhen(allDay.start, allDay.end, zone, NOW, true), zone).toBe("Today, all day");
      expect(meetingWhen(allDay.start + DAY_MS, allDay.end + DAY_MS, zone, NOW, true), zone).toBe("Tomorrow, all day");
    }
    expect(valid(updateCard({ event: allDay, text: "Renamed.", timeZone: "America/Los_Angeles", now: NOW })).root.caption).toBe("Today, all day");
    expect(valid(cancelledCard({ title: "Offsite", start: allDay.start, allDay: true, timeZone: ZONE, now: NOW })).root.caption).toBe("Was Today, all day");
  });
});

const noLoneSurrogate = (value: string) => expect(value).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
const strings = (node: unknown): string[] => (typeof node === "string" ? [node] : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);

describe("clipping and plain text", () => {
  it("clips by UTF-16 units and never splits a surrogate pair", () => {
    expect(clip("😀".repeat(10), 5)).toBe("😀😀…");
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 4)).toBe("abc");
    for (let max = 1; max < 12; max++) {
      const out = clip("a😀b😀c😀d😀e", max);
      expect(out.length).toBeLessThanOrEqual(max);
      noLoneSurrogate(out);
    }
  });

  it("keeps a card valid when emoji fill the subject, why and title", () => {
    const emoji = "😀".repeat(200);
    const email = valid(emailCard({ email: { id: "m", account: "g1", threadId: "t", at: NOW, from: emoji, subject: emoji, preview: "" }, why: "🚀".repeat(2_500), action: `a${"😀".repeat(2_500)}` }));
    const prep = valid(prepCard({ event: { ...demo, title: emoji, location: emoji }, brief: `x${"😀".repeat(7_000)}`, timeZone: ZONE, now: NOW }));
    const mixed = valid(updateCard({ event: { ...demo, title: `é${emoji}日本` }, text: `日本${"😀a".repeat(1_500)}`, timeZone: ZONE, now: NOW }));
    for (const built of [email, prep, mixed]) strings(built.root).forEach(noLoneSurrogate);
  });

  it("shows no Join for an over-long link or one with a username or password", () => {
    const long = `https://meet.example.test/${"a".repeat(2_000)}`;
    for (const joinUrl of [long, "https://user:pw@meet.example.test/a", "https://user@meet.example.test/a"]) {
      expect(valid(prepCard({ event: { ...demo, joinUrl }, brief: "x", timeZone: ZONE, now: NOW })).actions.map((entry) => entry.label), joinUrl).toEqual(["Draft a follow-up"]);
    }
    const edge = `https://meet.example.test/${"a".repeat(1_900)}`;
    expect(valid(prepCard({ event: { ...demo, joinUrl: edge }, brief: "x", timeZone: ZONE, now: NOW })).actions[0]!.label).toBe("Join");
    expect(valid(emailCard({ email: { id: "m", account: "g1", threadId: "t".repeat(3_000), at: NOW, from: "a", subject: "s", preview: "" }, why: "w", action: "a" })).actions.map((entry) => entry.label)).toEqual(["Draft a reply"]);
  });

  it("renders the brief as literal text, with no link, image or HTML node", () => {
    const brief = "## Who\n![x](https://evil.example/p.png)\n[click](javascript:alert(1))\n<img src=x>\n- a bullet";
    const { root } = valid(prepCard({ event: demo, brief, timeZone: ZONE, now: NOW }));
    const types = JSON.stringify(root).match(/"type":"([^"]+)"/g)!.map((entry) => entry.slice(8, -1));
    for (const forbidden of ["Markdown", "Image", "Link"]) expect(types).not.toContain(forbidden);
    const values = root.children.filter((node: any) => node.type === "Text").map((node: any) => node.value);
    expect(values).toEqual(["## Who", "![x](https://evil.example/p.png)", "[click](javascript:alert(1))", "<img src=x>", "- a bullet"]);
    const many = valid(prepCard({ event: demo, brief: "a\n".repeat(3_000), timeZone: ZONE, now: NOW }));
    expect(many.root.children.length).toBeLessThan(130);
    expect(BRIEF_MAX).toBe(WIDGET_LIMITS.markdown);
  });

  it("reads a sender made of a long whitespace run without backtracking", () => {
    const started = performance.now();
    const built = emailCard({ email: { id: "m", account: "g1", threadId: "t", at: NOW, from: `a${" ".repeat(5_000)}x`, subject: "Hi", preview: "" }, why: "w", action: "a" });
    expect(performance.now() - started).toBeLessThan(250);
    expect(built.summary.length).toBeLessThanOrEqual(140);
  });

  it("writes every summary as one short line, and the email's without the preview", () => {
    const nasty = `Title\nwith\n\nlines ${"😀".repeat(300)}`;
    const email = emailCard({ email: { id: "m", account: "g1", threadId: "t", at: NOW, from: `"Ada Lovelace" <ada@example.test>`, subject: nasty, preview: "SECRET PREVIEW" }, why: "w", action: "a" });
    const bare = emailCard({ email: { id: "m", account: "g1", threadId: "t", at: NOW, from: "<ada@example.test>", subject: "Hi", preview: "SECRET PREVIEW" }, why: "w", action: "a" });
    const built = [
      email, bare,
      prepCard({ event: { ...demo, title: nasty }, brief: "x", timeZone: ZONE, now: NOW }),
      updateCard({ event: demo, text: `Moved.\n${"long ".repeat(200)}`, timeZone: ZONE, now: NOW }),
      reminderCard({ event: { ...demo, title: nasty }, timeZone: ZONE, now: demo.start - 10 * MINUTE }),
      cancelledCard({ title: nasty, start: demo.start, timeZone: ZONE, now: NOW }),
    ];
    for (const entry of built) {
      expect(entry.summary).not.toMatch(/\s{2}|\n/);
      expect(entry.summary.length).toBeLessThanOrEqual(140);
      noLoneSurrogate(entry.summary);
      expect(entry.summary).not.toContain("SECRET PREVIEW");
    }
    expect(bare.summary).toBe("Important email from ada@example.test: Hi");
    expect(email.summary.startsWith("Important email from Ada Lovelace: Title with lines")).toBe(true);
  });

  it("reads an all-day event by its UTC date at a UTC midnight, for people at UTC-8 and UTC+5:30", () => {
    const start = Date.UTC(2026, 9, 17);
    const cases: Array<[string, number, string]> = [
      ["Etc/GMT+8", start - 60_000, "Tomorrow, all day"],
      ["Etc/GMT+8", start + 60_000, "Tomorrow, all day"],
      ["Etc/GMT+8", start + 8 * 60 * MINUTE - 60_000, "Tomorrow, all day"],
      ["Etc/GMT+8", start + 8 * 60 * MINUTE + 60_000, "Today, all day"],
      ["Asia/Kolkata", start - 60_000, "Today, all day"],
      ["Asia/Kolkata", start + 60_000, "Today, all day"],
      ["Asia/Kolkata", start - 5.5 * 60 * MINUTE - 60_000, "Tomorrow, all day"],
      ["Asia/Kolkata", start + DAY_MS - 5.5 * 60 * MINUTE + 60_000, "Sat, Oct 17, all day"],
    ];
    for (const [zone, now, expected] of cases) {
      // the last row is the day after: the event is then in the past and reads as its own date
      expect(meetingWhen(start, start + DAY_MS, zone, now, true), `${zone} ${new Date(now).toISOString()}`).toBe(expected);
    }
  });
});

describe("account naming on cards", () => {
  const email = { id: "m", account: "g1", threadId: "t", at: NOW, from: "Ada <ada@example.test>", subject: "Hi", preview: "" };

  it("flags an email with the account it reached, opens Gmail in that account, and drafts from it", () => {
    const { root, actions } = valid(emailCard({ email: { ...email, account: "ca_g2" }, why: "w", action: "a", account: "admin@example.test", address: "admin@example.test" }));
    expect(root.caption).toBe("From Ada <ada@example.test> · to admin@example.test");
    expect(actions.find((entry) => entry.label === "Open in Gmail")?.action.payload).toEqual({ url: "https://mail.google.com/mail/u/admin%40example.test/#all/t" });
    expect(actions.find((entry) => entry.label === "Draft a reply")?.action.payload).toEqual({ messageId: "m", account: "ca_g2" });
  });

  it("keeps today's link when no address is known", () => {
    expect(gmailUrl("t")).toBe("https://mail.google.com/mail/#all/t");
  });

  it("names the accounts a meeting is on in the prep, reminder and update captions", () => {
    for (const built of [prepCard({ event: demo, brief: "b", timeZone: ZONE, now: NOW, accounts: "me@example.test, admin@example.test" }),
      reminderCard({ event: demo, timeZone: ZONE, now: demo.start - 10 * MINUTE, accounts: "admin@example.test" }), updateCard({ event: demo, text: "t", timeZone: ZONE, now: NOW, accounts: "admin@example.test" })]) {
      expect(valid(built).root.caption).toContain("admin@example.test");
    }
  });
});

describe("the daily brief", () => {
  const reply: BriefEmail = { accountId: "ca_g2", account: "admin@example.test", address: "admin@example.test", messageId: "m1", threadId: "t1", from: "Ada <ada@example.test>", subject: "Q3 numbers due Friday" };
  const meeting: BriefMeeting = { title: "Supamaus demo with Jake", start: demo.start, end: demo.end, accounts: "me@example.test, admin@example.test", status: "Prep ready", joinUrl: demo.joinUrl };
  const empty: BriefFacts = { ...EMPTY_BRIEF, timeZone: ZONE };
  const full: BriefFacts = {
    ...empty,
    replies: [{ ...reply, accountId: "ca_g1", account: "me@example.test", address: "me@example.test", messageId: "m0", threadId: "t0", from: "Jake Price <jake@pin.example>", subject: "Pricing for Pin" }],
    failedRoutines: [{ name: "Weekly report", status: "failed", line: "The sheet was not shared.", open: { botId: "scout", threadId: "run-1" } }],
    clashes: [{ first: { title: "Standup", start: Date.UTC(2026, 9, 17, 12, 0), accounts: "me@example.test" }, second: { title: "Design review", start: Date.UTC(2026, 9, 17, 12, 15), accounts: "admin@example.test" } }],
    meetings: [{ title: "Focus", start: Date.UTC(2026, 9, 17, 13, 0), end: Date.UTC(2026, 9, 17, 14, 0), accounts: "me@example.test", status: "Just you" }, meeting],
    important: [{ ...reply, messageId: "i1", why: "Deadline Friday." }],
    routines: [{ name: "Morning news", status: "completed", line: "Three stories on AI chips.", open: { botId: "scout", threadId: "run-2" } }],
  };
  const sent = (built: BuiltCard) => valid(built).actions.filter((entry) => !entry.client).map((entry) => entry.label);
  const nodeTypes = (node: any): string[] => [node.type, ...(node.children ?? []).flatMap(nodeTypes)];

  it("lays out the daily brief in the order Needs you, Your day, Important emails, Routines", () => {
    const { root } = valid(briefCard(full));
    expect(root.title).toBe("Daily brief");
    expect(root.caption).toBe("Saturday, October 17");
    expect(root.children.filter((node: any) => node.type === "Title").map((node: any) => node.value)).toEqual(["Needs you", "Your day", "Important emails", "Routines"]);
    const text = JSON.stringify(root);
    const order = ["Jake Price: Pricing for Pin", "Weekly report failed", "Standup and Design review overlap", "6:30 PM · Focus", "10:30 PM · Supamaus demo with Jake", "Ada: Q3 numbers due Friday", "Morning news"];
    expect(order.map((shown) => text.indexOf(shown))).toEqual(order.map((shown) => text.indexOf(shown)).sort((a, b) => a - b));
    expect(text).toContain("5:30 PM on me@example.test and 5:45 PM on admin@example.test");
    expect(text).toContain("Three stories on AI chips.");
  });

  it("says in Needs you that connected apps could not be reached, with no line saying it is still checking", () => {
    const built = briefCard({ ...empty, meetings: null, unreachable: true });
    const text = JSON.stringify(valid(built).root);
    expect(text).toContain("Couldn't reach your connected apps. I'll try again soon.");
    expect(text.indexOf("Couldn't reach")).toBeGreaterThan(text.indexOf("Needs you"));
    expect(text).not.toContain("Checking");
    expect(text).not.toContain("Nothing needs you right now.");
    expect(built.summary).toBe("Daily brief: couldn't reach your connected apps");
  });

  it("names every account an item came from, and each account it could not read, at the top", () => {
    const text = JSON.stringify(valid(briefCard({ ...full, missing: [{ account: "admin@example.test", what: "calendar" }, { account: "me@example.test", what: "email" }] })).root);
    expect(text.indexOf("I couldn't read the calendar of admin@example.test.")).toBeLessThan(text.indexOf("Needs you"));
    expect(text.indexOf("I couldn't read the email of me@example.test.")).toBeLessThan(text.indexOf("Needs you"));
    for (const label of ["me@example.test · waiting on your reply", "Prep ready · me@example.test, admin@example.test", "admin@example.test · Deadline Friday."]) expect(text).toContain(label);
  });

  it("offers Draft a reply, Open in Gmail and Dismiss on a reply that waits, all on that email's own account", () => {
    const { actions } = valid(briefCard({ ...empty, replies: [reply] }));
    expect(actions.map((entry) => [entry.label, entry.action.type, entry.action.payload])).toEqual([
      ["Draft a reply to Ada", "draft_reply", { messageId: "m1", account: "ca_g2" }],
      ["Open in Gmail", "open_url", { url: "https://mail.google.com/mail/u/admin%40example.test/#all/t1" }],
      ["Dismiss Ada's email", DISMISS_ACTION, { messageId: "m1", account: "ca_g2" }]]);
    expect(DISMISS_ACTION).toBe("dismiss_email");
  });

  it("offers Open in Gmail and Dismiss on an important email, and opens Gmail without an account when no address is known", () => {
    const { root, actions } = valid(briefCard({ ...empty, important: [{ ...reply, address: undefined, why: undefined }] }));
    expect(actions.map((entry) => [entry.label, entry.action.type, entry.action.payload])).toEqual([
      ["Open in Gmail", "open_url", { url: "https://mail.google.com/mail/#all/t1" }],
      ["Dismiss Ada's email", DISMISS_ACTION, { messageId: "m1", account: "ca_g2" }]]);
    expect(root.children.find((node: any) => node.type === "Col")?.children[1]).toMatchObject({ type: "Caption", value: "admin@example.test" });
  });

  it("encodes the account's address and the thread id in the Gmail link", () => {
    const { actions } = valid(briefCard({ ...empty, replies: [{ ...reply, address: "a+b/c?@example.test", threadId: "t/1#x" }] }));
    const url = actions.find((entry) => entry.label === "Open in Gmail")!.action.payload as { url: string };
    expect(url).toEqual({ url: "https://mail.google.com/mail/u/a%2Bb%2Fc%3F%40example.test/#all/t%2F1%23x" });
    expect(new URL(url.url).pathname).toBe("/mail/u/a%2Bb%2Fc%3F%40example.test/");
  });

  it("gives every Draft a reply and Dismiss its own label: the sender, then the account, then an ordinal", () => {
    const thirty = <T,>(make: (n: number) => T) => Array.from({ length: 30 }, (_, n) => make(n));
    const across = { ...empty, replies: thirty((n) => ({ ...reply, messageId: `r${n}`, ...(n % 2 ? { accountId: "ca_g1", account: "me@example.test" } : {}) })),
      important: thirty((n) => ({ ...reply, messageId: `i${n}`, ...(n % 3 ? {} : { accountId: "ca_g3", account: "Work" }) })) };
    for (const facts of [across, { ...across, replies: thirty((n) => ({ ...reply, messageId: `r${n}` })), important: thirty((n) => ({ ...reply, messageId: `i${n}` })) }]) {
      const labels = sent(briefCard(facts));
      expect(labels).toHaveLength(BRIEF_ROWS * 3);
      expect(new Set(labels).size).toBe(labels.length);
      for (const label of labels) expect(label.length).toBeLessThanOrEqual(WIDGET_LIMITS.label);
    }
    const labels = sent(briefCard(across));
    expect(labels.slice(0, 4)).toEqual(["Draft a reply to Ada (admin)", "Dismiss Ada's email (admin)", "Draft a reply to Ada (me)", "Dismiss Ada's email (me)"]);
    expect(labels).toContain("Draft a reply to Ada (admin) (2)");
    expect(labels).toContain("Dismiss Ada's email (Work)");
    const same = sent(briefCard({ ...empty, replies: thirty((n) => ({ ...reply, messageId: `r${n}` })) }));
    expect(same.slice(0, 4)).toEqual(["Draft a reply to Ada", "Dismiss Ada's email", "Draft a reply to Ada (2)", "Dismiss Ada's email (2)"]);
  });

  it("keeps labels distinct when a long sender name is clipped to the same words", () => {
    const long = "Ada Lovelace of the Analytical Engine Society";
    const labels = sent(briefCard({ ...empty, replies: [{ ...reply, from: `${long} A <a@example.test>` }, { ...reply, messageId: "m2", from: `${long} B <b@example.test>` }] }));
    expect(new Set(labels).size).toBe(4);
    expect(labels[0]!.startsWith("Draft a reply to Ada Lovelace")).toBe(true);
  });

  it("says it is checking while the calendar or the waiting emails are still being read, and leaves Your day out with no calendar", () => {
    const checking = JSON.stringify(valid(briefCard({ ...empty, meetings: "checking", repliesChecking: true })).root);
    expect(checking).toContain("Checking your calendar…");
    expect(checking).toContain("Checking your email…");
    expect(checking).not.toContain("Nothing needs you right now.");
    expect(JSON.stringify(valid(briefCard({ ...empty, meetings: null })).root)).not.toContain("Your day");
    const quiet = JSON.stringify(valid(briefCard(empty)).root);
    expect(quiet).toContain("Nothing needs you right now.");
    expect(quiet).toContain("No meetings today.");
    expect(quiet).not.toContain("Important emails");
    expect(quiet).not.toContain("Routines");
  });

  it("follows the rows of Needs you with 'Checking your email…' while the waiting emails are still being read", () => {
    const { root } = valid(briefCard({ ...empty, failedRoutines: full.failedRoutines, repliesChecking: true, meetings: null }));
    expect(root.children.map((node: any) => node.type === "Row" ? "row" : node.value)).toEqual(["Needs you", "row", "Checking your email…"]);
    expect(root.children[2].type).toBe("Caption");
  });

  it("words a failed and a missed routine in Needs you, with Open only when the run has a thread", () => {
    const built = briefCard({ ...empty, failedRoutines: [full.failedRoutines[0]!, { name: "Inbox sweep", status: "missed", line: "It did not run" }] });
    const text = JSON.stringify(valid(built).root);
    for (const shown of ["Weekly report failed", "The sheet was not shared.", "Inbox sweep was missed", "It did not run"]) expect(text).toContain(shown);
    expect(valid(built).actions.map((entry) => [entry.label, entry.action.type, entry.action.payload])).toEqual([["Open", "open_thread", { botId: "scout", threadId: "run-1" }]]);
    expect(valid(briefCard({ ...empty, routines: [{ name: "Room notes", status: "completed", line: "Done.", open: { groupId: "g1", threadId: "room-1" } }] })).actions[0]!.action.payload).toEqual({ groupId: "g1", threadId: "room-1" });
  });

  it("shows Join on a meeting only for an https link", () => {
    for (const joinUrl of ["javascript:alert(1)", "http://meet.example.test/a", "https://user:pw@meet.example.test/a", `https://meet.example.test/${"a".repeat(2_000)}`, "not a url", ""]) {
      expect(valid(briefCard({ ...empty, meetings: [{ ...meeting, joinUrl }] })).actions, joinUrl).toEqual([]);
    }
    expect(valid(briefCard({ ...empty, meetings: [meeting] })).actions.map((entry) => [entry.label, entry.action.payload])).toEqual([["Join", { url: demo.joinUrl }]]);
  });

  it("caps each section at six rows with 'and N more', and stays a valid card at the limits", () => {
    const emoji = "\u{1F600}".repeat(300);
    const many = <T,>(make: (n: number) => T) => Array.from({ length: 9 }, (_, n) => make(n));
    const built = briefCard({ ...full, missing: many((n) => ({ account: `${emoji}${n}`, what: "email" as const })),
      replies: many((n) => ({ ...reply, messageId: `m${n}`, subject: emoji, from: emoji })), meetings: many((n) => ({ ...meeting, title: emoji, start: meeting.start + n })),
      important: many((n) => ({ ...reply, messageId: `i${n}`, why: emoji })), routines: many((n) => ({ name: emoji, status: "completed" as const, line: emoji, open: { botId: "b", threadId: `t${n}` } })) });
    const { root } = valid(built);
    const text = JSON.stringify(root);
    expect(text.match(/and 3 more/g)?.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain("and 5 more");
    strings(root).forEach(noLoneSurrogate);
    const overflow = root.children.filter((node: any) => /^and \d+ more$/.test(node.value ?? ""));
    expect(overflow.every((node: any) => node.type === "Caption")).toBe(true);
    expect(BRIEF_ROWS).toBe(6);
  });

  it("stays under the widget's size with every section full of maximum-length text and links", () => {
    const long = (n: number) => "x".repeat(n);
    const address = `${long(240)}@example.test`;
    const many = <T,>(make: (n: number) => T) => Array.from({ length: 30 }, (_, n) => make(n));
    const email = (n: number): BriefEmail => ({ accountId: `ca_${long(37)}`, account: address, address, messageId: `${n}${long(31)}`, threadId: long(32), from: `${long(300)} <${address}>`, subject: long(2_000), why: long(2_000) });
    const routine = (n: number) => ({ name: "\u{1F680}".repeat(120), status: "failed" as const, line: "\u{1F680}".repeat(70), open: { botId: long(40), threadId: `${n}${long(127)}` } });
    const at = (n: number) => ({ title: long(2_000), start: meeting.start + n, accounts: long(1_000) });
    const facts: BriefFacts = {
      now: NOW, timeZone: ZONE, repliesChecking: true,
      missing: many((n) => ({ account: `${n}${long(400)}`, what: n % 2 ? "email" as const : "calendar" as const })),
      repliesUnreadable: many((n) => ({ account: `${n}${long(400)}`, count: 999 })),
      replies: many(email), failedRoutines: many(routine), clashes: many((n) => ({ first: at(n), second: at(n + 1) })),
      meetings: many((n) => ({ title: long(2_000), start: meeting.start + n, end: meeting.end, accounts: long(2_000), status: long(500), joinUrl: `https://meet.example.test/${n}${long(570)}` })),
      important: many(email), routines: many((n) => ({ ...routine(n), status: "completed" as const })),
    };
    for (const built of [briefCard(facts), briefCard({ ...facts, replies: [], failedRoutines: [], clashes: [] }), briefFallbackCard(facts)]) {
      const { root } = valid(built);
      expect(JSON.stringify(root).length, JSON.stringify(root).length.toString()).toBeLessThan(WIDGET_LIMITS.bytes - 2_000);
      strings(root).forEach(noLoneSurrogate);
    }
    const { actions } = valid(briefCard({ ...facts, failedRoutines: [], clashes: [] }));
    for (const press of ["Join", "Open in Gmail"]) expect(actions.filter((entry) => entry.label.split(":")[0] === press), press).toHaveLength(press === "Join" ? BRIEF_ROWS : BRIEF_ROWS * 2);
  });

  it("counts the waiting emails of an account it can't read, one line per account under Needs you, and never says nothing needs you", () => {
    const built = briefCard({ ...empty, meetings: null, repliesUnreadable: [{ account: "admin@example.test", count: 2 }, { account: "me@example.test", count: 1 }] });
    const text = JSON.stringify(valid(built).root);
    expect(text).toContain("2 emails waiting in admin@example.test, which can't be read right now");
    expect(text).toContain("1 email waiting in me@example.test, which can't be read right now");
    expect(text.indexOf("2 emails waiting")).toBeGreaterThan(text.indexOf("Needs you"));
    expect(text).not.toContain("Nothing needs you right now.");
    expect(built.summary).toBe("Daily brief: 3 need you");
    expect(briefCard({ ...full, repliesUnreadable: [{ account: "admin@example.test", count: 2 }] }).summary).toBe("Daily brief: 5 need you, 2 meetings, 1 important email, 1 routine result");
    const clipped = JSON.stringify(valid(briefCard({ ...empty, repliesUnreadable: [{ account: `${"x".repeat(78)}\u{1F600}${"y".repeat(500)}`, count: 2 }] })).root);
    expect(clipped).toContain(`2 emails waiting in ${"x".repeat(78)}…, which`);
  });

  it("uses only Card, Title, Text, Caption, Row, Col and Button, so every phone can show it", () => {
    const types = new Set(nodeTypes(valid(briefCard({ ...full, missing: [{ account: "a", what: "email" }], repliesChecking: true })).root));
    expect([...types].every((type) => ["Card", "Title", "Text", "Caption", "Row", "Col", "Button"].includes(type)), [...types].join()).toBe(true);
  });

  it("falls back to the same sections as plain text with no buttons", () => {
    const facts: BriefFacts = { ...full, missing: [{ account: "admin@example.test", what: "calendar" }], repliesChecking: true };
    const fallback = briefFallbackCard(facts);
    const { root, actions } = valid(fallback);
    expect(actions).toEqual([]);
    expect(root.title).toBe("Daily brief");
    expect(root.children.filter((node: any) => node.type === "Title").map((node: any) => node.value)).toEqual(["Needs you", "Your day", "Important emails", "Routines"]);
    const text = JSON.stringify(root);
    for (const shown of ["I couldn't read the calendar of admin@example.test.", "Jake Price: Pricing for Pin", "me@example.test · waiting on your reply", "Weekly report failed", "Standup and Design review overlap", "10:30 PM · Supamaus demo with Jake", "Ada: Q3 numbers due Friday", "Morning news", "Checking your email…"]) {
      expect(text).toContain(shown);
    }
    expect(nodeTypes(root)).not.toContain("Button");
    expect(fallback.summary).toBe(briefCard(facts).summary);
  });

  it("summarises the brief in one short line", () => {
    expect(briefCard(full).summary).toBe("Daily brief: 3 need you, 2 meetings, 1 important email, 1 routine result");
    expect(briefCard({ ...empty, meetings: "checking" }).summary).toBe("Daily brief: checking your calendar…");
    expect(briefCard({ ...empty, replies: [reply], meetings: [meeting], important: [reply, reply], routines: [...full.routines, ...full.routines] }).summary).toBe("Daily brief: 1 needs you, 1 meeting, 2 important emails, 2 routine results");
    expect(briefCard(empty).summary).toBe("Daily brief: 0 meetings");
    expect(briefCard({ ...empty, meetings: null }).summary).toBe("Daily brief: nothing needs you right now");
    const counted = briefCard({ ...empty, replies: Array.from({ length: 40 }, (_, n) => ({ ...reply, messageId: `m${n}` })) }).summary;
    expect(counted).toBe("Daily brief: 40 need you, 0 meetings");
  });

  it("never sums the brief up as nothing needing you while email is still being checked or an account could not be read", () => {
    const missing: BriefFacts["missing"] = [{ account: "admin@example.test", what: "calendar" }, { account: "me@example.test", what: "email" }];
    expect(briefCard({ ...empty, meetings: null, repliesChecking: true }).summary).toBe("Daily brief: checking your email…");
    expect(briefCard({ ...empty, meetings: null, missing: missing.slice(0, 1) }).summary).toBe("Daily brief: 1 account unreadable");
    expect(briefCard({ ...full, missing, repliesChecking: true }).summary)
      .toBe("Daily brief: 2 accounts unreadable, 3 need you, checking your email…, 2 meetings, 1 important email, 1 routine result");
    expect(briefFallbackCard({ ...empty, meetings: null, repliesChecking: true }).summary).toBe("Daily brief: checking your email…");
  });
});
