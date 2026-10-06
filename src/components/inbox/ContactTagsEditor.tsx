import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Tag as TagIcon, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useTags } from '@/hooks/useTags';

// Tags rápidas do contato no inbox: chips com remover + dropdown para adicionar
// uma tag existente. Lê/escreve whatsapp_hub.contact_tags.
// Avisa as outras instâncias (cabeçalho da conversa + painel) para recarregar.
const TAGS_EVENT = 'megacrm:contact-tags-changed';

export function ContactTagsEditor({
  contactId,
  variant = 'block',
  align = 'left',
}: {
  contactId: string;
  // block = com título "Tags" (padrão); inline = só os chips, para cabeçalho/linha.
  variant?: 'block' | 'inline';
  align?: 'left' | 'right';
}) {
  const { tags: allTags } = useTags();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  const load = async () => {
    const supabase = getSupabase();
    const { data } = await supabase.from('contact_tags').select('tag_id').eq('contact_id', contactId);
    setTagIds(((data ?? []) as Array<{ tag_id: string }>).map((r) => r.tag_id));
  };

  useEffect(() => {
    void load();
    const onChange = (e: Event) => {
      if ((e as CustomEvent<string>).detail === contactId) void load();
    };
    window.addEventListener(TAGS_EVENT, onChange);
    return () => window.removeEventListener(TAGS_EVENT, onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);
  const notify = () => window.dispatchEvent(new CustomEvent(TAGS_EVENT, { detail: contactId }));

  const attach = async (tagId: string) => {
    setAdding(false);
    if (tagIds.includes(tagId)) return;
    const supabase = getSupabase();
    const { error } = await supabase.schema('whatsapp_hub').from('contact_tags').insert({ contact_id: contactId, tag_id: tagId });
    if (error) {
      toast.error('Falha ao adicionar tag', { description: error.message });
      return;
    }
    setTagIds((prev) => [...prev, tagId]);
    notify();
  };

  const detach = async (tagId: string) => {
    const supabase = getSupabase();
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('contact_tags')
      .delete()
      .eq('contact_id', contactId)
      .eq('tag_id', tagId);
    if (error) {
      toast.error('Falha ao remover tag', { description: error.message });
      return;
    }
    setTagIds((prev) => prev.filter((id) => id !== tagId));
    notify();
  };

  const byId = new Map(allTags.map((t) => [t.id, t]));
  const available = allTags.filter((t) => !tagIds.includes(t.id));

  const inline = variant === 'inline';
  return (
    <div className={inline ? '' : 'space-y-2'}>
      {!inline && <div className="text-label">Tags</div>}
      <div className={`flex flex-wrap items-center gap-1.5 ${align === 'right' ? 'justify-end' : ''}`}>
        {tagIds.map((id) => {
          const t = byId.get(id);
          if (!t) return null;
          return (
            <span
              key={id}
              className={inline
                ? 'group inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12.5px] font-medium'
                : 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold'}
              style={{ backgroundColor: `${t.color}1f`, color: t.color }}
            >
              {inline && <TagIcon className="h-3 w-3" />}
              {t.name}
              <button type="button" onClick={() => detach(id)} aria-label={`Remover ${t.name}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <div className="relative">
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            aria-label="Adicionar etiqueta"
            title="Adicionar etiqueta"
            className={inline
              ? 'inline-flex h-7 w-7 items-center justify-center rounded-lg border border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              : 'inline-flex items-center gap-1 rounded-full border border-[var(--color-border-card)] px-2.5 py-1 text-[11px] font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}
          >
            <Plus className={inline ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
            {!inline && 'Tag'}
          </button>
          {adding && (
            <div className={`absolute z-20 mt-1 w-48 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] shadow-2xl overflow-hidden max-h-56 overflow-y-auto ${align === 'right' ? 'right-0' : ''}`}>
              {available.length === 0 ? (
                <div className="px-3 py-2 text-xs text-[var(--color-text-secondary)] opacity-70">
                  Sem tags disponíveis. Crie em Contatos.
                </div>
              ) : (
                available.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => attach(t.id)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-subtle)]"
                  >
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: t.color }} />
                    <span className="text-[var(--color-text-primary)]">{t.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
