import { useEffect, useRef, useState } from 'react';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Menu, LogOut, Search, Plus, ChevronDown, User, Briefcase, CalendarDays, CheckSquare, Megaphone, Sun, Moon, BadgeDollarSign } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { NotificationsDropdown } from '@/components/NotificationsDropdown';
import { OrgSwitcher } from '@/app/layout/OrgSwitcher';
import { CommandPalette } from '@/components/CommandPalette';
import { useAuth } from '@/app/providers/AuthProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { Avatar } from '@/components/ui/Avatar';
import { NewSaleDialog } from '@/components/sales/NewSaleDialog';
import { GoalPill } from '@/components/sales/GoalPill';
import { AmaiaStatusPill } from '@/components/ai/AmaiaStatusPill';
import { DailyTasksPopover } from '@/components/header/DailyTasksPopover';
import { RemindersPopover } from '@/components/header/RemindersPopover';
import { OPEN_NEW_SALE_EVENT } from '@/hooks/useSales';
import { useIsMobile } from '@/hooks/useIsMobile';
import { SupportBanner } from './SupportBanner';
import { MOBILE_BTN } from './mobileChrome';

// Busca global aberta de fora do topo (ex.: menu do celular).
export const OPEN_SEARCH_EVENT = 'megacrm:open-search';

interface HeaderProps {
  onMenuClick?: () => void;
}

const CRIAR_ITEMS = [
  { label: 'Contato', icon: User, href: '/contacts', perm: 'contacts.create' },
  { label: 'Negócio', icon: Briefcase, href: '/funil', perm: 'deals.view' },
  { label: 'Visita', icon: CalendarDays, href: '/agenda', perm: 'visits.create' },
  { label: 'Tarefa', icon: CheckSquare, href: '/quadros?modo=caixa', perm: 'tasks.create' },
  { label: 'Campanha', icon: Megaphone, href: '/campaigns', perm: 'campaigns.manage' },
] as const;

export function Header({ onMenuClick }: HeaderProps) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const { displayName, avatarUrl, effectiveTheme, toggleTheme } = useAppUser();
  const perms = usePermission();
  const criarItems = CRIAR_ITEMS.filter((i) => perms.can(i.perm));
  const themeLabel = effectiveTheme === 'dark' ? 'Mudar para tema claro' : 'Mudar para tema escuro';
  const [searchOpen, setSearchOpen] = useState(false);
  const [criarOpen, setCriarOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleContact, setSaleContact] = useState<{ id: string; name: string | null } | null>(null);
  const mobile = useIsMobile();

  // Nova Venda pode ser aberta de qualquer tela (ex.: ficha do contato).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<{ contactId?: string; contactName?: string | null } | undefined>).detail;
      setSaleContact(d?.contactId ? { id: d.contactId, name: d.contactName ?? null } : null);
      setSaleOpen(true);
    };
    window.addEventListener(OPEN_NEW_SALE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_NEW_SALE_EVENT, onOpen);
  }, []);

  // Ctrl+K (ou Cmd+K no Mac) abre a busca global de qualquer tela.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    const onOpenSearch = () => setSearchOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpenSearch);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpenSearch);
    };
  }, []);

  const criarMenu = (compact: boolean) => (
    criarItems.length > 0 && <div className={compact ? 'relative min-w-0 flex-1' : 'relative'}>
          <Button onClick={() => setCriarOpen((v) => !v)} className={compact ? 'h-11 w-full rounded-xl px-3 text-[15px] shadow-[0_6px_16px_rgba(29,78,216,0.3)]' : 'min-h-10'}>
            <Plus className="h-4 w-4" /> Criar <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-[var(--motion-fast)] ${criarOpen ? 'rotate-180' : ''}`} />
          </Button>
          {criarOpen && (
            <>
              <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setCriarOpen(false)} />
              <div className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-48 origin-top-right rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-[var(--shadow-lg)]">
                {criarItems.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      onClick={() => { setCriarOpen(false); navigate(item.href); }}
                      className="flex w-full min-h-10 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-sm text-[var(--color-text-primary)] transition-colors duration-[var(--motion-fast)] hover:bg-[var(--color-surface-hover)]"
                    >
                      <Icon className="h-4 w-4 text-[var(--color-text-secondary)]" />
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
  );

  const dialogs = (
    <>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NewSaleDialog open={saleOpen} onClose={() => setSaleOpen(false)} initialContact={saleContact} />
    </>
  );

  // ---------------------------------------------------------------- celular
  if (mobile) {
    return (
      <MobileTop
        onMenuClick={onMenuClick}
        actions={
          <>
            <button type="button" onClick={onMenuClick} aria-label="Abrir menu" className={MOBILE_BTN}>
              <Menu className="h-5 w-5" />
            </button>
            {perms.can('tasks.view') && <DailyTasksPopover mobile />}
            {perms.can('reminders.view') && <RemindersPopover mobile />}
            <NotificationsDropdown mobile />
            {perms.can('financial.create') && (
              <button type="button" aria-label="Nova venda" title="Nova venda" onClick={() => { setSaleContact(null); setSaleOpen(true); }}
                className={cn(MOBILE_BTN, 'border-transparent bg-[rgba(34,197,94,0.16)] text-[var(--color-success)] hover:bg-[rgba(34,197,94,0.24)]')}>
                <BadgeDollarSign className="h-5 w-5" />
              </button>
            )}
            {criarMenu(true)}
          </>
        }
      >
        {dialogs}
      </MobileTop>
    );
  }

  const handleLogout = async () => {
    await signOut();
    toast.success('Sessão encerrada.');
    navigate('/auth/login', { replace: true });
  };

  return (
    <header
      className="h-16 shrink-0 bg-[var(--color-surface)] flex items-center justify-between px-4 sm:px-6 gap-4 border-b border-[var(--color-border-soft)]"
      role="banner"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          onClick={onMenuClick}
          aria-label="Abrir menu"
          className="md:hidden h-10 w-10 shrink-0 flex items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors duration-[var(--motion-base)]"
        >
          <Menu className="h-5 w-5" />
        </button>

        <button
          onClick={() => setSearchOpen(true)}
          className="hidden sm:flex min-w-0 min-h-10 items-center gap-2 flex-1 max-w-md rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-muted)] transition-colors duration-[var(--motion-base)] hover:border-[var(--accent-primary)]"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left truncate">Buscar contatos, conversas, leads...</span>
          <kbd className="hidden 2xl:inline shrink-0 rounded border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--color-text-secondary)]">
            Ctrl+K
          </kbd>
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:gap-3 shrink-0">
        {perms.can('tasks.view') && <DailyTasksPopover />}
        {perms.can('reminders.view') && <RemindersPopover />}
        <AmaiaStatusPill />
        {perms.can('financial.view') && <GoalPill />}
        {perms.can('financial.create') && <Button
          variant="success"
          onClick={() => { setSaleContact(null); setSaleOpen(true); }}
          className="min-h-10"
          aria-label="Nova venda"
        >
          <BadgeDollarSign className="h-4 w-4" /> <span className="hidden xl:inline">Nova venda</span>
        </Button>}
        {criarMenu(false)}

        <OrgSwitcher />

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={themeLabel}
          title={themeLabel}
          className="h-10 w-10 shrink-0 grid place-items-center rounded-[var(--radius-control)] border border-[var(--color-border-soft)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors duration-[var(--motion-base)]"
        >
          {effectiveTheme === 'dark' ? <Sun className="h-[18px] w-[18px]" /> : <Moon className="h-[18px] w-[18px]" />}
        </button>

        <NotificationsDropdown />

        <div className="flex min-w-0 items-center gap-2 border-l border-[var(--color-border-soft)] pl-2 sm:pl-3">
          <Avatar src={avatarUrl} name={displayName || user?.email} size="sm" className="bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]" />
          <div className="hidden min-w-0 lg:block leading-tight">
            <div className="max-w-[160px] truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
              {displayName?.trim() || user?.email?.split('@')[0] || 'Usuário'}
            </div>
            <div className="mt-0.5 max-w-[180px] truncate text-xs text-[var(--color-text-muted)]">
              {user?.email ?? '—'}
            </div>
          </div>
          <Button variant="ghost" size="icon" aria-label="Sair" title="Sair" onClick={handleLogout}>
            <LogOut className="h-[18px] w-[18px]" />
          </Button>
        </div>
      </div>

      {dialogs}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Topo do celular: marca da organização · faixa de suporte (se houver) · barra de botões.
// Grava a altura em --mh para os painéis (tarefas, lembretes, avisos) abrirem logo abaixo.
// ---------------------------------------------------------------------------
function MobileTop({ actions, children }: { onMenuClick?: () => void; actions: React.ReactNode; children: React.ReactNode }) {
  const { orgName, orgLogoUrl } = useAppUser();
  const ref = useRef<HTMLElement>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => document.documentElement.style.setProperty('--mh', `${Math.round(el.getBoundingClientRect().bottom)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => { ro.disconnect(); document.documentElement.style.removeProperty('--mh'); };
  }, []);
  const name = orgName?.trim() || 'Organização';
  return (
    <header ref={ref} role="banner" className="shrink-0 bg-[var(--color-bg-primary)] pt-[env(safe-area-inset-top)]">
      <div className="relative flex h-14 items-center gap-3 overflow-hidden border-b border-[var(--color-border-soft)] bg-[var(--color-surface)] px-4">
        {orgLogoUrl && !broken ? (
          <img src={orgLogoUrl} alt="" onError={() => setBroken(true)} className="h-9 w-auto max-w-[72px] shrink-0 object-contain" />
        ) : (
          <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border-card)] text-sm font-bold">{name[0].toUpperCase()}</span>
        )}
        <span className="h-7 w-px shrink-0 bg-[var(--color-border-card)]" aria-hidden />
        <div className="relative z-10 min-w-0 truncate text-[17px] font-extrabold tracking-[-0.01em] text-[var(--color-text-primary)]">
          {name.toUpperCase()} <span className="font-normal text-[var(--color-text-muted)]">CRM</span>
        </div>
        <svg className="pointer-events-none absolute -right-2 top-0 h-full w-32" viewBox="0 0 128 56" preserveAspectRatio="none" aria-hidden>
          <path d="M30 56 C 70 50 95 30 128 0 L128 56 Z" fill="#22C55E" />
          <path d="M48 56 C 82 50 104 34 128 12 L128 56 Z" fill="#1D4ED8" />
        </svg>
      </div>
      <SupportBanner variant="card" />
      <div className="flex items-center gap-2 px-3 py-2.5">{actions}</div>
      {children}
    </header>
  );
}
