import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GitBranchPlus, Timer, Workflow, Zap } from 'lucide-react';
import { FunnelAutomationsTab } from '@/components/automations/FunnelAutomationsTab';
import { FollowUpsTab } from '@/components/automations/FollowUpsTab';
import { FlowsTab } from '@/components/automations/FlowsTab';

// Automações: regras que já rodam sozinhas de verdade — no Funil (lead entrou
// numa etapa → ações) e em Follow-ups (inatividade/sem compra/sem resposta →
// mensagem) — e a aba Fluxos, o editor visual novo (React Flow), que HOJE só
// desenha e salva rascunho — não executa nada ainda. Propositalmente não
// mexi em como Funil/Follow-ups executam, pra não duplicar engine.
type TabId = 'fluxos' | 'funil' | 'followups';

export default function AutomationsPage() {
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>(() => {
    const t = searchParams.get('tab');
    return t === 'followups' || t === 'funil' ? t : 'fluxos';
  });

  const tabs: { id: TabId; label: string; icon: typeof Zap }[] = [
    { id: 'fluxos', label: 'Fluxos', icon: Workflow },
    { id: 'funil', label: 'Funil', icon: GitBranchPlus },
    { id: 'followups', label: 'Follow-ups', icon: Timer },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Zap className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Seção</div>
          <h1 className="text-2xl font-bold text-display">Automações</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Regras automáticas no funil e follow-ups por tempo/condição.
          </p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-[rgba(14,154,160,0.1)]">
        {tabs.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition ${
                tab === t.id
                  ? 'border-[var(--accent-primary)] text-[var(--accent-secondary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              <Icon className="h-4 w-4" /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'fluxos' ? <FlowsTab /> : tab === 'funil' ? <FunnelAutomationsTab /> : <FollowUpsTab />}
    </div>
  );
}
