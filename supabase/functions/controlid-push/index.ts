// ============================================================================
// controlid-push  (PÚBLICA — deploy com --no-verify-jwt)
// ----------------------------------------------------------------------------
// Ponto: o iDFace (Control iD, Access API) em modo PUSH chama este endereço pela internet — nada de abrir
// porta no parque. Configuração no aparelho (Ponto → Aparelhos mostra o comando pronto):
//   push_remote_address = https://<projeto>.supabase.co/functions/v1/controlid-push/<push_token>
//   push_request_period = 30 (segundos)
// Fluxo da Access API:
//   GET  …/push?deviceId=<serial>&uuid=<id>   → respondemos 1 comando {verb, endpoint, body, contentType,
//                                               queryString} ou corpo vazio (nada a fazer)
//   POST …/result?deviceId=<serial>           → {uuid, endpoint, response | error} — resultado do comando
// O que mandamos, nesta ordem:
//   1. buscar batidas novas (load_objects access_logs com id > último recebido) se a última busca tem 30 s+;
//   2. a fila ponto_device_cmds (cadastro de funcionários em lote, fotos em lote de 4, exclusões, acertar hora);
//   3. senão, corpo vazio.
// Batida = access_logs com event 7 (acesso liberado) e user_id > 0 → ponto_register_mark (NSR + SHA-256,
// imutável). Todo log recebido fica em ponto_device_logs (diagnóstico: não identificado, negado…).
// ASSUMIDO (confirmar no 1º teste com o aparelho): caminho do endereço com o token no fim; filtro "where"
// do load_objects; fuso do campo time (decidimos por lote: UTC ou hora local, o que der mais perto de agora).
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';

type Device = {
  id: string;
  org_id: string;
  company_id: string;
  name: string;
  timezone: string;
  device_serial: string | null;
  last_log_id: number;
  last_logs_poll_at: string | null;
  is_active: boolean;
};

type Cmd = {
  id: number;
  kind: string;
  employee_id: string | null;
  verb: string;
  endpoint: string;
  body: Record<string, unknown> | null;
  query_string: string | null;
  content_type: string;
  status: string;
  attempts: number;
};

const TOKEN_RE = /^[0-9a-f]{48}$/;
const LOGS_EVERY_MS = 30_000;
const SENT_RETRY_MS = 3 * 60_000; // comando entregue sem resultado → manda de novo
const MAX_ATTEMPTS = 5;
const PHOTOS_PER_CMD = 4; // ~4 fotos de até 1 MB em base64 por pedido

const empty = () => new Response(null, { status: 200 });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ fn: 'controlid-push', event, ...data }));

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** Diferença (ms) entre a hora local do fuso e UTC num instante — Rio Branco = -5 h. */
function tzOffsetMs(tz: string, at: Date): number {
  try {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    return asUtc - Math.floor(at.getTime() / 1000) * 1000;
  } catch {
    return -5 * 3600_000;
  }
}

function localParts(tz: string, at: Date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { day: g('day'), month: g('month'), year: g('year'), hour: g('hour'), minute: g('minute'), second: g('second') };
}

/** Resposta do aparelho pode vir como objeto ou como texto JSON. */
function parseResponse(r: unknown): Record<string, unknown> | null {
  if (r && typeof r === 'object') return r as Record<string, unknown>;
  if (typeof r === 'string' && r.trim()) {
    try { return JSON.parse(r); } catch { return null; }
  }
  return null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // …/controlid-push/<token>/push  ou  …/controlid-push/<token>/result
  const parts = url.pathname.split('/').filter(Boolean);
  const i = parts.indexOf('controlid-push');
  const token = (i >= 0 ? parts[i + 1] : '') || url.searchParams.get('t') || '';
  const action = (i >= 0 ? parts[i + 2] : '') || '';
  if (!TOKEN_RE.test(token)) return new Response('not found', { status: 404 });

  const db = getAdminClient();
  const { data: dev } = await db.from('ponto_devices')
    .select('id, org_id, company_id, name, timezone, device_serial, last_log_id, last_logs_poll_at, is_active')
    .eq('push_token', token).maybeSingle();
  const d = dev as Device | null;
  if (!d || !d.is_active) return new Response('not found', { status: 404 });

  const serial = url.searchParams.get('deviceId');
  const touch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
  if (serial && serial !== d.device_serial) touch.device_serial = serial;

  try {
    if (req.method === 'GET' && (action === 'push' || action === '')) {
      const uuid = url.searchParams.get('uuid') ?? crypto.randomUUID();
      const out = await nextCommand(db, d, uuid, touch);
      await db.from('ponto_devices').update(touch).eq('id', d.id);
      return out ? json(out) : empty();
    }
    if (req.method === 'POST' && action === 'result') {
      let body: { uuid?: string; endpoint?: string; response?: unknown; error?: unknown } = {};
      try { body = await req.json(); } catch { /* corpo vazio */ }
      await handleResult(db, d, body, touch);
      await db.from('ponto_devices').update(touch).eq('id', d.id);
      return empty();
    }
    return new Response('not found', { status: 404 });
  } catch (err) {
    log('error', { device: d.id, action, message: err instanceof Error ? err.message : String(err) });
    // 200 vazio: o aparelho só tenta de novo na próxima consulta.
    return empty();
  }
});

// --------------------------------------------------------------------------- envio de comandos
// deno-lint-ignore no-explicit-any
async function nextCommand(db: any, d: Device, uuid: string, touch: Record<string, unknown>) {
  const now = Date.now();

  // 1) Batidas novas — a cada 30 s no máximo (o resto do tempo a fila anda).
  const lastPoll = d.last_logs_poll_at ? Date.parse(d.last_logs_poll_at) : 0;
  if (now - lastPoll >= LOGS_EVERY_MS) {
    touch.last_logs_poll_at = new Date(now).toISOString();
    await db.from('ponto_device_cmds').insert({
      org_id: d.org_id, device_id: d.id, kind: 'load_logs', endpoint: 'load_objects', status: 'sent',
      uuid, sent_at: new Date(now).toISOString(), attempts: 1,
      body: { object: 'access_logs', where: { access_logs: { id: { '>': d.last_log_id } } } },
    });
    return {
      verb: 'POST', endpoint: 'load_objects', contentType: 'application/json',
      body: { object: 'access_logs', where: { access_logs: { id: { '>': d.last_log_id } } } },
    };
  }

  // linhas de controle de busca de batidas que nunca tiveram resposta
  await db.from('ponto_device_cmds').delete().eq('device_id', d.id).eq('kind', 'load_logs')
    .lt('sent_at', new Date(now - 10 * 60_000).toISOString());

  // 2) Fila. Entregue há 3 min sem resultado volta para pendente (até 5 tentativas).
  await db.from('ponto_device_cmds').update({ status: 'pending' })
    .eq('device_id', d.id).eq('status', 'sent').neq('kind', 'load_logs')
    .lt('sent_at', new Date(now - SENT_RETRY_MS).toISOString()).lt('attempts', MAX_ATTEMPTS);
  await db.from('ponto_device_cmds').update({ status: 'error', error: 'aparelho não respondeu' })
    .eq('device_id', d.id).eq('status', 'sent').neq('kind', 'load_logs')
    .lt('sent_at', new Date(now - SENT_RETRY_MS).toISOString()).gte('attempts', MAX_ATTEMPTS);

  const { data: firstRows } = await db.from('ponto_device_cmds')
    .select('id, kind, employee_id, verb, endpoint, body, query_string, content_type, status, attempts')
    .eq('device_id', d.id).eq('status', 'pending').order('id').limit(1);
  const first = (firstRows ?? [])[0] as Cmd | undefined;
  if (!first) return null;

  // Comandos do mesmo tipo em sequência vão juntos num pedido só.
  let batch: Cmd[] = [first];
  if (first.kind === 'user_upsert' || first.kind === 'user_photo') {
    const { data: more } = await db.from('ponto_device_cmds')
      .select('id, kind, employee_id, verb, endpoint, body, query_string, content_type, status, attempts')
      .eq('device_id', d.id).eq('status', 'pending').order('id').limit(first.kind === 'user_photo' ? PHOTOS_PER_CMD : 50);
    batch = [];
    for (const c of (more ?? []) as Cmd[]) {
      if (c.kind !== first.kind) break; // mantém a ordem da fila
      batch.push(c);
    }
  }

  let out: Record<string, unknown> | null = null;
  const failed: { id: number; error: string }[] = [];

  if (first.kind === 'user_upsert') {
    // último pedido de cada funcionário vence
    const byUser = new Map<number, unknown>();
    for (const c of batch) {
      for (const v of ((c.body?.values as Record<string, unknown>[]) ?? [])) byUser.set(Number(v.id), v);
    }
    out = { verb: 'POST', endpoint: 'create_or_modify_objects', contentType: 'application/json',
            body: { object: 'users', values: [...byUser.values()] } };
  } else if (first.kind === 'user_photo') {
    const images: { user_id: number; image: string }[] = [];
    for (const c of batch) {
      const userId = Number(String(c.query_string ?? '').replace('user_id=', ''));
      const { data: emp } = await db.from('ponto_employees').select('photo_path').eq('id', c.employee_id).maybeSingle();
      const path = (emp as { photo_path: string | null } | null)?.photo_path;
      if (!path || !userId) { failed.push({ id: c.id, error: 'funcionário sem foto' }); continue; }
      const { data: file, error } = await db.storage.from('whatsapp-hub-ponto').download(path);
      if (error || !file) { failed.push({ id: c.id, error: 'foto não encontrada no armazenamento' }); continue; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > 1_000_000) { failed.push({ id: c.id, error: 'foto maior que 1 MB' }); continue; }
      images.push({ user_id: userId, image: bytesToBase64(bytes) });
    }
    if (images.length) {
      out = { verb: 'POST', endpoint: 'user_set_image_list', contentType: 'application/json', body: { user_images: images } };
    }
  } else if (first.kind === 'set_time') {
    out = { verb: 'POST', endpoint: 'set_system_time', contentType: 'application/json', body: localParts(d.timezone, new Date()) };
  } else {
    out = { verb: first.verb || 'POST', endpoint: first.endpoint, contentType: first.content_type || 'application/json',
            body: first.body ?? {}, ...(first.query_string ? { queryString: first.query_string } : {}) };
  }

  for (const f of failed) {
    await db.from('ponto_device_cmds').update({ status: 'error', error: f.error, done_at: new Date().toISOString() }).eq('id', f.id);
  }
  const sentIds = batch.map((c) => c.id).filter((id) => !failed.some((f) => f.id === id));
  if (!out || !sentIds.length) return null;
  for (const c of batch.filter((b) => sentIds.includes(b.id))) {
    await db.from('ponto_device_cmds').update({
      status: 'sent', uuid, sent_at: new Date().toISOString(), attempts: c.attempts + 1,
    }).eq('id', c.id);
  }
  log('cmd_sent', { device: d.id, kind: first.kind, count: sentIds.length });
  return out;
}

// --------------------------------------------------------------------------- resultados
// deno-lint-ignore no-explicit-any
async function handleResult(db: any, d: Device, body: { uuid?: string; endpoint?: string; response?: unknown; error?: unknown }, touch: Record<string, unknown>) {
  const uuid = String(body.uuid ?? '');
  if (!uuid) return;
  const { data: rows } = await db.from('ponto_device_cmds')
    .select('id, kind, employee_id, body')
    .eq('device_id', d.id).eq('uuid', uuid).eq('status', 'sent');
  const cmds = (rows ?? []) as { id: number; kind: string; employee_id: string | null; body: Record<string, unknown> | null }[];
  if (!cmds.length) return;

  const errText = body.error ? (typeof body.error === 'string' ? body.error : JSON.stringify(body.error)).slice(0, 500) : null;
  const resp = parseResponse(body.response);
  const done = new Date().toISOString();

  if (cmds[0].kind === 'load_logs') {
    if (errText) {
      log('logs_error', { device: d.id, error: errText });
      await db.from('ponto_device_cmds').update({ status: 'error', error: errText, done_at: done }).in('id', cmds.map((c) => c.id));
      return;
    }
    const logs = ((resp?.access_logs as Record<string, unknown>[]) ?? [])
      .filter((l) => Number(l.id) > d.last_log_id)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const n = await ingestLogs(db, d, logs);
    if (logs.length) touch.last_log_id = Number(logs[logs.length - 1].id);
    // a linha de controle da busca não precisa ficar: só serve para casar o uuid
    await db.from('ponto_device_cmds').delete().in('id', cmds.map((c) => c.id));
    if (logs.length) log('logs_ingested', { device: d.id, logs: logs.length, marks: n });
    return;
  }

  if (errText) {
    await db.from('ponto_device_cmds').update({ status: 'error', error: errText, result: resp, done_at: done }).in('id', cmds.map((c) => c.id));
    log('cmd_error', { device: d.id, kind: cmds[0].kind, error: errText });
    return;
  }
  await db.from('ponto_device_cmds').update({ status: 'done', result: resp, done_at: done }).in('id', cmds.map((c) => c.id));

  if (cmds[0].kind === 'user_photo') {
    const ids = cmds.map((c) => c.employee_id).filter(Boolean);
    if (ids.length) await db.from('ponto_employees').update({ photo_synced_at: done }).in('id', ids);
  } else if (cmds[0].kind === 'set_time') {
    const actor = (cmds[0].body?.requested_by as string | undefined) ?? null;
    await db.rpc('ponto_log_clock', { p_device: d.id, p_before: null, p_after: done, p_actor: actor });
  }
}

// deno-lint-ignore no-explicit-any
async function ingestLogs(db: any, d: Device, logs: Record<string, unknown>[]): Promise<number> {
  if (!logs.length) return 0;
  const now = Date.now();
  // Fuso do campo time: o aparelho pode gravar a hora local como se fosse UTC. Escolhe, pelo log mais
  // recente do lote, a leitura que fica mais perto de agora.
  const newest = Number(logs[logs.length - 1].time ?? 0) * 1000;
  const off = tzOffsetMs(d.timezone, new Date(now));
  const shift = Math.abs(newest - now) <= Math.abs(newest - off - now) ? 0 : -off;

  let marks = 0;
  for (const l of logs) {
    const raw = Number(l.time ?? 0);
    const markedAt = raw ? new Date(raw * 1000 + shift) : null;
    const event = Number(l.event ?? 0);
    const userId = Number(l.user_id ?? 0);
    let markId: string | null = null;
    let note: string | null = null;
    if (event === 7 && userId > 0 && markedAt) {
      // "online" = chegou logo (até 5 min); batida guardada no aparelho sem internet vira offline
      const online = now - markedAt.getTime() <= 5 * 60_000;
      const { data, error } = await db.rpc('ponto_register_mark', {
        p_device: d.id, p_device_log_id: Number(l.id), p_device_user_id: userId,
        p_marked_at: markedAt.toISOString(), p_online: online,
      });
      if (error) note = error.message.slice(0, 200);
      else if (!data) note = 'pessoa do aparelho sem cadastro no CRM';
      else { markId = data as string; marks++; }
    }
    await db.from('ponto_device_logs').upsert({
      org_id: d.org_id, device_id: d.id, device_log_id: Number(l.id), event, device_user_id: userId || null,
      raw_time: raw || null, marked_at: markedAt?.toISOString() ?? null, mark_id: markId, note,
    }, { onConflict: 'device_id,device_log_id', ignoreDuplicates: true });
  }
  return marks;
}
