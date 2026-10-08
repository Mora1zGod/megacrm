import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronRight, FileBadge2, Loader2, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatDoc, maskCNPJ, onlyDigits } from '@/lib/format';
import { lookupCnpj } from '@/lib/cnpj-lookup';
import { Field, inputCls } from '@/app/routes/settings/sections/access/ui';
import { sefazApi } from '@/app/routes/purchases/data';
import { Logo } from './CompanyEditor';
import { companyError, updateCompany, type CompanyRow } from './companyData';

type CertInfo = { id: string; has_cert: boolean; cert_valid_until: string | null };

// Configurações → Empresas: lista das empresas do grupo (desta organização).
export function CompaniesSection() {
  const navigate = useNavigate();
  const perms = usePermission();
  const [rows, setRows] = useState<CompanyRow[] | null>(null);
  const [certs, setCerts] = useState<Map<string, CertInfo>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase().from('fin_companies').select('*').order('is_default', { ascending: false }).order('name');
    if (err) setError(companyError(err)); else { setRows((data ?? []) as CompanyRow[]); setError(null); }
    if (perms.can('purchases.view')) {
      sefazApi<{ companies: CertInfo[] }>('cert_status').then((r) => setCerts(new Map(r.companies.map((c) => [c.id, c])))).catch(() => undefined);
    }
  }, [perms]);
  useEffect(() => { void load(); }, [load]);

  const t = q.trim().toLowerCase();
  const d = onlyDigits(q);
  const list = (rows ?? []).filter((r) => !t || `${r.name} ${r.legal_name ?? ''} ${r.city ?? ''}`.toLowerCase().includes(t) || (d.length >= 3 && (r.cnpj ?? '').includes(d)));

  const certBadge = (id: string) => {
    const c = certs.get(id);
    if (!c) return null;
    if (!c.has_cert) return <span className="text-[var(--color-text-muted)]">sem certificado</span>;
    const days = c.cert_valid_until ? Math.ceil((new Date(c.cert_valid_until).getTime() - Date.now()) / 86400000) : null;
    if (days === null) return <span className="text-[var(--color-error)]">certificado inválido</span>;
    if (days < 0) return <span className="font-semibold text-[var(--color-error)]">certificado vencido</span>;
    if (days <= 30) return <span className="font-semibold text-[var(--inbox-warn-text,#B45309)]">certificado vence em {days} dia(s)</span>;
    return <span className="text-[var(--color-success)]">certificado A1 até {new Date(c.cert_valid_until!).toLocaleDateString('pt-BR')}</span>;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por nome, CNPJ ou cidade…" className={cn(inputCls, 'pl-9')} />
        </label>
        {perms.can('financial.setup') && <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Nova empresa</Button>}
      </div>
      {error && <p className="rounded-lg border border-[rgba(239,68,68,0.3)] p-3 text-sm text-[var(--color-error)]">{error}</p>}
      {!rows ? <div className="space-y-2"><Skeleton className="h-16" /><Skeleton className="h-16" /></div> : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
          {list.length === 0 && <p className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">Nenhuma empresa encontrada.</p>}
          {list.map((r) => (
            <button key={r.id} type="button" onClick={() => navigate(`/configuracoes/empresas/${r.id}`)}
              className="flex w-full items-center gap-4 border-b border-[var(--color-border-soft)] px-4 py-3 text-left last:border-0 hover:bg-[var(--color-surface-hover)]">
              <Logo url={r.logo_url} name={r.name} size={44} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-semibold text-[var(--color-text-primary)]">{r.name}</span>
                  {r.is_default && <span className="rounded-full bg-[var(--color-accent-subtle)] px-2 py-0.5 text-[10px] font-semibold text-[var(--accent-primary)]">padrão</span>}
                </span>
                <span className="block truncate text-xs text-[var(--color-text-muted)]">{[r.cnpj ? formatDoc(r.cnpj) : 'CNPJ não informado', r.legal_name, r.city && `${r.city}${r.state ? `/${r.state}` : ''}`].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="hidden items-center gap-1.5 text-xs md:flex"><FileBadge2 className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />{certBadge(r.id) ?? <span className="text-[var(--color-text-muted)]">—</span>}</span>
              <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold', r.is_active ? 'bg-[rgba(34,197,94,0.12)] text-[var(--color-success)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]')}>{r.is_active ? 'Ativa' : 'Inativa'}</span>
              <ChevronRight className="h-4 w-4 text-[var(--color-text-muted)]" />
            </button>
          ))}
        </div>
      )}
      <p className="text-xs text-[var(--color-text-muted)]">{rows?.length ?? 0} empresa(s) nesta organização. Outras organizações (contas separadas) ficam em Sistema → Organizações, só para o administrador da instância.</p>
      {creating && <NewCompanyDialog onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); navigate(`/configuracoes/empresas/${id}`); }} />}
    </div>
  );
}

function NewCompanyDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [cnpj, setCnpj] = useState('');
  const [name, setName] = useState('');
  const [legal, setLegal] = useState('');
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const doLookup = async () => {
    if (onlyDigits(cnpj).length !== 14) { toast.error('Digite os 14 números do CNPJ.'); return; }
    setLooking(true);
    try { const r = await lookupCnpj(cnpj); setLegal(r.razao_social ?? ''); setName((n) => n || r.nome_fantasia || r.razao_social || ''); }
    catch (e) { toast.error('Consulta do CNPJ', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setLooking(false); }
  };
  const create = async () => {
    if (name.trim().length < 2) { toast.error('Informe o nome fantasia.'); return; }
    const doc = onlyDigits(cnpj);
    if (doc && doc.length !== 14) { toast.error('O CNPJ tem 14 números.'); return; }
    setBusy(true);
    try {
      const { data, error } = await getSupabase().from('fin_companies').insert({ name: name.trim(), cnpj: doc || null }).select('id').single();
      if (error) throw new Error(companyError(error));
      if (legal.trim()) await updateCompany(String(data.id), { legal_name: legal.trim() }).catch(() => undefined);
      toast.success('Empresa criada. Complete o cadastro.');
      onCreated(String(data.id));
    } catch (e) { toast.error('Não foi possível criar', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} opaque title="Nova empresa" description="Com o CNPJ o sistema puxa os dados da Receita; depois é só completar o cadastro.">
      <div className="space-y-3">
        <Field label="CNPJ" htmlFor="nc-cnpj">
          <div className="flex gap-2">
            <input id="nc-cnpj" inputMode="numeric" value={cnpj} onChange={(e) => setCnpj(maskCNPJ(e.target.value))} placeholder="00.000.000/0000-00" className={inputCls} />
            <Button type="button" variant="outline" className="h-10 shrink-0" disabled={looking} onClick={() => void doLookup()}>{looking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />} Buscar</Button>
          </div>
        </Field>
        <Field label="Razão social" htmlFor="nc-legal"><input id="nc-legal" value={legal} onChange={(e) => setLegal(e.target.value)} className={inputCls} /></Field>
        <Field label="Nome fantasia" required htmlFor="nc-name"><input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} /></Field>
      </div>
      <div className="flex justify-end gap-2 pt-5"><Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={() => void create()}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Criar empresa</Button></div>
    </Dialog>
  );
}
