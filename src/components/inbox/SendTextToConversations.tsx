import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Check, ExternalLink, Loader2, Search, Send, Users } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { extractFunctionErrorMessage } from '@/lib/functionError';
import { formatPhoneDisplay } from '@/lib/phone';

const MAX_TARGETS = 5;
const MAX_CHARS = 4000; // o envio aceita até 4096 por mensagem

interface Target { id: string; name: string; phone: string; pic: string | null; group: boolean; last: string | null }

// Quebra textos grandes em várias mensagens, sem cortar linha no meio.
function chunks(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > MAX_CHARS) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}

// Envia um texto pelo WhatsApp do CRM (o número da conversa: UAZAPI/Zernio) para até 5 conversas — pessoas ou grupos.
// Usa o mesmo caminho da resposta na inbox (send-operator-message), então a mensagem fica gravada na conversa.
export function SendTextToConversations({ title, text: initial, onClose }: { title: string; text: string; onClose: () => void }) {
  const [text, setText] = useState(initial);
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [onlyGroups, setOnlyGroups] = useState(false);

  useEffect(() => {
    void (async () => {
      const sb = getSupabase();
      const { data: convs } = await sb.from('conversations').select('id, contact_id, last_message_at')
        .eq('channel', 'whatsapp').order('last_message_at', { ascending: false, nullsFirst: false }).limit(600);
      const rows = (convs ?? []) as Array<{ id: string; contact_id: string; last_message_at: string | null }>;
      const ids = [...new Set(rows.map((r) => r.contact_id))];
      const contacts = new Map<string, { name: string | null; phone: string | null; profile_pic_url: string | null }>();
      for (let i = 0; i < ids.length; i += 100) {
        const { data } = await sb.from('contacts').select('id, name, phone, profile_pic_url').in('id', ids.slice(i, i + 100));
        for (const c of (data ?? []) as Array<{ id: string; name: string | null; phone: string | null; profile_pic_url: string | null }>) contacts.set(c.id, c);
      }
      setTargets(rows.map((r) => {
        const c = contacts.get(r.contact_id);
        const phone = c?.phone ?? '';
        return { id: r.id, name: c?.name?.trim() || phone || '—', phone, pic: c?.profile_pic_url ?? null, group: phone.endsWith('@g.us'), last: r.last_message_at };
      }));
    })();
  }, []);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const digits = term.replace(/\D/g, '');
    return (targets ?? [])
      .filter((t) => !onlyGroups || t.group)
      .filter((t) => !term || t.name.toLowerCase().includes(term) || (digits.length > 2 && t.phone.replace(/\D/g, '').includes(digits)))
      .slice(0, 80);
  }, [targets, q, onlyGroups]);

  const toggle = (id: string) => setPicked((cur) => {
    if (cur.includes(id)) return cur.filter((x) => x !== id);
    if (cur.length >= MAX_TARGETS) { toast.info(`Até ${MAX_TARGETS} conversas por vez.`); return cur; }
    return [...cur, id];
  });

  const send = async () => {
    const body = text.trim();
    if (!body || !picked.length) return;
    setSending(true);
    const parts = chunks(body);
    const sb = getSupabase();
    const fails: string[] = [];
    let ok = 0;
    for (const convId of picked) {
      const who = targets?.find((t) => t.id === convId)?.name ?? 'conversa';
      try {
        for (const p of parts) {
          const { data, error } = await sb.functions.invoke('send-operator-message', { body: { conversation_id: convId, content: p } });
          if (error || !data?.ok) throw new Error(await extractFunctionErrorMessage(error, data?.error));
          if (data.zernio_error) throw new Error(data.zernio_error as string);
        }
        ok++;
      } catch (e) { fails.push(`${who}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    setSending(false);
    if (ok) toast.success(ok === 1 ? 'Enviado pelo WhatsApp do CRM.' : `Enviado para ${ok} conversas.`, { description: 'A mensagem fica registrada na conversa, no Atendimento.' });
    if (fails.length) toast.error('Não consegui enviar para todas', { description: fails.slice(0, 5).join('\n') });
    if (!fails.length) onClose();
  };

  return (
    <Dialog open onClose={onClose} opaque title={title} description="Sai pelo número de WhatsApp do CRM para a pessoa ou o grupo escolhido (até 5)." widthClass="max-w-3xl">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex min-h-0 flex-col">
          <div className="mb-1 flex items-center justify-between text-xs font-semibold text-[var(--color-text-secondary)]">
            <span>Mensagem (dá para editar)</span><span className="font-normal text-[var(--color-text-muted)]">{text.length} caracteres{text.length > MAX_CHARS ? ` · vai em ${chunks(text).length} partes` : ''}</span>
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={16}
            className="min-h-[300px] w-full flex-1 resize-y rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="mb-2 flex gap-2">
            <label className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar pessoa ou grupo" aria-label="Buscar conversa"
                className="h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] pl-8 pr-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
            </label>
            <button type="button" onClick={() => setOnlyGroups((v) => !v)} aria-pressed={onlyGroups}
              className={cn('flex h-10 items-center gap-1.5 rounded-[var(--radius-control)] border px-3 text-sm', onlyGroups ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]')}>
              <Users className="h-4 w-4" /> Grupos
            </button>
          </div>
          <ul className="max-h-[300px] flex-1 space-y-0.5 overflow-y-auto">
            {targets === null && <li className="flex items-center justify-center gap-2 py-6 text-sm text-[var(--color-text-muted)]"><Loader2 className="h-4 w-4 animate-spin" /> Carregando conversas…</li>}
            {targets && list.length === 0 && <li className="px-2 py-6 text-center text-sm text-[var(--color-text-muted)]">{onlyGroups ? 'Nenhum grupo no CRM. O grupo aparece aqui depois que alguém escrever nele (com grupos ligados no número).' : 'Nenhuma conversa encontrada.'}</li>}
            {list.map((t) => {
              const on = picked.includes(t.id);
              return (
                <li key={t.id}>
                  <button type="button" onClick={() => toggle(t.id)} aria-pressed={on}
                    className={cn('flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', on ? 'bg-[var(--color-accent-subtle)]' : 'hover:bg-[var(--color-surface-hover)]')}>
                    <Avatar src={t.pic} name={t.name} size="sm" className="!h-8 !w-8" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{t.name}</span>
                      <span className="block truncate text-xs text-[var(--color-text-muted)]">{t.group ? 'Grupo' : formatPhoneDisplay(t.phone)}</span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-4">
        <a href={`https://api.whatsapp.com/send?text=${encodeURIComponent(text.slice(0, 3500))}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]"><ExternalLink className="h-3.5 w-3.5" /> Abrir no meu WhatsApp em vez disso</a>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose} disabled={sending}>Cancelar</Button>
          <Button onClick={() => void send()} disabled={sending || !picked.length || !text.trim()}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar{picked.length ? ` para ${picked.length}` : ''}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
