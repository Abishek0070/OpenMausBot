# The Chief's recap

"Since you last looked" is a chat widget card the Chief of Staff posts in its own
chat when the owner comes back after three hours or more (`features.briefAwayHours`).
It is built from records only and runs no model. Design:
[`docs/superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md`](../superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md).

## What to know before checking by hand

- Only `POST /api/presence/active` from the owner counts as the person: the desktop
  app, a paired owner device, the owner's Cloud session. An event stream never does.
  A guest's call never moves the stored time: a paired client-only session is
  refused (403, or 401 on a Cloud home) and any other non-owner call is answered
  without being recorded.
- The card lists only bots, rooms and routine runs that everyone who can see the
  Chief may also see.
- `OMB_BRIEF_RECAP=0` turns the recap off; `features.briefRecap: false` does too.
- With no Chief, MausBot posts the recap in its own chat.
- A hosted team workspace has no recap, and neither has a Team Cloud.
- A team backup keeps the card marked as built by the server, so a restored
  recap replays to the Chief as records, never as its own words.

## Server

```sh
pnpm exec vitest run server/chief-recap.e2e.test.ts server/chief-recap-cloud.e2e.test.ts server/chief-recap-members.e2e.test.ts
```

The first starts a disposable fixture, makes a Chief, records the person as
present, has Scout finish a turn and runs an "Overnight numbers" routine, moves
the stored activation nine hours back in `presence.json`, restarts on the same
data and calls presence from the desktop and the phone. One card is posted as the
Chief, both calls answer with the Chief's thread to open, and a press on **Open**
is refused with 400 ("That action opens on the device and is not sent."). The second proves that event streams and guests
never move the stored time, at home and on a Cloud home. The third proves that a member reading
the Chief's chat never sees a bot limited to admins.

## Renderer

Launch the headless chat UI as in [Chat UI, driven headlessly](chat-ui.md), in a
terminal of its own (pnpm swallows Ctrl-C, which the launcher needs):

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
```

In a second terminal set `H` to the `ui` path the launcher prints, make the
fixture's starter the Chief, shorten the away time (0.002 hours is about seven
seconds), have Pepper do something, wait, and reload:

```sh
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json
pnpm control:omb ui flag --ui $H --set features.briefAwayHours=0.002
pnpm control:omb ui type --ui $H --name "Message Pepper" --text "Finish the report."
pnpm control:omb ui press --ui $H --keys Enter
pnpm control:omb ui wait-settle --ui $H --timeout 60
```

Make **Fixture Starter** the Chief. `bots` prints its id; PORT is the port in the
`url` the launcher printed:

```sh
pnpm control:omb bots --url http://127.0.0.1:PORT
curl -s -X PATCH http://127.0.0.1:PORT/api/bots/ID -H 'content-type: application/json' -H 'origin: http://127.0.0.1:PORT' -d '{"chiefOfStaff":true}'
```

Wait ten seconds, then reload and read the page. `wait-settle` is not used here:
it waits on Pepper's transcript, and the page is now on the Chief's.

```sh
pnpm control:omb ui eval --ui $H --js "location.reload()"
pnpm control:omb ui snapshot --ui $H
```

Expected: the page opened on Fixture Starter with no click, and
`log "Conversation with Fixture Starter"` holds `group "Since you last looked"`
with the line `Finished`, `Pepper`, `hello from fake claude` and a `button "Open"`.
If the group is missing, run `snapshot` again. Click it, then snapshot:

```sh
pnpm control:omb ui click --ui $H --name "Open"
pnpm control:omb ui snapshot --ui $H
```

The transcript is now `log "Conversation with Pepper"`, the composer is
`textbox "Message Pepper"`, and `StaticText "Finish the report."` appears once.
`pnpm control:omb ui console --ui $H` shows no `error` entries. Stop the
launcher with Ctrl-C.

What the harness cannot prove: a real absence of hours in the packaged app, which
the real-install pass in
[Agent notifications and proactivity QA](../notification-and-proactivity-qa.md) covers.
