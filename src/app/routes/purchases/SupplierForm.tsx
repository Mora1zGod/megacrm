import { useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Building2, Calendar, CreditCard, FileText, Globe, Hash, Info, Landmark, Loader2, Mail, MapPin, Phone, Save, Search, Store,
  Tag, Truck, User, Users, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { maskPhoneBR } from '@/lib/phone';
import { formatDoc, maskCEP, maskDoc, onlyDigits } from '@/lib/format';
import { chartAllowed, chartTree } from '../finance/data';
import { fmtDate, fmtDateTime, purError, type CnpjData, type PurLookups, type Supplier } from './data';
import { Badge } from './ui';

const UFS = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];
const NOTES_MAX = 1000;

const boxCls = 'flex h-10 w-full items-center overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] focus-within:border-[var(--accent-primary)] focus-within:ring-1 focus-within:ring-[var(--accent-primary)]';
const innerCls = 'h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] disabled:cursor-not-allowed';

function L({ label, req, htmlFor, children, className }: { label: string; req?: boolean; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-[13px] font-semibold text-[var(--color-text-primary)]">{label}{req && <span className="text-[var(--color-error)]"> *</span>}</label>
      {children}
    </div>
  );
}

function IconInput({ icon: Icon, id, value, onChange, placeholder, type = 'text', inputMode, disabled, maxLength, autoFocus, list }: {
  icon: LucideIcon; id: string; value: string; onChange?: (v: string) => void; placeholder?: string; type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']; disabled?: boolean; maxLength?: number; autoFocus?: boolean; list?: string;
}) {
  return (
    <div className={cn(boxCls, disabled && 'bg-[var(--color-fill-subtle)]')}>
      <span className="flex h-full w-10 shrink-0 items-center justify-center border-r border-[var(--color-border-soft)] text-[var(--color-text-muted)]"><Icon className="h-4 w-4" /></span>
      <input id={id} type={type} value={value} onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder} inputMode={inputMode}
        disabled={disabled} maxLength={maxLength} autoFocus={autoFocus} list={list} className={innerCls} />
    </div>
  );
}

function Section({ icon: Icon, title, hint, children }: { icon: LucideIcon; title: string; hint: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-[var(--color-border-soft)] pt-4 first:border-0 first:pt-0">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
        <div>
          <h4 className="text-[15px] font-semibold text-[var(--color-text-primary)]">{title}</h4>
          <p className="text-xs text-[var(--color-text-secondary)]">{hint}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

const statusTone = (s: string | null | undefined) => !s ? 'muted' as const : /ATIVA/i.test(s) ? 'success' as const : /SUSPENSA|INAPTA/i.test(s) ? 'warn' as const : 'error' as const;
const toDate = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '');

export function SupplierForm({ lookups, supplier, categories, onClose, onSaved }: {
  lookups: PurLookups; supplier: Supplier | null; categories: string[]; onClose: () => void; onSaved: (id: string) => void;
}) {
  const s = supplier;
  const [f, setF] = useState({
    kind: s?.kind ?? 'supplier', doc: maskDoc(s?.doc), name: s?.name ?? '', trade_name: s?.trade_name ?? '',
    state_registration: s?.state_registration ?? '', municipal_registration: s?.municipal_registration ?? '', category: s?.category ?? '',
    email: s?.email ?? '', phone: maskPhoneBR(s?.phone), whatsapp: maskPhoneBR(s?.whatsapp), website: s?.website ?? '', contact_name: s?.contact_name ?? '',
    founded_on: toDate(s?.founded_on), zip_code: maskCEP(s?.zip_code), street: s?.street ?? '', street_number: s?.street_number ?? '',
    complement: s?.complement ?? '', district: s?.district ?? '', city: s?.city ?? '', state: s?.state ?? '',
    bank_name: s?.bank_name ?? '', bank_agency: s?.bank_agency ?? '', bank_account: s?.bank_account ?? '', pix_key: s?.pix_key ?? '',
    payment_terms: s?.payment_terms ?? '', default_chart_account_id: s?.default_chart_account_id ?? '', notes: s?.notes ?? '', is_active: s?.is_active ?? true,
  });
  const [rf, setRf] = useState({
    legal_status: s?.legal_status ?? null, legal_status_date: s?.legal_status_date ?? null, main_activity: s?.main_activity ?? null,
    company_size: s?.company_size ?? null, legal_nature: s?.legal_nature ?? null, simples_nacional: s?.simples_nacional ?? null, mei: s?.mei ?? null,
    share_capital_cents: s?.share_capital_cents ?? null, headquarters: s?.headquarters ?? null, cnpj_data: s?.cnpj_data ?? null, cnpj_checked_at: s?.cnpj_checked_at ?? null,
  });
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const [cepBusy, setCepBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const tree = useMemo(() => chartTree(lookups.chart).filter((c) => chartAllowed(c, 'payable')), [lookups.chart]);
  const docDigits = onlyDigits(f.doc);
  const duplicate = docDigits.length >= 11 ? lookups.suppliers.find((p) => p.doc === docDigits && p.id !== s?.id) : undefined;

  const lookupCnpj = async () => {
    if (docDigits.length !== 14) { toast.error('Digite os 14 números do CNPJ.'); return; }
    setLooking(true);
    try {
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${docDigits}`);
      if (res.status === 404) throw new Error('CNPJ não encontrado na Receita.');
      if (!res.ok) throw new Error(res.status === 429 ? 'Muitas consultas seguidas. Espere um minuto e tente de novo.' : 'A consulta do CNPJ não respondeu agora. Tente de novo.');
      const d = (await res.json()) as CnpjData;
      const phone1 = onlyDigits(d.ddd_telefone_1);
      const phone2 = onlyDigits(d.ddd_telefone_2);
      const mobile = [phone1, phone2].find((p) => p.length === 11);
      const fixed = [phone1, phone2].find((p) => p.length === 10);
      setF((x) => ({
        ...x,
        name: d.razao_social || x.name,
        trade_name: d.nome_fantasia || x.trade_name,
        email: (d.email || '').toLowerCase() || x.email,
        phone: maskPhoneBR(fixed || phone1) || x.phone,
        whatsapp: mobile ? maskPhoneBR(mobile) : x.whatsapp,
        founded_on: toDate(d.data_inicio_atividade) || x.founded_on,
        zip_code: maskCEP(d.cep) || x.zip_code,
        street: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' ') || x.street,
        street_number: d.numero || x.street_number,
        complement: d.complemento || x.complement,
        district: d.bairro || x.district,
        city: d.municipio ? d.municipio.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) : x.city,
        state: d.uf || x.state,
        category: x.category || (d.cnae_fiscal_descricao ?? '').slice(0, 60),
      }));
      setRf({
        legal_status: d.descricao_situacao_cadastral ?? null,
        legal_status_date: toDate(d.data_situacao_cadastral) || null,
        main_activity: d.cnae_fiscal ? `${String(d.cnae_fiscal).replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3')} · ${d.cnae_fiscal_descricao ?? ''}` : d.cnae_fiscal_descricao ?? null,
        company_size: d.porte || d.descricao_porte || null,
        legal_nature: d.natureza_juridica ?? null,
        simples_nacional: d.opcao_pelo_simples ?? null,
        mei: d.opcao_pelo_mei ?? null,
        share_capital_cents: typeof d.capital_social === 'number' ? Math.round(d.capital_social * 100) : null,
        headquarters: d.descricao_identificador_matriz_filial ?? null,
        cnpj_data: d,
        cnpj_checked_at: new Date().toISOString(),
      });
      toast.success(`Dados da Receita carregados: ${d.razao_social ?? ''}`);
    } catch (e) {
      toast.error('Consulta do CNPJ', { description: e instanceof Error && !/fetch/i.test(e.message) ? e.message : 'Sem conexão com o serviço de consulta. Tente de novo.' });
    } finally { setLooking(false); }
  };

  const lookupCep = async (cep: string) => {
    const d = onlyDigits(cep);
    if (d.length !== 8) return;
    setCepBusy(true);
    try {
      const res = await fetch(`https://brasilapi.com.br/api/cep/v1/${d}`);
      if (!res.ok) return;
      const c = (await res.json()) as { street?: string; neighborhood?: string; city?: string; state?: string };
      setF((x) => ({ ...x, street: c.street || x.street, district: c.neighborhood || x.district, city: c.city || x.city, state: c.state || x.state }));
    } catch { /* sem internet: segue manual */ } finally { setCepBusy(false); }
  };

  const save = async () => {
    if (f.name.trim().length < 2) { toast.error('Informe a razão social / nome.'); return; }
    if (docDigits && docDigits.length !== 11 && docDigits.length !== 14) { toast.error('CPF deve ter 11 números e CNPJ 14.'); return; }
    if (duplicate) { toast.error(`Este CNPJ/CPF já está cadastrado (${duplicate.name}).`); return; }
    setBusy(true);
    const row: Record<string, unknown> = {
      kind: f.kind, name: f.name.trim(), doc: docDigits || null, is_active: f.is_active,
      phone: onlyDigits(f.phone) || null, whatsapp: onlyDigits(f.whatsapp) || null, zip_code: onlyDigits(f.zip_code) || null,
      founded_on: f.founded_on || null, default_chart_account_id: f.default_chart_account_id || null,
      email: f.email.trim().toLowerCase() || null, state: f.state || null, notes: f.notes.trim() || null,
      ...rf,
    };
    for (const k of ['trade_name', 'state_registration', 'municipal_registration', 'category', 'website', 'contact_name', 'street', 'street_number',
      'complement', 'district', 'city', 'bank_name', 'bank_agency', 'bank_account', 'pix_key', 'payment_terms'] as const) {
      row[k] = f[k].trim() || null;
    }
    const sb = getSupabase();
    const res = s ? await sb.from('fin_parties').update(row).eq('id', s.id).select('id').single() : await sb.from('fin_parties').insert(row).select('id').single();
    setBusy(false);
    if (res.error) { toast.error('Não foi possível salvar', { description: purError(res.error) }); return; }
    toast.success(s ? 'Cadastro atualizado.' : 'Cadastro salvo.');
    onSaved(res.data.id as string);
  };

  const d = rf.cnpj_data;
  const kinds: Array<[Supplier['kind'], string, LucideIcon]> = [['supplier', 'Fornecedor', Truck], ['customer', 'Cliente', User], ['both', 'Ambos', Users]];

  return (
    <Dialog open onClose={onClose} widthClass="max-w-4xl" opaque title={s ? `Editar ${s.trade_name || s.name}` : 'Novo fornecedor / cliente'}
      description="Cadastre os dados principais e preencha automaticamente pelo CNPJ.">
      <div className="space-y-5">
        {/* Busca pelo CNPJ */}
        <div className="grid gap-4 rounded-[var(--radius-card)] border border-[var(--color-accent-subtle)] bg-[var(--color-accent-subtle)]/40 p-4 md:grid-cols-[auto_1fr_minmax(0,260px)]">
          <span className="hidden h-11 w-11 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-[var(--accent-primary)] md:flex"><FileText className="h-5 w-5" /></span>
          <div className="min-w-0">
            <label htmlFor="sf-doc" className="mb-1 block text-[13px] font-semibold">CNPJ ou CPF <span className="text-[var(--color-error)]">*</span></label>
            <div className="flex gap-2">
              <input id="sf-doc" autoFocus={!s} inputMode="numeric" value={f.doc} placeholder="00.000.000/0000-00"
                onChange={(e) => set('doc', maskDoc(e.target.value))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void lookupCnpj(); } }}
                className="h-10 min-w-0 flex-1 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-sm tabular-nums outline-none focus:border-[var(--accent-primary)]" />
              <Button onClick={lookupCnpj} disabled={looking || docDigits.length !== 14} className="h-10">
                {looking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar dados
              </Button>
            </div>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">Digite só os números. Ex.: 12345678000195</p>
            {duplicate && <p className="mt-1 text-xs font-semibold text-[var(--color-error)]">Já existe cadastro com este documento: {duplicate.name}</p>}
          </div>
          <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface)]/70 p-3 text-xs text-[var(--color-text-secondary)]">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
            Com o CNPJ o sistema puxa da Receita: razão social, fantasia, situação, abertura, atividade (CNAE), porte, natureza, Simples/MEI, capital, sócios, telefone, e-mail e endereço.
          </div>
        </div>

        <Section icon={Building2} title="Dados principais" hint="Informações essenciais sobre o fornecedor ou cliente.">
          <div className="grid gap-3 md:grid-cols-2">
            <L label="Tipo" req>
              <div className="grid grid-cols-3 overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-card)]">
                {kinds.map(([k, label, Icon]) => (
                  <button key={k} type="button" onClick={() => set('kind', k)} aria-pressed={f.kind === k}
                    className={cn('flex h-10 items-center justify-center gap-2 border-r border-[var(--color-border-soft)] text-sm last:border-0',
                      f.kind === k ? 'bg-[var(--color-accent-subtle)] font-semibold text-[var(--accent-primary)] ring-1 ring-inset ring-[var(--accent-primary)]' : 'bg-[var(--color-surface)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
                    <Icon className="h-4 w-4" /> {label}
                  </button>
                ))}
              </div>
            </L>
            <L label="Situação cadastral">
              <div className={cn(boxCls, 'bg-[var(--color-fill-subtle)] px-3 text-sm')}>
                {rf.legal_status
                  ? <span className="flex items-center gap-2"><Badge tone={statusTone(rf.legal_status)}>{rf.legal_status}</Badge>{rf.legal_status_date && <span className="text-xs text-[var(--color-text-muted)]">desde {fmtDate(rf.legal_status_date)}</span>}</span>
                  : <span className="text-[var(--color-text-muted)]">Será preenchida via CNPJ</span>}
              </div>
            </L>
            <L label="Razão social" req htmlFor="sf-name"><IconInput icon={Users} id="sf-name" value={f.name} onChange={(v) => set('name', v)} placeholder="Razão social da empresa" /></L>
            <L label="Nome fantasia" htmlFor="sf-trade"><IconInput icon={Store} id="sf-trade" value={f.trade_name} onChange={(v) => set('trade_name', v)} placeholder="Nome fantasia" /></L>
            <div className="grid gap-3 sm:grid-cols-2">
              <L label="Inscrição estadual" htmlFor="sf-ie"><IconInput icon={FileText} id="sf-ie" value={f.state_registration} onChange={(v) => set('state_registration', v)} placeholder="Inscrição estadual" /></L>
              <L label="Inscrição municipal" htmlFor="sf-im"><IconInput icon={FileText} id="sf-im" value={f.municipal_registration} onChange={(v) => set('municipal_registration', v)} placeholder="Inscrição municipal" /></L>
            </div>
            <L label="Categoria" htmlFor="sf-cat">
              <IconInput icon={Tag} id="sf-cat" value={f.category} onChange={(v) => set('category', v)} placeholder="Ex.: Produtos químicos" list="sf-cats" />
              <datalist id="sf-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            </L>
          </div>
          {d && (
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-[var(--color-text-secondary)]">
                <span>Dados da Receita · {formatDoc(d.cnpj ?? docDigits)}</span>
                {rf.cnpj_checked_at && <span className="font-normal text-[var(--color-text-muted)]">consultado em {fmtDateTime(rf.cnpj_checked_at)}</span>}
              </div>
              <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                {([
                  ['Abertura', fmtDate(toDate(d.data_inicio_atividade) || null)],
                  ['Atividade principal (CNAE)', rf.main_activity],
                  ['Porte', rf.company_size],
                  ['Natureza jurídica', rf.legal_nature],
                  ['Matriz / filial', rf.headquarters],
                  ['Capital social', rf.share_capital_cents !== null ? formatBRL(rf.share_capital_cents) : null],
                  ['Simples Nacional', rf.simples_nacional === null ? '—' : rf.simples_nacional ? 'Optante' : 'Não optante'],
                  ['MEI', rf.mei === null ? '—' : rf.mei ? 'Sim' : 'Não'],
                ] as Array<[string, string | null]>).map(([k, v]) => (
                  <div key={k} className="min-w-0"><dt className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">{k}</dt><dd className="truncate" title={v ?? ''}>{v || '—'}</dd></div>
                ))}
              </dl>
              {(d.qsa?.length ?? 0) > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">Sócios</div>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {d.qsa!.map((q, i) => <li key={i} className="rounded-full border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 py-0.5 text-xs">{q.nome_socio}{q.qualificacao_socio ? ` · ${q.qualificacao_socio}` : ''}{q.data_entrada_sociedade ? ` · desde ${fmtDate(q.data_entrada_sociedade)}` : ''}</li>)}
                  </ul>
                </div>
              )}
              {(d.cnaes_secundarios?.filter((c) => c.codigo).length ?? 0) > 0 && (
                <details className="mt-2 text-xs"><summary className="cursor-pointer text-[var(--accent-primary)]">Atividades secundárias ({d.cnaes_secundarios!.filter((c) => c.codigo).length})</summary>
                  <ul className="mt-1 space-y-0.5 text-[var(--color-text-secondary)]">{d.cnaes_secundarios!.filter((c) => c.codigo).map((c) => <li key={c.codigo}>{String(c.codigo).replace(/^(\d{4})(\d)(\d{2})$/, '$1-$2/$3')} · {c.descricao}</li>)}</ul>
                </details>
              )}
            </div>
          )}
        </Section>

        <Section icon={MapPin} title="Contato e endereço" hint="Dados de contato e endereço da empresa.">
          <div className="grid gap-3 md:grid-cols-3">
            <L label="E-mail" htmlFor="sf-email"><IconInput icon={Mail} id="sf-email" type="email" value={f.email} onChange={(v) => set('email', v)} placeholder="exemplo@empresa.com.br" /></L>
            <L label="Telefone" htmlFor="sf-phone"><IconInput icon={Phone} id="sf-phone" inputMode="tel" value={f.phone} onChange={(v) => set('phone', maskPhoneBR(v))} placeholder="(68) 3222-0000" /></L>
            <L label="WhatsApp" htmlFor="sf-wa"><IconInput icon={Phone} id="sf-wa" inputMode="tel" value={f.whatsapp} onChange={(v) => set('whatsapp', maskPhoneBR(v))} placeholder="(68) 99999-9999" /></L>
            <L label="Pessoa de contato" htmlFor="sf-contact"><IconInput icon={User} id="sf-contact" value={f.contact_name} onChange={(v) => set('contact_name', v)} placeholder="Nome de quem atende" /></L>
            <L label="Data de fundação" htmlFor="sf-found"><IconInput icon={Calendar} id="sf-found" type="date" value={f.founded_on} onChange={(v) => set('founded_on', v)} /></L>
            <L label="Data de cadastro" htmlFor="sf-created"><IconInput icon={Calendar} id="sf-created" value={s ? fmtDateTime(s.created_at) : 'Hoje (ao salvar)'} disabled /></L>
          </div>
          <div className="grid gap-3 md:grid-cols-[150px_1fr_110px_1fr]">
            <L label="CEP" htmlFor="sf-cep">
              <div className="relative">
                <IconInput icon={MapPin} id="sf-cep" inputMode="numeric" value={f.zip_code} placeholder="00000-000"
                  onChange={(v) => { const m = maskCEP(v); set('zip_code', m); if (onlyDigits(m).length === 8) void lookupCep(m); }} />
                {cepBusy && <Loader2 className="absolute right-2 top-3 h-4 w-4 animate-spin text-[var(--accent-primary)]" />}
              </div>
            </L>
            <L label="Endereço" htmlFor="sf-street"><IconInput icon={Landmark} id="sf-street" value={f.street} onChange={(v) => set('street', v)} placeholder="Rua, avenida…" /></L>
            <L label="Número" htmlFor="sf-num"><IconInput icon={Hash} id="sf-num" value={f.street_number} onChange={(v) => set('street_number', v)} placeholder="Nº" /></L>
            <L label="Bairro" htmlFor="sf-district"><IconInput icon={Building2} id="sf-district" value={f.district} onChange={(v) => set('district', v)} placeholder="Bairro" /></L>
          </div>
          <div className="grid gap-3 md:grid-cols-[1fr_1fr_160px]">
            <L label="Complemento" htmlFor="sf-compl"><IconInput icon={Building2} id="sf-compl" value={f.complement} onChange={(v) => set('complement', v)} placeholder="Sala, galpão…" /></L>
            <L label="Cidade" htmlFor="sf-city"><IconInput icon={Building2} id="sf-city" value={f.city} onChange={(v) => set('city', v)} placeholder="Nome da cidade" /></L>
            <L label="UF" htmlFor="sf-uf">
              <div className={boxCls}>
                <span className="flex h-full w-10 shrink-0 items-center justify-center border-r border-[var(--color-border-soft)] text-[var(--color-text-muted)]"><MapPin className="h-4 w-4" /></span>
                <select id="sf-uf" value={f.state} onChange={(e) => set('state', e.target.value)} className={cn(innerCls, 'pr-2')}>
                  <option value="">Selecione</option>{UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </L>
          </div>
          <L label="Site" htmlFor="sf-site"><IconInput icon={Globe} id="sf-site" value={f.website} onChange={(v) => set('website', v)} placeholder="www.empresa.com.br" /></L>
        </Section>

        <Section icon={CreditCard} title="Pagamento" hint="Para pagar o fornecedor e sugerir a conta certa nas notas.">
          <div className="grid gap-3 md:grid-cols-3">
            <L label="Banco" htmlFor="sf-bank"><IconInput icon={Landmark} id="sf-bank" value={f.bank_name} onChange={(v) => set('bank_name', v)} placeholder="Banco" /></L>
            <L label="Agência" htmlFor="sf-ag"><IconInput icon={Hash} id="sf-ag" inputMode="numeric" value={f.bank_agency} onChange={(v) => set('bank_agency', v)} placeholder="0000" /></L>
            <L label="Conta" htmlFor="sf-acc"><IconInput icon={Hash} id="sf-acc" value={f.bank_account} onChange={(v) => set('bank_account', v)} placeholder="00000-0" /></L>
            <L label="Chave Pix" htmlFor="sf-pix"><IconInput icon={CreditCard} id="sf-pix" value={f.pix_key} onChange={(v) => set('pix_key', v)} placeholder="CNPJ, e-mail, telefone…" /></L>
            <L label="Condição habitual" htmlFor="sf-terms"><IconInput icon={Calendar} id="sf-terms" value={f.payment_terms} onChange={(v) => set('payment_terms', v)} placeholder="Ex.: 28 dias" /></L>
            <L label="Conta do plano (padrão)" htmlFor="sf-chart">
              <div className={boxCls}>
                <select id="sf-chart" value={f.default_chart_account_id} onChange={(e) => set('default_chart_account_id', e.target.value)} className={innerCls}>
                  <option value="">—</option>{tree.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}
                </select>
              </div>
            </L>
          </div>
        </Section>

        <div className="flex items-start gap-3 border-t border-[var(--color-border-soft)] pt-4">
          <FileText className="mt-1 h-5 w-5 shrink-0 text-[var(--color-text-muted)]" />
          <div className="relative min-w-0 flex-1">
            <label htmlFor="sf-notes" className="mb-1 block text-[13px] font-semibold">Observações</label>
            <textarea id="sf-notes" rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value.slice(0, NOTES_MAX))}
              placeholder="Informações adicionais sobre o fornecedor/cliente…"
              className="w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-primary)]" />
            <span className="absolute bottom-2 right-3 text-[11px] text-[var(--color-text-muted)]">{f.notes.length}/{NOTES_MAX}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border-soft)] pt-4">
          <label className="flex cursor-pointer items-center gap-3">
            <button type="button" role="switch" aria-checked={f.is_active} onClick={() => set('is_active', !f.is_active)}
              className={cn('relative h-6 w-11 rounded-full transition-colors', f.is_active ? 'bg-[var(--accent-fill)]' : 'bg-[var(--color-border-card)]')}>
              <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform', f.is_active ? 'translate-x-5' : 'translate-x-0.5')} />
            </button>
            <span><span className="block text-sm font-semibold">Ativo</span><span className="block text-xs text-[var(--color-text-muted)]">Pode ser usado em compras, notas e contas.</span></span>
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancelar</Button>
            <Button disabled={busy} onClick={save}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar cadastro</Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
