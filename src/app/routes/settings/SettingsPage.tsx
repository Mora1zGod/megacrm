import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity, BellRing, ArrowLeft, Bot, Building2, Cake, ChevronRight, Clock, GitBranchPlus, KeyRound, ListOrdered, Lock, Mail, MessagesSquare, Moon,
  Package, Palette, Plug, ScrollText, Server, Settings as SettingsIcon, ShieldCheck, Sun, Timer, UserCircle2, Users, UsersRound, Wallet,
  Webhook, Workflow, Zap, type LucideIcon,
} from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AccountSettings } from './sections/AccountSettings';
import { TeamSettings } from './sections/TeamSettings';
import { ChannelsSettings } from './sections/ChannelsSettings';
import { ProductsSettings } from './sections/ProductsSettings';
import { ApiKeysSettings } from './sections/ApiKeysSettings';
import { BrandingSettings } from './sections/BrandingSettings';
import { QuickRepliesSettings } from './sections/QuickRepliesSettings';
import { BirthdaySettings } from './sections/BirthdaySettings';
import { AttendanceSettings } from './sections/AttendanceSettings';
import { AccessSettings } from './sections/access/AccessSettings';
import { CompaniesSection } from './companies/CompaniesSection';
import { CompanyEditor } from './companies/CompanyEditor';
import { ChannelsStatus, ExternalServices, IntegrationsHub, WebhooksPanel } from './integrations/IntegrationsHub';
import { WaNotifySettings } from './integrations/WaNotifySettings';
import { SettingsTab as AsaasSettings } from '../finance/SettingsTab';

const AuditLogPage = lazy(() => import('../admin/AuditLogPage'));
const AdminPage = lazy(() => import('../admin/AdminPage'));

// ============================================================================
// Configurações = centro administrativo. 6 categorias → cartões → tela do item.
// Rotas: /configuracoes/:section/:item  (empresas: /configuracoes/empresas/:id?aba=…)
// Cada item reaproveita a tela que já existia; nada foi removido.
// ============================================================================
interface Item {
  id: string; title: string; desc: string; icon: LucideIcon;
  perm?: string; anyPerm?: string[]; superAdmin?: boolean;
  render?: () => ReactNode;   // tela dentro de Configurações
  to?: string;                // ou atalho para a página do módulo
}
interface SectionDef { id: string; title: string; desc: string; icon: LucideIcon; items: Item[]; render?: () => ReactNode }

const SECTIONS: SectionDef[] = [
  {
    id: 'conta', title: 'Conta', desc: 'Seu perfil, e-mail, senha e preferências', icon: UserCircle2,
    items: [
      { id: 'perfil', title: 'Meu perfil', desc: 'Nome, foto, e-mail e senha', icon: UserCircle2, render: () => <AccountSettings /> },
      { id: 'preferencias', title: 'Preferências', desc: 'Tema e empresa padrão', icon: Sun, render: () => <Preferences /> },
    ],
  },
  {
    id: 'equipe', title: 'Equipe e acessos', desc: 'Usuários, perfis, equipes e filas', icon: ShieldCheck,
    items: [
      { id: 'usuarios', title: 'Usuários', desc: 'Convidar, aprovar cadastros, ativar e desativar', icon: Users, perm: 'users.view', render: () => <AccessSettings initialTab="users" /> },
      { id: 'perfis', title: 'Perfis de acesso', desc: 'O que cada função pode ver e fazer', icon: ShieldCheck, perm: 'users.view', render: () => <AccessSettings initialTab="roles" /> },
      { id: 'equipes', title: 'Equipes / setores', desc: 'Agrupe as pessoas e defina gestores', icon: UsersRound, perm: 'users.view', render: () => <AccessSettings initialTab="teams" /> },
      { id: 'filas', title: 'Filas de atendimento', desc: 'Rodízio e distribuição das conversas', icon: ListOrdered, perm: 'users.view', render: () => <TeamSettings /> },
    ],
  },
  {
    id: 'integracoes', title: 'Comunicação e integrações', desc: 'WhatsApp, Instagram, e-mail, APIs e webhooks', icon: Plug,
    render: () => <IntegrationsHub />,
    items: [
      { id: 'canais', title: 'WhatsApp e Instagram', desc: 'Números, contas e conexões', icon: MessagesSquare, perm: 'settings.channels', render: () => <ChannelsSettings /> },
      { id: 'avisos', title: 'Notificações WhatsApp', desc: 'Número que envia os avisos e quem recebe', icon: BellRing, anyPerm: ['settings.channels', 'financial.ledger_view'], render: () => <WaNotifySettings /> },
      { id: 'status', title: 'Status dos canais', desc: 'Conectado, desconectado e última mensagem', icon: Activity, perm: 'settings.channels', render: () => <ChannelsStatus /> },
      { id: 'api', title: 'APIs', desc: 'Chaves de integração', icon: KeyRound, perm: 'settings.integrations', render: () => <ApiKeysSettings /> },
      { id: 'webhooks', title: 'Webhooks', desc: 'Endereços e últimos avisos', icon: Webhook, anyPerm: ['settings.integrations', 'settings.channels'], render: () => <WebhooksPanel /> },
      { id: 'externas', title: 'IA, e-mail e serviços externos', desc: 'OpenAI, LLM do agente, SMTP', icon: Server, render: () => <ExternalServices /> },
      { id: 'asaas', title: 'ASAAS (boleto e PIX)', desc: 'Cobrança e aviso de pagamento', icon: Wallet, perm: 'financial.setup', render: () => <AsaasSettings /> },
    ],
  },
  {
    id: 'automacao', title: 'Automação e IA', desc: 'AMAIA, automações, respostas rápidas e SLA', icon: Bot,
    items: [
      { id: 'amaia', title: 'AMAIA (agente de IA)', desc: 'Treinamento, modelos, base e mídias', icon: Bot, perm: 'settings.ai', to: '/ai-agent' },
      { id: 'horario', title: 'Horário de atendimento', desc: 'Quando a AMAIA responde', icon: Clock, perm: 'settings.ai', to: '/ai-agent?tab=hours' },
      { id: 'automacoes', title: 'Automações', desc: 'Fluxos de mensagens', icon: Workflow, perm: 'automations.view', to: '/automations' },
      { id: 'regras', title: 'Regras automáticas', desc: 'Funil e follow-ups', icon: GitBranchPlus, perm: 'automations.view', to: '/automations?tab=funil' },
      { id: 'respostas', title: 'Respostas rápidas', desc: 'Atalhos do Atendimento', icon: Zap, render: () => <QuickRepliesSettings /> },
      { id: 'sla', title: 'Atendimento / SLA', desc: 'Tempo de resposta e alertas', icon: Timer, perm: 'settings.edit', render: () => <AttendanceSettings /> },
      { id: 'aniversario', title: 'Aniversário', desc: 'Mensagem automática de aniversário', icon: Cake, perm: 'settings.edit', render: () => <BirthdaySettings /> },
    ],
  },
  {
    id: 'empresas', title: 'Empresas / Organizações', desc: 'Dados, fiscal, financeiro, compras e certificados', icon: Building2,
    render: () => <CompaniesSection />,
    items: [],
  },
  {
    id: 'sistema', title: 'Sistema', desc: 'Identidade visual, segurança, auditoria e produtos', icon: SettingsIcon,
    items: [
      { id: 'identidade', title: 'Identidade visual', desc: 'Logo, nome e tema da organização', icon: Palette, perm: 'settings.edit', render: () => <BrandingSettings /> },
      { id: 'produtos', title: 'Produtos', desc: 'Catálogo usado nas vendas', icon: Package, perm: 'settings.edit', render: () => <ProductsSettings /> },
      { id: 'seguranca', title: 'Segurança', desc: 'Entradas no sistema e mudanças de acesso', icon: Lock, perm: 'audit.view', render: () => <AccessSettings initialTab="audit" /> },
      { id: 'auditoria', title: 'Logs de auditoria', desc: 'Quem fez o quê, e quando', icon: ScrollText, perm: 'audit.view', render: () => <Suspense fallback={<Skeleton className="h-60" />}><AuditLogPage /></Suspense> },
      { id: 'api', title: 'API', desc: 'Chaves de integração', icon: KeyRound, perm: 'settings.integrations', to: '/configuracoes/integracoes/api' },
      { id: 'notificacoes', title: 'Notificações', desc: 'Avisos do navegador neste aparelho', icon: Mail, render: () => <BrowserNotifications /> },
      { id: 'organizacoes', title: 'Organizações da instância', desc: 'Criar, arquivar e entrar em organizações', icon: Building2, superAdmin: true, render: () => <Suspense fallback={<Skeleton className="h-60" />}><AdminPage /></Suspense> },
    ],
  },
];

// Abas antigas (?tab=) → endereço novo. Mantém os links/atalhos antigos funcionando.
const LEGACY_TAB: Record<string, string> = {
  account: 'conta/perfil', access: 'equipe/usuarios', team: 'equipe/filas', channels: 'integracoes/canais', products: 'sistema/produtos',
  attendance: 'automacao/sla', quick_replies: 'automacao/respostas', birthday: 'automacao/aniversario', branding: 'sistema/identidade', api: 'integracoes/api',
};
export function LegacySettingsRedirect() {
  const loc = useLocation();
  const tab = new URLSearchParams(loc.search).get('tab') ?? 'account';
  return <Navigate to={`/configuracoes/${LEGACY_TAB[tab] ?? 'conta/perfil'}`} replace />;
}

export default function SettingsPage() {
  const { section: sectionId, item: itemId } = useParams();
  const navigate = useNavigate();
  const perms = usePermission();
  const { isSuperAdmin, loading } = useAppUser();
  const allowed = (i: Item) => (i.superAdmin ? isSuperAdmin : (!i.perm || perms.can(i.perm)) && (!i.anyPerm || i.anyPerm.some((p) => perms.can(p))));
  const sections = SECTIONS.map((s) => ({ ...s, items: s.items.filter(allowed) }))
    .filter((s) => s.items.length > 0 || (s.id === 'empresas' && (perms.can('financial.ledger_view') || perms.can('purchases.view'))) || (s.id === 'integracoes' && s.render));

  if (loading || perms.loading) return <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-96" /></div>;
  const section = sections.find((s) => s.id === sectionId);
  if (!section) return <Navigate to={`/configuracoes/${sections[0]?.id ?? 'conta'}`} replace />;
  const item = section.id === 'empresas' ? undefined : section.items.find((i) => i.id === itemId);
  if (itemId && section.id !== 'empresas' && !item) return <Navigate to={`/configuracoes/${section.id}`} replace />;
  if (item?.to) return <Navigate to={item.to} replace />;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl glass-card"><SettingsIcon className="h-5 w-5 text-[var(--accent-primary)]" /></div>
        <div>
          <nav className="text-xs text-[var(--color-text-muted)]" aria-label="Caminho">
            <Link to="/configuracoes" className="hover:underline">Configurações</Link> <span aria-hidden>›</span>{' '}
            <Link to={`/configuracoes/${section.id}`} className="hover:underline">{section.title}</Link>
            {item && <> <span aria-hidden>›</span> <span className="text-[var(--color-text-secondary)]">{item.title}</span></>}
          </nav>
          <h1 className="text-2xl font-bold text-display">Configurações</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">O centro administrativo do sistema.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[270px_1fr]">
        <aside className="h-fit rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-2 lg:sticky lg:top-2">
          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Categorias de configuração">
            {sections.map((s) => {
              const on = s.id === section.id;
              return (
                <button key={s.id} type="button" onClick={() => navigate(`/configuracoes/${s.id}`)} aria-current={on ? 'page' : undefined}
                  className={cn('flex shrink-0 items-start gap-3 rounded-[var(--radius-control)] border-l-2 px-3 py-2.5 text-left transition-colors',
                    on ? 'border-[var(--accent-fill)] bg-[var(--color-accent-subtle)]' : 'border-transparent hover:bg-[var(--color-surface-hover)]')}>
                  <s.icon className={cn('mt-0.5 h-4 w-4 shrink-0', on ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)]')} />
                  <span className="min-w-0">
                    <span className={cn('block text-sm font-semibold leading-tight', on ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-primary)]')}>{s.title}</span>
                    <span className="hidden text-[11px] text-[var(--color-text-muted)] lg:block">{s.desc}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0">
          {section.id === 'empresas' && itemId ? <CompanyEditor id={itemId} /> : item ? (
            <div className="space-y-4">
              <button type="button" onClick={() => navigate(`/configuracoes/${section.id}`)} className="flex items-center gap-1.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                <ArrowLeft className="h-4 w-4" /> {section.title}
              </button>
              {item.render?.()}
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">{section.title}</h2>
                <p className="text-sm text-[var(--color-text-secondary)]">{section.desc}</p>
              </div>
              {section.render?.()}
              {section.items.length > 0 && section.id !== 'integracoes' && (
                <div>
                  {section.render && <h3 className="mb-3 text-sm font-semibold text-[var(--color-text-secondary)]">Todas as opções</h3>}
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {section.items.map((i) => (
                      <Link key={i.id} to={i.to ?? `/configuracoes/${section.id}/${i.id}`}
                        className="group flex items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 transition-colors hover:border-[var(--accent-primary)]">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><i.icon className="h-5 w-5" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-[var(--color-text-primary)]">{i.title}</span>
                          <span className="block text-xs text-[var(--color-text-muted)]">{i.desc}{i.to && !i.to.startsWith('/configuracoes') ? ' · abre o módulo' : ''}</span>
                        </span>
                        <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// Conta → Preferências: tema e empresa padrão (que vem marcada nos lançamentos).
function Preferences() {
  const { effectiveTheme, toggleTheme } = useAppUser();
  const [company, setCompany] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const sb = getSupabase();
    sb.rpc('my_default_company').then(async ({ data, error }) => {
      if (error || !data) { setCompany(null); return; }
      const { data: c } = await sb.from('fin_companies').select('name').eq('id', String(data)).maybeSingle();
      setCompany((c?.name as string | undefined) ?? null);
    });
  }, []);
  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <div>
          <div className="font-semibold text-[var(--color-text-primary)]">Tema</div>
          <p className="text-sm text-[var(--color-text-secondary)]">Vale só para você, neste navegador.</p>
        </div>
        <button type="button" onClick={toggleTheme} className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-4 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
          {effectiveTheme === 'dark' ? <><Moon className="h-4 w-4" /> Escuro</> : <><Sun className="h-4 w-4" /> Claro</>}
        </button>
      </div>
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
        <div className="font-semibold text-[var(--color-text-primary)]">Empresa padrão</div>
        <p className="text-sm text-[var(--color-text-secondary)]">
          {company === undefined ? 'Carregando…' : company ? <>Sua empresa padrão é <b>{company}</b>.</> : 'Nenhuma definida — o sistema usa a empresa padrão do grupo.'}
          {' '}Quem define é o administrador em Empresas → Usuários.
        </p>
      </div>
    </div>
  );
}

// Sistema → Notificações: permissão de aviso do navegador neste aparelho.
function BrowserNotifications() {
  const supported = typeof window !== 'undefined' && 'Notification' in window;
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(supported ? Notification.permission : 'unsupported');
  return (
    <div className="max-w-2xl space-y-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4">
      <div className="font-semibold text-[var(--color-text-primary)]">Avisos do navegador</div>
      <p className="text-sm text-[var(--color-text-secondary)]">
        {perm === 'unsupported' ? 'Este navegador não mostra avisos.' : perm === 'granted' ? 'Ligados neste aparelho.' : perm === 'denied' ? 'Bloqueados: libere nas configurações do navegador (cadeado ao lado do endereço).' : 'Ainda não liberados neste aparelho.'}
        {' '}O sino no topo continua mostrando tudo dentro do sistema.
      </p>
      {perm === 'default' && (
        <button type="button" onClick={() => void Notification.requestPermission().then(setPerm)} className="inline-flex h-9 items-center rounded-[var(--radius-control)] bg-[var(--accent-fill)] px-3.5 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]">Liberar avisos</button>
      )}
    </div>
  );
}
