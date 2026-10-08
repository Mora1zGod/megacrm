import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  BarChart3, Building2, CalendarDays, CircleDollarSign, Droplet, FileText, FlaskConical, Layers, List, Loader2, MessageSquare, Network,
  Paperclip, PartyPopper, Plus, RotateCcw, Send, Star, Bus, Handshake, UserRound, Users, Wifi, Wrench, X, Zap, type LucideIcon,
} from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { maskMoneyInput } from '@/lib/money';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { formatBRL, splitInstallments } from '@/lib/money';
import { addMonths, chartAllowed, friendlyError, rpc, todaySP, type Entry, type EntryKind, type Lookups } from './data';
import { ChartPicker, inputCls } from './ui';
import { formatDoc } from '@/lib/format';
import { SearchSelect } from '@/components/ui/SearchSelect';
import { SupplierFormDialog } from '../purchases/SupplierForm';

const SUGGESTIONS: Record<EntryKind, Array<{ label: string; description: string; code: string; icon: LucideIcon }>> = {
  payable: [
    { label: 'Energia', description: 'Conta de energia elétrica', code: '3.4.1', icon: Zap },
    { label: 'Água', description: 'Conta de água', code: '3.4.2', icon: Droplet },
    { label: 'Internet', description: 'Internet e telefonia', code: '4.2.2', icon: Wifi },
    { label: 'Químicos', description: 'Produtos químicos da piscina', code: '3.2.2', icon: FlaskConical },
    { label: 'Manutenção', description: 'Manutenção de brinquedos', code: '5.3', icon: Wrench },
    { label: 'Tráfego pago', description: 'Anúncios / tráfego pago', code: '6.1', icon: BarChart3 },
  ],
  receivable: [
    { label: 'Evento', description: 'Evento / aniversário', code: '1.3.5', icon: PartyPopper },
    { label: 'Excursão', description: 'Excursão / escola', code: '1.3.6', icon: Bus },
    { label: 'Área VIP', description: 'Locação de área VIP / bangalô', code: '1.3.4', icon: Star },
    { label: 'Patrocínio', description: 'Patrocínio', code: '1.4.3', icon: Handshake },
  ],
};

// Lançamento novo ou edição do cabeçalho (valor e parcelas não mudam na edição).
export function EntryFormDialog({ kind, lookups, entry, hasSettlement, onClose, onSaved }: {
  kind: EntryKind;
  lookups: Lookups;
  entry?: Entry | null;
  hasSettlement?: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { orgId } = useAppUser();
  const editing = Boolean(entry);
  const today = todaySP();
  const defaultCompany = lookups.companies.find((c) => c.is_default && c.is_active) ?? lookups.companies.find((c) => c.is_active);
  const [companyId, setCompanyId] = useState(entry?.company_id ?? defaultCompany?.id ?? '');
  const [description, setDescription] = useState(entry?.description ?? '');
  const [partyId, setPartyId] = useState(entry?.party_id ?? '');
  const [chartId, setChartId] = useState(entry?.chart_account_id ?? '');
  const [ccId, setCcId] = useState(entry?.cost_center_id ?? '');
  const [total, setTotal] = useState(entry?.total_cents ?? 0);
  const [issue, setIssue] = useState(entry?.issue_date ?? today);
  const [competence, setCompetence] = useState(entry?.competence_date ?? today);
  const [due, setDue] = useState(today);
  const [installments, setInstallments] = useState(entry?.installments_count ?? 1);
  const [notes, setNotes] = useState(entry?.notes ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [newParty, setNewParty] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = (list: FileList | null) => {
    const ok: File[] = [];
    for (const f of Array.from(list ?? [])) {
      if (f.size > MAX_FILE) toast.error(`${f.name} passa de 10 MB.`);
      else ok.push(f);
    }
    setFiles([...files, ...ok].slice(0, 10));
    if (fileRef.current) fileRef.current.value = '';
  };

  const parties = lookups.parties.filter((p) => p.is_active && (p.kind === 'both' || p.kind === (kind === 'payable' ? 'supplier' : 'customer') || p.id === partyId));
  // Parcelas sempre à vista. O usuário pode mudar a data/valor de cada uma (ex.: antecipar a 1ª).
  const auto = () => splitInstallments(total, installments).map((v, i) => ({ due: addMonths(due, i), cents: v }));
  const [sched, setSched] = useState<Array<{ due: string; cents: number }>>([]);
  const [customSched, setCustomSched] = useState(false);
  useEffect(() => { if (!customSched) setSched(auto()); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [total, installments, due, customSched]);
  const schedSum = sched.reduce((a, x) => a + x.cents, 0);
  const editSched = (i: number, patch: Partial<{ due: string; cents: number }>) => { setCustomSched(true); setSched(sched.map((x, j) => (j === i ? { ...x, ...patch } : x))); };

  const applySuggestion = (s: { description: string; code: string }) => {
    setDescription(s.description);
    const acc = lookups.chart.find((c) => c.code === s.code && chartAllowed(c, kind));
    if (acc) setChartId(acc.id);
    else toast.info('Descrição preenchida. Escolha a conta do plano — a conta sugerida não existe no seu plano.');
  };



  const uploadFiles = async (entryId: string) => {
    if (!files.length || !orgId) return;
    const sb = getSupabase();
    for (const f of files) {
      const safe = f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80);
      const path = `${orgId}/${entryId}/${Date.now()}-${safe}`;
      const up = await sb.storage.from('whatsapp-hub-finance').upload(path, f, { contentType: f.type || undefined });
      if (up.error) { toast.error(`Anexo ${f.name} não foi enviado`, { description: friendlyError(up.error) }); continue; }
      const { error } = await sb.from('fin_entry_attachments').insert({ entry_id: entryId, file_path: path, file_name: f.name, size_bytes: f.size });
      if (error) toast.error(`Anexo ${f.name} não foi registrado`, { description: friendlyError(error) });
    }
  };

  const save = async () => {
    if (!companyId) { toast.error('Escolha a empresa.'); return; }
    if (description.trim().length < 2) { toast.error('Informe a descrição.'); return; }
    if (!chartId) { toast.error('Escolha a conta do plano de contas.'); return; }
    if (!editing && total <= 0) { toast.error('Informe o valor total.'); return; }
    if (!editing && !due) { toast.error('Informe o 1º vencimento.'); return; }
    if (!editing && customSched) {
      if (sched.some((x) => !x.due || x.cents <= 0)) { toast.error('Cada parcela precisa de data e valor.'); return; }
      if (schedSum !== total) { toast.error(`A soma das parcelas (${formatBRL(schedSum)}) é diferente do total (${formatBRL(total)}).`); return; }
    }
    setSaving(true);
    try {
      let id = entry?.id ?? '';
      if (editing) {
        await rpc('fin_update_entry', {
          p_id: entry!.id,
          p: {
            company_id: companyId, description: description.trim(), party_id: partyId || '', chart_account_id: chartId,
            cost_center_id: ccId || '', issue_date: issue, competence_date: competence, notes,
          },
        });
      } else {
        const p = {
          kind, company_id: companyId, description: description.trim(), party_id: partyId || null, chart_account_id: chartId,
          cost_center_id: ccId || null, total_cents: total, issue_date: issue, competence_date: competence,
          due_date: due, installments, notes: notes.trim() || null,
        };
        id = customSched
          ? await rpc<string>('fin_create_entry_schedule', { p: { ...p, schedule: sched.map((x) => ({ due_date: x.due, amount_cents: x.cents })) } })
          : await rpc<string>('fin_create_entry', { p });
      }
      await uploadFiles(id);
      toast.success(editing ? 'Lançamento atualizado.' : kind === 'payable' ? 'Conta a pagar lançada.' : 'Conta a receber lançada.');
      onSaved(id);
    } catch (e) {
      toast.error('Não foi possível salvar', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const payable = kind === 'payable';
  const title = editing ? 'Editar lançamento' : payable ? 'Nova conta a pagar' : 'Nova conta a receber';
  const subtitle = editing ? 'Só o cabeçalho muda. Valor e parcelas ficam como foram lançados.'
    : payable ? 'Registre uma nova despesa para manter seu financeiro em dia.' : 'Registre um novo recebimento para manter seu financeiro em dia.';
  const who = payable ? 'fornecedor' : 'cliente';
  const dateCls = cn(inputCls, 'pl-10');

  return (
    <Dialog open onClose={onClose} widthClass="max-w-4xl" opaque>
      <div className="-mx-6 -mt-6 flex items-center gap-4 px-6 pb-4 pt-6 pr-16">
        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]">
          <FileText className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <h2 className="text-2xl font-bold text-display">{title}</h2>
          <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{subtitle}</p>
        </div>
      </div>

      <div className="max-h-[65vh] space-y-4 overflow-y-auto px-0.5 pb-1">
        {!editing && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)]"><Zap className="h-4 w-4 text-[var(--accent-primary)]" /> Sugestões rápidas:</span>
            {SUGGESTIONS[kind].map((s) => (
              <button key={s.label} type="button" onClick={() => applySuggestion(s)}
                className="flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-sm font-medium text-[var(--color-text-primary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
                <s.icon className="h-4 w-4 text-[var(--accent-primary)]" /> {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <F icon={Building2} label="Empresa" required htmlFor="ef-company" hint={editing && hasSettlement ? 'Já houve baixa: a empresa não muda.' : undefined}>
            <WithIcon icon={Building2}>
              <select id="ef-company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className={cn(inputCls, 'h-11 pl-10')}>
                {lookups.companies.filter((c) => editing || c.is_active).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.is_default ? ' (padrão)' : ''}{c.is_active ? '' : ' — inativa'}</option>
                ))}
              </select>
            </WithIcon>
          </F>
          <F icon={Users} label={payable ? 'Fornecedor' : 'Cliente'} htmlFor="ef-party">
            <div className="flex gap-2">
              <SearchSelect id="ef-party" value={partyId} onChange={setPartyId} emptyLabel={`— sem ${who} —`} placeholder={`Selecione o ${who}`}
                icon={<UserRound />} searchPlaceholder="Pesquisar nome ou CNPJ/CPF…" className="min-w-0 flex-1 [&>button]:h-11"
                options={parties.map((p) => ({ value: p.id, label: p.name, hint: p.doc ? `${formatDoc(p.doc)} ${p.doc}` : undefined }))} />
              <Button type="button" variant="outline" className="h-11 w-11 shrink-0 p-0 text-[var(--accent-primary)]" onClick={() => setNewParty(true)} title={`Cadastrar ${who}`} aria-label={`Cadastrar ${who}`}>
                <Plus className="h-5 w-5" />
              </Button>
            </div>
          </F>
        </div>

        <F icon={FileText} label="Descrição" required htmlFor="ef-desc">
          <WithIcon icon={FileText}>
            <input id="ef-desc" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 200))} className={cn(inputCls, 'h-11 pl-10')}
              placeholder={payable ? 'Ex.: Conta de energia de outubro' : 'Ex.: Evento de aniversário — família Souza'} />
          </WithIcon>
        </F>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <F icon={List} label="Plano de contas" required htmlFor="ef-chart" hint={payable ? 'Selecione a categoria da despesa. Apenas despesas e deduções.' : 'Selecione a categoria da receita. Apenas receitas.'}>
            <div className="[&_button#ef-chart]:h-11"><ChartPicker id="ef-chart" chart={lookups.chart} kind={kind} value={chartId} onChange={setChartId} icon={<List />} /></div>
          </F>
          <F icon={Network} label="Centro de custo (opcional)" htmlFor="ef-cc" hint="Apenas se quiser ratear por um centro de custo específico.">
            <WithIcon icon={Network}>
              <select id="ef-cc" value={ccId} onChange={(e) => setCcId(e.target.value)} className={cn(inputCls, 'h-11 pl-10', !ccId && 'text-[var(--color-text-muted)]')}>
                <option value="">Selecione o centro de custo</option>
                {lookups.costCenters.filter((c) => c.is_active || c.id === ccId).map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>)}
              </select>
            </WithIcon>
          </F>
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <F icon={CircleDollarSign} label="Valor total" required htmlFor="ef-total">
            <div className={cn('flex h-11 overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] focus-within:border-[var(--accent-primary)]', editing && 'opacity-60')}>
              <span className="flex items-center border-r border-[var(--color-border-card)] bg-[var(--color-surface-hover)] px-3 text-sm font-semibold text-[var(--color-text-primary)]">R$</span>
              <input id="ef-total" inputMode="numeric" disabled={editing} value={total ? formatBRL(total).replace('R$ ', '') : ''}
                onChange={(e) => setTotal(maskMoneyInput(e.target.value).cents)} placeholder="0,00"
                className="no-focus-ring min-w-0 flex-1 bg-transparent px-3 text-sm tabular-nums text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]" />
            </div>
          </F>
          <F icon={CalendarDays} label="Emissão" htmlFor="ef-issue">
            <WithIcon icon={CalendarDays}><input id="ef-issue" type="date" value={issue} onChange={(e) => setIssue(e.target.value)} className={cn(dateCls, 'h-11')} /></WithIcon>
          </F>
          <F icon={CalendarDays} label="Competência" htmlFor="ef-comp" hint={`Mês em que a ${payable ? 'despesa' : 'receita'} conta no DRE.`}>
            <WithIcon icon={CalendarDays}><input id="ef-comp" type="date" value={competence} onChange={(e) => setCompetence(e.target.value)} className={cn(dateCls, 'h-11')} /></WithIcon>
          </F>
          {!editing && (
            <F icon={CalendarDays} label="1º vencimento" required htmlFor="ef-due">
              <WithIcon icon={CalendarDays}><input id="ef-due" type="date" value={due} onChange={(e) => { setDue(e.target.value); setCustomSched(false); }} className={cn(dateCls, 'h-11')} /></WithIcon>
            </F>
          )}
        </div>

        {!editing && (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_3fr]">
            <F icon={Layers} label="Parcelas" htmlFor="ef-inst">
              <select id="ef-inst" value={installments} onChange={(e) => { setInstallments(Number(e.target.value)); setCustomSched(false); }} className={cn(inputCls, 'h-11')}>
                {Array.from({ length: 36 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}x{n === 1 ? ' (à vista)' : ''}</option>)}
              </select>
            </F>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-[var(--color-text-primary)]">Vencimentos</span>
                {customSched && (
                  <button type="button" onClick={() => setCustomSched(false)} className="flex items-center gap-1 text-xs font-medium text-[var(--accent-primary)] hover:underline">
                    <RotateCcw className="h-3 w-3" /> Recalcular
                  </button>
                )}
              </div>
              {total <= 0 ? (
                <div className="flex h-11 items-center rounded-[var(--radius-control)] border border-dashed border-[var(--color-border-card)] px-3 text-xs text-[var(--color-text-muted)]">
                  Informe o valor total para ver as parcelas.
                </div>
              ) : (
                <div className="overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-card)]">
                  <div className="max-h-56 overflow-y-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 bg-[var(--color-surface-hover)] text-xs text-[var(--color-text-secondary)]">
                        <tr><th className="w-16 px-3 py-1.5 text-left font-semibold">Parcela</th><th className="px-2 py-1.5 text-left font-semibold">Vencimento</th><th className="px-3 py-1.5 text-right font-semibold">Valor</th></tr>
                      </thead>
                      <tbody>
                        {sched.map((x, i) => (
                          <tr key={i} className="border-t border-[var(--color-border-soft)]">
                            <td className="px-3 py-1 tabular-nums text-[var(--color-text-secondary)]">{i + 1}/{sched.length}</td>
                            <td className="px-2 py-1">
                              <input type="date" aria-label={`Vencimento da parcela ${i + 1}`} value={x.due} onChange={(e) => editSched(i, { due: e.target.value })}
                                className={cn(inputCls, 'h-8 w-40 px-2')} />
                            </td>
                            <td className="px-3 py-1 text-right">
                              <input inputMode="numeric" aria-label={`Valor da parcela ${i + 1}`} value={x.cents ? formatBRL(x.cents).replace('R$ ', '') : ''}
                                onChange={(e) => editSched(i, { cents: maskMoneyInput(e.target.value).cents })}
                                className={cn(inputCls, 'ml-auto h-8 w-32 px-2 text-right tabular-nums')} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className={cn('flex justify-between border-t border-[var(--color-border-soft)] px-3 py-1.5 text-xs',
                    schedSum === total ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-error)]')}>
                    <span>{customSched ? 'Parcelas ajustadas à mão' : 'Mesmo dia nos meses seguintes'}</span>
                    <span className="tabular-nums">Soma {formatBRL(schedSum)}{schedSum !== total && ` · diferença ${formatBRL(total - schedSum)}`}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <F icon={MessageSquare} label="Observações (opcional)" htmlFor="ef-notes">
          <textarea id="ef-notes" value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} rows={3}
            placeholder={`Adicione informações complementares sobre esta conta…`} className={cn(inputCls, 'h-auto resize-y py-2.5')} />
          <div className="mt-1 text-right text-xs text-[var(--color-text-muted)]">{notes.length}/500</div>
        </F>

        <div>
          <input ref={fileRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.xls,.xlsx,.csv,application/pdf,image/jpeg,image/png" className="hidden" onChange={(e) => addFiles(e.target.files)} />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" className="h-11 px-4" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /> Anexar arquivo</Button>
            <span className="text-xs text-[var(--color-text-muted)]">PDF, JPG, PNG ou Excel (máx. 10 MB)</span>
          </div>
          {files.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2 text-xs">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-1.5 rounded-full border border-[var(--color-border-card)] px-2.5 py-1 text-[var(--color-text-secondary)]">
                  <Paperclip className="h-3 w-3" /> {f.name}
                  <button type="button" aria-label={`Remover ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><X className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="-mx-6 -mb-6 mt-4 flex justify-end gap-3 border-t border-[var(--color-border-soft)] bg-[var(--color-bg-primary)] px-6 py-4">
        <Button variant="outline" className="h-11 px-6" onClick={onClose}>Cancelar</Button>
        <Button className="h-11 px-6" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} {editing ? 'Salvar alterações' : 'Lançar'}</Button>
      </div>
      {newParty && <SupplierFormDialog defaultKind={payable ? 'supplier' : 'customer'} onClose={() => setNewParty(false)}
        onSaved={async (id) => { setNewParty(false); await lookups.reload(); setPartyId(id); }} />}
    </Dialog>
  );
}

const MAX_FILE = 10 * 1024 * 1024;

// Rótulo com ícone (padrão da tela).
function F({ icon: Icon, label, required, htmlFor, hint, children }: { icon: LucideIcon; label: string; required?: boolean; htmlFor?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="mb-1.5 flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]">
        <Icon className="h-4 w-4 text-[var(--color-text-secondary)]" />{label}{required && <span className="text-[var(--color-error)]" aria-label="obrigatório">*</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

function WithIcon({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="relative">
      <Icon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
      {children}
    </div>
  );
}
