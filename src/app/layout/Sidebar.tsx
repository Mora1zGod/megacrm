import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, type NavItem } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useTasks } from '@/hooks/useTasks';
import { useInternalChat } from '@/hooks/useInternalChat';

const GROUP_ORDER: NavItem['group'][] = ['Operação', 'Engajamento', 'Gestão', 'Administração'];

export function Sidebar() {
  const { role, isSuperAdmin } = useAppUser();
  const { pendingCount } = useTasks();
  const { unreadTotal } = useInternalChat();
  // Preferência de recolhimento persiste entre navegações/sessões.
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar_collapsed') === '1',
  );
  const toggle = () =>
    setCollapsed((v) => {
      localStorage.setItem('sidebar_collapsed', v ? '0' : '1');
      return !v;
    });

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.superAdminOnly) return isSuperAdmin;
    if (item.adminOnly) return role === 'admin';
    return true;
  });
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: visibleItems.filter((item) => item.group === group),
  })).filter((g) => g.items.length > 0);

  // Contadores no item de menu: tarefas pendentes e mensagens internas não
  // lidas. Zero = sem badge.
  const badgeFor = (to: string): number => {
    if (to === '/tasks') return pendingCount;
    if (to === '/chat') return unreadTotal;
    return 0;
  };

  return (
    <aside
      className={cn(
        'hidden md:flex md:flex-col shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-border-card)] will-change-[width] transition-[width] duration-200 ease-out',
        collapsed ? 'w-16' : 'w-60',
      )}
      aria-label="Navegação principal"
    >
      <div
        className={cn(
          'h-14 flex items-center border-b border-[var(--color-border-card)]',
          collapsed ? 'justify-center px-0' : 'gap-2.5 px-4',
        )}
      >
        <img src="/amai-logo.png" alt="Amai Park" className="h-7 w-7 shrink-0 rounded-md" />
        {!collapsed && (
          <div className="leading-tight min-w-0 flex-1">
            <div className="text-card-title text-[var(--color-text-primary)] truncate">AMAI Park</div>
            <div className="text-metadata">CRM</div>
          </div>
        )}
      </div>

      <nav className={cn('flex-1 overflow-y-auto py-3 space-y-5', collapsed ? 'px-2' : 'px-2.5')}>
        {groups.map(({ group, items }) => (
          <div key={group}>
            {!collapsed && (
              <div className="px-2 pb-1.5 text-metadata">
                {group}
              </div>
            )}
            <div className="space-y-0.5">
              {items.map((item) => {
                const Icon = item.icon;
                const badgeCount = badgeFor(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center rounded-[var(--radius-control)] py-2 text-sm font-medium',
                        'transition-colors duration-[var(--motion-base)]',
                        collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
                        'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]',
                        isActive &&
                          'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--accent-primary)]',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* Indicador ativo — barra lateral, não só tingimento de fundo.
                            Some/aparece com opacidade (não desloca layout). */}
                        <span
                          className={cn(
                            'absolute left-0 top-1/2 h-4 w-[2.5px] -translate-y-1/2 rounded-full bg-[var(--accent-primary)] transition-opacity duration-[var(--motion-base)]',
                            isActive ? 'opacity-100' : 'opacity-0',
                          )}
                          aria-hidden="true"
                        />
                        <Icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                        {!collapsed && badgeCount > 0 && (
                          <span className="shrink-0 rounded-full bg-[var(--accent-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bg-primary)]">
                            {badgeCount > 99 ? '99+' : badgeCount}
                          </span>
                        )}

                        {/* Tooltip real (não o title nativo do navegador) — só
                            existe/renderiza quando recolhida, via group-hover
                            em CSS puro, sem lib nova. */}
                        {collapsed && (
                          <span
                            role="tooltip"
                            className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-[var(--z-tooltip)] -translate-y-1/2 whitespace-nowrap rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)] opacity-0 shadow-[var(--shadow-md)] transition-opacity duration-[var(--motion-fast)] group-hover:opacity-100"
                          >
                            {item.label}
                            {badgeCount > 0 && (
                              <span className="ml-1.5 text-[var(--accent-primary)]">({badgeCount})</span>
                            )}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Seta flutuante fixa no centro VERTICAL DA TELA (fixed), deslizando
          junto com a borda direita da barra (left = largura da sidebar). */}
      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
        title={collapsed ? 'Expandir menu' : 'Recolher menu'}
        className={cn(
          'fixed top-1/2 z-30 hidden h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] transition-[left] duration-200 ease-out hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)] md:flex',
          collapsed ? 'left-16' : 'left-60',
        )}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>
    </aside>
  );
}
