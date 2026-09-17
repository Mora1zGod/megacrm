import { cn } from '@/lib/utils';

// Skeleton compartilhado — seção 10 do reboot: nunca deixar o usuário
// encarando spinner genérico ou tela vazia. Usa a superfície de hover como
// base (sutilmente mais clara que o card) e pulsa devagar.
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn('animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-hover)]', className)}
      aria-hidden="true"
    />
  );
}

// Skeleton de uma "linha" de lista (ícone/horário + texto + tag) — usado em
// widgets de agenda, atenção, listas de item único por linha.
export function SkeletonRow() {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5">
      <Skeleton className="h-3.5 w-10 shrink-0" />
      <Skeleton className="h-3.5 flex-1" />
      <Skeleton className="h-3.5 w-14 shrink-0" />
    </div>
  );
}
