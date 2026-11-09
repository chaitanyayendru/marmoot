import { useEffect, useRef, useState, type FormEvent } from 'react';
import { APP_NAMES, type PayApp, type Player } from '../model.ts';

const FIELDS: { app: PayApp; label: string; placeholder: string }[] = [
  { app: 'venmo', label: `${APP_NAMES.venmo} username`, placeholder: '@username' },
  { app: 'zelle', label: `${APP_NAMES.zelle} email or phone`, placeholder: 'name@example.com' },
  { app: 'paypal', label: 'PayPal.me name', placeholder: 'paypal.me/name' },
  { app: 'cashapp', label: `${APP_NAMES.cashapp} $cashtag`, placeholder: '$cashtag' },
];

interface Props {
  player: Player;
  isHost: boolean;
  hasBoughtIn: boolean;
  onSave: (p: Player, makeHost: boolean) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function PlayerDialog({ player, isHost, hasBoughtIn, onSave, onRemove, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<Player>(player);
  const [host, setHost] = useState(isHost);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    onSave({ ...draft, name: draft.name.trim() }, host && !isHost);
  }

  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-labelledby="player-title">
      <form onSubmit={submit}>
        <h2 id="player-title">{player.name}</h2>
        <label className="field">
          <span>Name</span>
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>

        <fieldset className="apps">
          <legend>How {draft.name.trim() || 'they'} can be paid</legend>
          {FIELDS.map((f) => (
            <label key={f.app} className="field">
              <span>{f.label}</span>
              <input
                value={draft.handles[f.app] ?? ''}
                placeholder={f.placeholder}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setDraft({ ...draft, handles: { ...draft.handles, [f.app]: e.target.value } })}
              />
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={draft.cash} onChange={(e) => setDraft({ ...draft, cash: e.target.checked })} />
            <span>Can settle in cash before leaving</span>
          </label>
        </fieldset>

        <label className="check">
          <input type="checkbox" checked={host} disabled={isHost} onChange={(e) => setHost(e.target.checked)} />
          <span>{isHost ? 'Host for this night' : 'Make host (collects cash buy-ins)'}</span>
        </label>

        <div className="sheet-actions">
          <button className="primary" type="submit">Save</button>
          <button type="button" onClick={() => ref.current?.close()}>Cancel</button>
        </div>
        {hasBoughtIn ? (
          <p className="fine">{player.name} has bought in, so they can't be removed. Undo their buy-ins first.</p>
        ) : (
          <button type="button" className="link danger" onClick={onRemove}>
            Remove {player.name} from this night
          </button>
        )}
      </form>
    </dialog>
  );
}
