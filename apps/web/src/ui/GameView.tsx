import { useMemo, useState, type Dispatch } from 'react';
import { ChevronLeft } from 'lucide-react';
import { go } from '../App.tsx';
import { parseDollars, usd, usdShort } from '../money.ts';
import { gameResult, gameTotals, newId, type Action, type GameItem, type GameUpdate, type Group } from '../model.ts';
import { NotSaving, Notice, Signed } from './bits.tsx';

type Step = 'buyins' | 'cashout' | 'results';

export function GameView({ group, game, dispatch, saved }: { group: Group; game: GameItem; dispatch: Dispatch<Action>; saved: boolean }) {
  const [step, setStep] = useState<Step>(game.closed ? 'results' : 'buyins');
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(game.cashouts).map(([k, v]) => [k, (v / 100).toFixed(2)])));
  const { totals, pot, cashedOut } = useMemo(() => gameTotals(game), [game]);
  const result = useMemo(() => gameResult(game), [game]);
  const name = (id: string) => group.members.find((m) => m.id === id)?.name ?? 'Someone';
  const host = game.hostId ? name(game.hostId) : null;
  const update = (u: GameUpdate) => dispatch({ type: 'updateGame', group: group.id, game: game.id, update: u });
  const recent = game.events.filter((e) => e.kind === 'buyin').slice(-5).reverse();

  return (
    <main className="page">
      <header className="topbar">
        <a className="back" href={`#/g/${group.id}`}><ChevronLeft size={22} /> {group.name}</a>
      </header>
      {!saved && <NotSaving />}

      <section className="hero" aria-label="Game night">
        <h1 className="hero-title">{game.name}</h1>
        <p className="hero-amount num">{usd(pot)}</p>
        <p className="hero-sub flat">in the pot, {game.players.length} players</p>
      </section>

      {!game.closed && (
        <div className="segmented tight" role="tablist" aria-label="Game steps">
          {(['buyins', 'cashout', 'results'] as Step[]).map((s, i) => (
            <button key={s} role="tab" aria-selected={step === s} className={step === s ? 'on' : undefined} onClick={() => setStep(s)}>
              {i + 1}. {s === 'buyins' ? 'Buy-ins' : s === 'cashout' ? 'Cash out' : 'Results'}
            </button>
          ))}
        </div>
      )}

      {step === 'buyins' && !game.closed && (
        <section className="stack" aria-label="Buy-ins">
          <p className="fine">
            {game.mode === 'cash-to-host' ? `Buy-ins are paid in cash to ${host ?? 'the host'}.` : 'Nobody pays for chips now; results go into the group balances.'}{' '}
            <button className="link" onClick={() => update({ kind: 'mode', mode: game.mode === 'cash-to-host' ? 'settle-later' : 'cash-to-host' })}>
              {game.mode === 'cash-to-host' ? 'Settle everything later instead' : 'Pay the host in cash instead'}
            </button>
          </p>
          <ul className="list">
            {game.players.map((p) => {
              const t = totals.get(p) ?? { buyins: 0, count: 0 };
              return (
                <li key={p} className="list-row">
                  <span className="row-main">
                    <span className="row-title">{name(p)}{p === game.hostId ? ' (host)' : ''}</span>
                    <span className="row-sub">{t.count} buy-in{t.count === 1 ? '' : 's'}</span>
                  </span>
                  <span className="num">{usd(t.buyins)}</span>
                  <button className="pill primary small" aria-label={`${name(p)} buys in for ${usdShort(game.buyIn)}`} onClick={() => update({ kind: 'buyIn', player: p, amount: game.buyIn, ids: [newId(), newId()], at: Date.now() })}>
                    +{usdShort(game.buyIn)}
                  </button>
                </li>
              );
            })}
          </ul>
          {recent.length > 0 && (
            <ul className="recent">
              {recent.map((e) =>
                e.kind === 'buyin' ? (
                  <li key={e.id}>
                    <span>{name(e.player)} bought in {usdShort(e.amount)}</span>
                    <button className="link" onClick={() => update({ kind: 'undo', event: e.id })}>Undo</button>
                  </li>
                ) : null,
              )}
            </ul>
          )}
          {pot > 0 && <button className="pill primary wide" onClick={() => setStep('cashout')}>Game over: count the chips</button>}
        </section>
      )}

      {step === 'cashout' && !game.closed && (
        <section className="stack" aria-label="Cash out">
          <p className="fine">Count each stack and enter what it's worth.</p>
          <ul className="list">
            {game.players.map((p) => {
              const bad = (text[p] ?? '').trim() !== '' && parseDollars(text[p] ?? '') === null;
              return (
                <li key={p} className="list-row">
                  <label className="row-main" htmlFor={`co-${p}`}>
                    <span className="row-title">{name(p)}</span>
                    <span className="row-sub">bought in {usd(totals.get(p)?.buyins ?? 0)}</span>
                  </label>
                  <input id={`co-${p}`} className="num money" inputMode="decimal" placeholder="0.00" value={text[p] ?? ''} aria-invalid={bad}
                    onChange={(e) => { setText({ ...text, [p]: e.target.value }); update({ kind: 'cashout', player: p, amount: parseDollars(e.target.value) }); }} />
                </li>
              );
            })}
          </ul>
          <p className="fine" aria-live="polite">Counted {usd(cashedOut)} of {usd(pot)}.</p>
          {result.status === 'recount' && (
            <Notice tone="warn">The chips come to {usd(Math.abs(result.discrepancy))} {result.discrepancy > 0 ? 'more' : 'less'} than the pot, more than the {usd(result.limit)} allowed. Recount.</Notice>
          )}
          {result.status === 'ready' && result.discrepancy !== 0 && <Notice>Off by {usd(Math.abs(result.discrepancy))}, within 1%. It's shared by how much each person bought in.</Notice>}
          <button className="pill primary wide" disabled={result.status !== 'ready'} onClick={() => setStep('results')}>See results</button>
        </section>
      )}

      {step === 'results' && (
        <section className="stack" aria-label="Results">
          {result.status !== 'ready' ? (
            <Notice>Enter every cash-out first.</Notice>
          ) : (
            <>
              <ul className="list">
                {[...result.lines].sort((a, b) => b.net - a.net).map((l) => (
                  <li key={l.player} className="list-row">
                    <span className="row-main">
                      <span className="row-title">{name(l.player)}</span>
                      <span className="row-sub">in {usd(l.buyins)}, out {usd(l.cashouts)}{l.cashGiven ? `, paid host ${usd(l.cashGiven)}` : ''}{l.cashReceived ? `, holds ${usd(l.cashReceived)} cash` : ''}</span>
                    </span>
                    <Signed cents={l.net} />
                  </li>
                ))}
              </ul>
              {game.closed ? (
                <p className="fine">These results are in the group's balances. <a href={`#/g/${group.id}/settle`}>Settle up</a></p>
              ) : (
                <button className="pill primary wide" onClick={() => { update({ kind: 'close' }); go(`/g/${group.id}`); }}>
                  Add results to group balances
                </button>
              )}
            </>
          )}
        </section>
      )}
    </main>
  );
}
