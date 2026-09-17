// ============================================================================
// Service worker do AMAI Park CRM
// ----------------------------------------------------------------------------
// Objetivo: tornar o app instalável no celular e abrir rápido. NÃO é objetivo
// funcionar offline de verdade — é um CRM, dado velho é pior que tela de erro.
//
// Estratégia por tipo de recurso:
//
//   · /assets/*  (JS/CSS com hash no nome)  → cache-first
//       O hash muda a cada build, então o arquivo é imutável: se o nome bate,
//       o conteúdo é o mesmo. Seguro cachear para sempre.
//
//   · navegação (HTML)                      → network-first
//       Sempre busca a versão nova primeiro. O cache só entra se a rede
//       falhar, para o app abrir e mostrar erro de conexão em vez de tela
//       branca do navegador.
//
//   · TUDO MAIS (Supabase, Edge Functions, API) → nunca tocado
//       Conversa, mensagem, visita e configuração passam direto para a rede.
//       Cachear qualquer um desses faria o operador responder a uma mensagem
//       que já foi respondida, ou não ver a que acabou de chegar.
// ============================================================================

const VERSION = 'amai-crm-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

self.addEventListener('install', (event) => {
  // Ativa a versão nova imediatamente, sem esperar todas as abas fecharem.
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.addAll(['/', '/manifest.webmanifest', '/icon-192.png']).catch(() => undefined),
    ),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Remove caches de versões anteriores — senão um build antigo fica preso.
      const nomes = await caches.keys();
      await Promise.all(
        nomes.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Só mexe no que é do próprio site. Supabase, Zernio, fontes e qualquer
  // outra origem passam direto.
  if (url.origin !== self.location.origin) return;

  // Rotas de dados nunca são cacheadas, mesmo sendo mesma origem.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/functions/')) return;

  // Assets com hash: cache-first.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copia = res.clone();
              caches.open(ASSET_CACHE).then((c) => c.put(req, copia));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Navegação: network-first com fallback para a casca.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/', copia));
          return res;
        })
        .catch(async () => (await caches.match('/')) ?? Response.error()),
    );
  }
});
