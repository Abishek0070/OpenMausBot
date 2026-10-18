# MausBot

MausBot is the built-in personal assistant (`builtIn: "mausbot"`). A new install
gets a Chief of Staff and MausBot; an existing one gets MausBot added. MausBot is
silent until the owner's first presence call. Then it posts:

- its intro, with a line that connected apps are not set up when the server has none;
- a "Set up a Chief of Staff?" card, when there is no visible Chief;
- a connect card for Gmail and Google Calendar, when connected apps are set up on
  the server and either one is missing. A service MausBot may not use
  (`mausbotMayUse` in `server/host/mausbot-intro.ts`) gets no card.

Design: [`docs/superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md`](../superpowers/specs/2026-10-17-mausbot-proactive-assistant-design.md).
The posted lines are in `server/host/mausbot-intro.ts`.

## What to know before checking by hand

- The server answers 409 to any change of MausBot's fixed fields: name, silver
  look (the avatar and the mascot), audience (admins), team and role, and peers other than `[]`. It also
  refuses deleting or hiding it, adding it to a team or a room, and Full or Custom
  access, on the bot or on one thread. A room that already holds MausBot can
  still release it. Adding MausBot to a calendar call answers 400, not 409.
- Silver is MausBot's alone: any other bot asking for it gets 409.
- MausBot runs at most at "Approve for me" (`auto`). Its send policy is always
  "ask": every send, booking and delete waits on the Approve card. Reads pass
  without one. It is read-only in HighLevel.
- The wire caps what it shows. A hand-edited record at Full still shows `auto`
  and "ask" in every payload.
- The Chief offer is posted once. Only the owner or an admin can answer it, and
  "Not now" settles it for good.
- With no Chief, MausBot posts the recap in its own chat.
- Built-in bots do not count toward the 100-bot workspace limit.
- `launchVerificationServer` renames the seeded Chief of Staff to "Fixture
  Starter" and un-appoints it, so a fixture starts with one plain bot plus a
  silent MausBot.
- A hosted team workspace has no MausBot, no Chief and no recap.
- What MausBot does on its own is in [MausBot's watcher](mausbot-watcher.md).

## Server

```sh
pnpm exec vitest run server/mausbot.e2e.test.ts server/mausbot.test.ts server/host/mausbot-intro.test.ts
```

The e2e has nine tests on real servers with disposable data. A new install seeds
a Chief and a silent MausBot, which posts its intro and the connect cards on the
first presence call, against a loopback connected-apps service that knows no
account. Every refusal above answers 409 (a calendar call, 400), silver stays MausBot's, and exports
leave it out. A send waits for Approve (a denied one never reaches the service),
a read passes, and a batch of messages is refused. An install from before this
version gets MausBot added, offers a Chief once, and only the admin's answer
appoints one; "Not now" is not asked again. A hosted workspace seeds no MausBot
and no Chief. After nine hours away, a home install posts the Chief's recap, and
a hosted one posts none.

## Renderer

Launch the headless chat UI as in [Chat UI, driven headlessly](chat-ui.md), in a
terminal of its own (pnpm swallows Ctrl-C, which the launcher needs):

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
```

The launcher creates Pepper and opens the test-only preview on Pepper, because it
passes `?resume=<Pepper id>`. A new install of the real app, with no remembered
selection, opens on MausBot instead. In a second terminal set `H` to the `ui`
path the launcher prints:

```sh
H=/tmp/openmausbot-verify-data-XXXXXX/ui.json
pnpm control:omb ui snapshot --ui $H
```

Expected: MausBot is the first row of the sidebar, above Fixture Starter and
Pepper, drawn in silver. The fixture has no Chief; with one, it would be the
second row, unsectioned. Open MausBot's menu: Delete is absent, and Archive and
Make Chief of Staff are disabled. MausBot's row and header have no Rename
control (the profile's name field is disabled too). Open its profile card: the
avatar and connection controls are disabled. Stop the launcher with Ctrl-C.
