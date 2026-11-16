import { Suspense, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { AppErrorBoundary } from '@/components/AppErrorBoundary';
import { PageLoading } from '@/components/PageLoading';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { SupportBanner } from './SupportBanner';
import { MailWatcher } from '@/app/routes/email/mailWatch';
import { PresenceTracker } from '@/hooks/usePresence';
import { useIsMobile } from '@/hooks/useIsMobile';

export function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { pathname } = useLocation();
  const mobile = useIsMobile();

  return (
    // h-screen + overflow-hidden: a altura da janela é a referência e o scroll
    // acontece DENTRO do <main>, não na página. Assim telas de altura cheia
    // (Inbox) podem usar h-full sem chutar o tamanho do cabeçalho — que varia
    // conforme a faixa de modo suporte aparece ou não.
    <div className="h-dvh flex overflow-hidden bg-[var(--color-bg-primary)]">
      <Sidebar />
      <MailWatcher />
      <PresenceTracker />
      <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* No celular a faixa de suporte vai dentro do topo (Header → MobileTop). */}
        {!mobile && <SupportBanner />}
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 min-h-0 overflow-auto p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:p-5" role="main">
          {/* Erro numa tela não derruba o menu; carregar uma tela mostra a barrinha no topo, não tela branca. */}
          <AppErrorBoundary key={pathname} scope="page">
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </AppErrorBoundary>
        </main>
      </div>
    </div>
  );
}
