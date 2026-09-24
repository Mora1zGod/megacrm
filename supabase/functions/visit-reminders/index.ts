// ============================================================================
// visit-reminders  (cron target, a cada 15min via wh-visit-reminders)
// ----------------------------------------------------------------------------
// Manda um lembrete de WhatsApp pra quem tem visita CONFIRMADA marcada pra
// hoje, uma vez, só dentro da janela 07:00-08:30 (America/Rio_Branco). O cron
// bate a cada 15min o dia inteiro; é a função que decide se é a hora certa —
// assim não depende de matemática de fuso/horário de verão no pg_cron (que
// roda em UTC).
//
// Controlado por toggle em org_settings ('visit_reminder_enabled' — chave
// texto 'true'/'false' via getCredential/setCredential, mesmo mecanismo das
// credenciais; default HABILITADO quando a chave não existe).
//
// Dedup: reminded_at é setado logo após o envio — nunca manda duas vezes pra
// mesma visita, mesmo rodando a cada 15min.
//
// Nome no cumprimento: `contacts.name` às vezes vem igual ao telefone (contato
// criado sem pushname do WhatsApp — a origem disso é outra function, ainda não
// corrigida na fonte). isPhoneLike() blinda esse caso aqui: nunca cumprimenta
// a pessoa pelo número — sem nome de verdade, usa saudação genérica.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { getCredential } from '../_shared/credentials.ts';
import { sendVisitMessage } from '../_shared/visit-messaging.ts';

const TIMEZONE = 'America/Rio_Branco';
const WINDOW_START_MIN = 7 * 60; // 07:00
const WINDOW_END_MIN = 8 * 60 + 30; // 08:30

type Admin = ReturnType<typeof getAdminClient>;

interface VisitRow {
  id: string;
  org_id: string;
  contact_id: string;
  visit_date: string;
  visit_time: string;
  party_size: number;
}

function nowInTz(): { dateStr: string; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;
  const minutesOfDay = Number(get('hour')) * 60 + Number(get('minute'));
  return { dateStr, minutesOfDay };
}

function formatTime(t: string): string {
  return t.slice(0, 5);
}

// True quando `s` é, no fundo, um número de telefone (só dígitos depois de
// tirar espaço/parênteses/+/-/.) — nunca deve virar "nome" num cumprimento.
function isPhoneLike(s: string): boolean {
  const stripped = s.replace(/[\s()+\-.]/g, '');
  return stripped.length >= 8 && /^\d+$/.test(stripped);
}

// Primeiro nome de verdade, ou string vazia se não tiver nome confiável
// (vazio, ou o próprio telefone disfarçado de nome).
function safeFirstName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || isPhoneLike(trimmed)) return '';
  const first = trimmed.split(/\s+/)[0];
  return isPhoneLike(first) ? '' : first;
}

async function sendReminder(admin: Admin, visit: VisitRow, phone: string, name: string): Promise<void> {
  const firstName = safeFirstName(name);
  const saudacao = firstName ? `Bom dia, ${firstName}! ☀️` : 'Bom dia! ☀️';
  const text =
    `${saudacao}\n\n` +
    `Passando pra lembrar que sua visita ao AMAI Park é HOJE, às ${formatTime(visit.visit_time)}` +
    (visit.party_size > 1 ? ` (${visit.party_size} pessoas)` : '') +
    `.\n\nQualquer imprevisto, só responder aqui. Te esperamos! 🌴`;

  await sendVisitMessage(admin, { orgId: visit.org_id, contactId: visit.contact_id, phone }, text);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const { minutesOfDay, dateStr } = nowInTz();
  if (minutesOfDay < WINDOW_START_MIN || minutesOfDay > WINDOW_END_MIN) {
    return jsonResponse({ ok: true, skipped: 'fora da janela 07:00-08:30', now: dateStr });
  }

  const admin = getAdminClient();

  const { data: visits, error } = await admin
    .from('park_visits')
    .select('id, org_id, contact_id, visit_date, visit_time, party_size')
    .eq('status', 'confirmed')
    .eq('visit_date', dateStr)
    .is('reminded_at', null)
    .limit(300);
  if (error) return jsonResponse({ ok: false, error: error.message }, { status: 500 });

  const rows = (visits ?? []) as VisitRow[];
  if (rows.length === 0) return jsonResponse({ ok: true, sent: 0, visits: 0 });

  const orgIds = [...new Set(rows.map((v) => v.org_id))];
  const enabledByOrg = new Map<string, boolean>();
  for (const orgId of orgIds) {
    const val = await getCredential(orgId, 'visit_reminder_enabled');
    enabledByOrg.set(orgId, val !== 'false'); // default habilitado
  }

  const contactIds = [...new Set(rows.map((v) => v.contact_id))];
  const { data: contacts } = await admin.from('contacts').select('id, phone, name').in('id', contactIds);
  const contactById = new Map(((contacts ?? []) as Array<{ id: string; phone: string | null; name: string | null }>).map((c) => [c.id, c]));

  let sent = 0;
  const errors: string[] = [];
  for (const visit of rows) {
    if (!enabledByOrg.get(visit.org_id)) continue;
    const contact = contactById.get(visit.contact_id);
    if (!contact?.phone) {
      errors.push(`visita ${visit.id}: contato sem telefone`);
      continue;
    }
    try {
      await sendReminder(admin, visit, contact.phone, contact.name ?? '');
      await admin.from('park_visits').update({ reminded_at: new Date().toISOString() }).eq('id', visit.id);
      sent++;
    } catch (err) {
      errors.push(`visita ${visit.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jsonResponse({ ok: true, sent, visits: rows.length, errors });
});
