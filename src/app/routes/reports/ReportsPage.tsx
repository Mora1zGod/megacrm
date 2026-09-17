import { useState, type ReactNode } from 'react';
import { PERIOD_PRESETS, periodRange, type PeriodKey } from '@/lib/dashboard';
import { useSalesDashboard } from '@/hooks/useSalesDashboard';
import { useOperators } from '@/hooks/useOperators';
import { Skeleton } from '@/components/ui/skeleton';

function formatBRL(v: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);
}

export default function ReportsPage() {
  const [period, setPeriod] = useState<PeriodKey>('30d');
  const range = periodRange(period);
  const { metrics, loading } = useSalesDashboard(range);
  const { operators } = useOperators();
  const ownerName = (id: string | null) => {
    if (!id) return 'Não atribuído';
    return operators.find((o) => o.user_id === id)?.email ?? 'Vendedor';
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-3 mb-4 shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Relatórios</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Visão consolidada — mesmos dados do Dashboard, em formato de relatório.</p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value as PeriodKey)}
          className="rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
        >
          {PERIOD_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex-1 space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto space-y-4">
          <ReportSection title="Vendas">
            <ReportRow label="Negócios ganhos" value={String(metrics.won.count)} />
            <ReportRow label="Valor ganho" value={formatBRL(metrics.won.value)} />
            <ReportRow label="Negócios perdidos" value={String(metrics.lost.count)} />
            <ReportRow label="Valor perdido" value={formatBRL(metrics.lost.value)} />
            <ReportRow label="Forecast (negócios abertos)" value={formatBRL(metrics.forecast.value)} />
          </ReportSection>

          <ReportSection title="Ranking por vendedor">
            {metrics.ranking.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] p-3">Sem vendas no período.</p>
            ) : (
              metrics.ranking.map((r) => (
                <ReportRow key={r.owner_id ?? 'sem-dono'} label={ownerName(r.owner_id)} value={formatBRL(r.value)} />
              ))
            )}
          </ReportSection>

          <ReportSection title="Uso da IA">
            <ReportRow label="Mensagens respondidas" value={String(metrics.ai.messagesCount)} />
            <ReportRow label="Conversas atendidas" value={String(metrics.ai.conversationsCount)} />
            <ReportRow
              label="Custo estimado (USD)"
              value={new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(metrics.ai.costUsd)}
            />
          </ReportSection>

          <ReportSection title="Canal de mensagem">
            {metrics.origin.messageChannel.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] p-3">Nenhuma conversa no período.</p>
            ) : (
              metrics.origin.messageChannel.map((c) => (
                <ReportRow key={c.name} label={c.name} value={String(c.count)} />
              ))
            )}
          </ReportSection>
        </div>
      )}
    </div>
  );
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
      <div className="px-4 py-2.5 border-b border-[var(--color-border-card)] text-sm font-semibold text-[var(--color-text-primary)]">
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ReportRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm border-b border-[var(--color-border-card)] last:border-0">
      <span className="text-[var(--color-text-secondary)]">{label}</span>
      <span className="font-medium text-[var(--color-text-primary)]">{value}</span>
    </div>
  );
}
