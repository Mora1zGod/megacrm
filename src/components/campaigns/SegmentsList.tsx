import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Tag as TagIcon, Trash2, Users } from 'lucide-react';
import { useSegments } from '@/hooks/useSegments';
import { useTags } from '@/hooks/useTags';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

export function SegmentsList() {
  const { segments, loading, error, createSegment, deleteSegment } = useSegments();
  const [novoOpen, setNovoOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-text-secondary)]">
          Segmentos são filtros salvos — a regra fica guardada, a contagem é recalculada sempre.
        </p>
        <Button onClick={() => setNovoOpen(true)}>
          <Plus className="h-4 w-4" /> Novo segmento
        </Button>
      </div>

      {error && <p className="text-sm text-[var(--color-error)]">{error}</p>}

      {loading ? (
        <p className="text-sm text-[var(--color-text-secondary)]">Carregando...</p>
      ) : segments.length === 0 ? (
        <div className="glass-card p-6 text-center text-sm text-[var(--color-text-secondary)]">
          Nenhum segmento criado ainda.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {segments.map((s) => (
            <div key={s.id} className="glass-card p-4 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-[var(--color-text-primary)] truncate">{s.name}</div>
                  {s.description && <div className="text-xs text-[var(--color-text-secondary)] truncate">{s.description}</div>}
                </div>
                <button
                  onClick={() => void deleteSegment(s.id).catch((e) => toast.error('Falha', { description: e.message }))}
                  className="shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
                  aria-label="Apagar segmento"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-[var(--accent-primary)]">
                <Users className="h-4 w-4" /> {s.count} contato{s.count === 1 ? '' : 's'}
              </div>
            </div>
          ))}
        </div>
      )}

      {novoOpen && (
        <NovoSegmentoDialog
          onClose={() => setNovoOpen(false)}
          onCreate={createSegment}
        />
      )}
    </div>
  );
}

function NovoSegmentoDialog({
  onClose, onCreate,
}: { onClose: () => void; onCreate: (i: { name: string; description?: string; tagIds: string[] }) => Promise<void> }) {
  const { tags } = useTags();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const toggleTag = (id: string) =>
    setTagIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const salvar = async () => {
    if (!name.trim()) { toast.error('Dê um nome ao segmento.'); return; }
    if (tagIds.length === 0) { toast.error('Escolha ao menos uma tag.'); return; }
    setSaving(true);
    try {
      await onCreate({ name: name.trim(), description: description.trim(), tagIds });
      toast.success('Segmento criado.');
      onClose();
    } catch (err) {
      toast.error('Falha ao criar', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Novo segmento">
      <div className="space-y-3">
        <div>
          <Label htmlFor="seg-name">Nome</Label>
          <input
            id="seg-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Leads AMAI PRIME"
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
        <div>
          <Label htmlFor="seg-desc">Descrição (opcional)</Label>
          <input
            id="seg-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
        <div>
          <Label>Tags (o contato entra se tiver alguma delas)</Label>
          <div className="flex flex-wrap gap-1.5 mt-1">
            {tags.length === 0 ? (
              <p className="text-xs text-[var(--color-text-secondary)]">Nenhuma tag cadastrada ainda.</p>
            ) : (
              tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTag(t.id)}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold border ${
                    tagIds.includes(t.id) ? 'border-[var(--accent-primary)]' : 'border-transparent opacity-60'
                  }`}
                  style={{ background: `${t.color}22`, color: t.color }}
                >
                  <TagIcon className="h-3 w-3" /> {t.name}
                </button>
              ))
            )}
          </div>
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void salvar()} disabled={saving}>{saving ? 'Criando...' : 'Criar segmento'}</Button>
      </div>
    </Dialog>
  );
}
