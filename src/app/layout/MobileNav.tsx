import { NavLink } from 'react-router-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, type NavItem } from './nav-config';
import { useAppUser } from '@/app/providers/AppUserProvider';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

const GROUP_ORDER: NavItem['group'][] = ['Operação', 'Engajamento', 'Gestão', 'Administração'];

// Drawer de navegação para telas < md (768px). Sem ele, a Sidebar
// (`hidden md:flex`) deixava o app sem NENHUMA navegação no mobile.
export function MobileNav({ open, onClose }: MobileNavProps) {
  const { role, isSuperAdmin } = useAppUser();
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
    <div
      className={cn(
        'fixed inset-0 z-50 md:hidden transition-opacity duration-200',
        open ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
      aria-hidden={!open}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <aside
        className={cn(
          'absolute left-0 top-0 h-full w-72 max-w-[80vw] bg-[var(--color-surface)] border-r border-[var(--color-border-card)] flex flex-col transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        role="dialog"
        aria-label="Navegação"
      >
        <div className="h-14 shrink-0 flex items-center justify-between px-4 border-b border-[var(--color-border-card)]">
          <div className="flex items-center gap-2.5">
            <img
              src="/amai-logo.png"
              alt="AMAI Park"
              className="h-7 w-7 rounded-md"
            />
            <span className="text-sm font-semibold text-[var(--color-text-primary)]">AMAI Park</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar menu"
            className="h-10 w-10 flex items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors duration-150"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3 space-y-4">
          {groups.map(({ group, items }) => (
            <div key={group}>
              <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
                {group}
              </div>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={onClose}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 min-h-11 text-sm font-medium transition-colors duration-150',
                          isActive
                            ? 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
                        )
                      }
                    >
                      <Icon className="h-4.5 w-4.5 shrink-0" />
                      {item.label}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>
    </div>
  );
}
