import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ChevronLeft, LifeBuoy, Loader2 } from 'lucide-react';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { adminSwitchOrg, reloadHere } from '@/lib/orgMembers';

// Barra fixa exibida quando o super admin está operando em uma org de suporte
// (org_id do JWT ≠ home_org_id). O "Voltar" chama /api/admin/switch-org
// { back: true }, atualiza a sessão e recarrega.
export function SupportBanner({ variant = 'bar' }: { variant?: 'bar' | 'card' } = {}) {
  const { isSuperAdmin, orgName } = useAppUser();
  const { session } = useAuth();
  const [impersonating, setImpersonating] = useState(false);
  const [returning, setReturning] = useState(false);

  useEffect(() => {
    const meta = (session?.user?.app_metadata ?? {}) as {
      org_id?: string;
      home_org_id?: string;
    };
    setImpersonating(
      isSuperAdmin && !!meta.home_org_id && meta.org_id !== meta.home_org_id,
    );
  }, [isSuperAdmin, session]);

  if (!impersonating) return null;

  const handleBack = async () => {
    setReturning(true);
    try {
      await adminSwitchOrg({ back: true });
      reloadHere();
    } catch (err) {
      setReturning(false);
      toast.error('Falha ao voltar à sua organização', {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (variant === 'card') {
    return (
      <div className="mx-3 mt-2.5 flex items-center justify-between gap-3 rounded-2xl border border-[var(--color-border-soft)] bg-[var(--color-accent-subtle)] py-2 pl-3 pr-2 text-sm text-[var(--color-text-primary)]">
        <div className="flex min-w-0 items-center gap-2.5">
          <LifeBuoy className="h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
          <span className="min-w-0 text-[13px] leading-tight">Você está na organização <strong className="font-bold">{orgName ?? 'de suporte'}</strong></span>
        </div>
        <button type="button" onClick={() => void handleBack()} disabled={returning}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-[13px] font-semibold shadow-sm disabled:opacity-50">
          {returning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronLeft className="h-4 w-4" />} Voltar
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-2 bg-[var(--color-accent-subtle)] border-b border-[var(--color-border-card)] text-sm text-[var(--color-text-primary)]">
      <div className="flex items-center gap-2 min-w-0">
        <LifeBuoy className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
        <span className="truncate">
          Você está na organização{' '}
          <strong className="font-semibold">{orgName ?? 'de suporte'}</strong> como suporte.
        </span>
      </div>
      <button
        type="button"
        onClick={() => void handleBack()}
        disabled={returning}
        className="shrink-0 inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-3 py-1.5 text-xs font-semibold text-[var(--color-text-primary)] transition-colors duration-150 hover:border-[var(--accent-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
      >
        {returning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Voltar
      </button>
    </div>
  );
}
