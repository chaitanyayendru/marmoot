import { useMemo, useState, type Dispatch } from 'react';
import { ChevronLeft, Copy, MessageCircle } from 'lucide-react';
import { usd } from '../money.ts';
import { APP_NAMES, newId, settlePlan, today, transferKey, type Action, type Group, type PayApp } from '../model.ts';
import { payAction } from '../payments.ts';
import { planText, reminderText, waLink, waNumber } from '../whatsapp.ts';
import { NotSaving, Notice } from './bits.tsx';

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function SettleView({ group, dispatch, saved }: { group: Group; dispatch: Dispatch<Action>; saved: boolean }) {
  const plan = useMemo(() => settlePlan(group), [group]);
  const [copied, setCopied] = useState<string | null>(null);
  const member = (id: string) => group.members.find((m) => m.id === id);
  const name = (id: string) => (id === group.me ? 'You' : member(id)?.name ?? 'Someone');
  const flash = async (key: string, text: string) => {
    if (await copy(text)) {
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 2000);
    }
  };
  const missingPhones = plan.transfers.filter((t) => t.from !== group.me && !waNumber(member(t.from)?.phone ?? '')).map((t) => name(t.from));

  return (
    <main className="page">
      <header className="topbar">
        <a className="back" href={`#/g/${group.id}`}><ChevronLeft size={22} /> {group.name}</a>
      </header>
      {!saved && <NotSaving />}

      <section className="hero" aria-label="Settle up">
        <h1 className="hero-title">Settle up</h1>
        <p className="hero-amount num">{plan.transfers.length}</p>
        <p className="hero-sub flat">
          {plan.transfers.length === 0 ? 'Everyone is settled up' : plan.transfers.length === 1 ? 'payment clears the group' : 'payments clear the group'}
          {plan.greedyCount > plan.transfers.length ? `, instead of ${plan.greedyCount}` : ''}
        </p>
      </section>

      {plan.matched === 'no-apps' && plan.transfers.length > 0 && (
        <Notice>
          Add each person's payment apps in <a href={`#/g/${group.id}/people`}>People</a> so every payment uses an app both people have.
        </Notice>
      )}
      {plan.matched === 'infeasible' && <Notice tone="warn">Someone shares no payment app with the people they'd pay, so this plan ignores apps.</Notice>}

      <ul className="list transfers">
        {plan.transfers.map((t) => {
          const key = transferKey(t);
          const payee = member(t.to);
          const action = payee ? payAction(t, payee, group.name) : null;
          const youPay = t.from === group.me;
          const record = () => dispatch({ type: 'addItem', group: group.id, item: { kind: 'payment', id: newId(), at: Date.now(), date: today(), from: t.from, to: t.to, amount: t.amount, rail: t.rail } });
          return (
            <li key={key} className="transfer">
              <div className="transfer-top">
                <p className="row-title">
                  {name(t.from)} {youPay ? 'pay' : 'pays'} {t.to === group.me ? 'you' : name(t.to)}
                </p>
                <p className={`num transfer-amt ${youPay ? 'down' : t.to === group.me ? 'up' : ''}`}>{usd(t.amount)}</p>
              </div>
              {t.rail && <p className="row-sub">on {APP_NAMES[t.rail as PayApp | 'cash']}</p>}
              <div className="transfer-actions">
                {youPay ? (
                  action?.kind === 'link' ? (
                    <a className="pill primary" href={action.href} target="_blank" rel="noopener noreferrer">{action.label}</a>
                  ) : action?.kind === 'copy' ? (
                    <button className="pill primary" onClick={() => flash(key, action.value)}>
                      <Copy size={16} /> {copied === key ? 'Copied' : action.label}
                    </button>
                  ) : null
                ) : (
                  <a className="pill whatsapp" href={waLink(reminderText(group, t), member(t.from)?.phone)} target="_blank" rel="noopener noreferrer">
                    <MessageCircle size={16} /> Remind {name(t.from)}
                  </a>
                )}
                <button className="pill" onClick={record}>{t.to === group.me ? 'Mark received' : 'Mark paid'}</button>
              </div>
              {youPay && action?.kind === 'copy' && <p className="fine">{action.hint}</p>}
              {youPay && action?.kind === 'link' && action.caveat && <p className="fine">{action.caveat}</p>}
            </li>
          );
        })}
      </ul>

      {missingPhones.length > 0 && (
        <p className="fine">
          No WhatsApp number for {[...new Set(missingPhones)].join(', ')}, so their reminder opens WhatsApp's chat picker.{' '}
          <a href={`#/g/${group.id}/people`}>Add numbers</a>
        </p>
      )}

      {plan.transfers.length > 0 && (
        <div className="share">
          <a className="pill whatsapp wide" href={waLink(planText(group, plan.transfers))} target="_blank" rel="noopener noreferrer">
            <MessageCircle size={16} /> Send the plan to the group
          </a>
          <button className="pill wide" onClick={() => flash('plan', planText(group, plan.transfers))}>
            <Copy size={16} /> {copied === 'plan' ? 'Copied' : 'Copy the plan'}
          </button>
        </div>
      )}
      <p className="fine">Messages open in your own WhatsApp, already written, with each payer's pay link inside. Nothing is sent until you tap send.</p>
    </main>
  );
}
