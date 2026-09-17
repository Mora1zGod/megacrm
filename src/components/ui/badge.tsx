import * as React from 'react';
import { cn } from '@/lib/utils';

export type BadgeTone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TONE_CLASSES: Record<BadgeTone, string> = {
  default: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]',
  success: 'bg-[rgba(34,197,94,0.12)] text-[var(--color-success)]',
  warning: 'bg-[rgba(245,158,11,0.12)] text-[var(--color-warning)]',
  danger: 'bg-[rgba(239,68,68,0.12)] text-[var(--color-error)]',
  info: 'bg-[rgba(59,130,246,0.12)] text-[var(--color-info)]',
  accent: 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

// Badge compartilhado — raio contido (6px, não pill), tons semânticos.
// Substitui defs locais duplicadas (ex.: ContactPanel tinha a sua própria).
const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ tone = 'default', className, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11px] font-semibold leading-normal',
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    />
  ),
);
Badge.displayName = 'Badge';

export { Badge };
