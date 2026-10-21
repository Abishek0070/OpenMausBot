import type { AssistantSources, EmailHeader, SourceAccount } from "../assistant-sources.ts";
import type { AssistantAccounts } from "./assistant-accounts.ts";
import { briefCard, briefFallbackCard, type BriefClash, type BriefEmail, type BriefFacts, type BriefMeeting, type BuiltCard } from "./assistant-cards.ts";
import { answered, briefDue, clashes, emailKey, keepNewest, localDate, prunePending, type Meeting } from "./assistant-plan.ts";
import { MAX_PENDING_EMAILS, storableId, type AssistantStateStore, type PendingEmail } from "./assistant-state.ts";
import type { RoutineRow } from "./brief-recap.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MAX_HEADERS = 1_000;
const POST_RETRY_MS = 15 * MINUTE;
const MAIL_WINDOW_MS = 30 * MINUTE;

export interface TriagePick { email: EmailHeader; copies: EmailHeader[]; why: string; action: string; needsReply: boolean }

type CardRef = { messageId: string; threadId: string };
type EmailRef = Omit<PendingEmail, "needsReply">;

export interface AssistantBriefDeps {
  state: AssistantStateStore;
  now(): number;
  timeZone(): string | undefined;
  accounts: Pick<AssistantAccounts, "listed" | "usable" | "unreadable" | "known" | "read" | "label" | "address" | "addresses" | "selectionIgnored">;
  sources: Pick<AssistantSources, "message" | "thread">;
  /** Every meeting read, merged; null until each usable Calendar account has been read in this run, a failed read included. */
  meetings(): readonly Meeting[] | null;
  status(meeting: Meeting, at: number): string;
  routines(since: number): RoutineRow[];
  /** Null when the card was refused or could not be posted. */
  post(built: BuiltCard): CardRef | null;
  /** False when the edit was refused. */
  edit(card: CardRef, built: BuiltCard): boolean;
}

interface PostedBrief extends CardRef {
  day: string;
  routines: RoutineRow[];
  postedAt: number;
  important: EmailRef[];
  live: boolean;
  mailOpen: boolean;
  pendingChecked: boolean;
  /** The JSON of the last card built for it. */
  shown?: string;
}

const refKey = (ref: EmailRef): string => emailKey({ account: ref.account, id: ref.messageId });
const storable = (email: EmailHeader): boolean => storableId(email.account) && storableId(email.id) && storableId(email.threadId);
const refOf = (email: EmailHeader, judgedAt: number): EmailRef => ({ account: email.account, messageId: email.id, threadId: email.threadId, judgedAt });
const emailsOf = (pick: TriagePick): EmailHeader[] => [pick.email, ...pick.copies];

function mergeRefs<T extends EmailRef>(list: readonly T[], added: readonly T[], merge: (kept: T, again: T) => T = (kept) => kept): T[] {
  const merged = [...list];
  for (const ref of added) {
    const at = merged.findIndex((one) => refKey(one) === refKey(ref));
    if (at < 0) merged.push(ref);
    else merged[at] = merge(merged[at]!, ref);
  }
  return merged;
}

export type AssistantBrief = ReturnType<typeof createAssistantBrief>;

export function createAssistantBrief(deps: AssistantBriefDeps) {
  const { accounts } = deps;
  const headers = new Map<string, { email: EmailHeader; why?: string }>();
  let brief: PostedBrief | undefined;
  let waitingForListing = false;
  let unreachable = false;
  let postFailedAt: number | undefined;
  let rereading: Promise<void> | undefined;
  const rereadFailed = new Set<string>();

  const pending = (): PendingEmail[] => deps.state.get().pendingEmails ?? [];
  const savePending = (list: readonly PendingEmail[]): void => { deps.state.patch({ pendingEmails: keepNewest(list, MAX_PENDING_EMAILS) }); };
  const due = (): boolean => briefDue({ now: deps.now(), timeZone: deps.timeZone(), lastBriefDate: deps.state.get().lastBriefDate }) !== null;
  const todays = (at: number): PostedBrief | undefined => (brief && localDate(at, deps.timeZone()) === brief.day ? brief : undefined);
  const labels = (ids: readonly string[]): string => [...new Set(ids.map((id) => accounts.label(id)))].join(", ");
  const usableIds = (service: "gmail" | "googlecalendar"): Set<string> => new Set(accounts.usable(service).map((account) => account.id));

  function remember(email: EmailHeader, why?: string): void {
    const key = emailKey(email);
    const kept = why ?? headers.get(key)?.why;
    headers.delete(key);
    headers.set(key, { email, ...(kept ? { why: kept } : {}) });
    if (headers.size > MAX_HEADERS) headers.delete(headers.keys().next().value!);
  }

  function addPending(entries: readonly PendingEmail[]): void {
    if (entries.length) savePending(mergeRefs(pending(), entries, (kept, again) => (again.needsReply && !kept.needsReply ? { ...kept, needsReply: true } : kept)));
  }

  const sameEmail = (email: EmailHeader): string => (email.messageIdHeader === undefined ? `key ${emailKey(email)}` : `header ${email.messageIdHeader}`);
  const groupOf = (key: string): string => {
    const known = headers.get(key)?.email;
    return known ? sameEmail(known) : `key ${key}`;
  };

  /** One row per email, so a message in two inboxes shows once, under the account it was first judged in. */
  function rows(refs: readonly EmailRef[]): Array<{ email: EmailHeader; why?: string }> {
    const seen = new Set<string>();
    const shown: Array<{ email: EmailHeader; why?: string }> = [];
    for (const ref of refs) {
      const known = headers.get(refKey(ref));
      if (!known || seen.has(sameEmail(known.email))) continue;
      seen.add(sameEmail(known.email));
      shown.push(known);
    }
    return shown.sort((a, b) => b.email.at - a.email.at);
  }

  function briefEmail({ email, why }: { email: EmailHeader; why?: string }): BriefEmail {
    const address = accounts.address(email.account);
    return {
      accountId: email.account, account: accounts.label(email.account), ...(address ? { address } : {}),
      messageId: email.id, threadId: email.threadId, from: email.from, subject: email.subject, ...(why ? { why } : {}),
    };
  }

  function onYourDay(meeting: Meeting, at: number, today: string): boolean {
    const solo = !meeting.attendees.some((attendee) => !attendee.self);
    return !meeting.allDay && meeting.status !== "cancelled" && !meeting.selfDeclined && (!solo || meeting.ownedCalendar === true)
      && meeting.end > at && localDate(meeting.start, deps.timeZone()) === today;
  }

  // An account that could not be read is named at the top instead, so the brief never claims a day without meetings.
  function yourDay(at: number): Meeting[] | "checking" | null {
    if (!accounts.usable("googlecalendar").length) return null;
    const all = deps.meetings();
    if (all === null) return unreachable ? null : "checking";
    const today = localDate(at, deps.timeZone());
    const listed = all.filter((meeting) => onYourDay(meeting, at, today));
    return listed.length === 0 && accounts.unreadable("googlecalendar").length > 0 ? null : listed;
  }

  function unshownCounts(unread: readonly PendingEmail[], shown: ReadonlySet<string>): BriefFacts["repliesUnreadable"] {
    const counted = new Set(shown);
    const counts = new Map<string, number>();
    for (const entry of unread) {
      const group = groupOf(refKey(entry));
      if (counted.has(group)) continue;
      counted.add(group);
      counts.set(entry.account, (counts.get(entry.account) ?? 0) + 1);
    }
    return [...counts].map(([id, count]) => ({ account: accounts.label(id), count }));
  }

  function facts(posted: Omit<PostedBrief, keyof CardRef>, at: number): BriefFacts {
    const known = accounts.known();
    const gmail = usableIds("gmail");
    const unreadableMail = new Set(accounts.unreadable("gmail").map((account) => account.id));
    const waiting = pending().filter((entry) => entry.needsReply && known.has(entry.account));
    const important = posted.important.filter((ref) => known.has(ref.account));
    const unread = (ref: EmailRef): boolean => !headers.has(refKey(ref)) && (unreadableMail.has(ref.account) || (posted.pendingChecked && gmail.has(ref.account)));
    const unreadWaiting = waiting.filter(unread);
    const replies = rows(waiting);
    const day = yourDay(at);
    const meetings = Array.isArray(day) ? day : [];
    const meeting = (one: Meeting): BriefMeeting => ({
      title: one.title, start: one.start, end: one.end, accounts: labels(one.accounts), status: deps.status(one, at), ...(one.joinUrl ? { joinUrl: one.joinUrl } : {}),
    });
    const side = (one: Meeting): BriefClash["first"] => ({ title: one.title, start: one.start, accounts: labels(one.accounts) });
    return {
      now: at,
      timeZone: deps.timeZone(),
      missing: [
        ...accounts.unreadable("googlecalendar").map((account) => ({ account: accounts.label(account.id), what: "calendar" as const })),
        ...[...new Set([...unreadableMail, ...[...unreadWaiting, ...important.filter(unread)].map((ref) => ref.account)])]
          .map((id) => ({ account: accounts.label(id), what: "email" as const })),
      ],
      replies: replies.map(briefEmail),
      repliesChecking: !unreachable && !posted.pendingChecked && [...waiting, ...posted.important].some((ref) => gmail.has(ref.account)),
      repliesUnreadable: unshownCounts(unreadWaiting, new Set(replies.map((row) => sameEmail(row.email)))),
      failedRoutines: posted.routines.filter((row) => row.status !== "completed"),
      clashes: clashes(meetings, { now: at, timeZone: deps.timeZone() }).map(([first, second]) => ({ first: side(first), second: side(second) })),
      meetings: Array.isArray(day) ? day.map(meeting) : day,
      important: rows(important).map(briefEmail),
      routines: posted.routines.filter((row) => row.status === "completed"),
      ...(unreachable ? { unreachable: true } : {}),
    };
  }

  function deliver<T>(done: "posted" | "updated", built: BuiltCard, plain: () => BuiltCard, send: (card: BuiltCard) => T | null | false): T | null {
    const sent = send(built);
    if (sent) return sent;
    const fallback = send(plain()) || null;
    console.warn(fallback
      ? `assistant: the daily brief card was not accepted, so its plain version was ${done}`
      : `assistant: the daily brief was not ${done}, as a card or as plain text`);
    return fallback;
  }

  /** An important email that needs no reply is held in assistant.json until a delivered card shows it or a copy of it. */
  function stillHeld(list: readonly PendingEmail[], shown: BriefFacts): PendingEmail[] {
    const onCard = new Set(shown.important.map((email) => groupOf(emailKey({ account: email.accountId, id: email.messageId }))));
    return list.filter((entry) => entry.needsReply || !onCard.has(groupOf(refKey(entry))));
  }

  function releaseShown(shown: BriefFacts): void {
    const before = pending();
    const kept = stillHeld(before, shown);
    if (kept.length !== before.length) savePending(kept);
  }

  function refresh(force: boolean): void {
    const at = deps.now();
    const posted = todays(at);
    if (!posted || (!posted.live && !force)) return;
    const shown = facts(posted, at);
    const built = briefCard(shown);
    const json = JSON.stringify(built.card);
    const card = { messageId: posted.messageId, threadId: posted.threadId };
    if (json !== posted.shown && !deliver("updated", built, () => briefFallbackCard(shown), (next) => deps.edit(card, next))) return;
    posted.shown = json;
    releaseShown(shown);
  }

  function post(): void {
    const at = deps.now();
    const day = briefDue({ now: at, timeZone: deps.timeZone(), lastBriefDate: deps.state.get().lastBriefDate });
    waitingForListing = false;
    if (!day || (postFailedAt !== undefined && at - postFailedAt < POST_RETRY_MS)) return;
    const since = deps.state.get().lastBriefAt ?? at - DAY;
    const gmail = usableIds("gmail");
    const routines = deps.routines(since);
    if (!gmail.size && !accounts.usable("googlecalendar").length && !routines.length) {
      waitingForListing = !accounts.listed();
      return;
    }
    const held = pending().filter((entry) => !entry.needsReply && gmail.has(entry.account));
    const draft = {
      day, routines, postedAt: at, important: held.map(({ needsReply: _needsReply, ...ref }) => ref),
      live: true, mailOpen: gmail.size > 0, pendingChecked: false,
    };
    const shown = facts(draft, at);
    const built = briefCard(shown);
    const card = deliver("posted", built, () => briefFallbackCard(shown), (next) => deps.post(next));
    if (!card) {
      postFailedAt = at;
      return;
    }
    postFailedAt = undefined;
    deps.state.patch({ lastBriefDate: day, lastBriefAt: at, pendingEmails: stillHeld(pending(), shown) });
    brief = { ...draft, messageId: card.messageId, threadId: card.threadId, shown: JSON.stringify(built.card) };
  }

  function judged(picks: TriagePick[]): TriagePick[] {
    const at = deps.now();
    for (const pick of picks) for (const email of emailsOf(pick)) remember(email, pick.why);
    const holdable = picks.filter((pick) => emailsOf(pick).every(storable));
    const unheld = picks.filter((pick) => !holdable.includes(pick));
    const replies = holdable.filter((pick) => pick.needsReply).flatMap(emailsOf).map((email) => ({ ...refOf(email, at), needsReply: true }));
    const others = holdable.filter((pick) => !pick.needsReply).map((pick) => refOf(pick.email, at));
    const held = [...replies, ...others.map((ref) => ({ ...ref, needsReply: false }))];
    if (due()) {
      addPending(held);
      return unheld;
    }
    const posted = todays(at);
    if (!posted?.mailOpen || at - posted.postedAt >= MAIL_WINDOW_MS) {
      addPending(replies);
      return picks;
    }
    addPending(held);
    posted.important = mergeRefs(posted.important, others);
    refresh(true);
    return unheld;
  }

  const rereadRefs = (posted: PostedBrief): EmailRef[] => [...pending().filter((entry) => entry.needsReply), ...posted.important];

  async function readMessages(posted: PostedBrief, scheduled: boolean): Promise<void> {
    const retry = posted.pendingChecked;
    if (!retry) rereadFailed.clear();
    const gmail = new Map(accounts.usable("gmail").map((account) => [account.id, account]));
    const waiting = pending().filter((entry) => entry.needsReply);
    const failedThisCheck = new Set<string>();
    const drop = new Set<string>();
    const learned = new Set<string>();
    // Every failed read counts towards the account's Reconnect, so an account that failed once is not read again here.
    const read = async <T>(ref: EmailRef, load: (account: SourceAccount) => Promise<T>): Promise<T | null> => {
      const account = gmail.get(ref.account);
      if (!account || failedThisCheck.has(account.id)) return null;
      const answer = await accounts.read(account, () => load(account), scheduled);
      if (answer === null) failedThisCheck.add(account.id);
      return answer;
    };

    for (const ref of rereadRefs(posted).filter((one) => !retry || rereadFailed.has(refKey(one)))) {
      const answer = await read(ref, async (account) => ({ email: await deps.sources.message(account, ref.messageId) }));
      if (!answer) {
        if (gmail.has(ref.account)) rereadFailed.add(refKey(ref));
        continue;
      }
      rereadFailed.delete(refKey(ref));
      learned.add(refKey(ref));
      if (answer.email) remember(answer.email);
      else if (!accounts.selectionIgnored(ref.account)) drop.add(refKey(ref));
    }

    const groups = new Map<string, PendingEmail[]>();
    for (const entry of waiting.filter((one) => !drop.has(refKey(one)))) {
      const group = groupOf(refKey(entry));
      groups.set(group, [...(groups.get(group) ?? []), entry]);
    }
    const addresses = accounts.addresses();
    for (const group of groups.values()) {
      if (retry && !group.some((entry) => learned.has(refKey(entry)))) continue;
      for (const entry of group) {
        const email = headers.get(refKey(entry))?.email;
        const thread = email && await read(entry, (account) => deps.sources.thread(account, email.threadId));
        if (!email || !thread || !answered(email, thread, addresses)) continue;
        for (const copy of group) drop.add(refKey(copy));
        break;
      }
    }

    posted.important = posted.important.filter((ref) => !drop.has(refKey(ref)));
    savePending(prunePending(pending().filter((entry) => !drop.has(refKey(entry))), { now: deps.now(), accounts: accounts.known() }));
    posted.pendingChecked = true;
    refresh(true);
  }

  function checkPending(scheduled: boolean): Promise<void> {
    const posted = brief;
    const retry = posted?.pendingChecked && posted === todays(deps.now()) && rereadRefs(posted).some((ref) => rereadFailed.has(refKey(ref)));
    if (!posted || (posted.pendingChecked && !retry)) return Promise.resolve();
    rereading ??= readMessages(posted, scheduled).finally(() => { rereading = undefined; });
    return rereading;
  }

  function dismiss(accountId: string, messageId: string): void {
    const pressed = groupOf(emailKey({ account: accountId, id: messageId }));
    const same = (ref: EmailRef): boolean => groupOf(refKey(ref)) === pressed;
    let dropped = false;
    const before = pending();
    const kept = before.filter((entry) => !same(entry));
    if (kept.length !== before.length) {
      savePending(kept);
      dropped = true;
    }
    const important = brief?.important.filter((ref) => !same(ref));
    if (brief && important && important.length !== brief.important.length) {
      brief.important = important;
      dropped = true;
    }
    if (dropped) refresh(true);
  }

  return {
    due,
    post,
    waiting: (): boolean => waitingForListing,
    judged,
    mailChecked(): void {
      if (brief) brief.mailOpen = false;
    },
    /** False when the account listing failed: the brief says so in place of what it is still checking. */
    appsReached(reached: boolean): void {
      unreachable = !reached;
      if (!reached) refresh(false);
    },
    checkPending,
    refresh: (): void => refresh(false),
    checked(startedAt: number): void {
      const posted = brief;
      if (!posted?.live || startedAt < posted.postedAt) return;
      refresh(true);
      posted.live = false;
    },
    dismiss,
    email: (accountId: string, messageId: string): EmailHeader | undefined => headers.get(emailKey({ account: accountId, id: messageId }))?.email,
  };
}
