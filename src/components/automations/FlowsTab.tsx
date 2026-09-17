import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { Copy, FileEdit, Plus, Archive } from 'lucide-react';
import { useAutomationFlows, type AutomationFlow } from '@/hooks/useAutomationFlows';
import { FlowEditor } from './FlowEditor';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

const STATUS_LABEL: Record<AutomationFlow['status'], { label: string; className: string }> = {
  draft: { label: 'Rascunho', className: 'bg-white/10 text-[var(--color-text-secondary)]' },
  active: { label: 'Ativa', className: 'bg-[rgba(34,197,94,0.15)] text-[#22C55E]' },
  paused: { label: 'Pausada', className: 'bg-[rgba(245,158,11,0.15)] text-[#F59E0B]' },
  archived: { label: 'Arquivada', className: 'bg-white/5 text-[var(--color-text-secondary)] opacity-60' },
};

export function FlowsTab() {
  const { flows, loading, error, createFlow, saveDefinition, duplicateFlow, archiveFlow } = useAutomationFlows();
  const [editing, setEditing] = useState<AutomationFlow | null>(null);
  const [novoOpen, setNovoOpen] = useState(false);

  const ativos = flows.filter((f) => f.status === 'active').length;
  const pausados = flows.filter((f) => f.status === 'paused').length;
  const rascunhos = flows.filter((f) => f.status === 'draft').length;

  return (
    <div className="space-y-4">
      {/* KPIs reais — sem execução ainda, então "com erro"/"taxa de sucesso"
          não existem de verdade; mostro só o que é real hoje: contagem por
          status. Nada de número fabricado. */}
      <div className="grid grid-cols-3 gap-3">
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{ativos}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Fluxos ativos</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{pausados}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Em pausa</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{rascunhos}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Rascunhos</div>
        </div>
      </div>

      <div className="rounded-lg border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.06)] px-3 py-2 text-xs text-[#FBBF24]">
        Editor visual — hoje só desenha e salva o fluxo como rascunho. A execução automática de verdade
        (disparar mensagem, mover funil etc. sozinho) é uma etapa futura, feita com cuidado.
      </div>

      <div className="flex justify-end">
        <Button onClick={() => setNovoOpen(true)}>
          <Plus className="h-4 w-4" /> Nova automação
        </Button>
      </div>

      {error && <p className="text-sm text-[var(--color-error)]">{error}</p>}

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      ) : flows.length === 0 ? (
        <div className="glass-card p-8 text-center">
          <p className="text-sm text-[var(--color-text-secondary)] mb-3">
            Nenhuma automação criada. Crie seu primeiro fluxo para automatizar tarefas repetitivas.
          </p>
          <Button onClick={() => setNovoOpen(true)}>
            <Plus className="h-4 w-4" /> Nova automação
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {flows.map((f) => (
            <div key={f.id} className="glass-card p-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--color-text-primary)] truncate">{f.name}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_LABEL[f.status].className}`}>
                    {STATUS_LABEL[f.status].label}
                  </span>
                </div>
                {f.description && <p className="text-xs text-[var(--color-text-secondary)] truncate">{f.description}</p>}
                <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
                  {f.definition?.nodes?.length ?? 0} nodes · atualizado {new Date(f.updated_at).toLocaleDateString('pt-BR')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Button size="sm" variant="outline" onClick={() => setEditing(f)}>
                  <FileEdit className="h-3.5 w-3.5" /> Editar
                </Button>
                <button
                  onClick={() => void duplicateFlow(f).then(() => toast.success('Duplicado como rascunho.')).catch((e) => toast.error('Falha', { description: e.message }))}
                  aria-label="Duplicar"
                  title="Duplicar"
                  className="rounded-lg border border-[var(--color-border-card)] p-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                {f.status !== 'archived' && (
                  <button
                    onClick={() => void archiveFlow(f.id).catch((e) => toast.error('Falha', { description: e.message }))}
                    aria-label="Arquivar"
                    title="Arquivar"
                    className="rounded-lg border border-[var(--color-border-card)] p-2 text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <FlowEditor
          flow={editing}
          onClose={() => setEditing(null)}
          onSave={async (def) => { await saveDefinition(editing.id, def); }}
        />
      )}

      {novoOpen && (
        <NovaAutomacaoDialog
          onClose={() => setNovoOpen(false)}
          onCreate={async (name) => {
            const flow = await createFlow(name);
            setNovoOpen(false);
            setEditing(flow);
          }}
        />
      )}
    </div>
  );
}

function NovaAutomacaoDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const criar = async () => {
    if (!name.trim()) { toast.error('Dê um nome à automação.'); return; }
    setSaving(true);
    try {
      await onCreate(name.trim());
    } catch (err) {
      toast.error('Falha ao criar', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Nova automação">
      <div className="space-y-3">
        <div>
          <Label htmlFor="flow-name">Nome</Label>
          <input
            id="flow-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
            placeholder="Ex.: Follow-up de lead sem resposta"
            className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void criar()} disabled={saving}>{saving ? 'Criando...' : 'Criar e abrir editor'}</Button>
      </div>
    </Dialog>
  );
}
