import { useMemo, useState, type Dispatch } from 'react';
import { Monitor, Moon, Plus, Settings, Sun } from 'lucide-react';
import { go } from '../App.tsx';
import { usd } from '../money.ts';
import { balanceHistory, groupNets, type Action, type State, type Theme } from '../model.ts';
import { sampleGroup } from '../sample.ts';
import { BalanceChart } from './Chart.tsx';
import { NotSaving, Sheet, Signed } from './bits.tsx';

export function Home({ state, dispatch, saved }: { state: State; dispatch: Dispatch<Action>; saved: boolean }) {
  const [settings, setSettings] = useState(false);
  const rows = useMemo(
    () => state.groups.map((g) => ({ g, mine: groupNets(g).get(g.me) ?? 0, people: g.members.length })),
    [state.groups],
  );
  const total = rows.reduce((s, r) => s + r.mine, 0);
  const history = useMemo(() => {
    const all = state.groups.flatMap((g) => balanceHistory(g).map((p, i, arr) => ({ date: p.date, delta: p.value - (i ? arr[i - 1]!.value : 0) })));
    all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let v = 0;
    return all.map((p) => ({ date: p.date, value: (v += p.delta) }));
  }, [state.groups]);

  function trySample() {
    const g = sampleGroup();
    dispatch({ type: 'createGroup', group: g });
    go(`/g/${g.id}`);
  }

  return (
    <main className="page">
      <header className="topbar">
        <span className="brand">Marmoot</span>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings">
          <Settings size={22} strokeWidth={1.75} />
        </button>
      </header>

      {!saved && <NotSaving />}

      {state.groups.length > 0 ? (
        <section className="hero" aria-label="Your balance">
          <p className="hero-amount num">{usd(Math.abs(total))}</p>
          <p className={`hero-sub ${total > 0 ? 'up' : total < 0 ? 'down' : 'flat'}`}>
            {total > 0 ? 'You’re owed, across all groups' : total < 0 ? 'You owe, across all groups' : 'You’re all settled up'}
          </p>
          <BalanceChart points={history} label="Your balance over time" />
        </section>
      ) : (
        <section className="empty">
          <h1>Split the bills you share</h1>
          <p className="muted">Groceries, rent, utilities, trips and game nights. Marmoot keeps the running balance and works out the fewest payments to settle up.</p>
        </section>
      )}

      <section aria-label="Groups">
        <div className="section-head">
          <h2>Groups</h2>
          <button className="pill small" onClick={() => go('/new')}>
            <Plus size={16} /> New group
          </button>
        </div>
        {rows.length === 0 ? (
          <div className="empty-actions">
            <button className="pill primary wide" onClick={() => go('/new')}>Create a group</button>
            <button className="pill wide" onClick={trySample}>Look around a sample flat first</button>
          </div>
        ) : (
          <ul className="list">
            {rows.map(({ g, mine, people }) => (
              <li key={g.id}>
                <a className="list-row" href={`#/g/${g.id}`}>
                  <span className="row-main">
                    <span className="row-title">{g.name}</span>
                    <span className="row-sub">{people} people{g.due.length ? `, ${g.due.length} bill${g.due.length > 1 ? 's' : ''} to enter` : ''}</span>
                  </span>
                  <span className="row-end">
                    <Signed cents={mine} />
                    <span className="row-sub">{mine > 0 ? 'owed to you' : mine < 0 ? 'you owe' : 'settled'}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {settings && (
        <Sheet title="Settings" onClose={() => setSettings(false)}>
          <fieldset className="segmented" aria-label="Appearance">
            <legend>Appearance</legend>
            {([
              ['system', 'Match phone', Monitor],
              ['light', 'Light', Sun],
              ['dark', 'Dark', Moon],
            ] as [Theme, string, typeof Sun][]).map(([value, label, Icon]) => (
              <label key={value} className={state.theme === value ? 'on' : undefined}>
                <input type="radio" name="theme" checked={state.theme === value} onChange={() => dispatch({ type: 'setTheme', theme: value })} />
                <Icon size={16} /> {label}
              </label>
            ))}
          </fieldset>
          <p className="fine">Your groups are stored on this device until accounts arrive.</p>
        </Sheet>
      )}
    </main>
  );
}
