import { ASSISTANT_SERVICES, isAddress, type AssistantService, type AssistantSources, type SourceAccount } from "../assistant-sources.ts";
import { failure } from "../failure.ts";
import { RECONNECT_AFTER } from "./assistant-plan.ts";
import { MAX_ACCOUNTS, MAX_ADDRESS_LENGTH, MAX_ID_LENGTH, MAX_MISSED_LISTINGS, type AccountRecord, type AssistantStateStore } from "./assistant-state.ts";

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
  /** Posts the Reconnect line and card for one account in MausBot's chat; false when nothing was posted. */
  reconnect(account: SourceAccount, label: string | undefined, text: string): boolean;
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
const isService = (id: string): id is AssistantService => (ASSISTANT_SERVICES as readonly string[]).includes(id);

function newRecord(account: SourceAccount): AccountRecord {
  return {
    service: account.service,
    ...(account.alias && storableId(account.alias) ? { alias: account.alias } : {}),
    ...(account.implied ? { implied: true } : {}),
  };
}

function fromRecord(id: string, record: AccountRecord): SourceAccount {
  const active = record.connectedSeen === true && !record.missedListings;
  return { service: record.service, id, ...(record.alias ? { alias: record.alias } : {}), active, ...(record.implied ? { implied: true } : {}) };
}

function withChanges(record: AccountRecord, changes: Partial<AccountRecord>): AccountRecord {
  const next: Record<string, unknown> = { ...record, ...changes };
  for (const [key, value] of Object.entries(changes)) if (value === undefined) delete next[key];
  return next as AccountRecord;
}

export type AssistantAccounts = ReturnType<typeof createAssistantAccounts>;

export function createAssistantAccounts(deps: AssistantAccountsDeps) {
  let listing: SourceAccount[] | null = null;
  let selectionWarned = false;
  const longIdsWarned = new Set<string>();
  const failureCountedAt = new Map<string, number>();
  const lastRead = new Map<string, "ok" | "failed">();

  const records = (): Record<string, AccountRecord> => deps.state.get().accounts ?? {};

  function lastSeen(): SourceAccount[] {
    const kept = Object.entries(records());
    if (!listing) return kept.map(([id, record]) => fromRecord(id, record));
    const listedIds = new Set(listing.map((account) => account.id));
    return [...listing, ...kept.filter(([id, record]) => record.missedListings && !listedIds.has(id)).map(([id, record]) => fromRecord(id, record))];
  }

  function fitsState(account: SourceAccount): boolean {
    if (storableId(account.id)) return true;
    if (!longIdsWarned.has(account.id)) {
      longIdsWarned.add(account.id);
      console.warn(`assistant: a ${account.service} account id of ${account.id.length} characters is longer than assistant.json holds, so MausBot leaves that account out`);
    }
    return false;
  }

  function saveRecord(account: SourceAccount, changes: Partial<AccountRecord>): void {
    const all = records();
    const record = all[account.id];
    if (!record && Object.keys(all).length >= MAX_ACCOUNTS) {
      console.warn(`assistant: ${account.service} account ${account.id} was not saved: assistant.json holds ${MAX_ACCOUNTS} accounts`);
      return;
    }
    deps.state.patch({ accounts: { ...all, [account.id]: withChanges(record ?? newRecord(account), changes) } });
  }

  function patchRecord(id: string, changes: Partial<AccountRecord>): void {
    const all = records();
    const record = all[id];
    if (record) deps.state.patch({ accounts: { ...all, [id]: withChanges(record, changes) } });
  }

  function describe(id: string, handed?: SourceAccount): { service?: AssistantService; label?: string } {
    const record = records()[id];
    const account = handed ?? lastSeen().find((candidate) => candidate.id === id);
    const service = record?.service ?? account?.service ?? (isService(id) ? id : undefined);
    const implied = (record ?? account)?.implied === true || (!record && !account && service !== undefined);
    return { service, label: accountLabel({ id, alias: record?.alias ?? account?.alias, ...(implied ? { implied: true } : {}) }, record?.address) };
  }

  function postReconnect(account: SourceAccount, text: (service: AssistantService, label?: string) => string): boolean {
    const { label } = describe(account.id, account);
    let posted = false;
    try {
      posted = deps.reconnect(account, label, text(account.service, label));
    } catch (error) {
      console.warn(`assistant: the Reconnect card for ${account.service} account ${account.id} was not posted: ${failure(error)}`);
    }
    if (posted) patchRecord(account.id, { reconnectShown: true });
    return posted;
  }

  function noteConnection(account: SourceAccount): void {
    const record = records()[account.id];
    const seen = record?.connectedSeen === true;
    if (account.active) {
      if (!seen) saveRecord(account, { connectedSeen: true, failures: 0, reconnectShown: false });
      return;
    }
    if (!record) {
      if (!account.implied && !account.pending) saveRecord(account, { connectedSeen: false });
      return;
    }
    if (!seen) return;
    if (record.reconnectShown || postReconnect(account, disconnectedText)) patchRecord(account.id, { connectedSeen: false });
  }

  function noteMissing(listed: readonly SourceAccount[]): void {
    const ids = new Set(listed.map((account) => account.id));
    const realServices = new Set(listed.filter((account) => !account.implied).map((account) => account.service));
    const before = Object.entries(records());
    const after: Record<string, AccountRecord> = {};
    const gone: string[] = [];
    for (const [id, record] of before) {
      if (record.implied && realServices.has(record.service)) gone.push(id);
      else if (record.implied || ids.has(id)) after[id] = withChanges(record, { missedListings: undefined });
      else if ((record.missedListings ?? 0) >= MAX_MISSED_LISTINGS) gone.push(id);
      else after[id] = { ...record, missedListings: (record.missedListings ?? 0) + 1 };
    }
    if (!gone.length && before.every(([id, record]) => after[id]?.missedListings === record.missedListings)) return;
    deps.state.patch({ accounts: after });
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
      const listed = answer.filter(fitsState);
      listing = listed;
      for (const account of listed) if (deps.mayUse(account.service)) noteConnection(account);
      noteMissing(listed);
      const kept = records();
      const shared = sharedAddresses();
      const addressDue = (account: SourceAccount): boolean => {
        const record = kept[account.id];
        return record !== undefined && account.active && deps.mayUse(account.service) && (!record.address || shared.has(account.id));
      };
      await Promise.all(listed.filter(addressDue).map(readAddress));
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
      const { service, label } = describe(accountId);
      return label ?? (service ? SERVICE_LABEL[service] : shortId(accountId));
    },

    address: (accountId: string): string | undefined => records()[accountId]?.address,

    addresses: (): ReadonlySet<string> => new Set(Object.values(records()).flatMap((record) => (record.address ? [record.address] : []))),

    /** Composio may run a read as another account than the one it names. Two accounts of one service answering with one
     * address is the sign, and a not-found answer from them can then be about another account's message. */
    selectionIgnored: (accountId: string): boolean => sharedAddresses().has(accountId),
  };
}
