import { useMemo, type Dispatch } from 'react';
import { usd } from '../money.ts';
import { derive, type Action, type Night } from '../model.ts';
import { NotSaving } from './bits.tsx';
import { CashOutStep } from './CashOutStep.tsx';
import { SettleStep } from './SettleStep.tsx';
import { TableStep } from './TableStep.tsx';

export type Step = 'table' | 'cashout' | 'settle';

const STEPS: { id: Step; label: string }[] = [
  { id: 'table', label: 'Buy-ins' },
  { id: 'cashout', label: 'Cash out' },
  { id: 'settle', label: 'Settle' },
];

export interface StepProps {
  night: Night;
  derived: ReturnType<typeof derive>;
  dispatch: Dispatch<Action>;
}

export function NightView({ night, step, dispatch, saved }: { night: Night; step: Step; dispatch: Dispatch<Action>; saved: boolean }) {
  const derived = useMemo(() => derive(night), [night]);
  const props: StepProps = { night, derived, dispatch };

  return (
    <main className="page">
      <nav className="crumbs">
        <a href="#/">All nights</a>
      </nav>
      <header className="night-head">
        <h1>{night.name}</h1>
        <p className="pot">
          <span className="num">{usd(derived.pot)}</span> in the pot, {night.players.length} {night.players.length === 1 ? 'player' : 'players'}
        </p>
      </header>

      {!saved && <NotSaving />}

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.id}>
            <a href={`#/n/${night.id}/${s.id}`} aria-current={s.id === step ? 'step' : undefined}>
              <span className="step-n">{i + 1}</span>
              {s.label}
            </a>
          </li>
        ))}
      </ol>

      {step === 'table' && <TableStep {...props} />}
      {step === 'cashout' && <CashOutStep {...props} />}
      {step === 'settle' && <SettleStep {...props} />}
    </main>
  );
}
