/**
 * Meta's webhook for Marmoot's WhatsApp number.
 *
 * GET: the one-time subscription check (hub.verify_token must equal WA_VERIFY_TOKEN).
 * POST: delivery updates. Each status (sent, delivered, read, failed) is matched to
 * the outbox row by Meta's message id and shown to the bill owner. The request is
 * rejected unless X-Hub-Signature-256 matches WA_APP_SECRET.
 */
import { explainError, rpc, verifySignature, type Env } from '../_shared/whatsapp.ts';

interface StatusUpdate {
  id: string;
  status: string;
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

export async function handleWhatsAppWebhook(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && !!env.WA_VERIFY_TOKEN && url.searchParams.get('hub.verify_token') === env.WA_VERIFY_TOKEN;
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const raw = await req.text();
  if (!env.WA_APP_SECRET || !(await verifySignature(raw, req.headers.get('x-hub-signature-256'), env.WA_APP_SECRET))) {
    return new Response('bad signature', { status: 401 });
  }

  let payload: { entry?: { changes?: { value?: { statuses?: StatusUpdate[] } }[] }[] };
  try {
    payload = JSON.parse(raw);
  } catch {
    return new Response('bad json', { status: 400 });
  }
  const statuses = (payload.entry ?? []).flatMap((e) => (e.changes ?? []).flatMap((c) => c.value?.statuses ?? []));
  for (const s of statuses) {
    const err = s.errors?.[0];
    const message = err ? explainError(err.code, err.error_data?.details ?? err.message ?? err.title ?? 'WhatsApp could not deliver it.') : null;
    await rpc(env, 'record_whatsapp_status', { p_wa_message_id: s.id, p_status: s.status, p_error: message }, fetchImpl);
  }
  // Meta retries anything but a 200, so answer 200 once the statuses are stored.
  return new Response('ok', { status: 200 });
}
