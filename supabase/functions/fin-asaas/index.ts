// ============================================================================
// fin-asaas — cobrança (boleto/PIX) de parcelas a receber pelo ASAAS
// ----------------------------------------------------------------------------
//   { action: 'config_status' }                                   → financial.setup
//   { action: 'save_config', api_key?, env, regenerate_token? }    → financial.setup
//   { action: 'create_charge', installment_id, account_id, billing_type } → financial.billing
//   { action: 'cancel_charge', charge_id }   (cobrança em aberto)  → financial.billing
//   { action: 'refund_charge', charge_id }   (cobrança paga)       → financial.billing
//
// O banco ligado à cobrança (onde a baixa automática cai) TEM de ser da mesma
// empresa do lançamento. A baixa em si vem pelo webhook (fin-asaas-webhook).
// ============================================================================

import { AuthError, callerCan, requireOrgCaller, type Caller } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getCredential, setCredential } from '../_shared/credentials.ts';
import { AsaasError, asaasFetch, centsToAsaas, loadAsaas } from '../_shared/asaas.ts';

type OrgCaller = Caller & { orgId: string };
const UUID_RE = /^[0-9a-f-]{36}$/i;

function fail(message: string, status = 400): Response {
  return jsonResponse({ ok: false, error: message }, { status });
}

function todaySP(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function randomToken(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function need(caller: OrgCaller, key: string, what: string) {
  if (!(await callerCan(caller, key))) throw new AuthError(`Seu perfil não permite ${what}. Peça ao administrador para liberar.`, 403);
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  try {
    const caller = (await requireOrgCaller(req)) as OrgCaller;
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return fail('Requisição inválida.');
    }
    const db = getAdminClient();
    const action = String(body.action ?? '');
    const webhookUrl = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/fin-asaas-webhook?org=${caller.orgId}`;

    // ------------------------------------------------------------ configuração
    if (action === 'config_status') {
      await need(caller, 'financial.setup', 'ver a configuração do ASAAS');
      const [key, env, token] = await Promise.all([
        getCredential(caller.orgId, 'asaas_api_key'),
        getCredential(caller.orgId, 'asaas_env'),
        getCredential(caller.orgId, 'asaas_webhook_token'),
      ]);
      return jsonResponse({
        ok: true,
        configured: Boolean(key),
        key_hint: key ? `…${key.slice(-4)}` : null,
        env: env === 'sandbox' ? 'sandbox' : 'production',
        webhook_url: webhookUrl,
        webhook_token: token,
      });
    }

    if (action === 'save_config') {
      await need(caller, 'financial.setup', 'configurar o ASAAS');
      const env = body.env === 'sandbox' ? 'sandbox' : 'production';
      const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
      if (apiKey) {
        // Confere a chave antes de salvar.
        const base = env === 'sandbox' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3';
        const test = await fetch(`${base}/customers?limit=1`, { headers: { access_token: apiKey, accept: 'application/json' } }).catch(() => null);
        if (!test || test.status === 401) return fail('O ASAAS recusou esta chave. Confira se copiou a chave inteira e se o ambiente (sandbox/produção) está certo.');
        await setCredential(caller.orgId, 'asaas_api_key', apiKey);
      }
      await setCredential(caller.orgId, 'asaas_env', env);
      let token = await getCredential(caller.orgId, 'asaas_webhook_token');
      if (!token || body.regenerate_token === true) {
        token = randomToken();
        await setCredential(caller.orgId, 'asaas_webhook_token', token);
      }
      return jsonResponse({ ok: true, webhook_url: webhookUrl, webhook_token: token, env });
    }

    // --------------------------------------------------------------- cobranças
    await need(caller, 'financial.billing', 'emitir ou cancelar cobranças');

    if (action === 'create_charge') {
      const instId = String(body.installment_id ?? '');
      const accountId = String(body.account_id ?? '');
      const billingType = ['BOLETO', 'PIX', 'UNDEFINED'].includes(String(body.billing_type)) ? String(body.billing_type) : 'UNDEFINED';
      if (!UUID_RE.test(instId)) return fail('Escolha a parcela.');
      if (!UUID_RE.test(accountId)) return fail('Escolha o banco que vai receber.');

      const { data: instData } = await db.from('fin_installments_v').select('*').eq('id', instId).maybeSingle();
      const inst = instData as Record<string, unknown> | null;
      if (!inst || inst.org_id !== caller.orgId) return fail('Parcela não encontrada.', 404);
      if (inst.kind !== 'receivable') return fail('Cobrança só para conta a receber.');
      if (inst.entry_status === 'canceled') return fail('Este lançamento está cancelado.');
      const remaining = Number(inst.remaining_cents ?? 0);
      if (remaining <= 0) return fail('Esta parcela já está paga.');
      if (inst.charge_status === 'pending' || inst.charge_status === 'open') return fail('Esta parcela já tem uma cobrança em aberto.');

      const { data: accData } = await db.from('fin_accounts').select('id, org_id, company_id, is_active, name').eq('id', accountId).maybeSingle();
      const acc = accData as { org_id: string; company_id: string; is_active: boolean } | null;
      if (!acc || acc.org_id !== caller.orgId) return fail('Banco não encontrado.');
      if (acc.company_id !== inst.company_id) return fail('O banco da cobrança precisa ser da MESMA empresa do lançamento.');
      if (!acc.is_active) return fail('Este banco está desativado. Escolha outro.');

      if (!inst.party_id) return fail('Para emitir cobrança, o lançamento precisa ter um cliente com CPF/CNPJ. Edite o lançamento e escolha o cliente.');
      const { data: partyData } = await db.from('fin_parties').select('*').eq('id', inst.party_id as string).maybeSingle();
      const party = partyData as { id: string; name: string; doc: string | null; email: string | null; phone: string | null; asaas_customer_id: string | null } | null;
      if (!party) return fail('Cliente não encontrado.');
      if (!party.doc) return fail(`O cliente ${party.name} está sem CPF/CNPJ. Cadastre o documento em Financeiro → Cadastros → Pessoas.`);

      const ctx = await loadAsaas(caller.orgId);
      let customerId = party.asaas_customer_id;
      if (!customerId) {
        const phone = (party.phone ?? '').replace(/\D/g, '');
        const created = await asaasFetch(ctx, '/customers', {
          method: 'POST',
          body: JSON.stringify({
            name: party.name,
            cpfCnpj: party.doc,
            ...(party.email ? { email: party.email } : {}),
            ...(phone.length >= 10 ? { mobilePhone: phone.replace(/^55/, '') } : {}),
            externalReference: party.id,
          }),
        });
        customerId = String(created.id ?? '');
        if (!customerId) return fail('O ASAAS não devolveu o cadastro do cliente. Tente de novo.');
        await db.from('fin_parties').update({ asaas_customer_id: customerId }).eq('id', party.id);
      }

      const today = todaySP();
      const due = String(inst.due_date) < today ? today : String(inst.due_date);
      const { data: chData, error: chErr } = await db.from('fin_charges').insert({
        org_id: caller.orgId,
        installment_id: instId,
        entry_id: inst.entry_id,
        account_id: accountId,
        billing_type: billingType,
        status: 'pending',
        value_cents: remaining,
        due_date: due,
        created_by: caller.userId,
      }).select('id').single();
      if (chErr) return fail(/fin_charges_one_open/.test(chErr.message) ? 'Esta parcela já tem uma cobrança em aberto.' : 'Não foi possível registrar a cobrança. Tente de novo.', 500);
      const chargeId = (chData as { id: string }).id;

      try {
        const label = `${inst.description}${Number(inst.installments_count) > 1 ? ` (${inst.number}/${inst.installments_count})` : ''}`;
        const pay = await asaasFetch(ctx, '/payments', {
          method: 'POST',
          body: JSON.stringify({
            customer: customerId,
            billingType,
            value: centsToAsaas(remaining),
            dueDate: due,
            description: label.slice(0, 500),
            externalReference: chargeId,
          }),
        });
        let pixPayload: string | null = null;
        if (billingType === 'PIX' || billingType === 'UNDEFINED') {
          try {
            const qr = await asaasFetch(ctx, `/payments/${pay.id}/pixQrCode`);
            pixPayload = typeof qr.payload === 'string' ? qr.payload : null;
          } catch { /* PIX opcional no UNDEFINED */ }
        }
        await db.from('fin_charges').update({
          provider_id: String(pay.id),
          status: 'open',
          invoice_url: (pay.invoiceUrl as string) ?? null,
          bank_slip_url: (pay.bankSlipUrl as string) ?? null,
          pix_payload: pixPayload,
        }).eq('id', chargeId);
        return jsonResponse({ ok: true, charge_id: chargeId, invoice_url: pay.invoiceUrl ?? null, bank_slip_url: pay.bankSlipUrl ?? null, pix_payload: pixPayload });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Falha no ASAAS.';
        await db.from('fin_charges').update({ status: 'failed', error_message: msg }).eq('id', chargeId);
        throw e;
      }
    }

    if (action === 'cancel_charge' || action === 'refund_charge') {
      const chargeId = String(body.charge_id ?? '');
      if (!UUID_RE.test(chargeId)) return fail('Cobrança inválida.');
      const { data: c } = await db.from('fin_charges').select('*').eq('id', chargeId).maybeSingle();
      const charge = c as { org_id: string; status: string; provider_id: string | null } | null;
      if (!charge || charge.org_id !== caller.orgId) return fail('Cobrança não encontrada.', 404);
      const ctx = await loadAsaas(caller.orgId);

      if (action === 'cancel_charge') {
        if (!['pending', 'open', 'failed'].includes(charge.status)) return fail('Só dá para cancelar cobrança em aberto. Se já foi paga, use "Pedir devolução".');
        if (charge.provider_id) await asaasFetch(ctx, `/payments/${charge.provider_id}`, { method: 'DELETE' });
        await db.from('fin_charges').update({ status: 'canceled', last_event: 'canceled_by_user' }).eq('id', chargeId);
        return jsonResponse({ ok: true });
      }

      if (charge.status !== 'paid') return fail('Só dá para pedir devolução de cobrança paga.');
      if (!charge.provider_id) return fail('Cobrança sem identificação no ASAAS.');
      await asaasFetch(ctx, `/payments/${charge.provider_id}/refund`, { method: 'POST', body: JSON.stringify({}) });
      await db.from('fin_charges').update({ status: 'refund_requested', last_event: 'refund_requested' }).eq('id', chargeId);
      return jsonResponse({ ok: true });
    }

    return fail('Ação inválida.');
  } catch (err) {
    if (err instanceof AuthError) return fail(err.message, err.status);
    if (err instanceof AsaasError) return fail(err.message, err.status);
    console.error('fin-asaas error', err);
    return fail('Não foi possível concluir agora. Tente de novo em alguns minutos.', 500);
  }
});
