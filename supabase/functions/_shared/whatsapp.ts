/**
 * WhatsApp Cloud API helpers shared by the Edge Functions. Pure functions where
 * possible, so they can be tested without Meta.
 *
 * The message is one approved template (WA_TEMPLATE, "bill_ready" by default):
 *
 *   Body:   {{1}} shared a bill with you: {{2}}, {{3}} in total. Tap below to pick
 *           the items you were part of. Everyone splits only what they had.
 *   Button: "Open the bill", a URL button whose link ends in the person's token:
 *           https://<your app>/?s={{1}}
 *
 * See docs/SHARING-SETUP.md for creating it in WhatsApp Manager.
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WA_TOKEN?: string;
  WA_PHONE_NUMBER_ID?: string;
  WA_APP_SECRET?: string;
  WA_VERIFY_TOKEN?: string;
  WA_TEMPLATE?: string;
  WA_TEMPLATE_LANG?: string;
  /** Override for tests; defaults to Meta's Graph API. */
  WA_GRAPH_URL?: string;
}

export function readEnv(get: (k: string) => string | undefined): Env {
  const need = (k: string) => {
    const v = get(k);
    if (!v) throw new Error(`missing environment variable ${k}`);
    return v;
  };
  // Projects on Supabase's newer keys get SUPABASE_SECRET_KEYS ({"default": "sb_secret_..."});
  // older ones get SUPABASE_SERVICE_ROLE_KEY. Either works for calling the database.
  let serviceKey = get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey) {
    try {
      serviceKey = JSON.parse(get('SUPABASE_SECRET_KEYS') ?? '{}').default;
    } catch { /* not set */ }
  }
  if (!serviceKey) throw new Error('missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEYS');
  return {
    SUPABASE_URL: need('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    WA_TOKEN: get('WA_TOKEN'),
    WA_PHONE_NUMBER_ID: get('WA_PHONE_NUMBER_ID'),
    WA_APP_SECRET: get('WA_APP_SECRET'),
    WA_VERIFY_TOKEN: get('WA_VERIFY_TOKEN'),
    WA_TEMPLATE: get('WA_TEMPLATE'),
    WA_TEMPLATE_LANG: get('WA_TEMPLATE_LANG'),
    WA_GRAPH_URL: get('WA_GRAPH_URL'),
  };
}

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

/** $20.90, or 20.90 EUR for other currencies. */
export function money(cents: number, currency: string): string {
  const v = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

export interface Alert {
  outbox_id: string;
  person_id: string;
  to_phone: string;
  person_name: string;
  person_token: string;
  owner_name: string;
  sheet_title: string;
  sheet_total_cents: number;
  currency: string;
}

/** The Graph API body for one bill alert. */
export function templateMessage(a: Alert, env: Pick<Env, 'WA_TEMPLATE' | 'WA_TEMPLATE_LANG'>) {
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: a.to_phone.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: env.WA_TEMPLATE || 'bill_ready',
      language: { code: env.WA_TEMPLATE_LANG || 'en_US' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: a.owner_name },
            { type: 'text', text: a.sheet_title },
            { type: 'text', text: money(Number(a.sheet_total_cents), a.currency) },
          ],
        },
        { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: a.person_token }] },
      ],
    },
  };
}

/** Meta's error codes, in words the bill owner can act on. */
export function explainError(code: number | undefined, fallback: string): string {
  switch (code) {
    case 131030:
      return 'This number is not on the test number\'s list. Add it under WhatsApp > API Setup in Meta, or switch to a real number.';
    case 131026:
      return 'WhatsApp could not deliver to this number. It may not use WhatsApp, or needs to update the app.';
    case 132001:
      return 'The bill_ready message template is missing or not approved yet in WhatsApp Manager.';
    case 132000:
      return 'The message template has a different number of blanks than Marmoot fills. Check it matches the setup guide.';
    case 190:
      return 'The WhatsApp access token expired. Create a new one and update WA_TOKEN.';
    case 131056:
      return 'Too many messages to this number in a short time. Try again in a minute.';
    case 131049:
      return 'Meta held this message back to protect the person from too many business messages. Try again tomorrow.';
    case 131050:
      return 'This person stopped marketing messages from businesses.';
    default:
      return fallback;
  }
}

/** Constant-time check of Meta's X-Hub-Signature-256 header. */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const expected = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice('sha256='.length).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Call a database function through PostgREST with the service role. */
export async function rpc<T>(env: Env, fn: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).message ?? text;
    } catch { /* not JSON */ }
    throw Object.assign(new Error(message), { status: res.status });
  }
  return (text ? JSON.parse(text) : null) as T;
}
