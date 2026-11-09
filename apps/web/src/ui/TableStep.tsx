import { useState, type FormEvent } from 'react';
import { go } from '../App.tsx';
import { usd, usdShort } from '../money.ts';
import { newId, type Player } from '../model.ts';
import { Chips, Notice } from './bits.tsx';
import type { StepProps } from './NightView.tsx';
import { PlayerDialog } from './PlayerDialog.tsx';

export function TableStep({ night, derived, dispatch }: StepProps) {
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<Player | null>(null);
  const host = night.players.find((p) => p.id === night.hostId);
  const name = (id: string) => night.players.find((p) => p.id === id)?.name ?? 'Someone';

  function add(e: FormEvent) {
    e.preventDefault();
    const n = newName.trim();
    if (!n) return;
    dispatch({ type: 'addPlayer', night: night.id, id: newId(), name: n });
    setNewName('');
  }

  const buyIns = night.events.filter((e) => e.kind === 'buyin').slice(-5).reverse();

  return (
    <section aria-label="Buy-ins">
      <p className="mode">
        {night.mode === 'cash-to-host'
          ? host
            ? <>Buy-ins are paid in cash to <strong>{host.name}</strong>, the host.</>
            : <>Buy-ins are paid in cash to the host. Add players, then pick the host.</>
          : <>Nobody pays for chips now. Everything settles at the end.</>}{' '}
        <button
          className="link"
          onClick={() => dispatch({ type: 'setMode', night: night.id, mode: night.mode === 'cash-to-host' ? 'settle-later' : 'cash-to-host' })}
        >
          {night.mode === 'cash-to-host' ? 'Settle everything at the end instead' : 'Pay the host in cash instead'}
        </button>
      </p>

      {night.players.length === 0 && <Notice>Add everyone at the table. You can add payment apps for each person later.</Notice>}

      <ul className="roster">
        {night.players.map((p) => {
          const t = derived.totals.get(p.id) ?? { buyins: 0, count: 0 };
          return (
            <li key={p.id} className="row">
              <button className="who" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
                <span className="who-name">{p.name}</span>
                <span className="who-meta">
                  {p.id === night.hostId && <span className="tag">Host</span>}
                  <Chips count={t.count} />
                </span>
              </button>
              <span className="num amt">{usd(t.buyins)}</span>
              <button
                className="buy"
                onClick={() => dispatch({ type: 'buyIn', night: night.id, player: p.id, amount: night.buyIn, ids: [newId(), newId()], at: Date.now() })}
                aria-label={`${p.name} buys in for ${usdShort(night.buyIn)}`}
              >
                +{usdShort(night.buyIn)}
              </button>
            </li>
          );
        })}
      </ul>

      <form className="add" onSubmit={add}>
        <label className="sr-only" htmlFor="new-player">Player name</label>
        <input id="new-player" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Player name" autoComplete="off" />
        <button disabled={!newName.trim()}>Add player</button>
      </form>

      {buyIns.length > 0 && (
        <section className="recent" aria-label="Latest buy-ins">
          <h2>Latest buy-ins</h2>
          <ul>
            {buyIns.map((e) =>
              e.kind === 'buyin' ? (
                <li key={e.id}>
                  <span>
                    {name(e.player)} bought in {usdShort(e.amount)}
                    {night.events.some((c) => c.kind === 'cash' && c.forBuyIn === e.id) && host ? `, paid ${host.name} in cash` : ''}
                  </span>
                  <button className="link" onClick={() => dispatch({ type: 'undo', night: night.id, event: e.id })}>
                    Undo
                  </button>
                </li>
              ) : null,
            )}
          </ul>
        </section>
      )}

      {night.players.length > 1 && derived.pot > 0 && (
        <button className="primary next" onClick={() => go(`/n/${night.id}/cashout`)}>
          Game over: count the chips
        </button>
      )}

      {editing && (
        <PlayerDialog
          player={editing}
          isHost={editing.id === night.hostId}
          hasBoughtIn={night.events.some((e) => (e.kind === 'buyin' ? e.player === editing.id : e.from === editing.id || e.to === editing.id))}
          onSave={(p, makeHost) => {
            dispatch({ type: 'updatePlayer', night: night.id, player: p });
            if (makeHost) dispatch({ type: 'setHost', night: night.id, player: p.id });
            setEditing(null);
          }}
          onRemove={() => {
            dispatch({ type: 'removePlayer', night: night.id, player: editing.id });
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
