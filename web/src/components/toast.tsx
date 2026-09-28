import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Modal } from './ui';

type ToastKind = 'ok' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; title: string; body?: string }
interface ConfirmReq { title: string; body: string; confirmLabel: string; resolve: (v: boolean) => void }

const Ctx = createContext<{ toast: (kind: ToastKind, title: string, body?: string) => void; confirm: (title: string, body: string, confirmLabel?: string) => Promise<boolean> } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmReq, setConfirmReq] = useState<ConfirmReq | null>(null);
  const seq = useRef(0);
  const toast = useCallback((kind: ToastKind, title: string, body?: string) => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-4), { id, kind, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 9000 : 3500);
  }, []);
  const confirm = useCallback((title: string, body: string, confirmLabel = 'Continue') => new Promise<boolean>((resolve) => setConfirmReq({ title, body, confirmLabel, resolve })), []);
  const close = (v: boolean) => { confirmReq?.resolve(v); setConfirmReq(null); };
  return (
    <Ctx.Provider value={{ toast, confirm }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[360px] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={clsx('pointer-events-auto flex gap-2.5 rounded-xl border bg-panel-2 p-3 shadow-xl shadow-black/40',
            t.kind === 'error' ? 'border-bad/40' : t.kind === 'ok' ? 'border-ok/30' : 'border-line-strong')}>
            {t.kind === 'error' ? <AlertTriangle className="mt-px size-4 shrink-0 text-bad" /> : t.kind === 'ok' ? <CheckCircle2 className="mt-px size-4 shrink-0 text-ok" /> : <Info className="mt-px size-4 shrink-0 text-info" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{t.title}</div>
              {t.body && <div className="mt-0.5 break-words text-[12px] text-muted">{t.body}</div>}
            </div>
            <button className="text-faint hover:text-fg" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss"><X className="size-3.5" /></button>
          </div>
        ))}
      </div>
      <Modal open={!!confirmReq} onClose={() => close(false)} title={confirmReq?.title ?? ''}
        footer={<><Button variant="ghost" onClick={() => close(false)}>Cancel</Button><Button variant="primary" onClick={() => close(true)}>{confirmReq?.confirmLabel}</Button></>}>
        <p className="text-muted">{confirmReq?.body}</p>
      </Modal>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}
