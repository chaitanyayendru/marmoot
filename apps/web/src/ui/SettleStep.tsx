import { useState } from 'react';
import { usd } from '../money.ts';
import { APP_NAMES, transferKey, type PayApp } from '../model.ts';
import { payAction } from '../payments.ts';
import { settleSummary, whatsappLink } from '../share.ts';
import { Net, Notice } from './bits.tsx';
import type { StepProps } from './NightView.tsx';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SettleStep({ night, derived, dispatch }: StepProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const s = derived.settlement;
  const player = (id: string) => night.players.find((p) => p.id === id);
  const name = (id: string) => player(id)?.name ?? 'Someone';

  if (s.status === 'waiting') {
    return (
      <section aria-label="Settle">
        <Notice>
          Enter a cash-out for {s.missing.map(name).join(', ') || 'everyone'} first. <a href={`#/n/${night.id}/cashout`}>Go to cash out</a>
        </Notice>
      </section>
    );
  }
  if (s.status === 'recount') {
    return (
      <section aria-label="Settle">
        <Notice tone="warn">
          The chips don't match the pot. <a href={`#/n/${night.id}/cashout`}>Recount and fix the cash-outs</a>
        </Notice>
      </section>
    );
  }

  const summary = settleSummary(night, s.transfers, derived.pot);
  const flash = async (id: string, text: string) => {
    if (await copy(text)) {
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    }
  };
  const paidCount = s.transfers.filter((t) => night.paid[transferKey(t)]).length;

  return (
    <section aria-label="Settle">
      <header className="settle-head">
        <h2>
          {s.transfers.length === 0
            ? 'Everyone broke even'
            : `${s.transfers.length} ${s.transfers.length === 1 ? 'payment settles' : 'payments settle'} the night`}
        </h2>
        {s.greedyCount > s.transfers.length && (
          <p className="muted">Pairing the biggest loser with the biggest winner each time would take {s.greedyCount}.</p>
        )}
      </header>

      {s.matched === 'no-apps' && s.transfers.length > 0 && (
        <Notice>Add a payment app for everyone (tap their name on Buy-ins) so each payment uses an app both people have.</Notice>
      )}
      {s.matched === 'infeasible' && (
        <Notice tone="warn">Someone shares no payment app with the people they'd pay, so this plan ignores apps. Ask them to add another app, or settle in cash.</Notice>
      )}

      <ul className="transfers">
        {s.transfers.map((t) => {
          const key = transferKey(t);
          const payee = player(t.to);
          const action = payee ? payAction(t, payee, night.name) : null;
          const paid = Boolean(night.paid[key]);
          return (
            <li key={key} className={paid ? 'paid' : undefined}>
              <p className="who-pays">
                <span>{name(t.from)}</span> pays <span>{name(t.to)}</span>
              </p>
              <p className="num big owed">{usd(t.amount)}</p>
              <p className="via">{t.rail ? `on ${APP_NAMES[t.rail as PayApp | 'cash']}` : action ? '' : `${name(t.to)} hasn't added a payment app`}</p>
              <div className="pay-actions">
                {action?.kind === 'link' && (
                  <a className="button primary" href={action.href} target="_blank" rel="noopener noreferrer">
                    {action.label}
                  </a>
                )}
                {action?.kind === 'copy' && (
                  <button className="primary" onClick={() => flash(key, action.value)}>
                    {copied === key ? 'Copied' : action.label}
                  </button>
                )}
                {action?.kind === 'cash' && <span className="muted">{action.label}</span>}
                <label className="check paid-toggle">
                  <input type="checkbox" checked={paid} onChange={() => dispatch({ type: 'togglePaid', night: night.id, key, at: Date.now() })} />
                  <span>Paid</span>
                </label>
              </div>
              {action?.kind === 'link' && action.caveat && <p className="fine">{action.caveat}</p>}
              {action?.kind === 'copy' && <p className="fine">{action.hint}</p>}
            </li>
          );
        })}
      </ul>

      {s.transfers.length > 0 && (
        <p className="muted progress">
          {paidCount === s.transfers.length ? 'All paid. The night is settled.' : `${paidCount} of ${s.transfers.length} paid.`}
        </p>
      )}

      <div className="share">
        <a className="button primary" href={whatsappLink(summary)} target="_blank" rel="noopener noreferrer">
          Share on WhatsApp
        </a>
        <button onClick={() => flash('summary', summary)}>{copied === 'summary' ? 'Copied' : 'Copy summary'}</button>
      </div>

      <details className="working">
        <summary>How each number was worked out</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">Bought in</th>
              <th scope="col">Cashed out</th>
              <th scope="col">Cash at table</th>
              {s.discrepancy !== 0 && <th scope="col">Chip-count share</th>}
              <th scope="col">Net</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.player}>
                <th scope="row">{name(l.player)}</th>
                <td className="num">{usd(l.buyins)}</td>
                <td className="num">{usd(l.cashouts)}</td>
                <td className="num">
                  {l.cashGiven ? `gave ${usd(l.cashGiven)}` : ''}
                  {l.cashReceived ? `holds ${usd(l.cashReceived)}` : ''}
                  {!l.cashGiven && !l.cashReceived ? '—' : ''}
                </td>
                {s.discrepancy !== 0 && <td className="num">{usd(l.adjustment)}</td>}
                <td>
                  <Net cents={l.net} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fine">Net = cashed out − bought in + cash you handed over − cash you're holding for others. Plus means you're owed.</p>
      </details>
    </section>
  );
}
