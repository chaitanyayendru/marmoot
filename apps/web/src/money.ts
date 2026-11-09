/** Parse what someone types into a money field ("20", "$12.5", "1,250.00") into cents. */
export function parseDollars(input: string): number | null {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (s === '') return null;
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** $1,234.50 — always two decimals, minus sign before the dollar sign. */
export function usd(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const a = Math.abs(cents);
  const dollars = Math.floor(a / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(a % 100).padStart(2, '0')}`;
}

/** $20 for whole dollars, $12.50 otherwise. Used where space is tight (buttons). */
export function usdShort(cents: number): string {
  return cents % 100 === 0 ? `$${(cents / 100).toLocaleString('en-US')}` : usd(cents);
}

/** Plain decimal for payment links: 1250 -> "12.50". */
export function linkAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}
