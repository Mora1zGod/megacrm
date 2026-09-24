import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Check, Loader2, Moon, Sun, Upload } from 'lucide-react';
import { useOrgBranding } from '@/hooks/useOrgBranding';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB

export function BrandingSettings() {
  const { branding, loading, error, save, uploadLogo } = useOrgBranding();
  const { applyOrgTheme } = useAppUser();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [savingTheme, setSavingTheme] = useState<'dark' | 'light' | null>(null);

  // Sincroniza o input de nome só quando os dados chegam a primeira vez,
  // sem sobrescrever o que o usuário já estiver digitando em re-renders.
  const [nameHydrated, setNameHydrated] = useState(false);
  if (branding && !nameHydrated) {
    setName(branding.name ?? '');
    setNameHydrated(true);
  }

  async function handleSaveName() {
    setSavingName(true);
    try {
      await save({ name: name.trim() || null });
      toast.success('Nome atualizado.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Falha ao salvar o nome.');
    } finally {
      setSavingName(false);
    }
  }

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setUploadError('Envie uma imagem PNG ou JPG de até 2MB.');
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setUploadError('Envie uma imagem PNG ou JPG de até 2MB.');
      return;
    }
    setUploading(true);
    try {
      await uploadLogo(file);
      toast.success('Logo atualizado.');
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Falha ao enviar o logo.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function handleThemeChange(mode: 'dark' | 'light') {
    if (branding?.theme_mode === mode) return;
    setSavingTheme(mode);
    try {
      await save({ theme_mode: mode });
      // Não mexe no <html> na mão: quem manda no `data-theme` é o
      // AppUserProvider. Escrever o atributo aqui só pintava a tela até o
      // provider rodar de novo com o tema antigo — e não pintava nada se o
      // usuário já tivesse clicado no sol/lua do topo alguma vez, porque a
      // preferência pessoal daquele navegador vence o tema da org.
      applyOrgTheme(mode);
      toast.success(mode === 'light' ? 'Tema claro ativado.' : 'Tema escuro ativado.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Falha ao trocar o tema.');
    } finally {
      setSavingTheme(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-[var(--color-text-secondary)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (error || !branding) {
    return (
      <div className="glass-card p-4 text-sm text-red-400">
        Não foi possível carregar a identidade visual da organização.
        {error ? ` (${error})` : ''}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Identidade Visual</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Nome, logo e tema que aparecem pra todo mundo da sua organização.
        </p>
      </div>

      {/* Nome da empresa */}
      <div className="glass-card p-4 space-y-3">
        <Label htmlFor="org-name">Nome da empresa</Label>
        <div className="flex items-center gap-2">
          <input
            id="org-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: AMAI Park"
            className="flex-1 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
          <Button onClick={() => void handleSaveName()} disabled={savingName}>
            {savingName ? 'Salvando...' : 'Salvar'}
          </Button>
        </div>
      </div>

      {/* Logo */}
      <div className="glass-card p-4 space-y-3">
        <Label>Logo</Label>
        <div className="flex items-center gap-4">
          <div className="h-16 w-16 rounded-xl border border-[var(--color-border-card)] bg-black/20 flex items-center justify-center overflow-hidden shrink-0">
            {branding.logo_url ? (
              <img src={branding.logo_url} alt="Logo" className="h-full w-full object-contain" />
            ) : (
              <span className="text-lg font-bold text-[var(--color-text-secondary)]">
                {(branding.name ?? 'AP').slice(0, 2).toUpperCase()}
              </span>
            )}
          </div>
          <div className="space-y-1">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg"
              className="hidden"
              onChange={(e) => void handleLogoChange(e)}
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              <Upload className="h-4 w-4" />
              {uploading ? 'Enviando...' : 'Enviar logo'}
            </Button>
            {uploadError && <p className="text-xs text-red-400">{uploadError}</p>}
            {!uploadError && (
              <p className="text-xs text-[var(--color-text-secondary)]">PNG ou JPG, até 2MB.</p>
            )}
          </div>
        </div>
      </div>

      {/* Tema */}
      <div className="glass-card p-4 space-y-3">
        <Label>Tema</Label>
        <div className="grid grid-cols-2 gap-3">
          {(['dark', 'light'] as const).map((mode) => {
            const isActive = branding.theme_mode === mode;
            const Icon = mode === 'dark' ? Moon : Sun;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => void handleThemeChange(mode)}
                disabled={savingTheme !== null}
                className={cn(
                  'flex items-center gap-3 rounded-lg border p-3 text-left transition-colors',
                  isActive
                    ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)]'
                    : 'border-[var(--color-border-card)] hover:bg-[var(--color-fill-subtle)]',
                )}
              >
                <Icon className="h-4 w-4 shrink-0 text-[var(--color-text-primary)]" />
                <span className="flex-1 text-sm font-medium text-[var(--color-text-primary)]">
                  {mode === 'dark' ? 'Escuro' : 'Claro'}
                </span>
                {isActive && <Check className="h-4 w-4 text-[var(--accent-primary)]" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
