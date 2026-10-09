import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { execSync } from 'node:child_process';

export default defineConfig(({ mode }) => {
  // Em produção a Vercel injeta SUPABASE_URL/ANON_KEY via process.env (têm
  // prioridade). Em dev, caem para um arquivo .env/.env.local na raiz, para o
  // app já abrir configurado e pular o wizard /setup.
  const fileEnv = loadEnv(mode, process.cwd(), '');
  const supabaseUrl = process.env.SUPABASE_URL ?? fileEnv.SUPABASE_URL ?? '';
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ?? fileEnv.SUPABASE_ANON_KEY ?? '';

  // Versão mostrada no rodapé do menu: commit (igual ao `git log`) + hora do build.
  let commit = (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7);
  if (!commit) {
    try { commit = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { commit = 'local'; }
  }
  const commitMsg = (process.env.VERCEL_GIT_COMMIT_MESSAGE ?? '').split('\n')[0].slice(0, 120);

  return {
    plugins: [react(), tailwindcss()],
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(supabaseUrl),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(supabaseAnonKey),
      'import.meta.env.VITE_APP_COMMIT': JSON.stringify(commit),
      'import.meta.env.VITE_APP_COMMIT_MSG': JSON.stringify(commitMsg),
      'import.meta.env.VITE_APP_BUILT_AT': JSON.stringify(new Date().toISOString()),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
    },
    // Bibliotecas base num arquivo separado: mudam pouco, então o navegador
    // mantém em cache entre um deploy e outro (só o código do CRM é baixado de novo).
    build: {
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined;
            if (/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\//.test(id)) return 'vendor-react';
            if (/node_modules\/@supabase\//.test(id)) return 'vendor-supabase';
            return undefined;
          },
        },
      },
    },
  };
});
