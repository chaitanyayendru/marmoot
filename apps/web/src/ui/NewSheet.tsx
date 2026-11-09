import { useMemo, useRef, useState, type Dispatch } from 'react';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { go } from '../App.tsx';
import { api } from '../apiClient.ts';
import { ApiError } from '../api.ts';
import { parseDollars, usd } from '../money.ts';
import { CATEGORIES, today, type Action, type Category, type Group } from '../model.ts';
import { e164 } from '../sheet.ts';
import { CategoryIcon, Notice } from './bits.tsx';

interface Row {
  key: number;
  name: string;
  price: string;
}

/** Values carried over from the Add expense sheet, read once when this page opens. */
let prefill: { title: string; amount: number | null; category: Category; among: string[] } | null = null;
export function prefillSheet(p: NonNullable<typeof prefill>) {
  prefill = p;
}

export function NewSheet({ group, dispatch }: { group: Group; dispatch: Dispatch<Action> }) {
  const start = useRef(prefill);
  prefill = null;
  const s = start.current;
  const nextKey = useRef(2);
  const meMember = group.members.find((m) => m.id === group.me)!;
  const [ownerName, setOwnerName] = useState(meMember.name === 'You' ? '' : meMember.name);
  const [title, setTitle] = useState(s?.title ?? '');
  const [category, setCategory] = useState<Category>(s?.category ?? 'groceries');
  const [rows, setRows] = useState<Row[]>(
    s?.amount ? [{ key: 0, name: s.title || 'Everything', price: (s.amount / 100).toFixed(2) }, { key: 1, name: '', price: '' }] : [{ key: 0, name: '', price: '' }, { key: 1, name: '', price: '' }],
  );
  const [tax, setTax] = useState('');
  const [tip, setTip] = useState('');
  const [note, setNote] = useState('');
  const [defaultIn, setDefaultIn] = useState(true);
  const [among, setAmong] = useState<string[]>(s?.among.length ? s.among : group.members.map((m) => m.id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const items = useMemo(
    () => rows.filter((r) => r.name.trim() || r.price.trim()).map((r) => ({ ...r, cents: parseDollars(r.price) })),
    [rows],
  );
  const badRow = items.find((r) => !r.name.trim() || r.cents === null);
  const taxC = tax.trim() ? parseDollars(tax) : 0;
  const tipC = tip.trim() ? parseDollars(tip) : 0;
  const total = items.reduce((t, r) => t + (r.cents ?? 0), 0) + (taxC ?? 0) + (tipC ?? 0);
  const people = group.members.filter((m) => among.includes(m.id) || m.id === group.me);
  const ok = !!ownerName.trim() && !!title.trim() && items.length > 0 && !badRow && taxC !== null && tipC !== null && people.length >= 2 && !saving;

  const setRow = (key: number, patch: Partial<Row>) => {
    setRows((rs) => {
      const next = rs.map((r) => (r.key === key ? { ...r, ...patch } : r));
      // Keep one empty row at the bottom to type the next item into.
      if (next.at(-1)?.name || next.at(-1)?.price) next.push({ key: nextKey.current++, name: '', price: '' });
      return next;
    });
  };

  async function create() {
    if (!api || !ok) return;
    setSaving(true);
    setError(null);
    try {
      const ordered = [group.members.find((m) => m.id === group.me)!, ...people.filter((m) => m.id !== group.me)];
      const created = await api.createSheet({
        title: title.trim(),
        people: ordered.map((m) => ({ name: m.id === group.me ? ownerName.trim() : m.name, phone: e164(m.phone), owner: m.id === group.me })),
        items: items.map((r) => ({ name: r.name.trim(), price: r.cents! })),
        tax: taxC ?? 0,
        tip: tipC ?? 0,
        note: note.trim() || undefined,
        defaultIn,
      });
      dispatch({
        type: 'addSheet',
        group: group.id,
        sheet: {
          id: created.sheet_id,
          ownerToken: created.owner_token,
          title: title.trim(),
          category,
          date: today(),
          createdAt: Date.now(),
          people: created.people.map((p, i) => ({ personId: p.id, memberId: ordered[i]!.id })),
        },
      });
      go(`/g/${group.id}/sheet/${created.sheet_id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not create the bill. Try again.');
      setSaving(false);
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <a className="back" href={`#/g/${group.id}`}><ChevronLeft size={22} /> {group.name}</a>
      </header>
      <h1>Split a bill by item</h1>
      <p className="muted">List what you bought. Everyone gets their own link and picks what they were part of, like tomatoes but not onions.</p>

      {!api && (
        <Notice tone="warn">
          Bill sheets need Marmoot's server, which isn't connected in this copy of the app yet. See docs/SHARING-SETUP.md.
        </Notice>
      )}

      <form className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <label className="field">
          <span>What for</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Costco, Trader Joe's, Dinner at Saffron" />
        </label>

        <fieldset className="chips-pick" aria-label="Category">
          {CATEGORIES.filter((c) => c.id !== 'game').map((c) => (
            <label key={c.id} className={category === c.id ? 'on' : undefined}>
              <input type="radio" name="category" checked={category === c.id} onChange={() => setCategory(c.id)} />
              <CategoryIcon category={c.id} size={16} /> {c.label}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>Items</legend>
          <ol className="item-rows">
            {rows.map((r, i) => {
              const cents = r.price.trim() ? parseDollars(r.price) : null;
              const last = i === rows.length - 1;
              return (
                <li key={r.key}>
                  <input aria-label={`Item ${i + 1}`} placeholder={i === 0 ? 'Tomatoes' : i === 1 ? 'Onions' : 'Item'} value={r.name} onChange={(e) => setRow(r.key, { name: e.target.value })} />
                  <input
                    className="num money"
                    inputMode="decimal"
                    aria-label={`Price of item ${i + 1}`}
                    placeholder="0.00"
                    value={r.price}
                    aria-invalid={r.price.trim() !== '' && cents === null}
                    onChange={(e) => setRow(r.key, { price: e.target.value })}
                  />
                  {!last ? (
                    <button type="button" className="icon-btn" aria-label={`Remove ${r.name || 'item'}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                      <Trash2 size={18} />
                    </button>
                  ) : (
                    <span className="icon-btn" aria-hidden="true"><Plus size={18} /></span>
                  )}
                </li>
              );
            })}
          </ol>
          {badRow && <p className="warn-text">Each item needs a name and a price.</p>}
        </fieldset>

        <div className="two">
          <label className="field">
            <span>Tax</span>
            <input className="num" inputMode="decimal" placeholder="0.00" value={tax} onChange={(e) => setTax(e.target.value)} aria-invalid={taxC === null} />
          </label>
          <label className="field">
            <span>Tip or service</span>
            <input className="num" inputMode="decimal" placeholder="0.00" value={tip} onChange={(e) => setTip(e.target.value)} aria-invalid={tipC === null} />
          </label>
        </div>
        <p className="fine">Tax and tip are split in proportion to what each person keeps.</p>

        <fieldset>
          <legend>Who's on it</legend>
          <div className="checks">
            {group.members.map((m) => (
              <label key={m.id} className="check">
                <input
                  type="checkbox"
                  checked={m.id === group.me || among.includes(m.id)}
                  disabled={m.id === group.me}
                  onChange={(e) => setAmong(e.target.checked ? [...among, m.id] : among.filter((x) => x !== m.id))}
                />
                <span className="row-main">
                  <span>{m.id === group.me ? `${m.name === 'You' ? 'You' : m.name} (paid)` : m.name}</span>
                  {m.id !== group.me && <span className="row-sub">{e164(m.phone) ? 'Gets a WhatsApp message' : 'No WhatsApp number yet: you can share their link instead'}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Everyone starts</legend>
          <div className="segmented" role="radiogroup" aria-label="Everyone starts">
            <label className={defaultIn ? 'on' : undefined}>
              <input type="radio" name="start" checked={defaultIn} onChange={() => setDefaultIn(true)} /> In for everything
            </label>
            <label className={!defaultIn ? 'on' : undefined}>
              <input type="radio" name="start" checked={!defaultIn} onChange={() => setDefaultIn(false)} /> Out of everything
            </label>
          </div>
          <p className="fine">
            {defaultIn ? 'People untick what they weren\'t part of. Anyone who never answers pays for everything.' : 'People tick what they had. Anything nobody ticks stays with you.'}
          </p>
        </fieldset>

        <label className="field">
          <span>Your name, as they'll see it</span>
          <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Chai" />
        </label>

        <label className="field">
          <span>Message (optional)</span>
          <input value={note} maxLength={280} onChange={(e) => setNote(e.target.value)} placeholder="Please pick yours by Sunday" />
        </label>

        {error && <Notice tone="warn">{error}</Notice>}
        <button className="pill primary wide" disabled={!ok || !api}>
          {saving ? 'Creating…' : `Create bill sheet${total ? `, ${usd(total)}` : ''}`}
        </button>
      </form>
    </main>
  );
}
