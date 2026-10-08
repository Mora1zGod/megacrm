import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, ExternalLink, Loader2, MessagesSquare, Send, Settings2, Users } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { formatPhone } from '@/lib/format';
import { MAX_IMAGE_ITEMS, renderBillsImages, type BillsImage } from '@/lib/wa-summary-image';
import { sendWaNotification, type NotifyRecipient } from '@/app/routes/settings/integrations/WaNotifySettings';
import { SendTextToConversations } from '@/components/inbox/SendTextToConversations';

// Envia o resumo das contas como IMAGEM (card) pelo número de avisos (UAZAPI) para as pessoas/grupos cadastrados
// em Configurações → Notificações WhatsApp. Alternativas: conversa do Atendimento ou o WhatsApp do próprio usuário.
export function SendBillsDialog({ data, text, caption, onClose }: { data: BillsImage; text: string; caption: string; onClose: () => void }) {
  const [imgs, setImgs] = useState<string[] | null>(null);
  const [cfg, setCfg] = useState<{ channel: string | null; recipients: NotifyRecipient[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [withText, setWithText] = useState(data.items.length > MAX_IMAGE_ITEMS);
  const [sending, setSending] = useState(false);
  const [viaInbox, setViaInbox] = useState(false);

  useEffect(() => { void renderBillsImages(data).then(setImgs).catch(() => setImgs([])); }, [data]);
  useEffect(() => {
    void (async () => {
      const sb = getSupabase();
      const [s, r] = await Promise.all([
        sb.from('wa_notify_settings').select('channel_id, channel:channel_id(label)').maybeSingle(),
        sb.from('wa_notify_recipients').select('id, name, phone, is_group, topics, is_active').eq('is_active', true).order('name'),
      ]);
      const row = s.data as { channel_id: string | null; channel: { label: string } | null } | null;
      const recipients = (r.data ?? []) as NotifyRecipient[];
      setCfg({ channel: row?.channel_id ? (row.channel?.label ?? 'número de avisos') : null, recipients });
      setPicked(recipients.filter((x) => x.topics.includes('financeiro')).map((x) => x.id));
    })();
  }, []);

  const send = async () => {
    if (!picked.length || !imgs?.length) return;
    setSending(true);
    try {
      const res = await sendWaNotification({ recipient_ids: picked, images_base64: imgs, text: withText ? text : caption });
      const fails = res.results.filter((x) => !x.ok);
      toast.success(`Enviado para ${res.sent} destinatário(s) pelo número ${res.channel}.`);
      if (fails.length) toast.error('Alguns não receberam', { description: fails.map((f) => `${f.name}: ${f.error}`).join('\n') });
      if (!fails.length) onClose();
    } catch (e) { toast.error('Não foi enviado.', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setSending(false); }
  };

  if (viaInbox) return <SendTextToConversations title="Enviar pelo Atendimento" text={text} onClose={onClose} />;

  return (
    <Dialog open onClose={onClose} opaque title="Enviar no WhatsApp" widthClass="max-w-4xl"
      description={cfg?.channel ? `Sai pelo número de avisos "${cfg.channel}" (UAZAPI, sem a regra das 24 h).` : undefined}>
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_320px]">
        <div className="max-h-[60vh] overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[#EFEAE2] p-3">
          {imgs === null ? <div className="flex h-60 items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Montando a imagem…</div>
            : imgs.length === 0 ? <p className="p-4 text-sm text-[var(--color-error)]">Não consegui gerar a imagem neste navegador.</p>
            : <div className="space-y-3">{imgs.map((b, i) => <img key={i} src={`data:image/png;base64,${b}`} alt={`Resumo das contas ${i + 1}`} className="mx-auto w-full max-w-[520px] rounded-lg shadow" />)}</div>}
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          {cfg === null ? <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Carregando…</div>
            : !cfg.channel || cfg.recipients.length === 0 ? (
              <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4 text-sm text-[var(--color-text-secondary)]">
                <p className="mb-3">{!cfg.channel ? 'Ainda não há número de avisos escolhido.' : 'Ninguém cadastrado para receber avisos.'}</p>
                <Link to="/configuracoes/integracoes/avisos" onClick={onClose} className="inline-flex items-center gap-1.5 font-semibold text-[var(--accent-primary)]"><Settings2 className="h-4 w-4" /> Configurar notificações</Link>
              </div>
            ) : (
              <>
                <div className="text-sm font-semibold text-[var(--color-text-primary)]">Para quem</div>
                <ul className="max-h-[38vh] space-y-0.5 overflow-y-auto">
                  {cfg.recipients.map((r) => {
                    const on = picked.includes(r.id);
                    return (
                      <li key={r.id}>
                        <button type="button" aria-pressed={on} onClick={() => setPicked((p) => (on ? p.filter((x) => x !== r.id) : [...p, r.id]))}
                          className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left', on ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-[var(--color-surface-hover)]')}>
                          <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded border', on ? 'border-[var(--accent-fill)] bg-[var(--accent-fill)] text-white' : 'border-[var(--color-border-card)]')}>{on && <Check className="h-3.5 w-3.5" />}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{r.name}</span>
                            <span className="flex items-center gap-1 truncate text-xs text-[var(--color-text-muted)]">{r.is_group ? <><Users className="h-3 w-3" /> Grupo</> : formatPhone(r.phone)}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <label className="flex items-start gap-2 text-xs text-[var(--color-text-secondary)]">
                  <input type="checkbox" checked={withText} onChange={(e) => setWithText(e.target.checked)} className="mt-0.5" />
                  <span>Mandar também a lista em texto{data.items.length > MAX_IMAGE_ITEMS ? ` (as imagens mostram ${MAX_IMAGE_ITEMS} de ${data.items.length})` : ''}</span>
                </label>
                <Button onClick={() => void send()} disabled={sending || !picked.length || !imgs?.length}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar{imgs && imgs.length > 1 ? ` ${imgs.length} imagens` : ''}{picked.length ? ` para ${picked.length}` : ''}
                </Button>
              </>
            )}
          <div className="mt-auto space-y-1.5 border-t border-[var(--color-border-soft)] pt-3 text-xs">
            <button type="button" onClick={() => setViaInbox(true)} className="flex items-center gap-1.5 text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]"><MessagesSquare className="h-3.5 w-3.5" /> Enviar para uma conversa do Atendimento</button>
            <a href={`https://api.whatsapp.com/send?text=${encodeURIComponent(text.slice(0, 3500))}`} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]"><ExternalLink className="h-3.5 w-3.5" /> Abrir no meu WhatsApp (só texto)</a>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
