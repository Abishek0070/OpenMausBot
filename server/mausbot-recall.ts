import { audienceWithin, roomFeeds } from "./bot-visibility.ts";
import { isAssistantJobThread } from "./host/assistant-turns.ts";
import type { BotRecord, GroupRecord } from "./store.ts";

type Tasked = { threadId: string; tasks?: readonly { threadId: string; routineRunId?: string }[] };

/** MausBot's hidden job threads hold untrusted invite and email text, so they never come back as search hits. */
function addThreads(threads: Set<string>, owner: Tasked): void {
  for (const task of owner.tasks ?? []) {
    if (!isAssistantJobThread(task.routineRunId)) threads.add(task.threadId);
  }
}

/** Every conversation MausBot may read: each bot's and room's threads within MausBot's own audience. */
export function assistantRecallThreads(store: { bots: readonly BotRecord[]; groups: readonly GroupRecord[]; bot(id: string): BotRecord | null }, from: BotRecord): string[] {
  const threads = new Set<string>();
  for (const bot of store.bots) {
    if (!audienceWithin(from.visibility, bot.visibility)) continue;
    threads.add(bot.threadId);
    addThreads(threads, bot);
  }
  for (const group of store.groups) {
    const members = group.memberIds.flatMap((id) => {
      const member = store.bot(id);
      return member ? [member.visibility] : [];
    });
    if (!roomFeeds([...members, group.audienceFloor], from.visibility)) continue;
    threads.add(group.threadId);
    addThreads(threads, group);
  }
  return [...threads];
}

export function assistantHitTitle(
  store: { botByThread(threadId: string): BotRecord | null; taskByThread(botId: string, threadId: string): { title: string } | undefined },
  from: BotRecord,
  threadId: string,
): string | undefined {
  const owner = store.botByThread(threadId);
  if (!owner) return undefined;
  const title = store.taskByThread(owner.id, threadId)?.title;
  return owner.id === from.id ? title : `${owner.name} · ${title ?? "conversation"}`;
}
