import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2, Pencil, Plus, Trash2, X, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useQuickReplies, type QuickReply } from '@/hooks/useQuickReplies';

// Normaliza o atalho: minúsculo, sem espaço/acento/barra — o "/" é só de
// exibição, nunca fica salvo no banco.
function slugifyShortcut(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^\/+/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

export function QuickRepliesSettings() {
  const { userId } = useAppUser();
  const { quickReplies, loading, reload } = useQuickReplies();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<QuickReply | null>(null);

  const openNew = () => { setEditing(null); setShowForm(true); };
  const openEdit = (q: QuickReply) => { setEditing(q); setShowForm(true); };

  const remove = async (q: QuickReply) => {
    if (!confirm(`Apagar a resposta rápida "/${q.shortcut}"?`)) return;
    const { error } = await getSupabase().from('quick_replies').delete().eq('id', q.id);
    if (error) {
      toast.error('Falha ao apagar', { description: error.message });
      return;
    }
    toast.success('Resposta rápida apagada.');
    void reload();
  };

  return (
    <Card>
      <div className="space-y-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-xl font-bold text-display">Respostas rápidas</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Atalhos de texto pronto pro Inbox — digite "/" seguido do atalho no
              composer pra inserir. Compartilhadas com toda a equipe.
            </p>
          </div>
          <Button type="button" onClick={openNew}>
            <Plus className="h-4 w-4" /> Nova resposta
          </Button>
        </header>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
          </div>
        ) : quickReplies.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-4 text-sm text-[var(--color-text-secondary)]">
            Nenhuma resposta rápida ainda. Crie a primeira — ex.: atalho{' '}
            <code>boasvindas</code> com a mensagem de boas-vindas padrão.
          </div>
        ) : (
          <div className="space-y-2">
            {quickReplies.map((q) => (
              <div
                key={q.id}
                className="flex items-start gap-3 rounded-lg border border-[rgba(14,154,160,0.15)] bg-white/[0.02] p-3"
              >
                <Zap className="h-4 w-4 shrink-0 mt-0.5 text-[var(--accent-primary)]" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-[var(--color-text-primary)]">/{q.shortcut}</div>
                  <p className="text-xs text-[var(--color-text-secondary)] line-clamp-2">{q.content}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => openEdit(q)}
                    aria-label="Editar"
                    className="rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] p-2 text-[var(--color-text-secondary)] transition hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(q)}
                    aria-label="Apagar"
                    className="rounded-lg border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] p-2 text-[#F87171] transition hover:border-[#F87171]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <QuickReplyDialog
          quickReply={editing}
          createdBy={userId}
          onClose={() => setShowForm(false)}
          onDone={() => { setShowForm(false); void reload(); }}
        />
      )}
    </Card>
  );
}

function QuickReplyDialog({
  quickReply,
  createdBy,
  onClose,
  onDone,
}: {
  quickReply: QuickReply | null;
  createdBy: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const editing = Boolean(quickReply);
  const [shortcut, setShortcut] = useState(quickReply?.shortcut ?? '');
  const [content, setContent] = useState(quickReply?.content ?? '');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const slug = slugifyShortcut(shortcut);
    if (!slug) { toast.error('Dê um atalho válido (ex.: boasvindas).'); return; }
    if (!content.trim()) { toast.error('Escreva o texto da resposta.'); return; }
    setSaving(true);
    const supabase = getSupabase();
    const { error } = editing
      ? await supabase.from('quick_replies').update({ shortcut: slug, content: content.trim() }).eq('id', quickReply!.id)
      : await supabase.from('quick_replies').insert({ shortcut: slug, content: content.trim(), created_by: createdBy });
    setSaving(false);
    if (error) {
      toast.error('Falha ao salvar', {
        description: error.code === '23505' ? 'Já existe uma resposta com esse atalho.' : error.message,
      });
      return;
    }
    toast.success(editing ? 'Resposta rápida atualizada.' : 'Resposta rápida criada.');
    onDone();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="glass-card w-full max-w-md space-y-4 p-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold text-display">
            {editing ? 'Editar resposta rápida' : 'Nova resposta rápida'}
          </h3>
          <button onClick={onClose} aria-label="Fechar" className="rounded-lg p-1.5 hover:bg-white/5">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="qr_shortcut">Atalho</Label>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-[var(--color-text-secondary)]">/</span>
              <Input
                id="qr_shortcut"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                placeholder="boasvindas"
                disabled={saving}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="qr_content">Mensagem</Label>
            <textarea
              id="qr_content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={4}
              disabled={saving}
              className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancelar</Button>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : editing ? 'Salvar' : 'Criar'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
