import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Search, User, Briefcase, CalendarDays } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { useGlobalSearch, type SearchResult } from '@/hooks/useGlobalSearch';

const KIND_ICON = { contact: User, deal: Briefcase, visit: CalendarDays } as const;
const KIND_LABEL = { contact: 'Contato', deal: 'Negócio', visit: 'Visita' } as const;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const { results, loading } = useGlobalSearch(query);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else setQuery('');
  }, [open]);

  if (!open) return null;

  const go = (r: SearchResult) => {
    navigate(r.href);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} widthClass="max-w-lg">
      <div className="-m-1">
        <div className="flex items-center gap-2 border-b border-[var(--color-border-card)] pb-3">
          <Search className="h-4 w-4 text-[var(--color-text-secondary)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar contatos, negócios, visitas..."
            className="flex-1 bg-transparent text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-secondary)] outline-none"
          />
          {loading && <Loader2 className="h-4 w-4 animate-spin text-[var(--color-text-secondary)]" />}
        </div>
        <div className="mt-2 max-h-80 overflow-y-auto">
          {query.trim().length < 2 ? (
            <p className="p-4 text-sm text-[var(--color-text-secondary)]">Digite pelo menos 2 letras.</p>
          ) : results.length === 0 && !loading ? (
            <p className="p-4 text-sm text-[var(--color-text-secondary)]">Nada encontrado.</p>
          ) : (
            results.map((r) => {
              const Icon = KIND_ICON[r.kind];
              return (
                <button
                  key={`${r.kind}-${r.id}`}
                  onClick={() => go(r)}
                  className="flex w-full items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 text-left hover:bg-[var(--color-surface-hover)] transition-colors duration-150"
                >
                  <Icon className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-[var(--color-text-primary)] truncate">{r.title}</div>
                    {r.subtitle && <div className="text-xs text-[var(--color-text-secondary)] truncate">{r.subtitle}</div>}
                  </div>
                  <span className="shrink-0 text-[10px] uppercase text-[var(--color-text-secondary)]">{KIND_LABEL[r.kind]}</span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Dialog>
  );
}
