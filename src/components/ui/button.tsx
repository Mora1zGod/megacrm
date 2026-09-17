import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

// Sem gradiente, sem glow — cor chapada com hover de brilho sutil. Alturas
// operacionais (32-36px); 40px só quando o botão precisa mesmo se destacar.
const buttonVariants = cva(
  'relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium transition-colors duration-[var(--motion-base)] ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg-primary)] disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--accent-primary)] text-[#04201D] font-semibold hover:bg-[var(--color-accent-secondary)]',
        secondary:
          'bg-[var(--color-surface-hover)] text-[var(--color-text-primary)] border border-[var(--color-border-card)] hover:border-[#2E333B] hover:bg-[#1F242B]',
        ghost:
          'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]',
        outline:
          'border border-[var(--color-border-card)] bg-transparent text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] hover:border-[#2E333B]',
        destructive:
          'bg-[var(--color-error)] text-white hover:bg-[var(--color-error)]/90',
        success:
          'bg-[var(--color-success)] text-[#04200D] font-semibold hover:bg-[var(--color-success)]/90',
        link:
          'text-[var(--accent-primary)] underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-3.5',
        sm: 'h-8 px-2.5 text-xs',
        lg: 'h-10 px-5 text-[0.9375rem]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  // Mostra um spinner e desabilita o botão SEM mudar sua largura: o
  // conteúdo original continua ocupando espaço (fica invisível, não
  // desmontado), o spinner é absolutamente posicionado por cima.
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading = false, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        <span className={cn('inline-flex items-center gap-1.5', loading && 'invisible')}>
          {children}
        </span>
        {loading && (
          <span className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
          </span>
        )}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
