import { useState, type Dispatch, type FormEvent } from 'react';
import { go } from '../App.tsx';
import { parseDollars, usd, usdShort } from '../money.ts';
import { defaultNightName, derive, newId, type Action, type BuyInMode, type Night } from '../model.ts';
import { NotSaving } from './bits.tsx';

export function Home({ nights, dispatch, saved }: { nights: Night[]; dispatch: Dispatch<Action>; saved: boolean }) {
  const [name, setName] = useState('');
  const [buyIn, setBuyIn] = useState('20');
  const [mode, setMode] = useState<BuyInMode>('settle-later');
  const buyInCents = parseDollars(buyIn);

  function start(e: FormEvent) {
    e.preventDefault();
    if (!buyInCents) return;
    const id = newId();
    const at = Date.now();
    dispatch({ type: 'createNight', id, name: name.trim() || defaultNightName(at), buyIn: buyInCents, mode, at });
    go(`/n/${id}/table`);
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1 className="wordmark">Marmoot</h1>
        <p className="lede">Track buy-ins at the table, then settle up in the fewest payments, using apps both people have.</p>
      </header>

      {!saved && <NotSaving />}

      <form className="panel start" onSubmit={start}>
        <h2>Start a poker night</h2>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={defaultNightName(Date.now())} />
        </label>
        <label className="field">
          <span>Buy-in</span>
          <input inputMode="decimal" value={buyIn} onChange={(e) => setBuyIn(e.target.value)} aria-invalid={buyInCents === null || buyInCents === 0} />
        </label>
        <fieldset className="choice">
          <legend>How do people pay for chips?</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'settle-later'} onChange={() => setMode('settle-later')} />
            <span>Nobody pays now; everything settles at the end</span>
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'cash-to-host'} onChange={() => setMode('cash-to-host')} />
            <span>Cash to the host at each buy-in</span>
          </label>
        </fieldset>
        <button className="primary" disabled={!buyInCents}>
          Start night{buyInCents ? `, ${usdShort(buyInCents)} buy-in` : ''}
        </button>
      </form>

      {nights.length > 0 && (
        <section className="history" aria-label="Your poker nights">
          <h2>Your nights</h2>
          <ul>
            {nights.map((n) => {
              const d = derive(n);
              const settled = d.settlement.status === 'ready';
              return (
                <li key={n.id}>
                  <a href={`#/n/${n.id}/${settled ? 'settle' : 'table'}`}>
                    <span className="h-name">{n.name}</span>
                    <span className="h-meta">
                      {n.players.length} players, {settled ? 'ready to settle' : 'in progress'}
                    </span>
                    <span className="num h-pot">{usd(d.pot)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
