import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { LogOut, Moon, Search, Sun, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV_ITEMS, navItemVisible, type NavItem } from './nav-config';
import { useEmailPerms, type EmailPerm } from '@/app/routes/email/useEmailPerm';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { useAuth } from '@/app/providers/AuthProvider';
import { Avatar } from '@/components/ui/Avatar';
import { OrgSwitcher } from './OrgSwitcher';
import { OPEN_SEARCH_EVENT } from './Header';

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

const GROUP_ORDER: NavItem['group'][] = ['Operação', 'Engajamento', 'Gestão', 'Administração'];

// Menu do celular (< 768 px): marca da organização, busca, áreas por grupo e, no rodapé,
// quem está logado, troca de organização, tema e sair (no celular o topo só tem os botões do dia a dia).
export function MobileNav({ open, onClose }: MobileNavProps) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { isSuperAdmin, orgName, orgLogoUrl, displayName, avatarUrl, effectiveTheme, toggleTheme } = useAppUser();
  const perms = usePermission();
  const emailPerms = useEmailPerms();
  const [broken, setBroken] = useState(false);
  const visibleItems = NAV_ITEMS.filter((item) => navItemVisible(item, (k) => (k.startsWith('email.') ? emailPerms.can(k as EmailPerm) : perms.can(k)), isSuperAdmin));
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: visibleItems.filter((item) => item.group === group),
  })).filter((g) => g.items.length > 0);

  // Voltar do Android / Esc fecha o menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const name = orgName?.trim() || 'Organização';
  const logout = async () => {
    onClose();
    await signOut();
    toast.success('Sessão encerrada.');
    navigate('/auth/login', { replace: true });
  };

  return (
    <div
      className={cn('fixed inset-0 z-50 md:hidden transition-opacity duration-200', open ? 'opacity-100' : 'pointer-events-none opacity-0')}
      aria-hidden={!open}
    >
      <div className="absolute inset-0 bg-[rgba(10,17,32,0.45)] backdrop-blur-[3px]" onClick={onClose} />
      <aside
        className={cn(
          'absolute left-0 top-0 flex h-full w-[86vw] max-w-[340px] flex-col overflow-hidden rounded-r-[28px] bg-[var(--color-surface)] shadow-[0_20px_60px_rgba(10,17,32,0.35)] transition-transform duration-200',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        role="dialog"
        aria-label="Navegação"
      >
        {/* marca */}
        <div className="relative shrink-0 overflow-hidden px-5 pb-4 pt-[calc(env(safe-area-inset-top)+16px)]">
          <div className="relative z-10 flex items-center gap-3">
            {orgLogoUrl && !broken ? (
              <img src={orgLogoUrl} alt="" onError={() => setBroken(true)} className="h-10 w-auto max-w-[76px] shrink-0 object-contain" />
            ) : (
              <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--color-border-card)] font-bold">{name[0].toUpperCase()}</span>
            )}
            <span className="h-8 w-px shrink-0 bg-[var(--color-border-card)]" aria-hidden />
            <div className="min-w-0 flex-1 truncate text-[17px] font-extrabold text-[var(--color-text-primary)]">
              {name.toUpperCase()} <span className="font-normal text-[var(--color-text-muted)]">CRM</span>
            </div>
            <button
              onClick={onClose}
              aria-label="Fechar menu"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-surface)] text-[var(--color-text-primary)] shadow-sm"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <svg className="pointer-events-none absolute bottom-0 right-0 h-10 w-44" viewBox="0 0 176 40" preserveAspectRatio="none" aria-hidden>
            <path d="M0 40 C 70 38 120 26 176 0 L176 40 Z" fill="#22C55E" />
            <path d="M40 40 C 100 38 140 28 176 10 L176 40 Z" fill="#1D4ED8" />
          </svg>
        </div>

        <nav className="flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
          <button
            type="button"
            onClick={() => { onClose(); window.dispatchEvent(new Event(OPEN_SEARCH_EVENT)); }}
            className="mb-3 mt-3 flex h-11 w-full items-center gap-2.5 rounded-xl border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] px-3 text-[15px] text-[var(--color-text-muted)]"
          >
            <Search className="h-4.5 w-4.5" /> Buscar contatos, conversas…
          </button>
          {groups.map(({ group, items }, gi) => (
            <div key={group} className={gi ? 'mt-3 border-t border-[var(--color-border-soft)] pt-3' : ''}>
              <div className="px-2 pb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{group}</div>
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
                          'group flex min-h-12 items-center gap-3 rounded-2xl px-1.5 text-[16px] font-medium transition-colors duration-150',
                          isActive
                            ? 'bg-[var(--color-accent-subtle)] font-semibold text-[var(--accent-primary)]'
                            : 'text-[var(--color-text-primary)] active:bg-[var(--color-surface-hover)]',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <span className={cn(
                            'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
                            isActive ? 'bg-[var(--color-surface)]/70 text-[var(--accent-primary)]' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]',
                          )}>
                            <Icon className="h-5 w-5" />
                          </span>
                          <span className="truncate">{item.label}</span>
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* quem está logado */}
        <div className="shrink-0 space-y-2 border-t border-[var(--color-border-soft)] px-3 pb-[calc(env(safe-area-inset-bottom)+12px)] pt-3">
          <OrgSwitcher inDrawer />
          <div className="flex items-center gap-2.5">
            <Avatar src={avatarUrl} name={displayName || user?.email} size="sm" className="bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{displayName?.trim() || user?.email?.split('@')[0] || 'Usuário'}</div>
              <div className="truncate text-xs text-[var(--color-text-muted)]">{user?.email ?? '—'}</div>
            </div>
            <button type="button" onClick={toggleTheme} aria-label={effectiveTheme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--color-border-soft)] text-[var(--color-text-secondary)]">
              {effectiveTheme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
            </button>
            <button type="button" onClick={() => void logout()} aria-label="Sair" title="Sair"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[var(--color-border-soft)] text-[var(--color-error)]">
              <LogOut className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}
