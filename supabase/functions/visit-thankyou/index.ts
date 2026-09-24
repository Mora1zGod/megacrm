// ============================================================================
// visit-thankyou  (cron target, a cada 15min via wh-visit-thankyou)
// ----------------------------------------------------------------------------
// Manda um agradecimento de WhatsApp ~3h depois do horário marcado de uma
// visita CONFIRMADA (ou já COMPLETED), uma vez, com dedup via thanked_at.
// Não depende de janela fixa de horário do dia — calcula visit_date+visit_time
// + 3h em America/Rio_Branco e compara com "agora"; funciona pra qualquer
// horário de visita, manhã ou tarde.
//
// Controlado por toggle em org_settings ('visit_thankyou_enabled' — mesmo
// mecanismo do visit-reminders; default HABILITADO quando a chave não existe).
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { getCredential } from '../_shared/credentials.ts';
import { sendVisitMessage } from '../_shared/visit-messaging.ts';

const TIMEZONE = 'America/Rio_Branco';
const THANKYOU_DELAY_HOURS = 3;

type Admin = ReturnType<typeof getAdminClient>;

interface VisitRow {
  id: string;
  org_id: string;
  contact_id: string;
  visit_date: string;
  visit_time: string;
  party_size: number;
}

// America/Rio_Branco é UTC-5 o ano inteiro (sem horário de verão desde 2019)
// — offset fixo é seguro aqui e evita depender de parsing de fuso em runtime.
const RIO_BRANCO_UTC_OFFSET_HOURS = -5;

function visitDateTimeUtc(v: VisitRow): Date {
  const iso = `${v.visit_date}T${v.visit_time}`;
  const local = new Date(iso);
  return new Date(local.getTime() - RIO_BRANCO_UTC_OFFSET_HOURS * 3600 * 1000);
}

async function sendThankYou(admin: Admin, visit: VisitRow, phone: string, name: string): Promise<void> {
  const firstName = (name || '').split(' ')[0];
  const text =
    `Oi${firstName ? `, ${firstName}` : ''}! 💚\n\n` +
    `Foi um prazer receber você hoje no AMAI Park! Esperamos que tenha curtido bastante.\n\n` +
    `Se puder, conta pra gente como foi a experiência — sua opinião ajuda muito. E volte sempre! 🌴`;

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

  const admin = getAdminClient();

  // Candidatos: confirmadas ou concluídas, sem agradecimento ainda, com data
  // de hoje ou de ontem (cobre visitas tardias sem varrer a tabela inteira).
  const todayRioBranco = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
  const yesterdayRioBranco = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(yesterday);

  const { data: visits, error } = await admin
    .from('park_visits')
    .select('id, org_id, contact_id, visit_date, visit_time, party_size')
    .in('status', ['confirmed', 'completed'])
    .in('visit_date', [todayRioBranco, yesterdayRioBranco])
    .is('thanked_at', null)
    .limit(300);
  if (error) return jsonResponse({ ok: false, error: error.message }, { status: 500 });

  const now = Date.now();
  const rows = ((visits ?? []) as VisitRow[]).filter(
    (v) => now - visitDateTimeUtc(v).getTime() >= THANKYOU_DELAY_HOURS * 3600 * 1000,
  );
  if (rows.length === 0) return jsonResponse({ ok: true, sent: 0, visits: 0 });

  const orgIds = [...new Set(rows.map((v) => v.org_id))];
  const enabledByOrg = new Map<string, boolean>();
  for (const orgId of orgIds) {
    const val = await getCredential(orgId, 'visit_thankyou_enabled');
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
      await sendThankYou(admin, visit, contact.phone, contact.name ?? '');
      await admin
        .from('park_visits')
        .update({ thanked_at: new Date().toISOString(), status: 'completed' })
        .eq('id', visit.id);
      sent++;
    } catch (err) {
      errors.push(`visita ${visit.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jsonResponse({ ok: true, sent, visits: rows.length, errors });
});
