import { lazy, type ComponentType } from 'react';

// Depois de cada deploy os arquivos das telas mudam de nome (hash). Uma aba aberta antes do deploy tenta
// buscar o arquivo antigo, que não existe mais → "Failed to fetch dynamically imported module" → tela branca.
// Aqui: tenta de novo uma vez e, se continuar falhando, recarrega a página (uma vez a cada 20 s) para pegar a versão nova.
const KEY = 'megacrm_chunk_reload_at';

export function isChunkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /dynamically imported module|Importing a module script failed|Failed to fetch|error loading dynamically|ChunkLoadError|Loading chunk|Unable to preload CSS|text\/html.*MIME/i.test(msg);
}

export function reloadForNewVersion(): boolean {
  let last = 0;
  try { last = Number(sessionStorage.getItem(KEY) || 0); } catch { /* sem storage */ }
  if (Date.now() - last < 20_000) return false; // já tentou agora há pouco: não entra em loop
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* sem storage */ }
  window.location.reload();
  return true;
}

export function lazyRetry<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) { // eslint-disable-line @typescript-eslint/no-explicit-any
  return lazy(async () => {
    try {
      return await factory();
    } catch (e) {
      if (!isChunkError(e)) throw e;
      await new Promise((r) => setTimeout(r, 400));
      try {
        return await factory();
      } catch (e2) {
        if (isChunkError(e2) && reloadForNewVersion()) return new Promise<never>(() => undefined); // a página vai recarregar
        throw e2;
      }
    }
  });
}
