import { useEffect, useRef, type ReactNode } from 'react';
import { Car, House, Package, Plane, Receipt, ShoppingCart, Spade, Ticket, Utensils, X, Zap, type LucideIcon } from 'lucide-react';
import { usd } from '../money.ts';
import type { Category } from '../model.ts';

const ICONS: Record<Category, LucideIcon> = {
  groceries: ShoppingCart,
  utilities: Zap,
  rent: House,
  dining: Utensils,
  household: Package,
  transport: Car,
  travel: Plane,
  fun: Ticket,
  game: Spade,
  other: Receipt,
};

export function CategoryIcon({ category, size = 18 }: { category: Category; size?: number }) {
  const Icon = ICONS[category] ?? Receipt;
  return (
    <span className="cat" aria-hidden="true">
      <Icon size={size} strokeWidth={1.75} />
    </span>
  );
}

/** Green when you're owed, red when you owe. Always has a sign so color is never the only cue. */
export function Signed({ cents, className = '' }: { cents: number; className?: string }) {
  const cls = cents > 0 ? 'up' : cents < 0 ? 'down' : 'flat';
  return <span className={`num ${cls} ${className}`}>{cents > 0 ? `+${usd(cents)}` : usd(cents)}</span>;
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <p className={`notice ${tone}`} role={tone === 'warn' ? 'alert' : undefined}>
      {children}
    </p>
  );
}

/** A modal sheet built on <dialog>, so focus, Escape and the backdrop behave. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} aria-label={title}>
      <header className="sheet-head">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" onClick={() => ref.current?.close()} aria-label="Close">
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function NotSaving() {
  return <Notice tone="warn">This browser isn't saving your data. Keep this page open, or open Marmoot in a normal browser tab.</Notice>;
}
