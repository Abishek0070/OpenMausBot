import { connectorCardText } from "../connector-card-text.ts";
import type { RequestOutcome } from "../contracts.ts";
import { failure } from "../failure.ts";
import { CHIEF_OF_STAFF_NAME, findMausBot, isMausBot } from "../mausbot.ts";
import { ownerOrAdmin, type RequestAuth } from "../request-auth.ts";
import type { BotRecord, Store } from "../store.ts";
import type { BriefState, BriefStateStore } from "./brief-state.ts";

export const MAUSBOT_INTRO = "Hi, I'm MausBot, your assistant. Before each meeting I look up who you're meeting, why the meeting exists and what's still open, and suggest a next step. I point out the emails you shouldn't miss, remind you ten minutes before a call, and have a Today card ready when you start your day. I only draft: nothing is sent, booked or accepted without your OK.";
export const MAUSBOT_NO_APPS = "Connected apps aren't set up on this server yet, so for now I can help you here in chat.";
export const CONNECT_LINE = "Connect Gmail & Calendar so I can do this.";
export const CHIEF_OFFER_TITLE = "Set up a Chief of Staff?";
export const CHIEF_OFFER_SUBTITLE = "A Chief of Staff keeps track of your other bots: what they did, what they are doing and what is waiting on you.";
export const CREATE_CHIEF = "Create a Chief of Staff";
export const NOT_NOW = "Not now";
export const appointOption = (name: string): string => `Make ${name} the Chief`;

export const MAUSBOT_SERVICES = [
  { slug: "gmail", label: "Gmail", description: "Read your email and draft replies. Nothing is sent without your OK." },
  { slug: "googlecalendar", label: "Google Calendar", description: "Read your calendar and draft invites. Nothing is booked without your OK." },
] as const;

export interface MausBotIntroDeps {
  store: Pick<Store, "bots" | "bot" | "appendMessage" | "messagesFor" | "patchMessage" | "patchTask" | "createBot" | "setChiefOfStaff" | "deleteBot">;
  state: BriefStateStore;
  hosted: boolean;
  maxBots: number;
  mainThread(bot: BotRecord): string | undefined;
  turnsByBot(): Map<string, number>;
  /** Connected apps are set up on this server: a project key or the managed service. */
  configured(): boolean;
  /** The install's connected services by slug; rejects when the service cannot be reached. */
  connected(): Promise<Record<string, { connected: boolean }>>;
  newId(): string;
  now?: () => number;
}

type Remembered = Pick<BriefState, "mausbotIntro" | "chiefOffer" | "connectOffer">;

export function mausbotMayUse(bot: Pick<BotRecord, "composio" | "connectorTools">, slug: string): boolean {
  return bot.composio !== false && (bot.connectorTools === undefined || Object.hasOwn(bot.connectorTools, slug));
}

export function createMausBotIntro(deps: MausBotIntroDeps) {
  const now = deps.now ?? Date.now;
  const unsaved: Remembered = {};
  let connecting: Promise<void> | undefined;
  const current = (): BriefState => ({ ...deps.state.get(), ...unsaved });

  function remember(changes: Remembered): void {
    try {
      deps.state.patch({ ...unsaved, ...changes });
      for (const key of Object.keys(unsaved) as Array<keyof Remembered>) delete unsaved[key];
    } catch (error) {
      Object.assign(unsaved, changes);
      console.warn(`mausbot: could not save the intro state: ${failure(error)}`);
    }
  }

  const visibleChief = (): boolean => deps.store.bots.some((bot) => bot.chiefOfStaff && !bot.hidden);

  function mostUsedBot(): BotRecord | null {
    const turns = deps.turnsByBot();
    return deps.store.bots.filter((bot) => !bot.hidden && !isMausBot(bot))
      .sort((a, b) => (turns.get(b.id) ?? 0) - (turns.get(a.id) ?? 0))[0] ?? null;
  }

  function offerChief(threadId: string): void {
    const pick = mostUsedBot();
    const requestId = deps.newId();
    const options = [CREATE_CHIEF, ...(pick ? [appointOption(pick.name)] : []), NOT_NOW];
    const message = deps.store.appendMessage(threadId, {
      role: "bot", kind: "options", card: { title: CHIEF_OFFER_TITLE, subtitle: CHIEF_OFFER_SUBTITLE, options, requestId, fixedOptions: true },
    });
    remember({ chiefOffer: { requestId, threadId, messageId: message.id, at: now(), ...(pick ? { candidateId: pick.id } : {}) } });
  }

  async function offerConnect(bot: BotRecord, threadId: string): Promise<void> {
    let services: Record<string, { connected: boolean }>;
    try {
      services = await deps.connected();
    } catch (error) {
      console.warn(`mausbot: connected apps could not be checked; the connect card waits: ${failure(error)}`);
      return;
    }
    if (current().connectOffer) return;
    const missing = MAUSBOT_SERVICES.filter(({ slug }) => mausbotMayUse(bot, slug) && services[slug]?.connected !== true);
    if (!missing.length) {
      remember({ connectOffer: { at: now(), threadId, shown: false } });
      return;
    }
    const resumeKey = `mausbot-connect-${deps.newId()}`;
    deps.store.appendMessage(threadId, { role: "bot", kind: "text", text: CONNECT_LINE });
    for (const service of missing) {
      deps.store.appendMessage(threadId, {
        role: "bot", kind: "connector", text: connectorCardText(service.label),
        connector: { slug: service.slug, label: service.label, description: service.description, status: "required", resumeKey, addAccount: true },
      });
    }
    remember({ connectOffer: { at: now(), threadId, shown: true } });
  }

  async function introduce(): Promise<void> {
    if (deps.hosted) return;
    try {
      if (Object.keys(unsaved).length) remember({});
      const bot = findMausBot(deps.store.bots);
      const threadId = bot && deps.mainThread(bot);
      if (!bot || !threadId) return;
      let posted = false;
      if (!current().mausbotIntro) {
        deps.store.appendMessage(threadId, { role: "bot", kind: "text", text: deps.configured() ? MAUSBOT_INTRO : `${MAUSBOT_INTRO}\n\n${MAUSBOT_NO_APPS}` });
        remember({ mausbotIntro: { at: now(), threadId } });
        posted = true;
      }
      if (!current().chiefOffer && !visibleChief()) {
        try {
          offerChief(threadId);
          posted = true;
        } catch (error) {
          console.warn(`mausbot: the Chief offer was not posted: ${failure(error)}`);
        }
      }
      if (posted) {
        try {
          deps.store.patchTask(bot.id, threadId, { unread: true });
        } catch (error) {
          console.warn(`mausbot: could not mark the chat unread: ${failure(error)}`);
        }
      }
      if (!current().connectOffer && deps.configured()) {
        connecting ??= offerConnect(bot, threadId).finally(() => { connecting = undefined; });
        await connecting;
      }
    } catch (error) {
      console.warn(`mausbot: the intro was not posted: ${failure(error)}`);
    }
  }

  function createChief(): boolean {
    const created = deps.store.createBot({ name: CHIEF_OF_STAFF_NAME });
    try {
      if (deps.store.setChiefOfStaff(created.id) !== null) return true;
    } catch (error) {
      console.warn(`mausbot: the new Chief of Staff could not be appointed: ${failure(error)}`);
    }
    deps.store.deleteBot(created.id);
    return false;
  }

  function appointCandidate(id: string | undefined): boolean {
    const target = id ? deps.store.bot(id) : null;
    return Boolean(target && !target.hidden && !isMausBot(target) && deps.store.setChiefOfStaff(target.id) !== null);
  }

  function settle(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown, auth: RequestAuth): RequestOutcome | undefined {
    const offer = current().chiefOffer;
    if (!offer || offer.requestId !== requestId || offer.threadId !== threadId) return undefined;
    const row = deps.store.messagesFor(threadId).find((line) => line.id === offer.messageId);
    if (!row?.card) return undefined;
    if (!ownerOrAdmin(auth)) return "unavailable";
    if (offer.answered) return offer.answered === "no" ? "rejected" : "answered";
    const choice = behavior === "answer" && typeof message === "string" && row.card.options.includes(message) ? message : NOT_NOW;
    if (choice !== NOT_NOW && visibleChief()) {
      const { answeredText: _answeredText, ...card } = row.card;
      deps.store.patchMessage(threadId, row.id, { card: { ...card, answered: "unavailable" } });
      remember({ chiefOffer: { ...offer, answered: "no" } });
      return "unavailable";
    }
    let answered: "create" | "appoint" | "no" = "no";
    if (choice === CREATE_CHIEF) {
      if (deps.store.bots.filter((bot) => bot.builtIn === undefined).length >= deps.maxBots || !createChief()) return "unavailable";
      answered = "create";
    } else if (choice !== NOT_NOW) {
      if (!appointCandidate(offer.candidateId)) return "unavailable";
      answered = "appoint";
    }
    deps.store.patchMessage(threadId, row.id, { card: { ...row.card, answered: "answer", answeredText: choice } });
    remember({ chiefOffer: { ...offer, answered } });
    return answered === "no" ? "rejected" : "answered";
  }

  /** Security invariant: only the owner or an admin may answer, whatever let the press reach this card; a refused press
   * leaves the card open and records nothing. */
  function answerCard(threadId: string, requestId: string, behavior: "allow" | "deny" | "answer", message: unknown, auth: RequestAuth): RequestOutcome | undefined {
    if (deps.hosted) return undefined;
    try {
      return settle(threadId, requestId, behavior, message, auth);
    } catch (error) {
      console.warn(`mausbot: the Chief offer was not settled: ${failure(error)}`);
      return "unavailable";
    }
  }

  return { introduce, answerCard };
}
