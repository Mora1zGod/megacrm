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
}

// Single source of truth for both the Sidebar and the router. Adding a new
// app section is a one-liner here.
// Base de Conhecimento, Follow-ups e Horário de atendimento viraram abas dentro
// de /ai-agent. Credenciais virou aba dentro de Configurações. Templates virou
// aba dentro de /campaigns (Módulo 1).
export const NAV_ITEMS: NavItem[] = [
  { to: '/dashboard', label: 'Visão geral', icon: LayoutDashboard, group: 'Operação', adminOnly: true },
  { to: '/inbox', label: 'Atendimento', icon: Inbox, group: 'Operação' },
  { to: '/funil', label: 'Funil', icon: KanbanSquare, group: 'Operação', adminOnly: true },
  { to: '/visitas', label: 'Visitas', icon: CalendarDays, group: 'Operação' },
  { to: '/contacts', label: 'Contatos', icon: Users, group: 'Operação' },
  { to: '/arquivos', label: 'Arquivos', icon: Paperclip, group: 'Operação' },
  { to: '/chat', label: 'Chat da equipe', icon: MessagesSquare, group: 'Operação' },
  { to: '/campaigns', label: 'Campanhas', icon: Megaphone, group: 'Engajamento' },
  { to: '/automations', label: 'Automações', icon: Zap, group: 'Engajamento', adminOnly: true },
  { to: '/ai-agent', label: 'Agente de IA', icon: Bot, group: 'Engajamento', adminOnly: true },
  { to: '/quadros', label: 'Quadros', icon: ClipboardList, group: 'Gestão' },
  { to: '/tasks', label: 'Tarefas', icon: CheckSquare, group: 'Gestão' },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, group: 'Gestão', adminOnly: true },
  { to: '/settings/profile', label: 'Configurações', icon: Settings, group: 'Administração' },
  { to: '/integracoes', label: 'Integrações', icon: Plug, group: 'Administração', adminOnly: true },
  { to: '/logs-auditoria', label: 'Logs de Auditoria', icon: ScrollText, group: 'Administração', adminOnly: true },
  { to: '/admin', label: 'Organizações', icon: Building2, group: 'Administração', superAdminOnly: true },
];
