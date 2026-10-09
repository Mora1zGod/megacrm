import { Skeleton } from '@/components/ui/skeleton';

// Carregando uma tela: barrinha animada no topo + esqueleto (nunca tela branca).
export function PageLoading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div aria-busy="true" aria-label={label}>
      <div className="page-loading-bar" role="progressbar" aria-label={label} />
      <div className="mx-auto max-w-7xl space-y-6 p-2 sm:p-4">
        <div className="space-y-2"><Skeleton className="h-6 w-48" /><Skeleton className="h-4 w-72" /></div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        <Skeleton className="h-64" />
      </div>
    </div>
  );
}
