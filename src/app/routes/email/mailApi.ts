import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

export interface MailAccount {
  id: string; org_id: string; owner_id: string; email: string; display_name: string | null; username: string;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; signature: string | null;
  is_active: boolean; last_ok_at: string | null; last_error: string | null; created_at: string;
}
export interface MailMember { account_id: string; user_id: string; can_send: boolean }
export interface MailAddr { name: string; address: string }
export interface MailFolder { path: string; name: string; special: string | null; messages: number | null; unseen: number | null; delimiter: string }
export interface MailRow {
  uid: number; subject: string; from: MailAddr | null; to: MailAddr[]; date: string | null;
  seen: boolean; flagged: boolean; answered: boolean; size: number; attachments: number;
}
export interface MailAttachment { part: string; filename: string; contentType: string; size: number; inline: boolean; cid: string | null }
export interface MailFull {
  uid: number; folder: string; subject: string; from: MailAddr | null; to: MailAddr[]; cc: MailAddr[]; replyTo: MailAddr[];
  date: string | null; messageId: string | null; references: string[]; html: string; text: string; flagged: boolean;
  attachments: MailAttachment[];
}

// Rota /api/mail (Vercel; IMAP/SMTP no servidor). A senha nunca volta para o navegador.
export async function mailApi<T = Record<string, unknown>>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data } = await getSupabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sessão expirada. Entre de novo.');
  let res: Response;
  try {
    res = await fetch('/api/mail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new Error('Sem conexão com o servidor. Confira a internet e tente de novo.');
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.message ?? (res.status === 413 ? 'Arquivo grande demais para enviar.' : `Erro ${res.status}`)));
  return json as T;
}

// Caixas que eu posso usar (minhas + liberadas para mim) — a RLS já filtra.
export function useMailAccounts() {
  const { userId } = useAppUser();
  const [accounts, setAccounts] = useState<MailAccount[] | null>(null);
  const [members, setMembers] = useState<MailMember[]>([]);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    const sb = getSupabase();
    const [a, m] = await Promise.all([
      sb.from('mail_accounts').select('*').order('created_at'),
      sb.from('mail_account_members').select('account_id, user_id, can_send'),
    ]);
    if (a.error && /mail_accounts|schema cache|does not exist/i.test(a.error.message)) setMissing(true);
    setAccounts((a.data ?? []) as MailAccount[]);
    setMembers((m.data ?? []) as MailMember[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const canSend = (acc: MailAccount) => acc.owner_id === userId || members.some((x) => x.account_id === acc.id && x.user_id === userId && x.can_send);
  return { accounts, members, missing, reload: load, canSend, userId };
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const addrLabel = (a: MailAddr | null | undefined) => (a ? a.name || a.address : '');

export function b64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// Baixa o anexo: base64 (até 3 MB) ou link assinado (maiores).
export async function fetchAttachment(accountId: string, folder: string, uid: number, att: MailAttachment): Promise<{ blob: Blob | null; url: string | null; filename: string; contentType: string }> {
  const r = await mailApi<{ filename: string; contentType: string; base64?: string; url?: string }>('mail_attachment', { account_id: accountId, folder, uid, part: att.part, filename: att.filename });
  if (r.base64) return { blob: b64ToBlob(r.base64, r.contentType), url: null, filename: r.filename, contentType: r.contentType };
  return { blob: null, url: r.url ?? null, filename: r.filename, contentType: r.contentType };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export const FOLDER_LABEL: Record<string, string> = {
  '\\Inbox': 'Caixa de entrada', '\\Sent': 'Enviados', '\\Drafts': 'Rascunhos', '\\Trash': 'Lixeira', '\\Junk': 'Spam', '\\Archive': 'Arquivo', '\\All': 'Todos', '\\Flagged': 'Com estrela',
};
