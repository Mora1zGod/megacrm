import { Copy } from 'lucide-react';
import { toast } from 'sonner';

// Tipos e utilitários da Central de Recadastramento (tela /recadastramentos).
// Banco: 20261111200000_recadastramento.sql · 20261112170000_recad_conferido.sql · 20261113090000_recad_central.sql

export const BUCKET = 'whatsapp-hub-recadastro';

export type Status = 'enviando' | 'novo' | 'em_analise' | 'pendente' | 'conferido' | 'lancado' | 'recusado';
export interface Submission {
  id: string; protocol: number; status: Status; plan: 'amai10' | 'infinity' | 'nao_sei'; people_count: number | null;
  passport_number: string | null; holder_name: string; holder_cpf: string; holder_birth: string | null; holder_email: string | null;
  holder_phone: string | null; portal_access: 'email' | 'whatsapp'; contact_id: string | null; team_notes: string | null;
  reviewed_at: string | null; completed_at: string | null; created_at: string;
  checked_at: string | null; launched_at: string | null;
}
export const SUB_COLS = 'id, protocol, status, plan, people_count, passport_number, holder_name, holder_cpf, holder_birth, holder_email, holder_phone, portal_access, contact_id, team_notes, reviewed_at, completed_at, created_at, checked_at, launched_at';

export interface PersonRow { id: string; position: number; name: string; birth_date: string; relationship: string; relationship_other: string | null; cpf: string | null; email: string | null }
export interface FileRow { id: string; person_id: string | null; kind: 'passaporte' | 'documento' | 'certidao_casamento'; path: string; mime: string; url: string | null }
export interface Issue {
  id: string; submission_id: string; text: string; status: 'aberta' | 'resolvida';
  created_by: string | null; created_at: string; resolved_by: string | null; resolved_at: string | null; deleted_at: string | null;
}
export interface Note { id: string; submission_id: string; text: string; created_by: string | null; created_at: string }
export interface EventRow { id: number; kind: string; actor: string | null; at: string; meta: Record<string, unknown> }

export const STATUS: Record<Status, { label: string; cls: string }> = {
  enviando: { label: 'Incompleto', cls: 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]' },
  novo: { label: 'Novo', cls: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' },
  em_analise: { label: 'Em análise', cls: 'bg-[rgba(245,158,11,0.14)] text-[#b45309] dark:text-[#fbbf24]' },
  pendente: { label: 'Aguardando associado', cls: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]' },
  conferido: { label: 'Pronto para lançar', cls: 'bg-[rgba(14,165,233,0.14)] text-[#0369a1] dark:text-[#38bdf8]' },
  lancado: { label: 'Lançado no Pocket', cls: 'bg-[rgba(34,197,94,0.14)] text-[var(--color-success)]' },
  recusado: { label: 'Recusado', cls: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]' },
};
export const PLAN: Record<string, string> = { amai10: 'AMAI 10', infinity: 'AMAI INFINITY', nao_sei: 'Não sabe' };
const REL: Record<string, string> = { pai: 'Pai', mae: 'Mãe', sogro: 'Sogro', sogra: 'Sogra', conjuge: 'Cônjuge', filho: 'Filho(a)', outro: 'Outro' };

export const fmtCpf = (c: string | null) => (c && c.length === 11 ? `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` : c ?? '');
export const fmtDate = (d: string | null) => (d ? d.slice(0, 10).split('-').reverse().join('/') : '');
export const fmtDateTime = (d: string | null) => (d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '');
export const relLabel = (p: PersonRow) => (p.relationship === 'outro' ? `Outro: ${p.relationship_other ?? ''}` : REL[p.relationship] ?? p.relationship);

export async function copy(text: string, what = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast.success(what); } catch { toast.error('Não foi possível copiar.'); }
}

// WhatsApp do Brasil para o wa.me: só dígitos, sem zero da operadora, com 55. Devolve null se não der um número válido.
export function waNumber(raw: string | null | undefined): string | null {
  let d = (raw ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

const firstName = (name: string) => {
  const f = name.trim().split(/\s+/)[0] ?? '';
  return f ? f.charAt(0).toUpperCase() + f.slice(1).toLowerCase() : '';
};

// Mensagem padrão: SÓ as pendências abertas. Nada de observação interna, CPF, documento, "associado regular",
// "passaporte validado" ou "acesso liberado" — a conferência ainda não terminou.
export function buildWhatsMessage(sub: Pick<Submission, 'holder_name' | 'protocol'>, open: Pick<Issue, 'text'>[]): string {
  const nome = firstName(sub.holder_name);
  let m = `Olá${nome ? `, ${nome}` : ''}! Tudo bem? Aqui é da equipe AMAI Park.\n\nEstamos conferindo a sua solicitação de atualização cadastral (protocolo #${sub.protocol}).`;
  if (open.length) {
    m += '\n\nPara prosseguirmos, precisamos que você regularize:\n\n' + open.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
    m += '\n\nVocê pode enviar as informações ou documentos por esta conversa. Após o recebimento, nossa equipe fará a conferência.';
  } else {
    m += '\n\nEntramos em contato para dar continuidade à conferência do seu cadastro.';
  }
  return `${m}\n\nObrigado!`;
}

export function CopyField({ label, value, field, wide }: { label: string; value: string; field: string; wide?: boolean }) {
  return (
    <div className={wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <div className="text-[11px] font-medium text-[var(--color-text-muted)]">{label}</div>
      <div className="flex items-center gap-1 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-[var(--color-bg-primary)] px-2 py-1.5">
        <span data-pocket={field} className="min-w-0 flex-1 truncate text-sm text-[var(--color-text-primary)]" title={value}>{value || '—'}</span>
        {value && (
          <button type="button" aria-label={`Copiar ${label}`} title="Copiar" onClick={() => void copy(value, `${label} copiado`)}
            className="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--accent-primary)]">
            <Copy className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function StatusChip({ status }: { status: Status }) {
  return <span className={`shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS[status].cls}`}>{STATUS[status].label}</span>;
}

// Rótulo de evento do histórico
export function eventText(e: EventRow): string {
  const t = typeof e.meta?.texto === 'string' ? `: ${e.meta.texto}` : '';
  switch (e.kind) {
    case 'pendencia_criada': return `Pendência criada${t}`;
    case 'pendencia_resolvida': return `Pendência resolvida${t}`;
    case 'pendencia_reaberta': return `Pendência reaberta${t}`;
    case 'pendencia_excluida': return `Pendência excluída${t}`;
    case 'observacao': return 'Observação registrada';
    case 'telefone': return 'WhatsApp do titular corrigido';
    case 'whatsapp_aberto': {
      const n = Number(e.meta?.pendencias ?? 0);
      return `Conversa do WhatsApp aberta para revisão${n ? ` (mensagem com ${n} pendência${n > 1 ? 's' : ''})` : ''}`;
    }
    case 'status': {
      const de = STATUS[e.meta?.de as Status]?.label ?? String(e.meta?.de ?? '');
      const para = STATUS[e.meta?.para as Status]?.label ?? String(e.meta?.para ?? '');
      return `Status: ${de} → ${para}`;
    }
    default: return e.kind;
  }
}
