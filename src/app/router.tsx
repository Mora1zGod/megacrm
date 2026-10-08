import { lazy, Suspense, type ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppLayout } from './layout/AppLayout';
import { useSupabaseConfig } from '@/hooks/useSupabase';
import { useAuth } from './providers/AuthProvider';
import { useAppUser } from './providers/AppUserProvider';
import { usePermission } from './providers/PermissionsProvider';
import { firstAllowedPath } from './layout/nav-config';
import { AccessGate } from './AccessGate';
import { Skeleton } from '@/components/ui/skeleton';

// Lazy loading the page chunks keeps the initial bundle lean.
const SetupPage = lazy(() => import('./routes/setup/SetupPage'));
const LoginPage = lazy(() => import('./routes/auth/LoginPage'));
const SignupPage = lazy(() => import('./routes/auth/SignupPage'));
const InvitePage = lazy(() => import('./routes/invite/InvitePage'));
const SelfSignupPage = lazy(() => import('./routes/auth/SelfSignupPage'));
const DashboardPage = lazy(() => import('./routes/dashboard/DashboardPage'));
const InboxPage = lazy(() => import('./routes/inbox/InboxPage'));
const CampaignsPage = lazy(() => import('./routes/campaigns/CampaignsPage'));
const ContactsPage = lazy(() => import('./routes/contacts/ContactsPage'));
const ContactDetailPage = lazy(() => import('./routes/contacts/ContactDetailPage'));
const FunilPage = lazy(() => import('./routes/funil/FunilPage'));
const VisitsPage = lazy(() => import('./routes/visits/VisitsPage'));
const BoardsPage = lazy(() => import('./routes/boards/BoardsPage'));
const AIAgentPage = lazy(() => import('./routes/ai-agent/AIAgentPage'));
const AutomationsPage = lazy(() => import('./routes/automations/AutomationsPage'));
const SettingsPage = lazy(() => import('./routes/settings/SettingsPage'));
const LegacySettingsRedirect = lazy(() => import('./routes/settings/SettingsPage').then((m) => ({ default: m.LegacySettingsRedirect })));
const FinancePage = lazy(() => import('./routes/finance/FinancePage'));
const PurchasesPage = lazy(() => import('./routes/purchases/PurchasesPage'));
const ReportsPage = lazy(() => import('./routes/reports/ReportsPage'));
const FilesPage = lazy(() => import('./routes/files/FilesPage'));
const ChatPage = lazy(() => import('./routes/chat/ChatPage'));
const SalesTvPage = lazy(() => import('./routes/tv/SalesTvPage'));
const AccessDeniedPage = lazy(() => import('./routes/errors/AccessDeniedPage'));

function PageFallback() {
  return (
    <div className="max-w-7xl mx-auto space-y-6 p-6" aria-busy="true" aria-label="Carregando página">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

function RequireSetup({ children }: { children: ReactElement }) {
  const { configured } = useSupabaseConfig();
  const location = useLocation();
  if (!configured) {
    return <Navigate to="/setup" state={{ from: location.pathname }} replace />;
  }
  return children;
}

function RequireSession({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <PageFallback />;
  if (!session) {
    return (
      <Navigate to="/auth/login" state={{ from: location.pathname }} replace />
    );
  }
  return children;
}

// Rota liberada por permissão (perfil + exceções). Sem permissão: tela
// "Acesso restrito" — a página nem monta, então nada daquela área é carregado.
// O bloqueio real dos dados é do banco (RLS); isto é a camada da interface.
function RequirePermission({ perm, area, children }: { perm: string; area?: string; children: ReactElement }) {
  const { loading: userLoading } = useAppUser();
  const { can, loading } = usePermission();
  if (userLoading || loading) return <PageFallback />;
  if (!can(perm)) return <AccessDeniedPage area={area} />;
  return children;
}

function RequireAnyPermission({ perms: keys, area, children }: { perms: string[]; area?: string; children: ReactElement }) {
  const { loading: userLoading } = useAppUser();
  const { can, loading } = usePermission();
  if (userLoading || loading) return <PageFallback />;
  if (!keys.some((k) => can(k))) return <AccessDeniedPage area={area} />;
  return children;
}

// "/" e rotas desconhecidas: vai para a 1ª área liberada do usuário.
function HomeRedirect() {
  const { loading: userLoading } = useAppUser();
  const { can, loading } = usePermission();
  if (userLoading || loading) return <PageFallback />;
  return <Navigate to={firstAllowedPath(can)} replace />;
}

// Console /admin: restrito ao super admin. Demais usuários vão pro dashboard.
function RequireSuperAdmin({ children }: { children: ReactElement }) {
  const { isSuperAdmin, loading } = useAppUser();
  if (loading) return <PageFallback />;
  if (!isSuperAdmin) {
    return <Navigate to="/" replace />;
  }
  return children;
}

function RedirectIfConfigured({ children }: { children: ReactElement }) {
  const { configured } = useSupabaseConfig();
  const { session } = useAuth();
  const location = useLocation();
  const setupStep = new URLSearchParams(location.search).get('step');
  if (configured) {
    if (location.pathname === '/setup' && setupStep === '4') {
      return children;
    }
    // Already configured → move the user forward. If they also have a
    // session, jump straight to dashboard; otherwise to login.
    return <Navigate to={session ? '/' : '/auth/login'} replace />;
  }
  return children;
}

function RedirectIfAuthenticated({ children }: { children: ReactElement }) {
  const { session, loading } = useAuth();
  if (loading) return <PageFallback />;
  if (session) {
    return <Navigate to="/" replace />;
  }
  return children;
}

export function AppRouter() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route
          path="/setup"
          element={
            <RedirectIfConfigured>
              <SetupPage />
            </RedirectIfConfigured>
          }
        />

        <Route
          path="/auth/login"
          element={
            <RequireSetup>
              <RedirectIfAuthenticated>
                <LoginPage />
              </RedirectIfAuthenticated>
            </RequireSetup>
          }
        />
        <Route
          path="/auth/signup"
          element={
            <RequireSetup>
              <RedirectIfAuthenticated>
                <SignupPage />
              </RedirectIfAuthenticated>
            </RequireSetup>
          }
        />
        {/* Cadastro pelo link do administrador (fica aguardando aprovação). */}
        <Route
          path="/cadastro/:token"
          element={
            <RequireSetup>
              <SelfSignupPage />
            </RequireSetup>
          }
        />
        {/* /invite NÃO usa RedirectIfAuthenticated: o link de convite do
            Supabase estabelece uma sessão, e o convidado precisa dela aberta
            para definir a senha (updateUser) antes de seguir para o app. */}
        <Route
          path="/invite"
          element={
            <RequireSetup>
              <InvitePage />
            </RequireSetup>
          }
        />

        {/* Painel TV: tela cheia, fora do layout (sem menu/topo). */}
        <Route
          path="/painel-tv"
          element={
            <RequireSetup>
              <RequireSession>
                <AccessGate>
                  <RequirePermission perm="financial.tv" area="Painel TV">
                    <SalesTvPage />
                  </RequirePermission>
                </AccessGate>
              </RequireSession>
            </RequireSetup>
          }
        />

        <Route
          element={
            <RequireSetup>
              <RequireSession>
                <AccessGate>
                  <AppLayout />
                </AccessGate>
              </RequireSession>
            </RequireSetup>
          }
        >
          <Route index element={<HomeRedirect />} />
          <Route path="/dashboard" element={<RequirePermission perm="dashboard.view" area="Visão geral"><DashboardPage /></RequirePermission>} />
          <Route path="/inbox" element={<RequirePermission perm="inbox.view" area="Atendimento"><InboxPage /></RequirePermission>} />
          <Route path="/campaigns" element={<RequirePermission perm="campaigns.view" area="Campanhas"><CampaignsPage /></RequirePermission>} />
          {/* Templates virou aba dentro de Campanhas (Módulo 1) — preserva links salvos. */}
          <Route path="/templates" element={<Navigate to="/campaigns?tab=templates" replace />} />
          <Route path="/contacts" element={<RequirePermission perm="contacts.view" area="Contatos"><ContactsPage /></RequirePermission>} />
          <Route path="/contacts/:id" element={<RequirePermission perm="contacts.view" area="Contatos"><ContactDetailPage /></RequirePermission>} />
          <Route path="/arquivos" element={<RequirePermission perm="files.view" area="Arquivos"><FilesPage /></RequirePermission>} />
          {/* Chat Interno: aberto a toda a equipe (sem AdminOnly). */}
          <Route path="/chat" element={<RequirePermission perm="chat.view" area="Chat da equipe"><ChatPage /></RequirePermission>} />
          <Route path="/funil" element={<RequirePermission perm="deals.view" area="Funil"><FunilPage /></RequirePermission>} />
          <Route path="/agenda" element={<RequirePermission perm="visits.view" area="Agenda"><VisitsPage /></RequirePermission>} />
          {/* Visitas virou Agenda (visitas + tarefas + lembretes) — mantém links antigos. */}
          <Route path="/visitas" element={<RequirePermission perm="visits.view" area="Agenda"><VisitsPage /></RequirePermission>} />
          <Route path="/quadros" element={<RequireAnyPermission perms={['boards.view', 'tasks.view']} area="Tarefas e quadros"><BoardsPage /></RequireAnyPermission>} />
          {/* /vendas (Vendas & Recompra) removido — redireciona pro dashboard */}
          <Route path="/vendas" element={<HomeRedirect />} />
          {/* /projetos (Entrega) e /educacao removidos — redirecionam pro funil */}
          <Route path="/projetos" element={<Navigate to="/funil" replace />} />
          <Route path="/educacao" element={<Navigate to="/funil" replace />} />
          <Route path="/ai-agent" element={<RequirePermission perm="settings.ai" area="Agente de IA"><AIAgentPage /></RequirePermission>} />
          <Route path="/automations" element={<RequirePermission perm="automations.view" area="Automações"><AutomationsPage /></RequirePermission>} />
          {/* Rotas antigas → agora abas dentro de /ai-agent */}
          <Route path="/knowledge" element={<Navigate to="/ai-agent" replace />} />
          <Route path="/follow-ups" element={<Navigate to="/automations?tab=followups" replace />} />
          {/* Configurações (centro administrativo). Rotas antigas redirecionam mantendo a aba. */}
          <Route path="/configuracoes" element={<SettingsPage />} />
          <Route path="/configuracoes/:section" element={<SettingsPage />} />
          <Route path="/configuracoes/:section/:item" element={<SettingsPage />} />
          <Route path="/settings" element={<LegacySettingsRedirect />} />
          <Route path="/settings/profile" element={<LegacySettingsRedirect />} />
          <Route path="/admin" element={<RequireSuperAdmin><Navigate to="/configuracoes/sistema/organizacoes" replace /></RequireSuperAdmin>} />
          <Route path="/financeiro" element={<RequirePermission perm="financial.ledger_view" area="Financeiro"><FinancePage /></RequirePermission>} />
          <Route path="/compras" element={<RequirePermission perm="purchases.view" area="Compras"><PurchasesPage /></RequirePermission>} />
          <Route path="/tasks" element={<Navigate to="/quadros?modo=caixa" replace />} />
          <Route path="/relatorios" element={<RequirePermission perm="reports.view" area="Relatórios"><ReportsPage /></RequirePermission>} />
          <Route path="/integracoes" element={<Navigate to="/configuracoes/integracoes" replace />} />
          <Route path="/logs-auditoria" element={<Navigate to="/configuracoes/sistema/auditoria" replace />} />
          {/* Credenciais agora é aba dentro de Configurações */}
          <Route path="/settings/credentials" element={<Navigate to="/configuracoes/integracoes/externas" replace />} />
        </Route>

        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </Suspense>
  );
}
