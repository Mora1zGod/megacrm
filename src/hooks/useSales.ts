import { useCallback, useEffect, useRef, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { monthRange, monthStartISO, type InstallmentDraft, type PaymentType } from '@/lib/sales';

// ============================================================================
// Vendas do mês: meta, vendido, recebido/pendente, ranking e série diária.
// A venda é um negócio GANHO (deals.status='won', won_at no mês), então
// qualquer negócio fechado no funil também conta — não só os da Nova Venda.
// Atualiza sozinho por realtime (deals, parcelas e meta).
// ============================================================================

export interface MonthSale {
  id: string;
  title: string;
  value: number;
  owner_id: string | null;
  won_at: string;
  contact_name: string | null;
}

export interface MonthRevenue {
  goal: number | null;
  sold: number;
  salesCount: number;
  received: number; // parcelas pagas com vencimento no mês
  pending: number; // parcelas pendentes com vencimento no mês
  overdue: number; // parcelas pendentes vencidas (qualquer mês)
  ranking: { owner_id: string | null; value: number; count: number }[];
  daily: { day: number; value: number }[];
  recent: MonthSale[];
}

const EMPTY: MonthRevenue = {
  goal: null, sold: 0, salesCount: 0, received: 0, pending: 0, overdue: 0, ranking: [], daily: [], recent: [],
};

interface WonRow {
  id: string;
  title: string;
  value: number | string | null;
  owner_id: string | null;
  won_at: string;
  contact: { name: string | null } | null;
}

export function useMonthRevenue(opts: { onNewSale?: (sale: MonthSale) => void } = {}) {
  const [data, setData] = useState<MonthRevenue>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef<Set<string> | null>(null);
  const onNewSaleRef = useRef(opts.onNewSale);
  onNewSaleRef.current = opts.onNewSale;

  const load = useCallback(async () => {
    const supabase = getSupabase();
    const { fromISO, toISO, fromDate, toDate } = monthRange();
    const today = new Date().toISOString().slice(0, 10);
    const [wonRes, instRes, overdueRes, goalRes] = await Promise.all([
      supabase
        .from('deals')
        .select('id, title, value, owner_id, won_at, contact:contacts(name)')
        .eq('status', 'won')
        .gte('won_at', fromISO)
        .lt('won_at', toISO)
        .order('won_at', { ascending: false }),
      supabase.from('deal_installments').select('amount, status').gte('due_date', fromDate).lte('due_date', toDate),
      supabase.from('deal_installments').select('amount').eq('status', 'pendente').lt('due_date', today),
      supabase.from('revenue_goals').select('amount').eq('month', monthStartISO()).maybeSingle(),
    ]);
    const err = wonRes.error ?? instRes.error ?? overdueRes.error ?? goalRes.error;
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const won = (wonRes.data ?? []) as unknown as WonRow[];
    const sales: MonthSale[] = won.map((d) => ({
      id: d.id,
      title: d.title,
      value: Number(d.value ?? 0),
      owner_id: d.owner_id,
      won_at: d.won_at,
      contact_name: d.contact?.name ?? null,
    }));

    const byOwner = new Map<string | null, { value: number; count: number }>();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const daily = Array.from({ length: daysInMonth }, (_, i) => ({ day: i + 1, value: 0 }));
    for (const s of sales) {
      const cur = byOwner.get(s.owner_id) ?? { value: 0, count: 0 };
      cur.value += s.value;
      cur.count += 1;
      byOwner.set(s.owner_id, cur);
      const day = new Date(s.won_at).getDate();
      daily[day - 1].value += s.value;
    }
    const inst = (instRes.data ?? []) as { amount: number | string; status: string }[];

    // Detecta venda nova (para o Painel TV): o que não estava na carga anterior.
    if (seen.current && onNewSaleRef.current) {
      for (const s of sales) if (!seen.current.has(s.id)) onNewSaleRef.current(s);
    }
    seen.current = new Set(sales.map((s) => s.id));

    setData({
      goal: goalRes.data ? Number((goalRes.data as { amount: number | string }).amount) : null,
      sold: sales.reduce((a, s) => a + s.value, 0),
      salesCount: sales.length,
      received: inst.filter((i) => i.status === 'pago').reduce((a, i) => a + Number(i.amount), 0),
      pending: inst.filter((i) => i.status !== 'pago').reduce((a, i) => a + Number(i.amount), 0),
      overdue: ((overdueRes.data ?? []) as { amount: number | string }[]).reduce((a, i) => a + Number(i.amount), 0),
      ranking: [...byOwner.entries()]
        .map(([owner_id, v]) => ({ owner_id, ...v }))
        .sort((a, b) => b.value - a.value),
      daily,
      recent: sales.slice(0, 8),
    });
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const supabase = getSupabase();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    const channel = supabase
      .channel(`month-revenue-${Math.random().toString(36).slice(2, 8)}`)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'deals' }, reload)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'deal_installments' }, reload)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'revenue_goals' }, reload)
      .subscribe();
    // Virada de mês / quedas de realtime: recarrega a cada 5 min.
    const interval = setInterval(() => void load(), 5 * 60 * 1000);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const setGoal = useCallback(async (amount: number) => {
    const supabase = getSupabase();
    const { data: u } = await supabase.auth.getUser();
    const { error: err } = await supabase
      .from('revenue_goals')
      .upsert(
        { month: monthStartISO(), amount, updated_by: u?.user?.id ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'org_id,month' },
      );
    if (err) throw new Error(err.message);
    await load();
  }, [load]);

  return { data, loading, error, reload: load, setGoal };
}

// ---------------------------------------------------------------------------
// Criação da venda
// ---------------------------------------------------------------------------

export interface QuickSaleInput {
  contactId: string;
  existingDealId: string | null; // fecha um negócio em aberto do cliente
  pipelineId: string;
  title: string;
  total: number; // valor do negócio (soma das parcelas)
  ownerId: string | null;
  products: { id: string; value: number }[];
  notes: string;
  paymentType: PaymentType;
  paymentMethod: string | null;
  schedule: InstallmentDraft[];
}

export async function createQuickSale(input: QuickSaleInput): Promise<string> {
  const supabase = getSupabase();
  const { data: u } = await supabase.auth.getUser();
  const actor = u?.user?.id ?? null;

  const { data: stageRows, error: stErr } = await supabase
    .from('stages')
    .select('id, is_won, position')
    .eq('pipeline_id', input.pipelineId)
    .order('position');
  if (stErr) throw new Error(stErr.message);
  const stages = (stageRows ?? []) as { id: string; is_won: boolean }[];
  const wonStage = stages.find((s) => s.is_won) ?? null;

  const nowISO = new Date().toISOString();
  // Mesma regra do funil: ganho → cliente Morno.
  const dealPatch = {
    title: input.title,
    value: input.total,
    pipeline_id: input.pipelineId,
    stage_id: wonStage?.id ?? stages[stages.length - 1]?.id ?? null,
    status: 'won' as const,
    won_at: nowISO,
    owner_id: input.ownerId,
    lead_type: 'Cliente',
    temperature: 'Morno',
    notes: input.notes.trim() || null,
  };

  let dealId: string;
  let prevStageId: string | null = null;
  if (input.existingDealId) {
    const { data: prev } = await supabase.from('deals').select('stage_id').eq('id', input.existingDealId).maybeSingle();
    prevStageId = (prev as { stage_id: string | null } | null)?.stage_id ?? null;
    const { error } = await supabase.from('deals').update(dealPatch).eq('id', input.existingDealId);
    if (error) throw new Error(error.message);
    dealId = input.existingDealId;
  } else {
    const { data, error } = await supabase
      .from('deals')
      .insert({ ...dealPatch, contact_id: input.contactId })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    dealId = (data as { id: string }).id;
  }

  if (input.products.length) {
    const { error } = await supabase.from('deal_products').upsert(
      input.products.map((p) => ({ deal_id: dealId, product_id: p.id, value: p.value, quantity: 1 })),
      { onConflict: 'deal_id,product_id' },
    );
    if (error) throw new Error(`Venda salva, mas os produtos falharam: ${error.message}`);
  }

  // Refazer a venda de um negócio existente substitui o calendário anterior.
  if (input.existingDealId) {
    await supabase.from('deal_installments').delete().eq('deal_id', dealId);
  }
  const { error: instErr } = await supabase.from('deal_installments').insert(
    input.schedule.map((r) => ({
      deal_id: dealId,
      payment_type: input.paymentType,
      number: r.number,
      total_count: r.total_count,
      due_date: r.due_date,
      amount: r.amount,
      status: r.status,
      payment_method: input.paymentMethod,
    })),
  );
  if (instErr) throw new Error(`Venda salva, mas as parcelas falharam: ${instErr.message}`);

  if (wonStage && prevStageId !== wonStage.id) {
    await supabase.from('lead_stage_history').insert({
      deal_id: dealId,
      from_stage_id: prevStageId,
      to_stage_id: wonStage.id,
      moved_by: 'humano',
      actor_id: actor,
      reason: 'Nova Venda',
    });
  }
  return dealId;
}

// Evento global para abrir a Nova Venda de qualquer tela (topo, atalhos).
export const OPEN_NEW_SALE_EVENT = 'megacrm:open-new-sale';
export function openNewSale(detail?: { contactId?: string; contactName?: string | null }) {
  window.dispatchEvent(new CustomEvent(OPEN_NEW_SALE_EVENT, { detail }));
}
