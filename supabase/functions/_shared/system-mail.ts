// ============================================================================
// E-mail do SISTEMA (16/11/2026) — avisos automáticos saindo de uma caixa do domínio
// da empresa (AMAI: naoresponda@amaipark.com, Hostinger, smtp.hostinger.com:465 SSL).
//
// Credenciais em public.org_settings (cifradas, só service role):
//   system_smtp_user, system_smtp_pass, [system_smtp_host], [system_smtp_port], [system_smtp_from_name]
// Procura primeiro na org do aviso; sem nada lá, usa a da primeira org que tiver (uma caixa
// atende a instância inteira, como o e-mail do login). Sem nenhuma: não envia (só registra no log).
//
// Cliente SMTP próprio (TLS direto na 465, AUTH LOGIN) — sem biblioteca externa.
// Nunca derruba quem chamou: devolve { ok:false, error } e registra no log.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2.45.0';
import { decryptValue } from './credentials.ts';

export interface SystemMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

interface SmtpConf { host: string; port: number; user: string; pass: string; fromName: string }

let confCache: { orgId: string; conf: SmtpConf | null; at: number } | null = null;

async function loadConf(orgId: string | null): Promise<SmtpConf | null> {
  const key = orgId ?? '';
  if (confCache && confCache.orgId === key && Date.now() - confCache.at < 60_000) return confCache.conf;
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data } = await db.from('org_settings').select('org_id, key, value_encrypted').like('key', 'system_smtp_%');
  const rows = (data ?? []) as Array<{ org_id: string; key: string; value_encrypted: string }>;
  const owner = rows.some((r) => r.org_id === orgId && r.key === 'system_smtp_pass')
    ? orgId
    : rows.find((r) => r.key === 'system_smtp_pass')?.org_id;
  let conf: SmtpConf | null = null;
  if (owner) {
    const get = async (k: string) => {
      const r = rows.find((x) => x.org_id === owner && x.key === k);
      return r ? await decryptValue(r.value_encrypted) : null;
    };
    const [user, pass, host, port, fromName] = await Promise.all([
      get('system_smtp_user'), get('system_smtp_pass'), get('system_smtp_host'), get('system_smtp_port'), get('system_smtp_from_name'),
    ]);
    if (user && pass) conf = { user, pass, host: host || 'smtp.hostinger.com', port: Number(port) || 465, fromName: fromName || 'AMAI Park' };
  }
  confCache = { orgId: key, conf, at: Date.now() };
  return conf;
}

// ---------------------------------------------------------------- MIME
const enc = new TextEncoder();
const b64 = (s: string) => {
  const bytes = enc.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/(.{76})/g, '$1\r\n');
const encWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

export function buildMime(from: { name: string; email: string }, m: SystemMail, date = new Date()): string {
  const boundary = `b_${crypto.randomUUID().replace(/-/g, '')}`;
  const domain = from.email.split('@')[1] ?? 'localhost';
  const headers = [
    `From: ${encWord(from.name)} <${from.email}>`,
    `To: <${m.to}>`,
    `Subject: ${encWord(m.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const part = (type: string, body: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(body))}\r\n`;
  return `${headers.join('\r\n')}\r\n\r\n${part('text/plain', m.text)}${part('text/html', m.html)}--${boundary}--\r\n`;
}

// ---------------------------------------------------------------- SMTP
async function smtpSend(conf: SmtpConf, m: SystemMail, connect: (host: string, port: number) => Promise<Deno.Conn> =
  (hostname, port) => Deno.connectTls({ hostname, port })): Promise<void> {
  const conn = await connect(conf.host, conf.port);
  const dec = new TextDecoder();
  let buf = '';
  const readReply = async (): Promise<{ code: number; text: string }> => {
    const chunk = new Uint8Array(4096);
    for (;;) {
      const lines = buf.split('\r\n');
      // resposta completa = última linha "NNN texto" (sem hífen)
      for (let i = 0; i < lines.length - 1; i += 1) {
        if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
          const text = lines.slice(0, i + 1).join('\n');
          buf = lines.slice(i + 1).join('\r\n');
          return { code: Number(lines[i].slice(0, 3)), text };
        }
      }
      const n = await conn.read(chunk);
      if (n === null) throw new Error('SMTP: conexão fechada');
      buf += dec.decode(chunk.subarray(0, n));
    }
  };
  const write = async (s: string) => {
    const data = enc.encode(s);
    let off = 0;
    while (off < data.length) off += await conn.write(data.subarray(off));
  };
  const cmd = async (line: string, ok: number[], hide = false) => {
    await write(`${line}\r\n`);
    const r = await readReply();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${hide ? '(credencial)' : line.split(' ')[0]}: ${r.text}`);
    return r;
  };
  const timer = setTimeout(() => { try { conn.close(); } catch { /* */ } }, 20_000);
  try {
    const hello = await readReply();
    if (hello.code !== 220) throw new Error(`SMTP: ${hello.text}`);
    await cmd(`EHLO ${conf.user.split('@')[1] ?? 'localhost'}`, [250]);
    await cmd('AUTH LOGIN', [334]);
    await cmd(b64(conf.user), [334], true);
    await cmd(b64(conf.pass), [235], true);
    await cmd(`MAIL FROM:<${conf.user}>`, [250]);
    await cmd(`RCPT TO:<${m.to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const body = buildMime({ name: conf.fromName, email: conf.user }, m).replace(/\r\n\./g, '\r\n..');
    await cmd(`${body}\r\n.`, [250]);
    try { await cmd('QUIT', [221]); } catch { /* tanto faz */ }
  } finally {
    clearTimeout(timer);
    try { conn.close(); } catch { /* já fechada */ }
  }
}

export async function sendSystemMail(orgId: string | null, m: SystemMail): Promise<{ ok: boolean; error?: string }> {
  try {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(m.to)) return { ok: false, error: 'destinatário inválido' };
    const conf = await loadConf(orgId);
    if (!conf) {
      console.warn(JSON.stringify({ event: 'system_mail_not_configured', subject: m.subject }));
      return { ok: false, error: 'e-mail do sistema não configurado' };
    }
    await smtpSend(conf, m);
    console.log(JSON.stringify({ event: 'system_mail_sent', subject: m.subject }));
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: 'system_mail_failed', subject: m.subject, error }));
    return { ok: false, error };
  }
}

// Só para teste local (cliente falso / servidor de teste).
export const __test = { smtpSend };

// ---------------------------------------------------------------- modelo visual
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// E-mail com a cara da AMAI: logo, título, parágrafos, botão opcional e rodapé "não responda".
// `paragraphs` são texto puro (escapados aqui); **negrito** vira <strong>.
export function brandMail(opts: {
  orgName: string; logoUrl?: string | null; title: string; paragraphs: string[];
  button?: { label: string; url: string }; footer?: string;
}): { html: string; text: string } {
  const bold = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#0F1B2E">$1</strong>');
  const logo = opts.logoUrl
    ? `<img src="${esc(opts.logoUrl)}" alt="${esc(opts.orgName)}" height="56" style="display:block;margin:0 auto;height:56px;width:auto;border:0">`
    : `<div style="font:800 22px Arial,sans-serif;color:#0B3FA8;text-align:center">${esc(opts.orgName)}</div>`;
  const btn = opts.button
    ? `<tr><td align="center" style="padding:8px 32px 28px"><a href="${esc(opts.button.url)}" style="display:inline-block;background:#0B3FA8;color:#ffffff;text-decoration:none;font:700 16px Arial,sans-serif;padding:14px 28px;border-radius:12px">${esc(opts.button.label)}</a></td></tr>
<tr><td style="padding:0 32px 24px;font:13px/1.5 Arial,sans-serif;color:#5B687D">Se o botão não abrir, copie e cole no navegador:<br><a href="${esc(opts.button.url)}" style="color:#1D4ED8;word-break:break-all">${esc(opts.button.url)}</a></td></tr>`
    : '';
  const footer = opts.footer ?? `Este é um e-mail automático da ${opts.orgName}. Por favor, não responda.`;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(opts.title)}</title></head>
<body style="margin:0;padding:0;background:#EEF4FC">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF4FC"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 28px rgba(11,63,168,.12)">
<tr><td style="height:6px;background:linear-gradient(90deg,#0B3FA8,#1D4ED8 60%,#22C55E);font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px">${logo}</td></tr>
<tr><td style="padding:12px 32px 4px;font:800 22px/1.3 Arial,sans-serif;color:#0F1B2E;text-align:center">${esc(opts.title)}</td></tr>
${opts.paragraphs.map((p) => `<tr><td style="padding:10px 32px;font:16px/1.6 Arial,sans-serif;color:#334155">${bold(p)}</td></tr>`).join('\n')}
<tr><td style="height:10px"></td></tr>
${btn}
<tr><td style="padding:18px 32px;background:#F6F8FB;font:12px/1.5 Arial,sans-serif;color:#7A879C;text-align:center">${esc(footer)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [opts.title, '', ...opts.paragraphs.map((p) => p.replace(/\*\*/g, '')), ...(opts.button ? ['', `${opts.button.label}: ${opts.button.url}`] : []), '', footer].join('\n');
  return { html, text };
}
