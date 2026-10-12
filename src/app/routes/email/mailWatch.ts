import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { mailApi, type MailAddr } from './mailApi';

// Aviso de e-mail novo com o CRM aberto: confere a Caixa de entrada das caixas do usuário a cada
// 2 min (e ao voltar para a aba). Novo e-mail = aviso na tela (+ aviso do navegador se a aba estiver
// em segundo plano e os avisos estiverem liberados) e contador de não lidos no menu "E-mail".
// O e-mail continua só na Hostinger: aqui guardamos no navegador apenas o último UID visto.

const POLL_MS = 120_000;
const MIN_GAP_MS = 45_000;
const UID_KEY = (id: string) => `megacrm_mail_uidnext:${id}`;
const ACC_KEY = 'megacrm_mail_account';

type Fresh = { uid: number; from: MailAddr | null; subject: string; date: string | null };
type CheckResp = { accounts: Array<{ account_id: string; unseen: number; uidNext: number; fresh: Fresh[]; error?: string }> };

// ---- store mínima (contador do menu + aviso para a tela de E-mail recarregar)
let unseen = 0;
let version = 0;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useMailUnseen = () => useSyncExternalStore(subscribe, () => unseen, () => 0);
// Muda sempre que chega e-mail novo (a tela de E-mail usa para recarregar a lista).
export const useMailVersion = () => useSyncExternalStore(subscribe, () => version, () => 0);
// A tela de E-mail avisa quando o usuário leu/apagou algo, para o contador acompanhar.
export function requestMailCheck() { window.dispatchEvent(new Event('megacrm-mail-check')); }

const readUid = (id: string) => { try { return Number(localStorage.getItem(UID_KEY(id)) || 0); } catch { return 0; } };
const writeUid = (id: string, v: number) => { try { localStorage.setItem(UID_KEY(id), String(v)); } catch { /* sem storage */ } };
const who = (a: MailAddr | null) => (a ? a.name || a.address : 'Remetente desconhecido');

export function useMailWatcher() {
  const { userId } = useAppUser();
  const navigate = useNavigate();
  const navRef = useRef(navigate);
  navRef.current = navigate;

  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let accounts: Array<{ id: string; email: string }> = [];
    let last = 0;
    let running = false;

    const loadAccounts = async () => {
      const { data, error } = await getSupabase().from('mail_accounts').select('id, email, is_active').eq('is_active', true).order('created_at');
      accounts = error ? [] : ((data ?? []) as Array<{ id: string; email: string }>);
    };

    const check = async (force = false) => {
      if (stopped || running || !accounts.length) return;
      if (!force && Date.now() - last < MIN_GAP_MS) return;
      running = true; last = Date.now();
      try {
        const since = Object.fromEntries(accounts.map((a) => [a.id, readUid(a.id)]));
        const r = await mailApi<CheckResp>('mail_check', { account_ids: accounts.map((a) => a.id), since });
        let total = 0;
        const news: Array<Fresh & { accountId: string; email: string }> = [];
        for (const a of r.accounts) {
          if (a.error) continue;
          total += a.unseen;
          const before = since[a.account_id] ?? 0;
          // 1ª vez neste navegador: só marca o ponto de partida (não avisa o que já estava lá).
          if (before > 0) news.push(...a.fresh.map((f) => ({ ...f, accountId: a.account_id, email: accounts.find((x) => x.id === a.account_id)?.email ?? '' })));
          if (a.uidNext > 0) writeUid(a.account_id, a.uidNext);
        }
        unseen = total;
        if (news.length) version += 1;
        emit();
        if (news.length) notify(news);
      } catch { /* sem conexão agora: tenta na próxima */ }
      finally { running = false; }
    };

    const open = (accountId: string) => {
      try { localStorage.setItem(ACC_KEY, accountId); } catch { /* sem storage */ }
      navRef.current('/email');
    };
    const notify = (news: Array<Fresh & { accountId: string; email: string }>) => {
      const first = news[news.length - 1];
      const title = news.length === 1 ? `Novo e-mail — ${who(first.from)}` : `${news.length} e-mails novos`;
      const body = news.length === 1 ? first.subject : news.slice(-3).map((n) => `${who(n.from)}: ${n.subject}`).join('\n');
      toast.info(title, { description: body, duration: 10_000, action: { label: 'Abrir', onClick: () => open(first.accountId) } });
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
        try {
          const n = new Notification(title, { body, tag: `mail-${first.accountId}`, icon: '/icon-192.png' });
          n.onclick = () => { window.focus(); open(first.accountId); n.close(); };
        } catch { /* navegador sem suporte */ }
      }
    };

    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    // Pedido da tela de E-mail (leu/moveu): espera 2 s para juntar vários cliques e no máximo 1 a cada 15 s.
    let askTimer = 0;
    const onAsk = () => {
      window.clearTimeout(askTimer);
      askTimer = window.setTimeout(() => { if (Date.now() - last >= 15_000) void check(true); }, 2000);
    };
    const onAccounts = () => { void loadAccounts().then(() => check(true)); };

    void loadAccounts().then(() => check(true));
    const timer = window.setInterval(() => { void check(); }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('megacrm-mail-check', onAsk);
    window.addEventListener('megacrm-mail-accounts', onAccounts);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(askTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('megacrm-mail-check', onAsk);
      window.removeEventListener('megacrm-mail-accounts', onAccounts);
    };
  }, [userId]);
}

// Componente sem tela: montado uma vez no layout.
export function MailWatcher() { useMailWatcher(); return null; }
