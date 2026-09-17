import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { CheckCircle2, XCircle } from 'lucide-react';
import { useIntegrationsStatus } from '@/hooks/useIntegrationsStatus';

export default function IntegrationsPage() {
  const { statuses, loading } = useIntegrationsStatus();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="mb-4 shrink-0">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Integrações</h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Visão geral do que já está configurado. Pra conectar números específicos, vai em{' '}
          <Link to="/settings/profile?tab=channels" className="text-[var(--accent-primary)] underline">
            Configurações → Canais
          </Link>.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : (
          statuses.map((s) => (
            <div
              key={s.key}
              className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 py-3"
            >
              <span className="text-sm text-[var(--color-text-primary)]">{s.label}</span>
              {s.configured ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-success)]">
                  <CheckCircle2 className="h-4 w-4" /> Configurado
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-secondary)]">
                  <XCircle className="h-4 w-4" /> Pendente
                </span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
