/**
 * What each payer taps to pay. Marmoot never moves money: it opens the payment app
 * with the amount filled in where the app supports that, and otherwise shows what
 * to type. Link formats:
 *   Venmo     documented: https://venmo.com/paymentlinks
 *   PayPal    documented: paypal.me/<name>/<amount>
 *   Cash App  amount in the path is NOT documented by Cash App; treat it as best effort
 *   Zelle     no public link format, so we offer the recipient's email or phone to copy
 */
import type { Transfer } from '@marmoot/core';
import { linkAmount, usd } from './money.ts';
import { APP_NAMES, PAY_APPS, type PayApp, type Player } from './model.ts';

export type PayAction =
  | { kind: 'link'; app: PayApp; label: string; href: string; caveat?: string }
  | { kind: 'copy'; app: PayApp; label: string; value: string; hint: string }
  | { kind: 'cash'; label: string };

const clean = {
  venmo: (h: string) => h.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?venmo\.com\/(u\/)?/i, ''),
  paypal: (h: string) => h.trim().replace(/^https?:\/\/(www\.)?paypal\.me\//i, '').replace(/^paypal\.me\//i, '').replace(/\/.*$/, ''),
  cashapp: (h: string) => h.trim().replace(/^https?:\/\/(www\.)?cash\.app\//i, '').replace(/^\$/, '').replace(/\/.*$/, ''),
  zelle: (h: string) => h.trim(),
} satisfies Record<PayApp, (h: string) => string>;

export function payAction(t: Transfer, payee: Player, note: string): PayAction | null {
  const amount = linkAmount(t.amount);
  // Prefer the app the solver matched; without app matching, use the payee's first app.
  const app = (t.rail as PayApp | 'cash' | undefined) ?? PAY_APPS.find((a) => (payee.handles[a] ?? '').trim() !== '') ?? (payee.cash ? 'cash' : undefined);
  if (!app) return null;
  if (app === 'cash') return { kind: 'cash', label: `Hand over ${usd(t.amount)} in cash` };

  const raw = payee.handles[app];
  if (!raw) return null;
  const handle = clean[app](raw);
  if (handle === '') return null;

  switch (app) {
    case 'venmo':
      return {
        kind: 'link',
        app,
        label: `Pay on ${APP_NAMES.venmo}`,
        href: `https://venmo.com/${encodeURIComponent(handle)}?txn=pay&amount=${amount}&note=${encodeURIComponent(note)}&audience=private`,
      };
    case 'paypal':
      return { kind: 'link', app, label: `Pay on ${APP_NAMES.paypal}`, href: `https://paypal.me/${encodeURIComponent(handle)}/${amount}` };
    case 'cashapp':
      return {
        kind: 'link',
        app,
        label: `Pay on ${APP_NAMES.cashapp}`,
        href: `https://cash.app/$${encodeURIComponent(handle)}/${amount}`,
        caveat: `Check Cash App shows ${usd(t.amount)} before you send.`,
      };
    case 'zelle':
      return { kind: 'copy', app, label: 'Copy Zelle details', value: handle, hint: `Send ${usd(t.amount)} by Zelle to ${handle} from your bank's app.` };
  }
}
