import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Briefcase, Check, Loader2, Pencil, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { brl } from '@/lib/dashboard';

interface DealLite {
  id: string;
  title: string;
  value: number | null;
  stage_id: string | null;
  status: string;
}

interface StageLite {
  id: string;
  name: string;
}

// Barra compacta acima da thread: valor e etapa do negócio ativo, editáveis
// sem sair da conversa.
//
// Esses dados já existiam no painel lateral, mas ali competem com tags,
// campos personalizados e ações — no meio de um atendimento o operador não
// para para procurar. Aqui ficam na linha de visão, junto do nome do contato.
// O painel continua sendo o lugar de tudo o mais.
export function ConversationDealBar({
  contactId,
  activeDealId,
}: {
  contactId: string | null;
  activeDealId: string | null;
}) {
  const [deal, setDeal] = useState<DealLite | null>(null);
  const [stages, setStages] = useState<StageLite[]>([]);
  const [editandoValor, setEditandoValor] = useState(false);
  const [valorTxt, setValorTxt] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let cancelado = false;
    void (async () => {
      if (!contactId) { setDeal(null); return; }
      const supabase = getSupabase();
      // Negócio ativo da conversa; sem ele, o negócio aberto mais recente.
      let q = supabase
        .from('deals')
        .select('id, title, value, stage_id, status')
        .eq('contact_id', contactId)
        .is('archived_at', null)
        .eq('status', 'open')
        .order('created_at', { ascending: false })
        .limit(1);
      if (activeDealId) q = supabase
        .from('deals')
        .select('id, title, value, stage_id, status')
        .eq('id', activeDealId)
        .limit(1);
      const { data } = await q;
      const d = ((data ?? []) as DealLite[])[0] ?? null;
      if (cancelado) return;
      setDeal(d);
      if (d?.stage_id) {
        const { data: st } = await supabase
          .from('deals')
          .select('pipeline_id')
          .eq('id', d.id)
          .maybeSingle();
        const pid = (st as { pipeline_id: string | null } | null)?.pipeline_id;
        if (pid) {
          const { data: sts } = await supabase
            .from('stages')
            .select('id, name')
            .eq('pipeline_id', pid)
            .order('position');
          if (!cancelado) setStages((sts ?? []) as StageLite[]);
        }
      }
    })();
    return () => { cancelado = true; };
  }, [contactId, activeDealId]);

  if (!deal) return null;

  const salvarValor = async () => {
    const limpo = valorTxt.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
    const num = Number(limpo);
    if (!Number.isFinite(num) || num < 0) {
      toast.error('Valor inválido.');
      return;
    }
    setSalvando(true);
    const { error } = await getSupabase().from('deals').update({ value: num }).eq('id', deal.id);
    setSalvando(false);
    if (error) { toast.error('Não consegui salvar.', { description: error.message }); return; }
    setDeal({ ...deal, value: num });
    setEditandoValor(false);
    toast.success('Valor atualizado.');
  };

  const mudarEtapa = async (stageId: string) => {
    const anterior = deal.stage_id;
    setDeal({ ...deal, stage_id: stageId });
    const { error } = await getSupabase().from('deals').update({ stage_id: stageId }).eq('id', deal.id);
    if (error) {
      setDeal({ ...deal, stage_id: anterior });
      toast.error('Não consegui mover.', { description: error.message });
      return;
    }
    toast.success('Etapa atualizada.');
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--color-border-card)] bg-[var(--color-accent-subtle)] px-4 py-2">
      <div className="flex items-center gap-1.5 min-w-0">
        <Briefcase className="h-3 w-3 shrink-0 text-[var(--accent-primary)]" />
        <span className="truncate text-xs text-[var(--color-text-secondary)]">{deal.title}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <span className="text-[0.65rem] uppercase tracking-wide text-[var(--color-text-secondary)]">Valor</span>
        {editandoValor ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={valorTxt}
              onChange={(e) => setValorTxt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void salvarValor();
                if (e.key === 'Escape') setEditandoValor(false);
              }}
              placeholder="0,00"
              className="w-24 rounded border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-1.5 py-0.5 text-xs text-[var(--color-text-primary)]"
            />
            <button type="button" onClick={() => void salvarValor()} disabled={salvando} aria-label="Salvar valor">
              {salvando ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3 text-[#10B981]" />}
            </button>
            <button type="button" onClick={() => setEditandoValor(false)} aria-label="Cancelar">
              <X className="h-3 w-3 text-[var(--color-text-secondary)]" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setValorTxt(deal.value ? String(deal.value).replace('.', ',') : '');
              setEditandoValor(true);
            }}
            className="group inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-secondary)]"
          >
            {brl(Number(deal.value) || 0)}
            <Pencil className="h-2.5 w-2.5 opacity-0 transition group-hover:opacity-70" />
          </button>
        )}
      </div>

      {stages.length > 0 && (
        <div className="flex items-center gap-1.5">
          <span className="text-[0.65rem] uppercase tracking-wide text-[var(--color-text-secondary)]">Etapa</span>
          <select
            value={deal.stage_id ?? ''}
            onChange={(e) => void mudarEtapa(e.target.value)}
            className="rounded border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-1.5 py-0.5 text-xs text-[var(--color-text-primary)]"
          >
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
