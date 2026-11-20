/**
 * Adding people from the phone's contacts, with the browser's own contact picker
 * (the Contact Picker API). The person picks who to share; Marmoot never sees the
 * rest of their contacts. Chrome on Android has it; iPhone browsers and computers
 * don't, and there the invite link is the quick way: people add themselves.
 *
 * WhatsApp doesn't let websites (or other apps) read its contacts, so there's no
 * "from WhatsApp" option.
 */
import { waNumber } from './whatsapp.ts';

interface ContactInfo {
  name?: string[];
  tel?: string[];
}
interface ContactsManager {
  select(properties: ('name' | 'tel')[], options?: { multiple?: boolean }): Promise<ContactInfo[]>;
}

const manager = (): ContactsManager | null => {
  const c = (globalThis.navigator as unknown as { contacts?: ContactsManager } | undefined)?.contacts;
  return c && typeof c.select === 'function' ? c : null;
};

export function canPickContacts(): boolean {
  return manager() !== null;
}

export interface PickedContact {
  name: string;
  phone: string;
}

/** The number WhatsApp can use: the first one with a country code, else the first that reads as one. */
export function bestPhone(tels: string[] = []): string {
  const clean = tels.map((t) => t.trim()).filter(Boolean);
  return clean.find((t) => t.startsWith('+') && waNumber(t)) ?? clean.find((t) => waNumber(t)) ?? clean[0] ?? '';
}

/** What the picker gave back, as names and numbers. A contact with no name goes by its number. */
export function fromContacts(list: ContactInfo[]): PickedContact[] {
  return list
    .map((c) => {
      const phone = bestPhone(c.tel);
      const name = (c.name ?? []).map((n) => n.trim()).find(Boolean) ?? phone;
      return { name: name.slice(0, 60), phone };
    })
    .filter((c) => c.name);
}

/** Open the phone's contact picker. Resolves to [] if they cancel. */
export async function pickContacts(multiple = true): Promise<PickedContact[]> {
  const c = manager();
  if (!c) return [];
  return fromContacts(await c.select(['name', 'tel'], { multiple }));
}

/** Contacts not already in the list (same number, or same name when there's no number). */
export function newPeople(picked: PickedContact[], existing: { name: string; phone: string }[]): { add: PickedContact[]; already: PickedContact[] } {
  const numbers = new Set(existing.map((m) => waNumber(m.phone)).filter(Boolean));
  const names = new Set(existing.map((m) => m.name.trim().toLowerCase()));
  const add: PickedContact[] = [];
  const already: PickedContact[] = [];
  for (const p of picked) {
    const n = waNumber(p.phone);
    const dup = n ? numbers.has(n) : names.has(p.name.trim().toLowerCase());
    if (dup) {
      already.push(p);
    } else {
      add.push(p);
      if (n) numbers.add(n);
      names.add(p.name.trim().toLowerCase());
    }
  }
  return { add, already };
}
