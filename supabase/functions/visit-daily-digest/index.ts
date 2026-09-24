// ============================================================================
// visit-daily-digest  (cron target, a cada 15min via wh-visit-digest)
// ----------------------------------------------------------------------------
// Todo dia de manhã, avisa a EQUIPE (não o cliente) quais visitas estão
// marcadas para hoje. A notificação aparece no sininho do CRM.
//
// Diferente do visit-reminders, que manda WhatsApp PARA O CLIENTE. Aqui o
// destinatário é interno: é o "não deixe de olhar isso hoje".
//
// Igual ao visit-reminders, o cron bate a cada 15min e a função decide se é a
// hora certa (janela 07:00-08:30 em America/Rio_Branco). Dedup por dia via
// app_settings: guarda a última data enviada e não repete.
//
// Manda também quando NÃO há visitas? Não. Notificação diária de "nada hoje"
// vira ruído e treina a pessoa a ignorar o sininho — que é justamente onde
// aparecem os handoffs.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { getCredential, setCredential } from '../_shared/credentials.ts';

const TIMEZONE = 'America/Rio_Branco';
const WINDOW_START_MIN = 7 * 60;      // 07:00
const WINDOW_END_MIN = 8 * 60 + 30;   // 08:30
const DIGEST_KEY = 'visit_digest_last_date';
const ENABLED_KEY = 'visit_digest_enabled';

interface VisitRow {
  id: string;
  org_id: string;
  contact_id: string;
  visit_time: string;
  party_size: number;
  notes: string | null;
}

function nowInTz(): { dateStr: string; minutesOfDay: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    minutesOfDay: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const { dateStr, minutesOfDay } = nowInTz();
  if (minutesOfDay < WINDOW_START_MIN || minutesOfDay > WINDOW_END_MIN) {
    return jsonResponse({ ok: true, skipped: 'fora da janela 07:00-08:30' });
  }

  const admin = getAdminClient();

  const { data: visits, error } = await admin
    .from('park_visits')
    .select('id, org_id, contact_id, visit_time, party_size, notes')
    .eq('status', 'confirmed')
    .eq('visit_date', dateStr)
    .order('visit_time', { ascending: true })
    .limit(200);
  if (error) return jsonResponse({ ok: false, error: error.message }, { status: 500 });

  const rows = (visits ?? []) as VisitRow[];
  if (rows.length === 0) {
    return jsonResponse({ ok: true, sent: 0, motivo: 'sem visitas hoje' });
  }

  // Agrupa por org — cada uma recebe o resumo das suas visitas.
  const byOrg = new Map<string, VisitRow[]>();
  for (const v of rows) {
    if (!byOrg.has(v.org_id)) byOrg.set(v.org_id, []);
    byOrg.get(v.org_id)!.push(v);
  }

  const contactIds = [...new Set(rows.map((v) => v.contact_id))];
  const { data: contacts } = await admin
    .from('contacts')
    .select('id, name, phone')
    .in('id', contactIds);
  const contactById = new Map(
    ((contacts ?? []) as Array<{ id: string; name: string | null; phone: string | null }>)
      .map((c) => [c.id, c]),
  );

  let notified = 0;
  const errors: string[] = [];

  for (const [orgId, orgVisits] of byOrg) {
    try {
      if ((await getCredential(orgId, ENABLED_KEY)) === 'false') continue;
      // Dedup: já enviou hoje?
      if ((await getCredential(orgId, DIGEST_KEY)) === dateStr) continue;

      const linhas = orgVisits.map((v) => {
        const c = contactById.get(v.contact_id);
        const nome = (c?.name ?? '').trim();
        const temLetra = /\p{L}/u.test(nome);
        const quem = temLetra ? nome : (c?.phone ?? 'sem nome');
        const pessoas = v.party_size > 1 ? ` (${v.party_size} pessoas)` : '';
        return `${v.visit_time.slice(0, 5)} — ${quem}${pessoas}`;
      });

      const titulo = orgVisits.length === 1
        ? '1 visita agendada para hoje'
        : `${orgVisits.length} visitas agendadas para hoje`;
      const corpo = linhas.join('\n');

      // Notifica os membros da org que já aceitaram o convite (não existe
      // coluna is_active nesta tabela; accepted_at é o sinal de conta ativa).
      const { data: membros } = await admin
        .from('app_users')
        .select('user_id')
        .eq('org_id', orgId)
        .not('accepted_at', 'is', null);
      let userIds = ((membros ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);

      // Org sem membros próprios (operada por super admin em modo suporte):
      // avisa os super admins. Sem isso o resumo não chegaria a ninguém e o
      // operador ficaria sem saber das visitas do dia.
      if (userIds.length === 0) {
        const { data: supers } = await admin
          .from('app_users')
          .select('user_id')
          .eq('is_super_admin', true);
        userIds = ((supers ?? []) as Array<{ user_id: string }>).map((m) => m.user_id);
      }
      if (userIds.length === 0) {
        errors.push(`org ${orgId}: nenhum destinatário`);
        continue;
      }

      const { error: insErr } = await admin.from('notifications').insert(
        userIds.map((uid) => ({
          org_id: orgId,
          user_id: uid,
          type: 'mention',
          title: titulo,
          body: corpo,
        })),
      );
      if (insErr) {
        errors.push(`org ${orgId}: ${insErr.message}`);
        continue;
      }

      await setCredential(orgId, DIGEST_KEY, dateStr);
      notified += userIds.length;
    } catch (err) {
      errors.push(`org ${orgId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return jsonResponse({ ok: true, sent: notified, visitas: rows.length, errors });
});
