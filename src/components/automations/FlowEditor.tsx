import { useCallback, useState } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Handle,
  Position,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toast } from 'sonner';
import {
  Zap, GitBranch, Clock, Send, Flag, Plus, Save, Trash2, X,
  MessageSquare, Tag, UserCheck, KanbanSquare, CheckSquare, CalendarPlus, Bot, BotOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { type AutomationFlow, type FlowDefinition } from '@/hooks/useAutomationFlows';

// ---------------------------------------------------------------------------
// Nodes customizados. Cada um só guarda { label, subtitle } — nada aqui
// EXECUTA nada; é só a definição visual do fluxo, salva como rascunho.
// ---------------------------------------------------------------------------

type FlowNodeData = { label: string; subtitle?: string };

function BaseNode({
  icon: Icon, color, data, children,
}: { icon: typeof Zap; color: string; data: FlowNodeData; children?: React.ReactNode }) {
  return (
    <div
      className="rounded-lg border bg-[var(--color-surface-raised)] px-3 py-2 min-w-[190px] shadow-sm"
      style={{ borderColor: color }}
    >
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <span className="text-xs font-semibold text-[var(--color-text-primary)] truncate">{data.label}</span>
      </div>
      {data.subtitle && <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)] truncate">{data.subtitle}</div>}
      {children}
    </div>
  );
}

function TriggerNode({ data }: NodeProps) {
  return (
    <BaseNode icon={Zap} color="#22C55E" data={data as FlowNodeData}>
      <Handle type="source" position={Position.Right} />
    </BaseNode>
  );
}

function ConditionNode({ data }: NodeProps) {
  return (
    <div className="rounded-lg border bg-[var(--color-surface-raised)] px-3 py-2 min-w-[190px] shadow-sm" style={{ borderColor: '#A78BFA' }}>
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 shrink-0" style={{ color: '#A78BFA' }} />
        <span className="text-xs font-semibold text-[var(--color-text-primary)] truncate">{(data as FlowNodeData).label}</span>
      </div>
      {(data as FlowNodeData).subtitle && (
        <div className="mt-0.5 text-[11px] text-[var(--color-text-secondary)] truncate">{(data as FlowNodeData).subtitle}</div>
      )}
      <div className="mt-1.5 flex justify-between text-[10px] font-semibold">
        <span className="text-[#22C55E]">Sim</span>
        <span className="text-[#EF4444]">Não</span>
      </div>
      <Handle type="source" position={Position.Right} id="sim" style={{ top: '65%', background: '#22C55E' }} />
      <Handle type="source" position={Position.Bottom} id="nao" style={{ background: '#EF4444' }} />
    </div>
  );
}

function WaitNode({ data }: NodeProps) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} />
      <BaseNode icon={Clock} color="#F59E0B" data={data as FlowNodeData}>
        <Handle type="source" position={Position.Right} />
      </BaseNode>
    </div>
  );
}

function ActionNode({ data }: NodeProps) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} />
      <BaseNode icon={Send} color="#3B82F6" data={data as FlowNodeData}>
        <Handle type="source" position={Position.Right} />
      </BaseNode>
    </div>
  );
}

function EndNode({ data }: NodeProps) {
  return (
    <div className="relative">
      <Handle type="target" position={Position.Left} />
      <BaseNode icon={Flag} color="#64748B" data={data as FlowNodeData} />
    </div>
  );
}

const NODE_TYPES = { trigger: TriggerNode, condition: ConditionNode, wait: WaitNode, action: ActionNode, end: EndNode };

// ---------------------------------------------------------------------------
// Paleta — só gatilhos/condições/ações que já existem como conceito real no
// CRM (mensagens, tags, funil, tarefas, visitas, IA). Nada aqui dispara nada
// ainda — é só o que vai virar um node no canvas.
// ---------------------------------------------------------------------------

const TRIGGERS = [
  { label: 'Mensagem recebida', icon: MessageSquare },
  { label: 'Tag adicionada', icon: Tag },
  { label: 'Mudança de etapa', icon: KanbanSquare },
  { label: 'Negócio ganho', icon: KanbanSquare },
  { label: 'Negócio perdido', icon: KanbanSquare },
  { label: 'Visita criada', icon: CalendarPlus },
  { label: 'Visita confirmada', icon: CalendarPlus },
  { label: 'Não compareceu', icon: CalendarPlus },
];
const CONDITIONS = [
  { label: 'Mensagem contém...', icon: MessageSquare },
  { label: 'Tag do contato', icon: Tag },
  { label: 'Etapa do funil', icon: KanbanSquare },
  { label: 'Possui visita', icon: CalendarPlus },
];
const ACTIONS = [
  { label: 'Enviar mensagem', icon: MessageSquare },
  { label: 'Adicionar tag', icon: Tag },
  { label: 'Atribuir responsável', icon: UserCheck },
  { label: 'Mover no funil', icon: KanbanSquare },
  { label: 'Criar tarefa', icon: CheckSquare },
  { label: 'Criar visita', icon: CalendarPlus },
  { label: 'Pausar IA', icon: BotOff },
  { label: 'Ativar IA', icon: Bot },
];

let nodeIdCounter = 1;
const nextId = () => `n${Date.now()}_${nodeIdCounter++}`;

export function FlowEditor({
  flow, onClose, onSave,
}: { flow: AutomationFlow; onClose: () => void; onSave: (def: FlowDefinition) => Promise<void> }) {
  const initial = flow.definition?.nodes?.length
    ? flow.definition
    : {
        nodes: [{ id: 'start', type: 'trigger', position: { x: 40, y: 120 }, data: { label: 'Início', subtitle: 'Escolha um gatilho →' } }],
        edges: [],
      };

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(initial.nodes as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges as Edge[]);
  const [selected, setSelected] = useState<Node | null>(null);
  const [saving, setSaving] = useState(false);
  const [paletteTab, setPaletteTab] = useState<'gatilhos' | 'condicoes' | 'acoes'>('gatilhos');

  const onConnect = useCallback((c: Connection) => setEdges((eds) => addEdge(c, eds)), [setEdges]);

  const addNode = (type: keyof typeof NODE_TYPES, label: string) => {
    const id = nextId();
    setNodes((nds) => [
      ...nds,
      { id, type, position: { x: 320 + (nds.length % 4) * 40, y: 80 + (nds.length % 5) * 90 }, data: { label, subtitle: 'Clique para configurar' } },
    ]);
  };

  const updateSelected = (patch: Partial<FlowNodeData>) => {
    if (!selected) return;
    setNodes((nds) => nds.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, ...patch } } : n)));
    setSelected((s) => (s ? { ...s, data: { ...s.data, ...patch } } : s));
  };

  const deleteSelected = () => {
    if (!selected) return;
    setNodes((nds) => nds.filter((n) => n.id !== selected.id));
    setEdges((eds) => eds.filter((e) => e.source !== selected.id && e.target !== selected.id));
    setSelected(null);
  };

  const salvar = async () => {
    setSaving(true);
    try {
      await onSave({ nodes, edges });
      toast.success('Rascunho salvo.');
    } catch (err) {
      toast.error('Falha ao salvar', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  const paletteItems = paletteTab === 'gatilhos' ? TRIGGERS : paletteTab === 'condicoes' ? CONDITIONS : ACTIONS;
  const paletteType: keyof typeof NODE_TYPES = paletteTab === 'gatilhos' ? 'trigger' : paletteTab === 'condicoes' ? 'condition' : 'action';

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-bg-primary)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border-card)] px-4 py-2.5 shrink-0">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[var(--color-text-primary)] truncate">{flow.name}</div>
          <div className="text-[11px] text-[var(--color-text-secondary)]">
            Rascunho — este fluxo ainda não executa nada automaticamente.
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button onClick={() => void salvar()} disabled={saving}>
            <Save className="h-4 w-4" /> {saving ? 'Salvando...' : 'Salvar rascunho'}
          </Button>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fechar">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={NODE_TYPES}
            onNodeClick={(_e, n) => setSelected(n)}
            onPaneClick={() => setSelected(null)}
            colorMode="dark"
            fitView
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(148,163,184,0.15)" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable style={{ background: 'var(--color-surface-raised)' }} />
          </ReactFlow>
        </div>

        {/* Painel direito: paleta (nada selecionado) ou configuração do node */}
        <div className="w-72 shrink-0 border-l border-[var(--color-border-card)] overflow-y-auto p-3">
          {selected ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
                  {selected.type === 'trigger' ? 'Gatilho' : selected.type === 'condition' ? 'Condição' : selected.type === 'wait' ? 'Espera' : selected.type === 'action' ? 'Ação' : 'Fim'}
                </span>
                {selected.id !== 'start' && (
                  <button onClick={deleteSelected} aria-label="Apagar node" className="text-[var(--color-text-secondary)] hover:text-[var(--color-error)]">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">Título</label>
                <input
                  value={(selected.data as FlowNodeData).label}
                  onChange={(e) => updateSelected({ label: e.target.value })}
                  className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">Resumo (config)</label>
                <input
                  value={(selected.data as FlowNodeData).subtitle ?? ''}
                  onChange={(e) => updateSelected({ subtitle: e.target.value })}
                  placeholder="Ex.: Template AMAI PRIME"
                  className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-text-primary)]"
                />
              </div>
              <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
                Configuração detalhada por tipo de node (variáveis, template real, prazo relativo etc.)
                é a próxima etapa — hoje isso só guarda o resumo em texto, pra você desenhar o fluxo.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex gap-1 rounded-lg bg-[var(--color-fill-subtle)] p-1">
                {(['gatilhos', 'condicoes', 'acoes'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setPaletteTab(t)}
                    className={`flex-1 rounded-md py-1 text-[11px] font-semibold capitalize ${paletteTab === t ? 'bg-[var(--accent-fill)] text-white' : 'text-[var(--color-text-secondary)]'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <div className="space-y-1.5">
                {paletteItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      onClick={() => addNode(paletteType, item.label)}
                      className="flex w-full items-center gap-2 rounded-lg border border-[var(--color-border-card)] px-2.5 py-2 text-left text-xs text-[var(--color-text-primary)] hover:border-[var(--accent-primary)] transition-colors"
                    >
                      <Icon className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
                      {item.label}
                      <Plus className="h-3 w-3 ml-auto text-[var(--color-text-secondary)]" />
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => addNode('wait', 'Aguardar')}
                className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--color-border-card)] px-2.5 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)]"
              >
                <Clock className="h-3.5 w-3.5" /> Aguardar <Plus className="h-3 w-3 ml-auto" />
              </button>
              <button
                onClick={() => addNode('end', 'Fim')}
                className="flex w-full items-center gap-2 rounded-lg border border-dashed border-[var(--color-border-card)] px-2.5 py-2 text-left text-xs text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)]"
              >
                <Flag className="h-3.5 w-3.5" /> Fim <Plus className="h-3 w-3 ml-auto" />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const EMPTY_DEFINITION: FlowDefinition = { nodes: [], edges: [] };
