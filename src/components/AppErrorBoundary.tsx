import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { isChunkError, reloadForNewVersion } from '@/lib/lazyRetry';

interface Props { children: ReactNode; scope?: 'app' | 'page' }
interface State { error: Error | null }

// Pega qualquer erro de tela: em vez de tela branca, mostra o aviso com "Recarregar" (e, se for versão
// antiga depois de um deploy, recarrega sozinho). No nível "page" o menu e o topo continuam funcionando.
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[tela] erro capturado', error, info.componentStack);
    if (isChunkError(error)) reloadForNewVersion();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = isChunkError(error);
    const page = this.props.scope === 'page';
    return (
      <div className={page ? 'flex min-h-[60vh] items-center justify-center p-6' : 'flex min-h-screen items-center justify-center bg-[var(--color-bg-primary)] p-6'}>
        <div className="max-w-md rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-6 text-center shadow-[var(--shadow-lg)]">
          <AlertTriangle className="mx-auto mb-3 h-10 w-10 text-[var(--color-warning,#d97706)]" />
          <h1 className="text-lg font-bold text-[var(--color-text-primary)]">{chunk ? 'Saiu uma versão nova do sistema' : 'Esta tela travou'}</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {chunk ? 'Recarregue para usar a versão atualizada.' : 'Nada foi perdido. Recarregue a página; se continuar, mande um print desta mensagem.'}
          </p>
          {!chunk && <p className="mt-3 break-words rounded-md bg-[var(--color-surface-hover)] px-3 py-2 text-left font-mono text-[11px] text-[var(--color-text-muted)]">{error.message.slice(0, 300)}</p>}
          <div className="mt-4 flex justify-center gap-2">
            <button type="button" onClick={() => window.location.reload()} className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] bg-[var(--accent-fill)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--accent-fill-hover)]"><RefreshCw className="h-4 w-4" /> Recarregar</button>
            <button type="button" onClick={() => { window.location.href = '/'; }} className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-4 py-2 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"><Home className="h-4 w-4" /> Início</button>
          </div>
        </div>
      </div>
    );
  }
}
