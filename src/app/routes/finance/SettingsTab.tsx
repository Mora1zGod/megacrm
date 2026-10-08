import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Link } from 'react-router-dom';
import { Copy, KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { Field, inputCls } from './ui';

interface Status { configured: boolean; key_hint: string | null; env: 'sandbox' | 'production'; webhook_url: string; webhook_token: string | null }

async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabase().functions.invoke('fin-asaas', { body });
  if (data?.ok) return data as Record<string, unknown>;
  let m = data?.error as string | undefined;
  if (!m && error && 'context' in error) { try { m = (await (error as { context: Response }).context.json())?.error; } catch { /* */ } }
  throw new Error(m ?? 'A função de cobrança (fin-asaas) ainda não foi publicada no Supabase.');
}

// Financeiro → Configurações: integração de cobrança ASAAS.
export function SettingsTab() {
  const can = usePermission().can('financial.setup');
  const [st, setSt] = useState<Status | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [env, setEnv] = useState<'sandbox' | 'production'>('production');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try { const s = (await call({ action: 'config_status' })) as unknown as Status; setSt(s); setEnv(s.env); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  useEffect(() => { if (can) void load(); }, [can]);

  if (!can) return <p className="text-sm text-[var(--color-text-muted)]">Seu perfil não permite ver as configurações do Financeiro.</p>;

  const saveCfg = async (regenerate = false) => {
    setBusy(true);
    try {
      await call({ action: 'save_config', api_key: key.trim() || undefined, env, regenerate_token: regenerate });
      toast.success(regenerate ? 'Novo token gerado. Atualize no painel do ASAAS.' : 'Configuração salva.');
      setKey('');
      await load();
    } catch (e) { toast.error('Não foi possível salvar', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  const copy = (t: string) => { void navigator.clipboard.writeText(t); toast.success('Copiado.'); };

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="h-4 w-4" /> Certificado digital (SEFAZ)</h3>
          <p className="text-xs text-[var(--color-text-secondary)]">O certificado A1 de cada empresa fica em Configurações → Empresas → Certificados. Com ele o sistema puxa as notas de entrada sozinho.</p>
        </div>
        <Link to="/configuracoes/empresas" className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-fill)] px-3.5 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]">Abrir empresas</Link>
      </div>
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-[var(--accent-primary)]" /> Cobrança ASAAS (boleto e PIX)</h3>
        <p className="mb-3 text-sm text-[var(--color-text-secondary)]">
          Emite boleto/PIX de parcelas a receber. Quando o cliente paga, o ASAAS avisa o CRM e a baixa é feita sozinha no banco escolhido.
        </p>
        {err && <p className="mb-3 rounded-lg bg-[rgba(239,68,68,0.08)] px-3 py-2 text-sm text-[var(--color-error)]">{err}</p>}
        <div className="space-y-3">
          <Field label="Ambiente" htmlFor="as-env">
            <select id="as-env" value={env} onChange={(e) => setEnv(e.target.value as 'sandbox' | 'production')} className={inputCls}>
              <option value="production">Produção (cobranças de verdade)</option>
              <option value="sandbox">Sandbox (testes)</option>
            </select>
          </Field>
          <Field label="Chave da API" htmlFor="as-key" hint={st?.configured ? `Chave salva (${st.key_hint}). Preencha só para trocar.` : 'No ASAAS: Integrações → Chave de API.'}>
            <input id="as-key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} className={inputCls} placeholder={st?.configured ? '••••••••' : '$aact_...'} />
          </Field>
          <Button onClick={() => void saveCfg(false)} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar</Button>
        </div>
      </div>

      {st && (
        <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-sm">
          <h3 className="mb-1 font-semibold">Webhook (aviso de pagamento)</h3>
          <p className="mb-3 text-[var(--color-text-secondary)]">No painel do ASAAS, em Integrações → Webhooks → Cobranças, cadastre esta URL e este token de autenticação:</p>
          <div className="space-y-2">
            <CopyRow label="URL" value={st.webhook_url} onCopy={copy} />
            {st.webhook_token ? <CopyRow label="Token" value={st.webhook_token} onCopy={copy} /> : <p className="text-xs text-[var(--color-text-muted)]">Salve a configuração para gerar o token.</p>}
          </div>
          <Button variant="outline" size="sm" className="mt-3" disabled={busy} onClick={() => { if (window.confirm('Gerar um novo token? O antigo para de funcionar até você atualizar no ASAAS.')) void saveCfg(true); }}>
            <RefreshCw className="h-3.5 w-3.5" /> Gerar novo token
          </Button>
        </div>
      )}
    </div>
  );
}

function CopyRow({ label, value, onCopy }: { label: string; value: string; onCopy: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 text-xs font-semibold text-[var(--color-text-muted)]">{label}</span>
      <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className={`${inputCls} flex-1 font-mono text-xs`} />
      <Button size="sm" variant="outline" onClick={() => onCopy(value)} aria-label={`Copiar ${label}`}><Copy className="h-3.5 w-3.5" /></Button>
    </div>
  );
}
