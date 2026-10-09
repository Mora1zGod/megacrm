import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from './lib/registerSW';
import { reloadForNewVersion } from './lib/lazyRetry';
import './styles/globals.css';

// Arquivo de tela de uma versão antiga (depois de um deploy): recarrega para pegar a nova em vez de travar.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewVersion()) event.preventDefault();
});

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root element is missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: instalável no celular + carregamento rápido. Só roda em produção.
registerServiceWorker();
