import { BadgeDollarSign, Eye, EyeOff, MonitorPlay, Target, TrendingUp, Users } from 'lucide-react';
import { useMonthRevenue } from '@/hooks/useSales';
import { useHideValues } from '@/hooks/useHideValues';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { formatBRL } from '@/lib/sales';
import { openNewSale } from '@/hooks/useSales';

// Faixa de vendas do mês no topo do dashboard: meta (barra), vendido,
// recebido/pendente, nº de vendas e top vendedores.
export function RevenueGoalCard() {
  const { data, loading } = useMonthRevenue();
  const { hidden, toggle } = useHideValues();
  const { operators } = useOperators();
  if (loading) return null;

  const pct = data.goal ? Math.min(100, (data.sold / data.goal) * 100) : 0;
  const monthName = new Date().toLocaleDateString('pt-BR', { month: 'long' });
  const nameOf = (id: string | null) => (id ? operatorLabel(operators.find((o) => o.user_id === id)) || 'Vendedor' : 'Sem vendedor');

  return (
    <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">
              <Target className="h-4 w-4 text-[var(--accent-primary)]" /> Meta de {monthName}
            </div>
            <div className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">{formatBRL(data.sold, hidden)}</div>
            <div className="text-xs text-[var(--color-text-secondary)]">
              {data.goal ? <>de {formatBRL(data.goal, hidden)} · {Math.floor(pct)}% alcançado</> : 'Defina a meta no alvo do topo da tela'}
            </div>
          </div>
          <div className="flex gap-1">
            <button type="button" onClick={toggle} className="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'} title={hidden ? 'Mostrar valores' : 'Ocultar valores'}>
              {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
            <a href="/painel-tv" target="_blank" rel="noopener" className="rounded p-1.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-label="Abrir Painel TV" title="Abrir Painel TV">
              <MonitorPlay className="h-4 w-4" />
            </a>
          </div>
        </div>
        {data.goal ? (
          <div className="mt-3">
            <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
              <div className="h-full rounded-full bg-[var(--color-success)] transition-[width] duration-700" style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-1 text-right text-xs text-[var(--color-text-muted)]">
              {pct >= 100 ? 'Meta batida! 🎉' : `Faltam ${formatBRL(Math.max(0, data.goal - data.sold), hidden)}`}
            </div>
          </div>
        ) : null}
      </div>

      <Stat icon={<BadgeDollarSign className="h-4 w-4" />} label="Recebido no mês" value={formatBRL(data.received, hidden)}
        sub={<>A receber: {formatBRL(data.pending, hidden)}{data.overdue > 0 && <span className="text-[var(--color-error)]"> · Vencido: {formatBRL(data.overdue, hidden)}</span>}</>} />
      <Stat icon={<TrendingUp className="h-4 w-4" />} label="Vendas no mês" value={String(data.salesCount)}
        sub={<button type="button" onClick={() => openNewSale()} className="font-medium text-[var(--accent-primary)] hover:underline">+ Registrar venda</button>} />
      <Stat icon={<Users className="h-4 w-4" />} label="Top vendedores" value={data.ranking[0] ? nameOf(data.ranking[0].owner_id) : '—'}
        sub={data.ranking.length ? data.ranking.slice(0, 3).map((r, i) => `${i + 1}º ${nameOf(r.owner_id)} ${formatBRL(r.value, hidden)}`).join(' · ') : 'Nenhuma venda ainda'} />
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
      <div className="flex items-center gap-2 text-xs font-medium text-[var(--color-text-secondary)]">
        <span className="text-[var(--accent-primary)]">{icon}</span> {label}
      </div>
      <div className="mt-2 truncate text-xl font-bold text-[var(--color-text-primary)]">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}
