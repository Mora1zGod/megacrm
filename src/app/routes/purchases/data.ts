import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { friendlyError, type ChartAccount, type Company, type CostCenter } from '../finance/data';

export { rpc, fmtDate, fmtDateTime, todaySP, addDays, monthStart, monthEnd, friendlyError, partyDisplay, upperBR } from '../finance/data';

// ---------------------------------------------------------------- tipos
export type ReqStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'returned' | 'quoting' | 'ordered' | 'done' | 'canceled';
export type QuoteStatus = 'open' | 'pending_approval' | 'approved' | 'ordered' | 'canceled';
export type OrderStatus = 'draft' | 'issued' | 'partial' | 'received' | 'canceled';
export type ReceiptStatus = 'draft' | 'done' | 'reversed' | 'canceled';
export type InvoiceStatus = 'summary' | 'pending' | 'posted' | 'ignored' | 'canceled_sefaz';

export interface Supplier {
  id: string; kind: 'supplier' | 'customer' | 'both'; name: string; doc: string | null; email: string | null; phone: string | null;
  is_active: boolean; trade_name: string | null; state_registration: string | null; municipal_registration: string | null;
  category: string | null; contact_name: string | null; whatsapp: string | null; website: string | null;
  zip_code: string | null; street: string | null; street_number: string | null; complement: string | null; district: string | null;
  city: string | null; state: string | null; bank_name: string | null; bank_agency: string | null; bank_account: string | null;
  pix_key: string | null; payment_terms: string | null; default_chart_account_id: string | null; notes: string | null;
  created_at: string;
  legal_status?: string | null; legal_status_date?: string | null; founded_on?: string | null; main_activity?: string | null;
  company_size?: string | null; legal_nature?: string | null; simples_nacional?: boolean | null; mei?: boolean | null;
  share_capital_cents?: number | null; headquarters?: string | null; cnpj_data?: CnpjData | null; cnpj_checked_at?: string | null;
  // pur_suppliers_v
  invoices_count?: number; invoices_12m_cents?: number; last_invoice_date?: string | null;
  open_orders_count?: number; open_orders_cents?: number; last_order_at?: string | null;
  open_payable_cents?: number; overdue_cents?: number;
}
export interface InvItem { id: string; code: string | null; name: string; unit: string; requires_lot: boolean; ncm: string | null; gtin: string | null; chart_account_id: string | null; last_cost_cents: number | null; is_active: boolean }
export interface InvLocation { id: string; company_id: string | null; name: string; is_active: boolean }
export interface Role { id: string; name: string }
export interface Team { id: string; name: string }

export interface Requisition {
  id: string; number: string | null; company_id: string | null; company_name: string | null; team_id: string | null; team_name: string | null;
  cost_center_id: string | null; cost_center_name: string | null; justification: string | null; urgency: 'low' | 'normal' | 'high' | 'urgent';
  needed_by: string | null; status: ReqStatus; approved_limit_cents: number | null; submitted_at: string | null; decided_by: string | null;
  decided_at: string | null; decision_reason: string | null; cancel_reason: string | null; requested_by: string | null; created_at: string;
  items_count: number; estimated_cents: number;
}
export interface ReqItem { id: string; requisition_id: string; item_id: string | null; description: string; qty: number; unit: string; est_unit_cents: number | null; ordered_qty: number; received_qty: number }
export interface Quotation { id: string; number: string; requisition_id: string; status: QuoteStatus; total_cents: number | null; approval_reason: string | null; approved_by: string | null; approved_at: string | null; cancel_reason: string | null; created_by: string | null; created_at: string }
export interface QuoteItem { id: string; quotation_id: string; requisition_item_id: string; item_id: string | null; description: string; qty: number; unit: string; winner_supplier_id: string | null; winner_justification: string | null }
export interface QuoteSupplier { id: string; quotation_id: string; party_id: string; status: 'invited' | 'responded' | 'no_response' | 'declined'; lead_time_days: number | null; freight_cents: number; payment_terms: string | null; notes: string | null }
export interface QuotePrice { id: string; quotation_supplier_id: string; quotation_item_id: string; unit_cents: number }
export interface Order {
  id: string; number: string | null; company_id: string | null; company_name: string | null; party_id: string | null; party_name: string | null; party_doc: string | null;
  quotation_id: string | null; requisition_id: string | null; status: OrderStatus; revision: number; freight_cents: number; payment_terms: string | null;
  expected_date: string | null; notes: string | null; issued_at: string | null; cancel_reason: string | null; created_at: string;
  goods_cents: number; total_cents: number; pending_lines: number; lines: number;
}
export interface OrderItem { id: string; order_id: string; item_id: string | null; description: string; qty: number; unit: string; unit_cents: number; received_qty: number; requisition_item_id: string | null }
export interface Receipt { id: string; number: string; order_id: string; status: ReceiptStatus; received_date: string; location_id: string | null; notes: string | null; done_at: string | null; reversed_at: string | null; reverse_reason: string | null; created_at: string }
export interface ReceiptItem { id: string; receipt_id: string; order_item_id: string; received_qty: number; accepted_qty: number; rejected_qty: number; lot: string | null; expiry: string | null; divergence_type: string | null; divergence_status: string | null; divergence_notes: string | null }
export interface Invoice {
  id: string; company_id: string; company_name: string | null; source: 'sefaz' | 'xml' | 'manual'; doc_type: string; number: string; series: string | null;
  access_key: string | null; party_id: string | null; party_name: string | null; supplier_doc: string | null; supplier_name: string | null;
  issue_date: string | null; entry_date: string | null; effective_date: string | null; total_cents: number; products_cents: number | null;
  freight_cents: number | null; discount_cents: number | null; other_cents: number | null; status: InvoiceStatus; manual_reason: string | null;
  xml_path: string | null; has_full_xml: boolean; sefaz_situation: string | null; manifested_at: string | null; fin_entry_id: string | null;
  fin_reconciled: boolean; fin_diff_accepted: boolean; stock_reconciled: boolean; posted_at: string | null; ignored_reason: string | null;
  canceled_reason: string | null; created_at: string; fin_total_cents: number | null; links_count: number;
}
export interface InvoiceItem { id: string; invoice_id: string; line: number; product_code: string | null; description: string; ncm: string | null; cfop: string | null; unit: string | null; qty: number; unit_cents: number; total_cents: number; gtin: string | null; item_id: string | null; conversion_factor: number; lot: string | null; expiry: string | null; location_id: string | null; stock_posted: boolean }

// ---------------------------------------------------------------- rótulos
export const REQ_STATUS: Record<ReqStatus, [string, Tone]> = {
  draft: ['Rascunho', 'muted'], submitted: ['Aguardando aprovação', 'warn'], approved: ['Aprovada', 'accent'], rejected: ['Reprovada', 'error'],
  returned: ['Devolvida p/ correção', 'warn'], quoting: ['Em cotação', 'accent'], ordered: ['Pedido emitido', 'accent'], done: ['Concluída', 'success'],
  canceled: ['Cancelada', 'muted'],
};
export const QUOTE_STATUS: Record<QuoteStatus, [string, Tone]> = {
  open: ['Aberta', 'accent'], pending_approval: ['Aguardando aprovação (alçada)', 'warn'], approved: ['Aprovada', 'success'], ordered: ['Pedido emitido', 'success'], canceled: ['Cancelada', 'muted'],
};
export const ORDER_STATUS: Record<OrderStatus, [string, Tone]> = {
  draft: ['Rascunho', 'muted'], issued: ['Emitido', 'accent'], partial: ['Recebido parcial', 'warn'], received: ['Recebido', 'success'], canceled: ['Cancelado', 'muted'],
};
export const RECEIPT_STATUS: Record<ReceiptStatus, [string, Tone]> = {
  draft: ['Em conferência', 'warn'], done: ['Concluído', 'success'], reversed: ['Estornado', 'error'], canceled: ['Cancelado', 'muted'],
};
export const INVOICE_STATUS: Record<InvoiceStatus, [string, Tone]> = {
  summary: ['Resumo SEFAZ', 'warn'], pending: ['Pendente', 'accent'], posted: ['Lançada', 'success'], ignored: ['Ignorada', 'muted'], canceled_sefaz: ['Cancelada na SEFAZ', 'error'],
};
export const URGENCY: Record<Requisition['urgency'], string> = { low: 'Baixa', normal: 'Normal', high: 'Alta', urgent: 'Urgente' };
export const DIVERGENCE: Record<string, string> = { damage: 'Avaria', wrong_item: 'Item errado', shortage: 'Falta', excess: 'Sobra', price: 'Preço diferente' };
export const DIVERGENCE_STATUS: Record<string, string> = { analysis: 'Em análise', resolved: 'Resolvida', accepted: 'Aceita', rejected: 'Recusada' };
export const DOC_TYPE: Record<string, string> = { nfe: 'NF-e', recibo: 'Recibo', boleto: 'Boleto', contrato: 'Contrato', outro: 'Outro' };
export const SOURCE: Record<string, string> = { sefaz: 'SEFAZ', xml: 'XML', manual: 'Manual' };

export type Tone = 'muted' | 'accent' | 'warn' | 'error' | 'success';

// ---------------------------------------------------------------- cadastros de apoio
export interface PurLookups {
  loading: boolean; error: string | null;
  companies: Company[]; suppliers: Supplier[]; items: InvItem[]; locations: InvLocation[];
  costCenters: CostCenter[]; chart: ChartAccount[]; teams: Team[]; roles: Role[]; people: Map<string, string>;
  reload: () => Promise<void>;
}

export function usePurLookups(): PurLookups {
  const [s, set] = useState<Omit<PurLookups, 'reload'>>({
    loading: true, error: null, companies: [], suppliers: [], items: [], locations: [], costCenters: [], chart: [], teams: [], roles: [], people: new Map(),
  });
  const reload = useCallback(async () => {
    const sb = getSupabase();
    const [c, p, i, l, cc, ch, t, r, ops] = await Promise.all([
      sb.from('fin_companies').select('*').order('is_default', { ascending: false }).order('name'),
      sb.from('fin_parties').select('*').order('name').limit(3000),
      sb.from('inv_items').select('*').order('name').limit(3000),
      sb.from('inv_locations').select('*').order('name'),
      sb.from('fin_cost_centers').select('*').order('name'),
      sb.from('fin_chart_accounts').select('*').order('code'),
      sb.from('teams').select('id, name').order('name'),
      sb.from('access_roles').select('id, name').order('name'),
      sb.rpc('list_operators'),
    ]);
    const err = c.error ?? p.error ?? i.error ?? l.error;
    const people = new Map<string, string>();
    for (const o of (ops.data ?? []) as Array<{ user_id: string; display_name: string | null; email: string }>) people.set(o.user_id, o.display_name || o.email);
    set({
      loading: false,
      error: err ? purError(err) : null,
      companies: (c.data ?? []) as Company[],
      suppliers: (p.data ?? []) as Supplier[],
      items: (i.data ?? []) as InvItem[],
      locations: (l.data ?? []) as InvLocation[],
      costCenters: (cc.data ?? []) as CostCenter[],
      chart: (ch.data ?? []) as ChartAccount[],
      teams: (t.data ?? []) as Team[],
      roles: (r.data ?? []) as Role[],
      people,
    });
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { ...s, reload };
}

export function purError(err: unknown): string {
  const raw = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err ?? '');
  if (/(relation|function) .*(pur_|inv_)|pur_\w+ does not exist/i.test(raw)) {
    return 'O módulo Compras ainda não foi instalado no banco. Peça para rodar o SQL de Compras no Supabase.';
  }
  return friendlyError(err);
}

// Chamada à rota /api/sefaz com a sessão atual.
export async function sefazApi<T = Record<string, unknown>>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Entre de novo.');
  let res: Response;
  try {
    res = await fetch('/api/sefaz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Confira a internet e tente de novo.');
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.message ?? `Erro ${res.status}`));
  return json as T;
}

export function qtyFmt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
}

export function personName(people: Map<string, string>, id: string | null | undefined): string {
  if (!id) return '—';
  return people.get(id) ?? 'usuário';
}

export interface TabProps {
  lookups: PurLookups;
  openId: string | null;
  onOpen: (kind: string, id: string) => void;
  onCloseDoc: () => void;
}

// Resposta da BrasilAPI (/api/cnpj/v1) — só os campos usados.
export interface CnpjData {
  cnpj?: string; razao_social?: string; nome_fantasia?: string; descricao_situacao_cadastral?: string; data_situacao_cadastral?: string;
  data_inicio_atividade?: string; cnae_fiscal?: number; cnae_fiscal_descricao?: string; cnaes_secundarios?: Array<{ codigo: number; descricao: string }>;
  porte?: string; descricao_porte?: string; natureza_juridica?: string; opcao_pelo_simples?: boolean | null; opcao_pelo_mei?: boolean | null;
  capital_social?: number; descricao_identificador_matriz_filial?: string; email?: string | null; ddd_telefone_1?: string; ddd_telefone_2?: string;
  cep?: string; descricao_tipo_de_logradouro?: string; logradouro?: string; numero?: string; complemento?: string; bairro?: string; municipio?: string; uf?: string;
  qsa?: Array<{ nome_socio: string; qualificacao_socio?: string; data_entrada_sociedade?: string }>;
}
