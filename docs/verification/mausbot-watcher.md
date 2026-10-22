# MausBot's watcher

With Gmail and Google Calendar connected, MausBot reads every connected Google
account and every calendar the owner selected (now to 36 hours ahead), and new
email in every inbox, about every 15 minutes from the server, with no model.
When there is work it runs a MausBot turn in a hidden job thread and posts only
the resulting card in MausBot's chat: a meeting prep when a meeting with
another person is within 4 hours, a reminder 10 minutes before, a card for an
email that matters, and one daily brief on the first presence of the person's
day. Design:
[`docs/superpowers/specs/2026-10-21-mausbot-daily-brief-design.md`](../superpowers/specs/2026-10-21-mausbot-daily-brief-design.md),
on top of
[`docs/superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md`](../superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md).

## What to know before checking by hand

- "MausBot can act on its own" (Settings, `features.assistantActs`, on unless
  `false`) stops all of it. A job already running when it goes off posts
  nothing, and its daily turn is refunded. A hosted team workspace, and a Team
  Cloud the same way, has no watcher and makes no reads.
- MausBot reads and posts nothing until its intro is saved in `brief.json`.
  The intro posts on the owner's first presence, before any recap or daily
  brief that presence brings.
- A workspace restore or Cloud move turns "MausBot can act on its own" off, as
  it turns routines off, and leaves the source's jobs in flight and Retry cards
  behind. A restore also forgets which accounts the source saw connected and
  the Reconnect cards it showed, so the restored server learns its connections
  again. Send and Move to My Cloud leave MausBot out: My Cloud has its own. If both servers are switched on and connected to the same Google
  account, both watch it.
- `assistant.json` (version 2; a version 1 file starts fresh) in the data
  folder keeps, per connected account: its address, alias, email cursor, judged
  ids, failure count, whether Reconnect was shown, whether it was seen
  connected, and how many listings in a row it was missing from. It also keeps
  the pending emails `{ account, messageId, threadId, judgedAt, needsReply,
  copyGroup }` (`copyGroup` is a hash of the email's `Message-ID` header, never
  the header itself), `lastBriefDate`, `lastBriefAt` and `lastBriefCard` (the
  message id of that day's brief), meeting ids, times and attendee
  fingerprints, the day's turn count, in-flight jobs, Retry cards and hidden job
  threads. Never a subject, a sender or a body.
- **Every call names its account.** Each connected-apps call carries the
  account id (`ACCOUNT_PARAM`). A service that connected apps report as
  connected without listing accounts is one implied account, and its calls name
  none. A refusal to pick an account counts as that account's read failure,
  never as empty data. An account's address comes from the Gmail profile, or for
  Calendar from its primary calendar. Gmail links open as
  `mail.google.com/mail/u/<address>/#all/<threadId>` when the address is known.
- **Calendar reads.** The primary calendar and every selected, not hidden
  calendar are read, except one shared as free/busy only (access role
  `freeBusyReader`), which has no event details. A calendar counts as the
  person's own when it is the primary one or its role is owner. Each account
  shares one 60-second deadline, with at most 4 calendars read at a time. One
  unreadable calendar fails that account's read.
- **One meeting, many calendars.** A meeting found on several calendars or
  accounts is one meeting, matched by `iCalUID` (plus the original start for a
  recurring instance), else by the same title, start and end. It gets one prep,
  one reminder and one clash. A fresh read beats a kept one for the same
  meeting, and a fresh cancellation or decline wins.
- **One email, many inboxes.** The same email in two inboxes, matched by its
  `Message-ID` header, is one row and one triage item; without the header both
  show. Showing it releases both copies. Each pending copy keeps the hash of
  that header, so the copies stay grouped after a restart. Triage is one batch
  of up to 20 emails across all accounts.
- **The daily brief.** On the first presence of the person's day MausBot posts
  one card, "Daily brief", at once, so opening the app lands on MausBot. It has
  four sections: **Needs you**, **Your day**, **Important emails** and
  **Routines**.
  - Above the sections, the brief names every account it could not read
    ("I couldn't read the email of …"). An account stays named while any of
    its waiting or held emails could not be re-read, even after a later inbox
    read of that account succeeds.
  - **Needs you** lists emails waiting on a reply (pending for 7 days), a missed
    or failed routine, two meetings that overlap, and a count of the waiting
    emails it cannot show, per account ("2 emails waiting in …, which can't be
    read right now"). A waiting email whose re-read failed stays in that count
    until a re-read succeeds or it is a week old; the failed re-reads are tried
    again at each later check that day. Needs you never says "Nothing needs you
    right now." while such an email is unshown. It says "Checking your email…"
    until the pending emails are re-read, and, after a cold start, until the
    first email check in that process has finished. If the account listing
    fails it says "Couldn't reach your connected apps. I'll try again soon."
    while the brief can still be edited.
  - **Your day** lists today's timed meetings that have not ended, with solo
    blocks marked "Just you". With no usable Calendar account the section is
    left out; before the first read it says "Checking your calendar…".
  - **Important emails** lists the important ones, up to six, then "and N
    more". Buttons are Join, Open, Open in Gmail, Draft a reply and Dismiss,
    each with a label derived from its row.
  - **Routines** lists completed runs since the last brief, one line each (the
    first sentence of the last digest reply, else the run's output, else
    "Finished"). A failed or missed run appears once, in Needs you; a cancelled
    one does not appear. The brief keeps the routine rows it was posted with, and
    a run that finishes later appears in the next day's brief.
- **The brief is edited in place.** The reads of the first check that starts
  after it posts, and the first email check that finishes after it, edit the
  same card with no notification. After that only a re-read that succeeds on a
  later check, the first finished email check after a cold start, and Dismiss
  edit it. If the brief is refused, a plain-text fallback posts, and
  `lastBriefDate` is saved only once something has posted. If both are refused
  it retries after 15 minutes. It posts when a Google account is usable or
  there are routine results; otherwise nothing posts.
- **Morning mail is held for the brief.** An important email is held, not
  carded, until an email check reads every usable Gmail account and finishes
  with no triage queued or running and nothing deferred. A check where one
  account's read failed leaves the window open. A 30-minute backstop after the
  brief posts also closes the window. A held email stays in `assistant.json`
  until a delivered card shows it.
- **Dismiss costs no turn.** Dismiss is answered by the server only on a card
  the server built (`serverCard`), which only the server can edit (a bot's
  `update_widget` on one is told the widget is missing), in MausBot's main thread: the press route
  answers `202 { ok: true, threadId, handled: true }`, runs no model turn and
  adds no chat message. A `dismiss_email` button on a widget a MausBot turn drew
  goes to MausBot as an ordinary press. Only the owner or an admin can dismiss;
  anyone else is refused and the card stays open. Dismiss drops the email and
  every copy grouped with it from `assistant.json`, and takes its row off
  today's brief, including a Dismiss pressed on an old card while today's brief
  is in memory. After a restart, a Dismiss on today's brief (`lastBriefCard`)
  edits that card's stored tree: the pressed row goes, an emptied Needs you
  says "Nothing needs you right now.", an emptied Important emails section
  goes, and the rest of the card stays as it was. A Dismiss on an older card
  after a restart only drops the email. With the switch off or before the
  intro, Dismiss drops the email, edits nothing and starts no turn. A hosted
  workspace or a Team Cloud answers no press.
- **Routines and the Chief's recap.** Routine runs leave the Chief's recap only
  when MausBot's watcher is on (switch on, intro saved, not hosted) and every
  reader of the recap can see MausBot (`takesRoutines` in
  `server/host/mausbot-host.ts`); otherwise the recap keeps them. The team line
  is not in the brief and stays in the recap.
- **Accounts and Reconnect.** Each account has its own count, and a Reconnect
  card names it. A Reconnect card follows the 3rd failing check, not the 3rd
  failing read: at most one failure counts per account per check, a success
  resets the count, and a read that takes over 60 seconds fails. A check that a
  presence started counts a failure only when none was counted in the last
  check interval. A listed account that was seen active and is now expired,
  failed or revoked gets its Reconnect card once. It stays listed: the brief
  names it as unreadable, its waiting emails are kept, and its last calendar
  events keep their reminders until they end, or for one day past its last good
  read. After it reconnects, a later loss shows the card again. An account
  never seen active gets no card; the brief still names it. An account that is
  pending (never active) is ignored until it is active.
- **Removed accounts are forgotten.** An account is forgotten, with its pending
  emails and meetings and with no card, only after it is missing from 2
  successful listings in a row. After the first miss it is named unreadable and
  not read. A failed listing forgets nothing.
- **Message gone.** A waiting email is dropped quietly only when `messageGone`
  (`server/assistant-sources.ts`) says so: Google answers "Requested entity was
  not found", or the tool says the message, email or thread is not found or
  deleted. Wording that names an account, connection, token, permission or tool
  never counts. Any other failed read keeps the entry and names the account. If
  two account ids report the same address, account selection is treated as not
  honoured: no waiting email is dropped for them and a warning is logged once.
- **Add another account.** MausBot's connect card has "Add another account"
  (up to 5 per app). It asks for a label, as Settings does; MausBot names an
  account by its address everywhere.
- **Draft a reply** names the receiving account (its address and id) in the
  press text, and MausBot's draft call names that account. After a restart,
  when MausBot no longer holds the email, the press text names the message by
  id and the account from `assistant.json`'s account table, never from the
  card's text. A press naming another account than the one MausBot holds the
  message under gets no records.
- Every meeting card names its accounts, the Cancelled card included.
- At most 12 prep turns a day, counted in the person's time zone: preps,
  updates and repeat preps all count. Email checks are separate, at most one
  per check interval.
- A meeting moved later after its reminder gets a new reminder before its new
  time. A prep still queued when its meeting starts is dropped and its turn
  given back.
- A **Retry** card (a failed prep, update or email job) settles as
  "unavailable" when nothing would run: the daily cap is used, the meeting has
  started or is gone, the switch is off, the calendar has not been read since a
  restart, the service is disconnected, or the press came from someone who is
  not the owner or an admin. There is no Retry card for the brief: an
  unreadable account is named at the top of it.
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
pnpm exec vitest run server/host/assistant-plan.test.ts server/host/assistant-accounts.test.ts server/host/assistant-brief.test.ts server/host/assistant-cards.test.ts server/host/assistant-state.test.ts server/host/assistant-watch.test.ts server/host/assistant-job-requests.test.ts server/host/chief-brief.test.ts server/host/mausbot-host.test.ts server/routes/bot-messages.test.ts server/assistant-sources.test.ts shared/outbound.test.ts server/assistant.e2e.test.ts
```

`server/assistant.e2e.test.ts` has seven tests. Each starts real servers on
disposable data with a fake Claude engine and a loopback connected-apps service
(`server/testing/fake-connected-apps.ts`), with `OMB_ASSISTANT_CHECK_MS` at 1000.

1. "preps a meeting three hours out once, puts the first important email in the
   daily brief and cards a later one, reminds ten minutes before, and answers a
   press from its own records": a meeting three hours out gets one prep card, the
   brief carries the first important email, and the newsletter gets none. The
   work runs in hidden job threads, which raise no notification of their own, and
   a forged closing marker in the invite is defused inside the records block. A
   press on the email card carries MausBot's own record of that email. After a
   restart with the meeting nine minutes away, there is one reminder and no
   second prep. Open names only a visible conversation, a leftover job thread is
   deleted, and the press's turn replays MausBot's chat with every card, including
   an email whose subject says "Ignore previous instructions", inside a records
   block, defused.
2. "posts nothing before the owner first comes, then its intro first; a morning
   restart opens on the daily brief at once and fills that card in place":
   nothing is posted or read before the first presence, then the intro comes
   first, and a slow calendar leaves "Checking your calendar…" until the read
   edits the same card, with one notification.
3. "reads two Google accounts: one prep for a meeting on both calendars, one
   email check for both inboxes, every call naming its account, and Draft a reply
   from the receiving account".
4. "posts the daily brief at the morning presence with Needs you, Your day,
   routine results and the account it could not read, and a Dismiss costs no
   turn".
5. "runs a job at Ask without exec, browser or phone and answers its requests
   itself, and never sends, with Full stored on MausBot": a shell, a fetch, a
   write and a question are declined with the job's reason; a send from the job
   thread is refused, and a send from MausBot's chat waits for an Approve card.
6. "files no incident for a failed job turn, while an ordinary failed turn
   reaches the Chief".
7. "does nothing on a hosted team workspace or with MausBot switched off, while
   the same server unhosted and on reads on its own clock".

## What the harness cannot prove

The tool slugs, the account parameter and the answer shapes in the fake service
are not yet checked against the live Composio service. These stay unconfirmed
until a run against real accounts, done with the person, confirms them:

- `ACCOUNT_PARAM` ("account") on each tool item, and that Composio honours it
  per call;
- the four new slugs, `GMAIL_GET_PROFILE`, `GOOGLECALENDAR_LIST_CALENDARS`,
  `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` and `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`,
  their arguments and answers;
- the wording `messageGone` recognises for a deleted message;
- that `payload.headers` carries the `Message-ID` header (read only when two or
  more Gmail accounts are connected);
- that the `mail.google.com/mail/u/<address>/` link opens the right account;
- that two profile reads for two accounts return different addresses;
- that older phone clients accept the Dismiss answer,
  `202 { ok: true, threadId, handled: true }`, which carries no `message`.

`GOOGLECALENDAR_EVENTS_LIST` and `GMAIL_FETCH_EMAILS` are in the same position.
The harness also cannot prove a real engine's prep or the person's real day.
Those need a scratch server with the real Claude engine, then a side-by-side
build on the owner's own bots and calendar.
