import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Archive, ArrowLeft, Barcode, ChevronLeft, ChevronRight, Download, FileCode2, FileText, Forward, Image as ImageIcon, Inbox, Loader2, Mail, MailOpen,
  Paperclip, PenSquare, RefreshCw, Reply, ReplyAll, Search, Send, Settings2, Star, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { formatBRL } from '@/lib/money';
import { findBoletos, findHints, htmlToText, type BoletoInfo } from '@/lib/boleto';
import { EntryFormDialog, type EntryPrefill } from '../finance/EntryFormDialog';
import { useFinanceLookups } from '../finance/data';
import { sefazApi } from '../purchases/data';
import { MailAccountsSettings } from './MailAccountsSettings';
import {
  addrLabel, fetchAttachment, fmtBytes, FOLDER_LABEL, mailApi, saveBlob, useMailAccounts,
  type MailAccount, type MailAttachment, type MailFolder, type MailFull, type MailRow,
} from './mailApi';

const ACC_KEY = 'megacrm_mail_account';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const when = (d: string | null) => {
  if (!d) return '';
  const t = new Date(d); const now = new Date();
  return t.toDateString() === now.toDateString() ? t.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : t.getFullYear() === now.getFullYear() ? t.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '') : t.toLocaleDateString('pt-BR');
};
const folderName = (f: MailFolder) => (f.special && FOLDER_LABEL[f.special]) || f.name;

// E-mail dentro do CRM: caixas IMAP/SMTP (Hostinger) — ler, buscar, baixar anexos, responder,
// encaminhar e lançar boleto/nota direto no Financeiro e em Compras.
export default function EmailPage() {
  const { accounts, missing, reload, canSend } = useMailAccounts();
  const [accId, setAccId] = useState<string | null>(() => { try { return localStorage.getItem(ACC_KEY); } catch { return null; } });
  const account = accounts?.find((a) => a.id === accId && a.is_active) ?? accounts?.find((a) => a.is_active) ?? null;
  useEffect(() => { if (account) try { localStorage.setItem(ACC_KEY, account.id); } catch { /* sem storage */ } }, [account]);
  const [setup, setSetup] = useState(false);

  if (accounts === null) return <div className="p-6"><Skeleton className="h-96" /></div>;
  if (missing || accounts.length === 0 || setup) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-1">
        <div className="flex items-center gap-2">
          {setup && accounts.length > 0 && <Button variant="ghost" size="sm" onClick={() => setSetup(false)}><ArrowLeft className="h-4 w-4" /> Voltar</Button>}
          <h1 className="text-xl font-bold text-[var(--color-text-primary)]">E-mail</h1>
        </div>
        <MailAccountsSettings onChanged={() => void reload()} />
      </div>
    );
  }
  if (!account) return <div className="p-6 text-sm text-[var(--color-text-secondary)]">Todas as caixas estão desligadas. <button type="button" className="font-semibold text-[var(--accent-primary)]" onClick={() => setSetup(true)}>Configurar</button></div>;
  return <Mailbox key={account.id} account={account} accounts={accounts.filter((a) => a.is_active)} onPick={setAccId} onSetup={() => setSetup(true)} canSend={canSend(account)} />;
}

function Mailbox({ account, accounts, onPick, onSetup, canSend }: { account: MailAccount; accounts: MailAccount[]; onPick: (id: string) => void; onSetup: () => void; canSend: boolean }) {
  const [folders, setFolders] = useState<MailFolder[] | null>(null);
  const [folder, setFolder] = useState('INBOX');
  const [rows, setRows] = useState<MailRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(40);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [unread, setUnread] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openUid, setOpenUid] = useState<number | null>(null);
  const [compose, setCompose] = useState<ComposeInit | null>(null);
  const reqId = useRef(0);

  const loadFolders = useCallback(async () => {
    try { const r = await mailApi<{ folders: MailFolder[] }>('mail_folders', { account_id: account.id }); setFolders(r.folders); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setFolders([]); }
  }, [account.id]);
  const loadList = useCallback(async () => {
    const my = ++reqId.current;
    setBusy(true);
    try {
      const r = await mailApi<{ messages: MailRow[]; total: number; pageSize: number }>('mail_list', { account_id: account.id, folder, page, q: query, unread });
      if (my !== reqId.current) return;
      setRows(r.messages); setTotal(r.total); setPageSize(r.pageSize); setErr(null);
    } catch (e) { if (my === reqId.current) { setErr(e instanceof Error ? e.message : String(e)); setRows([]); } }
    finally { if (my === reqId.current) setBusy(false); }
  }, [account.id, folder, page, query, unread]);
  useEffect(() => { void loadFolders(); }, [loadFolders]);
  useEffect(() => { void loadList(); }, [loadList]);
  const refresh = () => { void loadFolders(); void loadList(); };

  const patchRow = (uid: number, p: Partial<MailRow>) => setRows((cur) => cur?.map((r) => (r.uid === uid ? { ...r, ...p } : r)) ?? cur);
  const act = async (action: 'mail_flags' | 'mail_move', uids: number[], extra: Record<string, unknown>, ok?: string) => {
    try {
      await mailApi(action, { account_id: account.id, folder, uids, ...extra });
      if (ok) toast.success(ok);
      if (action === 'mail_move') { setRows((cur) => cur?.filter((r) => !uids.includes(r.uid)) ?? cur); if (openUid && uids.includes(openUid)) setOpenUid(null); void loadFolders(); }
    } catch (e) { toast.error('Não deu certo.', { description: e instanceof Error ? e.message : String(e) }); void loadList(); }
  };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = folders?.find((f) => f.path === folder);

  return (
    <div className="-m-3 flex h-[calc(100%+1.5rem)] min-h-0 bg-[var(--color-bg-primary)] sm:-m-5 sm:h-[calc(100%+2.5rem)]">
      {/* Pastas */}
      <aside className={cn('w-56 shrink-0 flex-col border-r border-[var(--color-border-card)] bg-[var(--color-surface)] p-3', openUid ? 'hidden xl:flex' : 'hidden md:flex')}>
        {accounts.length > 1 ? (
          <select value={account.id} onChange={(e) => onPick(e.target.value)} className="mb-3 h-9 w-full truncate rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm font-semibold" aria-label="Caixa">
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
          </select>
        ) : <div className="mb-3 truncate px-1 text-sm font-semibold text-[var(--color-text-primary)]" title={account.email}>{account.email}</div>}
        <Button className="mb-3 w-full" disabled={!canSend} onClick={() => setCompose({ mode: 'new' })}><PenSquare className="h-4 w-4" /> Escrever</Button>
        <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
          {folders === null ? <Skeleton className="h-40" /> : folders.map((f) => (
            <button key={f.path} type="button" onClick={() => { setFolder(f.path); setPage(0); setOpenUid(null); }}
              className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm', folder === f.path ? 'bg-[var(--color-accent-subtle)] font-semibold text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
              {f.special === '\\Inbox' ? <Inbox className="h-4 w-4 shrink-0" /> : f.special === '\\Sent' ? <Send className="h-4 w-4 shrink-0" /> : f.special === '\\Trash' ? <Trash2 className="h-4 w-4 shrink-0" /> : f.special === '\\Archive' ? <Archive className="h-4 w-4 shrink-0" /> : <Mail className="h-4 w-4 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{folderName(f)}</span>
              {f.unseen ? <span className="rounded-full bg-[var(--accent-fill)] px-1.5 text-[10px] font-bold text-white">{f.unseen}</span> : null}
            </button>
          ))}
        </nav>
        <button type="button" onClick={onSetup} className="mt-2 flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--accent-primary)]"><Settings2 className="h-3.5 w-3.5" /> Caixas e acesso</button>
      </aside>

      {/* Lista */}
      <section className={cn('w-full min-w-0 shrink-0 flex-col border-r border-[var(--color-border-card)] bg-[var(--color-surface)] md:w-[360px] xl:w-[400px]', openUid ? 'hidden lg:flex' : 'flex')}>
        <div className="space-y-2 border-b border-[var(--color-border-soft)] p-3">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 flex-1 truncate text-base font-bold text-[var(--color-text-primary)]">{current ? folderName(current) : 'Caixa de entrada'}</h2>
            <select value={folder} onChange={(e) => { setFolder(e.target.value); setPage(0); }} className="h-8 rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] px-1 text-xs md:hidden" aria-label="Pasta">
              {(folders ?? []).map((f) => <option key={f.path} value={f.path}>{folderName(f)}</option>)}
            </select>
            <button type="button" onClick={refresh} aria-label="Atualizar" className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}</button>
            <Button size="sm" className="md:hidden" disabled={!canSend} onClick={() => setCompose({ mode: 'new' })}><PenSquare className="h-4 w-4" /></Button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); setPage(0); setQuery(q.trim()); }} className="flex gap-2">
            <label className="relative flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar (remetente, assunto, texto)" className="h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] pl-8 pr-7 text-sm outline-none focus:border-[var(--accent-primary)]" />
              {query && <button type="button" aria-label="Limpar busca" onClick={() => { setQ(''); setQuery(''); setPage(0); }} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]"><X className="h-3.5 w-3.5" /></button>}
            </label>
            <button type="button" onClick={() => { setUnread((v) => !v); setPage(0); }} aria-pressed={unread}
              className={cn('h-9 rounded-[var(--radius-control)] border px-2.5 text-xs font-medium', unread ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]')}>Não lidos</button>
          </form>
        </div>
        {err && <div className="m-3 rounded-md border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-2 text-xs text-[var(--color-error)]">{err} <button type="button" className="font-semibold underline" onClick={onSetup}>Conferir caixa</button></div>}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {rows === null ? <li className="p-3"><Skeleton className="h-64" /></li> : rows.length === 0 ? <li className="p-6 text-center text-sm text-[var(--color-text-muted)]">{query || unread ? 'Nada encontrado.' : 'Pasta vazia.'}</li> : rows.map((r) => (
            <li key={r.uid}>
              <div role="button" tabIndex={0} onClick={() => { setOpenUid(r.uid); if (!r.seen) patchRow(r.uid, { seen: true }); }} onKeyDown={(e) => { if (e.key === 'Enter') setOpenUid(r.uid); }}
                className={cn('group flex cursor-pointer gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5 hover:bg-[var(--color-surface-hover)]', openUid === r.uid && 'bg-[var(--color-accent-subtle)]')}>
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', r.seen ? 'bg-transparent' : 'bg-[var(--accent-fill)]')} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className={cn('min-w-0 flex-1 truncate text-sm', r.seen ? 'text-[var(--color-text-secondary)]' : 'font-bold text-[var(--color-text-primary)]')}>{folder === current?.path && current?.special === '\\Sent' ? `Para: ${r.to.map(addrLabel).join(', ')}` : addrLabel(r.from) || '—'}</span>
                    <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{when(r.date)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className={cn('min-w-0 flex-1 truncate text-[13px]', r.seen ? 'text-[var(--color-text-secondary)]' : 'font-semibold text-[var(--color-text-primary)]')}>{r.subject}</span>
                    {r.answered && <Reply className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" aria-label="Respondido" />}
                    {r.attachments > 0 && <Paperclip className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-muted)]" aria-label={`${r.attachments} anexo(s)`} />}
                    <button type="button" aria-label={r.flagged ? 'Tirar estrela' : 'Marcar com estrela'} onClick={(e) => { e.stopPropagation(); patchRow(r.uid, { flagged: !r.flagged }); void act('mail_flags', [r.uid], { flagged: !r.flagged }); }}
                      className={cn('shrink-0', r.flagged ? 'text-[#F5B400]' : 'text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100')}><Star className={cn('h-3.5 w-3.5', r.flagged && 'fill-current')} /></button>
                  </span>
                </span>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t border-[var(--color-border-soft)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          <span>{total ? `${page * pageSize + 1}–${Math.min(total, (page + 1) * pageSize)} de ${total}` : ''}</span>
          <span className="flex gap-1">
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} aria-label="Mais novos" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)] disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
            <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)} aria-label="Mais antigos" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)] disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
          </span>
        </div>
      </section>

      {/* Leitura */}
      <section className={cn('min-w-0 flex-1 flex-col bg-[var(--color-surface)]', openUid ? 'flex' : 'hidden lg:flex')}>
        {openUid ? (
          <MessageView key={`${folder}:${openUid}`} account={account} folder={folder} uid={openUid} canSend={canSend}
            isTrash={current?.special === '\\Trash'}
            onBack={() => setOpenUid(null)}
            onCompose={setCompose}
            onFlag={(flagged) => { patchRow(openUid, { flagged }); void act('mail_flags', [openUid], { flagged }); }}
            onUnread={() => { patchRow(openUid, { seen: false }); void act('mail_flags', [openUid], { seen: false }); setOpenUid(null); }}
            onMove={(to) => void act('mail_move', [openUid], { to }, to === 'trash' ? 'Movido para a lixeira.' : 'Arquivado.')} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-[var(--color-text-muted)]"><MailOpen className="h-10 w-10 opacity-40" /> Escolha um e-mail para ler.</div>
        )}
      </section>

      {compose && <ComposeDialog account={account} init={compose} onClose={() => setCompose(null)} onSent={() => { setCompose(null); void loadFolders(); if (current?.special === '\\Sent') void loadList(); }} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ leitura
function MessageView({ account, folder, uid, canSend, isTrash, onBack, onCompose, onFlag, onUnread, onMove }: {
  account: MailAccount; folder: string; uid: number; canSend: boolean; isTrash: boolean; onBack: () => void; onCompose: (c: ComposeInit) => void;
  onFlag: (f: boolean) => void; onUnread: () => void; onMove: (to: 'trash' | 'archive') => void;
}) {
  const perms = usePermission();
  const [msg, setMsg] = useState<MailFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [images, setImages] = useState(false);
  const [busyAtt, setBusyAtt] = useState<string | null>(null);
  const [launch, setLaunch] = useState<{ prefill: EntryPrefill; fromEmail: string; cnpjs: string[] } | null>(null);
  useEffect(() => {
    void mailApi<MailFull>('mail_get', { account_id: account.id, folder, uid }).then(setMsg).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [account.id, folder, uid]);

  const plain = useMemo(() => (msg ? `${msg.subject}\n${msg.text || htmlToText(msg.html)}` : ''), [msg]);
  const boletos = useMemo(() => findBoletos(plain), [plain]);
  const hints = useMemo(() => findHints(plain), [plain]);
  const canFin = perms.can('financial.ledger_create');
  const canPur = perms.can('purchases.invoice');

  const srcDoc = useMemo(() => {
    if (!msg) return '';
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${images ? 'https: http:' : ''}; img-src data: ${images ? 'https: http:' : ''}; font-src data: ${images ? 'https:' : ''};`;
    const body = msg.html || `<pre style="white-space:pre-wrap;font:14px/1.5 system-ui,sans-serif;margin:0">${esc(msg.text || '')}</pre>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{margin:16px;font:14px/1.5 system-ui,Segoe UI,Arial,sans-serif;color:#0f1b2e;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
  }, [msg, images]);
  const hasRemote = useMemo(() => Boolean(msg?.html && /<img[^>]+src=["']?https?:/i.test(msg.html)), [msg]);

  const download = async (a: MailAttachment) => {
    setBusyAtt(a.part);
    try {
      const f = await fetchAttachment(account.id, folder, uid, a);
      if (f.blob) saveBlob(f.blob, f.filename); else if (f.url) window.open(f.url, '_blank', 'noopener');
    } catch (e) { toast.error('Não consegui baixar.', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusyAtt(null); }
  };
  const toFile = async (a: MailAttachment): Promise<File | null> => {
    const f = await fetchAttachment(account.id, folder, uid, a);
    if (f.blob) return new File([f.blob], f.filename, { type: f.contentType });
    if (f.url) { const r = await fetch(f.url); return new File([await r.blob()], f.filename, { type: f.contentType }); }
    return null;
  };
  const launchPayable = async (b?: BoletoInfo, att?: MailAttachment) => {
    if (!msg) return;
    setBusyAtt(att?.part ?? 'boleto');
    try {
      const pdfs = att ? [att] : msg.attachments.filter((x) => /pdf/i.test(x.contentType) || /\.pdf$/i.test(x.filename)).slice(0, 3);
      const files: File[] = [];
      for (const p of pdfs) { const f = await toFile(p); if (f && f.size <= 10 * 1024 * 1024) files.push(f); }
      const note = [b ? `Linha digitável: ${b.digits}` : '', `E-mail de ${msg.from?.address ?? ''} em ${msg.date ? new Date(msg.date).toLocaleDateString('pt-BR') : ''}`].filter(Boolean).join('\n');
      setLaunch({
        prefill: {
          description: msg.subject.slice(0, 200),
          totalCents: b?.amount_cents ?? hints.amount_cents ?? undefined,
          dueDate: b?.due_date ?? hints.due_date ?? undefined,
          notes: note.slice(0, 500),
          files,
        },
        fromEmail: (msg.from?.address ?? '').toLowerCase(),
        cnpjs: hints.cnpjs,
      });
    } catch (e) { toast.error('Não consegui preparar o lançamento.', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusyAtt(null); }
  };
  const importXml = async (a: MailAttachment) => {
    setBusyAtt(a.part);
    try {
      const f = await toFile(a);
      if (!f) throw new Error('Arquivo não veio.');
      const xml = await f.text();
      const r = await sefazApi<{ number: string; supplier: string; total_cents: number }>('import_xml', { xml });
      toast.success(`Nota ${r.number} importada em Compras → Notas de entrada.`, { description: `${r.supplier} · ${formatBRL(r.total_cents)}`, action: { label: 'Abrir', onClick: () => { window.location.href = '/compras?tab=notas'; } } });
    } catch (e) { toast.error('Não consegui importar a nota.', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusyAtt(null); }
  };

  if (err) return <div className="p-6 text-sm text-[var(--color-error)]">{err} <Button size="sm" variant="ghost" onClick={onBack}>Voltar</Button></div>;
  if (!msg) return <div className="space-y-3 p-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-4 w-1/3" /><Skeleton className="h-80" /></div>;
  const iconBtn = 'flex h-9 w-9 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] disabled:opacity-30';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border-soft)] px-3 py-2">
        <button type="button" onClick={onBack} aria-label="Voltar" className={cn(iconBtn, 'lg:hidden')}><ArrowLeft className="h-4 w-4" /></button>
        <button type="button" disabled={!canSend} onClick={() => onCompose({ mode: 'reply', msg, folder })} title="Responder" className={iconBtn}><Reply className="h-4 w-4" /></button>
        <button type="button" disabled={!canSend} onClick={() => onCompose({ mode: 'replyAll', msg, folder })} title="Responder a todos" className={iconBtn}><ReplyAll className="h-4 w-4" /></button>
        <button type="button" disabled={!canSend} onClick={() => onCompose({ mode: 'forward', msg, folder })} title="Encaminhar" className={iconBtn}><Forward className="h-4 w-4" /></button>
        <span className="mx-1 h-5 w-px bg-[var(--color-border-card)]" />
        <button type="button" onClick={() => onFlag(!msg.flagged)} title="Estrela" className={cn(iconBtn, msg.flagged && 'text-[#F5B400]')}><Star className={cn('h-4 w-4', msg.flagged && 'fill-current')} /></button>
        <button type="button" onClick={onUnread} title="Marcar como não lido" className={iconBtn}><Mail className="h-4 w-4" /></button>
        <button type="button" onClick={() => onMove('archive')} title="Arquivar" className={iconBtn}><Archive className="h-4 w-4" /></button>
        {!isTrash && <button type="button" onClick={() => onMove('trash')} title="Lixeira" className={iconBtn}><Trash2 className="h-4 w-4" /></button>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-1 px-5 pb-3 pt-4">
          <h1 className="text-lg font-bold leading-snug text-[var(--color-text-primary)]">{msg.subject}</h1>
          <div className="text-sm text-[var(--color-text-primary)]"><b>{msg.from?.name || msg.from?.address}</b>{msg.from?.name && <span className="text-[var(--color-text-muted)]"> &lt;{msg.from.address}&gt;</span>}</div>
          <div className="text-xs text-[var(--color-text-muted)]">Para: {msg.to.map((a) => a.address).join(', ')}{msg.cc.length ? ` · Cc: ${msg.cc.map((a) => a.address).join(', ')}` : ''} · {msg.date ? new Date(msg.date).toLocaleString('pt-BR') : ''}</div>
        </div>

        {(boletos.length > 0 || msg.attachments.length > 0) && (
          <div className="space-y-2 px-5 pb-3">
            {boletos.map((b) => (
              <div key={b.barcode} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-accent-subtle)] px-3 py-2 text-sm">
                <Barcode className="h-5 w-5 text-[var(--accent-primary)]" />
                <span className="min-w-0 flex-1">
                  <b>Boleto encontrado</b>{b.amount_cents ? ` · ${formatBRL(b.amount_cents)}` : ''}{b.due_date ? ` · vence ${new Date(`${b.due_date}T12:00:00`).toLocaleDateString('pt-BR')}` : ''}
                  <span className="block truncate font-mono text-[11px] text-[var(--color-text-muted)]">{b.digits}</span>
                </span>
                <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(b.digits).then(() => toast.success('Linha digitável copiada.')); }}>Copiar código</Button>
                {canFin && <Button size="sm" disabled={busyAtt === 'boleto'} onClick={() => void launchPayable(b)}>{busyAtt === 'boleto' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} Lançar conta a pagar</Button>}
              </div>
            ))}
            {msg.attachments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {msg.attachments.map((a) => {
                  const isPdf = /pdf/i.test(a.contentType) || /\.pdf$/i.test(a.filename);
                  const isXml = /xml/i.test(a.contentType) || /\.xml$/i.test(a.filename);
                  return (
                    <div key={a.part} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-card)] px-2.5 py-1.5 text-sm">
                      {isPdf ? <FileText className="h-4 w-4 text-[#dc2626]" /> : isXml ? <FileCode2 className="h-4 w-4 text-[#16a34a]" /> : /image/i.test(a.contentType) ? <ImageIcon className="h-4 w-4 text-[var(--accent-primary)]" /> : <Paperclip className="h-4 w-4" />}
                      <span className="max-w-[220px] truncate" title={a.filename}>{a.filename}</span>
                      <span className="text-xs text-[var(--color-text-muted)]">{fmtBytes(a.size)}</span>
                      <button type="button" disabled={busyAtt === a.part} onClick={() => void download(a)} aria-label={`Baixar ${a.filename}`} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)]">{busyAtt === a.part ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}</button>
                      {isPdf && canFin && <button type="button" disabled={busyAtt === a.part} onClick={() => void launchPayable(boletos[0], a)} className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)]">Lançar a pagar</button>}
                      {isXml && canPur && <button type="button" disabled={busyAtt === a.part} onClick={() => void importXml(a)} className="rounded-md px-1.5 py-0.5 text-xs font-semibold text-[var(--accent-primary)] hover:bg-[var(--color-accent-subtle)]">Importar nota</button>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {hasRemote && !images && (
          <div className="mx-5 mb-2 flex items-center gap-2 rounded-md bg-[var(--color-surface-hover)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)]">
            <ImageIcon className="h-3.5 w-3.5" /> As imagens de fora foram bloqueadas para sua privacidade.
            <button type="button" className="font-semibold text-[var(--accent-primary)]" onClick={() => setImages(true)}>Mostrar imagens</button>
          </div>
        )}
        <div className="px-3 pb-6">
          <iframe title="Conteúdo do e-mail" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcDoc} className="h-[70vh] w-full rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-white" />
        </div>
      </div>
      {launch && <LaunchPayable {...launch} onClose={() => setLaunch(null)} />}
    </div>
  );
}

// Abre o formulário de conta a pagar com o que veio do e-mail (fornecedor pelo e-mail/CNPJ do texto).
function LaunchPayable({ prefill, fromEmail, cnpjs, onClose }: { prefill: EntryPrefill; fromEmail: string; cnpjs: string[]; onClose: () => void }) {
  const lookups = useFinanceLookups();
  if (lookups.loading) return <Dialog open onClose={onClose} opaque title="Lançar conta a pagar"><Skeleton className="h-40" /></Dialog>;
  // Fornecedor: mesmo e-mail do remetente, senão CNPJ citado no texto, senão o mesmo domínio do e-mail.
  const sup = lookups.parties.filter((p) => p.kind !== 'customer');
  const domain = fromEmail.split('@')[1] ?? '';
  const party = sup.find((p) => p.email?.toLowerCase() === fromEmail)
    ?? sup.find((p) => p.doc && cnpjs.includes(p.doc))
    ?? (domain && !/gmail|hotmail|outlook|yahoo|uol|bol|icloud/i.test(domain) ? sup.find((p) => p.email?.toLowerCase().endsWith(`@${domain}`)) : undefined);
  return <EntryFormDialog kind="payable" lookups={lookups} prefill={{ ...prefill, partyId: party?.id }} onClose={onClose}
    onSaved={() => { onClose(); toast.success('Conta a pagar lançada.', { description: 'O PDF foi anexado ao lançamento.', action: { label: 'Abrir', onClick: () => { window.location.href = '/financeiro?tab=pagar'; } } }); }} />;
}

// ------------------------------------------------------------------------------------------------ escrever
type ComposeInit = { mode: 'new' } | { mode: 'reply' | 'replyAll' | 'forward'; msg: MailFull; folder: string };

function ComposeDialog({ account, init, onClose, onSent }: { account: MailAccount; init: ComposeInit; onClose: () => void; onSent: () => void }) {
  const me = account.email.toLowerCase();
  const orig = init.mode === 'new' ? null : init.msg;
  const replyTo = orig ? (orig.replyTo[0] ?? orig.from) : null;
  const initialTo = init.mode === 'reply' || init.mode === 'replyAll' ? (replyTo?.address ?? '') : '';
  const initialCc = init.mode === 'replyAll' && orig ? [...orig.to, ...orig.cc].map((a) => a.address).filter((x) => x && x.toLowerCase() !== me && x !== initialTo).join(', ') : '';
  const prefix = init.mode === 'forward' ? 'Enc: ' : init.mode === 'new' ? '' : 'Re: ';
  const [to, setTo] = useState(initialTo);
  const [cc, setCc] = useState(initialCc);
  const [bcc, setBcc] = useState('');
  const [showCc, setShowCc] = useState(Boolean(initialCc));
  const [subject, setSubject] = useState(orig ? (/^(re|enc|fwd|fw):/i.test(orig.subject) ? orig.subject : `${prefix}${orig.subject}`) : '');
  const [body, setBody] = useState(account.signature ? `\n\n--\n${account.signature}` : '');
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);

  const quoted = useMemo(() => {
    if (!orig) return '';
    const head = init.mode === 'forward'
      ? `---------- Mensagem encaminhada ----------<br>De: ${esc(orig.from?.name ?? '')} &lt;${esc(orig.from?.address ?? '')}&gt;<br>Data: ${orig.date ? new Date(orig.date).toLocaleString('pt-BR') : ''}<br>Assunto: ${esc(orig.subject)}<br>Para: ${esc(orig.to.map((a) => a.address).join(', '))}<br><br>`
      : `Em ${orig.date ? new Date(orig.date).toLocaleString('pt-BR') : ''}, ${esc(orig.from?.name || orig.from?.address || '')} escreveu:`;
    const content = orig.html || `<pre style="white-space:pre-wrap">${esc(orig.text)}</pre>`;
    return init.mode === 'forward' ? `<br><div>${head}${content}</div>` : `<br><div>${head}</div><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${content}</blockquote>`;
  }, [orig, init.mode]);

  const addFiles = (list: FileList | null) => {
    const next = [...files, ...Array.from(list ?? [])];
    if (next.reduce((s, f) => s + f.size, 0) > 3 * 1024 * 1024) { toast.error('Anexos até 3 MB no total.', { description: 'Para arquivos maiores, mande um link.' }); return; }
    setFiles(next.slice(0, 10));
  };
  const send = async () => {
    if (!to.trim()) { toast.error('Informe para quem vai.'); return; }
    setSending(true);
    try {
      const attachments = await Promise.all(files.map(async (f) => {
        const buf = new Uint8Array(await f.arrayBuffer());
        let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return { filename: f.name, contentType: f.type || 'application/octet-stream', base64: btoa(bin) };
      }));
      const html = `<div style="font:14px/1.5 Arial,sans-serif">${esc(body).replace(/\n/g, '<br>')}</div>${quoted}`;
      const text = `${body}${orig ? `\n\n> ${(orig.text || htmlToText(orig.html)).split('\n').slice(0, 60).join('\n> ')}` : ''}`;
      await mailApi('mail_send', {
        account_id: account.id, to, cc, bcc, subject, html, text, attachments,
        reply: orig && init.mode !== 'forward' ? { uid: orig.uid, folder: init.mode !== 'new' ? init.folder : 'INBOX', messageId: orig.messageId, references: orig.references } : undefined,
        forward: orig && init.mode === 'forward' ? { uid: orig.uid, folder: init.folder } : undefined,
      });
      toast.success('E-mail enviado.', { description: 'A cópia ficou em Enviados.' });
      onSent();
    } catch (e) { toast.error('Não foi enviado.', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setSending(false); }
  };
  const field = 'h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm outline-none focus:border-[var(--accent-primary)]';
  return (
    <Dialog open onClose={onClose} opaque widthClass="max-w-3xl" title={init.mode === 'new' ? 'Novo e-mail' : init.mode === 'forward' ? 'Encaminhar' : 'Responder'} description={`De: ${account.display_name ? `${account.display_name} <${account.email}>` : account.email}`}>
      <div className="space-y-2">
        <div className="flex items-center gap-2"><span className="w-12 text-xs text-[var(--color-text-muted)]">Para</span><input autoFocus={init.mode === 'new' || init.mode === 'forward'} value={to} onChange={(e) => setTo(e.target.value)} placeholder="email@exemplo.com, outro@exemplo.com" className={field} />
          {!showCc && <button type="button" onClick={() => setShowCc(true)} className="shrink-0 text-xs font-semibold text-[var(--accent-primary)]">Cc/Cco</button>}</div>
        {showCc && <>
          <div className="flex items-center gap-2"><span className="w-12 text-xs text-[var(--color-text-muted)]">Cc</span><input value={cc} onChange={(e) => setCc(e.target.value)} className={field} /></div>
          <div className="flex items-center gap-2"><span className="w-12 text-xs text-[var(--color-text-muted)]">Cco</span><input value={bcc} onChange={(e) => setBcc(e.target.value)} className={field} /></div>
        </>}
        <div className="flex items-center gap-2"><span className="w-12 text-xs text-[var(--color-text-muted)]">Assunto</span><input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} /></div>
        <textarea autoFocus={init.mode === 'reply' || init.mode === 'replyAll'} value={body} onChange={(e) => setBody(e.target.value)} rows={12}
          onFocus={(e) => { if (init.mode !== 'new' && e.target.selectionStart === e.target.value.length && body.startsWith('\n')) e.target.setSelectionRange(0, 0); }}
          className="w-full resize-y rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] p-3 text-sm outline-none focus:border-[var(--accent-primary)]" placeholder="Escreva aqui…" />
        {orig && <p className="text-xs text-[var(--color-text-muted)]">{init.mode === 'forward' ? `A mensagem original vai junto${orig.attachments.length ? `, com ${orig.attachments.length} anexo(s)` : ''}.` : 'A mensagem original vai citada abaixo do seu texto.'}</p>}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {files.map((f, i) => <span key={i} className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-card)] px-2 py-1 text-xs"><Paperclip className="h-3 w-3" />{f.name} <span className="text-[var(--color-text-muted)]">{fmtBytes(f.size)}</span><button type="button" aria-label={`Remover ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="h-3 w-3" /></button></span>)}
          </div>
        )}
        <div className="flex items-center justify-between gap-2 pt-1">
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /> Anexar</Button>
            {totalBytes > 0 && <span className="text-xs text-[var(--color-text-muted)]">{fmtBytes(totalBytes)} de 3 MB</span>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={sending}>Cancelar</Button>
            <Button onClick={() => void send()} disabled={sending}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Enviar</Button>
          </div>
        </div>
        <p className="text-right text-[11px] text-[var(--color-text-muted)]"><Link to="/configuracoes/integracoes/email" className="hover:underline">Assinatura e caixas</Link></p>
      </div>
    </Dialog>
  );
}
