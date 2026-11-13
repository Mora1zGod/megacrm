// ============================================================================
// monitor-alerts  (pg_cron 'monitor-alerts-15min', service role)
// ----------------------------------------------------------------------------
// Para cada org ativa com alertas ligados: monitor_check(org) diz o que está errado (falhas de envio,
// mensagens presas em "enviado", clientes esperando, nenhuma mensagem chegando, gasto do WhatsApp perto do
// limite). Cada tipo de alerta sai no máx. 1 vez a cada 2 h (monitor_alert_log), pelo número UAZAPI de
// Notificações WhatsApp, para os destinatários com o assunto "monitoramento". Nunca escreve no Atendimento.
// ============================================================================
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { requireServiceRole } from '../_shared/auth.ts';
import { uazapiContextFromChannel, uazapiSendText } from '../_shared/uazapi.ts';

const REPEAT_MS = 2 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    await requireServiceRole(req);
  } catch {
    return jsonResponse({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const admin = getAdminClient();
  const { data: orgs } = await admin.from('organizations').select('id, name').eq('status', 'active');
  const results: Array<Record<string, unknown>> = [];

  for (const org of (orgs ?? []) as Array<{ id: string; name: string }>) {
    try {
      const { data: recs } = await admin.from('wa_notify_recipients').select('phone')
        .eq('org_id', org.id).eq('is_active', true).contains('topics', ['monitoramento']);
      const recipients = (recs ?? []) as Array<{ phone: string }>;
      if (!recipients.length) continue;

      const { data: check, error: chkErr } = await admin.rpc('monitor_check', { p_org: org.id });
      if (chkErr) throw chkErr;
      const c = check as { enabled: boolean; alertas: Array<{ kind: string; texto: string }> } | null;
      if (!c?.enabled || !c.alertas?.length) { results.push({ org: org.id, alerts: 0 }); continue; }

      // Tira o que já foi avisado nas últimas 2 h.
      const since = new Date(Date.now() - REPEAT_MS).toISOString();
      const { data: recent } = await admin.from('monitor_alert_log').select('kind')
        .eq('org_id', org.id).gte('sent_at', since);
      const already = new Set(((recent ?? []) as Array<{ kind: string }>).map((r) => r.kind));
      const fresh = c.alertas.filter((a) => !already.has(a.kind));
      if (!fresh.length) { results.push({ org: org.id, alerts: 0, repeated: c.alertas.length }); continue; }

      const { data: cfg } = await admin.from('wa_notify_settings').select('channel_id').eq('org_id', org.id).maybeSingle();
      const channelId = (cfg as { channel_id?: string | null } | null)?.channel_id;
      if (!channelId) { results.push({ org: org.id, skipped: 'sem número de avisos' }); continue; }
      const { data: ch } = await admin.from('channels').select('org_id, provider, uazapi_server_url, uazapi_token_encrypted')
        .eq('id', channelId).maybeSingle();
      const channel = ch as { org_id: string; provider: string; uazapi_server_url: string | null; uazapi_token_encrypted: string | null } | null;
      if (!channel || channel.org_id !== org.id || channel.provider !== 'uazapi') {
        results.push({ org: org.id, skipped: 'número de avisos inválido' });
        continue;
      }
      const uctx = await uazapiContextFromChannel(channel);
      const text = [`⚠️ *Monitoramento CRM — ${org.name}*`, ...fresh.map((a) => a.texto), 'Detalhes: https://crm.amaipark.com/monitoramento'].join('\n\n');
      let sent = 0;
      for (const r of recipients) {
        try { await uazapiSendText(uctx, { phone: r.phone, text }); sent++; } catch (err) {
          console.log(JSON.stringify({ event: 'monitor_alert_send_error', org_id: org.id, error: String(err) }));
        }
      }
      await admin.from('monitor_alert_log').insert(fresh.map((a) => ({ org_id: org.id, kind: a.kind, detail: a.texto, sent_to: sent })));
      results.push({ org: org.id, alerts: fresh.length, sent });
    } catch (err) {
      console.log(JSON.stringify({ event: 'monitor_alert_error', org_id: org.id, error: String(err) }));
      results.push({ org: org.id, error: String(err) });
    }
  }
  console.log(JSON.stringify({ event: 'monitor_alerts_run', results }));
  return jsonResponse({ ok: true, results });
});
