// ============================================================================
// fin-asaas-webhook  (PÚBLICA — deploy com --no-verify-jwt)
// ----------------------------------------------------------------------------
// URL: …/functions/v1/fin-asaas-webhook?org=<org_id>
// Autenticação: header `asaas-access-token` = token salvo em
// Financeiro → Configurações → Cobrança ASAAS (credencial asaas_webhook_token).
//
// PAYMENT_CONFIRMED / PAYMENT_RECEIVED → baixa automática (idempotente)
// PAYMENT_REFUNDED                     → estorno automático da baixa
// PAYMENT_DELETED                      → cobrança cancelada
// Demais eventos: só registra o último evento na cobrança.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse } from '../_shared/cors.ts';
import { getCredential } from '../_shared/credentials.ts';
import { asaasToCents } from '../_shared/asaas.ts';

const UUID_RE = /^[0-9a-f-]{36}$/i;

function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ ok: false }, { status: 405 });
  const org = new URL(req.url).searchParams.get('org') ?? '';
  if (!UUID_RE.test(org)) return jsonResponse({ ok: false, error: 'org inválida' }, { status: 400 });

  const expected = await getCredential(org, 'asaas_webhook_token').catch(() => null);
  const got = req.headers.get('asaas-access-token') ?? '';
  if (!expected || !got || !safeEqual(expected, got)) {
    return jsonResponse({ ok: false, error: 'token inválido' }, { status: 401 });
  }

  let body: { event?: string; payment?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ ok: true, ignored: 'json' });
  }
  const event = String(body.event ?? '');
  const pay = body.payment ?? {};
  const providerId = typeof pay.id === 'string' ? pay.id : '';
  if (!event.startsWith('PAYMENT_') || !providerId) return jsonResponse({ ok: true, ignored: event });

  const db = getAdminClient();
  let { data: charge } = await db.from('fin_charges').select('id, org_id, status').eq('provider', 'asaas').eq('provider_id', providerId).maybeSingle();
  // Fallback: externalReference = id da cobrança no CRM (corrida entre criar e o 1º evento).
  if (!charge && typeof pay.externalReference === 'string' && UUID_RE.test(pay.externalReference)) {
    const r = await db.from('fin_charges').select('id, org_id, status').eq('id', pay.externalReference).maybeSingle();
    charge = r.data;
  }
  const c = charge as { id: string; org_id: string; status: string } | null;
  if (!c || c.org_id !== org) return jsonResponse({ ok: true, ignored: 'cobrança desconhecida' });

  try {
    if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED' || event === 'PAYMENT_RECEIVED_IN_CASH') {
      const paidDate = String(pay.clientPaymentDate ?? pay.paymentDate ?? pay.confirmedDate ?? '').slice(0, 10) || null;
      const { error } = await db.rpc('fin_charge_paid', {
        p_charge: c.id,
        p_paid_date: paidDate,
        p_value_cents: asaasToCents(pay.value),
        p_event: event,
      });
      if (error) throw error;
    } else if (event === 'PAYMENT_REFUNDED') {
      const { error } = await db.rpc('fin_charge_refunded', { p_charge: c.id, p_event: event });
      if (error) throw error;
    } else if (event === 'PAYMENT_DELETED') {
      if (c.status !== 'paid') await db.from('fin_charges').update({ status: 'canceled', last_event: event }).eq('id', c.id);
    } else {
      await db.from('fin_charges').update({ last_event: event }).eq('id', c.id);
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'fin_asaas_webhook_error', asaas_event: event, message: err instanceof Error ? err.message : String(err) }));
    // 500 → o ASAAS tenta de novo (a baixa é idempotente).
    return jsonResponse({ ok: false }, { status: 500 });
  }
  return jsonResponse({ ok: true });
});
