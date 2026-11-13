import { useState, type Dispatch, type FormEvent } from 'react';
import { ChevronLeft, Plus } from 'lucide-react';
import { go } from '../App.tsx';
import { APP_NAMES, memberInUse, newMember, railsFor, type Action, type Group, type Member, type PayApp } from '../model.ts';
import { waNumber } from '../whatsapp.ts';
import { NotSaving, Sheet } from './bits.tsx';

const FIELDS: { app: PayApp; label: string; placeholder: string }[] = [
  { app: 'venmo', label: 'Venmo username', placeholder: '@username' },
  { app: 'zelle', label: 'Zelle email or phone', placeholder: 'name@example.com' },
  { app: 'paypal', label: 'PayPal.me name', placeholder: 'paypal.me/name' },
  { app: 'cashapp', label: 'Cash App $cashtag', placeholder: '$cashtag' },
];

export function PeopleView({ group, dispatch, saved }: { group: Group; dispatch: Dispatch<Action>; saved: boolean }) {
  const [editing, setEditing] = useState<Member | null>(null);
  const [newName, setNewName] = useState('');
  const [groupName, setGroupName] = useState(group.name);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function add(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    const m = newMember(newName);
    dispatch({ type: 'addMember', group: group.id, member: m });
    setNewName('');
    setEditing(m);
  }

  return (
    <main className="page">
      <header className="topbar">
        <a className="back" href={`#/g/${group.id}`}><ChevronLeft size={22} /> {group.name}</a>
      </header>
      {!saved && <NotSaving />}
      <h1>People</h1>
      <p className="fine">A WhatsApp number lets reminders go straight to that person. Payment apps decide who can pay whom.</p>

      <ul className="list">
        {group.members.map((m) => {
          const apps = railsFor(m).map((a) => APP_NAMES[a as PayApp | 'cash']);
          return (
            <li key={m.id}>
              <button className="list-row as-button" onClick={() => setEditing(m)}>
                <span className="avatar" aria-hidden="true">{m.name.slice(0, 1).toUpperCase()}</span>
                <span className="row-main">
                  <span className="row-title">{m.name}{m.id === group.me && m.name !== 'You' ? ' (you)' : ''}</span>
                  <span className="row-sub">
                    {group.shared ? (m.userId ? 'Joined, ' : 'Not joined yet, ') : ''}
                    {apps.length ? apps.join(', ') : 'No payment apps yet'}
                    {m.id !== group.me && !waNumber(m.phone) ? ', no WhatsApp number' : ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <form className="add-row" onSubmit={add}>
        <input aria-label="New person's name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Add someone" />
        <button className="pill" disabled={!newName.trim()}><Plus size={16} /> Add</button>
      </form>

      <section className="stack danger-zone" aria-label="Group settings">
        <label className="field">
          <span>Group name</span>
          <input value={groupName} onChange={(e) => setGroupName(e.target.value)} onBlur={() => dispatch({ type: 'renameGroup', group: group.id, name: groupName })} />
        </label>
        {confirmDelete ? (
          <div className="confirm">
            <p>
              {group.shared
                ? `Leave ${group.name}? It disappears from your phones. Everyone else keeps it, with your expenses in it.`
                : `Delete ${group.name} and everything in it from this device?`}
            </p>
            <div className="two">
              <button className="pill danger" onClick={() => { dispatch({ type: 'deleteGroup', group: group.id }); go('/'); }}>{group.shared ? 'Leave group' : 'Delete group'}</button>
              <button className="pill" onClick={() => setConfirmDelete(false)}>{group.shared ? 'Stay' : 'Keep it'}</button>
            </div>
          </div>
        ) : (
          <button className="link danger" onClick={() => setConfirmDelete(true)}>{group.shared ? 'Leave this group' : 'Delete this group'}</button>
        )}
      </section>

      {editing && (
        <MemberSheet
          member={editing}
          isMe={editing.id === group.me}
          inUse={memberInUse(group, editing.id) || !!editing.userId}
          onSave={(m) => { dispatch({ type: 'updateMember', group: group.id, member: m }); setEditing(null); }}
          onRemove={() => { dispatch({ type: 'removeMember', group: group.id, member: editing.id }); setEditing(null); }}
          onClose={() => setEditing(null)}
        />
      )}
    </main>
  );
}

function MemberSheet({ member, isMe, inUse, onSave, onRemove, onClose }: { member: Member; isMe: boolean; inUse: boolean; onSave: (m: Member) => void; onRemove: () => void; onClose: () => void }) {
  const [draft, setDraft] = useState(member);
  const badPhone = draft.phone.trim() !== '' && waNumber(draft.phone) === null;
  return (
    <Sheet title={member.name} onClose={onClose}>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (draft.name.trim() && !badPhone) onSave({ ...draft, name: draft.name.trim() }); }}>
        <label className="field">
          <span>Name</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label className="field">
          <span>WhatsApp number</span>
          <input value={draft.phone} inputMode="tel" placeholder="+1 404 555 0101" aria-invalid={badPhone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          {badPhone && <span className="warn-text">Include the country code, like +1 or +91.</span>}
        </label>
        <fieldset className="stack tight">
          <legend>How {isMe ? 'you' : draft.name.trim() || 'they'} can be paid</legend>
          {FIELDS.map((f) => (
            <label key={f.app} className="field">
              <span>{f.label}</span>
              <input value={draft.handles[f.app] ?? ''} placeholder={f.placeholder} autoCapitalize="off" autoCorrect="off" spellCheck={false} onChange={(e) => setDraft({ ...draft, handles: { ...draft.handles, [f.app]: e.target.value } })} />
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={draft.cash} onChange={(e) => setDraft({ ...draft, cash: e.target.checked })} />
            <span>Can settle in cash</span>
          </label>
        </fieldset>
        <button className="pill primary wide" disabled={!draft.name.trim() || badPhone}>Save</button>
        {!isMe && (inUse ? <p className="fine">{member.userId ? `${member.name} has joined with their own account, so they stay in the group.` : `${member.name} is in some expenses, so they stay in the group.`}</p> : <button type="button" className="link danger" onClick={onRemove}>Remove {member.name}</button>)}
      </form>
    </Sheet>
  );
}
