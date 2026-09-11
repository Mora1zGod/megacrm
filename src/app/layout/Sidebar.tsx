import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, type NavItem } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useTasks } from '@/hooks/useTasks';

const GROUP_ORDER: NavItem['group'][] = ['Operação', 'Engajamento', 'Gestão', 'Administração'];

export function Sidebar() {
  const { role, isSuperAdmin } = useAppUser();
  const { pendingCount } = useTasks();
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
            <div className="text-sm font-semibold text-[var(--color-text-primary)]">AMAI Park</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">CRM</div>
          </div>
        )}
      </div>

      <nav className={cn('flex-1 overflow-y-auto py-3 space-y-4', collapsed ? 'px-2' : 'px-2.5')}>
        {groups.map(({ group, items }) => (
          <div key={group}>
            {!collapsed && (
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {group}
              </div>
            )}
            <div className="space-y-0.5">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center rounded-[var(--radius-control)] py-2 text-sm font-medium transition-colors duration-150',
                        collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
                        'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]',
                        isActive &&
                          'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)] hover:text-[var(--accent-primary)]',
                      )
                    }
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    {!collapsed && <span className="truncate flex-1">{item.label}</span>}
                    {!collapsed && item.to === '/tasks' && pendingCount > 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--accent-primary)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-bg-primary)]">
                        {pendingCount}
                      </span>
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
