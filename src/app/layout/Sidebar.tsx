import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { Building2, ChevronLeft, ChevronRight, MessagesSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, type NavItem } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useTasks } from '@/hooks/useTasks';
import { useInternalChat } from '@/hooks/useInternalChat';
import { Avatar } from '@/components/ui/Avatar';

const GROUP_ORDER: NavItem['group'][] = ['Operação', 'Engajamento', 'Gestão', 'Administração'];

export function Sidebar() {
  const { role, isSuperAdmin, displayName, avatarUrl, orgName } = useAppUser();
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
        collapsed ? 'w-[68px]' : 'w-60',
      )}
      aria-label="Navegação principal"
    >
      <div className={cn('h-[76px] shrink-0 flex items-center', collapsed ? 'justify-center' : 'px-4')}>
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-[var(--accent-primary)] text-white shadow-sm">
            <MessagesSquare className="h-5 w-5" />
          </span>
          {!collapsed && (
            <div className="min-w-0 leading-none">
              <div className="text-xl font-extrabold tracking-[-0.045em] text-[var(--color-text-primary)]">
                Mega<span className="font-normal text-[var(--accent-primary)]">CRM</span>
              </div>
              <div className="mt-1 text-[7px] font-semibold uppercase tracking-[0.16em] text-[var(--color-text-muted)]">
                Conexões que crescem
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={cn('mx-3 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)]', collapsed ? 'p-2' : 'p-2.5')}>
        <div className={cn('flex items-center', collapsed ? 'justify-center' : 'gap-2.5')}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--accent-primary)] text-xs font-bold text-white">
            {(orgName?.trim()?.[0] ?? 'A').toUpperCase()}
          </span>
          {!collapsed && (
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-xs font-semibold text-[var(--color-text-primary)]">{orgName ?? 'Organização'}</div>
              <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-secondary)]">Seu espaço de trabalho</div>
            </div>
          )}
          {!collapsed && <Building2 className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />}
        </div>
      </div>

      <nav className={cn('flex-1 overflow-y-auto py-4 space-y-5', collapsed ? 'px-2' : 'px-3')}>
        {groups.map(({ group, items }) => (
          <div key={group}>
            {!collapsed && (
              <div className="px-2 pb-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                {group}
              </div>
            )}
            <div className="space-y-1">
              {items.map((item) => {
                const Icon = item.icon;
                const badgeCount = badgeFor(item.to);
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) => cn(
                      'group relative flex min-h-10 items-center rounded-[var(--radius-control)] text-[13px] font-medium transition-colors duration-[var(--motion-base)]',
                      collapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5',
                      isActive
                        ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
                    )}
                  >
                    <Icon className="h-[18px] w-[18px] shrink-0" />
                    {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                    {!collapsed && badgeCount > 0 && (
                      <span className="min-w-[20px] rounded-md bg-[var(--accent-primary)] px-1.5 py-0.5 text-center text-[10px] font-semibold text-white">
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
              <div className="truncate text-xs font-semibold text-[var(--color-text-primary)]">{displayName?.trim() || 'Usuário'}</div>
              <div className="mt-0.5 text-[10px] capitalize text-[var(--color-text-secondary)]">{role === 'admin' ? 'Administrador' : 'Operador'}</div>
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
          collapsed ? 'left-[68px]' : 'left-60',
        )}
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>
    </aside>
  );
}
