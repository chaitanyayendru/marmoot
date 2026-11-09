import { useState, type Dispatch, type FormEvent } from 'react';
import { ChevronLeft, Plus, X } from 'lucide-react';
import { go } from '../App.tsx';
import { newGroup, newMember, type Action } from '../model.ts';
import { waNumber } from '../whatsapp.ts';
import { NotSaving } from './bits.tsx';

export function NewGroup({ dispatch, saved }: { dispatch: Dispatch<Action>; saved: boolean }) {
  const [name, setName] = useState('');
  const [you, setYou] = useState('');
  const [people, setPeople] = useState([{ name: '', phone: '' }, { name: '', phone: '' }]);

  const named = people.filter((p) => p.name.trim());
  const ready = name.trim() && you.trim() && named.length > 0;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const me = newMember(you);
    const g = newGroup(name, me, named.map((p) => newMember(p.name, p.phone)), Date.now());
    dispatch({ type: 'createGroup', group: g });
    go(`/g/${g.id}`);
  }

  return (
    <main className="page">
      <header className="topbar">
        <a className="back" href="#/"><ChevronLeft size={22} /> Groups</a>
      </header>
      {!saved && <NotSaving />}
      <form className="stack" onSubmit={submit}>
        <h1>New group</h1>
        <label className="field">
          <span>Group name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Flat 4B, Tahoe trip, Friday poker" autoFocus />
        </label>
        <label className="field">
          <span>Your name</span>
          <input value={you} onChange={(e) => setYou(e.target.value)} placeholder="How the group knows you" autoComplete="given-name" />
        </label>

        <fieldset className="people-edit">
          <legend>Who's in it</legend>
          <p className="fine">Add WhatsApp numbers to send each person reminders directly. You can add them later.</p>
          {people.map((p, i) => {
            const badPhone = p.phone.trim() !== '' && waNumber(p.phone) === null;
            return (
              <div key={i} className="person-row">
                <input aria-label={`Person ${i + 1} name`} value={p.name} placeholder="Name" onChange={(e) => setPeople(people.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)))} />
                <input aria-label={`Person ${i + 1} WhatsApp number`} value={p.phone} placeholder="WhatsApp number" inputMode="tel" aria-invalid={badPhone} onChange={(e) => setPeople(people.map((q, j) => (j === i ? { ...q, phone: e.target.value } : q)))} />
                {people.length > 1 && (
                  <button type="button" className="icon-btn" aria-label={`Remove person ${i + 1}`} onClick={() => setPeople(people.filter((_, j) => j !== i))}>
                    <X size={18} />
                  </button>
                )}
              </div>
            );
          })}
          <button type="button" className="pill small" onClick={() => setPeople([...people, { name: '', phone: '' }])}>
            <Plus size={16} /> Add someone
          </button>
        </fieldset>

        <button className="pill primary wide" disabled={!ready}>Create group</button>
      </form>
    </main>
  );
}
