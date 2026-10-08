import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Activity, BellRing, Bot, CheckCircle2, ChevronRight, CircleDashed, Copy, Instagram, KeyRound, Loader2, Mail, MessageCircle, RefreshCw, Webhook, Wallet, XCircle, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase, getSupabaseCredentials } from '@/lib/supabase';
import { useAuth } from '@/app/providers/AuthProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useIntegrationsStatus } from '@/hooks/useIntegrationsStatus';
import { formatPhone } from '@/lib/format';

interface ChannelRow { id: string; provider: 'zernio' | 'uazapi'; label: string; phone: string | null; zernio_account_id: string | null; is_active: boolean }
interface Live {
  channels: ChannelRow[];
  platform: Record<string, string>;                         // zernio_account_id → whatsapp | instagram
  uazapi: Record<string, { connected: boolean; status: string | null }>;
  zernioOk: boolean | null; instagram: boolean | null;
  lastByChannel: Record<string, string>;                      // última mensagem por canal
  apiKeys: number | null;
  asaas: { configured: boolean; env: string } | null;
  checkedAt: string;
}

export const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Rio_Branco', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');

// Estado de todas as integrações (consultado ao vivo: Zernio, UAZAPI, chaves e ASAAS).
export function useIntegrationsLive() {
  const { session } = useAuth();
  const perms = usePermission();
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    const auth = { Authorization: `Bearer ${session.access_token}` };
    const sb = getSupabase();
    const json = async <T,>(p: Promise<Response>): Promise<T | null> => { try { const r = await p; return r.ok ? ((await r.json()) as T) : null; } catch { return null; } };
    const [ch, zc, uz, conv, keys, asaas] = await Promise.all([
      sb.from('channels').select('id, provider, label, phone, zernio_account_id, is_active').order('created_at'),
      json<{ connected?: boolean; instagramConnected?: boolean; channels?: Array<{ zernio_account_id: string | null; platform: string | null }> }>(fetch('/api/zernio-connect', { headers: auth })),
      json<{ channels?: Array<{ id: string; connected: boolean; status: string | null }> }>(fetch('/api/uazapi?action=connect', { headers: auth })),
      sb.from('conversations').select('channel_id, last_message_at').not('channel_id', 'is', null).order('last_message_at', { ascending: false }).limit(500),
      perms.can('settings.integrations') ? json<{ keys?: Array<{ revoked_at: string | null }> }>(fetch('/api/api-keys', { headers: auth })) : Promise.resolve(null),
      perms.can('financial.setup')
        ? sb.functions.invoke('fin-asaas', { body: { action: 'config_status' } }).then((r) => (r.data?.ok ? { configured: Boolean(r.data.configured), env: String(r.data.env ?? '') } : null)).catch(() => null)
        : Promise.resolve(null),
    ]);
    const platform: Record<string, string> = {};
    for (const c of zc?.channels ?? []) if (c.zernio_account_id && c.platform) platform[c.zernio_account_id] = c.platform;
    const uazapi: Live['uazapi'] = {};
    for (const c of uz?.channels ?? []) uazapi[c.id] = { connected: c.connected, status: c.status };
    const lastByChannel: Record<string, string> = {};
    for (const r of (conv.data ?? []) as Array<{ channel_id: string; last_message_at: string | null }>) if (r.last_message_at && !lastByChannel[r.channel_id]) lastByChannel[r.channel_id] = r.last_message_at;
    setLive({
      channels: (ch.data ?? []) as ChannelRow[], platform, uazapi, zernioOk: zc ? Boolean(zc.connected) : null, instagram: zc ? Boolean(zc.instagramConnected) : null,
      lastByChannel, apiKeys: keys ? (keys.keys ?? []).filter((k) => !k.revoked_at).length : null, asaas, checkedAt: new Date().toISOString(),
    });
    setBusy(false);
  }, [session, perms]);
  useEffect(() => { void load(); }, [load]);
  return { live, busy, reload: load };
}

export function channelState(live: Live, c: ChannelRow): { platform: 'whatsapp' | 'instagram'; connected: boolean | null; detail: string } {
  const platform = c.provider === 'zernio' && c.zernio_account_id && live.platform[c.zernio_account_id] === 'instagram' ? 'instagram' : 'whatsapp';
  if (!c.is_active) return { platform, connected: false, detail: 'Desativado' };
  if (c.provider === 'uazapi') {
    const u = live.uazapi[c.id];
    return { platform, connected: u ? u.connected : null, detail: u ? (u.connected ? 'Conectado' : `Desconectado${u.status ? ` (${u.status})` : ''}`) : 'Sem resposta' };
  }
  const known = c.zernio_account_id ? c.zernio_account_id in live.platform : false;
  return { platform, connected: live.zernioOk === null ? null : known, detail: live.zernioOk === null ? 'Sem resposta' : known ? 'Conectado' : 'Conta não encontrada no Zernio' };
}

function Dot({ on }: { on: boolean | null }) {
  return on === null ? <CircleDashed className="h-4 w-4 text-[var(--color-text-muted)]" />
    : on ? <CheckCircle2 className="h-4 w-4 text-[var(--color-success)]" /> : <XCircle className="h-4 w-4 text-[var(--color-error)]" />;
}

interface CardDef { id: string; title: string; icon: LucideIcon; tone: string; status: string; on: boolean | null; meta?: string; to: string; cta: string; show: boolean }

// Comunicação e integrações: cartões com status, conectado/desconectado, última atividade, configurar e testar.
export function IntegrationsHub() {
  const perms = usePermission();
  const { statuses } = useIntegrationsStatus();
  const { live, busy, reload } = useIntegrationsLive();
  const cred = (k: string) => statuses.find((s) => s.key === k)?.configured ?? null;
  const chans = live?.channels ?? [];
  const st = live ? chans.map((c) => ({ c, s: channelState(live, c) })) : [];
  const wa = st.filter((x) => x.s.platform === 'whatsapp');
  const ig = st.filter((x) => x.s.platform === 'instagram');
  const last = (list: typeof st) => list.map((x) => live?.lastByChannel[x.c.id]).filter(Boolean).sort().pop();
  const cards: CardDef[] = [
    { id: 'whatsapp', title: 'WhatsApp', icon: MessageCircle, tone: 'bg-[rgba(34,197,94,0.12)] text-[#16a34a]', show: perms.can('settings.channels'),
      on: !live ? null : wa.length ? wa.every((x) => x.s.connected) : false,
      status: !live ? 'Verificando…' : wa.length ? `${wa.filter((x) => x.s.connected).length} de ${wa.length} número(s) conectado(s)` : 'Nenhum número', meta: last(wa) ? `Última mensagem ${fmtWhen(last(wa))}` : undefined,
      to: '/configuracoes/integracoes/canais', cta: 'Configurar' },
    { id: 'avisos', title: 'Notificações WhatsApp', icon: BellRing, tone: 'bg-[rgba(34,197,94,0.12)] text-[#16a34a]', show: perms.can('settings.channels') || perms.can('financial.ledger_view'),
      on: null, status: 'Número UAZAPI que envia os avisos', meta: 'Contas a pagar e outros avisos para pessoas e grupos', to: '/configuracoes/integracoes/avisos', cta: 'Configurar' },
    { id: 'instagram', title: 'Instagram', icon: Instagram, tone: 'bg-[rgba(221,42,123,0.12)] text-[#DD2A7B]', show: perms.can('settings.channels'),
      on: live ? (live.instagram ?? null) : null, status: !live ? 'Verificando…' : live.instagram ? 'Conectado' : live.instagram === false ? 'Não conectado' : 'Sem resposta',
      meta: last(ig) ? `Última mensagem ${fmtWhen(last(ig))}` : undefined, to: '/configuracoes/integracoes/canais', cta: 'Configurar' },
    { id: 'email', title: 'E-mail (SMTP)', icon: Mail, tone: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]', show: true,
      on: cred('smtp_host'), status: cred('smtp_host') ? 'Configurado' : cred('smtp_host') === false ? 'Não configurado' : 'Verificando…', meta: 'Usado nos e-mails do sistema (convites, senha)',
      to: '/configuracoes/integracoes/externas', cta: 'Ver status' },
    { id: 'api', title: 'APIs', icon: KeyRound, tone: 'bg-[rgba(245,158,11,0.12)] text-[#d97706]', show: perms.can('settings.integrations'),
      on: live?.apiKeys === null || !live ? null : live.apiKeys > 0, status: !live ? 'Verificando…' : live.apiKeys === null ? '—' : `${live.apiKeys} chave(s) ativa(s)`,
      to: '/configuracoes/integracoes/api', cta: 'Gerenciar' },
    { id: 'webhooks', title: 'Webhooks', icon: Webhook, tone: 'bg-[rgba(99,102,241,0.12)] text-[#6366f1]', show: perms.can('settings.integrations') || perms.can('settings.channels'),
      on: null, status: 'Endereços que recebem os avisos', meta: 'Zernio, UAZAPI e ASAAS', to: '/configuracoes/integracoes/webhooks', cta: 'Ver endereços' },
    { id: 'ia', title: 'IA e serviços externos', icon: Bot, tone: 'bg-[rgba(14,165,233,0.12)] text-[#0284c7]', show: true,
      on: cred('openai_api_key') === null ? null : Boolean(cred('openai_api_key') && cred('llm_api_key')),
      status: [cred('openai_api_key') ? 'OpenAI ✓' : 'OpenAI pendente', cred('llm_api_key') ? 'LLM do agente ✓' : 'LLM pendente'].join(' · '),
      to: '/configuracoes/integracoes/externas', cta: 'Ver status' },
    { id: 'asaas', title: 'ASAAS (boleto e PIX)', icon: Wallet, tone: 'bg-[rgba(14,116,144,0.12)] text-[#0e7490]', show: perms.can('financial.setup'),
      on: live?.asaas ? live.asaas.configured : null, status: !live ? 'Verificando…' : live.asaas ? (live.asaas.configured ? `Configurado (${live.asaas.env === 'sandbox' ? 'testes' : 'produção'})` : 'Não configurado') : 'Função não publicada',
      to: '/configuracoes/integracoes/asaas', cta: 'Configurar' },
    { id: 'status', title: 'Status dos canais', icon: Activity, tone: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]', show: perms.can('settings.channels'),
      on: !live ? null : st.length ? st.every((x) => x.s.connected) : null, status: !live ? 'Verificando…' : `${st.filter((x) => x.s.connected).length} de ${st.length} conectado(s)`,
      meta: live ? `Conferido ${fmtWhen(live.checkedAt)}` : undefined, to: '/configuracoes/integracoes/status', cta: 'Ver detalhes' },
  ];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void reload().then(() => toast.success('Conexões testadas agora.')); }}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Testar conexões
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.filter((c) => c.show).map((c) => (
          <Link key={c.id} to={c.to} className="group flex flex-col gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--accent-primary)]">
            <div className="flex items-center gap-3">
              <span className={cn('flex h-10 w-10 items-center justify-center rounded-[var(--radius-control)]', c.tone)}><c.icon className="h-5 w-5" /></span>
              <span className="min-w-0 flex-1 font-semibold text-[var(--color-text-primary)]">{c.title}</span>
              <Dot on={c.on} />
            </div>
            <div className="min-h-[2.5rem]">
              <p className="text-sm text-[var(--color-text-secondary)]">{c.status}</p>
              {c.meta && <p className="text-xs text-[var(--color-text-muted)]">{c.meta}</p>}
            </div>
            <span className="flex items-center gap-1 text-sm font-semibold text-[var(--accent-primary)]">{c.cta} <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" /></span>
          </Link>
        ))}
      </div>
    </div>
  );
}

// Status detalhado de cada canal (teste ao vivo).
export function ChannelsStatus() {
  const { live, busy, reload } = useIntegrationsLive();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--color-text-secondary)]">Conferido agora no provedor (Zernio / UAZAPI). {live && <span className="text-[var(--color-text-muted)]">Última verificação {fmtWhen(live.checkedAt)}.</span>}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void reload()}>{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Testar conexão</Button>
      </div>
      {!live ? <Skeleton className="h-40" /> : (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-hover)] text-left text-[11px] uppercase text-[var(--color-text-muted)]">
              <tr><th className="px-3 py-2">Canal</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Provedor</th><th className="px-3 py-2">Situação</th><th className="px-3 py-2">Última mensagem</th></tr>
            </thead>
            <tbody>
              {live.channels.length === 0 && <tr><td colSpan={5} className="px-3 py-6 text-center text-[var(--color-text-muted)]">Nenhum canal cadastrado.</td></tr>}
              {live.channels.map((c) => {
                const s = channelState(live, c);
                return (
                  <tr key={c.id} className="border-t border-[var(--color-border-soft)]">
                    <td className="px-3 py-2"><div className="font-medium text-[var(--color-text-primary)]">{c.label}</div>{c.phone && <div className="text-xs text-[var(--color-text-muted)]">{formatPhone(c.phone)}</div>}</td>
                    <td className="px-3 py-2">{s.platform === 'instagram' ? 'Instagram' : 'WhatsApp'}</td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{c.provider === 'zernio' ? 'Zernio (oficial)' : 'UAZAPI'}</td>
                    <td className="px-3 py-2"><span className="inline-flex items-center gap-1.5"><Dot on={s.connected} /> {s.detail}</span></td>
                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{fmtWhen(live.lastByChannel[c.id])}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Link to="/configuracoes/integracoes/canais" className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--accent-primary)] hover:underline">Configurar canais <ChevronRight className="h-4 w-4" /></Link>
    </div>
  );
}

// Serviços externos (credenciais da organização).
export function ExternalServices() {
  const { statuses, loading } = useIntegrationsStatus();
  return (
    <div className="space-y-3">
      <p className="text-sm text-[var(--color-text-secondary)]">Chaves guardadas cifradas no servidor. A chave do LLM e da OpenAI se trocam no <Link className="text-[var(--accent-primary)] underline" to="/ai-agent?tab=agent">Agente de IA</Link>; a do Zernio, em Canais.</p>
      {loading ? <Skeleton className="h-40" /> : statuses.map((s) => (
        <div key={s.key} className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 py-3">
          <span className="text-sm text-[var(--color-text-primary)]">{s.label}</span>
          <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', s.configured ? 'text-[var(--color-success)]' : 'text-[var(--color-text-secondary)]')}>
            <Dot on={s.configured} /> {s.configured ? 'Configurado' : 'Pendente'}
          </span>
        </div>
      ))}
    </div>
  );
}

// Endereços de webhook (somente leitura) + últimos avisos recebidos quando o perfil pode ver.
export function WebhooksPanel() {
  const { orgId } = useAppUser();
  const base = getSupabaseCredentials()?.url ?? '';
  const [events, setEvents] = useState<Array<{ event_type: string; processed_at: string }> | null>(null);
  const [asaasUrl, setAsaasUrl] = useState<string | null>(null);
  useEffect(() => {
    getSupabase().from('webhook_events').select('event_type, processed_at').order('processed_at', { ascending: false }).limit(15)
      .then(({ data, error }) => setEvents(error ? [] : (data ?? []) as Array<{ event_type: string; processed_at: string }>));
    getSupabase().functions.invoke('fin-asaas', { body: { action: 'config_status' } }).then((r) => setAsaasUrl(r.data?.ok ? String(r.data.webhook_url ?? '') || null : null)).catch(() => undefined);
  }, []);
  const rows: Array<[string, string | null, string]> = [
    ['Zernio (WhatsApp oficial e Instagram)', base && orgId ? `${base}/functions/v1/zernio-webhook?org=${orgId}` : null, 'Cadastrado no painel do Zernio, com a assinatura (secret) da organização.'],
    ['UAZAPI (WhatsApp por QR)', null, 'Um endereço por número, cadastrado sozinho ao conectar em Canais.'],
    ['ASAAS (aviso de pagamento)', asaasUrl, 'Cadastrado no painel do ASAAS com o token da integração.'],
  ];
  const copy = (t: string) => { void navigator.clipboard.writeText(t); toast.success('Copiado.'); };
  return (
    <div className="space-y-4">
      {rows.map(([name, url, hint]) => (
        <div key={name} className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
          <div className="text-sm font-semibold text-[var(--color-text-primary)]">{name}</div>
          {url ? (
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md bg-[var(--color-surface-hover)] px-2 py-1.5 text-xs">{url}</code>
              <Button size="sm" variant="outline" onClick={() => copy(url)}><Copy className="h-3.5 w-3.5" /></Button>
            </div>
          ) : null}
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">{hint}</p>
        </div>
      ))}
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border-soft)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text-primary)]">Últimos avisos recebidos</div>
        {events === null ? <div className="p-4"><Skeleton className="h-16" /></div> : events.length === 0
          ? <p className="px-4 py-4 text-sm text-[var(--color-text-muted)]">Sem registros visíveis para o seu perfil.</p>
          : <ul>{events.map((e, i) => <li key={i} className="flex justify-between gap-3 border-b border-[var(--color-border-soft)] px-4 py-2 text-xs last:border-0"><span className="font-mono">{e.event_type}</span><span className="text-[var(--color-text-muted)]">{fmtWhen(e.processed_at)}</span></li>)}</ul>}
      </div>
    </div>
  );
}
