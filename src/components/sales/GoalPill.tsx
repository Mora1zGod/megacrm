import { useState } from 'react';
import { toast } from 'sonner';
import { Eye, EyeOff, MonitorPlay, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMonthRevenue } from '@/hooks/useSales';
import { formatBRL, formatBRLShort, parseMoney } from '@/lib/sales';
import { useHideValues } from '@/hooks/useHideValues';

// Pill da meta do mês no topo (admin): vendido / meta + barra. Clique abre
// o resumo, a edição da meta e o atalho para o Painel TV.
export function GoalPill() {
  const { data, loading, setGoal } = useMonthRevenue();
  const [open, setOpen] = useState(false);
  const [goalRaw, setGoalRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const { hidden, toggle } = useHideValues();

  if (loading) return null;
  const pct = data.goal ? Math.min(100, Math.round((data.sold / data.goal) * 100)) : null;
  const money = (v: number) => (hidden ? 'R$ •••' : formatBRLShort(v));

  const save = async () => {
    const v = parseMoney(goalRaw);
    if (!(v >= 0)) { toast.error('Valor inválido.'); return; }
    setSaving(true);
    try {
      await setGoal(v);
      toast.success('Meta do mês salva.');
      setGoalRaw('');
    } catch (e) {
      toast.error('Não foi possível salvar a meta', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative hidden lg:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-3 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]"
        aria-label="Meta do mês"
      >
        <Target className="h-4 w-4 text-[var(--accent-primary)]" />
        <span className="font-semibold text-[var(--color-text-primary)]">{money(data.sold)}</span>
        {data.goal ? <span>/ {money(data.goal)}</span> : <span>definir meta</span>}
        {pct !== null && (
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
            <span className="block h-full rounded-full bg-[var(--color-success)]" style={{ width: `${pct}%` }} />
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setOpen(false)} />
          <div className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-72 space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-4 shadow-[var(--shadow-lg)]">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">Meta do mês</div>
              <button type="button" onClick={toggle} className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-label={hidden ? 'Mostrar valores' : 'Ocultar valores'} title={hidden ? 'Mostrar valores' : 'Ocultar valores'}>
                {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <div className="space-y-1 text-sm">
              <Row label="Vendido" value={formatBRL(data.sold, hidden)} strong />
              <Row label="Meta" value={data.goal ? formatBRL(data.goal, hidden) : '—'} />
              {data.goal ? <Row label={pct! >= 100 ? 'Meta batida! 🎉' : 'Falta'} value={pct! >= 100 ? `${pct}%` : formatBRL(Math.max(0, data.goal - data.sold), hidden)} /> : null}
              <Row label="Vendas no mês" value={String(data.salesCount)} />
              <Row label="Recebido no mês" value={formatBRL(data.received, hidden)} />
              <Row label="A receber no mês" value={formatBRL(data.pending, hidden)} />
              {data.overdue > 0 && <Row label="Vencido" value={formatBRL(data.overdue, hidden)} danger />}
            </div>
            <div className="flex gap-2">
              <input
                value={goalRaw}
                onChange={(e) => setGoalRaw(e.target.value)}
                placeholder={data.goal ? 'Nova meta (R$)' : 'Meta do mês (R$)'}
                inputMode="decimal"
                className="min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-2.5 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
              />
              <Button size="sm" onClick={() => void save()} disabled={saving || !goalRaw.trim()}>Salvar</Button>
            </div>
            <a href="/painel-tv" target="_blank" rel="noopener" className="flex items-center justify-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] py-2 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
              <MonitorPlay className="h-4 w-4" /> Abrir Painel TV
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, strong, danger }: { label: string; value: string; strong?: boolean; danger?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-[var(--color-text-secondary)]">{label}</span>
      <span className={`${strong ? 'font-semibold' : ''} ${danger ? 'text-[var(--color-error)]' : 'text-[var(--color-text-primary)]'}`}>{value}</span>
    </div>
  );
}
