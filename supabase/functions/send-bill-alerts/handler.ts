/**
 * POST { owner_token, people?: string[], resend?: boolean }
 *
 * Sends each person on a bill sheet a WhatsApp message from Marmoot's own number,
 * with a button that opens their part of the sheet. Only the sheet's owner token
 * can trigger it. Returns who was messaged, who failed and why, and who has no number.
 */
import { cors, explainError, json, rpc, templateMessage, type Alert, type Env } from '../_shared/whatsapp.ts';

export async function handleSendBillAlerts(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  if (!env.WA_TOKEN || !env.WA_PHONE_NUMBER_ID) {
    return json({ error: 'whatsapp_not_configured', message: 'WhatsApp sending is not set up yet: WA_TOKEN and WA_PHONE_NUMBER_ID are missing.' }, 501);
  }

  let body: { owner_token?: string; people?: string[]; resend?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_request', message: 'Send JSON.' }, 400);
  }
  if (!body.owner_token) return json({ error: 'bad_request', message: 'owner_token is required.' }, 400);

  let alerts: Alert[];
  try {
    alerts = await rpc<Alert[]>(env, 'queue_bill_alerts', {
      p_owner_token: body.owner_token,
      p_people: body.people ?? null,
      p_resend: body.resend ?? false,
    }, fetchImpl);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return json({ error: 'not_allowed', message: (e as Error).message }, status === 400 || status === 403 || status === 404 ? 403 : 500);
  }

  const graph = env.WA_GRAPH_URL || 'https://graph.facebook.com/v25.0';
  const sent: string[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const a of alerts) {
    let waId: string | undefined;
    let error: string | undefined;
    try {
      const res = await fetchImpl(`${graph}/${env.WA_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WA_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(templateMessage(a, env)),
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out?.messages?.[0]?.id) waId = out.messages[0].id;
      else error = explainError(out?.error?.code, out?.error?.message ?? `WhatsApp answered ${res.status}`);
    } catch (e) {
      error = `Could not reach WhatsApp: ${(e as Error).message}`;
    }
    await rpc(env, 'record_alert', {
      p_outbox: a.outbox_id,
      p_status: waId ? 'sent' : 'failed',
      p_wa_message_id: waId ?? null,
      p_error: error ?? null,
    }, fetchImpl);
    if (waId) sent.push(a.person_name);
    else failed.push({ name: a.person_name, error: error! });
  }
  return json({ sent, failed });
}
