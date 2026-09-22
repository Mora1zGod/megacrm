import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { MobileNav } from './MobileNav';
import { SupportBanner } from './SupportBanner';

export function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    // h-screen + overflow-hidden: a altura da janela é a referência e o scroll
    // acontece DENTRO do <main>, não na página. Assim telas de altura cheia
    // (Inbox) podem usar h-full sem chutar o tamanho do cabeçalho — que varia
    // conforme a faixa de modo suporte aparece ou não.
    <div className="h-screen flex overflow-hidden bg-[var(--color-bg-primary)]">
      <Sidebar />
      <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <SupportBanner />
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 min-h-0 p-3 sm:p-5 overflow-auto" role="main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
