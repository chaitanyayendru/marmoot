import { useMemo, useState, type Dispatch } from 'react';
import { ArrowLeftRight, ChevronLeft, ListChecks, Repeat, Spade, Trash2, Users, X } from 'lucide-react';
import { go } from '../App.tsx';
import { parseDollars, usd } from '../money.ts';
import {
  balanceHistory,
  byDate,
  categoryLabel,
  groupNets,
  itemNets,
  newGame,
  newId,
  shortDate,
  today,
  type Action,
  type ExpenseItem,
  type Group,
  type Item,
  type PaymentItem,
} from '../model.ts';
import { api } from '../apiClient.ts';
import { BalanceChart } from './Chart.tsx';
import { CategoryIcon, NotSaving, Sheet, Signed } from './bits.tsx';
import { ExpenseSheet } from './ExpenseSheet.tsx';
import { prefillSheet } from './NewSheet.tsx';
import { InviteButton, JoinRequests } from './Sharing.tsx';

const monthOf = (date: string) => {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

export function GroupView({ group, dispatch, saved }: { group: Group; dispatch: Dispatch<Action>; saved: boolean }) {
  const [adding, setAdding] = useState(false);
  const [startingGame, setStartingGame] = useState(false);
  const [added, setAdded] = useState<ExpenseItem | null>(null);
  const [dueAmounts, setDueAmounts] = useState<Record<string, string>>({});
  const [openItem, setOpenItem] = useState<ExpenseItem | PaymentItem | null>(null);
  const nets = useMemo(() => groupNets(group), [group]);
  const mine = nets.get(group.me) ?? 0;
  const history = useMemo(() => balanceHistory(group), [group]);
  const name = (id: string) => (id === group.me ? 'You' : group.members.find((m) => m.id === id)?.name ?? 'Someone');

  const months = useMemo(() => {
    const sorted = [...group.items].sort(byDate).reverse();
    const out: { month: string; items: Item[] }[] = [];
    for (const i of sorted) {
      const month = monthOf(i.date);
      const last = out.at(-1);
      if (last?.month === month) last.items.push(i);
      else out.push({ month, items: [i] });
    }
    return out;
  }, [group.items]);

  const openGames = group.items.filter((i) => i.kind === 'game' && !i.closed);

  return (
    <main className="page with-bar">
      <header className="topbar">
        <a className="back" href="#/"><ChevronLeft size={22} /> Groups</a>
        <span className="topbar-actions">
          <InviteButton group={group} />
          <a className="icon-btn" href={`#/g/${group.id}/people`} aria-label="People in this group">
            <Users size={22} strokeWidth={1.75} />
          </a>
        </span>
      </header>
      {!saved && <NotSaving />}
      {group.shared && <JoinRequests group={group} />}
      {group.shared && !group.me && (
        <p className="notice warn">You’re in this group, but not linked to anyone in its list yet. Ask someone in it to add you.</p>
      )}

      <section className="hero" aria-label={`Your balance in ${group.name}`}>
        <h1 className="hero-title">{group.name}</h1>
        <p className="hero-amount num">{usd(Math.abs(mine))}</p>
        <p className={`hero-sub ${mine > 0 ? 'up' : mine < 0 ? 'down' : 'flat'}`}>
          {mine > 0 ? 'You’re owed' : mine < 0 ? 'You owe' : group.items.length ? 'You’re settled up' : 'No expenses yet'}
        </p>
        <BalanceChart points={history} label={`Your balance in ${group.name}`} />
      </section>

      {group.due.map((d) => {
        const r = group.recurring.find((x) => x.id === d.recurringId);
        if (!r) return null;
        const key = `${d.recurringId}:${d.date}`;
        const cents = parseDollars(dueAmounts[key] ?? '');
        return (
          <section key={key} className="due" aria-label={`${r.description} is due`}>
            <p>
              <strong>{r.description}</strong> is due ({shortDate(d.date)}). It changes each time, so enter this one.
            </p>
            <div className="due-row">
              <input inputMode="decimal" placeholder="Amount" aria-label={`${r.description} amount`} value={dueAmounts[key] ?? ''} onChange={(e) => setDueAmounts({ ...dueAmounts, [key]: e.target.value })} />
              <button className="pill primary" disabled={!cents} onClick={() => dispatch({ type: 'resolveDue', group: group.id, recurringId: d.recurringId, date: d.date, amount: cents, id: newId(), at: Date.now() })}>
                Add
              </button>
              <button className="pill" onClick={() => dispatch({ type: 'resolveDue', group: group.id, recurringId: d.recurringId, date: d.date, amount: null, id: '', at: 0 })}>
                Skip
              </button>
            </div>
          </section>
        );
      })}

      {openGames.map((g) => (
        <a key={g.id} className="due game-link" href={`#/g/${group.id}/game/${g.id}`}>
          <Spade size={18} /> Game night in progress. Tap to keep going.
        </a>
      ))}

      {(group.sheets ?? []).filter((sh) => !sh.expenseId).map((sh) => (
        <a key={sh.id} className="due game-link" href={`#/g/${group.id}/sheet/${sh.id}`}>
          <ListChecks size={18} /> {sh.title}: waiting on people to pick their items. Tap to see who's in.
        </a>
      ))}

      <div className="quick">
        <a className="pill" href={`#/g/${group.id}/sheet/new`}>
          <ListChecks size={16} /> Split by item
        </a>
        <button className="pill" onClick={() => setStartingGame(true)}>
          <Spade size={16} /> Game night
        </button>
        <a className="pill" href={`#/g/${group.id}/people`}>
          <Users size={16} /> People & settings
        </a>
      </div>

      {months.length === 0 ? (
        <p className="muted">Add the first expense: a grocery run, the electricity bill, this month's rent.</p>
      ) : (
        months.map(({ month, items }) => (
          <section key={month} aria-label={month}>
            <h2 className="month">{month}</h2>
            <ul className="list">
              {items.map((i) => {
                const effect = itemNets(i).get(group.me) ?? 0;
                if (i.kind === 'expense') {
                  return (
                    <li key={i.id}>
                     <button className="list-row as-button" onClick={() => setOpenItem(i)}>
                      <CategoryIcon category={i.category} />
                      <span className="row-main">
                        <span className="row-title">{i.description || categoryLabel(i.category)}</span>
                        <span className="row-sub">
                          {name(i.paidBy)} paid {usd(i.amount)}, {shortDate(i.date)}
                          {i.recurringId ? ', repeats' : ''}
                        </span>
                      </span>
                      <span className="row-end">
                        {effect === 0 ? <span className="row-sub">not involved</span> : <Signed cents={effect} />}
                        {effect !== 0 && <span className="row-sub">{effect > 0 ? 'you lent' : 'your share'}</span>}
                      </span>
                     </button>
                    </li>
                  );
                }
                if (i.kind === 'payment') {
                  return (
                    <li key={i.id}>
                     <button className="list-row as-button" onClick={() => setOpenItem(i)}>
                      <span className="cat" aria-hidden="true"><ArrowLeftRight size={18} strokeWidth={1.75} /></span>
                      <span className="row-main">
                        <span className="row-title">{name(i.from)} paid {i.to === group.me ? 'you' : name(i.to)}</span>
                        <span className="row-sub">{usd(i.amount)}, {shortDate(i.date)}</span>
                      </span>
                      <span className="row-end">{effect !== 0 && <Signed cents={effect} />}</span>
                     </button>
                    </li>
                  );
                }
                return (
                  <li key={i.id}>
                    <a className="list-row" href={`#/g/${group.id}/game/${i.id}`}>
                      <CategoryIcon category="game" />
                      <span className="row-main">
                        <span className="row-title">{i.name}</span>
                        <span className="row-sub">{i.players.length} players, {shortDate(i.date)}{i.closed ? '' : ', in progress'}</span>
                      </span>
                      <span className="row-end">{i.closed && (effect === 0 ? <span className="row-sub">broke even</span> : <Signed cents={effect} />)}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {group.recurring.length > 0 && (
        <section aria-label="Repeating bills">
          <h2 className="month">Repeating bills</h2>
          <ul className="list">
            {group.recurring.map((r) => (
              <li key={r.id} className="list-row">
                <span className="cat" aria-hidden="true"><Repeat size={18} strokeWidth={1.75} /></span>
                <span className="row-main">
                  <span className="row-title">{r.description}</span>
                  <span className="row-sub">
                    {r.amount === null ? 'Amount varies' : usd(r.amount)}, every {r.every}, next {shortDate(r.next)}
                  </span>
                </span>
                <button className="icon-btn" aria-label={`Stop repeating ${r.description}`} onClick={() => dispatch({ type: 'deleteRecurring', group: group.id, recurring: r.id })}>
                  <Trash2 size={18} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openItem && (
        <ItemDetails
          group={group}
          item={openItem}
          onClose={() => setOpenItem(null)}
          onDelete={() => {
            dispatch({ type: 'deleteItem', group: group.id, item: openItem.id });
            setOpenItem(null);
          }}
        />
      )}

      {added && (
        <div className="toast" role="status">
          <span>Added {added.description || categoryLabel(added.category)}, {usd(added.amount)}.</span>
          {api && added.paidBy === group.me && added.split.method === 'equal' ? (
            <button
              className="pill small"
              onClick={() => {
                // Turn it into a bill sheet so people can confirm or opt out, then send.
                prefillSheet({ title: added.description, amount: added.amount, category: added.category, among: added.split.method === 'equal' ? added.split.among : [] });
                dispatch({ type: 'deleteItem', group: group.id, item: added.id });
                setAdded(null);
                window.location.hash = `/g/${group.id}/sheet/new`;
              }}
            >
              Let people opt out
            </button>
          ) : (
            <button className="pill small" onClick={() => { dispatch({ type: 'deleteItem', group: group.id, item: added.id }); setAdded(null); }}>Undo</button>
          )}
          <button className="icon-btn" aria-label="Dismiss" onClick={() => setAdded(null)}>
            <X size={18} />
          </button>
        </div>
      )}

      <nav className="bar" aria-label="Actions">
        <button className="pill primary" onClick={() => setAdding(true)}>Add expense</button>
        <a className="pill" href={`#/g/${group.id}/settle`}>Settle up</a>
      </nav>

      {adding && (
        <ExpenseSheet
          group={group}
          onClose={() => setAdding(false)}
          onSave={(item, repeat) => {
            dispatch({ type: 'addItem', group: group.id, item });
            if (repeat) dispatch({ type: 'addRecurring', group: group.id, recurring: repeat });
            setAdding(false);
            setAdded(item);
          }}
        />
      )}

      {startingGame && (
        <StartGame
          group={group}
          onClose={() => setStartingGame(false)}
          onStart={(players, buyIn, mode) => {
            const game = newGame(players, buyIn, mode, today(), Date.now());
            dispatch({ type: 'addItem', group: group.id, item: game });
            go(`/g/${group.id}/game/${game.id}`);
          }}
        />
      )}
    </main>
  );
}

function StartGame({ group, onClose, onStart }: { group: Group; onClose: () => void; onStart: (players: string[], buyIn: number, mode: 'cash-to-host' | 'settle-later') => void }) {
  const [players, setPlayers] = useState<string[]>(group.members.map((m) => m.id));
  const [buyIn, setBuyIn] = useState('20');
  const [cash, setCash] = useState(false);
  const cents = parseDollars(buyIn);
  return (
    <Sheet title="Game night" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (cents && players.length > 1) onStart(players, cents, cash ? 'cash-to-host' : 'settle-later'); }}>
        <p className="fine">Track buy-ins and cash-outs. When it's over, each person's result goes into the group's balances.</p>
        <fieldset className="checks">
          <legend>Who's playing</legend>
          {group.members.map((m) => (
            <label key={m.id} className="check">
              <input type="checkbox" checked={players.includes(m.id)} onChange={(e) => setPlayers(e.target.checked ? [...players, m.id] : players.filter((p) => p !== m.id))} />
              <span>{m.id === group.me && m.name !== 'You' ? `${m.name} (you)` : m.name}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>Buy-in</span>
          <input inputMode="decimal" value={buyIn} onChange={(e) => setBuyIn(e.target.value)} aria-invalid={!cents} />
        </label>
        <label className="check">
          <input type="checkbox" checked={cash} onChange={(e) => setCash(e.target.checked)} />
          <span>Buy-ins are paid in cash to the host</span>
        </label>
        <button className="pill primary wide" disabled={!cents || players.length < 2}>Start</button>
      </form>
    </Sheet>
  );
}

/** An expense or payment: who paid, each person's share, and deleting it. */
function ItemDetails({ group, item, onClose, onDelete }: { group: Group; item: ExpenseItem | PaymentItem; onClose: () => void; onDelete: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const who = (id: string) => (id === group.me ? 'You' : group.members.find((m) => m.id === id)?.name ?? 'Someone');
  const nets = itemNets(item);
  const fromSheet = item.kind === 'expense' && (group.sheets ?? []).some((sh) => sh.expenseId === item.id);
  const title = item.kind === 'expense' ? item.description || categoryLabel(item.category) : `${who(item.from)} paid ${item.to === group.me ? 'you' : who(item.to)}`;
  return (
    <Sheet title={title} onClose={onClose}>
      <div className="stack">
        <p className="detail-amount num">{usd(item.amount)}</p>
        <p className="muted">
          {item.kind === 'expense' ? `${who(item.paidBy)} paid, ${shortDate(item.date)}` : `${shortDate(item.date)}${item.rail ? `, by ${item.rail === 'cash' ? 'cash' : item.rail}` : ''}`}
          {item.kind === 'expense' && item.recurringId ? '. Repeats.' : ''}
          {fromSheet ? '. From a split-by-item bill.' : ''}
        </p>
        {item.kind === 'expense' && (
          <ul className="list compact">
            {group.members
              .map((m) => ({ m, share: (item.paidBy === m.id ? item.amount : 0) - (nets.get(m.id) ?? 0) }))
              .filter(({ share }) => share !== 0)
              .map(({ m, share }) => (
                <li key={m.id} className="list-row">
                  <span className="row-main"><span className="row-title">{who(m.id)}</span></span>
                  <span className="row-end num">{usd(share)}</span>
                </li>
              ))}
          </ul>
        )}
        {confirm ? (
          <div className="confirm">
            <p>
              Delete this {item.kind === 'expense' ? 'expense' : 'payment'}? Balances change for everyone in {group.name}
              {item.kind === 'expense' && item.recurringId ? '. The repeating bill keeps going; stop it under Repeating bills.' : '.'}
            </p>
            <div className="two">
              <button className="pill" onClick={() => setConfirm(false)}>Keep it</button>
              <button className="pill danger" onClick={onDelete}><Trash2 size={16} /> Delete</button>
            </div>
          </div>
        ) : (
          <button className="pill danger wide" onClick={() => setConfirm(true)}>
            <Trash2 size={16} /> Delete {item.kind === 'expense' ? 'expense' : 'payment'}
          </button>
        )}
      </div>
    </Sheet>
  );
}
