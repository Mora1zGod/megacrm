import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// ---------------------------------------------------------------- tipos
export type EntryKind = 'payable' | 'receivable';
export type InstStatus = 'open' | 'overdue' | 'partial' | 'paid' | 'canceled';
export type Nature = 'operating_revenue' | 'deduction' | 'cost' | 'operating_expense' | 'investment' | 'financial' | 'tax';

export interface Company { id: string; name: string; cnpj: string | null; is_active: boolean; is_default: boolean }
export interface Account {
  id: string; company_id: string; company_name: string; name: string; kind: 'bank' | 'cash';
  bank_name: string | null; agency: string | null; account_number: string | null;
  opening_balance_cents: number; balance_cents: number; movements_count: number; is_active: boolean;
}
export interface ChartAccount {
  id: string; parent_id: string | null; code: string; name: string; type: 'revenue' | 'expense';
  nature: Nature; is_synthetic: boolean; is_active: boolean;
}
export interface CostCenter { id: string; parent_id: string | null; code: string | null; name: string; is_active: boolean }
export interface Party {
  id: string; kind: 'supplier' | 'customer' | 'both'; name: string; doc: string | null;
  email: string | null; phone: string | null; is_active: boolean; asaas_customer_id: string | null;
  trade_name?: string | null; // nome fantasia (20261008170000_suppliers.sql)
}
export interface InstallmentRow {
  id: string; entry_id: string; number: number; due_date: string; amount_cents: number;
  kind: EntryKind; company_id: string; company_name: string; description: string;
  party_id: string | null; party_name: string | null; chart_account_id: string; chart_code: string; chart_name: string;
  cost_center_id: string | null; cost_center_name: string | null; installments_count: number;
  competence_date: string; issue_date: string; entry_status: 'active' | 'canceled'; total_cents: number;
  paid_cents: number; remaining_cents: number; last_settle_date: string | null; status: InstStatus;
  is_partial: boolean; charge_id: string | null; charge_status: string | null; charge_type: string | null; charge_url: string | null;
}
export interface Entry {
  id: string; company_id: string; kind: EntryKind; description: string; party_id: string | null;
  chart_account_id: string; cost_center_id: string | null; total_cents: number; issue_date: string;
  competence_date: string; installments_count: number; notes: string | null; status: 'active' | 'canceled';
  cancel_reason: string | null; canceled_at: string | null; source: string; source_ref: string | null; created_at: string;
}
export interface Settlement {
  id: string; installment_id: string; entry_id: string; account_id: string; settle_date: string;
  amount_cents: number; interest_cents: number; fine_cents: number; discount_cents: number; net_cents: number;
  notes: string | null; source: string; reversal_of: string | null; reversed_at: string | null; reverse_reason: string | null;
  created_at: string;
}

export const NATURE_LABEL: Record<Nature, string> = {
  operating_revenue: 'Receita operacional',
  deduction: 'Dedução',
  cost: 'Custo',
  operating_expense: 'Despesa operacional',
  investment: 'Investimento',
  financial: 'Financeira',
  tax: 'Imposto',
};

export const STATUS_LABEL: Record<InstStatus, string> = {
  open: 'Aberto', overdue: 'Vencido', partial: 'Parcial', paid: 'Pago', canceled: 'Cancelado',
};

// ---------------------------------------------------------------- datas (fuso de São Paulo)
export function todaySP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
export function monthStart(iso: string): string { return `${iso.slice(0, 7)}-01`; }
export function monthEnd(iso: string): string { return addDays(addMonths(monthStart(iso), 1), -1); }
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

// ---------------------------------------------------------------- erros para o operador
const TECH = /(row-level security|permission denied|violates|duplicate key|syntax|invalid input|null value|relation .* does not exist|function .* does not exist|schema cache|SQLSTATE|PGRST|JWT|fetch failed|Failed to fetch|NetworkError)/i;

export function friendlyError(err: unknown): string {
  const raw = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '');
  if (!raw) return 'Não foi possível concluir. Tente de novo.';
  if (/row-level security|permission denied/i.test(raw)) return 'Seu perfil não permite esta ação. Peça ao administrador para liberar.';
  if (/foreign key/i.test(raw)) return 'Este cadastro já está em uso e não pode ser excluído. Desative-o em vez de excluir.';
  if (/duplicate key|unique/i.test(raw)) {
    if (/code/i.test(raw)) return 'Já existe uma conta com esse código no plano de contas.';
    return 'Já existe um registro igual. Confira os dados.';
  }
  if (/(relation|function) .*(fin_|does not exist)|schema cache/i.test(raw)) {
    return 'O módulo Financeiro ainda não foi instalado no banco. Peça para rodar o SQL do Financeiro no Supabase.';
  }
  if (/Failed to fetch|NetworkError|fetch failed/i.test(raw)) return 'Sem conexão com o servidor. Confira a internet e tente de novo.';
  if (TECH.test(raw)) return 'Não foi possível concluir. Tente de novo; se continuar, avise o suporte.';
  return raw;
}

export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw new Error(friendlyError(error));
  return data as T;
}

// ---------------------------------------------------------------- cadastros (cache simples)
export interface Lookups {
  loading: boolean;
  error: string | null;
  companies: Company[];
  accounts: Account[];
  chart: ChartAccount[];
  costCenters: CostCenter[];
  parties: Party[];
  reload: () => Promise<void>;
}

export function useFinanceLookups(): Lookups {
  const [state, setState] = useState<Omit<Lookups, 'reload'>>({
    loading: true, error: null, companies: [], accounts: [], chart: [], costCenters: [], parties: [],
  });
  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [c, a, ch, cc, p] = await Promise.all([
      sb.from('fin_companies').select('*').order('is_default', { ascending: false }).order('name'),
      sb.from('fin_account_balances_v').select('*').order('name'),
      sb.from('fin_chart_accounts').select('*').order('code'),
      sb.from('fin_cost_centers').select('*').order('name'),
      sb.from('fin_parties').select('*').order('name').limit(2000),
    ]);
    const err = c.error ?? a.error ?? ch.error ?? cc.error ?? p.error;
    setState({
      loading: false,
      error: err ? friendlyError(err) : null,
      companies: (c.data ?? []) as Company[],
      accounts: (a.data ?? []) as Account[],
      chart: (ch.data ?? []) as ChartAccount[],
      costCenters: (cc.data ?? []) as CostCenter[],
      parties: (p.data ?? []) as Party[],
    });
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

// Contas do plano permitidas para o tipo de lançamento.
export function chartAllowed(c: ChartAccount, kind: EntryKind): boolean {
  if (c.is_synthetic || !c.is_active) return false;
  return kind === 'payable' ? c.type === 'expense' || c.nature === 'deduction' : c.type === 'revenue' && c.nature !== 'deduction';
}

// Árvore em ordem de código, com profundidade (para mostrar indentado/agrupado).
export function chartTree(chart: ChartAccount[]): Array<ChartAccount & { depth: number }> {
  const byParent = new Map<string | null, ChartAccount[]>();
  for (const c of chart) {
    const k = c.parent_id ?? null;
    byParent.set(k, [...(byParent.get(k) ?? []), c]);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.code.localeCompare(b.code, 'pt-BR', { numeric: true }));
  const out: Array<ChartAccount & { depth: number }> = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) { out.push({ ...c, depth }); walk(c.id, depth + 1); }
  };
  walk(null, 0);
  // Órfãos (pai desativado/ausente)
  for (const c of chart) if (!out.some((o) => o.id === c.id)) out.push({ ...c, depth: 0 });
  return out;
}

// Nome para listas: nome fantasia (quando houver) em MAIÚSCULAS; senão a razão social.
export function partyDisplay(p: { name?: string | null; trade_name?: string | null } | null | undefined, fallback?: string | null): string {
  return ((p?.trade_name?.trim() || p?.name || fallback || '') as string).toLocaleUpperCase('pt-BR');
}
export const upperBR = (v: string | null | undefined) => (v ?? '').toLocaleUpperCase('pt-BR');
