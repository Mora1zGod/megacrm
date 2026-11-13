import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Activity, AlertTriangle, Bot, CheckCircle2, Clock, Loader2, MessageCircle, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatPhone } from '@/lib/format';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '../../providers/PermissionsProvider';

// /monitoramento — saúde do atendimento num lugar só (20261112190000_monitoring.sql → monitor_overview()).
// Nasceu do dia em que o número oficial ficou recusando tudo (Meta 131042) e o CRM mostrava "enviado".
// Os mesmos alertas do topo saem no WhatsApp (Edge Function monitor-alerts, a cada 15 min) para quem tem o
// assunto "Monitoramento" em Configurações → Notificações WhatsApp.

interface Canal {
  id: string; label: string | null; provider: string; phone: string | null; is_active: boolean; ai_enabled: boolean;
  total: number; enviadas: number; entregues: number; lidas: number; falhas: number; presas: number;
  ultima_entrega: string | null; ultimo_erro: string | null; ultimo_erro_em: string | null;
}
interface Overview {
  gerado_em: string;
  alertas: Array<{ kind: string; texto: string }>;
  canais: Canal[];
  erros: Array<{ motivo: string; qtd: number; ultima: string }>;
  esperando: { total: number; com_ia: number; mais_antiga: string | null };
  ia: { ligada: boolean; whatsapp: boolean; instagram: boolean } | null;
  ia_custo: { hoje_usd: number; mes_usd: number; respostas_mes: number } | null;
  wa_gasto: {
    por_categoria: Record<string, number>;
    precos: { marketing: number; utility: number; authentication: number };
    limite_mes_centavos: number; estimado_mes_centavos: number; alertas_ligados: boolean;
  } | null;
  webhook_ultimo: string | null;
  agendamentos_com_erro: Array<{ jobname: string; falhas: number; ultima: string; mensagem: string | null }>;
}

const fmtTime = (d: string | null) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const brl = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const usd = (v: number) => `US$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CAT: Record<string, string> = { marketing: 'Marketing', utility: 'Utilidade', authentication: 'Autenticação', sem_categoria: 'Sem categoria (conta como Utilidade)' };

function minutesSince(d: string | null): number | null {
  return d ? Math.round((Date.now() - new Date(d).getTime()) / 60000) : null;
}
function waitLabel(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ${min % 60} min` : `${Math.floor(h / 24)} dias`;
}

function Panel({ title, icon, children, right }: { title: string; icon: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-text-primary)]">{icon}{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-control)] bg-[var(--color-surface-raised)] px-3 py-2">
      <div className="truncate text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className={cn('text-lg font-semibold tabular-nums',
        tone === 'bad' ? 'text-[var(--color-error)]' : tone === 'warn' ? 'text-[#b45309] dark:text-[#fbbf24]' : tone === 'ok' ? 'text-[var(--color-success)]' : 'text-[var(--color-text-primary)]')}>{value}</div>
    </div>
  );
}

function SpendSettings({ data, canEdit, onSaved }: { data: NonNullable<Overview['wa_gasto']>; canEdit: boolean; onSaved: () => void }) {
  const { orgId } = useAppUser();
  const toTxt = (c: number) => (c ? (c / 100).toFixed(2).replace('.', ',') : '');
  const [f, setF] = useState({
    marketing: toTxt(data.precos.marketing), utility: toTxt(data.precos.utility), authentication: toTxt(data.precos.authentication),
    limite: toTxt(data.limite_mes_centavos), alertas: data.alertas_ligados,
  });
  const [saving, setSaving] = useState(false);
  const cents = (t: string) => Math.max(0, Math.round(Number(t.replace(/\./g, '').replace(',', '.') || 0) * 100));
  const save = async () => {
    setSaving(true);
    const { error } = await getSupabase().from('app_settings').update({
      wa_price_marketing_cents: cents(f.marketing), wa_price_utility_cents: cents(f.utility), wa_price_auth_cents: cents(f.authentication),
      wa_budget_month_cents: cents(f.limite), monitor_alerts_enabled: f.alertas,
    }).eq('org_id', orgId);
    setSaving(false);
    if (error) { toast.error('Não consegui salvar.', { description: error.message }); return; }
    toast.success('Configuração salva.');
    onSaved();
  };
  const input = 'h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-60';
  return (
    <div className="mt-4 space-y-3 border-t border-[var(--color-border-soft)] pt-3">
      <p className="text-xs text-[var(--color-text-muted)]">
        Preço por mensagem de modelo (R$), conforme a tabela da Meta para o Brasil que aparece na sua fatura. A conta aqui é uma
        estimativa; o valor oficial é o da cobrança da Meta.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([['marketing', 'Marketing'], ['utility', 'Utilidade'], ['authentication', 'Autenticação'], ['limite', 'Limite no mês']] as const).map(([k, l]) => (
          <label key={k} className="space-y-1 text-xs text-[var(--color-text-secondary)]">
            <span>{l} (R$)</span>
            <input className={input} inputMode="decimal" disabled={!canEdit} value={f[k]} placeholder="0,00"
              onChange={(e) => setF({ ...f, [k]: e.target.value.replace(/[^\d,.]/g, '') })} />
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
        <input type="checkbox" className="h-4 w-4" disabled={!canEdit} checked={f.alertas} onChange={(e) => setF({ ...f, alertas: e.target.checked })} />
        Mandar alertas no WhatsApp (falhas, mensagens presas, clientes esperando, gasto em 80% do limite)
      </label>
      {canEdit && <Button size="sm" disabled={saving} onClick={() => void save()}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Salvar</Button>}
    </div>
  );
}

export default function MonitorPage() {
  const perms = usePermission();
  const canEdit = perms.can('settings.edit');
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data: d, error: e } = await getSupabase().rpc('monitor_overview');
    setLoading(false);
    if (e) {
      setError(/monitor_overview|schema cache|does not exist/i.test(e.message)
        ? 'Falta rodar o SQL do monitoramento (20261112190000_monitoring.sql) no banco.' : e.message);
      return;
    }
    setError(null);
    setData(d as Overview);
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const g = data?.wa_gasto;
  const pct = g && g.limite_mes_centavos > 0 ? Math.min(100, Math.round((g.estimado_mes_centavos / g.limite_mes_centavos) * 100)) : null;
  const sinceWebhook = minutesSince(data?.webhook_ultimo ?? null);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent-subtle)]"><Activity className="h-5 w-5 text-[var(--accent-primary)]" /></span>
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">Monitoramento</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">Envio do WhatsApp, AMAIA, clientes esperando e gastos. Atualiza sozinho a cada minuto.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} {data ? `Atualizado ${fmtTime(data.gerado_em)}` : 'Atualizar'}
        </Button>
      </div>

      {error && <div className="rounded-[var(--radius-card)] border border-[var(--color-error)] bg-[rgba(220,38,38,0.08)] p-3 text-sm text-[var(--color-error)]">{error}</div>}
      {!data && !error && <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-[var(--accent-primary)]" /></div>}

      {data && (
        <>
          {data.alertas.length === 0 ? (
            <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-[rgba(34,197,94,0.4)] bg-[rgba(34,197,94,0.08)] p-3 text-sm text-[var(--color-text-primary)]">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-[var(--color-success)]" /> Tudo funcionando: nenhum alerta agora.
            </div>
          ) : (
            <div className="space-y-2 rounded-[var(--radius-card)] border border-[var(--color-error)] bg-[rgba(220,38,38,0.06)] p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--color-error)]"><AlertTriangle className="h-4 w-4" /> {data.alertas.length} alerta(s)</div>
              {data.alertas.map((a) => <p key={a.kind} className="text-sm text-[var(--color-text-primary)]">{a.texto}</p>)}
            </div>
          )}

          <Panel title="Envio por número (últimas 24 h)" icon={<MessageCircle className="h-4 w-4 text-[var(--accent-primary)]" />}>
            <div className="space-y-3">
              {data.canais.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum número cadastrado.</p>}
              {data.canais.map((c) => {
                const oficial = c.provider === 'zernio';
                const failRate = c.total ? Math.round((c.falhas / c.total) * 100) : 0;
                return (
                  <div key={c.id} className={cn('rounded-[var(--radius-control)] border p-3', c.falhas >= 5 && failRate >= 20 ? 'border-[var(--color-error)]' : 'border-[var(--color-border-soft)]', !c.is_active && 'opacity-60')}>
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[var(--color-text-primary)]">{c.label || 'Número'}</span>
                      {c.phone && <span className="text-sm text-[var(--color-text-muted)]">{formatPhone(c.phone)}</span>}
                      <span className="rounded-md bg-[var(--color-fill-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)]">{oficial ? 'Oficial (Meta)' : 'UAZAPI'}</span>
                      {!c.is_active && <span className="rounded-md bg-[var(--color-fill-subtle)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)]">desativado</span>}
                      <span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-semibold', c.ai_enabled ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)]')}>
                        {c.ai_enabled ? 'AMAIA neste número' : 'Sem AMAIA neste número'}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                      <Stat label="Enviadas" value={c.total} />
                      <Stat label={oficial ? 'Entregues + lidas' : 'Entregues (sem confirmação)'} value={oficial ? c.entregues + c.lidas : '—'} tone={oficial && c.total > 0 && c.entregues + c.lidas === 0 ? 'bad' : 'ok'} />
                      <Stat label="Falharam" value={`${c.falhas}${c.total ? ` (${failRate}%)` : ''}`} tone={c.falhas >= 5 && failRate >= 20 ? 'bad' : c.falhas ? 'warn' : undefined} />
                      <Stat label="Presas em “enviado” +30 min" value={oficial ? c.presas : '—'} tone={oficial && c.presas >= 10 ? 'warn' : undefined} />
                      <Stat label="Última entrega confirmada" value={<span className="text-sm">{oficial ? fmtTime(c.ultima_entrega) : '—'}</span>} />
                    </div>
                    {c.ultimo_erro && (
                      <p className="mt-2 text-xs text-[var(--color-error)]">Última falha ({fmtTime(c.ultimo_erro_em)}): {c.ultimo_erro}</p>
                    )}
                  </div>
                );
              })}
              {data.erros.length > 0 && (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Motivos de falha (24 h)</div>
                  <ul className="space-y-1 text-sm">
                    {data.erros.map((e) => (
                      <li key={e.motivo} className="flex gap-2"><span className="w-10 shrink-0 text-right font-semibold tabular-nums text-[var(--color-error)]">{e.qtd}×</span><span className="text-[var(--color-text-secondary)]">{e.motivo}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Clientes esperando resposta" icon={<Clock className="h-4 w-4 text-[var(--accent-primary)]" />}
              right={<Link to="/inbox" className="text-sm font-semibold text-[var(--accent-primary)]">Abrir Atendimento</Link>}>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="Esperando +10 min" value={data.esperando.total} tone={data.esperando.total >= 10 ? 'bad' : data.esperando.total ? 'warn' : 'ok'} />
                <Stat label="Com a AMAIA ligada" value={data.esperando.com_ia} tone={data.esperando.com_ia ? 'warn' : undefined} />
                <Stat label="Mais antiga" value={<span className="text-sm">{waitLabel(minutesSince(data.esperando.mais_antiga))}</span>} />
              </div>
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">Conversas abertas dos últimos 3 dias em que a última mensagem é do cliente.</p>
            </Panel>

            <Panel title="AMAIA" icon={<Bot className="h-4 w-4 text-[var(--accent-primary)]" />}
              right={<Link to="/ai-agent" className="text-sm font-semibold text-[var(--accent-primary)]">Agente de IA</Link>}>
              <div className="grid grid-cols-3 gap-2">
                <Stat label="WhatsApp" value={data.ia?.ligada && data.ia?.whatsapp ? 'Ligada' : 'Pausada'} tone={data.ia?.ligada && data.ia?.whatsapp ? 'ok' : 'warn'} />
                <Stat label="Instagram" value={data.ia?.ligada && data.ia?.instagram ? 'Ligada' : 'Pausada'} tone={data.ia?.ligada && data.ia?.instagram ? 'ok' : 'warn'} />
                <Stat label="Respostas no mês" value={data.ia_custo?.respostas_mes ?? 0} />
                <Stat label="Custo da IA hoje" value={<span className="text-base">{usd(data.ia_custo?.hoje_usd ?? 0)}</span>} />
                <Stat label="Custo da IA no mês" value={<span className="text-base">{usd(data.ia_custo?.mes_usd ?? 0)}</span>} />
                <Stat label="Última msg de cliente" value={<span className="text-sm">{sinceWebhook === null ? '—' : `há ${waitLabel(sinceWebhook)}`}</span>} tone={sinceWebhook !== null && sinceWebhook > 120 ? 'warn' : undefined} />
              </div>
            </Panel>
          </div>

          {g && (
            <Panel title="Gasto do WhatsApp no mês (estimativa)" icon={<Wallet className="h-4 w-4 text-[var(--accent-primary)]" />}>
              <div className="grid gap-2 sm:grid-cols-3">
                <Stat label="Estimado no mês" value={brl(g.estimado_mes_centavos)} tone={pct !== null && pct >= 80 ? 'bad' : undefined} />
                <Stat label="Limite no mês" value={g.limite_mes_centavos ? brl(g.limite_mes_centavos) : 'não definido'} />
                <Stat label="Modelos enviados" value={Object.values(g.por_categoria).reduce((a, b) => a + Number(b), 0)} />
              </div>
              {pct !== null && (
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--color-border-soft)]">
                  <div className={cn('h-full rounded-full', pct >= 80 ? 'bg-[var(--color-error)]' : 'bg-[var(--accent-fill)]')} style={{ width: `${pct}%` }} />
                </div>
              )}
              {Object.keys(g.por_categoria).length > 0 && (
                <ul className="mt-3 space-y-1 text-sm text-[var(--color-text-secondary)]">
                  {Object.entries(g.por_categoria).map(([k, n]) => <li key={k}>{CAT[k] ?? k}: <b className="text-[var(--color-text-primary)]">{n}</b></li>)}
                </ul>
              )}
              <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                Conta só mensagens de modelo (campanhas e mensagens fora das 24 h); respostas dentro da janela de 24 h não entram aqui.
              </p>
              <SpendSettings key={data.gerado_em} data={g} canEdit={canEdit} onSaved={() => void load()} />
            </Panel>
          )}

          {data.agendamentos_com_erro.length > 0 && (
            <Panel title="Agendamentos com erro (24 h)" icon={<AlertTriangle className="h-4 w-4 text-[var(--color-error)]" />}>
              <ul className="space-y-1 text-sm">
                {data.agendamentos_com_erro.map((j) => (
                  <li key={j.jobname} className="text-[var(--color-text-secondary)]"><b className="text-[var(--color-text-primary)]">{j.jobname}</b>: {j.falhas} falha(s), última {fmtTime(j.ultima)}{j.mensagem ? ` — ${j.mensagem}` : ''}</li>
                ))}
              </ul>
            </Panel>
          )}

          <p className="text-xs text-[var(--color-text-muted)]">
            Alertas no WhatsApp: em Configurações → Notificações WhatsApp, marque o assunto <b>Monitoramento</b> em quem deve receber.
            Cada alerta se repete no máximo a cada 2 horas.
          </p>
        </>
      )}
    </div>
  );
}
