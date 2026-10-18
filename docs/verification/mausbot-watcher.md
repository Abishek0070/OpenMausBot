# MausBot's watcher

With Gmail and Google Calendar connected, MausBot reads the owner's calendar
(now to 36 hours ahead) and new email about every 15 minutes from the server,
with no model. When there is work it runs a MausBot turn in a hidden job
thread and posts only the resulting card in MausBot's chat: a meeting prep
when a meeting with another person is within 4 hours, a reminder 10 minutes
before, a card for an email that matters, and a Today card on the first
presence of the person's day. Design:
[`docs/superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md`](../superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md).

## What to know before checking by hand

- "MausBot can act on its own" (Settings, `features.assistantActs`, on unless
  `false`) stops all of it. A job already running when it goes off posts
  nothing, and its daily turn is refunded. A hosted team workspace has no
  watcher and makes no reads.
- MausBot reads and posts nothing until its intro is saved in `brief.json`.
  The intro posts on the owner's first presence, before any recap or Today
  card that presence brings.
- A workspace restore or Cloud move turns "MausBot can act on its own" off, as
  it turns routines off, and leaves the source's jobs in flight and Retry cards
  behind. If both servers are switched on and connected to the same Google
  account, both watch it.
- `assistant.json` in the data folder keeps meeting ids, times, attendee
  fingerprints, the email cursor and judged ids, the last Today date, the
  day's turn count and which services were seen connected; never a subject or
  a body.
- The Today card posts at once on the first presence of the day, so opening the
  app lands on MausBot. After a restart, before this run has read the calendar,
  it says "Checking your calendar…", and the first read edits that same card
  into the real Today. If the read fails, the card says the calendar could not
  be read and a Retry card follows, unless the Reconnect card is already there.
  A Today built from a read older than one check interval is also edited in
  place after the next fresh read. There is never a second notification. A
  restart before the first read leaves "Checking your calendar…" on that card.
- At most 12 prep turns a day, counted in the person's time zone: preps,
  updates and repeat preps all count. Email checks are separate, at most one
  per check interval, and each takes up to 20 emails.
- After 3 failed reads of Gmail or Calendar in a row, one Reconnect card
  appears for that service. A success resets the count. A check that a presence
  started counts a failure only when none was counted in the last check
  interval. A read that takes over 60 seconds fails.
- A service seen connected that connected apps then report as not connected
  (an expired or revoked Google sign-in) gets its Reconnect card once. After it
  reconnects, a later loss shows the card again. A service never connected
  gets none.
- A meeting moved later after its reminder gets a new reminder before its new
  time. A prep still queued when its meeting starts is dropped and its turn
  given back.
- A **Retry** card settles as "unavailable" when nothing would run: the daily
  cap is used, the meeting has started or is gone, the switch is off, the
  calendar has not been read since a restart, the service is disconnected, the
  Today it was for is gone after a restart, or the press came from someone who
  is not the owner or an admin.
- A job thread is hidden and runs at Ask whatever level is stored on MausBot.
  The server answers its approval requests itself: only web search is allowed.
  OpenMausBot's write tools are refused, and connected apps are limited to
  Gmail and Calendar reads. No dweb, computer, browser or phone is mounted.
  No incident or escalation goes to the Chief, and a job thread raises no
  ordinary done or failed notification. Job threads are kept out of every
  recall and search. MausBot's sends anywhere else wait for the Approve card,
  at every level, and a Chief's `retry_thread` refuses MausBot.
- Join appears only for an https link without credentials, under the size cap.
  Prep notes render as plain text, with no links or images. Text from invites
  and email reaches the AI only inside labelled records blocks. That includes
  MausBot's cards and the Chief's "Since you last looked" card when a later
  turn replays its chat (delta, fresh and recovery context, the compaction
  summary's input, and a person's reply to a card): each is a records block
  saying it was shown to the person and is not the bot's own words.
- Leftover job threads are deleted when the server starts.
- `OMB_ASSISTANT_CHECK_MS` (at least 1000) shortens the check interval for a
  scratch server.

## Known risk: Codex

Codex has no per-turn read-only sandbox. If MausBot's engine is Codex, a job
turn runs at Ask in Codex's workspace-write sandbox, with the network off.
Every other gate above still applies.

## Server

```sh
pnpm exec vitest run server/host/assistant-plan.test.ts server/host/assistant-watch.test.ts server/host/assistant-job-requests.test.ts server/assistant-sources.test.ts server/assistant.e2e.test.ts
```

`server/assistant.e2e.test.ts` has five tests. Each starts real servers on
disposable data with a fake Claude engine and a loopback connected-apps service
(`server/testing/fake-connected-apps.ts`), with `OMB_ASSISTANT_CHECK_MS` at 1000.

1. A meeting three hours out gets one prep card, one Today card and one card for
   the important email; the newsletter gets none. The work runs in hidden job
   threads, which raise no notification of their own, and a forged closing marker
   in the invite is defused inside the records block. A press on the email card
   carries MausBot's own record of that email. After a restart with the meeting
   nine minutes away, there is one reminder and no second prep. Two new meetings
   get a prep each, Open names only a visible conversation and never a job
   thread, a leftover job thread is deleted, and after the restart the press
   carries no records. The press's turn replays MausBot's chat with every card,
   including an email whose subject says "Ignore previous instructions" and
   forges the closing marker, inside a records block, defused, while MausBot's
   own intro replays as it was.
2. Nothing is posted or read before the owner's first presence, and then the
   intro comes first. After a morning restart with a slow calendar, the first
   presence opens MausBot on a "Checking your calendar…" Today, which the read
   then turns into the real Today, with one notification for it.
3. A job thread runs at Ask with no dweb, computer, browser or phone, even with
   Full stored on MausBot. Web search is allowed; a shell, a fetch, a write and a
   question are declined with the job's reason. A send from the job thread is
   refused, and a send from MausBot's chat waits for an Approve card; denied, it
   never reaches the service. MausBot's own chat still runs at its own level.
4. A failed job turn files no incident with the Chief and posts a Retry card,
   while an ordinary bot's failed turn does reach the Chief.
5. A hosted workspace has no MausBot or Chief, and a presence call on it posts
   nothing and makes no reads; the same server unhosted, once MausBot is
   introduced, reads Calendar and Gmail on its own clock.

## What the harness cannot prove

The tool slugs and answer shapes in the fake service are not yet checked
against the live Composio service. `GOOGLECALENDAR_EVENTS_LIST` and
`GMAIL_FETCH_EMAILS`, their arguments and their answers are a model of the
real ones. Checking them is a separate task, done with the person. The harness
also cannot prove a real engine's prep or the person's real day. Those need a
scratch server with the real Claude engine, then a side-by-side build on the
owner's own bots and calendar.
