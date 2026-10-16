# MausBot, a proactive assistant, and the Chief of Staff

Date: 2026-10-17. Status: approved in conversation section by section; this document awaits Omkar's review.

This replaces the "morning brief" half of the earlier design
(`2026-10-15-chief-proactive-brief-design.md`, on the unpublished branches `feat/chief-recap`,
`feat/chief-morning-brief` and `feat/chief-brief-desktop`). After testing that build, Omkar asked for something
closer to Grok Bot: a default bot that is proactive by itself, with no setup, driven by what is actually
happening in the person's day rather than by a routine at 8:00.

## What success looks like

A person opens the app and the main bot already knows their day. Before a call it has researched the people,
said why the meeting exists, what is still open and what to do next. It points out the email they must not
miss. It reminds them ten minutes before. They did not set anything up beyond connecting Gmail and Google
Calendar once. Separately, their Chief of Staff tells them what their bots did and what is waiting on them.

The reference is Grok Bot's pre-call messages: "Your Supamaus demo with Jake Price is tonight, 10:30 to 11:00 PM
IST, on the Cal video call. He's Head of Customer Success at Pin.com… Two things you might want to settle before
the call… worth testing the demo flow before 10:30."

## Decisions (Omkar, 2026-10-17)

1. Two bots. **MausBot** is a built-in personal assistant. The **Chief of Staff** is the team role. A new install
   gets both.
2. MausBot owns the person's day: meeting prep, important email, reminders, a Today card. The Chief owns the team:
   what the bots did, goals, delegation, what is waiting on the person. Meeting notes come only from MausBot.
3. Timing follows events, not a schedule. Cloud homes act ahead of events around the clock. Free users get the
   same while the app is open, and a catch-up when they open it.
4. Existing users get MausBot added. If they have no Chief, MausBot offers once to set one up.
5. Without Gmail and Calendar, MausBot asks once, in its own chat, and works with what it has.
6. MausBot's second brain is everything the person can see: its memory, the profile, mail and calendar, and the
   other bots' conversations and results (read only).
7. Approach A: a background watcher that uses no AI, and AI turns only when there is real work.

## 1. The two bots

**MausBot**

- A built-in bot named "MausBot" with the MausBot mascot.
- It is always first in the sidebar, and in the phone apps once they update.
- It cannot be deleted. Its name and mascot are fixed. Its notifications can be muted.
- It runs on the person's default engine with their connected apps.
- It is not a Chief: it does not start, stop or delegate to bots.
- Its bot record carries `builtIn: "mausbot"`. Nothing else is special about it: it is an ordinary bot with its
  own chat, memory and settings.
- Its visibility is the owner (admins) only, because it reads the owner's mail.

**Chief of Staff**

- Unchanged team role (`chiefOfStaff` on a bot).
- On a new install it is a bot named "Chief of Staff".
- Its existing team behaviour stays: delegation, goals, team setup, incidents and escalations.

**Who gets which bots**

- **New install:** the store seeds MausBot, then "Chief of Staff". The random starter bot goes away.
- **Existing install, at the first start of this version:** MausBot is added at the top if no bot carries
  `builtIn: "mausbot"`. The person's bots are untouched.
- **Existing install with no Chief:** MausBot's first message carries one card, "Set up a Chief of Staff?", with
  three choices:
  - "Create a Chief of Staff" makes a new bot named Chief of Staff;
  - "Make <most-used bot> the Chief" appoints that bot;
  - "Not now".

  Only the owner or an admin may answer it.
- **Hosted team workspaces:** no MausBot and no proactive posts, as in the earlier build.

**MausBot's first message** says in plain words what it does: meeting prep, important email, reminders, a Today
card. If Gmail or Google Calendar is not connected, it adds one "Connect Gmail & Calendar" card. The card is shown
once. MausBot raises it again only when the person opens it or mentions meetings or email.

## 2. The watcher

A host module (`server/host/assistant-watch.ts`, factory with dependencies, per `server/host/README.md`) decides
when MausBot should act. It uses no AI itself.

**What it reads**, about every 15 minutes:
- calendar events from now to 36 hours ahead;
- email that arrived since the last check.

Both are read through the connected-apps service, from the server, with the owner's connection. It uses the
calendar listing and Gmail fetch tools over the existing relay; the plan confirms the exact tool names and how
to call them without an engine turn.

**What it keeps** in `assistant.json` in the data folder (mode 0600, atomic write, one store instance):
- for each meeting seen: its id, start, attendee fingerprint, the recurring-series id, when it was prepped and
  when it was reminded;
- the email cursor and the ids already judged;
- the date of the last Today card;
- the day's turn count.

It never stores email bodies or subjects.

**Work it starts**

| Event | What happens | AI |
|---|---|---|
| A meeting with at least one other person, not declined, not all-day, starts within 4 hours and has no prep yet | One MausBot prep turn. If the meeting is found later than that (booked late, or the app was opened late), prep starts at once with a shorter brief. | yes |
| A prepped meeting changes time or attendees | MausBot posts a short update. | yes |
| A recurring meeting with the same attendees as a prepped earlier occurrence | No web research. If mail or history has something new since the last occurrence, one short turn writes a "what changed since last time" line for the reminder; otherwise the reminder goes out alone. | only when something changed |
| About 10 minutes before a meeting | A reminder card from calendar data: title, time, Join, a link to the prep. | no |
| New email since the last check | At most one triage turn per 15 minutes, up to 20 emails, using only sender, subject and preview. MausBot posts only what matters: needs a reply, from someone the person meets today, or carries a deadline. Otherwise nothing is posted. | yes |
| The person's first presence of the day, in their zone | The Today card, built from what the watcher already knows: today's meetings with prep status, important emails not yet handled, and one line about the team that opens the Chief's chat. | no |

**Where it runs.** The watcher runs whenever the server runs:
- a Cloud home runs it around the clock;
- in the desktop app the server lives only while the app runs, so free users get it while the app is open.

On start, and on a presence return (the existing "I'm back" signal), it catches up at once:
- meetings in the next 4 hours are prepped;
- the Today card is posted if due;
- email since the last check is judged.

**Guardrails**
- At most 12 prep turns a day. Past the cap, meetings get reminders only.
- One triage turn per 15 minutes.
- One setting, "MausBot can act on its own" (on by default), stops all of it.
- A connected-app error is retried on the next check. After three failures in a row for the same service,
  MausBot posts one "Reconnect Gmail" (or Calendar) card.
- A failed AI turn posts one error card with Retry for that item, and the item is not retried on its own.

## 3. What MausBot posts

All of it goes to MausBot's own chat as chat-widget cards. The chat is marked unread, and one notification is sent
per card (a new notification kind, `assistant`).

The watcher's turns (prep, triage, updates) run in a MausBot background thread. Only their cards are posted into
MausBot's main chat, so the person never sees the working or a "nothing important" reply.

- **Meeting prep:**
  - when and where, with a **Join** button;
  - who the attendees are (role, company, anything recent from the web);
  - why the meeting exists (invite text, booking note);
  - the person's history with them: past email, earlier meetings, and anything their bots did that mentions them
    or their company;
  - open questions;
  - a suggested next step.

  Buttons: **Join**, **Open** (the related chat), **Draft a follow-up**.
- **Reminder:** "Call with Mayank in 10 minutes", with **Join** and **Prep notes**.
- **Important email:** sender, subject, why it matters, the suggested action, with **Open in Gmail** and **Draft a
  reply**.
- **Today:** described in section 2.

**Second brain.** MausBot's turns can search, read only:
- every conversation the owner can see;
- its own memory, and the profile;
- the owner's mail and calendar.

This needs a cross-bot search scope that only MausBot gets. MausBot never posts in another bot's chat. Text taken
from mail, calendar invites or other bots enters its prompt inside a labelled block, as records to read, not
instructions to follow.

**It never acts for the person.** It drafts replies, follow-ups and invites. Sending, booking or accepting
anything goes through an Approve button, and MausBot's tools on this path are read and draft only.

## 4. The Chief of Staff, and what carries over

**The Chief owns the team**
- The "Since you last looked" recap from the earlier build stays. It is posted by the Chief in the Chief's chat
  after an absence of 3 hours or more. It shows only bots everyone who can see the Chief may also see, and it is
  off on hosted workspaces.
- With no Chief, MausBot posts the recap.

**Which chat the app opens on after a return**
- MausBot's, when MausBot posted something new for the person (Today or a prep); otherwise the Chief's recap.
- Only a client that is arriving is told to open. A person already working is never moved.

**Dropped from the earlier build**
- the "Morning brief at 8:00?" offer;
- the Morning brief routine and its facts, quiet-day and catch-up code;
- the "Make me your Chief of Staff?" card in the most-used bot's chat.

**Carried over from the earlier build**
- presence and the renderer's "I'm back" pings, with their false-return fixes;
- `open_thread` buttons resolved in the viewer's store;
- the recap builder and its audience rules;
- the brief state store pattern;
- the hosted-workspace switch;
- the owner-or-admin rule for answering harness cards.

## 5. Edge cases and safety

- **No prep:** all-day events, events with only the person, and declined invites.
- **Travel:** event times come from the calendar; the Today card and "first presence of the day" use the zone the
  device reports.
- **One watcher per server**, whatever the number of devices.
- **An engine without web search:** MausBot says so once and preps from calendar, mail and history only.
- **An engine without connected-app tools:** the watcher still reads, because it runs on the server, but prep and
  triage turns cannot read mail. MausBot says so once.
- **Sleep:** a Mac waking from sleep catches up through the presence return.
- **Shared self-hosted servers:** MausBot is the owner's. Members never see its chat and cannot answer its cards.

## Delivery

Nothing from the earlier build is published. The work is re-cut:

| Part | Content | Builds on |
|---|---|---|
| 1 | Recap, presence pings, `open_thread` buttons; the morning brief and the old appoint card are removed | the existing branches, rebased onto current main |
| 2 | MausBot: built-in bot, pinning, seeding both bots, adding MausBot to existing installs, the Chief offer card, the connect card, owner-only visibility | Part 1 |
| 3 | The watcher and MausBot's cards: prep, reminder, email, Today; caps and the switch; cross-bot search for MausBot | Part 2 |
| 4 | mausbot-mobile follow-up: MausBot pinned and its cards on phones, presence from phones (with the companion allowlist entry for `POST /api/presence/active` in OpenMausBot) | Part 3 |

## Testing

- **Unit tests** for the watcher's decisions against a fake calendar and inbox:
  - which meetings are prepped, and when;
  - late bookings;
  - recurring series;
  - reminders;
  - email batching;
  - the daily cap;
  - catch-up on start and on return;
  - the Today card;
  - connected-app failures and the reconnect card.
- **End-to-end tests** with the fake engine and a fake connected-apps relay serving calendar events and emails:
  - a new install has MausBot and Chief of Staff;
  - an existing install gets MausBot and the Chief offer;
  - a meeting three hours out gets one prep card and one reminder;
  - an important email gets one card;
  - an unimportant one gets nothing;
  - nothing runs on a hosted workspace.
- **A scratch-server run** with the real Claude engine.
- **A side-by-side build on Omkar's own bots and calendar**, with a meeting added three hours ahead, before
  anything is published.

## Out of scope

- Push from Gmail or Calendar (webhooks): a later speed-up for Cloud email.
- Acting on the person's behalf without Approve.
- Per-person assistants on shared or hosted workspaces.
- Calendars and mail other than Google.
