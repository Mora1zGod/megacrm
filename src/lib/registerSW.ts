// ============================================================================
// registerSW — instala o service worker e trata atualização de versão
// ----------------------------------------------------------------------------
// Sem tratar atualização, o PWA instalado no celular fica preso na versão que
// foi instalada: o SW novo entra em "waiting" e só assume quando TODAS as abas
// forem fechadas — o que num app de tela cheia praticamente não acontece. O
// operador continuaria usando uma versão antiga sem saber.
//
// Aqui, quando uma versão nova é detectada, mandamos o SW assumir na hora e
// recarregamos uma única vez (guarda contra loop de reload).
// ============================================================================

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  // Em dev o SW atrapalha (cacheia módulos do Vite e mascara alterações).
  if (import.meta.env.DEV) return;

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const novo = reg.installing;
          if (!novo) return;
          novo.addEventListener('statechange', () => {
            // Só é ATUALIZAÇÃO se já havia um controller; na primeira
            // instalação isso também dispara e não queremos recarregar.
            if (novo.state === 'installed' && navigator.serviceWorker.controller) {
              novo.postMessage('SKIP_WAITING');
            }
          });
        });
      })
      .catch(() => {
        // Falha ao registrar não pode derrubar o app — ele funciona sem SW.
      });

    let recarregando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (recarregando) return;
      recarregando = true;
      window.location.reload();
    });
  });
}
