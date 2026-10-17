# Agent notifications and proactivity QA

OpenMausBot treats **proactivity as an explicit trigger**, not as a hidden
heartbeat. A bot may continue within an active task through Auto mode, may be
started by a Routine or Webhook, and may coordinate peers when its engine and
profile allow that. This change does not add background polling that invents
work or sends messages without one of those configured paths. The Chief of Staff's "Since you last looked" recap only reads records that already exist and never runs a model.

## Notification policy

The harness is the single owner of interruption policy. A bot with
notifications disabled remains quiet. Otherwise it may emit:

- **Needs approval** or **has a question** when the task is blocked on the user.
- **Needs your hands** when a computer task requires a takeover.
- **Finished** only when there is a non-empty result to summarize.
- **Routine failed** when a scheduled or manual routine run cannot complete.

Every notification carries both the bot ID and the exact task thread ID. A
click must select that bot **and switch to that task**, including a routine's
detached task; opening whichever task happens to be active is a failure.

Desktop notifications are suppressed while the window already has focus. The
iOS app can present live or replayed notifications while it is running and uses
the same bot/task target when the notification is tapped. Waking a terminated
iOS app still requires a future APNs relay; local network or VPN connectivity
alone cannot provide closed-app delivery.

## Automated coverage

| Contract | Test |
|---|---|
| Per-agent off means quiet; empty completions stay quiet; summaries are bounded | `server/notify.test.ts` |
| Browser click returns the exact bot/task target | `src/lib/notify.test.ts` |
| Store navigation selects the bot and switches the task | `src/state/store.test.ts` |
| Routine failure receipt and callback occur once | `server/routines.test.ts` |
| Real failed routine emits one `routine-failed` notification and no duplicate `done` | `server/notification-wiring.test.ts` |
| iOS target parsing and detached-task decision | `ios/Tests/CompanionCoreTests/DecodingTests.swift` |
| Paired-device route policy remains default-deny | `companion/test/routes.test.ts` |
| One recap per return; a guest or service never moves presence | `server/host/presence.test.ts`, `server/host/chief-brief.test.ts`, `server/routes/presence.test.ts`, `server/chief-recap.e2e.test.ts` |
| A member never sees a restricted bot in the recap | `server/chief-recap-members.e2e.test.ts` |

## Manual release pass

Run these with two bots, notifications enabled on one and disabled on the
other:

1. Background the desktop window. Complete a normal task and confirm one
   result notification. Click it and verify the exact task opens.
2. Trigger an approval and a question. Confirm their copy, click targets, and
   that no duplicate completion notification appears before the task settles.
3. Run a routine manually, then create a controlled failing run. Confirm the
   receipt shows the detached task and the failure generates exactly one alert.
4. Repeat the above with notifications disabled for that bot; the chat and run
   receipt should update without a system alert.
5. On iOS, tap a live/replayed notification for a non-active routine task.
   Confirm the app switches the server-side active task before navigating.
6. Exercise Auto mode, a Routine, and a Webhook independently. Verify each has
   a visible initiating user/configured trigger and that no unconfigured
   heartbeat starts work.
7. Close the app for three hours or more while a bot finishes something, open it,
   and confirm one "Since you last looked" card in the Chief's chat and that the
   app opens on it.

Live provider, OS-permission, backgrounding, and APNs behavior cannot be proven
by unit tests alone and remains part of the signed desktop/iPhone release pass.
