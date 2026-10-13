import { useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';

// Permissões do E-mail (20261013110000_email_permissions.sql). Enquanto o banco não tiver essas
// permissões no catálogo (SQL ainda não rodado), tudo segue liberado como antes.
let installed: boolean | null = null;
let pending: Promise<boolean> | null = null;
function loadInstalled(): Promise<boolean> {
  if (installed !== null) return Promise.resolve(installed);
  pending ??= Promise.resolve(
    getSupabase().from('permissions').select('key').eq('module', 'email').limit(1),
  ).then(({ data, error }) => { installed = !error && (data?.length ?? 0) > 0; return installed; })
    .catch(() => false);
  return pending;
}

export type EmailPerm = 'email.view' | 'email.send' | 'email.connect' | 'email.share';

export function useEmailPerms(): { ready: boolean; can: (k: EmailPerm) => boolean } {
  const perms = usePermission();
  const [inst, setInst] = useState<boolean | null>(installed);
  useEffect(() => { if (inst === null) void loadInstalled().then(setInst); }, [inst]);
  return {
    ready: inst !== null && !perms.loading,
    can: (k) => inst === false || perms.can(k),
  };
}
