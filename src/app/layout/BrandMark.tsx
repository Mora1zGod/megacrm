import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';

// Marca do topo do menu: logo e nome da PRÓPRIA organização, cadastrados em
// Configurações → Identidade Visual (AMAI PARK vê a logo do parque, BELA
// CENTER vê a dela). Antes estava fixo "MegaCRM", nome do produto que o
// cliente não conhece. Sem logo cadastrada, cai na inicial do nome.
export function BrandMark({ compact = false }: { compact?: boolean }) {
  const { orgName, orgLogoUrl } = useAppUser();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [orgLogoUrl]);

  const name = orgName?.trim() || 'Organização';
  const showLogo = !!orgLogoUrl && !broken;

  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {showLogo ? (
        <img
          src={orgLogoUrl ?? undefined}
          alt={name}
          onError={() => setBroken(true)}
          className="h-9 w-9 shrink-0 rounded-[10px] bg-[var(--color-surface-raised)] object-contain"
        />
      ) : (
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] text-sm font-bold text-[var(--color-text-primary)]"
        >
          {name[0].toUpperCase()}
        </span>
      )}
      {!compact && (
        <div className="min-w-0 leading-tight">
          <div className={cn('truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--color-text-primary)]')}>
            {name}
          </div>
          <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">CRM</div>
        </div>
      )}
    </div>
  );
}
