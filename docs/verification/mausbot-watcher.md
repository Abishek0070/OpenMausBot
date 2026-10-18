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
- `assistant.json` in the data folder keeps meeting ids, times, attendee
  fingerprints, the email cursor and judged ids, the last Today date and the
  day's turn count; never a subject or a body.
- The Today card posts at once on the first presence of the day, from the last
  calendar read (after a restart, "at once" waits for the first check), so opening the app lands on MausBot. If that read is older
  than one check interval, the card is edited in place after the next fresh
  read. There is no second notification.
- At most 12 prep turns a day, counted in the person's time zone: preps,
  updates and repeat preps all count. Email checks are separate, at most one
  per check interval, and each takes up to 20 emails.
- After 3 failed reads of Gmail or Calendar in a row, one Reconnect card
  appears for that service. A success resets the count.
- A **Retry** card settles as "unavailable" when nothing would run: the daily
  cap is used, the meeting has started or is gone, the switch is off, the
  calendar has not been read since a restart, the service is disconnected, or
  the press came from someone who is not the owner or an admin.
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
  and email reaches the AI only inside labelled records blocks.
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

`server/assistant.e2e.test.ts` has four tests. Each starts real servers on
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
   carries no records.
2. A job thread runs at Ask with no dweb, computer, browser or phone, even with
   Full stored on MausBot. Web search is allowed; a shell, a fetch, a write and a
   question are declined with the job's reason. A send from the job thread is
   refused, and a send from MausBot's chat waits for an Approve card; denied, it
   never reaches the service. MausBot's own chat still runs at its own level.
3. A failed job turn files no incident with the Chief and posts a Retry card,
   while an ordinary bot's failed turn does reach the Chief.
4. A hosted workspace has no MausBot or Chief, and a presence call on it posts
   nothing and makes no reads; the same server unhosted reads Calendar and
   Gmail on its own clock.

## What the harness cannot prove

The tool slugs and answer shapes in the fake service are not yet checked
against the live Composio service. `GOOGLECALENDAR_EVENTS_LIST` and
`GMAIL_FETCH_EMAILS`, their arguments and their answers are a model of the
real ones. Checking them is a separate task, done with the person. The harness
also cannot prove a real engine's prep or the person's real day. Those need a
scratch server with the real Claude engine, then a side-by-side build on the
owner's own bots and calendar.
