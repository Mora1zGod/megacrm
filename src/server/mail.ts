// ============================================================================
// E-mail (IMAP/SMTP) — usado pela rota Vercel /api/mail (reescrita para api/sefaz.ts,
// que só despacha as ações "mail_*" para cá; o plano Hobby tem limite de 12 funções).
// ----------------------------------------------------------------------------
// Nada de e-mail é gravado no banco: cada ação abre a caixa (IMAP), faz o que precisa
// e fecha. Envio por SMTP + cópia em "Enviados" (APPEND). A senha fica cifrada em
// whatsapp_hub.mail_account_secrets (só service role). Acesso: dono da caixa ou
// colega liberado em mail_account_members (enviar exige can_send).
// ============================================================================
import { randomUUID } from 'node:crypto';
import { ImapFlow, type ListResponse, type MessageStructureObject, type MessageAddressObject } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt } from '../lib/credentials.js';

export class MailError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface MailCtx {
  userId: string;
  orgId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sys: SupabaseClient<any, any, any>;
}

interface Account {
  id: string; org_id: string; owner_id: string; email: string; display_name: string | null; username: string;
  imap_host: string; imap_port: number; smtp_host: string; smtp_port: number; signature: string | null; is_active: boolean;
}
interface Creds { host: string; port: number; smtpHost: string; smtpPort: number; user: string; pass: string }

const PAGE = 40;
const MAX_INLINE_B64 = 3 * 1024 * 1024;   // a Vercel devolve no máx. ~4,5 MB por resposta
const MAX_SEND_BYTES = 3 * 1024 * 1024;   // e recebe no máx. ~4,5 MB por pedido
const MAX_HTML = 1_500_000;
const BUCKET = 'whatsapp-hub-mail';

const db = (ctx: MailCtx) => ctx.sys.schema('whatsapp_hub');
const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
const int = (v: unknown, def: number) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 65536 ? n : def; };
const hostOk = (h: string) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h);

// ------------------------------------------------------------------ acesso
async function loadAccount(ctx: MailCtx, id: unknown, need: 'use' | 'send' | 'owner' = 'use'): Promise<Account> {
  const { data } = await db(ctx).from('mail_accounts').select('*').eq('id', str(id, 64)).maybeSingle();
  const acc = data as Account | null;
  if (!acc || acc.org_id !== ctx.orgId) throw new MailError(404, 'Caixa de e-mail não encontrada.');
  if (acc.owner_id !== ctx.userId) {
    if (need === 'owner') throw new MailError(403, 'Só o dono da caixa pode fazer isso.');
    const { data: m } = await db(ctx).from('mail_account_members').select('can_send').eq('account_id', acc.id).eq('user_id', ctx.userId).maybeSingle();
    if (!m) throw new MailError(403, 'Esta caixa não foi liberada para você.');
    if (need === 'send' && !(m as { can_send: boolean }).can_send) throw new MailError(403, 'Você pode ler esta caixa, mas não enviar por ela.');
  }
  if (!acc.is_active && need !== 'owner') throw new MailError(400, 'Esta caixa está desligada.');
  return acc;
}

async function credsOf(ctx: MailCtx, acc: Account): Promise<Creds> {
  const { data } = await db(ctx).from('mail_account_secrets').select('password_encrypted').eq('account_id', acc.id).maybeSingle();
  const enc = (data as { password_encrypted: string } | null)?.password_encrypted;
  if (!enc) throw new MailError(400, 'Senha da caixa não cadastrada. Abra Configurações → E-mail e salve a senha.');
  return { host: acc.imap_host, port: acc.imap_port, smtpHost: acc.smtp_host, smtpPort: acc.smtp_port, user: acc.username, pass: decrypt(enc) };
}

function friendly(e: unknown): string {
  const err = e as { authenticationFailed?: boolean; responseText?: string; code?: string; message?: string; responseCode?: number };
  if (err?.authenticationFailed || /auth|login|credential|535|invalid/i.test(`${err?.responseText ?? ''} ${err?.message ?? ''}`)) return 'E-mail ou senha não conferem.';
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'Servidor de e-mail não encontrado. Confira o endereço (ex.: imap.hostinger.com).';
  if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNREFUSED' || err?.code === 'ECONNRESET') return 'O servidor de e-mail não respondeu. Confira servidor e porta.';
  return err?.responseText || err?.message || 'Erro ao falar com o servidor de e-mail.';
}

async function withImap<T>(c: Creds, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.port === 993, auth: { user: c.user, pass: c.pass },
    logger: false, socketTimeout: 40_000, greetingTimeout: 12_000, connectionTimeout: 12_000,
  });
  try {
    await client.connect();
  } catch (e) {
    throw new MailError(400, friendly(e));
  }
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function transport(c: Creds) {
  return nodemailer.createTransport({
    host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, auth: { user: c.user, pass: c.pass },
    connectionTimeout: 12_000, greetingTimeout: 12_000, socketTimeout: 40_000,
  });
}

// ------------------------------------------------------------------ helpers de mensagem
const addr = (list?: MessageAddressObject[]) => (list ?? []).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));
const parsedAddr = (a?: AddressObject | AddressObject[]) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value.map((v) => ({ name: v.name ?? '', address: v.address ?? '' })));

interface AttMeta { part: string; filename: string; contentType: string; size: number; inline: boolean; cid: string | null }
function attachmentsOf(node: MessageStructureObject | undefined, out: AttMeta[] = []): AttMeta[] {
  if (!node) return out;
  if (node.childNodes?.length) { for (const ch of node.childNodes) attachmentsOf(ch, out); return out; }
  const type = (node.type ?? '').toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? '';
  const disp = (node.disposition ?? '').toLowerCase();
  const isBodyText = (type === 'text/plain' || type === 'text/html') && !filename && disp !== 'attachment';
  if (isBodyText || type.startsWith('multipart/')) return out;
  out.push({
    part: node.part ?? '1', filename: filename || `anexo.${type.split('/')[1] ?? 'bin'}`, contentType: type || 'application/octet-stream',
    size: node.size ?? 0, inline: disp === 'inline' && Boolean(node.id), cid: node.id ? node.id.replace(/^<|>$/g, '') : null,
  });
  return out;
}

async function findSpecial(client: ImapFlow, use: '\\Sent' | '\\Trash' | '\\Archive' | '\\Drafts'): Promise<string | null> {
  const list = await client.list();
  const hit = list.find((m) => m.specialUse === use);
  if (hit) return hit.path;
  const names: Record<string, RegExp> = {
    '\\Sent': /^(inbox[./])?(sent|enviad[ao]s?|itens enviados|sent items|sent messages)$/i,
    '\\Trash': /^(inbox[./])?(trash|lixeira|deleted|deleted items|itens excluídos)$/i,
    '\\Archive': /^(inbox[./])?(archive|arquivo|arquivados?)$/i,
    '\\Drafts': /^(inbox[./])?(drafts|rascunhos?)$/i,
  };
  return list.find((m) => names[use].test(m.path))?.path ?? null;
}

// ------------------------------------------------------------------ ações
async function saveAccount(ctx: MailCtx, b: Record<string, unknown>) {
  const email = str(b.email, 200).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new MailError(400, 'E-mail inválido.');
  const row = {
    email,
    display_name: str(b.display_name, 120) || null,
    username: str(b.username, 200) || email,
    imap_host: str(b.imap_host, 120) || 'imap.hostinger.com',
    imap_port: int(b.imap_port, 993),
    smtp_host: str(b.smtp_host, 120) || 'smtp.hostinger.com',
    smtp_port: int(b.smtp_port, 465),
    signature: str(b.signature, 5000) || null,
    is_active: b.is_active === undefined ? true : Boolean(b.is_active),
  };
  if (!hostOk(row.imap_host) || !hostOk(row.smtp_host)) throw new MailError(400, 'Servidor IMAP/SMTP inválido.');
  const existing = b.id ? await loadAccount(ctx, b.id, 'owner') : null;
  const password = typeof b.password === 'string' ? b.password : '';
  if (!existing && !password) throw new MailError(400, 'Informe a senha do e-mail.');
  const pass = password || (existing ? (await credsOf(ctx, existing)).pass : '');
  const creds: Creds = { host: row.imap_host, port: row.imap_port, smtpHost: row.smtp_host, smtpPort: row.smtp_port, user: row.username, pass };
  // Testa antes de salvar: entrar no IMAP e no SMTP.
  await withImap(creds, async () => undefined);
  try { await transport(creds).verify(); } catch (e) { throw new MailError(400, `IMAP ok, mas o envio (SMTP) falhou: ${friendly(e)}`); }

  let id = existing?.id;
  if (existing) {
    const { error } = await db(ctx).from('mail_accounts').update({ ...row, last_ok_at: new Date().toISOString(), last_error: null }).eq('id', existing.id);
    if (error) throw new MailError(400, error.message);
  } else {
    const { data, error } = await db(ctx).from('mail_accounts')
      .insert({ ...row, org_id: ctx.orgId, owner_id: ctx.userId, last_ok_at: new Date().toISOString() }).select('id').single();
    if (error) throw new MailError(400, /duplicate|unique/i.test(error.message) ? 'Essa caixa já está ligada no CRM.' : error.message);
    id = (data as { id: string }).id;
  }
  if (password) {
    const { error } = await db(ctx).from('mail_account_secrets').upsert({ account_id: id, password_encrypted: encrypt(password), updated_at: new Date().toISOString() });
    if (error) throw new MailError(500, 'Não consegui guardar a senha.');
  }
  return { ok: true, id };
}

async function deleteAccount(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id, 'owner');
  const { error } = await db(ctx).from('mail_accounts').delete().eq('id', acc.id);
  if (error) throw new MailError(400, error.message);
  return { ok: true };
}

async function folders(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id);
  const c = await credsOf(ctx, acc);
  const list = await withImap(c, (client) => client.list({ statusQuery: { messages: true, unseen: true } }));
  await db(ctx).from('mail_accounts').update({ last_ok_at: new Date().toISOString(), last_error: null }).eq('id', acc.id);
  const rank = (m: ListResponse) => ({ '\\Inbox': 0, '\\Drafts': 2, '\\Sent': 3, '\\Archive': 4, '\\Junk': 5, '\\Trash': 6 } as Record<string, number>)[m.specialUse ?? ''] ?? (m.path.toUpperCase() === 'INBOX' ? 0 : 1);
  return {
    ok: true,
    folders: list.filter((m) => !m.flags.has('\\Noselect')).sort((a, z) => rank(a) - rank(z) || a.path.localeCompare(z.path)).map((m) => ({
      path: m.path, name: m.name, special: m.path.toUpperCase() === 'INBOX' ? '\\Inbox' : (m.specialUse ?? null),
      messages: m.status?.messages ?? null, unseen: m.status?.unseen ?? null, delimiter: m.delimiter,
    })),
  };
}

async function listMessages(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id);
  const c = await credsOf(ctx, acc);
  const folder = str(b.folder, 300) || 'INBOX';
  const page = Math.max(0, Math.floor(Number(b.page) || 0));
  const q = str(b.q, 200);
  const unreadOnly = b.unread === true;
  return withImap(c, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const box = client.mailbox;
      const exists = box && typeof box === 'object' ? box.exists : 0;
      let uids: number[] = [];
      let total = exists;
      if (q || unreadOnly) {
        const query = q ? { or: [{ subject: q }, { from: q }, { body: q }] } : {};
        const found = await client.search(unreadOnly ? { ...query, seen: false } : query, { uid: true });
        const all = (Array.isArray(found) ? found : []).sort((a, z) => z - a);
        total = all.length;
        uids = all.slice(page * PAGE, page * PAGE + PAGE);
      }
      const range = q || unreadOnly ? uids : null;
      if ((q || unreadOnly) && !uids.length) return { ok: true, total, page, pageSize: PAGE, messages: [] };
      let seqRange = '';
      if (!range) {
        const end = exists - page * PAGE;
        if (end < 1) return { ok: true, total, page, pageSize: PAGE, messages: [] };
        seqRange = `${Math.max(1, end - PAGE + 1)}:${end}`;
      }
      const rows = await client.fetchAll(range ?? seqRange, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true }, range ? { uid: true } : undefined);
      const messages = rows.map((m) => ({
        uid: m.uid,
        subject: m.envelope?.subject ?? '(sem assunto)',
        from: addr(m.envelope?.from)[0] ?? null,
        to: addr(m.envelope?.to),
        date: (m.envelope?.date ?? m.internalDate ?? null),
        seen: m.flags?.has('\\Seen') ?? false,
        flagged: m.flags?.has('\\Flagged') ?? false,
        answered: m.flags?.has('\\Answered') ?? false,
        size: m.size ?? 0,
        attachments: attachmentsOf(m.bodyStructure).filter((a) => !a.inline).length,
      })).sort((a, z) => z.uid - a.uid);
      return { ok: true, total, page, pageSize: PAGE, messages };
    } finally { lock.release(); }
  });
}

async function getMessage(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id);
  const c = await credsOf(ctx, acc);
  const folder = str(b.folder, 300) || 'INBOX';
  const uid = Math.floor(Number(b.uid));
  if (!uid) throw new MailError(400, 'Mensagem inválida.');
  return withImap(c, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const meta = await client.fetchOne(String(uid), { uid: true, bodyStructure: true, flags: true, envelope: true }, { uid: true });
      if (!meta) throw new MailError(404, 'E-mail não encontrado (pode ter sido movido).');
      const dl = await client.download(String(uid), undefined, { uid: true, maxBytes: 30 * 1024 * 1024 });
      const parsed = await simpleParser(dl.content);
      let html = typeof parsed.html === 'string' ? parsed.html : '';
      // Imagens embutidas (cid:) viram data: para aparecerem sem baixar nada de fora.
      for (const a of parsed.attachments) {
        if (a.contentId && a.content.length < 400 * 1024 && html) {
          const cid = a.contentId.replace(/^<|>$/g, '');
          html = html.split(`cid:${cid}`).join(`data:${a.contentType};base64,${a.content.toString('base64')}`);
        }
      }
      if (html.length > MAX_HTML) html = `${html.slice(0, MAX_HTML)}<p>[mensagem muito longa — cortada]</p>`;
      if (b.mark_seen !== false && !meta.flags?.has('\\Seen')) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }).catch(() => undefined);
      const atts = attachmentsOf(meta.bodyStructure).filter((a) => !(a.inline && a.cid && html.includes('data:')));
      return {
        ok: true,
        uid,
        folder,
        subject: parsed.subject ?? meta.envelope?.subject ?? '(sem assunto)',
        from: parsedAddr(parsed.from)[0] ?? addr(meta.envelope?.from)[0] ?? null,
        to: parsedAddr(parsed.to), cc: parsedAddr(parsed.cc), replyTo: parsedAddr(parsed.replyTo),
        date: parsed.date ?? meta.envelope?.date ?? null,
        messageId: parsed.messageId ?? meta.envelope?.messageId ?? null,
        references: Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [],
        html, text: (parsed.text ?? '').slice(0, 200_000),
        flagged: meta.flags?.has('\\Flagged') ?? false,
        attachments: atts,
      };
    } finally { lock.release(); }
  });
}

async function getAttachment(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id);
  const c = await credsOf(ctx, acc);
  const folder = str(b.folder, 300) || 'INBOX';
  const uid = Math.floor(Number(b.uid));
  const part = str(b.part, 40);
  if (!uid || !/^[0-9.]+$/.test(part)) throw new MailError(400, 'Anexo inválido.');
  return withImap(c, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const dl = await client.download(String(uid), part, { uid: true, maxBytes: 25 * 1024 * 1024 });
      const chunks: Buffer[] = [];
      for await (const ch of dl.content) chunks.push(ch as Buffer);
      const buf = Buffer.concat(chunks);
      const filename = (dl.meta?.filename || str(b.filename, 200) || 'anexo').replace(/[\\/]/g, '_');
      const contentType = dl.meta?.contentType || 'application/octet-stream';
      if (buf.length <= MAX_INLINE_B64) return { ok: true, filename, contentType, size: buf.length, base64: buf.toString('base64') };
      // Grande demais para a resposta: vai para o Storage privado e volta um link de 10 minutos.
      const path = `${ctx.orgId}/${ctx.userId}/${randomUUID()}/${filename.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-120)}`;
      const up = await ctx.sys.storage.from(BUCKET).upload(path, buf, { contentType, upsert: false });
      if (up.error) throw new MailError(500, `Não consegui preparar o arquivo: ${up.error.message}`);
      const signed = await ctx.sys.storage.from(BUCKET).createSignedUrl(path, 600, { download: filename });
      if (signed.error || !signed.data) throw new MailError(500, 'Não consegui gerar o link do arquivo.');
      return { ok: true, filename, contentType, size: buf.length, url: signed.data.signedUrl };
    } finally { lock.release(); }
  });
}

async function setFlags(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id);
  const c = await credsOf(ctx, acc);
  const folder = str(b.folder, 300) || 'INBOX';
  const uids = (Array.isArray(b.uids) ? b.uids : []).map((x) => Math.floor(Number(x))).filter((x) => x > 0).slice(0, 200);
  if (!uids.length) throw new MailError(400, 'Nenhum e-mail escolhido.');
  return withImap(c, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const set = async (flag: string, on: unknown) => {
        if (on === true) await client.messageFlagsAdd(uids, [flag], { uid: true });
        if (on === false) await client.messageFlagsRemove(uids, [flag], { uid: true });
      };
      await set('\\Seen', b.seen);
      await set('\\Flagged', b.flagged);
      return { ok: true };
    } finally { lock.release(); }
  });
}

async function moveMessages(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id);
  const c = await credsOf(ctx, acc);
  const folder = str(b.folder, 300) || 'INBOX';
  const uids = (Array.isArray(b.uids) ? b.uids : []).map((x) => Math.floor(Number(x))).filter((x) => x > 0).slice(0, 200);
  if (!uids.length) throw new MailError(400, 'Nenhum e-mail escolhido.');
  const to = str(b.to, 300);
  return withImap(c, async (client) => {
    const dest = to === 'trash' ? await findSpecial(client, '\\Trash') : to === 'archive' ? await findSpecial(client, '\\Archive') : to;
    if (!dest) throw new MailError(400, to === 'archive' ? 'Esta caixa não tem pasta de arquivo.' : 'Pasta de destino não encontrada.');
    if (dest === folder) return { ok: true, moved: 0 };
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageMove(uids, dest, { uid: true });
      return { ok: true, moved: uids.length, to: dest };
    } finally { lock.release(); }
  });
}

interface OutAtt { filename: string; content: Buffer; contentType?: string }
async function sendMessage(ctx: MailCtx, b: Record<string, unknown>) {
  const acc = await loadAccount(ctx, b.account_id, 'send');
  const c = await credsOf(ctx, acc);
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 50);
  const to = list(b.to); const cc = list(b.cc); const bcc = list(b.bcc);
  const bad = [...to, ...cc, ...bcc].find((x) => !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(x.replace(/^.*<|>$/g, '')));
  if (bad) throw new MailError(400, `Endereço inválido: ${bad}`);
  if (!to.length) throw new MailError(400, 'Informe pelo menos um destinatário.');
  const subject = str(b.subject, 400);
  const html = String(b.html ?? '').slice(0, 2_000_000);
  const text = String(b.text ?? '').slice(0, 500_000);
  const atts: OutAtt[] = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 10).map((a: Record<string, unknown>) => ({
    filename: str(a.filename, 200) || 'anexo', content: Buffer.from(String(a.base64 ?? ''), 'base64'), contentType: str(a.contentType, 120) || undefined,
  }));
  if (atts.reduce((s, a) => s + a.content.length, 0) > MAX_SEND_BYTES) throw new MailError(400, 'Anexos acima de 3 MB no total.');
  const reply = b.reply && typeof b.reply === 'object' ? b.reply as Record<string, unknown> : null;
  const fwd = b.forward && typeof b.forward === 'object' ? b.forward as Record<string, unknown> : null;

  return withImap(c, async (client) => {
    // Encaminhar: o servidor anexa os arquivos do e-mail original.
    if (fwd?.uid && fwd?.folder) {
      const lock = await client.getMailboxLock(str(fwd.folder, 300));
      try {
        const meta = await client.fetchOne(String(Math.floor(Number(fwd.uid))), { uid: true, bodyStructure: true }, { uid: true });
        for (const a of meta ? attachmentsOf(meta.bodyStructure).filter((x) => !x.inline).slice(0, 10) : []) {
          const dl = await client.download(String(meta && meta.uid), a.part, { uid: true, maxBytes: 20 * 1024 * 1024 });
          const chunks: Buffer[] = [];
          for await (const ch of dl.content) chunks.push(ch as Buffer);
          atts.push({ filename: dl.meta?.filename || a.filename, content: Buffer.concat(chunks), contentType: dl.meta?.contentType || a.contentType });
        }
      } finally { lock.release(); }
    }
    const refs = Array.isArray(reply?.references) ? (reply!.references as unknown[]).map(String) : [];
    const inReplyTo = reply?.messageId ? String(reply.messageId) : undefined;
    const mail = {
      from: acc.display_name ? { name: acc.display_name, address: acc.email } : acc.email,
      to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, subject,
      html: html || undefined, text: text || undefined,
      inReplyTo, references: inReplyTo ? [...refs, inReplyTo].slice(-20) : undefined,
      attachments: atts.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      messageId: `<${randomUUID()}@${acc.email.split('@')[1]}>`,
      date: new Date(),
    };
    const raw: Buffer = await new Promise((resolve, reject) => new MailComposer(mail).compile().build((err: Error | null, msg: Buffer) => (err ? reject(err) : resolve(msg))));
    try {
      await transport(c).sendMail({ envelope: { from: acc.email, to: [...to, ...cc, ...bcc].map((x) => x.replace(/^.*<|>$/g, '')) }, raw });
    } catch (e) {
      throw new MailError(400, `Não foi enviado: ${friendly(e)}`);
    }
    // Cópia em "Enviados" (a Hostinger não guarda sozinha o que sai por SMTP).
    let savedTo: string | null = null;
    try {
      const sent = await findSpecial(client, '\\Sent');
      if (sent) { await client.append(sent, raw, ['\\Seen']); savedTo = sent; }
    } catch { /* enviado mesmo assim */ }
    // Marca o original como respondido.
    if (reply?.uid && reply?.folder) {
      try {
        const lock = await client.getMailboxLock(str(reply.folder, 300));
        try { await client.messageFlagsAdd(String(Math.floor(Number(reply.uid))), ['\\Answered'], { uid: true }); } finally { lock.release(); }
      } catch { /* tanto faz */ }
    }
    return { ok: true, sentCopy: savedTo };
  });
}

// ------------------------------------------------------------------ despacho
export async function mailAction(ctx: MailCtx, action: string, b: Record<string, unknown>) {
  if (!action.startsWith('mail_')) return null;
  // Usuário desativado (ou fora da org) não usa e-mail, mesmo com token ainda válido.
  const { data: me } = await db(ctx).from('app_users').select('status').eq('user_id', ctx.userId).eq('org_id', ctx.orgId).maybeSingle();
  if (!me || ((me as { status?: string }).status ?? 'active') !== 'active') throw new MailError(403, 'Seu acesso está desativado.');
  switch (action) {
    case 'mail_save_account': return saveAccount(ctx, b);
    case 'mail_delete_account': return deleteAccount(ctx, b);
    case 'mail_folders': return folders(ctx, b);
    case 'mail_list': return listMessages(ctx, b);
    case 'mail_get': return getMessage(ctx, b);
    case 'mail_attachment': return getAttachment(ctx, b);
    case 'mail_flags': return setFlags(ctx, b);
    case 'mail_move': return moveMessages(ctx, b);
    case 'mail_send': return sendMessage(ctx, b);
    default: return null;
  }
}
