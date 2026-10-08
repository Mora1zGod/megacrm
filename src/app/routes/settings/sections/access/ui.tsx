import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Member } from './useAccessData';

export const inputCls =
  'h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--accent-primary)] disabled:opacity-60';

export function Field({ label, htmlFor, hint, required, children }: { label: string; htmlFor?: string; hint?: string; required?: boolean; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold text-[var(--color-text-secondary)]">{label}{required && <span className="text-[var(--color-error)]" aria-label="obrigatório"> *</span>}</label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

// Painel lateral (drawer) — usado no cadastro/edição de usuário e no editor de perfil.
export function Drawer({ open, title, subtitle, onClose, children, footer, wide }: {
  open: boolean; title: string; subtitle?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40 fade-in" onClick={onClose} />
      <div className={cn('relative flex h-full w-full flex-col bg-[var(--color-surface)] shadow-[var(--shadow-lg)]', wide ? 'max-w-3xl' : 'max-w-xl')}>
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border-card)] px-6 py-4">
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Fechar" className="rounded-lg p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-[var(--color-border-card)] px-6 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function StatusPill({ m }: { m: Pick<Member, 'status' | 'invite_pending'> }) {
  const s = m.status === 'pending'
    ? { label: 'Aguardando aprovação', dot: 'bg-[#F59E0B]', text: 'text-[var(--inbox-warn-text,#B45309)]' }
    : m.status !== 'active'
    ? m.status === 'blocked'
      ? { label: 'Bloqueado', dot: 'bg-[var(--color-error)]', text: 'text-[var(--color-error)]' }
      : { label: 'Inativo', dot: 'bg-[var(--color-text-muted)]', text: 'text-[var(--color-text-muted)]' }
    : m.invite_pending
      ? { label: 'Convite pendente', dot: 'bg-[#F59E0B]', text: 'text-[var(--inbox-warn-text,#B45309)]' }
      : { label: 'Ativo', dot: 'bg-[var(--color-success)]', text: 'text-[var(--color-success)]' };
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-semibold', s.text)}>
      <span className={cn('h-2 w-2 rounded-full', s.dot)} /> {s.label}
    </span>
  );
}

export function formatWhen(iso: string | null): string {
  if (!iso) return 'Nunca';
  const d = new Date(iso);
  const now = new Date();
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 2) return 'Agora';
  if (mins < 60) return `há ${mins} min`;
  if (d.toDateString() === now.toDateString()) return `Hoje, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
