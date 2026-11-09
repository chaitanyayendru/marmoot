import type { ReactNode } from 'react';
import { usd } from '../money.ts';

/** One dot per buy-in, so rebuys are visible at a glance. */
export function Chips({ count }: { count: number }) {
  const shown = Math.min(count, 6);
  return (
    <span className="chips" aria-label={`${count} buy-in${count === 1 ? '' : 's'}`}>
      {Array.from({ length: shown }, (_, i) => (
        <span key={i} className="chip" />
      ))}
      {count > shown && <span className="chip-more">+{count - shown}</span>}
    </span>
  );
}

/** A signed amount: brass when someone is owed, red when they owe. */
export function Net({ cents, big = false }: { cents: number; big?: boolean }) {
  const cls = cents > 0 ? 'up' : cents < 0 ? 'down' : 'even';
  return <span className={`num ${big ? 'big' : ''} ${cls}`}>{cents > 0 ? `+${usd(cents)}` : usd(cents)}</span>;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p className={`notice ${tone}`} role={tone === 'warn' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

export function NotSaving() {
  return <Notice tone="warn">This browser isn't saving your nights. Keep this page open until the night is settled.</Notice>;
}
