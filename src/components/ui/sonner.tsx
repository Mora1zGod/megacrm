import { Toaster as SonnerToaster } from 'sonner';
import { useAppUser } from '@/app/providers/AppUserProvider';

export function Toaster() {
  // Segue o tema da organização (ver AppUserProvider/globals.css) — antes
  // ficava fixo em 'dark', então o toast continuava escuro mesmo com a org
  // no tema claro.
  const { themeMode } = useAppUser();
  return (
    <SonnerToaster
      theme={themeMode}
      position="top-right"
      richColors
      toastOptions={{
        classNames: {
          toast:
            'glass-card !border-[rgba(14,154,160,0.25)] !bg-[var(--color-surface-raised)] !text-[var(--color-text-primary)]',
          description: '!text-[var(--color-text-secondary)]',
        },
      }}
    />
  );
}
