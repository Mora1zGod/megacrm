import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { KeyRound, Loader2, Plus, ShieldAlert, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { formatBRL } from '@/lib/money';
import { formatDoc } from '../finance/SetupTab';
import { fmtDate, fmtDateTime, purError, sefazApi, type PurLookups } from './data';
import { Badge, Card, EmptyRow, Field, inputCls, MoneyInput, Spinner, TableWrap, tdCls, thCls } from './ui';

interface Band { id: string; min_cents: number; max_cents: number | null; access_role_id: string }
interface CertCompany {
  id: string; name: string; cnpj: string | null; is_default: boolean; is_active: boolean; has_cert: boolean; enabled: boolean;
  cert_cnpj: string | null; cert_subject: string | null; cert_valid_until: string | null; last_nsu: string | null; max_nsu: string | null;
  last_sync_at: string | null; next_sync_after: string | null; last_status: string | null;
}

// Compras → Configurações: só as regras de Compras. O certificado digital é da EMPRESA
// (Configurações → Empresas → Certificados); Compras e a busca na SEFAZ só o consomem.
export function PurchaseSettingsTab({ lookups }: { lookups: PurLookups }) {
  const def = lookups.companies.find((c) => c.is_default) ?? lookups.companies[0];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-sm">
        <span className="flex items-center gap-2 text-[var(--color-text-secondary)]"><KeyRound className="h-4 w-4 text-[var(--accent-primary)]" />
          O <b className="text-[var(--color-text-primary)]">certificado digital</b> e os padrões de Compras (almoxarifado, centro de custo, conta, limite e responsável) ficam no cadastro de cada empresa.</span>
        <Link to={def ? `/configuracoes/empresas/${def.id}?aba=certificados` : '/configuracoes/empresas'}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-fill)] px-3.5 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]">Abrir empresas</Link>
      </div>
      <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Alçadas de aprovação</h3>
      <Bands lookups={lookups} />
    </div>
  );
}

// Certificado A1 + busca na SEFAZ (usado em Configurações → Empresas → Certificados).
export function SefazSettings({ companyId }: { companyId?: string } = {}) {
  const [data, setData] = useState<{ strict_tls: boolean; companies: CertCompany[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [upload, setUpload] = useState<CertCompany | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setData(await sefazApi('cert_status')); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = async (key: string, action: string, body: Record<string, unknown>, ok?: string) => {
    setBusy(key);
    try { const r = await sefazApi<{ message?: string }>(action, body); toast.success(r.message ?? ok ?? 'Feito.'); void load(); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  if (error) return <p className="rounded-lg border border-[rgba(239,68,68,0.3)] p-3 text-sm text-[var(--color-error)]">{error}</p>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Com o certificado <b>A1</b> (.pfx/.p12) de cada empresa, o sistema busca na SEFAZ todas as NF-e emitidas contra o CNPJ, dá ciência e baixa o XML completo.
        O certificado e a senha ficam guardados <b>cifrados</b> no servidor e nunca voltam para a tela. Notas sem XML continuam podendo ser lançadas à mão (Notas de entrada → Lançamento manual).
      </p>
      {!data.strict_tls && (
        <p className="flex items-start gap-2 rounded-lg border border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] p-3 text-xs">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          A conexão com a SEFAZ é cifrada e usa o seu certificado, mas o servidor ainda não confere a cadeia ICP-Brasil do site da SEFAZ (variável SEFAZ_CA_PEM não configurada na Vercel).
        </p>
      )}
      {data.companies.filter((c) => !companyId || c.id === companyId).map((c) => {
        const expired = c.cert_valid_until && new Date(c.cert_valid_until).getTime() < Date.now();
        const soon = c.cert_valid_until && !expired && new Date(c.cert_valid_until).getTime() - Date.now() < 30 * 86400000;
        const days = c.cert_valid_until ? Math.ceil((new Date(c.cert_valid_until).getTime() - Date.now()) / 86400000) : null;
        const invalid = c.has_cert && !c.cert_valid_until;
        return (
          <Card key={c.id} title={<span className="flex items-center gap-2">{c.name}{c.is_default && <Badge tone="accent">padrão</Badge>}{!c.is_active && <Badge tone="muted">inativa</Badge>}</span>}
            actions={<>
              {c.has_cert && <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => run(c.id, 'remove_cert', { company_id: c.id }, 'Certificado removido.')}><Trash2 className="h-3.5 w-3.5" /> Remover</Button>}
              {c.has_cert && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={c.enabled} onChange={(e) => run(c.id, 'set_enabled', { company_id: c.id, enabled: e.target.checked }, e.target.checked ? 'Busca ligada.' : 'Busca desligada.')} /> Buscar notas desta empresa</label>}
              <Button size="sm" variant={c.has_cert ? 'outline' : 'default'} onClick={() => setUpload(c)}><Upload className="h-3.5 w-3.5" /> {c.has_cert ? 'Trocar certificado' : 'Enviar certificado'}</Button>
              {c.has_cert && c.enabled && <Button size="sm" disabled={busy === `s${c.id}`} onClick={() => run(`s${c.id}`, 'sync', { company_id: c.id })}>{busy === `s${c.id}` && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Buscar agora</Button>}
            </>}>
            <div className="grid gap-3 text-sm sm:grid-cols-4">
              <div><div className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">CNPJ da empresa</div>{c.cnpj ? formatDoc(c.cnpj) : c.cert_cnpj ? <span className="text-[var(--inbox-warn-text,#B45309)]">não cadastrado — usando o do certificado</span> : <span className="text-[var(--color-error)]">não cadastrado</span>}</div>
              <div><div className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">Certificado</div>
                {c.has_cert ? <span className="inline-flex items-center gap-1"><ShieldCheck className="h-4 w-4 text-[var(--color-success)]" /> {c.cert_cnpj ? formatDoc(c.cert_cnpj) : 'enviado'}</span> : <span className="text-[var(--color-text-muted)]">não enviado</span>}
              </div>
              <div><div className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">Validade</div>
                {c.cert_valid_until ? <span className={expired ? 'text-[var(--color-error)]' : soon ? 'text-[var(--inbox-warn-text,#B45309)]' : ''}>{fmtDate(c.cert_valid_until)}{expired ? ' (vencido)' : soon ? ' (vence em breve)' : ''}</span> : '—'}
              </div>
              <div><div className="text-[11px] font-semibold uppercase text-[var(--color-text-muted)]">Última busca</div>{c.last_sync_at ? fmtDateTime(c.last_sync_at) : '—'}
                {c.next_sync_after && new Date(c.next_sync_after).getTime() > Date.now() && <div className="text-xs text-[var(--color-text-muted)]">próxima liberada {fmtDateTime(c.next_sync_after)}</div>}
              </div>
            </div>
            {(expired || soon || invalid) && (
              <p className={`mt-3 flex items-center gap-2 rounded-lg border p-2.5 text-xs font-medium ${expired || invalid ? 'border-[rgba(239,68,68,0.35)] bg-[rgba(239,68,68,0.06)] text-[var(--color-error)]' : 'border-[rgba(245,158,11,0.4)] bg-[rgba(245,158,11,0.06)] text-[var(--inbox-warn-text,#B45309)]'}`}>
                <ShieldAlert className="h-4 w-4 shrink-0" />
                {invalid ? 'Certificado inválido: não foi possível ler a validade. Envie o arquivo de novo.'
                  : expired ? 'Certificado vencido: a busca na SEFAZ e a ciência das notas param até enviar um novo.'
                  : `Certificado vence em ${days} dia(s). Providencie a renovação para não parar a busca das notas.`}
              </p>
            )}
            {c.cert_subject && <p className="mt-2 truncate text-xs text-[var(--color-text-muted)]">{c.cert_subject}</p>}
            {c.last_status && <p className="mt-1 text-xs text-[var(--color-text-secondary)]">SEFAZ: {c.last_status}{c.last_nsu ? ` · NSU ${Number(c.last_nsu)}${c.max_nsu ? ` de ${Number(c.max_nsu)}` : ''}` : ''}</p>}
          </Card>
        );
      })}
      {data.companies.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Cadastre as empresas em Configurações → Empresas.</p>}
      <p className="text-xs text-[var(--color-text-muted)]">Certificado <b>A3</b> (cartão ou token USB) não serve para a busca automática: ele só funciona plugado no computador, e a busca roda no servidor. Use um A1 para a empresa.</p>
      {upload && <CertDialog company={upload} onClose={() => setUpload(null)} onDone={() => { setUpload(null); void load(); }} />}
    </div>
  );
}

function CertDialog({ company, onClose, onDone }: { company: CertCompany; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      const r = await sefazApi<{ cnpj: string | null; valid_until: string }>('save_cert', { company_id: company.id, pfx_base64: btoa(bin), password });
      toast.success(`Certificado salvo${r.cnpj ? ` (CNPJ ${formatDoc(r.cnpj)})` : ''}, válido até ${fmtDate(r.valid_until)}.`);
      onDone();
    } catch (e) { toast.error('Certificado', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); setPassword(''); }
  };
  return (
    <Dialog open onClose={onClose} opaque title={`Certificado digital · ${company.name}`} description="Arquivo A1 (.pfx ou .p12) e a senha dele. O CNPJ do certificado precisa ser o da empresa (ou da mesma raiz).">
      <div className="space-y-3">
        <Field label="Arquivo do certificado" required htmlFor="ct-file">
          <input id="ct-file" type="file" accept=".pfx,.p12,application/x-pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm" />
        </Field>
        <Field label="Senha do certificado" required htmlFor="ct-pass">
          <input id="ct-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
        </Field>
        <p className="flex items-start gap-2 text-xs text-[var(--color-text-muted)]"><KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" /> A senha é usada só no servidor para abrir o certificado e fica guardada cifrada junto com ele.</p>
      </div>
      <div className="flex justify-end gap-2 pt-5"><Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy || !file} onClick={send}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar certificado</Button></div>
    </Dialog>
  );
}

export function Bands({ lookups }: { lookups: PurLookups }) {
  const [rows, setRows] = useState<Band[] | null>(null);
  const [edit, setEdit] = useState<Band | 'new' | null>(null);
  const load = useCallback(async () => {
    const { data, error } = await getSupabase().from('pur_approval_bands').select('*').order('min_cents');
    if (error) toast.error(purError(error));
    setRows((data ?? []) as Band[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const role = (id: string) => lookups.roles.find((r) => r.id === id)?.name ?? '—';
  const remove = async (b: Band) => {
    const { error } = await getSupabase().from('pur_approval_bands').delete().eq('id', b.id);
    if (error) toast.error(purError(error)); else void load();
  };
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Defina quem aprova cada faixa de valor. A requisição é aprovada por quem tem a alçada do valor estimado; se a cotação passar do teto da faixa, precisa de nova aprovação.
        Sem faixa para um valor, qualquer pessoa com a permissão “Aprovar requisição” aprova. O Administrador aprova qualquer valor. <b>Quem pede nunca aprova o próprio pedido.</b>
      </p>
      <div className="flex justify-end"><Button onClick={() => setEdit('new')}><Plus className="h-4 w-4" /> Nova faixa</Button></div>
      {!rows ? <Spinner /> : (
        <TableWrap minWidth={520}>
          <thead><tr className="border-b border-[var(--color-border-card)]"><th className={thCls}>De</th><th className={thCls}>Até</th><th className={thCls}>Quem aprova (perfil)</th><th className={thCls}></th></tr></thead>
          <tbody>
            {rows.length === 0 && <EmptyRow cols={4} text="Nenhuma faixa: quem tem a permissão de aprovar aprova qualquer valor." />}
            {rows.map((b) => (
              <tr key={b.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className={`${tdCls} tabular-nums`}>{formatBRL(b.min_cents)}</td><td className={`${tdCls} tabular-nums`}>{b.max_cents !== null ? formatBRL(b.max_cents) : 'sem limite'}</td>
                <td className={tdCls}>{role(b.access_role_id)}</td>
                <td className={`${tdCls} text-right`}><Button size="sm" variant="ghost" onClick={() => setEdit(b)}>Editar</Button><Button size="sm" variant="ghost" onClick={() => remove(b)}><Trash2 className="h-3.5 w-3.5" /></Button></td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {edit && <BandForm band={edit === 'new' ? null : edit} lookups={lookups} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </div>
  );
}

function BandForm({ band, lookups, onClose, onSaved }: { band: Band | null; lookups: PurLookups; onClose: () => void; onSaved: () => void }) {
  const [min, setMin] = useState(band?.min_cents ?? 0);
  const [max, setMax] = useState(band?.max_cents ?? 0);
  const [noMax, setNoMax] = useState(band ? band.max_cents === null : false);
  const [roleId, setRoleId] = useState(band?.access_role_id ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} opaque title={band ? 'Editar faixa' : 'Nova faixa de aprovação'}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="De (valor)" required htmlFor="bd-min"><MoneyInput id="bd-min" cents={min} onChange={setMin} /></Field>
        <Field label="Até (valor)" htmlFor="bd-max"><MoneyInput id="bd-max" cents={max} onChange={setMax} disabled={noMax} /></Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={noMax} onChange={(e) => setNoMax(e.target.checked)} /> Sem limite máximo</label>
        <div className="sm:col-span-2"><Field label="Perfil que aprova" required htmlFor="bd-role">
          <select id="bd-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} className={inputCls}>
            <option value="">Escolha…</option>{lookups.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field></div>
      </div>
      <div className="flex justify-end gap-2 pt-5"><Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy || !roleId} onClick={async () => {
          if (!noMax && max < min) { toast.error('O “até” precisa ser maior que o “de”.'); return; }
          setBusy(true);
          const row = { min_cents: min, max_cents: noMax ? null : max, access_role_id: roleId };
          const sb = getSupabase();
          const { error } = band ? await sb.from('pur_approval_bands').update(row).eq('id', band.id) : await sb.from('pur_approval_bands').insert(row);
          setBusy(false);
          if (error) { toast.error(purError(error)); return; }
          toast.success('Faixa salva.'); onSaved();
        }}>Salvar</Button>
      </div>
    </Dialog>
  );
}
