import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Menu, LogOut, Search, Plus, ChevronDown, User, Briefcase, CalendarDays, CheckSquare, Megaphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NotificationsDropdown } from '@/components/NotificationsDropdown';
import { OrgSwitcher } from '@/app/layout/OrgSwitcher';
import { CommandPalette } from '@/components/CommandPalette';
import { useAuth } from '@/app/providers/AuthProvider';

interface HeaderProps {
  onMenuClick?: () => void;
}

const CRIAR_ITEMS = [
  { label: 'Contato', icon: User, href: '/contacts' },
  { label: 'Negócio', icon: Briefcase, href: '/funil' },
  { label: 'Visita', icon: CalendarDays, href: '/visitas' },
  { label: 'Tarefa', icon: CheckSquare, href: '/tasks' },
  { label: 'Campanha', icon: Megaphone, href: '/campaigns' },
] as const;

export function Header({ onMenuClick }: HeaderProps) {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [searchOpen, setSearchOpen] = useState(false);
  const [criarOpen, setCriarOpen] = useState(false);

  // Ctrl+K (ou Cmd+K no Mac) abre a busca global de qualquer tela.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const handleLogout = async () => {
    await signOut();
    toast.success('Sessão encerrada.');
    navigate('/auth/login', { replace: true });
  };

  return (
    <header
      className="h-14 shrink-0 bg-[var(--color-surface)] border-b border-[var(--color-border-card)] flex items-center justify-between px-4 sm:px-6 gap-4"
      role="banner"
    >
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <button
          onClick={onMenuClick}
          aria-label="Abrir menu"
          className="md:hidden h-10 w-10 shrink-0 flex items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] transition-colors duration-150"
        >
          <Menu className="h-5 w-5" />
        </button>

        <button
          onClick={() => setSearchOpen(true)}
          className="hidden sm:flex items-center gap-2 flex-1 max-w-md rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] transition-colors duration-150"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left truncate">Buscar contatos, negócios, visitas...</span>
          <kbd className="shrink-0 rounded border border-[var(--color-border-card)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-secondary)]">
            Ctrl+K
          </kbd>
        </button>
      </div>

      <div className="flex min-w-0 items-center gap-2 sm:gap-3 shrink-0">
        <div className="relative">
          <Button onClick={() => setCriarOpen((v) => !v)}>
            <Plus className="h-4 w-4" /> Criar <ChevronDown className="h-3.5 w-3.5" />
          </Button>
          {criarOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setCriarOpen(false)} />
              <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-48 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-lg">
                {CRIAR_ITEMS.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.label}
                      onClick={() => { setCriarOpen(false); navigate(item.href); }}
                      className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors duration-150"
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

        <OrgSwitcher />

        <NotificationsDropdown />

        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden min-w-0 sm:block text-right leading-tight">
            <div className="text-xs text-[var(--color-text-primary)] max-w-[140px] lg:max-w-[200px] truncate">
              {user?.email ?? '—'}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Sair"
            onClick={handleLogout}
          >
            <LogOut className="h-4.5 w-4.5" />
          </Button>
        </div>
      </div>

      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  );
}
