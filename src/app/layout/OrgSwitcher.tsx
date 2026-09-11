import { useEffect, useRef, useState } from 'react';
import { Building2, Check, ChevronDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/app/providers/AuthProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { getSupabase } from '@/lib/supabase';

// Seletor de organização no header. Membro comum pertence a UMA org: exibe só
// o nome dela. O super admin vê um dropdown com todas as orgs e troca de
// contexto via /api/admin/switch-org (atualiza a claim org_id no JWT →
// refreshSession → reload).

interface OrgOption {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'archived';
}

export function OrgSwitcher() {
  const { session } = useAuth();
  const { orgId, orgName, isSuperAdmin } = useAppUser();
  const [open, setOpen] = useState(false);
  const [orgs, setOrgs] = useState<OrgOption[] | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fecha o dropdown em clique fora.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Carrega a lista de orgs ao abrir (só super admin chega aqui).
  useEffect(() => {
    if (!open || orgs !== null || !session) return;
    void (async () => {
      try {
        const res = await fetch('/api/admin/orgs', {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const body = await res.json();
        if (!res.ok || !body.success) throw new Error(body.message ?? 'Falha ao listar organizações.');
        setOrgs((body.orgs ?? body.data ?? []) as OrgOption[]);
      } catch (err) {
        toast.error('Falha ao listar organizações', {
          description: err instanceof Error ? err.message : 'Erro interno',
        });
        setOrgs([]);
      }
    })();
  }, [open, orgs, session]);

  const switchTo = async (target: OrgOption) => {
    if (!session || target.id === orgId) {
      setOpen(false);
      return;
    }
    setSwitching(target.id);
    try {
      const res = await fetch('/api/admin/switch-org', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ orgId: target.id }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.message ?? 'Falha ao trocar de organização.');
      await getSupabase().auth.refreshSession();
      window.location.href = '/dashboard';
    } catch (err) {
      toast.error('Falha ao trocar de organização', {
        description: err instanceof Error ? err.message : 'Erro interno',
      });
      setSwitching(null);
    }
  };

  const label = (
    <div className="text-right leading-tight">
      <div className="text-sm font-medium text-[var(--color-text-primary)] max-w-[180px] truncate">
        {orgName ?? '—'}
      </div>
    </div>
  );

  // Membro comum: apenas o nome da própria org, sem dropdown.
  if (!isSuperAdmin) {
    return <div className="hidden md:block pr-2 border-r border-[var(--color-border-card)]">{label}</div>;
  }

  return (
    <div ref={rootRef} className="relative hidden md:block pr-2 border-r border-[var(--color-border-card)]">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Trocar de organização"
        className="flex items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-1 -my-1 transition-colors duration-150 hover:bg-[var(--color-surface-hover)]"
      >
        {label}
        <ChevronDown
          className={`h-4 w-4 text-[var(--color-text-secondary)] transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open ? (
        <div className="absolute right-2 top-[calc(100%+8px)] z-50 w-64 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1.5 shadow-lg">
          <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--color-text-muted)]">
            Organizações
          </div>
          {orgs === null ? (
            <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-[var(--color-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
            </div>
          ) : orgs.length === 0 ? (
            <div className="px-2.5 py-2 text-sm text-[var(--color-text-secondary)]">Nenhuma organização.</div>
          ) : (
            orgs.map((org) => (
              <button
                key={org.id}
                onClick={() => void switchTo(org)}
                disabled={switching !== null || org.status === 'archived'}
                className="flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-sm text-[var(--color-text-primary)] transition-colors duration-150 hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Building2 className="h-4 w-4 shrink-0 text-[var(--accent-secondary)]" />
                <span className="min-w-0 flex-1 truncate">{org.name}</span>
                {org.status === 'archived' ? (
                  <span className="shrink-0 text-[10px] uppercase text-[var(--color-text-secondary)]">arquivada</span>
                ) : null}
                {switching === org.id ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                ) : org.id === orgId ? (
                  <Check className="h-4 w-4 shrink-0 text-[var(--color-success)]" />
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
