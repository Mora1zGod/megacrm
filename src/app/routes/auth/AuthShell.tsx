import type { ReactNode } from 'react';

interface AuthShellProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

// Shared chrome for /auth/login and /auth/signup — keeps both pages visually
// consistent with /setup without repeating the logo + card + layout code.
//
// Fundo: gradiente + silhuetas de palmeira em SVG puro (sem foto real do
// parque ainda — troca fácil por uma foto de verdade assim que tiver uma:
// só substituir o <div> de fundo por um <img> com a mesma classe de posição).
export function AuthShell({ title, subtitle, children, footer }: AuthShellProps) {
  return (
    <div className="relative min-h-screen overflow-hidden flex items-center justify-center px-4 py-10">
      {/* Fundo — gradiente noturno + brilho de água, sem foto (placeholder) */}
      <div
        className="absolute inset-0 -z-10"
        style={{
          background:
            'radial-gradient(60% 50% at 50% 15%, rgba(20,184,174,0.16) 0%, transparent 60%),' +
            'radial-gradient(45% 40% at 85% 85%, rgba(20,184,174,0.10) 0%, transparent 65%),' +
            'linear-gradient(180deg, #060a0d 0%, #0B0D10 45%, #060809 100%)',
        }}
        aria-hidden="true"
      />
      {/* Silhuetas de folhas — decorativo, opacidade baixa */}
      <svg className="absolute left-0 top-0 h-64 w-64 -z-10 opacity-[0.06]" viewBox="0 0 200 200" fill="none" aria-hidden="true">
        <path d="M10 190 Q 40 80 140 20 Q 100 90 60 140 Q 90 110 130 100 Q 70 150 10 190 Z" fill="#5EEAD4" />
      </svg>
      <svg className="absolute right-0 bottom-0 h-64 w-64 -z-10 opacity-[0.06] rotate-180" viewBox="0 0 200 200" fill="none" aria-hidden="true">
        <path d="M10 190 Q 40 80 140 20 Q 100 90 60 140 Q 90 110 130 100 Q 70 150 10 190 Z" fill="#5EEAD4" />
      </svg>

      {/* Taglines de canto — decorativo, escondido em telas pequenas */}
      <div className="hidden lg:block absolute top-10 right-10 text-right text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)] leading-relaxed" aria-hidden="true">
        Lazer<br />Pessoas<br />Histórias<br />Sempre
      </div>
      <div className="hidden lg:block absolute bottom-10 left-10 text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-muted)]" aria-hidden="true">
        Amai Park — Viva grandes momentos
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-3">
            <img
              src="/amai-logo.png"
              alt="Amai Park"
              className="h-14 w-14 rounded-2xl shadow-[0_0_40px_rgba(20,184,174,0.35)]"
            />
            <div>
              <div className="text-label">Amai Park</div>
              <div className="text-2xl font-bold text-display">CRM</div>
            </div>
          </div>
        </div>

        <div className="glass-card p-8 space-y-6 border-[rgba(20,184,174,0.35)] shadow-[0_0_50px_rgba(20,184,174,0.12)]">
          <header className="space-y-1">
            <h1 className="text-2xl font-bold text-display">{title}</h1>
            {subtitle && (
              <p className="text-sm text-[var(--color-text-secondary)]">{subtitle}</p>
            )}
          </header>

          {children}
        </div>

        {footer && (
          <p className="mt-6 text-center text-sm text-[var(--color-text-secondary)]">
            {footer}
          </p>
        )}

        <p className="hidden sm:block mt-8 text-center text-sm italic text-[var(--color-text-muted)]">
          "Mais que momentos, conexões para a vida toda."
        </p>
      </div>
    </div>
  );
}
