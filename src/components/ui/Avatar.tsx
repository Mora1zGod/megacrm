import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useMediaUrl } from '@/lib/signedMedia';

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
  // Bolinha de presença: true = verde (online), false = cinza. Sem a prop = sem bolinha.
  online?: boolean;
}

const DOT_CLASS: Record<AvatarSize, string> = { sm: 'h-2.5 w-2.5', md: 'h-3 w-3', lg: 'h-4 w-4' };

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

// Cor das iniciais pelo nome (sempre a mesma para a mesma pessoa) — lista mais fácil de bater o olho.
const TINTS = [
  'bg-[rgba(34,197,94,0.16)] text-[#15803D] [[data-theme=dark]_&]:text-[#4ADE80]',
  'bg-[rgba(59,130,246,0.16)] text-[#1D4ED8] [[data-theme=dark]_&]:text-[#93C5FD]',
  'bg-[rgba(245,158,11,0.18)] text-[#B45309] [[data-theme=dark]_&]:text-[#FBBF24]',
  'bg-[rgba(139,92,246,0.16)] text-[#6D28D9] [[data-theme=dark]_&]:text-[#C4B5FD]',
  'bg-[rgba(20,184,166,0.16)] text-[#0F766E] [[data-theme=dark]_&]:text-[#5EEAD4]',
];
function tintFor(name: string | null | undefined): string {
  const v = (name ?? '').trim();
  if (!v) return 'bg-[var(--color-surface-raised)] border border-[var(--color-border-card)] text-[var(--color-text-secondary)]';
  let h = 0;
  for (let i = 0; i < v.length; i += 1) h = (h * 31 + v.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

export function Avatar({ online, ...props }: AvatarProps) {
  if (online === undefined) return <AvatarImage {...props} />;
  return (
    <span className="relative inline-flex shrink-0" title={online ? 'Online agora' : 'Offline'}>
      <AvatarImage {...props} />
      <span
        aria-label={online ? 'Online' : 'Offline'}
        className={cn(
          'absolute bottom-0 right-0 rounded-full ring-2 ring-[var(--color-surface)]',
          DOT_CLASS[props.size ?? 'md'],
          online ? 'bg-[#22C55E]' : 'bg-[var(--color-text-muted)]',
        )}
      />
    </span>
  );
}

function AvatarImage({ src: rawSrc, name, size = 'md', className }: Omit<AvatarProps, 'online'>) {
  const sizeClass = SIZE_CLASS[size];
  // Foto de contato guardada no bucket privado whatsapp-hub-media: link assinado (iniciais enquanto assina).
  const src = useMediaUrl(rawSrc);
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
        'rounded-full flex items-center justify-center font-bold shrink-0',
        tintFor(name),
        sizeClass,
        className,
      )}
      aria-hidden
    >
      {initialsFrom(name)}
    </div>
  );
}
