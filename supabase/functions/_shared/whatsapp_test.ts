import { assertEquals } from 'jsr:@std/assert@1';
import { handleSendBillAlerts } from '../send-bill-alerts/handler.ts';
import { handleWhatsAppWebhook } from '../whatsapp-webhook/handler.ts';
import { money, readEnv, templateMessage, verifySignature, type Alert, type Env } from './whatsapp.ts';

const env: Env = {
  SUPABASE_URL: 'http://db.test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  WA_TOKEN: 'wa-token',
  WA_PHONE_NUMBER_ID: '1234567890',
  WA_APP_SECRET: 'app-secret',
  WA_VERIFY_TOKEN: 'verify-me',
  WA_GRAPH_URL: 'http://graph.test',
};

const alert = (name: string, phone: string): Alert => ({
  outbox_id: `out-${name}`, person_id: `p-${name}`, to_phone: phone, person_name: name, person_token: `tok-${name}`,
  owner_name: 'Chai', sheet_title: 'Costco', sheet_total_cents: 2090, currency: 'USD',
});

/** A fake fetch for PostgREST and the Graph API that records every call. */
function fakeFetch(graph: (body: any) => { status: number; body: unknown }) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    if (url === 'http://db.test/rest/v1/rpc/queue_bill_alerts') {
      if (body.p_owner_token !== 'owner-token') return new Response(JSON.stringify({ message: 'Only the person who shared this bill can do that.' }), { status: 403 });
      return Response.json([alert('Chandu', '+919845012345'), alert('Hima', '+14045550199')]);
    }
    if (url.startsWith('http://db.test/rest/v1/rpc/')) return new Response(null, { status: 204 });
    if (url === 'http://graph.test/1234567890/messages') {
      const r = graph(body);
      return Response.json(r.body, { status: r.status });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { impl, calls };
}

const post = (body: unknown) => new Request('http://fn.test/send-bill-alerts', { method: 'POST', body: JSON.stringify(body) });

Deno.test('the template carries the owner, the bill, the total and the person\'s own link', () => {
  const m = templateMessage(alert('Hima', '+14045550199'), {});
  assertEquals(m.to, '14045550199');
  assertEquals(m.template.name, 'bill_ready');
  assertEquals(m.template.components[0].parameters.map((p) => p.text), ['Chai', 'Costco', '$20.90']);
  assertEquals(m.template.components[1].parameters[0].text, 'tok-Hima');
  assertEquals(money(123456, 'EUR'), '1234.56 EUR');
});

Deno.test('sends each person a message and records what WhatsApp said', async () => {
  const { impl, calls } = fakeFetch((b) =>
    b.to === '14045550199'
      ? { status: 400, body: { error: { code: 131030, message: 'Recipient phone number not in allowed list' } } }
      : { status: 200, body: { messages: [{ id: 'wamid.ABC' }] } }
  );
  const res = await handleSendBillAlerts(post({ owner_token: 'owner-token' }), env, impl);
  const out = await res.json();
  assertEquals(res.status, 200);
  assertEquals(out.sent, ['Chandu']);
  assertEquals(out.failed[0].name, 'Hima');
  assertEquals(out.failed[0].error.includes('test number'), true);
  const records = calls.filter((c) => c.url.endsWith('/record_alert')).map((c) => [c.body.p_outbox, c.body.p_status, c.body.p_wa_message_id]);
  assertEquals(records, [['out-Chandu', 'sent', 'wamid.ABC'], ['out-Hima', 'failed', null]]);
  const graphCall = calls.find((c) => c.url.startsWith('http://graph.test'))!;
  assertEquals(graphCall.headers.get('authorization'), 'Bearer wa-token');
  assertEquals(calls[0].headers.get('apikey'), 'service-key');
});

Deno.test('a guest token cannot send; missing setup says so', async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: {} }));
  const denied = await handleSendBillAlerts(post({ owner_token: 'guest-token' }), env, impl);
  assertEquals(denied.status, 403);
  const unset = await handleSendBillAlerts(post({ owner_token: 'owner-token' }), { ...env, WA_TOKEN: undefined }, impl);
  assertEquals(unset.status, 501);
  assertEquals((await unset.json()).error, 'whatsapp_not_configured');
});

async function sign(raw: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test('webhook: subscription check, signature check, statuses stored', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: {} }));
  const ok = await handleWhatsAppWebhook(new Request('http://fn.test/?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42'), env, impl);
  assertEquals([ok.status, await ok.text()], [200, '42']);
  const bad = await handleWhatsAppWebhook(new Request('http://fn.test/?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42'), env, impl);
  assertEquals(bad.status, 403);

  const raw = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [
    { id: 'wamid.ABC', status: 'delivered' },
    { id: 'wamid.DEF', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] },
  ] } }] }] });
  const forged = await handleWhatsAppWebhook(new Request('http://fn.test/', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': await sign(raw, 'wrong') } }), env, impl);
  assertEquals(forged.status, 401);
  const real = await handleWhatsAppWebhook(new Request('http://fn.test/', { method: 'POST', body: raw, headers: { 'x-hub-signature-256': await sign(raw, 'app-secret') } }), env, impl);
  assertEquals(real.status, 200);
  const stored = calls.filter((c) => c.url.endsWith('/record_whatsapp_status')).map((c) => [c.body.p_wa_message_id, c.body.p_status, c.body.p_error?.slice(0, 26) ?? null]);
  assertEquals(stored, [['wamid.ABC', 'delivered', null], ['wamid.DEF', 'failed', 'WhatsApp could not deliver']]);
  assertEquals(await verifySignature(raw, null, 'app-secret'), false);
});

Deno.test('reads the service key from either the legacy or the newer variable', () => {
  const vars: Record<string, string> = { SUPABASE_URL: 'u', SUPABASE_SECRET_KEYS: '{"default":"sb_secret_x"}' };
  assertEquals(readEnv((k) => vars[k]).SUPABASE_SERVICE_ROLE_KEY, 'sb_secret_x');
  assertEquals(readEnv((k) => ({ ...vars, SUPABASE_SERVICE_ROLE_KEY: 'legacy' })[k]).SUPABASE_SERVICE_ROLE_KEY, 'legacy');
});
