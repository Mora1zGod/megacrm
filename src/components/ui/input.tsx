import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  // Estado visual — seção 14 do reboot pede normal/hover/focus/disabled/
  // error/success. Sem a prop, comportamento é 100% igual ao de antes.
  state?: 'error' | 'success';
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, state, ...props }, ref) => {
    return (
      <input
        type={type}
        ref={ref}
        aria-invalid={state === 'error' || undefined}
        className={cn(
          'flex h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm',
          'placeholder:text-[var(--color-text-muted)]',
          'text-[var(--color-text-primary)]',
          'transition-colors duration-[var(--motion-base)]',
          'hover:border-[#2E333B]',
          'focus:border-[var(--accent-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]',
          'disabled:cursor-not-allowed disabled:opacity-40',
          state === 'error' &&
            'border-[var(--color-error)] focus:border-[var(--color-error)] focus:ring-[var(--color-error)]',
          state === 'success' &&
            'border-[var(--color-success)] focus:border-[var(--color-success)] focus:ring-[var(--color-success)]',
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = 'Input';

export { Input };

