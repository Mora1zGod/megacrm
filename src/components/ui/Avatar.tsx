import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

// Avatar circular compartilhado: mostra a imagem redonda quando há `src`, senão
// cai nas iniciais (até 2 letras) no mesmo estilo do ConversationList. Usado
// para contatos (foto do lead via UAZAPI) e operadores (avatar do perfil).

export type AvatarSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-16 w-16 text-lg',
};

interface AvatarProps {
  src?: string | null;
  name?: string | null;
  size?: AvatarSize;
  className?: string;
}

// Iniciais: até duas letras. Se o nome tem espaço, pega a inicial das duas
// primeiras palavras; senão, os dois primeiros caracteres.
function initialsFrom(name: string | null | undefined): string {
  const value = name?.trim();
  if (!value) return '—';
  const parts = value.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return value.slice(0, 2).toUpperCase();
}

export function Avatar({ src, name, size = 'md', className }: AvatarProps) {
  const sizeClass = SIZE_CLASS[size];
  // Fotos do Instagram vêm da CDN da Meta com link assinado que EXPIRA em
  // poucos dias. Sem este fallback o navegador mostrava imagem quebrada; agora
  // cai nas iniciais quando a foto não carrega.
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt={name ?? 'avatar'}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        className={cn('rounded-full object-cover shrink-0', sizeClass, className)}
      />
    );
  }
  return (
    <div
      className={cn(
        'rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-card)] flex items-center justify-center font-semibold text-[var(--color-text-secondary)] shrink-0',
        sizeClass,
        className,
      )}
      aria-hidden
    >
      {initialsFrom(name)}
    </div>
  );
}
