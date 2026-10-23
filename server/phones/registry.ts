import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

import { PHONE_CAPABILITIES, PHONE_PLATFORMS } from "../../shared/phone-apps.ts";
import { writeFileAtomic } from "../atomic.ts";

export const phoneRegistration = z.object({
  installId: z.string().regex(/^[\w-]{8,64}$/),
  name: z.string().min(1).max(120),
  platform: z.enum(PHONE_PLATFORMS),
  appVersion: z.string().max(40),
  timeZone: z.string().max(64),
  /** Capability → the OS grant the phone holds ("full", "limited", "when_in_use", "send", "listener"); present means allowed. */
  capabilities: z.partialRecord(z.enum(PHONE_CAPABILITIES), z.string().min(1).max(32)),
}).strict();
export type PhoneRegistration = z.infer<typeof phoneRegistration>;

const recordSchema = z.object({
  key: z.string().min(1).max(300), owner: z.string().min(1).max(300), registration: phoneRegistration,
  registeredAt: z.number(), seen: z.number(), lastUsedAt: z.number().nullable(),
}).strict();
const fileSchema = z.object({ version: z.literal(1), phones: z.array(recordSchema).max(200) });

export type PhoneRecord = { key: string; owner: string; registration: PhoneRegistration; registeredAt: number; seen: number; lastUsedAt: number | null };
/** What the owner's UI and the phone itself see. */
export type PublicPhone = Omit<PhoneRecord, "owner"> & { online: boolean; busy: boolean };

export const PHONE_ONLINE_MS = 60_000;
export const MAX_PHONES = 20;
const SEEN_WRITE_MS = 60_000;

const failure = (message: string, status = 409) => Object.assign(new Error(message), { status });

export class PhoneRegistry {
  private readonly file: string;
  private readonly now: () => number;
  private phones = new Map<string, PhoneRecord>();
  private written = new Map<string, number>();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    try {
      if (existsSync(file)) for (const phone of fileSchema.parse(JSON.parse(readFileSync(file, "utf8"))).phones) this.phones.set(phone.key, phone);
    } catch {
      this.phones = new Map();
      console.warn("phones: the record of paired phones could not be read; starting a new one");
    }
  }

  private save(): void {
    try { writeFileAtomic(this.file, `${JSON.stringify({ version: 1, phones: [...this.phones.values()] })}\n`, { mode: 0o600 }); }
    catch (error) { console.warn(`phones: could not save the record of paired phones: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Same key: update. Same owner + installId under another key: replace that record, keeping its history. */
  register(key: string, owner: string, registration: PhoneRegistration): PhoneRecord {
    const at = this.now();
    const sameKey = this.phones.get(key);
    const twin = [...this.phones.values()].find((phone) => phone.key !== key && phone.owner === owner && phone.registration.installId === registration.installId);
    const previous = sameKey ?? twin;
    if (!previous && this.phones.size >= MAX_PHONES) throw failure("Too many phones");
    if (twin) { this.phones.delete(twin.key); this.written.delete(twin.key); }
    const record: PhoneRecord = { key, owner, registration, registeredAt: previous?.registeredAt ?? at, seen: at, lastUsedAt: previous?.lastUsedAt ?? null };
    this.phones.set(key, record);
    this.written.set(key, at);
    this.save();
    return record;
  }

  get(key: string): PhoneRecord | undefined {
    return this.phones.get(key);
  }

  seen(key: string): void {
    const phone = this.phones.get(key);
    if (!phone) return;
    const at = this.now();
    phone.seen = at;
    if (at - (this.written.get(key) ?? 0) < SEEN_WRITE_MS) return;
    this.written.set(key, at);
    this.save();
  }

  used(key: string): void {
    const phone = this.phones.get(key);
    if (!phone) return;
    phone.lastUsedAt = phone.seen = this.now();
    this.save();
  }

  remove(key: string): boolean {
    if (!this.phones.delete(key)) return false;
    this.written.delete(key);
    this.save();
    return true;
  }

  /** A null owner lists every phone (the desktop admin list). */
  list(owner: string | null, busy: (key: string) => boolean): PublicPhone[] {
    const at = this.now();
    return [...this.phones.values()]
      .filter((phone) => owner === null || phone.owner === owner)
      .sort((a, b) => b.seen - a.seen)
      .map(({ owner: _owner, ...rest }) => ({ ...rest, online: at - rest.seen < PHONE_ONLINE_MS, busy: busy(rest.key) }));
  }

  /** Seen within the last minute. */
  online(key: string): boolean {
    const phone = this.phones.get(key);
    return phone !== undefined && this.now() - phone.seen < PHONE_ONLINE_MS;
  }

  forOwner(owner: string): PhoneRecord[] {
    return [...this.phones.values()].filter((phone) => phone.owner === owner);
  }
}
