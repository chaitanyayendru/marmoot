/**
 * Creates Marmoot's WhatsApp message template through Meta's API, so there's nothing
 * to click through in WhatsApp Manager. Run it again to see whether Meta approved it.
 *
 *   $env:WA_TOKEN = "<access token from WhatsApp > API Setup>"
 *   $env:WA_WABA_ID = "<WhatsApp Business Account ID, shown as Messaging account ID>"
 *   $env:APP_URL = "https://marmoot.pages.dev"     # your Cloudflare Pages address
 *   npm run wa:template
 *
 * The body must match what send-bill-alerts fills in: three blanks (who, what, total)
 * and one URL button whose link ends in the person's token.
 */

export const TEMPLATE_BODY =
  'Hi! {{1}} shared a bill with you: {{2}}, {{3}} in total. Tap below to pick the items you were part of. Everyone splits only what they had.';

export function templateDefinition(name: string, appUrl: string) {
  const base = appUrl.replace(/\/+$/, '');
  return {
    name,
    language: 'en_US',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: TEMPLATE_BODY, example: { body_text: [['Chai', 'Costco', '$33.39']] } },
      {
        type: 'BUTTONS',
        buttons: [{ type: 'URL', text: 'Open the bill', url: `${base}/?s={{1}}`, example: [`${base}/?s=abc123`] }],
      },
    ],
  };
}

interface Existing {
  id: string;
  name: string;
  status: string;
  category: string;
  rejected_reason?: string;
  components?: { type: string; buttons?: { url?: string }[] }[];
}

async function main() {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) {
      console.error(`Set ${k} first (see the comment at the top of supabase/whatsapp-template.ts).`);
      process.exit(1);
    }
    return v;
  };
  const token = need('WA_TOKEN');
  const waba = need('WA_WABA_ID');
  const appUrl = need('APP_URL');
  const name = process.env.WA_TEMPLATE || 'bill_ready';
  const graph = process.env.WA_GRAPH_URL || 'https://graph.facebook.com/v25.0';
  const auth = { Authorization: `Bearer ${token}` };

  const list = await fetch(`${graph}/${waba}/message_templates?name=${name}&fields=name,status,category,rejected_reason,components`, { headers: auth });
  const listed = (await list.json()) as { data?: Existing[]; error?: { message: string } };
  if (!list.ok) {
    console.error(`Meta said: ${listed.error?.message ?? list.status}`);
    process.exit(1);
  }
  const found = listed.data?.find((t) => t.name === name);
  if (found) {
    const url = found.components?.find((c) => c.type === 'BUTTONS')?.buttons?.[0]?.url;
    console.log(`Template ${name} already exists: ${found.status} (${found.category}).`);
    if (found.rejected_reason && found.rejected_reason !== 'NONE') console.log(`Rejected because: ${found.rejected_reason}`);
    if (url && !url.startsWith(appUrl.replace(/\/+$/, ''))) {
      console.log(`Its button opens ${url}, not ${appUrl}. Delete it in WhatsApp Manager and run this again.`);
    }
    if (found.category !== 'UTILITY') console.log('Meta filed it as marketing, which costs more per message. It still works.');
    return;
  }

  const res = await fetch(`${graph}/${waba}/message_templates`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(templateDefinition(name, appUrl)),
  });
  const out = (await res.json()) as { id?: string; status?: string; category?: string; error?: { message: string; error_user_msg?: string } };
  if (!res.ok) {
    console.error(`Meta refused the template: ${out.error?.error_user_msg ?? out.error?.message ?? res.status}`);
    process.exit(1);
  }
  console.log(`Created template ${name}: ${out.status} (${out.category}).`);
  console.log(out.status === 'APPROVED' ? 'Ready to send.' : 'Run npm run wa:template again in a few minutes to see whether Meta approved it.');
}

if (process.argv[1]?.endsWith('whatsapp-template.ts')) await main();
