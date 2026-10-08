import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { fmtDateTime, friendlyError } from './data';

interface AuditRow {
  id: number; table_name: string; record_id: string | null; action: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; actor_id: string | null; created_at: string;
}

const TABLE_LABEL: Record<string, string> = {
  fin_companies: 'Empresa', fin_accounts: 'Banco/caixa', fin_chart_accounts: 'Plano de contas', fin_cost_centers: 'Centro de custo',
  fin_parties: 'Pessoa', fin_entries: 'Lançamento', fin_installments: 'Parcela', fin_settlements: 'Baixa', fin_transfers: 'Transferência',
  fin_period_locks: 'Fechamento', fin_entry_attachments: 'Anexo', fin_charges: 'Cobrança',
};

const FIELD_LABEL: Record<string, string> = {
  name: 'nome', description: 'descrição', status: 'status', company_id: 'empresa', party_id: 'pessoa', chart_account_id: 'plano de contas',
  cost_center_id: 'centro de custo', competence_date: 'competência', issue_date: 'emissão', due_date: 'vencimento', notes: 'observações',
  is_active: 'ativo', is_default: 'padrão', cancel_reason: 'motivo', closed_until: 'fechado até', last_reason: 'motivo',
  reversed_at: 'estornado em', reverse_reason: 'motivo do estorno', opening_balance_cents: 'saldo inicial', cnpj: 'CNPJ', doc: 'CPF/CNPJ',
};

const IGNORE = new Set(['updated_at', 'created_at', 'org_id', 'id']);

function show(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (k.endsWith('_cents')) return formatBRL(Number(v));
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  return String(v).slice(0, 80);
}

// Histórico (trilha de auditoria): o que mudou, antes → depois, quem e quando.
export function AuditList({ recordIds, tables }: { recordIds?: string[]; tables?: string[] }) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const key = (recordIds ?? []).join(',') + '|' + (tables ?? []).join(',');

  useEffect(() => {
    let cancel = false;
    (async () => {
      const sb = getSupabase();
      let q = sb.from('fin_audit_log').select('*').order('created_at', { ascending: false }).limit(300);
      if (recordIds?.length) q = q.in('record_id', recordIds);
      if (tables?.length) q = q.in('table_name', tables);
      const [{ data, error: err }, ops] = await Promise.all([q, sb.rpc('list_operators')]);
      if (cancel) return;
      if (err) setError(friendlyError(err));
      setRows((data ?? []) as AuditRow[]);
      const m = new Map<string, string>();
      for (const o of (ops.data ?? []) as Array<{ user_id: string; display_name: string | null; email: string }>) m.set(o.user_id, o.display_name || o.email);
      setNames(m);
    })();
    return () => { cancel = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!rows) return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>;
  if (error) return <p className="text-sm text-[var(--color-error)]">{error}</p>;
  if (rows.length === 0) return <p className="text-sm text-[var(--color-text-muted)]">Sem registros no histórico.</p>;

  return (
    <ol className="space-y-2">
      {rows.map((r) => {
        const changes = r.action === 'UPDATE' && r.before && r.after
          ? Object.keys(r.after).filter((k) => !IGNORE.has(k) && JSON.stringify(r.before![k]) !== JSON.stringify(r.after![k]))
          : [];
        const what = TABLE_LABEL[r.table_name] ?? r.table_name;
        const title = r.action === 'INSERT' ? `${what} criado(a)` : r.action === 'DELETE' ? `${what} excluído(a)` : `${what} alterado(a)`;
        const label = (r.after?.description ?? r.after?.name ?? r.before?.name ?? '') as string;
        return (
          <li key={r.id} className="rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-[var(--color-text-primary)]">{title}{label ? ` · ${String(label).slice(0, 60)}` : ''}</span>
              <span className="text-xs text-[var(--color-text-muted)]">{fmtDateTime(r.created_at)} · {r.actor_id ? names.get(r.actor_id) ?? 'usuário' : 'sistema'}</span>
            </div>
            {r.action === 'INSERT' && r.after && 'amount_cents' in r.after && (
              <div className="text-xs text-[var(--color-text-secondary)]">Valor: {formatBRL(Number(r.after.amount_cents))}</div>
            )}
            {changes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-[var(--color-text-secondary)]">
                {changes.slice(0, 8).map((k) => (
                  <li key={k}><span className="font-medium">{FIELD_LABEL[k] ?? k}:</span> {show(k, r.before![k])} → <span className="text-[var(--color-text-primary)]">{show(k, r.after![k])}</span></li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
