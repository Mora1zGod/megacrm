import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { registerServiceWorker } from './lib/registerSW';
import './styles/globals.css';

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
