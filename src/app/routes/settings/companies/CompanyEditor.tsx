import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeft, BadgeCheck, Building2, CheckCircle2, CircleDashed, FileBadge2, Landmark, Loader2, MapPin, Plug, Receipt, Search,
  ShieldCheck, ShoppingCart, Upload, Users, Wallet, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatDoc, maskCEP, maskDoc, onlyDigits } from '@/lib/format';
import { maskPhoneBR } from '@/lib/phone';
import { formatBRL } from '@/lib/money';
import { lookupCep, lookupCnpj } from '@/lib/cnpj-lookup';
import { Field, inputCls } from '@/app/routes/settings/sections/access/ui';
import { ChartPicker, MoneyInput } from '@/app/routes/finance/ui';
import { useFinanceLookups } from '@/app/routes/finance/data';
import { usePurLookups, sefazApi } from '@/app/routes/purchases/data';
import { SefazSettings, Bands } from '@/app/routes/purchases/PurchaseSettingsTab';
import { PAYMENT_METHOD, TAX_REGIME, companyError, updateCompany, type CompanyRow } from './companyData';

type Tab = 'geral' | 'fiscal' | 'financeiro' | 'compras' | 'certificados' | 'integracoes' | 'usuarios';
const TABS: Array<{ id: Tab; label: string; hint: string; icon: typeof Building2 }> = [
  { id: 'geral', label: 'Geral', hint: 'Dados, contato e endereço', icon: Building2 },
  { id: 'fiscal', label: 'Fiscal e tributário', hint: 'Regime, CNAE, séries', icon: Receipt },
  { id: 'financeiro', label: 'Financeiro', hint: 'Bancos, PIX e padrões', icon: Wallet },
  { id: 'compras', label: 'Compras', hint: 'Padrões e aprovação', icon: ShoppingCart },
  { id: 'certificados', label: 'Certificados', hint: 'Certificado digital A1', icon: FileBadge2 },
  { id: 'integracoes', label: 'Integrações', hint: 'O que está ligado', icon: Plug },
  { id: 'usuarios', label: 'Usuários', hint: 'Quem trabalha aqui', icon: Users },
];

const g2 = 'grid grid-cols-1 gap-4 md:grid-cols-2';
const g3 = 'grid grid-cols-1 gap-4 md:grid-cols-3';

// Configurações → Empresas → (empresa): tela completa com abas.
export function CompanyEditor({ id }: { id: string }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('aba'))?.id ?? 'geral') as Tab;
  const setTab = (t: Tab) => setParams((p) => { p.set('aba', t); return p; }, { replace: true });
  const [row, setRow] = useState<CompanyRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase().from('fin_companies').select('*').eq('id', id).maybeSingle();
    if (err) setError(companyError(err));
    else if (!data) setError('Empresa não encontrada (ou seu perfil não tem acesso ao Financeiro/Compras).');
    else { setRow(data as CompanyRow); setError(null); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <Back onBack={() => navigate('/configuracoes/empresas')}><p className="rounded-lg border border-[rgba(239,68,68,0.3)] p-4 text-sm text-[var(--color-error)]">{error}</p></Back>;
  if (!row) return <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-96" /></div>;

  return (
    <div className="space-y-4">
      <button type="button" onClick={() => navigate('/configuracoes/empresas')} className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
        <ArrowLeft className="h-4 w-4" /> Empresas
      </button>
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
        <div className="flex flex-wrap items-center gap-4 border-b border-[var(--color-border-soft)] px-6 py-5">
          <Logo url={row.logo_url} name={row.name} size={56} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-bold text-[var(--color-text-primary)]">{row.name}</h2>
            <p className="truncate text-sm text-[var(--color-text-secondary)]">{row.legal_name || 'Gerencie os dados da empresa, configurações e integrações.'}{row.cnpj ? ` · ${formatDoc(row.cnpj)}` : ''}</p>
          </div>
          {row.is_default && <span className="rounded-full bg-[var(--color-accent-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--accent-primary)]">Empresa padrão</span>}
          <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
            row.is_active ? 'bg-[rgba(34,197,94,0.12)] text-[var(--color-success)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]')}>
            <span className={cn('h-1.5 w-1.5 rounded-full', row.is_active ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-muted)]')} />{row.is_active ? 'Ativa' : 'Inativa'}
          </span>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr]">
          <nav className="flex gap-1 overflow-x-auto border-b border-[var(--color-border-soft)] p-3 lg:flex-col lg:border-b-0 lg:border-r" aria-label="Seções da empresa">
            {TABS.map((t) => (
              <button key={t.id} type="button" onClick={() => setTab(t.id)} aria-current={tab === t.id ? 'page' : undefined}
                className={cn('flex shrink-0 items-start gap-3 rounded-[var(--radius-control)] border-l-2 px-3 py-2.5 text-left transition-colors',
                  tab === t.id ? 'border-[var(--accent-fill)] bg-[var(--color-accent-subtle)]' : 'border-transparent hover:bg-[var(--color-surface-hover)]')}>
                <t.icon className={cn('mt-0.5 h-4 w-4 shrink-0', tab === t.id ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)]')} />
                <span className="min-w-0">
                  <span className={cn('block text-sm font-semibold', tab === t.id ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-primary)]')}>{t.label}</span>
                  <span className="hidden text-xs text-[var(--color-text-muted)] lg:block">{t.hint}</span>
                </span>
              </button>
            ))}
          </nav>
          <div className="min-w-0 p-6">
            {tab === 'geral' && <GeneralTab row={row} onSaved={load} />}
            {tab === 'fiscal' && <FiscalTab row={row} onSaved={load} />}
            {tab === 'financeiro' && <FinanceTab row={row} onSaved={load} />}
            {tab === 'compras' && <PurchasesTab row={row} onSaved={load} />}
            {tab === 'certificados' && <Section title="Certificados digitais" desc="Certificado A1 da empresa. Compras e a busca de notas na SEFAZ usam este certificado."><SefazSettings companyId={row.id} /></Section>}
            {tab === 'integracoes' && <IntegrationsTab row={row} />}
            {tab === 'usuarios' && <UsersTab row={row} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Back({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return <div className="space-y-4"><button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)]"><ArrowLeft className="h-4 w-4" /> Empresas</button>{children}</div>;
}

export function Logo({ url, name, size = 40 }: { url: string | null; name: string; size?: number }) {
  return url
    ? <img src={url} alt="" className="shrink-0 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] bg-white object-contain p-1" style={{ width: size, height: size }} />
    : <span className="flex shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent-subtle)] font-bold text-[var(--accent-primary)]" style={{ width: size, height: size, fontSize: size / 3 }}>
        {name.trim().slice(0, 2).toUpperCase()}
      </span>;
}

function Section({ title, desc, actions, children }: { title: string; desc?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="text-lg font-bold text-[var(--color-text-primary)]">{title}</h3>{desc && <p className="text-sm text-[var(--color-text-secondary)]">{desc}</p>}</div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function SaveBar({ dirty, busy, onSave, onReset }: { dirty: boolean; busy: boolean; onSave: () => void; onReset: () => void }) {
  return (
    <div className="sticky bottom-0 -mx-6 -mb-6 mt-6 flex justify-end gap-3 border-t border-[var(--color-border-soft)] bg-[var(--color-surface)] px-6 py-4">
      <Button variant="outline" disabled={!dirty || busy} onClick={onReset}>Cancelar</Button>
      <Button disabled={!dirty || busy} onClick={onSave}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar alterações</Button>
    </div>
  );
}

// Formulário da aba: guarda só o que mudou e manda para fin_company_update.
function useForm<T extends Record<string, unknown>>(initial: T, id: string, onSaved: () => Promise<void> | void) {
  const [f, setF] = useState<T>(initial);
  const [busy, setBusy] = useState(false);
  const base = useRef(initial);
  useEffect(() => { base.current = initial; setF(initial); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [JSON.stringify(initial)]);
  const dirty = JSON.stringify(f) !== JSON.stringify(base.current);
  const set = <K extends keyof T>(k: K, v: T[K]) => setF((x) => ({ ...x, [k]: v }));
  const save = async (transform: (v: T) => Record<string, unknown> = (v) => v) => {
    const out = transform(f); const prev = transform(base.current);
    const patch: Record<string, unknown> = {};
    for (const k of Object.keys(out)) if (JSON.stringify(out[k]) !== JSON.stringify(prev[k])) patch[k] = out[k];
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try { await updateCompany(id, patch); toast.success('Alterações salvas.'); await onSaved(); }
    catch (e) { toast.error('Não foi possível salvar', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return { f, set, setF, dirty, busy, save, reset: () => setF(base.current) };
}

// ------------------------------------------------------------------ GERAL
function GeneralTab({ row, onSaved }: { row: CompanyRow; onSaved: () => Promise<void> }) {
  const { orgId } = useAppUser();
  const canEdit = usePermission().can('financial.setup');
  const form = useForm({
    legal_name: row.legal_name ?? '', name: row.name, person_type: row.person_type, cnpj: maskDoc(row.cnpj ?? ''),
    state_registration: row.state_registration ?? '', municipal_registration: row.municipal_registration ?? '',
    founded_on: row.founded_on ?? '', legal_status: row.legal_status ?? '',
    phone: maskPhoneBR(row.phone ?? ''), email: row.email ?? '', website: row.website ?? '',
    zip_code: maskCEP(row.zip_code ?? ''), street: row.street ?? '', street_number: row.street_number ?? '', complement: row.complement ?? '',
    district: row.district ?? '', city: row.city ?? '', state: row.state ?? '', notes: row.notes ?? '',
    is_active: row.is_active, is_default: row.is_default,
  }, row.id, onSaved);
  const { f, set } = form;
  const [looking, setLooking] = useState(false);
  const [cepBusy, setCepBusy] = useState(false);
  const [extra, setExtra] = useState<Record<string, unknown>>({});
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const fetchCnpj = async () => {
    const d = onlyDigits(f.cnpj);
    if (d.length !== 14) { toast.error('Digite os 14 números do CNPJ.'); return; }
    setLooking(true);
    try {
      const { source, state_registration: ie, ...r } = await lookupCnpj(d);
      const phone = onlyDigits(r.ddd_telefone_1);
      form.setF((x) => ({
        ...x, legal_name: r.razao_social || x.legal_name, name: x.name || r.nome_fantasia || r.razao_social || x.name,
        state_registration: x.state_registration || ie || '', founded_on: (r.data_inicio_atividade ?? '').slice(0, 10) || x.founded_on,
        legal_status: r.descricao_situacao_cadastral || x.legal_status, phone: phone ? maskPhoneBR(phone) : x.phone,
        email: (r.email || '').toLowerCase() || x.email, zip_code: maskCEP(r.cep) || x.zip_code,
        street: [r.descricao_tipo_de_logradouro, r.logradouro].filter(Boolean).join(' ') || x.street, street_number: r.numero || x.street_number,
        complement: r.complemento || x.complement, district: r.bairro || x.district,
        city: r.municipio ? r.municipio.toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase()) : x.city, state: r.uf || x.state,
      }));
      const cnae = (c?: number) => (c ? String(c).padStart(7, '0').replace(/^(\d{2})(\d{2})(\d)(\d{2})$/, '$1.$2-$3-$4') : '');
      setExtra({
        cnpj_data: r, cnpj_checked_at: new Date().toISOString(),
        ...(row.main_activity ? {} : { main_activity: r.cnae_fiscal ? `${cnae(r.cnae_fiscal)} - ${r.cnae_fiscal_descricao ?? ''}` : null }),
        ...(row.secondary_activities?.length ? {} : { secondary_activities: (r.cnaes_secundarios ?? []).filter((c) => c.codigo).map((c) => `${cnae(c.codigo)} - ${c.descricao}`) }),
      });
      toast.success(`Dados da Receita carregados (${source}). Confira e salve.`);
    } catch (e) { toast.error('Consulta do CNPJ', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLooking(false); }
  };
  const fetchCep = async (v: string) => {
    if (onlyDigits(v).length !== 8) return;
    setCepBusy(true);
    const c = await lookupCep(v);
    setCepBusy(false);
    if (c) form.setF((x) => ({ ...x, street: c.street || x.street, district: c.district || x.district, city: c.city || x.city, state: c.state || x.state }));
  };
  const uploadLogo = async (file: File | undefined) => {
    if (!file || !orgId) return;
    if (file.size > 2 * 1024 * 1024) { toast.error('O logo pode ter no máximo 2 MB.'); return; }
    if (!/^image\/(png|jpeg|svg\+xml|webp)$/.test(file.type)) { toast.error('Use PNG, JPG, SVG ou WEBP.'); return; }
    setUploading(true);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
      const path = `${orgId}/empresas/${row.id}.${ext}`;
      const sb = getSupabase();
      const up = await sb.storage.from('org-branding').upload(path, file, { upsert: true, cacheControl: '3600', contentType: file.type });
      if (up.error) throw new Error(/row-level|not allowed|unauthorized/i.test(up.error.message) ? 'Só administrador envia logo.' : up.error.message);
      const url = `${sb.storage.from('org-branding').getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
      await updateCompany(row.id, { logo_url: url });
      toast.success('Logo atualizado.'); await onSaved();
    } catch (e) { toast.error('Logo', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setUploading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const doc = onlyDigits(f.cnpj);
  const save = () => {
    if (f.name.trim().length < 2) { toast.error('Informe o nome fantasia.'); return; }
    if (doc && doc.length !== 11 && doc.length !== 14) { toast.error('CNPJ precisa de 14 números (CPF, 11).'); return; }
    void form.save((v) => ({ ...v, cnpj: onlyDigits(v.cnpj) || null, phone: onlyDigits(v.phone) || null, zip_code: onlyDigits(v.zip_code) || null,
      state: v.state.toUpperCase(), email: v.email.trim().toLowerCase(), ...extra })).then(() => setExtra({}));
  };
  const ro = !canEdit;
  const dirty = form.dirty || Object.keys(extra).length > 0;

  return (
    <Section title="Dados gerais" desc="Informações básicas da empresa."
      actions={(
        <div className="flex items-center gap-3">
          <Logo url={row.logo_url} name={row.name} size={64} />
          <div>
            <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(e) => void uploadLogo(e.target.files?.[0])} />
            <Button variant="outline" size="sm" disabled={ro || uploading} onClick={() => fileRef.current?.click()}>{uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} {row.logo_url ? 'Trocar logo' : 'Enviar logo'}</Button>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">PNG, JPG ou SVG (máx. 2 MB)</p>
          </div>
        </div>
      )}>
      {ro && <ReadOnlyNote />}
      <fieldset disabled={ro} className="space-y-4">
        <div className={g2}>
          <Field label="Razão social" required htmlFor="cg-legal"><input id="cg-legal" value={f.legal_name} onChange={(e) => set('legal_name', e.target.value)} className={inputCls} /></Field>
          <Field label="Nome fantasia" required htmlFor="cg-name"><input id="cg-name" value={f.name} onChange={(e) => set('name', e.target.value)} className={inputCls} /></Field>
        </div>
        <div className={g3}>
          <Field label={f.person_type === 'pf' ? 'CPF' : 'CNPJ'} required htmlFor="cg-cnpj">
            <div className="flex gap-2">
              <input id="cg-cnpj" inputMode="numeric" value={f.cnpj} onChange={(e) => set('cnpj', maskDoc(e.target.value))} placeholder="00.000.000/0000-00" className={inputCls} />
              {f.person_type === 'pj' && <Button type="button" variant="outline" className="h-10 shrink-0 px-3" disabled={looking} onClick={() => void fetchCnpj()} title="Buscar dados na Receita">
                {looking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</Button>}
            </div>
          </Field>
          <Field label="Inscrição estadual" htmlFor="cg-ie"><input id="cg-ie" value={f.state_registration} onChange={(e) => set('state_registration', e.target.value)} className={inputCls} /></Field>
          <Field label="Inscrição municipal" htmlFor="cg-im"><input id="cg-im" value={f.municipal_registration} onChange={(e) => set('municipal_registration', e.target.value)} className={inputCls} /></Field>
        </div>
        <div className={g3}>
          <Field label="Tipo de pessoa" htmlFor="cg-pt">
            <select id="cg-pt" value={f.person_type} onChange={(e) => set('person_type', e.target.value as 'pj' | 'pf')} className={inputCls}><option value="pj">Jurídica</option><option value="pf">Física</option></select>
          </Field>
          <Field label="Data de abertura" htmlFor="cg-found"><input id="cg-found" type="date" value={f.founded_on} onChange={(e) => set('founded_on', e.target.value)} className={inputCls} /></Field>
          <Field label="Situação cadastral" htmlFor="cg-sit"><input id="cg-sit" value={f.legal_status} onChange={(e) => set('legal_status', e.target.value)} placeholder="Ex.: Ativa" className={inputCls} /></Field>
        </div>

        <h4 className="flex items-center gap-2 pt-2 text-sm font-semibold text-[var(--color-text-primary)]"><Landmark className="h-4 w-4 text-[var(--accent-primary)]" /> Contato</h4>
        <div className={g3}>
          <Field label="Telefone" htmlFor="cg-phone"><input id="cg-phone" inputMode="tel" value={f.phone} onChange={(e) => set('phone', maskPhoneBR(e.target.value))} placeholder="(00) 00000-0000" className={inputCls} /></Field>
          <Field label="E-mail" htmlFor="cg-email"><input id="cg-email" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} className={inputCls} /></Field>
          <Field label="Site" htmlFor="cg-site"><input id="cg-site" value={f.website} onChange={(e) => set('website', e.target.value)} placeholder="https://" className={inputCls} /></Field>
        </div>

        <h4 className="flex items-center gap-2 pt-2 text-sm font-semibold text-[var(--color-text-primary)]"><MapPin className="h-4 w-4 text-[var(--accent-primary)]" /> Endereço</h4>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-6">
          <div className="col-span-2 md:col-span-2"><Field label="CEP" htmlFor="cg-cep">
            <div className="relative"><input id="cg-cep" inputMode="numeric" value={f.zip_code} onChange={(e) => { set('zip_code', maskCEP(e.target.value)); void fetchCep(e.target.value); }} placeholder="00000-000" className={inputCls} />
              {cepBusy && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-[var(--color-text-muted)]" />}</div>
          </Field></div>
          <div className="col-span-2 md:col-span-3"><Field label="Endereço" htmlFor="cg-street"><input id="cg-street" value={f.street} onChange={(e) => set('street', e.target.value)} className={inputCls} /></Field></div>
          <div className="col-span-2 md:col-span-1"><Field label="Número" htmlFor="cg-num"><input id="cg-num" value={f.street_number} onChange={(e) => set('street_number', e.target.value)} className={inputCls} /></Field></div>
          <div className="col-span-2 md:col-span-2"><Field label="Complemento" htmlFor="cg-comp"><input id="cg-comp" value={f.complement} onChange={(e) => set('complement', e.target.value)} className={inputCls} /></Field></div>
          <div className="col-span-2 md:col-span-2"><Field label="Bairro" htmlFor="cg-dist"><input id="cg-dist" value={f.district} onChange={(e) => set('district', e.target.value)} className={inputCls} /></Field></div>
          <div className="col-span-1 md:col-span-1"><Field label="Cidade" htmlFor="cg-city"><input id="cg-city" value={f.city} onChange={(e) => set('city', e.target.value)} className={inputCls} /></Field></div>
          <div className="col-span-1 md:col-span-1"><Field label="UF" htmlFor="cg-uf"><input id="cg-uf" maxLength={2} value={f.state} onChange={(e) => set('state', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} className={inputCls} /></Field></div>
        </div>

        <Field label={`Descrição / observações (${f.notes.length}/500)`} htmlFor="cg-notes">
          <textarea id="cg-notes" rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value.slice(0, 500))} className={cn(inputCls, 'h-auto py-2')} />
        </Field>
        <div className="flex flex-wrap gap-6 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.is_active} disabled={row.is_default} onChange={(e) => set('is_active', e.target.checked)} /> Empresa ativa</label>
          <label className="flex items-center gap-2" title={row.is_default ? 'Para trocar, marque outra empresa como padrão.' : undefined}>
            <input type="checkbox" checked={f.is_default} disabled={row.is_default} onChange={(e) => set('is_default', e.target.checked)} /> Empresa padrão do grupo
          </label>
        </div>
        {row.cnpj_checked_at && <p className="text-xs text-[var(--color-text-muted)]">Dados conferidos na Receita em {new Date(row.cnpj_checked_at).toLocaleString('pt-BR', { timeZone: 'America/Rio_Branco' })}.</p>}
      </fieldset>
      {!ro && <SaveBar dirty={dirty} busy={form.busy} onSave={save} onReset={() => { form.reset(); setExtra({}); }} />}
    </Section>
  );
}

function ReadOnlyNote() {
  return <p className="rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-secondary)]">Somente leitura: seu perfil não tem a permissão de configurar o Financeiro.</p>;
}

// ------------------------------------------------------------------ FISCAL
function FiscalTab({ row, onSaved }: { row: CompanyRow; onSaved: () => Promise<void> }) {
  const canEdit = usePermission().can('financial.setup');
  const ts = row.tax_settings ?? {};
  const form = useForm({
    tax_regime: row.tax_regime ?? '', main_activity: row.main_activity ?? '', secondary_activities: row.secondary_activities ?? [],
    service_code: row.service_code ?? '', state_registration: row.state_registration ?? '', municipal_registration: row.municipal_registration ?? '',
    fiscal_env: row.fiscal_env, nfe_series: row.nfe_series?.toString() ?? '', nfce_series: row.nfce_series?.toString() ?? '', nfse_series: row.nfse_series?.toString() ?? '',
    iss_rate: String(ts.iss_rate ?? ''), default_cfop: String(ts.default_cfop ?? ''), default_csosn: String(ts.default_csosn ?? ''),
  }, row.id, onSaved);
  const { f, set } = form;
  const [newCnae, setNewCnae] = useState('');
  const ro = !canEdit;
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = () => {
    for (const k of ['nfe_series', 'nfce_series', 'nfse_series'] as const) {
      if (f[k] && !/^\d{1,3}$/.test(f[k])) { toast.error('A série tem de 0 a 999.'); return; }
    }
    void form.save((v) => {
      const { iss_rate, default_cfop, default_csosn, ...rest } = v;
      return {
        ...rest, tax_regime: v.tax_regime || null, nfe_series: num(v.nfe_series), nfce_series: num(v.nfce_series), nfse_series: num(v.nfse_series),
        tax_settings: { ...(row.tax_settings ?? {}), iss_rate: iss_rate.trim() || null, default_cfop: default_cfop.trim() || null, default_csosn: default_csosn.trim() || null },
      };
    });
  };
  return (
    <Section title="Fiscal e tributário" desc="Regime, atividades (CNAE), inscrições e séries dos documentos fiscais.">
      {ro && <ReadOnlyNote />}
      <fieldset disabled={ro} className="space-y-4">
        <div className={g2}>
          <Field label="Regime tributário" htmlFor="cf-reg">
            <select id="cf-reg" value={f.tax_regime} onChange={(e) => set('tax_regime', e.target.value)} className={inputCls}>
              <option value="">Escolha…</option>{Object.entries(TAX_REGIME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Ambiente fiscal" htmlFor="cf-env" hint="Homologação = testes, sem valor fiscal.">
            <select id="cf-env" value={f.fiscal_env} onChange={(e) => set('fiscal_env', e.target.value as 'production' | 'homologation')} className={inputCls}>
              <option value="homologation">Homologação (testes)</option><option value="production">Produção</option>
            </select>
          </Field>
        </div>
        <Field label="Atividade principal (CNAE)" htmlFor="cf-cnae"><input id="cf-cnae" value={f.main_activity} onChange={(e) => set('main_activity', e.target.value)} placeholder="93.29-8-01 - Parques de diversão e parques temáticos" className={inputCls} /></Field>
        <Field label="Atividades secundárias (CNAE)" htmlFor="cf-cnae2">
          <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-1.5">
            {f.secondary_activities.map((c, i) => (
              <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-md bg-[var(--color-surface-hover)] px-2 py-1 text-xs text-[var(--color-text-primary)]">
                <span className="truncate">{c}</span>
                {!ro && <button type="button" aria-label={`Remover ${c}`} onClick={() => set('secondary_activities', f.secondary_activities.filter((_, j) => j !== i))} className="text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><X className="h-3 w-3" /></button>}
              </span>
            ))}
            {!ro && <input id="cf-cnae2" value={newCnae} onChange={(e) => setNewCnae(e.target.value)} placeholder={f.secondary_activities.length ? 'Adicionar…' : 'Digite e tecle Enter'}
              onKeyDown={(e) => { if (e.key === 'Enter' && newCnae.trim()) { e.preventDefault(); set('secondary_activities', [...f.secondary_activities, newCnae.trim()]); setNewCnae(''); } }}
              className="no-focus-ring min-w-[160px] flex-1 bg-transparent px-1 text-sm outline-none" />}
          </div>
        </Field>
        <div className={g3}>
          <Field label="Código de serviço (NFS-e)" htmlFor="cf-svc"><input id="cf-svc" value={f.service_code} onChange={(e) => set('service_code', e.target.value)} className={inputCls} /></Field>
          <Field label="Inscrição estadual" htmlFor="cf-ie"><input id="cf-ie" value={f.state_registration} onChange={(e) => set('state_registration', e.target.value)} className={inputCls} /></Field>
          <Field label="Inscrição municipal" htmlFor="cf-im"><input id="cf-im" value={f.municipal_registration} onChange={(e) => set('municipal_registration', e.target.value)} className={inputCls} /></Field>
        </div>
        <div className={g3}>
          <Field label="Série NF-e" htmlFor="cf-s1"><input id="cf-s1" inputMode="numeric" value={f.nfe_series} onChange={(e) => set('nfe_series', e.target.value.replace(/\D/g, '').slice(0, 3))} className={inputCls} /></Field>
          <Field label="Série NFC-e" htmlFor="cf-s2"><input id="cf-s2" inputMode="numeric" value={f.nfce_series} onChange={(e) => set('nfce_series', e.target.value.replace(/\D/g, '').slice(0, 3))} className={inputCls} /></Field>
          <Field label="Série NFS-e" htmlFor="cf-s3"><input id="cf-s3" inputMode="numeric" value={f.nfse_series} onChange={(e) => set('nfse_series', e.target.value.replace(/\D/g, '').slice(0, 3))} className={inputCls} /></Field>
        </div>
        <h4 className="pt-2 text-sm font-semibold text-[var(--color-text-primary)]">Configurações tributárias</h4>
        <div className={g3}>
          <Field label="Alíquota de ISS (%)" htmlFor="cf-iss"><input id="cf-iss" inputMode="decimal" value={f.iss_rate} onChange={(e) => set('iss_rate', e.target.value.replace(/[^\d,]/g, '').slice(0, 6))} placeholder="Ex.: 5" className={inputCls} /></Field>
          <Field label="CFOP padrão de entrada" htmlFor="cf-cfop"><input id="cf-cfop" inputMode="numeric" value={f.default_cfop} onChange={(e) => set('default_cfop', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="Ex.: 1102" className={inputCls} /></Field>
          <Field label="CSOSN / CST padrão" htmlFor="cf-cst"><input id="cf-cst" value={f.default_csosn} onChange={(e) => set('default_csosn', e.target.value.slice(0, 4))} placeholder="Ex.: 102" className={inputCls} /></Field>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">Estes dados ficam guardados para a emissão de notas, que ainda não está ligada no sistema (hoje o sistema só recebe as notas de entrada).</p>
      </fieldset>
      {!ro && <SaveBar dirty={form.dirty} busy={form.busy} onSave={save} onReset={form.reset} />}
    </Section>
  );
}

// ------------------------------------------------------------------ FINANCEIRO
function FinanceTab({ row, onSaved }: { row: CompanyRow; onSaved: () => Promise<void> }) {
  const perms = usePermission();
  const canEdit = perms.can('financial.setup');
  const lk = useFinanceLookups();
  const form = useForm({
    pix_key: row.pix_key ?? '', default_account_id: row.default_account_id ?? '', default_cost_center_id: row.default_cost_center_id ?? '',
    default_chart_account_id: row.default_chart_account_id ?? '', default_payment_method: row.default_payment_method ?? '',
  }, row.id, onSaved);
  const { f, set } = form;
  const accounts = lk.accounts.filter((a) => a.company_id === row.id);
  const ro = !canEdit;
  return (
    <Section title="Financeiro" desc="Contas bancárias da empresa e os padrões usados nos lançamentos.">
      {ro && <ReadOnlyNote />}
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-2.5">
          <span className="text-sm font-semibold text-[var(--color-text-primary)]">Contas bancárias e caixas</span>
          <Link to="/financeiro?tab=bancos" className="text-xs font-semibold text-[var(--accent-primary)] hover:underline">Gerenciar no Financeiro ›</Link>
        </div>
        {lk.loading ? <div className="p-4"><Skeleton className="h-8" /></div> : accounts.length === 0
          ? <p className="px-4 py-4 text-sm text-[var(--color-text-muted)]">Nenhuma conta cadastrada para esta empresa.</p>
          : <ul>{accounts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-2.5 text-sm last:border-0">
                <span><b className="text-[var(--color-text-primary)]">{a.name}</b> <span className="text-[var(--color-text-muted)]">{a.kind === 'cash' ? 'Caixa' : [a.bank_name, a.agency && `ag. ${a.agency}`, a.account_number && `cc ${a.account_number}`].filter(Boolean).join(' · ')}</span>{!a.is_active && <span className="ml-2 text-xs text-[var(--color-text-muted)]">(inativa)</span>}</span>
                <span className="tabular-nums text-[var(--color-text-secondary)]">{perms.can('financial.ledger_view') ? formatBRL(a.balance_cents) : ''}</span>
              </li>
            ))}</ul>}
      </div>
      <fieldset disabled={ro} className="space-y-4">
        <div className={g2}>
          <Field label="Chave PIX" htmlFor="ff-pix"><input id="ff-pix" value={f.pix_key} onChange={(e) => set('pix_key', e.target.value)} placeholder="CNPJ, e-mail, telefone ou chave aleatória" className={inputCls} /></Field>
          <Field label="Forma de pagamento padrão" htmlFor="ff-pm">
            <select id="ff-pm" value={f.default_payment_method} onChange={(e) => set('default_payment_method', e.target.value)} className={inputCls}>
              <option value="">—</option>{Object.entries(PAYMENT_METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </Field>
          <Field label="Conta bancária padrão" htmlFor="ff-acc">
            <select id="ff-acc" value={f.default_account_id} onChange={(e) => set('default_account_id', e.target.value)} className={inputCls}>
              <option value="">—</option>{accounts.filter((a) => a.is_active || a.id === f.default_account_id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Centro de custo padrão" htmlFor="ff-cc">
            <select id="ff-cc" value={f.default_cost_center_id} onChange={(e) => set('default_cost_center_id', e.target.value)} className={inputCls}>
              <option value="">—</option>{lk.costCenters.filter((c) => c.is_active || c.id === f.default_cost_center_id).map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>)}
            </select>
          </Field>
          <Field label="Plano de contas padrão (despesas)" htmlFor="ff-chart">
            <ChartPicker id="ff-chart" chart={lk.chart} kind="payable" value={f.default_chart_account_id} onChange={(v) => set('default_chart_account_id', v)} emptyLabel="—" />
          </Field>
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4 text-sm">
        <span className="text-[var(--color-text-secondary)]"><b className="text-[var(--color-text-primary)]">Cobrança (ASAAS) e integrações bancárias</b> são da organização e valem para todas as empresas.</span>
        <Link to="/configuracoes/integracoes/asaas" className="text-sm font-semibold text-[var(--accent-primary)] hover:underline">Abrir ›</Link>
      </div>
      {!ro && <SaveBar dirty={form.dirty} busy={form.busy} onSave={() => void form.save()} onReset={form.reset} />}
    </Section>
  );
}

// ------------------------------------------------------------------ COMPRAS
function PurchasesTab({ row, onSaved }: { row: CompanyRow; onSaved: () => Promise<void> }) {
  const perms = usePermission();
  const canEdit = perms.can('purchases.setup');
  const lk = useFinanceLookups();
  const pl = usePurLookups();
  const rules = row.purchase_rules ?? {};
  const form = useForm({
    purchase_location_id: row.purchase_location_id ?? '', purchase_cost_center_id: row.purchase_cost_center_id ?? '',
    purchase_chart_account_id: row.purchase_chart_account_id ?? '', purchase_account_id: row.purchase_account_id ?? '',
    purchase_requires_approval: row.purchase_requires_approval, purchase_limit_cents: row.purchase_limit_cents ?? 0,
    purchase_manager_id: row.purchase_manager_id ?? '',
    min_quotes: String(rules.min_quotes ?? ''), require_justification: rules.require_justification !== false,
    order_notes: String(rules.order_notes ?? ''),
  }, row.id, onSaved);
  const { f, set } = form;
  const members = [...pl.people.entries()];
  const ro = !canEdit;
  const save = () => void form.save((v) => {
    const { min_quotes, require_justification, order_notes, ...rest } = v;
    return {
      ...rest, purchase_limit_cents: v.purchase_limit_cents || null,
      purchase_rules: { ...(row.purchase_rules ?? {}), min_quotes: min_quotes ? Number(min_quotes) : null, require_justification, order_notes: order_notes.trim() || null },
    };
  });
  return (
    <Section title="Compras" desc="Padrões desta empresa no módulo Compras. O certificado digital fica na aba Certificados.">
      {ro && <p className="rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-secondary)]">Somente leitura: seu perfil não tem a permissão de configurar Compras.</p>}
      <fieldset disabled={ro} className="space-y-4">
        <div className={g2}>
          <Field label="Almoxarifado padrão" htmlFor="cp-loc">
            <select id="cp-loc" value={f.purchase_location_id} onChange={(e) => set('purchase_location_id', e.target.value)} className={inputCls}>
              <option value="">—</option>{pl.locations.filter((l) => (l.is_active && (!l.company_id || l.company_id === row.id)) || l.id === f.purchase_location_id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Responsável pelas compras" htmlFor="cp-mgr">
            <select id="cp-mgr" value={f.purchase_manager_id} onChange={(e) => set('purchase_manager_id', e.target.value)} className={inputCls}>
              <option value="">—</option>{members.map(([uid, name]) => <option key={uid} value={uid}>{name}</option>)}
            </select>
          </Field>
          <Field label="Centro de custo padrão" htmlFor="cp-cc">
            <select id="cp-cc" value={f.purchase_cost_center_id} onChange={(e) => set('purchase_cost_center_id', e.target.value)} className={inputCls}>
              <option value="">—</option>{lk.costCenters.filter((c) => c.is_active || c.id === f.purchase_cost_center_id).map((c) => <option key={c.id} value={c.id}>{c.code ? `${c.code} ` : ''}{c.name}</option>)}
            </select>
          </Field>
          <Field label="Conta financeira padrão" htmlFor="cp-acc">
            <select id="cp-acc" value={f.purchase_account_id} onChange={(e) => set('purchase_account_id', e.target.value)} className={inputCls}>
              <option value="">—</option>{lk.accounts.filter((a) => a.company_id === row.id && (a.is_active || a.id === f.purchase_account_id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
          <Field label="Plano de contas padrão das compras" htmlFor="cp-chart">
            <ChartPicker id="cp-chart" chart={lk.chart} kind="payable" value={f.purchase_chart_account_id} onChange={(v) => set('purchase_chart_account_id', v)} emptyLabel="—" />
          </Field>
          <Field label="Limite de compra sem aprovação" htmlFor="cp-lim" hint="Acima disso a requisição passa pelas alçadas.">
            <MoneyInput id="cp-lim" cents={f.purchase_limit_cents} onChange={(v) => set('purchase_limit_cents', v)} />
          </Field>
        </div>
        <h4 className="pt-2 text-sm font-semibold text-[var(--color-text-primary)]">Regras de requisição e pedido</h4>
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.purchase_requires_approval} onChange={(e) => set('purchase_requires_approval', e.target.checked)} /> Requisição precisa de aprovação</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={f.require_justification} onChange={(e) => set('require_justification', e.target.checked)} /> Exigir justificativa na requisição</label>
          <div className="grid max-w-md grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Mínimo de cotações" htmlFor="cp-minq"><input id="cp-minq" inputMode="numeric" value={f.min_quotes} onChange={(e) => set('min_quotes', e.target.value.replace(/\D/g, '').slice(0, 1))} placeholder="Ex.: 3" className={inputCls} /></Field>
          </div>
          <Field label="Observação padrão no pedido de compra" htmlFor="cp-on"><input id="cp-on" value={f.order_notes} onChange={(e) => set('order_notes', e.target.value.slice(0, 200))} placeholder="Ex.: Favor citar o número do pedido na nota fiscal." className={inputCls} /></Field>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">A aprovação por valor já funciona pelas alçadas abaixo. Limite, mínimo de cotações, justificativa e observação ficam registrados para a empresa; a trava automática deles nas telas de Compras entra na próxima etapa.</p>
      </fieldset>
      {!ro && <SaveBar dirty={form.dirty} busy={form.busy} onSave={save} onReset={form.reset} />}
      {canEdit && (
        <div className="space-y-3 border-t border-[var(--color-border-soft)] pt-5">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">Alçadas de aprovação (valem para todas as empresas)</h4>
          <Bands lookups={pl} />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ INTEGRAÇÕES
function IntegrationsTab({ row }: { row: CompanyRow }) {
  const lk = useFinanceLookups();
  const [cert, setCert] = useState<{ has_cert: boolean; enabled: boolean; cert_valid_until: string | null; last_sync_at: string | null } | null>(null);
  useEffect(() => {
    sefazApi<{ companies: Array<{ id: string; has_cert: boolean; enabled: boolean; cert_valid_until: string | null; last_sync_at: string | null }> }>('cert_status')
      .then((r) => setCert(r.companies.find((c) => c.id === row.id) ?? null)).catch(() => setCert(null));
  }, [row.id]);
  const banks = lk.accounts.filter((a) => a.company_id === row.id && a.kind === 'bank').length;
  const expired = cert?.cert_valid_until && new Date(cert.cert_valid_until).getTime() < Date.now();
  const items: Array<{ name: string; desc: string; on: boolean | null; detail: string; to?: string }> = [
    { name: 'NF-e de entrada (SEFAZ)', desc: 'Busca automática das notas contra o CNPJ', on: cert ? Boolean(cert.has_cert && cert.enabled && !expired) : null,
      detail: !cert ? '…' : !cert.has_cert ? 'Sem certificado' : expired ? 'Certificado vencido' : cert.enabled ? `Ativa${cert.last_sync_at ? ` · última busca ${new Date(cert.last_sync_at).toLocaleDateString('pt-BR')}` : ''}` : 'Desligada', to: `?aba=certificados` },
    { name: 'Bancos', desc: 'Contas bancárias desta empresa', on: banks > 0, detail: banks ? `${banks} conta(s)` : 'Nenhuma', to: '/financeiro?tab=bancos' },
    { name: 'ASAAS (boleto e PIX)', desc: 'Da organização (todas as empresas)', on: null, detail: 'Ver status', to: '/configuracoes/integracoes/asaas' },
    { name: 'WhatsApp e Instagram', desc: 'Canais da organização', on: null, detail: 'Ver canais', to: '/configuracoes/integracoes/canais' },
    { name: 'NFS-e / NFC-e (emissão)', desc: 'Emissão de notas de saída', on: false, detail: 'Ainda não disponível' },
    { name: 'Getnet / maquininhas', desc: 'Conciliação de cartão', on: false, detail: 'Ainda não disponível' },
    { name: 'ERP / API externa', desc: 'Use as chaves de API da organização', on: null, detail: 'Chaves de API', to: '/configuracoes/integracoes/api' },
  ];
  return (
    <Section title="Integrações" desc="O que está ligado para esta empresa.">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {items.map((it) => {
          const body = (
            <>
              <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                it.on === true ? 'bg-[rgba(34,197,94,0.12)] text-[var(--color-success)]' : it.on === false ? 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]' : 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]')}>
                {it.on === true ? <CheckCircle2 className="h-4 w-4" /> : it.on === false ? <CircleDashed className="h-4 w-4" /> : <Plug className="h-4 w-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-[var(--color-text-primary)]">{it.name}</span>
                <span className="block text-xs text-[var(--color-text-muted)]">{it.desc}</span>
              </span>
              <span className="text-right text-xs text-[var(--color-text-secondary)]">{it.detail}{it.to && <span className="ml-1 text-[var(--accent-primary)]">›</span>}</span>
            </>
          );
          return it.to
            ? <Link key={it.name} to={it.to} className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3 hover:border-[var(--accent-primary)]">{body}</Link>
            : <div key={it.name} className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3 opacity-80">{body}</div>;
        })}
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ USUÁRIOS
interface MemberLite { user_id: string; email: string; display_name: string | null; role_name: string | null; status: string; job_title: string | null }
function UsersTab({ row }: { row: CompanyRow }) {
  const perms = usePermission();
  const canEdit = perms.can('users.edit');
  const [members, setMembers] = useState<MemberLite[] | null>(null);
  const [links, setLinks] = useState<Array<{ user_id: string; company_id: string; is_default: boolean }>>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const load = useCallback(async () => {
    const sb = getSupabase();
    const [m, l] = await Promise.all([sb.rpc('list_members'), sb.from('fin_company_users').select('user_id, company_id, is_default')]);
    if (m.error) toast.error(companyError(m.error));
    if (l.error && !/fin_company_users/.test(l.error.message)) toast.error(companyError(l.error));
    if (l.error && /fin_company_users/.test(l.error.message)) toast.error('Falta rodar o SQL das Empresas (company_settings) no Supabase.');
    setMembers(((m.data ?? []) as MemberLite[]).filter((x) => x.status !== 'pending'));
    setLinks((l.data ?? []) as typeof links);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const mine = useMemo(() => new Map(links.filter((l) => l.company_id === row.id).map((l) => [l.user_id, l])), [links, row.id]);
  const defaultElsewhere = (uid: string) => links.some((l) => l.user_id === uid && l.is_default && l.company_id !== row.id);
  const setLink = async (uid: string, member: boolean, isDefault: boolean) => {
    setBusy(uid);
    const { error } = await getSupabase().rpc('fin_company_user_set', { p_company: row.id, p_user: uid, p_member: member, p_default: isDefault });
    setBusy(null);
    if (error) { toast.error(companyError(error)); return; }
    void load();
  };
  const list = (members ?? []).filter((m) => `${m.display_name ?? ''} ${m.email} ${m.role_name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Section title="Usuários" desc="Quem trabalha nesta empresa e qual é a empresa padrão de cada um."
      actions={perms.can('users.view') ? <Link to="/configuracoes/equipe/usuarios" className="text-sm font-semibold text-[var(--accent-primary)] hover:underline">Perfis e permissões ›</Link> : undefined}>
      <p className="rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-hover)] p-3 text-xs text-[var(--color-text-secondary)]">
        A empresa padrão já vem escolhida nos lançamentos e nas buscas de notas. Hoje quem tem acesso ao Financeiro/Compras vê todas as empresas do grupo;
        o perfil e as permissões de cada pessoa se definem em Equipe e acessos.
      </p>
      <label className="relative block max-w-sm"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pessoa" className={cn(inputCls, 'pl-9')} /></label>
      {!members ? <Skeleton className="h-40" /> : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-hover)] text-left text-[11px] uppercase text-[var(--color-text-muted)]">
              <tr><th className="px-3 py-2">Pessoa</th><th className="px-3 py-2">Perfil</th><th className="px-3 py-2 text-center">Trabalha aqui</th><th className="px-3 py-2 text-center">Empresa padrão</th></tr>
            </thead>
            <tbody>
              {list.map((m) => {
                const link = mine.get(m.user_id);
                return (
                  <tr key={m.user_id} className="border-t border-[var(--color-border-soft)]">
                    <td className="px-3 py-2"><div className="font-medium text-[var(--color-text-primary)]">{m.display_name || m.email}</div><div className="text-xs text-[var(--color-text-muted)]">{m.email}{m.status !== 'active' ? ' · inativo' : ''}</div></td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]"><span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />{m.role_name ?? '—'}</span></td>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" aria-label={`${m.display_name ?? m.email} trabalha nesta empresa`} disabled={!canEdit || busy === m.user_id} checked={Boolean(link)}
                        onChange={(e) => void setLink(m.user_id, e.target.checked, false)} className="h-4 w-4 accent-[var(--accent-fill)]" />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button type="button" disabled={!canEdit || busy === m.user_id} onClick={() => void setLink(m.user_id, true, !link?.is_default)}
                        title={defaultElsewhere(m.user_id) && !link?.is_default ? 'Hoje a padrão é outra empresa — clicar troca para esta.' : undefined}
                        className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold disabled:opacity-50',
                          link?.is_default ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]')}>
                        {busy === m.user_id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}{link?.is_default ? 'Padrão' : 'Tornar padrão'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && <tr><td colSpan={4} className="px-3 py-6 text-center text-sm text-[var(--color-text-muted)]">Ninguém encontrado.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
