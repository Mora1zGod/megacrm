import {
  LayoutDashboard,
  Inbox,
  Megaphone,
  Users,
  Bot,
  Settings,
  KanbanSquare,
  Zap,
  Building2,
  CalendarDays,
  ClipboardList,
  CheckSquare,
  BarChart3,
  Plug,
  ScrollText,
  Paperclip,
  MessagesSquare,
  Wallet,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  group: 'Operação' | 'Engajamento' | 'Gestão' | 'Administração';
  // Itens adminOnly só aparecem para role 'admin'. Operadores não veem
  // Credenciais (escrita admin-only — antes a rota existia mas sem link,
  // deixando Configurações/Equipe/Conta inalcançáveis pela UI).
  adminOnly?: boolean;
  // Itens superAdminOnly só aparecem para o super admin da instância
  // (JWT is_super_admin). Ex.: console de Organizações (/admin).
  superAdminOnly?: boolean;
  // Permissão que libera o item (e a rota). Sem `perm` = sempre visível.
  perm?: string;
}

// Single source of truth for both the Sidebar and the router. Adding a new
// app section is a one-liner here.
// Base de Conhecimento, Follow-ups e Horário de atendimento viraram abas dentro
// de /ai-agent. Credenciais virou aba dentro de Configurações. Templates virou
// aba dentro de /campaigns (Módulo 1).
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Visão geral', icon: LayoutDashboard, group: 'Operação', perm: 'dashboard.view' },
  { to: '/inbox', label: 'Atendimento', icon: Inbox, group: 'Operação', perm: 'inbox.view' },
  { to: '/funil', label: 'Funil', icon: KanbanSquare, group: 'Operação', perm: 'deals.view' },
  { to: '/agenda', label: 'Agenda', icon: CalendarDays, group: 'Operação', perm: 'visits.view' },
  { to: '/contacts', label: 'Contatos', icon: Users, group: 'Operação', perm: 'contacts.view' },
  { to: '/arquivos', label: 'Arquivos', icon: Paperclip, group: 'Operação', perm: 'files.view' },
  { to: '/chat', label: 'Chat da equipe', icon: MessagesSquare, group: 'Operação', perm: 'chat.view' },
  { to: '/campaigns', label: 'Campanhas', icon: Megaphone, group: 'Engajamento', perm: 'campaigns.view' },
  { to: '/automations', label: 'Automações', icon: Zap, group: 'Engajamento', perm: 'automations.view' },
  { to: '/ai-agent', label: 'Agente de IA', icon: Bot, group: 'Engajamento', perm: 'settings.ai' },
  { to: '/quadros', label: 'Quadros', icon: ClipboardList, group: 'Gestão', perm: 'boards.view' },
  { to: '/financeiro', label: 'Financeiro', icon: Wallet, group: 'Gestão', perm: 'financial.ledger_view' },
  { to: '/compras', label: 'Compras', icon: ShoppingCart, group: 'Gestão', perm: 'purchases.view' },
  { to: '/tasks', label: 'Tarefas', icon: CheckSquare, group: 'Gestão', perm: 'tasks.view' },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, group: 'Gestão', perm: 'reports.view' },
  { to: '/settings/profile', label: 'Configurações', icon: Settings, group: 'Administração' },
  { to: '/integracoes', label: 'Integrações', icon: Plug, group: 'Administração', perm: 'settings.integrations' },
  { to: '/logs-auditoria', label: 'Logs de Auditoria', icon: ScrollText, group: 'Administração', perm: 'audit.view' },
  { to: '/admin', label: 'Organizações', icon: Building2, group: 'Administração', superAdminOnly: true },
];

// Item visível para o usuário? (super admin só para /admin; `perm` via can()).
export function navItemVisible(item: NavItem, can: (key: string) => boolean, isSuperAdmin: boolean): boolean {
  if (item.superAdminOnly) return isSuperAdmin;
  if (item.perm) return can(item.perm);
  return true;
}

// "Início" do usuário: a 1ª área liberada no menu (Visão geral para quem pode).
export function firstAllowedPath(can: (key: string) => boolean): string {
  const item = NAV_ITEMS.find((i) => !i.superAdminOnly && (!i.perm || can(i.perm)) && i.to !== '/settings/profile');
  return item?.to ?? '/settings/profile';
}
