import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import type { Api } from '../api.ts';
import { usd } from '../money.ts';
import { responseStatus, sheetTotals } from '../sheet.ts';
import { Notice } from './bits.tsx';
import { useSheet, withChoice } from './useSheet.ts';

const first = (name: string) => name.split(/\s+/)[0] ?? name;

/**
 * What someone sees when they open their link: the bill, a switch per item, and
 * their running total. No account, no install. Their changes show on the owner's
 * sheet within a few seconds.
 */
export function GuestSheet({ api, token }: { api: Api; token: string }) {
  const { data, error, change } = useSheet(api, token, 5000);
  const [viewed, setViewed] = useState(false);

  useEffect(() => {
    if (!viewed) {
      setViewed(true);
      void api.markViewed(token).catch(() => {});
    }
  }, [api, token, viewed]);

  const totals = useMemo(() => (data ? sheetTotals(data) : null), [data]);
  if (!data || !totals) {
    return (
      <main className="page">
        <header className="topbar"><span className="brand">Marmoot</span></header>
        {error ? <Notice tone="warn">{error}</Notice> : <p className="muted">Opening the bill…</p>}
      </main>
    );
  }

  const me = data.people.find((p) => p.id === data.me.id)!;
  const owner = data.people.find((p) => p.is_owner)!;
  const open = data.sheet.status === 'open';
  const mine = totals.totals.get(me.id) ?? { items: 0, extras: 0, total: 0 };
  const inFor = (item: string) => !me.out_of_bill && !!totals.cells.get(item)?.has(me.id) && !totals.unclaimed.includes(item);
  const whoIn = (item: string) =>
    data.people.filter((p) => totals.cells.get(item)?.has(p.id) && !totals.unclaimed.includes(item)).map((p) => (p.id === me.id ? 'you' : first(p.name)));
  const isOwner = data.me.is_owner;

  return (
    <main className="page">
      <header className="topbar"><span className="brand">Marmoot</span></header>

      <section className="hero">
        <h1 className="hero-title">{isOwner ? 'Your bill' : `${first(owner.name)}'s bill`}: {data.sheet.title}</h1>
        <p className="hero-amount num">{usd(mine.total)}</p>
        <p className="hero-sub muted">
          {me.out_of_bill ? 'You said you weren’t part of this bill' : `Your share of ${usd(totals.total)}`}
          {open ? '' : ', final'}
        </p>
      </section>

      {data.sheet.note && (
        <blockquote className="note">
          <p>{data.sheet.note}</p>
          <footer className="fine">{first(owner.name)}</footer>
        </blockquote>
      )}

      {error && <Notice tone="warn">{error}</Notice>}

      {open ? (
        <p className="muted">
          {data.sheet.default_in
            ? 'Untick anything you weren’t part of. Tax and tip follow what you keep.'
            : 'Tick what you were part of. Tax and tip follow what you keep.'}
        </p>
      ) : (
        <Notice>{first(owner.name)} closed this bill. These amounts are final and are in your group’s balances.</Notice>
      )}

      <ul className="list choose">
        {data.items.map((it) => {
          const on = inFor(it.id);
          const share = totals.cells.get(it.id)?.get(me.id);
          const people = whoIn(it.id);
          return (
            <li key={it.id}>
              <label className={`list-row choice ${on ? 'on' : ''}`}>
                <input
                  type="checkbox"
                  className="switch"
                  checked={on}
                  disabled={!open}
                  onChange={() => void change((d) => withChoice(d, it.id, me.id, !on), () => api.setChoice(token, it.id, !on))}
                />
                <span className="row-main">
                  <span className="row-title">{it.name}</span>
                  <span className="row-sub">{people.length ? `${people.join(', ')} ${people.length === 1 && people[0] !== 'you' ? 'is' : 'are'} in` : `Nobody yet: ${first(owner.name)} covers it`}</span>
                </span>
                <span className="row-end">
                  <span className="num">{usd(Number(it.price_cents))}</span>
                  {on && share !== undefined && <span className="row-sub up">you {usd(share)}</span>}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <dl className="breakdown">
        <div><dt>Your items</dt><dd className="num">{usd(mine.items)}</dd></div>
        <div><dt>Your share of tax and tip</dt><dd className="num">{usd(mine.extras)}</dd></div>
        <div className="total"><dt>You pay {first(owner.name)}</dt><dd className="num">{usd(mine.total)}</dd></div>
      </dl>

      {open && !isOwner && (
        <div className="stack tight">
          {me.responded_at && !me.out_of_bill ? (
            <Notice>
              <Check size={16} /> Thanks. {first(owner.name)} can see your choices. You can still change them until the bill closes.
            </Notice>
          ) : (
            !me.out_of_bill && (
              <button className="pill primary wide" onClick={() => void change(null, () => api.markDone(token))}>
                Done, that’s my part
              </button>
            )
          )}
          <button className="link" onClick={() => void change(null, () => api.setOutOfBill(token, !me.out_of_bill))}>
            {me.out_of_bill ? 'Actually, I was part of this bill' : 'I wasn’t part of this bill'}
          </button>
        </div>
      )}

      <section aria-label="Everyone">
        <h2 className="month">Everyone</h2>
        <ul className="list">
          {data.people.map((p) => {
            const st = responseStatus(p);
            return (
              <li key={p.id} className="list-row">
                <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="row-main">
                  <span className="row-title">{p.id === me.id ? `${p.name} (you)` : p.name}</span>
                  <span className={`status ${st.tone}`}>{st.label}</span>
                </span>
                <span className="row-end num">{usd(totals.totals.get(p.id)?.total ?? 0)}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <p className="fine">Shared with Marmoot. Only people with a link to this bill can see it.</p>
    </main>
  );
}
