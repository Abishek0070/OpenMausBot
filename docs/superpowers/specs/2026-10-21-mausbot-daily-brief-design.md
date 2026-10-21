# MausBot's daily brief: every account, every calendar, and what routines produced

Status: design, 2026-10-21. It builds on the MausBot watcher
(`docs/superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md`, built on the unpublished branch
`feat/mausbot-watcher`). "Omkar decided" marks his choices. "Builder's call" marks choices made without him, which he
may overrule.

## Why

Omkar has three Google accounts: a personal Gmail, admin@supamaus.com and omkar@supamaus.com. Each morning he opens
every inbox and calendar to see what matters, and his bots' routines also run overnight. He wants one place that has
already looked at all of it: "Too many places to check" (Omkar).

MausBot already watches mail and calendar, but it can only read one Google account. It treats "Gmail is connected" as
true if any account is connected. It then reads without naming an account, so with several accounts connected that read
most likely fails, because the app asks Composio to require an account choice. It also reads only each account's
primary calendar, and nothing reports what routines produced.

## Goals

1. **All Google accounts.** MausBot reads every connected Gmail account and every Google Calendar account, as many as
   the person adds. Composio allows up to 5 accounts per app; `MULTI_ACCOUNT_CONFIG` is in `server/composio.ts`.
2. **All calendars.** It reads every calendar in each Google account that the person has turned on in Google, not only
   the primary one.
3. **One daily brief.** It replaces today's Today card and keeps the same moment: the first time the person opens the
   app each day, as MausBot's first card of the day. Opening the app lands on it, under the existing open rule.
4. **The brief's order** (Omkar decided):
   1. **Needs you.** Only what the person must act on, from every account:
      - emails waiting on their reply;
      - a routine that failed or was missed;
      - a meeting clash across calendars.
   2. **Your day.** Every meeting from every calendar on one timeline, with prep status and a Join link.
   3. **Important emails** not yet handled, across all inboxes.
   4. **What routines produced** since the last brief.
5. **Routine results** (Omkar decided). For each routine run that finished since the last brief, show one short line:
   the routine's name and what it produced, with Open to see the result. Failed and missed runs are listed too.
   Successful results appear only in the daily brief. There are no routine cards during the day.
6. **The Chief keeps the rest of the team's work** (Omkar decided). The Chief's "Since you last looked" recap keeps
   chats and delegated tasks. Routine runs move to MausBot's brief.
7. **During the day, the watcher works as it does now, across all accounts.** That covers meeting prep, 10-minute
   reminders and important-email cards.
8. **Every item says which account it came from**, for example "admin@supamaus.com". A broken connection names the
   account in its Reconnect card.

## Non-goals

- **Outlook, Zoho, iCloud and other providers.** All of Omkar's accounts are Google, and other providers are for other
  users later. The reading code must keep the provider behind an interface, so Outlook can be added without rewriting
  the watcher (see "Constraints").
- **Granola call follow-ups.** These are a separate project, for the Chief of Staff or a separate bot. They do not
  belong in MausBot's brief.
- **The iPhone "Talk to MausBot" Action Button shortcut.** This is a separate small change, in mausbot-mobile.
- **Routine cards during the day.**
- **A new screen.** The brief is a chat card in MausBot's chat, as Today is now.

## Anti-goals: these would make it a failure even if it technically works

- **A missing account.** If one account fails to read, the brief must say so and name the account. It must never look
  complete.
- **One account's mail mixed into another's reply.** A "Draft a reply" from an email must draft from the account that
  received it.
- **The same meeting twice.** A meeting on two of the person's calendars (an invite to both work accounts, say) appears
  once.
- **More AI cost per account.** Adding an account must not multiply AI turns. Email checks across all accounts share one
  batch, and the daily cap of 12 prep turns is per person, not per account.
- **Slower mornings.** The brief still posts at once on first presence. It uses a "Checking your calendar…" placeholder
  and edits it in place when reads land, as now.
- **Weaker safety.** Every rule from the watcher spec and its build still holds: untrusted text in labelled blocks, job
  threads fenced, no sends without Approve, hosted workspaces off, and the switch stops everything.

## How it works

### Reading several accounts

- **Selecting the account.** Composio needs each tool call to name the account when several are connected. Each call
  from `server/assistant-sources.ts` names one account, by connected-account id or alias, in whatever form Composio's
  multi-account mode expects. The exact parameter is unconfirmed, so the real-service check confirms it and pins it in
  the fixtures before anything ships. It is already owed as Task 3.15.
- **Listing accounts.** `connectedServices` already returns `accounts: [{ id, alias?, status }]` per toolkit. The
  watcher reads each ACTIVE account of `gmail` and of `googlecalendar`.
- **Account address.** Read each account's own address once with a read-only profile call (Gmail profile), and cache
  the address per account id. Fall back to the alias, then a short id. The address is shown to the person, so the cache
  lives in `assistant.json` as a per-account record. That is a schema addition; addresses are not mail content.
- **Calendars.** List each Google account's calendars with the calendar-list read, keep the ones the person has
  selected in Google, and read events from each. Builder's call: also skip calendars the person has hidden.
- **New read tools.** Each new read tool (profile, calendar list, read one message by id) is added to `KNOWN_READ_SLUGS`
  and to the job-thread gate's Gmail/Calendar read allowlist. The watcher still calls only fixed read slugs.
- **Whose meetings count.** Builder's call, from the design review. An event counts as the person's meeting when one of
  their connected addresses is its organiser or an attendee, on any calendar. It also counts when it sits on a calendar
  the person owns: a primary calendar, or one they own, which covers solo blocks with no guests. Events on colleagues'
  shared calendars or room calendars that the person isn't invited to are left out of Your day, prep and reminders.
  Google sets `attendees[].self` relative to the calendar being read, so the check uses the person's addresses, not
  `self`.

### State per account

Every per-service field in `assistant.json` becomes per account:
- the email cursor;
- the judged ids;
- failure counts;
- seen-connected;
- reconnect-shown.

A meeting is keyed by provider event identity, not by account. That is how one meeting on two calendars stays one meeting
(see "Duplicate meetings").

The file is new in this unpublished build, so its schema may change without migration. If the build ships before this
work, the builder adds a migration that maps the old single-service fields to the first account.

### Duplicate meetings

- Two events count as one meeting when they share Google's `iCalUID`, or failing that, the same start, end and
  normalised title within the same hour.
- The merged meeting lists every account it appears on.
- Prep and reminders run once per meeting.

### Email checks

- One triage batch covers new mail from all accounts, still up to 20 emails, still at most one triage turn per check
  interval.
- Each email in the prompt's labelled records carries its account address.
- Emails waiting on a reply that the person already answered from another account are not shown twice. Builder's call:
  match on thread or Message-ID headers where available.

### Pending emails: "Needs you" carries over (Omkar decided)

- An email judged "needs a reply" stays in the brief's Needs you section, day after day, until one of these happens:
  - the person has replied, from any of their connected addresses;
  - the person dismisses it from the brief;
  - 7 days pass.
- `assistant.json` stores only `{ account id, message id, thread id, judged at }` per pending email. It never stores the
  subject, sender or body, so the "no mail content in state" rule still holds.
- Before each brief, the watcher re-reads each pending email's header by id, so the brief can show it and Draft a reply
  works after a restart. It also checks the thread for a later message from any of the person's addresses.
  - Both reads go through fixed read slugs, confirmed in the real-service check.
  - An email that can't be read anymore drops out quietly.
- Builder's call: an important email that needs no reply appears in one brief only, the first after it was judged. It
  can be dismissed, and it doesn't carry over.

### Morning mail goes in the brief (Omkar decided)

- Mail judged while the day's brief hasn't been posted yet is held for the brief. It gets no separate card and no
  notification. This covers overnight mail on a Cloud home and mail waiting when the desktop app starts.
- The first email check that finishes after the brief posts adds its results to the brief, editing it in place. That
  edit sends no second notification.
- From then on, important emails get their own cards as today.

### The daily brief card

The brief replaces `todayCard` in `server/host/assistant-cards.ts`. It is built by the server from what the watcher
already knows, and opening it costs no AI turn.

1. **Needs you:**
   - emails judged "needs a reply" and not yet answered;
   - routine runs since the last brief whose status is failed or missed;
   - pairs of meetings that overlap on the person's own calendars, where both are accepted or not declined.
2. **Your day:** meetings from every calendar, merged and sorted, each with its account, prep status and Join link
   (https only, as now).
3. **Important emails:** the triage's important emails not yet handled, each tagged with its account.
4. **Routines:**
   - Every routine run that finished since the last brief, across every bot the person can see. MausBot is admins-only.
   - One line per run: the routine name plus the first sentence of the run's last bot reply (its digest), clipped. A
     failed run shows its error instead.
   - Each line has Open, which goes to the run's thread.
   - Text taken from a run's reply is bot output that may quote untrusted data. It reaches a later turn only through the
     labelled replay that the build already applies to server-built cards.

Builder's calls on the card:
- **Title.** "Daily brief", in Omkar's words. It avoids clashing with the "Today" page in PR #3019.
- **Size.** Each section stays within the widget limits.
- **Overflow.** Overflow reads "and N more", with Open for the full list where a thread exists.

If PR #3019 (the Today page) merges first, the routines section may read its data through `todayReport()` for one
source of truth. It is optional, not a dependency.

### The Chief's recap

- When MausBot exists and its switch is on, the Chief's recap no longer lists routine runs. Chats and delegated tasks
  stay.
- Builder's calls, from the design review. The Chief's recap keeps routine runs in two cases, so routines are never
  unreported:
  - MausBot's switch is off;
  - the recap's readers include anyone who can't see MausBot. MausBot is admins-only, and on a shared self-hosted
    server, members who can see the Chief would otherwise lose every routine summary.

### Connecting accounts

- Adding an account already works in Settings: a second account needs a label, and the app asks for it.
- MausBot's connect card gains "Add another account", which asks for the label the same way.
- Builder's call: the label defaults to the account's address once Google returns it.

## Constraints

- **Provider interface.** `AssistantSources` grows into a per-account interface. A provider (Google today) supplies:
  - list accounts;
  - read events for an account;
  - read new mail for an account;
  - read the account's address.

  The watcher, plan, cards and state never name a provider beyond these calls, so Outlook later is a new provider
  module.
- **Every rule from the watcher spec and its build stands**, including:
  - fixed read slugs only;
  - unreadable answers are errors, never empty data;
  - labelled records;
  - Ask-clamped, fenced job threads;
  - the intro comes first;
  - hosted workspaces are off;
  - the 12 prep turns a day cap;
  - the switch.
- **Size pins and the route ratchet** on `server/index.ts` and the other pinned files still apply. `origin/main` now pins
  `server/index.ts` at 17445.
- **Phones.** They show the brief as an ordinary chat-widget card. The "Needs you" press targets use existing actions.
  No phone change is needed beyond what the earlier phone follow-up already owes in mausbot-mobile.

## Left to the builder

- **Composio's exact multi-account parameter and the new read slugs.** Confirm them in the real-service check, and pin
  real answers in the fixtures.
- **The duplicate-meeting rule's fallback details**, and the clash rule's handling of tentative events.
- **Whether to split delivery** into two pull requests: multi-account reading first, then the brief and routines.
