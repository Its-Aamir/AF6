import clsx from 'clsx';
import { Loader2, X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';

export function Button({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'xs'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors select-none disabled:cursor-not-allowed disabled:opacity-45',
        size === 'md' && 'h-8 px-3 text-[13px]',
        size === 'sm' && 'h-7 px-2.5 text-[12px]',
        size === 'xs' && 'h-6 px-2 text-[11px]',
        variant === 'primary' && 'bg-accent text-[#0b0d1a] hover:bg-accent-strong',
        variant === 'secondary' && 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-[#20252f]',
        variant === 'ghost' && 'text-muted hover:text-fg hover:bg-raised',
        variant === 'subtle' && 'bg-accent/12 text-accent-strong hover:bg-accent/20',
        variant === 'danger' && 'bg-bad/10 text-bad border border-bad/25 hover:bg-bad/20',
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

const TONES = {
  neutral: 'bg-raised text-muted border-line',
  accent: 'bg-accent/12 text-accent-strong border-accent/25',
  ok: 'bg-ok/10 text-ok border-ok/25',
  warn: 'bg-warn/10 text-warn border-warn/25',
  bad: 'bg-bad/10 text-bad border-bad/25',
  info: 'bg-info/10 text-info border-info/25',
} as const;
export type Tone = keyof typeof TONES;

export function Badge({ tone = 'neutral', children, className, pulse }: { tone?: Tone; children: ReactNode; className?: string; pulse?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium whitespace-nowrap', TONES[tone], className)}>
      {pulse && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Panel({ title, actions, children, className, bodyClassName }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={clsx('rounded-xl border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <h3 className="text-[12px] font-semibold tracking-wide text-fg">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={clsx('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Progress({ value, tone = 'accent', className }: { value: number; tone?: 'accent' | 'ok' | 'warn' | 'bad'; className?: string }) {
  const color = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' }[tone];
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-line', className)}>
      <div className={clsx('h-full rounded-full transition-[width] duration-500', color)} style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('size-4 animate-spin text-muted', className)} />;
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-12 text-center">
      {icon && <div className="mb-1 text-faint">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="max-w-md text-muted">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-6 backdrop-blur-sm" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" className={clsx('flex max-h-[90vh] w-full flex-col rounded-2xl border border-line-strong bg-panel shadow-2xl shadow-black/60', wide ? 'max-w-5xl' : 'max-w-lg')}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-[14px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg" aria-label="Close"><X className="size-4" /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, disabled, size = 'md' }: { value: T; options: { value: T; label: ReactNode; disabled?: boolean }[]; onChange: (v: T) => void; disabled?: boolean; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
          className={clsx('rounded-md font-medium transition-colors disabled:opacity-40', size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-3 py-1 text-[12px]',
            value === o.value ? 'bg-raised text-fg shadow-sm' : 'text-muted hover:text-fg')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx('inline-flex cursor-pointer items-center gap-2 select-none', disabled && 'cursor-not-allowed opacity-50')}>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={clsx('relative h-[18px] w-8 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}>
        <span className={clsx('absolute top-0.5 size-3.5 rounded-full bg-white transition-all', checked ? 'left-[16px]' : 'left-0.5')} />
      </button>
      {label && <span className="text-[12px]">{label}</span>}
    </label>
  );
}

export function Stat({ label, value, sub, icon }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-muted">{label}{icon}</div>
      <div className="mt-2 text-[22px] font-semibold tracking-tight tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-muted">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

export function ErrorNote({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-bad/30 bg-bad/8 px-3 py-2 text-[12px] text-bad">
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onDismiss && <button onClick={onDismiss} className="opacity-70 hover:opacity-100" aria-label="Dismiss"><X className="size-3.5" /></button>}
    </div>
  );
}
