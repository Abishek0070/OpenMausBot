import { isAddress, type AssistantService, type AssistantSources, type SourceAccount } from "../assistant-sources.ts";
import { failure } from "../failure.ts";
import { RECONNECT_AFTER } from "./assistant-plan.ts";
import { MAX_ACCOUNTS, MAX_ADDRESS_LENGTH, MAX_ID_LENGTH, type AccountRecord, type AssistantStateStore } from "./assistant-state.ts";

const SHORT_ID = 6;
const SERVICE_LABEL: Record<AssistantService, string> = { gmail: "Gmail", googlecalendar: "Google Calendar" };
const RECONNECT_NAME: Record<AssistantService, string> = { gmail: "Gmail", googlecalendar: "Calendar" };
const READS: Record<AssistantService, string> = { gmail: "email", googlecalendar: "calendar" };

export interface AssistantAccountsDeps {
  state: AssistantStateStore;
  sources: Pick<AssistantSources, "accounts" | "address">;
  now(): number;
  checkMs: number;
  mayUse(service: AssistantService): boolean;
  /** Posts the Reconnect line and card for one account in MausBot's chat. */
  reconnect(account: SourceAccount, label: string | undefined, text: string): void;
}

const shortId = (id: string): string => `account …${id.slice(-SHORT_ID)}`;

export function accountLabel(account: Pick<SourceAccount, "id" | "alias" | "implied">, address?: string): string | undefined {
  return address || account.alias || (account.implied ? undefined : shortId(account.id));
}

const reconnectLead = (service: AssistantService, label?: string): string => `Reconnect ${RECONNECT_NAME[service]}${label ? ` for ${label}` : ""}`;

export function reconnectText(service: AssistantService, label?: string): string {
  const whose = label ? "its" : "your";
  return `${reconnectLead(service, label)}: I couldn't read ${whose} ${READS[service]} three times in a row.`;
}

export function disconnectedText(service: AssistantService, label?: string): string {
  const [which, whose] = label ? ["that", "its"] : ["your", "your"];
  return `${reconnectLead(service, label)}: ${which} ${SERVICE_LABEL[service]} connection stopped working, so I can't read ${whose} ${READS[service]}.`;
}

const storableId = (id: string): boolean => id.length >= 1 && id.length <= MAX_ID_LENGTH;
const isService = (id: string): id is AssistantService => Object.hasOwn(SERVICE_LABEL, id);

function newRecord(account: SourceAccount): AccountRecord {
  return {
    service: account.service,
    ...(account.alias && storableId(account.alias) ? { alias: account.alias } : {}),
    ...(account.implied ? { implied: true } : {}),
  };
}

function fromRecord(id: string, record: AccountRecord): SourceAccount {
  return { service: record.service, id, ...(record.alias ? { alias: record.alias } : {}), active: record.connectedSeen === true, ...(record.implied ? { implied: true } : {}) };
}

export type AssistantAccounts = ReturnType<typeof createAssistantAccounts>;

export function createAssistantAccounts(deps: AssistantAccountsDeps) {
  let listing: SourceAccount[] | null = null;
  let selectionWarned = false;
  const failureCountedAt = new Map<string, number>();
  const lastRead = new Map<string, "ok" | "failed">();

  const records = (): Record<string, AccountRecord> => deps.state.get().accounts ?? {};
  const lastSeen = (): SourceAccount[] => listing ?? Object.entries(records()).map(([id, record]) => fromRecord(id, record));

  function saveRecord(account: SourceAccount, changes: Partial<AccountRecord>): void {
    const all = records();
    const record = all[account.id];
    if (!record && Object.keys(all).length >= MAX_ACCOUNTS) {
      console.warn(`assistant: ${account.service} account ${account.id} was not saved: assistant.json holds ${MAX_ACCOUNTS} accounts`);
      return;
    }
    deps.state.patch({ accounts: { ...all, [account.id]: { ...(record ?? newRecord(account)), ...changes } } });
  }

  function patchRecord(id: string, changes: Partial<AccountRecord>): void {
    const all = records();
    const record = all[id];
    if (record) deps.state.patch({ accounts: { ...all, [id]: { ...record, ...changes } } });
  }

  function postReconnect(account: SourceAccount, text: (service: AssistantService, label?: string) => string): void {
    patchRecord(account.id, { reconnectShown: true });
    const label = accountLabel(account, records()[account.id]?.address);
    try {
      deps.reconnect(account, label, text(account.service, label));
    } catch (error) {
      console.warn(`assistant: the Reconnect card for ${account.service} account ${account.id} was not posted: ${failure(error)}`);
    }
  }

  function noteConnection(account: SourceAccount): void {
    const record = records()[account.id];
    if (account.active === (record?.connectedSeen === true)) return;
    if (account.active) {
      saveRecord(account, { connectedSeen: true, failures: 0, reconnectShown: false });
      return;
    }
    patchRecord(account.id, { connectedSeen: false });
    if (!record?.reconnectShown) postReconnect(account, disconnectedText);
  }

  function forgetUnlisted(listed: readonly SourceAccount[]): void {
    const ids = new Set(listed.map((account) => account.id));
    const realServices = new Set(listed.filter((account) => !account.implied).map((account) => account.service));
    const all = Object.entries(records());
    const gone = new Set(all.filter(([id, record]) => (record.implied ? realServices.has(record.service) : !ids.has(id))).map(([id]) => id));
    if (!gone.size) return;
    deps.state.patch({ accounts: Object.fromEntries(all.filter(([id]) => !gone.has(id))) });
    for (const id of gone) {
      lastRead.delete(id);
      failureCountedAt.delete(id);
    }
  }

  async function readAddress(account: SourceAccount): Promise<void> {
    try {
      const answer = (await deps.sources.address(account))?.trim().toLowerCase();
      if (answer && answer.length <= MAX_ADDRESS_LENGTH && isAddress(answer)) patchRecord(account.id, { address: answer });
    } catch (error) {
      console.warn(`assistant: reading the address of ${account.service} account ${account.id} failed: ${failure(error)}`);
    }
  }

  function sharedAddresses(): Set<string> {
    const byAddress = new Map<string, string[]>();
    for (const [id, record] of Object.entries(records())) {
      if (!record.address) continue;
      const key = `${record.service} ${record.address}`;
      byAddress.set(key, [...(byAddress.get(key) ?? []), id]);
    }
    return new Set([...byAddress.values()].filter((ids) => ids.length > 1).flat());
  }

  function warnSharedAddresses(): void {
    const shared = sharedAddresses();
    if (!shared.size || selectionWarned) return;
    selectionWarned = true;
    console.warn(`assistant: accounts ${[...shared].join(", ")} answered with the same address, so connected apps may be ignoring which account a read names; a missing message from them is not trusted`);
  }

  return {
    async refresh(): Promise<SourceAccount[] | null> {
      const answer = await deps.sources.accounts();
      if (!answer) return null;
      const listed = answer.filter((account) => storableId(account.id));
      listing = listed;
      for (const account of listed) if (deps.mayUse(account.service)) noteConnection(account);
      forgetUnlisted(listed);
      const kept = records();
      const unaddressed = listed.filter((account) => account.active && deps.mayUse(account.service) && kept[account.id] && !kept[account.id]!.address);
      await Promise.all(unaddressed.map(readAddress));
      warnSharedAddresses();
      return listed;
    },

    listed: (): boolean => listing !== null,

    usable(service: AssistantService): SourceAccount[] {
      if (!deps.mayUse(service)) return [];
      return lastSeen().filter((account) => account.service === service && account.active);
    },

    unreadable(service: AssistantService): SourceAccount[] {
      if (!deps.mayUse(service)) return [];
      const kept = records();
      return lastSeen().filter((account) => account.service === service && (account.active ? lastRead.get(account.id) === "failed" : Object.hasOwn(kept, account.id)));
    },

    known: (): ReadonlySet<string> => new Set(Object.keys(records())),

    async read<T>(account: SourceAccount, load: () => Promise<T>, scheduled: boolean): Promise<T | null> {
      try {
        const value = await load();
        lastRead.set(account.id, "ok");
        const record = records()[account.id];
        if (record?.failures || record?.reconnectShown) patchRecord(account.id, { failures: 0, reconnectShown: false });
        return value;
      } catch (error) {
        lastRead.set(account.id, "failed");
        const at = deps.now();
        if (!scheduled && at - (failureCountedAt.get(account.id) ?? -Infinity) < deps.checkMs) {
          console.warn(`assistant: reading ${account.service} account ${account.id} failed again within one check interval: ${failure(error)}`);
          return null;
        }
        failureCountedAt.set(account.id, at);
        const record = records()[account.id];
        const count = (record?.failures ?? 0) + 1;
        patchRecord(account.id, { failures: count });
        console.warn(`assistant: reading ${account.service} account ${account.id} failed (${count} in a row): ${failure(error)}`);
        if (record && count >= RECONNECT_AFTER && !record.reconnectShown && deps.mayUse(account.service)) postReconnect(account, reconnectText);
        return null;
      }
    },

    readState: (accountId: string): "ok" | "failed" | undefined => lastRead.get(accountId),

    label(accountId: string): string {
      const record = records()[accountId];
      const account = listing?.find((candidate) => candidate.id === accountId) ?? (record && fromRecord(accountId, record));
      if (account) return accountLabel(account, record?.address) ?? SERVICE_LABEL[account.service];
      return isService(accountId) ? SERVICE_LABEL[accountId] : shortId(accountId);
    },

    address: (accountId: string): string | undefined => records()[accountId]?.address,

    addresses: (): ReadonlySet<string> => new Set(Object.values(records()).flatMap((record) => (record.address ? [record.address] : []))),

    /** Composio may run a read as another account than the one it names. Two accounts of one service answering with one
     * address is the sign, and a not-found answer from them can then be about another account's message. */
    selectionIgnored: (accountId: string): boolean => sharedAddresses().has(accountId),
  };
}
