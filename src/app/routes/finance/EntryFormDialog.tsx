import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Paperclip, Plus, Sparkles } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { formatBRL, splitInstallments } from '@/lib/money';
import { addMonths, chartAllowed, chartTree, fmtDate, friendlyError, rpc, todaySP, type Entry, type EntryKind, type Lookups } from './data';
import { CompanySelect, Field, inputCls, MoneyInput } from './ui';

const SUGGESTIONS: Record<EntryKind, Array<{ label: string; description: string; code: string }>> = {
  payable: [
    { label: 'Energia', description: 'Conta de energia elétrica', code: '3.4.1' },
    { label: 'Água', description: 'Conta de água', code: '3.4.2' },
    { label: 'Internet', description: 'Internet e telefonia', code: '4.2.2' },
    { label: 'Químicos', description: 'Produtos químicos da piscina', code: '3.2.2' },
    { label: 'Manutenção', description: 'Manutenção de brinquedos', code: '5.3' },
    { label: 'Tráfego pago', description: 'Anúncios / tráfego pago', code: '6.1' },
  ],
  receivable: [
    { label: 'Evento', description: 'Evento / aniversário', code: '1.3.5' },
    { label: 'Excursão', description: 'Excursão / escola', code: '1.3.6' },
    { label: 'Área VIP', description: 'Locação de área VIP / bangalô', code: '1.3.4' },
    { label: 'Patrocínio', description: 'Patrocínio', code: '1.4.3' },
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
  const [newParty, setNewParty] = useState<{ name: string; doc: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const tree = useMemo(() => chartTree(lookups.chart), [lookups.chart]);
  // Agrupado igual à árvore: cada sintética vira um <optgroup> com as analíticas permitidas abaixo dela.
  const groups = useMemo(() => {
    const out: Array<{ label: string; items: typeof tree }> = [];
    let current: { label: string; items: typeof tree } | null = null;
    for (const c of tree) {
      if (c.is_synthetic) {
        current = { label: `${'  '.repeat(c.depth)}${c.code} ${c.name}`, items: [] };
        out.push(current);
      } else if (chartAllowed(c, kind) || c.id === chartId) {
        if (!current) { current = { label: 'Outras', items: [] }; out.push(current); }
        current.items.push(c);
      }
    }
    return out.filter((g) => g.items.length > 0);
  }, [tree, kind, chartId]);

  const parties = lookups.parties.filter((p) => p.is_active && (p.kind === 'both' || p.kind === (kind === 'payable' ? 'supplier' : 'customer') || p.id === partyId));
  const preview = splitInstallments(total, installments);

  const applySuggestion = (s: { description: string; code: string }) => {
    setDescription(s.description);
    const acc = lookups.chart.find((c) => c.code === s.code && chartAllowed(c, kind));
    if (acc) setChartId(acc.id);
    else toast.info('Descrição preenchida. Escolha a conta do plano — a conta sugerida não existe no seu plano.');
  };

  const createParty = async () => {
    if (!newParty || newParty.name.trim().length < 2) { toast.error('Informe o nome.'); return; }
    const doc = newParty.doc.replace(/\D/g, '');
    if (doc && doc.length !== 11 && doc.length !== 14) { toast.error('CPF deve ter 11 números e CNPJ 14.'); return; }
    const { data, error } = await getSupabase().from('fin_parties')
      .insert({ name: newParty.name.trim(), doc: doc || null, kind: kind === 'payable' ? 'supplier' : 'customer' })
      .select('id').single();
    if (error) { toast.error('Não foi possível cadastrar', { description: friendlyError(error) }); return; }
    await lookups.reload();
    setPartyId((data as { id: string }).id);
    setNewParty(null);
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
        id = await rpc<string>('fin_create_entry', {
          p: {
            kind, company_id: companyId, description: description.trim(), party_id: partyId || null, chart_account_id: chartId,
            cost_center_id: ccId || null, total_cents: total, issue_date: issue, competence_date: competence,
            due_date: due, installments, notes: notes.trim() || null,
          },
        });
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

  const title = editing ? 'Editar lançamento' : kind === 'payable' ? 'Nova conta a pagar' : 'Nova conta a receber';

  return (
    <Dialog open onClose={onClose} title={title} widthClass="max-w-3xl"
      description={editing ? 'Só o cabeçalho muda. Valor e parcelas ficam como foram lançados.' : undefined}>
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        {!editing && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="flex items-center gap-1 text-xs font-semibold text-[var(--color-text-muted)]"><Sparkles className="h-3.5 w-3.5" /> Sugestões:</span>
            {SUGGESTIONS[kind].map((s) => (
              <button key={s.label} type="button" onClick={() => applySuggestion(s)}
                className="rounded-full border border-[var(--color-border-card)] px-2.5 py-1 text-xs font-medium text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]">
                {s.label}
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Empresa" htmlFor="ef-company" hint={editing && hasSettlement ? 'Já houve baixa: a empresa não muda.' : undefined}>
            <CompanySelect id="ef-company" companies={lookups.companies} value={companyId} onChange={setCompanyId} allLabel={null} onlyActive={!editing} />
          </Field>
          <Field label={kind === 'payable' ? 'Fornecedor' : 'Cliente'} htmlFor="ef-party">
            {newParty ? (
              <div className="flex gap-1.5">
                <input autoFocus value={newParty.name} onChange={(e) => setNewParty({ ...newParty, name: e.target.value })} placeholder="Nome" className={inputCls} />
                <input value={newParty.doc} onChange={(e) => setNewParty({ ...newParty, doc: e.target.value })} placeholder="CPF/CNPJ" className={cn(inputCls, 'w-40')} />
                <Button size="sm" onClick={() => void createParty()} className="h-10">Salvar</Button>
                <Button size="sm" variant="outline" onClick={() => setNewParty(null)} className="h-10">×</Button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <select id="ef-party" value={partyId} onChange={(e) => setPartyId(e.target.value)} className={inputCls}>
                  <option value="">— sem {kind === 'payable' ? 'fornecedor' : 'cliente'} —</option>
                  {parties.map((p) => <option key={p.id} value={p.id}>{p.name}{p.doc ? ` · ${p.doc}` : ''}</option>)}
                </select>
                <Button type="button" size="sm" variant="outline" className="h-10" onClick={() => setNewParty({ name: '', doc: '' })} title="Cadastrar novo">
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            )}
          </Field>
        </div>

        <Field label="Descrição" htmlFor="ef-desc">
          <input id="ef-desc" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 200))} className={inputCls}
            placeholder={kind === 'payable' ? 'Ex.: Conta de energia de outubro' : 'Ex.: Evento de aniversário — família Souza'} />
        </Field>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Plano de contas" htmlFor="ef-chart" hint={kind === 'payable' ? 'Só despesas e deduções.' : 'Só receitas.'}>
            <select id="ef-chart" value={chartId} onChange={(e) => setChartId(e.target.value)} className={inputCls}>
              <option value="">Escolha a conta…</option>
              {groups.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.items.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          <Field label="Centro de custo (opcional)" htmlFor="ef-cc">
            <select id="ef-cc" value={ccId} onChange={(e) => setCcId(e.target.value)} className={inputCls}>
              <option value="">— sem centro de custo —</option>
              {lookups.costCenters.filter((c) => c.is_active || c.id === ccId).map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>)}
            </select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Field label="Valor total" htmlFor="ef-total">
            <MoneyInput id="ef-total" cents={total} onChange={setTotal} disabled={editing} />
          </Field>
          <Field label="Emissão" htmlFor="ef-issue">
            <input id="ef-issue" type="date" value={issue} onChange={(e) => setIssue(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Competência" htmlFor="ef-comp" hint="Mês em que a receita/despesa conta no DRE.">
            <input id="ef-comp" type="date" value={competence} onChange={(e) => setCompetence(e.target.value)} className={inputCls} />
          </Field>
          {!editing && (
            <Field label="1º vencimento" htmlFor="ef-due">
              <input id="ef-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
            </Field>
          )}
        </div>

        {!editing && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr]">
            <Field label="Parcelas" htmlFor="ef-inst">
              <select id="ef-inst" value={installments} onChange={(e) => setInstallments(Number(e.target.value))} className={inputCls}>
                <option value={1}>Única</option>
                {Array.from({ length: 35 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}x</option>)}
              </select>
            </Field>
            {installments > 1 && total > 0 && (
              <div className="rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
                <div className="mb-1 font-semibold">Parcelas</div>
                <div className="grid max-h-24 grid-cols-2 gap-x-4 gap-y-0.5 overflow-y-auto sm:grid-cols-3">
                  {preview.map((v, i) => <span key={i} className="tabular-nums">{i + 1}/{installments} · {fmtDate(addMonths(due, i))} · {formatBRL(v)}</span>)}
                </div>
              </div>
            )}
          </div>
        )}

        <Field label={`Observações (${notes.length}/500)`} htmlFor="ef-notes">
          <textarea id="ef-notes" value={notes} onChange={(e) => setNotes(e.target.value.slice(0, 500))} rows={2} className={cn(inputCls, 'h-auto py-2')} />
        </Field>

        <div>
          <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 10))} />
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Paperclip className="h-3.5 w-3.5" /> Anexar arquivo</Button>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-[var(--color-text-secondary)]">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2">
                  <Paperclip className="h-3 w-3" /> {f.name}
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="text-[var(--color-error)] hover:underline">remover</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-[var(--color-border-soft)] pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} {editing ? 'Salvar alterações' : 'Lançar'}</Button>
      </div>
    </Dialog>
  );
}
