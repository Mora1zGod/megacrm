// ============================================================================
// send-birthday-messages  (cron target, diário)
// ----------------------------------------------------------------------------
// Consome contacts.birthday_date e dispara o template de aniversário via
// Zernio para cada contato que faz aniversário hoje (ou em N dias, conforme
// birthday_config.send_days_before). Espelha a estrutura de
// repurchase-dispatch/index.ts (mesmos guardrails, mesma forma de envio).
//
// GUARDRAILS (ordem de curto-circuito):
//   1. Kill-switch: birthday_config.auto_send = false → NADA é enviado.
//   2. Template não configurado → nada é enviado.
//   3. Horário comercial (app_settings.business_hours, America/Sao_Paulo):
//      fora da janela do dia → o run inteiro é adiado para o próximo tick.
//   4. Mês/dia de aniversário batendo com hoje + send_days_before.
//   5. Idempotência por ano: last_birthday_sent_year != ano atual.
//   6. Telefone validado em E.164 antes de qualquer chamada externa.
//   7. Auditoria: cada envio (e cada skip por telefone inválido) vira uma
//      linha em crm_ai_actions com template, variáveis e message id.
//
// Template esperado (Meta, aprovado): "Feliz aniversário, {{1}}! 🎉 A equipe
// deseja um dia incrível."
//   {{1}} = nome do contato
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import {
  ZernioError,
  createInboxConversation,
  sendInboxTemplate,
  type ZernioContext,
} from '../_shared/zernio.ts';
import { loadOrgZernioContext } from '../_shared/channels.ts';

const BATCH_LIMIT = 200;
const E164 = /^\+\d{10,15}$/;
const TZ = 'America/Sao_Paulo';

interface BirthdayConfig {
  auto_send: boolean;
  send_days_before: number;
  template_name: string | null;
  template_language: string;
}

interface BirthdayContact {
  id: string;
  name: string | null;
  phone: string | null;
  last_birthday_sent_year: number | null;
}

type Admin = ReturnType<typeof getAdminClient>;

// business_hours: { mon: {start:'08:00', end:'18:00'}, ... }. Ausente ou
// malformado → permite (o kill-switch é a proteção mestre; isto é refinamento).
function withinBusinessHours(businessHours: unknown): boolean {
  if (!businessHours || typeof businessHours !== 'object') return true;
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  const dayKey = String(parts.weekday ?? '').toLowerCase().slice(0, 3); // mon, tue…
  const window = (businessHours as Record<string, unknown>)[dayKey];
  if (!window || typeof window !== 'object') return false; // dia sem janela = não envia
  const { start, end } = window as { start?: string; end?: string };
  if (!start || !end) return false;
  const hhmm = `${parts.hour}:${parts.minute}`;
  return hhmm >= start && hhmm <= end;
}

// "Hoje" na TZ do negócio, deslocado por send_days_before dias — devolve
// {year, month, day} já considerando o alvo (aniversário daqui a N dias).
function targetDateParts(sendDaysBefore: number): { year: number; month: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const now = new Date(Date.now() + sendDaysBefore * 86400 * 1000);
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

async function findOrCreateConversation(admin: Admin, orgId: string, contactId: string): Promise<{ id: string; zernio: string | null } | null> {
  const { data: existing } = await admin
    .from('conversations')
    .select('id, zernio_conversation_id')
    .eq('org_id', orgId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) {
    const row = existing as { id: string; zernio_conversation_id: string | null };
    return { id: row.id, zernio: row.zernio_conversation_id };
  }
  const { data: created, error } = await admin
    .from('conversations')
    .insert({ org_id: orgId, contact_id: contactId, status: 'ai_active', last_message_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) return null;
  return { id: (created as { id: string }).id, zernio: null };
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

  // Multi-org: processa cada org ATIVA que tenha config de aniversário. Cada
  // org tem seu próprio kill-switch, template, horário comercial e contexto
  // Zernio. Uma org que pula (kill-switch/template/horário) não afeta as demais.
  const { data: orgRows, error: orgErr } = await admin
    .from('organizations')
    .select('id')
    .eq('status', 'active');
  if (orgErr) return jsonResponse({ ok: false, error: orgErr.message }, { status: 500 });
  const orgIds = ((orgRows ?? []) as Array<{ id: string }>).map((o) => o.id);

  const results: Array<Record<string, unknown>> = [];
  let grandSent = 0;

  for (const orgId of orgIds) {
    const res = await processOrg(admin, orgId);
    grandSent += res.sent;
    if (res.skipped || res.sent > 0 || res.errors.length > 0) {
      results.push({ org_id: orgId, ...res });
    }
  }

  return jsonResponse({ ok: true, orgs: orgIds.length, sent: grandSent, results });
});

// Executa um run de aniversário para UMA org. Toda credencial/query é
// escopada a esse org; retorna o resumo do run.
async function processOrg(
  admin: Admin,
  orgId: string,
): Promise<{ sent: number; skipped_phone: number; queue: number; errors: string[]; skipped?: string }> {
  const empty = { sent: 0, skipped_phone: 0, queue: 0, errors: [] as string[] };

  // -- Guardrail 1: kill-switch ----------------------------------------------
  const { data: cfgRow, error: cfgErr } = await admin
    .from('birthday_config')
    .select('auto_send, send_days_before, template_name, template_language')
    .eq('org_id', orgId)
    .maybeSingle();
  if (cfgErr) return { ...empty, errors: [cfgErr.message] };
  const cfg = (cfgRow ?? null) as BirthdayConfig | null;
  if (!cfg || !cfg.auto_send) return { ...empty, skipped: 'kill_switch_off' };

  // -- Guardrail 2: template configurado -------------------------------------
  const templateName = cfg.template_name?.trim();
  if (!templateName) return { ...empty, skipped: 'template_not_configured' };

  // -- Guardrail 3: horário comercial ----------------------------------------
  const { data: settings } = await admin
    .from('app_settings')
    .select('business_hours')
    .eq('org_id', orgId)
    .maybeSingle();
  if (!withinBusinessHours((settings as { business_hours?: unknown } | null)?.business_hours)) {
    return { ...empty, skipped: 'outside_business_hours' };
  }

  // -- Guardrail 4+5: aniversariantes de hoje (+N dias), ainda não enviados
  //    este ano ---------------------------------------------------------------
  const { year, month, day } = targetDateParts(cfg.send_days_before || 0);

  const { data: due, error: dueErr } = await admin
    .from('contacts')
    .select('id, name, phone, last_birthday_sent_year')
    .eq('org_id', orgId)
    .eq('birthday_month', month)
    .eq('birthday_day', day)
    .or(`last_birthday_sent_year.is.null,last_birthday_sent_year.lt.${year}`)
    .limit(BATCH_LIMIT);
  if (dueErr) return { ...empty, errors: [dueErr.message] };

  const queue = (due ?? []) as BirthdayContact[];
  if (queue.length === 0) return empty;

  let ctx: ZernioContext;
  try {
    ctx = await loadOrgZernioContext(admin, orgId);
  } catch (err) {
    return { ...empty, queue: queue.length, errors: [err instanceof Error ? err.message : 'ctx'] };
  }
  let sent = 0;
  let skippedPhone = 0;
  const errors: string[] = [];

  for (const c of queue) {
    // -- Guardrail 6: E.164 ---------------------------------------------------
    const phone = c.phone?.trim() ?? '';
    if (!E164.test(phone)) {
      skippedPhone++;
      await admin.from('crm_ai_actions').insert({
        org_id: orgId,
        contact_id: c.id,
        action_type: 'birthday_skip',
        description: `Aniversário NÃO disparado: telefone inválido (${phone || 'vazio'})`,
        payload: { contact_id: c.id },
      });
      continue;
    }

    try {
      const customerName = c.name?.trim() || 'cliente';
      const components = [{
        type: 'body',
        parameters: [{ type: 'text', text: customerName }],
      }];

      const conv = await findOrCreateConversation(admin, orgId, c.id);
      if (!conv) {
        errors.push(`${c.id}: conversa falhou`);
        continue;
      }

      let zConvId = conv.zernio;
      if (!zConvId) {
        const created = await createInboxConversation({
          apiKey: ctx.apiKey, accountId: ctx.accountId, participantId: phone,
        });
        zConvId = created.conversationId;
        if (zConvId) {
          await admin.from('conversations').update({ zernio_conversation_id: zConvId }).eq('id', conv.id);
        }
      }
      if (!zConvId) {
        errors.push(`${c.id}: Zernio não retornou conversationId`);
        continue;
      }

      const result = await sendInboxTemplate({
        apiKey: ctx.apiKey, accountId: ctx.accountId, conversationId: zConvId,
        name: templateName, language: cfg.template_language || 'pt_BR', components,
      });

      const preview = `Feliz aniversário, ${customerName}! 🎉`;
      await admin.from('messages').insert({
        org_id: orgId,
        conversation_id: conv.id, direction: 'outbound', sender_type: 'system',
        content_type: 'template', content: preview,
        zernio_message_id: result.messageId, meta_status: 'sent', is_private_note: false,
      });
      await admin.from('conversations').update({ last_message_at: new Date().toISOString() }).eq('id', conv.id);

      await admin.from('contacts').update({ last_birthday_sent_year: year }).eq('id', c.id);

      // -- Guardrail 7: auditoria --------------------------------------------
      await admin.from('crm_ai_actions').insert({
        org_id: orgId,
        contact_id: c.id,
        action_type: 'birthday_sent',
        description: `Template de aniversário "${templateName}" enviado`,
        payload: {
          contact_id: c.id, template: templateName, variables: [customerName],
          zernio_message_id: result.messageId, year,
        },
      });
      sent++;
    } catch (err) {
      const msg = err instanceof ZernioError ? err.message : err instanceof Error ? err.message : String(err);
      errors.push(`${c.id}: ${msg}`);
    }
  }

  return { sent, skipped_phone: skippedPhone, queue: queue.length, errors };
}
