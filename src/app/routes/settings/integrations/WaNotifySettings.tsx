import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BellRing, Loader2, Plus, Send, Trash2, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { extractFunctionErrorMessage } from '@/lib/functionError';
import { formatPhone } from '@/lib/format';
import { maskPhoneBR } from '@/lib/phone';
import { Field, inputCls } from '../sections/access/ui';

export interface NotifyRecipient { id: string; name: string; phone: string; is_group: boolean; topics: string[]; is_active: boolean }
interface UazChannel { id: string; label: string; phone: string | null; is_active: boolean }

// Telefone digitado → só dígitos com DDI 55. Grupo (JID …@g.us) passa como está.
export function normalizeNotifyPhone(raw: string): string | null {
  const t = raw.trim();
  if (/^[0-9-]{10,40}@g\.us$/.test(t)) return t;
  const d = t.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d;
  if (d.length >= 10 && d.length <= 15) return d;
  return null;
}

export async function sendWaNotification(body: { recipient_ids: string[]; text?: string; images_base64?: string[] }) {
  const { data, error } = await getSupabase().functions.invoke('send-wa-notification', { body });
  if (error || !data?.ok) throw new Error(await extractFunctionErrorMessage(error, data?.error));
  return data as { sent: number; channel: string; results: Array<{ id: string; name: string; ok: boolean; error?: string }> };
}

// Configurações → Comunicação e integrações → Notificações WhatsApp.
// Escolhe o número UAZAPI que envia os avisos internos e quem recebe (pessoas ou grupos).
export function WaNotifySettings() {
  const { orgId } = useAppUser();
  const perms = usePermission();
  const canEdit = perms.can('settings.channels');
  const [channels, setChannels] = useState<UazChannel[] | null>(null);
  const [channelId, setChannelId] = useState<string>('');
  const [recipients, setRecipients] = useState<NotifyRecipient[]>([]);
  const [groups, setGroups] = useState<Array<{ name: string; phone: string }>>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    const sb = getSupabase();
    const [ch, cfg, rc, gr] = await Promise.all([
      sb.from('channels').select('id, label, phone, is_active').eq('provider', 'uazapi').order('label'),
      sb.from('wa_notify_settings').select('channel_id').maybeSingle(),
      sb.from('wa_notify_recipients').select('id, name, phone, is_group, topics, is_active').order('name'),
      sb.from('contacts').select('name, phone').like('phone', '%@g.us').order('name').limit(200),
    ]);
    if (cfg.error && /wa_notify_settings|schema cache|does not exist/i.test(cfg.error.message)) setMissing(true);
    setChannels((ch.data ?? []) as UazChannel[]);
    setChannelId((cfg.data as { channel_id: string | null } | null)?.channel_id ?? '');
    setRecipients((rc.data ?? []) as NotifyRecipient[]);
    setGroups(((gr.data ?? []) as Array<{ name: string | null; phone: string }>).filter((g) => g.phone?.endsWith('@g.us')).map((g) => ({ name: g.name?.trim() || 'Grupo sem nome', phone: g.phone })));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const saveChannel = async (id: string) => {
    setChannelId(id);
    const { error } = await getSupabase().from('wa_notify_settings').upsert({ org_id: orgId, channel_id: id || null, updated_at: new Date().toISOString() }, { onConflict: 'org_id' });
    if (error) { toast.error('Não consegui salvar o número.', { description: error.message }); void load(); return; }
    toast.success(id ? 'Número de avisos salvo.' : 'Envio de avisos desligado.');
  };
  const add = async (n: string, p: string) => {
    const ph = normalizeNotifyPhone(p);
    if (!n.trim()) { toast.error('Dê um nome (ex.: Gabriel, Grupo Financeiro).'); return; }
    if (!ph) { toast.error('Número inválido.', { description: 'Ex.: (68) 99942-8493, ou escolha um grupo da lista.' }); return; }
    setBusy(true);
    const { error } = await getSupabase().from('wa_notify_recipients').insert({ name: n.trim(), phone: ph });
    setBusy(false);
    if (error) { toast.error(/duplicate|unique/i.test(error.message) ? 'Esse número/grupo já está na lista.' : 'Não consegui adicionar.', { description: error.message }); return; }
    setName(''); setPhone('');
    void load();
  };
  const toggle = async (r: NotifyRecipient) => {
    const { error } = await getSupabase().from('wa_notify_recipients').update({ is_active: !r.is_active }).eq('id', r.id);
    if (error) toast.error('Não consegui salvar.', { description: error.message });
    void load();
  };
  const remove = async (r: NotifyRecipient) => {
    const { error } = await getSupabase().from('wa_notify_recipients').delete().eq('id', r.id);
    if (error) toast.error('Não consegui remover.', { description: error.message });
    void load();
  };
  const test = async (r: NotifyRecipient) => {
    try {
      const res = await sendWaNotification({ recipient_ids: [r.id], text: `✅ Teste de avisos do CRM AMAI Park.\nEste número/grupo vai receber as notificações (contas a pagar e outras).` });
      toast.success(`Teste enviado para ${r.name} pelo número ${res.channel}.`);
    } catch (e) { toast.error('O teste não foi enviado.', { description: e instanceof Error ? e.message : String(e) }); }
  };

  if (channels === null) return <Skeleton className="h-60" />;
  if (missing) return <p className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4 text-sm text-[var(--color-text-secondary)]">Falta rodar o SQL das notificações (<code>SQL-08-10-notificacoes-whatsapp.sql</code>) no Supabase.</p>;
  const groupsAvailable = groups.filter((g) => !recipients.some((r) => r.phone === g.phone));

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <BellRing className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
        <div className="text-sm text-[var(--color-text-secondary)]">
          Avisos internos (ex.: <b>Contas a pagar</b> → botão WhatsApp) saem por um número <b>UAZAPI</b> — sem a regra das 24 h da API oficial —
          direto para as pessoas e grupos abaixo. Não aparecem no Atendimento.
        </div>
      </div>

      <div className="max-w-lg">
        <Field label="Número que envia os avisos" htmlFor="wn-channel" hint={channels.length ? undefined : 'Nenhum número UAZAPI cadastrado. Cadastre em WhatsApp e Instagram.'}>
          <select id="wn-channel" value={channelId} disabled={!canEdit} onChange={(e) => void saveChannel(e.target.value)} className={inputCls}>
            <option value="">— Desligado —</option>
            {channels.map((c) => <option key={c.id} value={c.id} disabled={!c.is_active}>{c.label}{c.phone ? ` · ${formatPhone(c.phone)}` : ''}{c.is_active ? '' : ' (desativado)'}</option>)}
          </select>
        </Field>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">Quem recebe</h3>
        {recipients.length === 0 ? <p className="mb-3 text-sm text-[var(--color-text-muted)]">Ninguém ainda. Adicione um número ou um grupo.</p> : (
          <ul className="mb-4 divide-y divide-[var(--color-border-soft)] rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
            {recipients.map((r) => (
              <li key={r.id} className={cn('flex flex-wrap items-center gap-3 px-4 py-2.5', !r.is_active && 'opacity-60')}>
                {r.is_group ? <Users className="h-4 w-4 text-[var(--accent-primary)]" /> : <Send className="h-4 w-4 text-[var(--color-text-muted)]" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{r.name}</span>
                  <span className="block truncate text-xs text-[var(--color-text-muted)]">{r.is_group ? 'Grupo' : formatPhone(r.phone)}</span>
                </span>
                <Button size="sm" variant="outline" disabled={!channelId || !r.is_active} onClick={() => void test(r)}>Enviar teste</Button>
                {canEdit && <>
                  <Button size="sm" variant="ghost" onClick={() => void toggle(r)}>{r.is_active ? 'Pausar' : 'Ativar'}</Button>
                  <button type="button" aria-label={`Remover ${r.name}`} onClick={() => void remove(r)} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><Trash2 className="h-4 w-4" /></button>
                </>}
              </li>
            ))}
          </ul>
        )}

        {canEdit && (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4">
              <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">Adicionar pessoa</div>
              <div className="flex flex-wrap gap-2">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome (ex.: Gabriel)" className={cn(inputCls, 'min-w-[140px] flex-1')} />
                <input value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} inputMode="tel" placeholder="(68) 99942-8493" className={cn(inputCls, 'w-44')} />
                <Button disabled={busy} onClick={() => void add(name, phone)}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Adicionar</Button>
              </div>
            </div>
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4">
              <div className="mb-1 text-sm font-semibold text-[var(--color-text-primary)]">Adicionar grupo</div>
              <p className="mb-3 text-xs text-[var(--color-text-muted)]">Grupos que já apareceram no CRM (o número precisa estar no grupo).</p>
              {groupsAvailable.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nenhum grupo disponível.</p> : (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {groupsAvailable.map((g) => (
                    <li key={g.phone} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-[var(--color-surface-hover)]">
                      <span className="flex min-w-0 items-center gap-2 text-sm"><Users className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" /><span className="truncate">{g.name}</span></span>
                      <Button size="sm" variant="outline" onClick={() => void add(g.name, g.phone)}><Plus className="h-3.5 w-3.5" /> Adicionar</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
