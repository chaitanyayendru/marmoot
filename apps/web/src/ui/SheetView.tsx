import { useMemo, useState, type Dispatch } from 'react';
import { Check, ChevronLeft, ClipboardCopy, Copy, Download, MessageCircle, Minus, Send, Trash2 } from 'lucide-react';
import { go } from '../App.tsx';
import { ApiError, type Api, type SheetData, type SheetPerson } from '../api.ts';
import { sheetLink } from '../apiClient.ts';
import { parseDollars, usd } from '../money.ts';
import { newId, type Action, type Group, type SheetRef } from '../model.ts';
import { eventText, groupShareText, messageStatus, responseStatus, sheetExpense, sheetTotals, splitwiseText } from '../sheet.ts';
import { waLink } from '../whatsapp.ts';
import { Notice, Sheet } from './bits.tsx';
import { useSheet, withChoice } from './useSheet.ts';

const first = (name: string) => name.split(/\s+/)[0] ?? name;
/** Sending through Marmoot's own WhatsApp number (Meta Cloud API) is optional; without it, the owner shares one message in the group. */
const metaSend = import.meta.env.VITE_WHATSAPP_SEND === '1';
const time = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function SheetView({ api, group, sheetRef, dispatch }: { api: Api; group: Group; sheetRef: SheetRef; dispatch: Dispatch<Action> }) {
  const token = sheetRef.ownerToken;
  const { data, error, change, reload, setError } = useSheet(api, token);
  const [sending, setSending] = useState(false);
  const [sendNote, setSendNote] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState<SheetData['items'][number] | null>(null);
  const [newName, setNewName] = useState('');
  const [newPrice, setNewPrice] = useState('');
  const [closing, setClosing] = useState(false);
  const [copiedText, setCopiedText] = useState<'group' | 'splitwise' | null>(null);
  const [showText, setShowText] = useState<string | null>(null);

  const totals = useMemo(() => (data ? sheetTotals(data) : null), [data]);
  if (!data || !totals) {
    return (
      <main className="page">
        <header className="topbar"><a className="back" href={`#/g/${group.id}`}><ChevronLeft size={22} /> {group.name}</a></header>
        {error ? <Notice tone="warn">{error}</Notice> : <p className="muted">Loading the bill…</p>}
      </main>
    );
  }

  const open = data.sheet.status === 'open';
  const others = data.people.filter((p) => !p.is_owner);
  const answered = others.filter((p) => p.responded_at || p.out_of_bill).length;
  const unsent = others.filter((p) => p.has_phone && (!p.alert_status || p.alert_status === 'not_sent' || p.alert_status === 'failed'));
  const cellIn = (item: string, p: SheetPerson) => totals.cells.get(item)?.has(p.id) && !totals.unclaimed.includes(item);

  async function send(people?: string[], resend = false) {
    setSending(true);
    setSendNote(null);
    try {
      const r = await api.sendAlerts(token, people, resend);
      const parts: string[] = [];
      if (r.sent.length) parts.push(`Sent to ${r.sent.join(', ')} on WhatsApp.`);
      for (const f of r.failed) parts.push(`${f.name}: ${f.error}`);
      if (!r.sent.length && !r.failed.length) parts.push('Everyone with a WhatsApp number already has the message.');
      setSendNote({ tone: r.failed.length ? 'warn' : 'info', text: parts.join(' ') });
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'whatsapp_not_configured' || e.status === 404)) setNotConfigured(true);
      else setSendNote({ tone: 'warn', text: e instanceof Error ? e.message : 'Sending failed.' });
    } finally {
      setSending(false);
      void reload();
    }
  }

  async function copy(p: SheetPerson) {
    if (!p.token) return;
    try {
      await navigator.clipboard.writeText(sheetLink(p.token));
      setCopied(p.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError(`Copy this link for ${p.name}: ${sheetLink(p.token)}`);
    }
  }

  /** Copy a message; if the browser won't allow it, show the text to copy by hand. */
  async function copyText(which: 'group' | 'splitwise', text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedText(which);
      setTimeout(() => setCopiedText(null), 2000);
    } catch {
      setShowText(text);
    }
  }

  async function addItem() {
    const cents = parseDollars(newPrice);
    if (!newName.trim() || cents === null) return;
    const ok = await change(null, () => api.addItem(token, newName.trim(), cents));
    if (ok) {
      setNewName('');
      setNewPrice('');
    }
  }

  async function closeIntoGroup() {
    if (!data || !totals) return;
    const expense = sheetExpense(sheetRef, data, totals, newId(), Date.now());
    if (!expense) return;
    const ok = await change(null, () => api.close(token));
    if (ok) {
      dispatch({ type: 'closeSheet', group: group.id, sheet: sheetRef.id, expense });
      go(`/g/${group.id}`);
    }
  }

  return (
    <main className="page wide-page">
      <header className="topbar">
        <a className="back" href={`#/g/${group.id}`}><ChevronLeft size={22} /> {group.name}</a>
        <button className="icon-btn" aria-label="Download as Excel" onClick={() => void import('./excel.ts').then((m) => m.downloadSheet(data, totals))}>
          <Download size={20} />
        </button>
      </header>

      <section className="hero">
        <h1 className="hero-title">{data.sheet.title}</h1>
        <p className="hero-amount num">{usd(totals.total)}</p>
        <p className="hero-sub muted">
          {open ? `${answered} of ${others.length} answered` : sheetRef.expenseId ? `Closed and added to ${group.name}` : 'Closed'}
        </p>
      </section>

      {error && <Notice tone="warn">{error}</Notice>}

      {open && (
        <section className="send" aria-label="Share">
          <a className="pill primary wide" href={waLink(groupShareText(data, totals, sheetLink))} target="_blank" rel="noreferrer">
            <MessageCircle size={16} /> Share in the WhatsApp group
          </a>
          <button className="pill wide" onClick={() => void copyText('group', groupShareText(data, totals, sheetLink))}>
            <ClipboardCopy size={16} /> {copiedText === 'group' ? 'Copied' : 'Copy the message'}
          </button>
          <p className="fine">One message with everyone's own link. Each link only changes that person's column, and you'll see here who has opened it and what they picked.</p>
          {metaSend && (notConfigured ? (
            <Notice tone="warn">
              Marmoot's WhatsApp number isn't set up on the server yet (docs/SHARING-SETUP.md, step 3). Share in the group instead.
            </Notice>
          ) : (
            <button className="pill wide" disabled={sending || unsent.length === 0} onClick={() => void send()}>
              <Send size={16} /> {sending ? 'Sending…' : unsent.length ? `Message ${unsent.map((p) => first(p.name)).join(', ')} from Marmoot's number` : 'Everyone has the message'}
            </button>
          ))}
          {sendNote && <Notice tone={sendNote.tone}>{sendNote.text}</Notice>}
        </section>
      )}

      <div className="grid-wrap" role="region" aria-label="Who's in for what" tabIndex={0}>
        <table className="grid">
          <thead>
            <tr>
              <th scope="col" className="item-col">Item</th>
              {data.people.map((p) => {
                const st = responseStatus(p);
                return (
                  <th key={p.id} scope="col" className="person-col">
                    <span className="person-name">{p.is_owner ? 'You' : first(p.name)}</span>
                    <span className={`status ${st.tone}`}>{st.label}</span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {data.items.map((it) => (
              <tr key={it.id} className={totals.unclaimed.includes(it.id) ? 'unclaimed' : undefined}>
                <th scope="row" className="item-col">
                  {open ? (
                    <button className="item-name" onClick={() => setEditing(it)}>{it.name}</button>
                  ) : (
                    it.name
                  )}
                  <span className="price num">{usd(Number(it.price_cents))}</span>
                  {totals.unclaimed.includes(it.id) && <span className="row-sub">Nobody's in: on you</span>}
                </th>
                {data.people.map((p) => {
                  const on = cellIn(it.id, p);
                  return (
                    <td key={p.id}>
                      <button
                        className={`cell ${on ? 'on' : 'off'}`}
                        aria-pressed={!!on}
                        aria-label={`${p.name}: ${on ? 'in for' : 'out of'} ${it.name}`}
                        disabled={!open}
                        onClick={() => void change((d) => withChoice(d, it.id, p.id, !on), () => api.setChoice(token, it.id, !on, p.id))}
                      >
                        {on ? <Check size={16} strokeWidth={2.5} /> : <Minus size={16} />}
                        <span className="num">{on ? usd(totals.cells.get(it.id)!.get(p.id)!) : ''}</span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
            {open && (
              <tr className="add-item">
                <th scope="row" className="item-col">
                  <input aria-label="New item" placeholder="New item" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addItem()} />
                </th>
                <td colSpan={data.people.length}>
                  <span className="add-item-row">
                    <input className="num money" inputMode="decimal" aria-label="New item price" placeholder="0.00" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addItem()} />
                    <button className="pill small" disabled={!newName.trim() || parseDollars(newPrice) === null} onClick={() => void addItem()}>Add</button>
                  </span>
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="item-col">Tax and tip <span className="price num">{usd(Number(data.sheet.tax_cents) + Number(data.sheet.tip_cents))}</span></th>
              {data.people.map((p) => <td key={p.id} className="num">{usd(totals.totals.get(p.id)?.extras ?? 0)}</td>)}
            </tr>
            <tr className="total">
              <th scope="row" className="item-col">Total <span className="price num">{usd(totals.total)}</span></th>
              {data.people.map((p) => <td key={p.id} className="num">{usd(totals.totals.get(p.id)?.total ?? 0)}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="fine">
        {data.people.length > 4 ? 'Swipe sideways to see everyone. ' : ''}Tap any cell to change it. Everyone else can change only their own column, from their link.
      </p>

      <section aria-label="People">
        <h2 className="month">People</h2>
        <ul className="list">
          {others.map((p) => {
            const st = responseStatus(p);
            return (
              <li key={p.id} className="list-row person-row-status">
                <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="row-main">
                  <span className="row-title">{p.name} <span className={`status ${st.tone}`}>{st.label}</span></span>
                  {metaSend ? (
                    <span className="row-sub">
                      {messageStatus(p)}
                      {p.alert_updated_at && p.alert_status !== 'no_phone' ? `, ${time(p.alert_updated_at)}` : ''}
                      {p.phone ? ` · ${p.phone}` : ''}
                    </span>
                  ) : (
                    <span className="row-sub">
                      {p.out_of_bill ? 'Not part of this bill' : p.responded_at ? `Finished, ${time(p.responded_at)}` : p.viewed_at ? `Opened, ${time(p.viewed_at)}` : "Hasn't opened their link yet"}
                      {` · owes ${usd(totals.totals.get(p.id)?.total ?? 0)}`}
                    </span>
                  )}
                  {metaSend && p.alert_status === 'failed' && p.alert_error && <span className="warn-text">{p.alert_error}</span>}
                </span>
                <span className="row-actions">
                  {metaSend && open && p.has_phone && !notConfigured && p.alert_status === 'failed' && (
                    <button className="pill small" disabled={sending} onClick={() => void send([p.id], true)}>Resend</button>
                  )}
                  <button className="pill small" onClick={() => void copy(p)}>
                    <Copy size={14} /> {copied === p.id ? 'Copied' : 'Link'}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      {data.events.length > 0 && (
        <section aria-label="Activity">
          <h2 className="month">Activity</h2>
          <ul className="activity">
            {data.events.slice(0, 40).map((e) => {
              const text = eventText(e, data);
              return text ? (
                <li key={e.id}>
                  <span>{text}</span>
                  <time className="fine" dateTime={e.at}>{time(e.at)}</time>
                </li>
              ) : null;
            })}
          </ul>
        </section>
      )}

      <section aria-label="Splitwise" className="stack tight">
        <h2 className="month">Splitwise</h2>
        <pre className="copy-block num">{splitwiseText(data, totals)}</pre>
        <button className="pill wide" disabled={totals.total <= 0} onClick={() => void copyText('splitwise', splitwiseText(data, totals))}>
          <ClipboardCopy size={16} /> {copiedText === 'splitwise' ? 'Copied' : 'Copy for Splitwise'}
        </button>
        <p className="fine">In Splitwise: Add an expense in your group, enter {usd(totals.total)}, choose "split by exact amounts" and type these in. Wait until everyone has answered{answered < others.length ? ` (${others.length - answered} still to go)` : ''}.</p>
      </section>

      {open && (
        <section className="stack tight">
          {!closing ? (
            <button className="pill wide" disabled={totals.total <= 0} onClick={() => setClosing(true)}>Close and add to {group.name}</button>
          ) : (
            <div className="confirm">
              <p>
                This locks the sheet and adds {usd(totals.total)} to {group.name}, with each person owing their total above.
                {answered < others.length ? ` ${others.length - answered} ${others.length - answered === 1 ? 'person hasn\'t' : 'people haven\'t'} answered yet.` : ''}
              </p>
              <div className="two">
                <button className="pill" onClick={() => setClosing(false)}>Not yet</button>
                <button className="pill primary" onClick={() => void closeIntoGroup()}>Close and add</button>
              </div>
            </div>
          )}
        </section>
      )}

      {showText && (
        <Sheet title="Copy this" onClose={() => setShowText(null)}>
          <textarea className="copy-block" readOnly rows={10} value={showText} onFocus={(e) => e.currentTarget.select()} />
        </Sheet>
      )}

      {editing && (
        <ItemSheet
          item={editing}
          onClose={() => setEditing(null)}
          onSave={(name, price) => {
            setEditing(null);
            void change(null, () => api.updateItem(token, editing.id, name, price));
          }}
          onRemove={() => {
            setEditing(null);
            void change(null, () => api.removeItem(token, editing.id));
          }}
        />
      )}
    </main>
  );
}

function ItemSheet({ item, onClose, onSave, onRemove }: { item: SheetData['items'][number]; onClose: () => void; onSave: (name: string, price: number) => void; onRemove: () => void }) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState((Number(item.price_cents) / 100).toFixed(2));
  const cents = parseDollars(price);
  return (
    <Sheet title="Edit item" onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (name.trim() && cents !== null) onSave(name.trim(), cents); }}>
        <label className="field"><span>Item</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span>Price</span><input className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={cents === null} /></label>
        <button className="pill primary wide" disabled={!name.trim() || cents === null}>Save</button>
        <button type="button" className="pill danger wide" onClick={onRemove}><Trash2 size={16} /> Remove {item.name}</button>
      </form>
    </Sheet>
  );
}
