import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Bot, BookOpen, Clock, Image, LayoutDashboard, Layers, ListTree, Loader2, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { AIAgentSettings } from '../settings/sections/AIAgentSettings';
import { AIAgentProfiles } from '../settings/sections/AIAgentProfiles';
import { AgentMediaSettings } from '../settings/sections/AgentMediaSettings';
import { BusinessHoursSettings } from '../settings/sections/BusinessHoursSettings';
import KnowledgePage from '../knowledge/KnowledgePage';
import { AmaiaOverviewTab } from '@/components/aiagent/AmaiaOverviewTab';
import { AmaiaConversationsTab } from '@/components/aiagent/AmaiaConversationsTab';
import { AmaiaLogsTab } from '@/components/aiagent/AmaiaLogsTab';

type TabId = 'overview' | 'agent' | 'profiles' | 'media' | 'knowledge' | 'hours' | 'conversations' | 'logs';

interface TabDef {
  id: TabId;
  label: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Visão geral', icon: LayoutDashboard, render: () => <AmaiaOverviewTab /> },
  { id: 'agent', label: 'Agente', icon: Bot, render: () => <AIAgentSettings /> },
  { id: 'profiles', label: 'Modelos', icon: Layers, render: () => <AIAgentProfiles /> },
  { id: 'knowledge', label: 'Base de Conhecimento', icon: BookOpen, render: () => <KnowledgePage /> },
  { id: 'media', label: 'Mídias', icon: Image, render: () => <AgentMediaSettings /> },
  { id: 'hours', label: 'Horário de atendimento', icon: Clock, render: () => <BusinessHoursSettings /> },
  { id: 'conversations', label: 'Conversas', icon: MessageSquare, render: () => <AmaiaConversationsTab /> },
  { id: 'logs', label: 'Logs', icon: ListTree, render: () => <AmaiaLogsTab /> },
];

export default function AIAgentPage() {
  const { role, loading } = useAppUser();
  const [active, setActive] = useState<TabId>('overview');
  const current = TABS.find((t) => t.id === active) ?? TABS[0];

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" />
      </div>
    );
  }
  // Tela admin-only: configuração do agente, mídias, base, follow-ups e horário.
  if (role !== 'admin') return <Navigate to="/dashboard" replace />;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Bot className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Seção</div>
          <h1 className="text-2xl font-bold text-display">Agente de IA</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Configuração do agente, base de conhecimento, follow-ups e horário
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-[var(--color-border-card)]">
        {TABS.map((t) => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActive(t.id)}
              className={cn(
                'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
                isActive
                  ? 'border-[var(--accent-primary)] text-[var(--color-text-primary)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div>{current.render()}</div>
    </div>
  );
}
