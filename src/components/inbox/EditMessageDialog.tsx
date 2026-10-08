import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import { extractFunctionErrorMessage } from '@/lib/functionError';
import type { Message } from '@/types/inbox';

// Mesma marca de assinatura do envio ("*Nome:*\n…"): fica fixa, edita-se o resto.
const SIGNATURE_RE = /^(\*[^*\n]{1,60}:\*\n)([\s\S]*)$/;

// Editar mensagem já enviada — a correção chega no WhatsApp do cliente
// (marcada como "Editada"). Só existe para números UAZAPI, até 15 min.
export function EditMessageDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const raw = message.content ?? '';
  const sig = SIGNATURE_RE.exec(raw);
  const prefix = sig ? sig[1] : '';
  const [text, setText] = useState(sig ? sig[2] : raw);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const body = text.trim();
    if (!body) { toast.error('A mensagem não pode ficar vazia.'); return; }
    setSaving(true);
    const { data, error } = await getSupabase().functions.invoke('edit-operator-message', {
      body: { message_id: message.id, content: prefix + body },
    });
    setSaving(false);
    if (error || !data?.ok) {
      toast.error('Não foi possível editar', { description: await extractFunctionErrorMessage(error, data?.error) });
      return;
    }
    toast.success('Mensagem corrigida — o cliente vê a versão nova.');
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title="Editar mensagem" description="O cliente recebe a correção no WhatsApp (aparece como “Editada”).">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); } }}
        rows={4}
        aria-label="Novo texto da mensagem"
        className="w-full resize-y rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]"
      />
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />} Salvar correção
        </Button>
      </div>
    </Dialog>
  );
}
