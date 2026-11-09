import { useMemo, useState } from 'react';
import { splitAmount, SplitError, type Split } from '@marmoot/core';
import { parseDollars, usd } from '../money.ts';
import { advance, CATEGORIES, newId, today, type Category, type ExpenseItem, type Group, type Recurring } from '../model.ts';
import { CategoryIcon, Sheet } from './bits.tsx';

type Method = Split['method'];
const METHODS: { id: Method; label: string }[] = [
  { id: 'equal', label: 'Equally' },
  { id: 'exact', label: 'Amounts' },
  { id: 'percent', label: 'Percent' },
  { id: 'shares', label: 'Shares' },
];

/** "33.33" -> 3333 basis points; null if it isn't a percentage with up to two decimals. */
function parsePercent(s: string): number | null {
  const t = s.trim().replace(/%$/, '');
  if (t === '') return 0;
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}

interface Props {
  group: Group;
  onClose: () => void;
  onSave: (item: ExpenseItem, repeat: Recurring | null) => void;
}

export function ExpenseSheet({ group, onClose, onSave }: Props) {
  const ids = group.members.map((m) => m.id);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<Category>('groceries');
  const [paidBy, setPaidBy] = useState(group.me);
  const [method, setMethod] = useState<Method>('equal');
  const [among, setAmong] = useState<string[]>(ids);
  const [values, setValues] = useState<Record<string, string>>({});
  const [date, setDate] = useState(today());
  const [every, setEvery] = useState<'none' | 'week' | 'month'>('none');
  const [varies, setVaries] = useState(true);

  const total = parseDollars(amount);
  const split: Split | null = useMemo(() => {
    switch (method) {
      case 'equal':
        return { method, among };
      case 'exact': {
        const amounts: Record<string, number> = {};
        for (const id of ids) {
          const v = values[id]?.trim() ? parseDollars(values[id]!) : 0;
          if (v === null) return null;
          amounts[id] = v;
        }
        return { method, amounts };
      }
      case 'percent': {
        const basisPoints: Record<string, number> = {};
        for (const id of ids) {
          const v = parsePercent(values[id] ?? '');
          if (v === null) return null;
          basisPoints[id] = v;
        }
        return { method, basisPoints };
      }
      case 'shares': {
        const shares: Record<string, number> = {};
        for (const id of ids) {
          const raw = (values[id] ?? '1').trim();
          if (!/^\d*$/.test(raw)) return null;
          shares[id] = raw === '' ? 0 : Number(raw);
        }
        return { method, shares };
      }
    }
  }, [method, among, values, ids.join()]);

  const result = useMemo((): { shares: Map<string, number> } | { error: string } => {
    if (!total) return { error: 'Enter the amount.' };
    if (!split) return { error: method === 'percent' ? 'Use percentages like 25 or 33.33.' : 'Check the numbers above.' };
    try {
      return { shares: splitAmount(total, split) };
    } catch (e) {
      return { error: e instanceof SplitError ? e.message : 'Check the numbers above.' };
    }
  }, [total, split, method]);

  const ok = 'shares' in result;

  function save() {
    if (!ok || !total || !split) return;
    const item: ExpenseItem = { kind: 'expense', id: newId(), at: Date.now(), date, description: description.trim(), category, amount: total, paidBy, split };
    let repeat: Recurring | null = null;
    if (every !== 'none') {
      const rid = newId();
      item.recurringId = rid;
      repeat = { id: rid, description: description.trim() || CATEGORIES.find((c) => c.id === category)!.label, category, amount: varies ? null : total, paidBy, split, every, next: advance(date, every), day: Number(date.slice(8, 10)) };
    }
    onSave(item, repeat);
  }

  const switchMethod = (m: Method) => {
    setMethod(m);
    setValues({});
  };

  return (
    <Sheet title="Add expense" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="amount-field">
          <span className="sr-only">Amount</span>
          <span className="num currency" aria-hidden="true">$</span>
          <input className="num" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus aria-invalid={amount.trim() !== '' && !total} />
        </label>

        <label className="field">
          <span>What for</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Costco run, October electricity" />
        </label>

        <fieldset className="chips-pick" aria-label="Category">
          {CATEGORIES.map((c) => (
            <label key={c.id} className={category === c.id ? 'on' : undefined}>
              <input type="radio" name="category" checked={category === c.id} onChange={() => { setCategory(c.id); if (c.id === 'utilities') setVaries(true); }} />
              <CategoryIcon category={c.id} size={16} /> {c.label}
            </label>
          ))}
        </fieldset>

        <div className="two">
          <label className="field">
            <span>Paid by</span>
            <select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
              {group.members.map((m) => (
                <option key={m.id} value={m.id}>{m.id === group.me && m.name !== 'You' ? `${m.name} (you)` : m.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        </div>

        <fieldset className="split">
          <legend>Split</legend>
          <div className="segmented tight" role="radiogroup" aria-label="How to split">
            {METHODS.map((m) => (
              <label key={m.id} className={method === m.id ? 'on' : undefined}>
                <input type="radio" name="method" checked={method === m.id} onChange={() => switchMethod(m.id)} />
                {m.label}
              </label>
            ))}
          </div>
          <ul className="split-rows">
            {group.members.map((m) => {
              const share = ok ? result.shares.get(m.id) ?? 0 : null;
              return (
                <li key={m.id}>
                  {method === 'equal' ? (
                    <label className="check">
                      <input type="checkbox" checked={among.includes(m.id)} onChange={(e) => setAmong(e.target.checked ? [...among, m.id] : among.filter((x) => x !== m.id))} />
                      <span>{m.id === group.me && m.name !== 'You' ? `${m.name} (you)` : m.name}</span>
                    </label>
                  ) : (
                    <label className="split-input">
                      <span>{m.id === group.me && m.name !== 'You' ? `${m.name} (you)` : m.name}</span>
                      <input
                        inputMode={method === 'shares' ? 'numeric' : 'decimal'}
                        placeholder={method === 'exact' ? '0.00' : method === 'percent' ? '0%' : '1'}
                        value={values[m.id] ?? ''}
                        onChange={(e) => setValues({ ...values, [m.id]: e.target.value })}
                      />
                    </label>
                  )}
                  <span className="num share">{share === null ? '' : usd(share)}</span>
                </li>
              );
            })}
          </ul>
          <p className={`fine ${ok ? '' : 'warn-text'}`} aria-live="polite">{ok ? 'Shares add up to the total.' : result.error}</p>
        </fieldset>

        <label className="field">
          <span>Repeats</span>
          <select value={every} onChange={(e) => setEvery(e.target.value as typeof every)}>
            <option value="none">Doesn't repeat</option>
            <option value="month">Every month</option>
            <option value="week">Every week</option>
          </select>
        </label>
        {every !== 'none' && (
          <label className="check">
            <input type="checkbox" checked={varies} onChange={(e) => setVaries(e.target.checked)} />
            <span>The amount changes each time (I'll be asked for it)</span>
          </label>
        )}

        <button className="pill primary wide" disabled={!ok}>Add expense{total ? `, ${usd(total)}` : ''}</button>
      </form>
    </Sheet>
  );
}
