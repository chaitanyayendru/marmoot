/**
 * Talks to Marmoot's server (Supabase): the database functions through PostgREST and
 * the WhatsApp Edge Function. Plain fetch, no SDK, and no browser globals, so the
 * same code runs in the app and in the end-to-end test under Node.
 *
 * Bill sheets need no account: every call carries the caller's sheet token, and the
 * database checks it (supabase/migrations/20261109060000_bill_sheets.sql).
 */
import type { Cents } from '@marmoot/core';

export type AlertStatus = 'not_sent' | 'no_phone' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface SheetPerson {
  id: string;
  name: string;
  is_owner: boolean;
  out_of_bill: boolean;
  viewed_at: string | null;
  responded_at: string | null;
  has_phone: boolean;
  /** Owner only. */
  phone: string | null;
  token: string | null;
  alert_status: AlertStatus | null;
  alert_error: string | null;
  alert_updated_at: string | null;
}

export interface SheetEvent {
  id: number;
  kind: string;
  person_id: string | null;
  actor_id: string | null;
  item_id: string | null;
  detail: string | null;
  at: string;
}

export interface SheetData {
  sheet: {
    id: string;
    title: string;
    note: string | null;
    currency: string;
    tax_cents: Cents;
    tip_cents: Cents;
    default_in: boolean;
    status: 'open' | 'closed';
    created_at: string;
    closed_at: string | null;
  };
  me: { id: string; is_owner: boolean };
  people: SheetPerson[];
  items: { id: string; name: string; price_cents: Cents }[];
  choices: { item_id: string; person_id: string; is_in: boolean }[];
  events: SheetEvent[];
}

export interface NewSheet {
  title: string;
  people: { name: string; phone?: string | null; owner?: boolean }[];
  items: { name: string; price: Cents }[];
  tax: Cents;
  tip: Cents;
  note?: string;
  defaultIn: boolean;
}

export interface Created {
  sheet_id: string;
  owner_token: string;
  people: { id: string; name: string; token: string }[];
}

export interface SendResult {
  sent: string[];
  failed: { name: string; error: string }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createApi(baseUrl: string, key: string, fetchImpl: typeof fetch = (...a) => fetch(...a)) {
  const url = baseUrl.replace(/\/+$/, '');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  async function call<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      throw new ApiError("Can't reach Marmoot's server. Check your connection and try again.", 0, 'offline');
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const p = (parsed ?? {}) as { message?: string; error?: string; code?: string };
      throw new ApiError(p.message ?? `The server answered ${res.status}.`, res.status, p.error ?? p.code);
    }
    return parsed as T;
  }
  const rpc = <T = null>(fn: string, args: Record<string, unknown>) => call<T>(`/rest/v1/rpc/${fn}`, args);

  return {
    createSheet: (s: NewSheet) =>
      rpc<Created>('create_bill_sheet', {
        p_title: s.title,
        p_people: s.people,
        p_items: s.items,
        p_tax_cents: s.tax,
        p_tip_cents: s.tip,
        p_note: s.note ?? null,
        p_currency: 'USD',
        p_default_in: s.defaultIn,
      }),
    sheet: (token: string) => rpc<SheetData>('bill_sheet', { p_token: token }),
    markViewed: (token: string) => rpc('mark_bill_viewed', { p_token: token }),
    setChoice: (token: string, item: string, isIn: boolean, person?: string) =>
      rpc('set_bill_choice', { p_token: token, p_item: item, p_in: isIn, p_person: person ?? null }),
    setOutOfBill: (token: string, out: boolean, person?: string) => rpc('set_out_of_bill', { p_token: token, p_out: out, p_person: person ?? null }),
    markDone: (token: string) => rpc('mark_bill_done', { p_token: token }),
    addItem: (owner: string, name: string, price: Cents) => rpc<string>('add_bill_item', { p_owner_token: owner, p_name: name, p_price_cents: price }),
    updateItem: (owner: string, item: string, name: string, price: Cents) =>
      rpc('update_bill_item', { p_owner_token: owner, p_item: item, p_name: name, p_price_cents: price }),
    removeItem: (owner: string, item: string) => rpc('remove_bill_item', { p_owner_token: owner, p_item: item }),
    updateSheet: (owner: string, s: { title: string; note: string | null; tax: Cents; tip: Cents }) =>
      rpc('update_bill_sheet', { p_owner_token: owner, p_title: s.title, p_note: s.note, p_tax_cents: s.tax, p_tip_cents: s.tip }),
    addPerson: (owner: string, name: string, phone?: string | null) =>
      rpc<{ id: string; name: string; token: string }>('add_bill_person', { p_owner_token: owner, p_name: name, p_phone: phone ?? null }),
    setPhone: (owner: string, person: string, phone: string | null) => rpc('set_bill_person_phone', { p_owner_token: owner, p_person: person, p_phone: phone }),
    close: (owner: string, close = true) => rpc('close_bill_sheet', { p_owner_token: owner, p_close: close }),
    /** Marmoot's WhatsApp number messages everyone not yet messaged (or the people listed). */
    sendAlerts: (owner: string, people?: string[], resend = false) =>
      call<SendResult>('/functions/v1/send-bill-alerts', { owner_token: owner, people: people ?? null, resend }),
  };
}

export type Api = ReturnType<typeof createApi>;
