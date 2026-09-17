import { Bot, DollarSign, MessageSquare, UserCheck } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { useAmaiaOverview } from '@/hooks/useAmaiaOverview';

export function AmaiaOverviewTab() {
  const { data, loading } = useAmaiaOverview();

  if (loading || !data) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 flex items-center gap-3">
        <span className={`h-2.5 w-2.5 rounded-full ${data.isActive ? 'bg-[#22C55E]' : 'bg-[var(--color-text-secondary)]'}`} />
        <span className="text-sm font-semibold text-[var(--color-text-primary)]">
          AMAIA {data.isActive ? 'Online' : 'Pausada'}
        </span>
        <span className="text-xs text-[var(--color-text-secondary)] ml-2">
          Últimos 7 dias — dado real, sem tendência % (ainda não comparamos com o período anterior)
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card p-3">
          <MessageSquare className="h-4 w-4 text-[var(--accent-primary)] mb-1" />
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{data.conversasAtivasIA}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Conversas com IA ativa agora</div>
        </div>
        <div className="glass-card p-3">
          <UserCheck className="h-4 w-4 text-[var(--accent-primary)] mb-1" />
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{data.conversasHumano}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Em atendimento humano agora</div>
        </div>
        <div className="glass-card p-3">
          <Bot className="h-4 w-4 text-[var(--accent-primary)] mb-1" />
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{data.conversasAtendidasPeriodo}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Conversas atendidas (7d)</div>
        </div>
        <div className="glass-card p-3">
          <DollarSign className="h-4 w-4 text-[var(--accent-primary)] mb-1" />
          <div className="text-lg font-bold text-[var(--color-text-primary)]">
            {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(data.custoPeriodoUsd)}
          </div>
          <div className="text-xs text-[var(--color-text-secondary)]">Custo estimado (7d)</div>
        </div>
      </div>

      <div className="glass-card p-4">
        <div className="text-label mb-1">Transferências para humano (7d)</div>
        <div className="text-2xl font-bold text-[var(--color-text-primary)]">{data.transferenciasPeriodo}</div>
        <p className="mt-1 text-xs text-[var(--color-text-secondary)] opacity-70">
          Ainda não categorizamos o motivo (pedido do cliente, baixa confiança, etc.) — o sistema hoje só
          sabe que a transferência aconteceu. Categorizar motivo é uma melhoria futura.
        </p>
      </div>

      <div className="rounded-lg border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.06)] px-3 py-2 text-xs text-[#FBBF24]">
        "Testes" (conversar com a AMAIA sem afetar cliente real), "Versões" (histórico de prompt) e
        "Avaliação 👍👎" ainda não existem — não fabriquei essas telas sem backend de verdade por trás.
      </div>
    </div>
  );
}
