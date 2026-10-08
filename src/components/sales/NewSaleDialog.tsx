import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Search, UserPlus, X } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import { normalizePhone } from '@/lib/phone';
import { useProducts } from '@/hooks/useProducts';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { createQuickSale } from '@/hooks/useSales';
import {
  FREQUENCY_LABEL,
  buildSchedule,
  formatBRL,
  parseMoney,
  scheduleTotal,
  splitAmount,
  todayISO,
  type Frequency,
  type PaymentType,
} from '@/lib/sales';
import type { Pipeline } from '@/types/crm';
import { formatPhone, maskPhoneInput } from '@/lib/format';

const inputCls =
  'w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const labelCls = 'mb-1 block text-xs font-medium text-[var(--color-text-secondary)]';

const PAYMENT_METHODS = ['PIX', 'Cartão de crédito', 'Cartão de débito', 'Boleto', 'Dinheiro', 'Transferência'];

interface ContactHit { id: string; name: string | null; phone: string }
interface OpenDeal { id: string; title: string; value: number | null; pipeline_id: string | null }

export function NewSaleDialog({
  open,
  onClose,
  initialContact,
}: {
  open: boolean;
  onClose: () => void;
  initialContact?: { id: string; name: string | null } | null;
}) {
  const { userId } = useAppUser();
  const { operators } = useOperators();
  const { products } = useProducts();

  // Cliente
  const [contact, setContact] = useState<ContactHit | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [newMode, setNewMode] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [openDeals, setOpenDeals] = useState<OpenDeal[]>([]);
  const [existingDealId, setExistingDealId] = useState<string>('');

  // Venda
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineId, setPipelineId] = useState('');
  const [title, setTitle] = useState('');
  const [productIds, setProductIds] = useState<string[]>([]);
  const [valueRaw, setValueRaw] = useState('');
  const [ownerId, setOwnerId] = useState<string>('');
  const [notes, setNotes] = useState('');

  // Pagamento
  const [ptype, setPtype] = useState<PaymentType>('avista');
  const [method, setMethod] = useState('PIX');
  const [firstDue, setFirstDue] = useState(todayISO());
  const [count, setCount] = useState(3);
  const [freq, setFreq] = useState<Frequency>('mensal');
  const [entryRaw, setEntryRaw] = useState('');
  const [firstPaid, setFirstPaid] = useState(true);

  const [busy, setBusy] = useState(false);

  // Reset ao abrir.
  useEffect(() => {
    if (!open) return;
    setContact(initialContact ? { id: initialContact.id, name: initialContact.name, phone: '' } : null);
    setQuery(''); setHits([]); setNewMode(false); setNewName(''); setNewPhone('');
    setExistingDealId(''); setTitle(''); setProductIds([]); setValueRaw(''); setNotes('');
    setPtype('avista'); setMethod('PIX'); setFirstDue(todayISO()); setCount(3); setFreq('mensal');
    setEntryRaw(''); setFirstPaid(true);
    setOwnerId(userId ?? '');
  }, [open, initialContact, userId]);

  useEffect(() => {
    if (!open) return;
    void getSupabase()
      .from('pipelines')
      .select('*')
      .eq('kind', 'comercial')
      .order('position')
      .then(({ data }) => {
        const list = (data ?? []) as Pipeline[];
        setPipelines(list);
        setPipelineId((cur) => cur || ((list.find((p) => p.is_default) ?? list[0])?.id ?? ''));
      });
  }, [open]);

  // Busca de cliente (debounce).
  useEffect(() => {
    if (!open || contact || newMode) return;
    const q = query.trim();
    if (q.length < 2) { setHits([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const safe = q.replace(/[%,()]/g, ' ');
      const { data } = await getSupabase()
        .from('contacts')
        .select('id, name, phone')
        .not('phone', 'like', '%@g.us')
        .or(`name.ilike.%${safe}%,phone.ilike.%${safe}%`)
        .limit(8);
      setHits((data ?? []) as ContactHit[]);
      setSearching(false);
    }, 300);
    return () => clearTimeout(t);
  }, [query, open, contact, newMode]);

  // Negócios em aberto do cliente escolhido: dá para fechar um deles.
  useEffect(() => {
    if (!contact) { setOpenDeals([]); setExistingDealId(''); return; }
    void getSupabase()
      .from('deals')
      .select('id, title, value, pipeline_id')
      .eq('contact_id', contact.id)
      .eq('status', 'open')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        const list = (data ?? []) as OpenDeal[];
        setOpenDeals(list);
        if (list.length === 1) setExistingDealId(list[0].id);
      });
  }, [contact]);

  useEffect(() => {
    const d = openDeals.find((x) => x.id === existingDealId);
    if (!d) return;
    if (d.pipeline_id) setPipelineId(d.pipeline_id);
    if (!title) setTitle(d.title);
    if (!valueRaw && d.value) setValueRaw(String(d.value).replace('.', ','));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingDealId]);

  const value = parseMoney(valueRaw);
  const entry = parseMoney(entryRaw);
  const schedule = useMemo(() => {
    if (!(value > 0)) return [];
    return buildSchedule({
      type: ptype,
      total: value,
      firstDue,
      count: ptype === 'avista' ? 1 : count,
      frequency: freq,
      entry: ptype === 'parcelado' && entry > 0 ? entry : undefined,
      firstPaid,
    });
  }, [value, ptype, firstDue, count, freq, entry, firstPaid]);
  const total = scheduleTotal(schedule);

  const entryInvalid = ptype === 'parcelado' && entry > 0 && entry >= value;
  const contactName = contact?.name || contact?.phone || '';

  const submit = async () => {
    if (busy) return;
    let c = contact;
    if (!c && newMode) {
      const ph = normalizePhone(newPhone);
      if (!newName.trim()) { toast.error('Informe o nome do cliente.'); return; }
      if (!ph.ok) { toast.error('Telefone inválido', { description: ph.error }); return; }
      setBusy(true);
      const supabase = getSupabase();
      const ins = await supabase.from('contacts').insert({ name: newName.trim(), phone: ph.e164 }).select('id, name, phone').single();
      if (ins.error) {
        // Telefone já cadastrado: usa o contato existente.
        const ex = await supabase.from('contacts').select('id, name, phone').eq('phone', ph.e164).maybeSingle();
        if (!ex.data) { setBusy(false); toast.error('Não foi possível criar o cliente', { description: ins.error.message }); return; }
        c = ex.data as ContactHit;
      } else {
        c = ins.data as ContactHit;
      }
    }
    if (!c) { toast.error('Escolha ou cadastre o cliente.'); return; }
    if (!pipelineId) { toast.error('Escolha o funil.'); setBusy(false); return; }
    if (!(value > 0)) { toast.error('Informe o valor da venda.'); setBusy(false); return; }
    if (entryInvalid) { toast.error('A entrada precisa ser menor que o total.'); setBusy(false); return; }
    if (ptype !== 'avista' && (count < 2 || count > 120)) { toast.error('Número de parcelas entre 2 e 120.'); setBusy(false); return; }

    setBusy(true);
    try {
      const productValues = productIds.length ? splitAmount(total, productIds.length) : [];
      const chosen = products.filter((p) => productIds.includes(p.id));
      const autoTitle = chosen.length ? chosen.map((p) => p.name).join(' + ') : 'Venda';
      await createQuickSale({
        contactId: c.id,
        existingDealId: existingDealId || null,
        pipelineId,
        title: title.trim() || `${autoTitle} — ${c.name || formatPhone(c.phone)}`,
        total,
        ownerId: ownerId || null,
        products: productIds.map((id, i) => ({ id, value: productValues[i] })),
        notes,
        paymentType: ptype,
        paymentMethod: method,
        schedule,
      });
      toast.success('Venda registrada! 🎉', { description: `${formatBRL(total)} — ${c.name || formatPhone(c.phone)}` });
      onClose();
    } catch (e) {
      toast.error('Não foi possível registrar a venda', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Nova venda" description="Registra a venda como negócio ganho, com o calendário de pagamento." widthClass="max-w-2xl" opaque>
      <div className="space-y-5">
        {/* Cliente */}
        <section className="space-y-2">
          <span className={labelCls}>Cliente *</span>
          {contact ? (
            <div className="flex items-center justify-between rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">{contactName}</div>
                {contact.phone && contact.name && <div className="text-xs text-[var(--color-text-muted)]">{formatPhone(contact.phone)}</div>}
              </div>
              <button type="button" onClick={() => setContact(null)} aria-label="Trocar cliente" className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : newMode ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Nome do cliente" className={inputCls} />
              <input value={newPhone} onChange={(e) => setNewPhone(maskPhoneInput(e.target.value))} placeholder="(68) 99999-9999" inputMode="tel" className={inputCls} />
              <button type="button" onClick={() => setNewMode(false)} className="text-left text-xs text-[var(--accent-primary)] hover:underline">Buscar cliente existente</button>
            </div>
          ) : (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-[var(--color-text-muted)]" />
              <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar por nome ou telefone" className={`${inputCls} pl-9`} />
              {(hits.length > 0 || searching || query.trim().length >= 2) && (
                <div className="mt-1 max-h-56 overflow-auto rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1">
                  {searching && <div className="flex items-center gap-2 px-2 py-2 text-xs text-[var(--color-text-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando…</div>}
                  {hits.map((h) => (
                    <button key={h.id} type="button" onClick={() => { setContact(h); setHits([]); }} className="flex w-full items-center justify-between rounded px-2 py-2 text-left text-sm hover:bg-[var(--color-surface-hover)]">
                      <span className="truncate text-[var(--color-text-primary)]">{h.name || formatPhone(h.phone)}</span>
                      <span className="ml-2 shrink-0 text-xs text-[var(--color-text-muted)]">{formatPhone(h.phone)}</span>
                    </button>
                  ))}
                  {!searching && hits.length === 0 && <div className="px-2 py-2 text-xs text-[var(--color-text-muted)]">Nenhum cliente encontrado.</div>}
                </div>
              )}
              <button type="button" onClick={() => { setNewMode(true); setNewName(query.match(/\d/) ? '' : query); setNewPhone(query.match(/\d/) ? query : ''); }} className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--accent-primary)] hover:underline">
                <UserPlus className="h-3.5 w-3.5" /> Cadastrar cliente novo
              </button>
            </div>
          )}
          {openDeals.length > 0 && (
            <div>
              <label className={labelCls} htmlFor="ns-deal">Negócio</label>
              <select id="ns-deal" value={existingDealId} onChange={(e) => setExistingDealId(e.target.value)} className={inputCls}>
                <option value="">Criar novo negócio</option>
                {openDeals.map((d) => (
                  <option key={d.id} value={d.id}>Fechar: {d.title}{d.value ? ` (${formatBRL(Number(d.value))})` : ''}</option>
                ))}
              </select>
            </div>
          )}
        </section>

        {/* Venda */}
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className={labelCls}>Produtos / serviços</span>
            {products.length === 0 ? (
              <div className="text-xs text-[var(--color-text-muted)]">Nenhum produto cadastrado (Configurações → Produtos).</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {products.map((p) => {
                  const on = productIds.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setProductIds((cur) => (on ? cur.filter((x) => x !== p.id) : [...cur, p.id]))}
                      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition ${on ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
                    >
                      {on && <Check className="h-3 w-3" />} {p.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="ns-title">Descrição</label>
            <input id="ns-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Passaporte AMAI PRIME — família 4 pessoas" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ns-value">{ptype === 'recorrente' ? 'Valor de cada cobrança *' : 'Valor total *'}</label>
            <input id="ns-value" value={valueRaw} onChange={(e) => setValueRaw(e.target.value)} placeholder="0,00" inputMode="decimal" className={inputCls} />
          </div>
          <div>
            <label className={labelCls} htmlFor="ns-owner">Vendedor</label>
            <select id="ns-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className={inputCls}>
              <option value="">Sem vendedor</option>
              {operators.map((o) => <option key={o.user_id} value={o.user_id}>{operatorLabel(o)}</option>)}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="ns-pipe">Funil (o negócio vai para a etapa de ganho)</label>
            <select id="ns-pipe" value={pipelineId} onChange={(e) => setPipelineId(e.target.value)} className={inputCls}>
              {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </section>

        {/* Pagamento */}
        <section className="space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3">
          <div className="grid grid-cols-3 gap-1 rounded-[var(--radius-control)] bg-[var(--color-fill-subtle)] p-1">
            {([['avista', 'À vista'], ['parcelado', 'Parcelado'], ['recorrente', 'Recorrente']] as const).map(([k, l]) => (
              <button key={k} type="button" aria-pressed={ptype === k} onClick={() => setPtype(k)} className={`h-8 rounded-md text-sm font-medium transition ${ptype === k ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] shadow-sm' : 'text-[var(--color-text-secondary)]'}`}>
                {l}
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="ns-due">{ptype === 'avista' ? 'Vencimento' : '1º vencimento'}</label>
              <input id="ns-due" type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="ns-method">Forma de pagamento</label>
              <select id="ns-method" value={method} onChange={(e) => setMethod(e.target.value)} className={inputCls}>
                {PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            {ptype !== 'avista' && (
              <div>
                <label className={labelCls} htmlFor="ns-count">{ptype === 'parcelado' ? 'Nº de parcelas' : 'Nº de cobranças'}</label>
                <input id="ns-count" type="number" min={2} max={120} value={count} onChange={(e) => setCount(Number(e.target.value) || 0)} className={inputCls} />
              </div>
            )}
            {ptype !== 'avista' && (
              <div>
                <label className={labelCls} htmlFor="ns-freq">Frequência</label>
                <select id="ns-freq" value={freq} onChange={(e) => setFreq(e.target.value as Frequency)} className={inputCls}>
                  {(ptype === 'parcelado' ? (['semanal', 'quinzenal', 'mensal'] as Frequency[]) : (Object.keys(FREQUENCY_LABEL) as Frequency[])).map((f) => (
                    <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>
                  ))}
                </select>
              </div>
            )}
            {ptype === 'parcelado' && (
              <div>
                <label className={labelCls} htmlFor="ns-entry">Entrada (opcional)</label>
                <input id="ns-entry" value={entryRaw} onChange={(e) => setEntryRaw(e.target.value)} placeholder="0,00" inputMode="decimal" className={inputCls} />
                {entryInvalid && <div className="mt-1 text-xs text-[var(--color-error)]">A entrada precisa ser menor que o total.</div>}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-primary)]">
            <input type="checkbox" checked={firstPaid} onChange={(e) => setFirstPaid(e.target.checked)} className="h-4 w-4 accent-[var(--accent-fill)]" />
            {ptype === 'avista' ? 'Já foi pago' : 'A 1ª parcela já foi paga'}
          </label>

          {schedule.length > 0 && (
            <div className="rounded-[var(--radius-control)] bg-[var(--color-fill-subtle)] p-2 text-xs">
              <div className="mb-1 flex justify-between font-semibold text-[var(--color-text-primary)]">
                <span>{schedule.length === 1 ? 'Pagamento' : `${schedule.length} ${ptype === 'recorrente' ? 'cobranças' : 'parcelas'}`}</span>
                <span>Total {formatBRL(total)}</span>
              </div>
              <div className="max-h-32 space-y-0.5 overflow-auto">
                {schedule.map((r) => (
                  <div key={r.number} className="flex justify-between text-[var(--color-text-secondary)]">
                    <span>{r.number}/{r.total_count} · {r.due_date.split('-').reverse().join('/')}</span>
                    <span>{formatBRL(r.amount)} {r.status === 'pago' ? '· pago' : ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>

        <div>
          <label className={labelCls} htmlFor="ns-notes">Observações</label>
          <textarea id="ns-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={inputCls} />
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button type="button" variant="success" onClick={() => void submit()} disabled={busy || !(value > 0) || (!contact && !newMode)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Registrar venda {total > 0 ? formatBRL(total) : ''}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
