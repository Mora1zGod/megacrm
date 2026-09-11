import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from './input';
import { cn } from '@/lib/utils';

type PasswordInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>;

// Campo de senha com botão de mostrar/ocultar.
//
// Existe como componente (e não como botão repetido em cada tela) porque a
// senha aparece em login, cadastro, convite e troca de senha — repetir o
// controle em cada lugar garante que uma hora eles divergem.
//
// O botão fica FORA da ordem de tabulação (tabIndex={-1}): quem navega por
// teclado espera ir do campo direto para "Entrar", não parar num controle
// visual no meio do caminho.
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...props }, ref) {
    const [visivel, setVisivel] = useState(false);
    return (
      <div className="relative">
        <Input
          ref={ref}
          type={visivel ? 'text' : 'password'}
          className={cn('pr-10', className)}
          {...props}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisivel((v) => !v)}
          aria-label={visivel ? 'Ocultar senha' : 'Mostrar senha'}
          title={visivel ? 'Ocultar senha' : 'Mostrar senha'}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
        >
          {visivel ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    );
  },
);
