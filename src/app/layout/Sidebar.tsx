import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, type NavItem } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useTasks } from '@/hooks/useTasks';
import { useInternalChat } from '@/hooks/useInternalChat';
import { Avatar } from '@/components/ui/Avatar';
import { BrandMark } from './BrandMark';

const GROUP_ORDER: NavItem['group'][] = ['Operação', 'Engajamento', 'Gestão', 'Administração'];

export function Sidebar() {
  const { role, isSuperAdmin, displayName, avatarUrl } = useAppUser();
  const { pendingCount } = useTasks();
  const { unreadTotal } = useInternalChat();
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sidebar_collapsed') === '1',
  );

  const toggle = () => setCollapsed((value) => {
    localStorage.setItem('sidebar_collapsed', value ? '0' : '1');
    return !value;
  });

  const visibleItems = NAV_ITEMS.filter((item) => {
    if (item.superAdminOnly) return isSuperAdmin;
    if (item.adminOnly) return role === 'admin';
    return true;
  });
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: visibleItems.filter((item) => item.group === group),
  })).filter((group) => group.items.length > 0);

  const badgeFor = (to: string): number => {
    if (to === '/tasks') return pendingCount;
    if (to === '/chat') return unreadTotal;
    return 0;
  };

  return (
    <aside
      className={cn(
        'hidden md:flex md:flex-col shrink-0 bg-[var(--color-surface)] border-r border-[var(--color-border-card)] will-change-[width] transition-[width] duration-200 ease-out',
        collapsed ? 'w-[68px]' : 'w-[216px]',
      )}
      aria-label="Navegação principal"
    >
      <div className={cn('h-16 shrink-0 flex items-center border-b border-[var(--color-border-soft)]', collapsed ? 'justify-center' : 'px-4')}>
        <BrandMark compact={collapsed} />
      </div>

      <nav className={cn('flex-1 overflow-y-auto py-3 space-y-5', collapsed ? 'px-2' : 'px-2.5')}>
        {groups.map(({ group, items }) => (
          <div key={group}>
            {!collapsed && (
              <div className="px-3 pb-1.5 text-xs font-semibold text-[var(--color-text-muted)]">
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
                    className={({ isActive }) => cn(
                      'group relative flex min-h-[42px] items-center rounded-[9px] text-sm font-medium transition-colors duration-[var(--motion-base)]',
                      collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                      isActive
                        ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
                    )}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                    {!collapsed && badgeCount > 0 && (
                      <span className="min-w-[22px] rounded-full bg-[var(--accent-fill)] px-1.5 py-0.5 text-center text-xs font-semibold text-white">
                        {badgeCount > 99 ? '99+' : badgeCount}
                      </span>
                    )}
                    {collapsed && (
                      <span role="tooltip" className="pointer-events-none absolute left-[calc(100%+9px)] top-1/2 z-[var(--z-tooltip)] -translate-y-1/2 whitespace-nowrap rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-text-primary)] opacity-0 shadow-[var(--shadow-md)] transition-opacity group-hover:opacity-100">
                        {item.label}{badgeCount > 0 ? ` (${badgeCount})` : ''}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn('shrink-0 border-t border-[var(--color-border-card)] py-3', collapsed ? 'px-2' : 'px-3')}>
        <div className={cn('flex items-center rounded-[var(--radius-control)] p-2', collapsed ? 'justify-center' : 'gap-2.5')}>
          <Avatar src={avatarUrl} name={displayName} size="sm" className="bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]" />
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{displayName?.trim() || 'Usuário'}</div>
              <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{role === 'admin' ? 'Administrador' : 'Operador'}</div>
            </div>
          )}
          {!collapsed && <span className="h-2 w-2 rounded-full bg-[var(--color-success)]" title="Online" />}
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
        className={cn(
          'fixed top-1/2 z-30 hidden h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] text-[var(--color-text-secondary)] shadow-sm transition-[left] duration-200 hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)] md:flex',
          collapsed ? 'left-[68px]' : 'left-[216px]',
        )}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>
    </aside>
  );
}
