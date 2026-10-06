import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { firstAllowedPath } from '@/app/layout/nav-config';

// Tela 403 — mostrada quando o usuário abre (ou digita na URL) uma área que o
// perfil dele não libera. Nada da área é carregado.
export default function AccessDeniedPage({ area }: { area?: string }) {
  const perms = usePermission();
  const home = firstAllowedPath(perms.can);
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-8 text-center shadow-[var(--shadow-sm,none)]">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(239,68,68,0.1)] text-[var(--color-error)]">
          <ShieldAlert className="h-7 w-7" />
        </div>
        <h1 className="text-lg font-bold tracking-wide text-[var(--color-text-primary)]">ACESSO RESTRITO</h1>
        <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
          Você não possui permissão para acessar esta área{area ? ` (${area})` : ''}.
        </p>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          {perms.roleName ? `Seu perfil: ${perms.roleName}. ` : ''}Se precisar, peça ao administrador para liberar.
        </p>
        <Link to={home} replace
          className="mt-6 inline-flex min-h-10 items-center justify-center rounded-[var(--radius-control)] bg-[var(--accent-fill)] px-4 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]">
          Voltar ao início
        </Link>
      </div>
    </div>
  );
}
