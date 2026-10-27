import { useSyncExternalStore } from "react";

import type { Group } from "@/state/store";

const watchers = new Set<() => void>();
let openGroupId: string | null = null;
let opener: HTMLElement | null = null;

function publish(next: string | null) {
  if (next === openGroupId) return;
  openGroupId = next;
  for (const watch of Array.from(watchers)) watch();
}

export function openRoomPanel(groupId: string, from?: HTMLElement | null): void {
  opener = from ?? null;
  publish(groupId);
}

/** `refocus` hands focus back to what opened the panel, for a close the person asked for. */
export function closeRoomPanel({ refocus = false }: { refocus?: boolean } = {}): void {
  const returnTo = opener;
  opener = null;
  publish(null);
  if (refocus && returnTo?.isConnected) returnTo.focus();
}

function subscribe(watch: () => void) {
  watchers.add(watch);
  return () => {
    watchers.delete(watch);
  };
}

export function useRoomPanel(): string | null {
  return useSyncExternalStore(subscribe, () => openGroupId, () => null);
}

// A remote client cannot open desktop panels, so it keeps every control in the header.
export function simpleRoomHeader({ advanced, remoteClient, group, setupPending }: {
  advanced: boolean;
  remoteClient: boolean;
  group: Pick<Group, "dm">;
  setupPending: boolean;
}): boolean {
  return !advanced && !remoteClient && !group.dm && !setupPending;
}
