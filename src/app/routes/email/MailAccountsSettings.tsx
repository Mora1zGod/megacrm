import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, ChevronDown, Loader2, Mail, Pencil, Plus, Share2, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { Field, inputCls } from '../settings/sections/access/ui';
import { mailApi, useMailAccounts, type MailAccount } from './mailApi';

// Configurações → Comunicação e integrações → E-mail: cada pessoa liga a PRÓPRIA caixa (Hostinger ou outra
// IMAP/SMTP) e pode liberar para colegas. A senha é testada e guardada cifrada no servidor.
export function MailAccountsSettings({ onChanged }: { onChanged?: () => void }) {
  const { accounts, members, missing, reload, userId } = useMailAccounts();
  const [editing, setEditing] = useState<MailAccount | 'new' | null>(null);
  const [sharing, setSharing] = useState<MailAccount | null>(null);
  const [confirmDel, setConfirmDel] = useState<MailAccount | null>(null);

  if (accounts === null) return <Skeleton className="h-40" />;
  if (missing) return <p className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-4 text-sm text-[var(--color-text-secondary)]">Falta rodar o SQL do e-mail (<code>SQL-09-10-email.sql</code>) no Supabase.</p>;
  const mine = accounts.filter((a) => a.owner_id === userId);
  const shared = accounts.filter((a) => a.owner_id !== userId);
  const del = async (a: MailAccount) => {
    try { await mailApi('mail_delete_account', { account_id: a.id }); toast.success('Caixa desligada do CRM.', { description: 'Nada foi apagado na Hostinger.' }); setConfirmDel(null); await reload(); onChanged?.(); }
    catch (e) { toast.error('Não consegui remover.', { description: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-secondary)]">
        <Mail className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
        <div>Ligue o seu e-mail (Hostinger ou outro com IMAP/SMTP) para ler, responder e baixar anexos dentro do CRM. Só você vê a sua caixa — a não ser que libere para um colega. A senha fica cifrada no servidor; os e-mails continuam na Hostinger.</div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Minhas caixas</h3>
        <Button onClick={() => setEditing('new')}><Plus className="h-4 w-4" /> Ligar e-mail</Button>
      </div>
      {mine.length === 0 ? <p className="text-sm text-[var(--color-text-muted)]">Nenhuma caixa ligada ainda.</p> : (
        <ul className="divide-y divide-[var(--color-border-soft)] rounded-[var(--radius-card)] border border-[var(--color-border-card)]">
          {mine.map((a) => {
            const shares = members.filter((m) => m.account_id === a.id).length;
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {a.last_error ? <XCircle className="h-5 w-5 text-[var(--color-error)]" /> : <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-[var(--color-text-primary)]">{a.display_name ? `${a.display_name} · ` : ''}{a.email}</span>
                  <span className="block truncate text-xs text-[var(--color-text-muted)]">{a.imap_host} · {shares ? `liberada para ${shares} colega(s)` : 'só você'}{!a.is_active ? ' · desligada' : ''}{a.last_error ? ` · ${a.last_error}` : ''}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => setSharing(a)}><Share2 className="h-3.5 w-3.5" /> Liberar</Button>
                <Button size="sm" variant="outline" onClick={() => setEditing(a)}><Pencil className="h-3.5 w-3.5" /> Editar</Button>
                <button type="button" aria-label={`Remover ${a.email}`} onClick={() => setConfirmDel(a)} className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-error)]"><Trash2 className="h-4 w-4" /></button>
              </li>
            );
          })}
        </ul>
      )}
      {shared.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-[var(--color-text-primary)]">Liberadas para mim</h3>
          <ul className="space-y-1 text-sm text-[var(--color-text-secondary)]">
            {shared.map((a) => <li key={a.id} className="flex items-center gap-2"><Mail className="h-4 w-4" /> {a.email}{members.find((m) => m.account_id === a.id && m.user_id === userId)?.can_send === false ? ' (só leitura)' : ''}</li>)}
          </ul>
        </div>
      )}

      {editing && <AccountForm account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await reload(); onChanged?.(); }} />}
      {sharing && <ShareDialog account={sharing} onClose={() => setSharing(null)} onChanged={reload} />}
      {confirmDel && (
        <Dialog open onClose={() => setConfirmDel(null)} opaque title="Desligar caixa do CRM" description={`${confirmDel.email} sai do CRM. Os e-mails continuam na Hostinger.`}>
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmDel(null)}>Cancelar</Button><Button className="bg-[var(--color-error)]" onClick={() => void del(confirmDel)}>Desligar</Button></div>
        </Dialog>
      )}
    </div>
  );
}

function AccountForm({ account, onClose, onSaved }: { account: MailAccount | null; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState(account?.email ?? '');
  const [name, setName] = useState(account?.display_name ?? '');
  const [username, setUsername] = useState(account?.username ?? '');
  const [password, setPassword] = useState('');
  const [imapHost, setImapHost] = useState(account?.imap_host ?? 'imap.hostinger.com');
  const [imapPort, setImapPort] = useState(String(account?.imap_port ?? 993));
  const [smtpHost, setSmtpHost] = useState(account?.smtp_host ?? 'smtp.hostinger.com');
  const [smtpPort, setSmtpPort] = useState(String(account?.smtp_port ?? 465));
  const [signature, setSignature] = useState(account?.signature ?? '');
  const [active, setActive] = useState(account?.is_active ?? true);
  const [adv, setAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!email.trim()) { toast.error('Informe o e-mail.'); return; }
    if (!account && !password) { toast.error('Informe a senha do e-mail.'); return; }
    setBusy(true);
    try {
      await mailApi('mail_save_account', {
        id: account?.id, email: email.trim(), display_name: name.trim(), username: username.trim() || email.trim(), password: password || undefined,
        imap_host: imapHost.trim(), imap_port: Number(imapPort), smtp_host: smtpHost.trim(), smtp_port: Number(smtpPort), signature, is_active: active,
      });
      toast.success(account ? 'Caixa atualizada.' : 'E-mail ligado! Entrada e envio testados.');
      onSaved();
    } catch (e) { toast.error('Não consegui ligar o e-mail.', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} opaque title={account ? `Editar ${account.email}` : 'Ligar e-mail'} widthClass="max-w-lg"
      description="Usa o mesmo e-mail e senha do webmail da Hostinger. O CRM testa a entrada e o envio antes de salvar.">
      <div className="space-y-3">
        <Field label="E-mail" htmlFor="ma-email" required><input id="ma-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={Boolean(account)} placeholder="financeiro@amaipark.com" className={inputCls} /></Field>
        <Field label="Nome que aparece para quem recebe" htmlFor="ma-name"><input id="ma-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Financeiro AMAI Park" className={inputCls} /></Field>
        <Field label={account ? 'Nova senha (deixe vazio para manter)' : 'Senha do e-mail'} htmlFor="ma-pass" required={!account}>
          <input id="ma-pass" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Assinatura (vai no fim dos e-mails)" htmlFor="ma-sig"><textarea id="ma-sig" rows={3} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={'Gabriel Moura\nAMAI Park · (68) 9 9999-9999'} className={cn(inputCls, 'h-auto py-2')} /></Field>
        <button type="button" onClick={() => setAdv((v) => !v)} className="flex items-center gap-1 text-xs font-semibold text-[var(--accent-primary)]"><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', adv && 'rotate-180')} /> Servidores (avançado)</button>
        {adv && (
          <div className="grid grid-cols-[1fr_90px] gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-3">
            <Field label="Usuário (login)" htmlFor="ma-user"><input id="ma-user" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="igual ao e-mail" className={inputCls} /></Field><div />
            <Field label="IMAP (entrada)" htmlFor="ma-ih"><input id="ma-ih" value={imapHost} onChange={(e) => setImapHost(e.target.value)} className={inputCls} /></Field>
            <Field label="Porta" htmlFor="ma-ip"><input id="ma-ip" value={imapPort} onChange={(e) => setImapPort(e.target.value.replace(/\D/g, ''))} className={inputCls} /></Field>
            <Field label="SMTP (envio)" htmlFor="ma-sh"><input id="ma-sh" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} className={inputCls} /></Field>
            <Field label="Porta" htmlFor="ma-sp"><input id="ma-sp" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value.replace(/\D/g, ''))} className={inputCls} /></Field>
            {account && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Caixa ligada</label>}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancelar</Button>
          <Button onClick={() => void save()} disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} {busy ? 'Testando…' : 'Testar e salvar'}</Button>
        </div>
      </div>
    </Dialog>
  );
}

function ShareDialog({ account, onClose, onChanged }: { account: MailAccount; onClose: () => void; onChanged: () => Promise<void> }) {
  const { operators } = useOperators();
  const [rows, setRows] = useState<Array<{ user_id: string; can_send: boolean }> | null>(null);
  const load = async () => {
    const { data } = await getSupabase().from('mail_account_members').select('user_id, can_send').eq('account_id', account.id);
    setRows((data ?? []) as Array<{ user_id: string; can_send: boolean }>);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [account.id]);
  const set = async (uid: string, on: boolean, canSend = true) => {
    const sb = getSupabase();
    const { error } = on
      ? await sb.from('mail_account_members').upsert({ account_id: account.id, user_id: uid, org_id: account.org_id, can_send: canSend }, { onConflict: 'account_id,user_id' })
      : await sb.from('mail_account_members').delete().eq('account_id', account.id).eq('user_id', uid);
    if (error) { toast.error('Não consegui salvar.', { description: error.message }); return; }
    await load(); await onChanged();
  };
  return (
    <Dialog open onClose={onClose} opaque title={`Liberar ${account.email}`} description="Quem você marcar vê esta caixa no CRM. Tire o 'pode enviar' para deixar só leitura.">
      {rows === null ? <Skeleton className="h-32" /> : (
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {operators.filter((o) => o.user_id !== account.owner_id).map((o) => {
            const r = rows.find((x) => x.user_id === o.user_id);
            return (
              <li key={o.user_id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--color-surface-hover)]">
                <label className="flex flex-1 items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(r)} onChange={(e) => void set(o.user_id, e.target.checked)} /> {operatorLabel(o)}</label>
                {r && <label className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)]"><input type="checkbox" checked={r.can_send} onChange={(e) => void set(o.user_id, true, e.target.checked)} /> pode enviar</label>}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
