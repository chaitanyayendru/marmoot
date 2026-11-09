import { useState } from 'react';
import { go } from '../App.tsx';
import { parseDollars, usd } from '../money.ts';
import { Net, Notice } from './bits.tsx';
import type { StepProps } from './NightView.tsx';

export function CashOutStep({ night, derived, dispatch }: StepProps) {
  // Keep what was typed, even if it doesn't parse yet, so the field never fights the user.
  const [text, setText] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(night.cashouts).map(([k, v]) => [k, (v / 100).toFixed(2)])),
  );
  const cashIn = (id: string) => night.events.reduce((s, e) => (e.kind === 'cash' && e.from === id ? s + e.amount : s), 0);
  const cashHeld = (id: string) => night.events.reduce((s, e) => (e.kind === 'cash' && e.to === id ? s + e.amount : s), 0);

  const s = derived.settlement;
  const entered = Object.keys(night.cashouts).length;
  const gap = derived.cashedOut - derived.pot;

  return (
    <section aria-label="Cash out">
      <p className="mode">Count each stack and enter what it's worth in dollars.</p>
      <ul className="roster cashout">
        {night.players.map((p) => {
          const bought = derived.totals.get(p.id)?.buyins ?? 0;
          const out = night.cashouts[p.id];
          const value = text[p.id] ?? '';
          const bad = value.trim() !== '' && parseDollars(value) === null;
          return (
            <li key={p.id} className="row">
              <label className="who" htmlFor={`co-${p.id}`}>
                <span className="who-name">{p.name}</span>
                <span className="who-meta">bought in {usd(bought)}</span>
              </label>
              <input
                id={`co-${p.id}`}
                className="num money"
                inputMode="decimal"
                placeholder="0.00"
                value={value}
                aria-invalid={bad}
                onChange={(e) => {
                  setText({ ...text, [p.id]: e.target.value });
                  dispatch({ type: 'setCashout', night: night.id, player: p.id, amount: parseDollars(e.target.value) });
                }}
              />
              <span className="preview">
                {out !== undefined ? <Net cents={out - bought + cashIn(p.id) - cashHeld(p.id)} /> : <span className="muted">—</span>}
              </span>
            </li>
          );
        })}
      </ul>

      <div className="tally" aria-live="polite">
        <p>
          Counted <span className="num">{usd(derived.cashedOut)}</span> of <span className="num">{usd(derived.pot)}</span> in the pot
          {entered < night.players.length ? `, ${night.players.length - entered} still to count.` : '.'}
        </p>
        {s.status === 'recount' && (
          <Notice tone="warn">
            The chips come to {usd(Math.abs(s.discrepancy))} {s.discrepancy > 0 ? 'more' : 'less'} than the pot. That's more than the {usd(s.limit)} allowed, so recount before settling.
          </Notice>
        )}
        {s.status === 'ready' && gap !== 0 && (
          <Notice>
            Off by {usd(Math.abs(gap))}, which is within 1% of the pot. The difference is shared across players by how much each bought in.
          </Notice>
        )}
      </div>

      <button className="primary next" disabled={s.status !== 'ready'} onClick={() => go(`/n/${night.id}/settle`)}>
        Work out who pays whom
      </button>
    </section>
  );
}
