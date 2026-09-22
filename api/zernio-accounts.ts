import { createClient } from '@supabase/supabase-js';
import { requireAdmin, isAuthFailure } from '../src/lib/admin-auth.js';
import { encrypt, getCredential } from '../src/lib/credentials.js';

// ============================================================================
// api/zernio-accounts
// ----------------------------------------------------------------------------
// CRUD das CONTAS Zernio da org (whatsapp_hub.zernio_credentials). Cada conta
// é um login Zernio separado com sua própria API Key — necessário porque cada
// login Zernio só aceita 2 contas conectadas (WhatsApp/Instagram/TikTok/...).
// A chave nunca volta ao browser: só devolvemos id/label/created_at.
//
//  GET    → lista as contas da org (sem a chave).
//  POST   → cria uma conta nova { label, apiKey }.
//  PUT    → edita uma conta existente { id, label?, apiKey? } — troca o nome
//           e/ou a chave sem mexer no id (os canais que já apontam pra essa
//           conta continuam apontando, sem precisar reconectar nada).
//  DELETE → apaga uma conta { id }. Os canais que apontavam pra ela ficam com
//           zernio_credential_id = null (ON DELETE SET NULL) — não apaga o
//           canal, só desvincula a chave (o canal fica "órfão de chave" até
//           ser reconectado numa outra conta).
// ============================================================================

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

function authHeaderOf(req: ApiRequest): string | string[] | undefined {
  return req.headers?.authorization ?? req.headers?.Authorization;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

interface ZernioCredentialRow {
  id: string;
  label: string;
  created_at: string;
}

async function handleGet(orgId: string, res: ApiResponse) {
  const supabase = getSupabaseAdmin();
  let { data, error } = await supabase
    .schema('whatsapp_hub')
    .from('zernio_credentials')
    .select('id, label, created_at')
    .eq('org_id', orgId)
    .order('created_at');
  if (error) throw error;

  // Compatibilidade com organizações configuradas antes do suporte a várias
  // contas Zernio. A chave antiga continua válida no cofre da org; materializa
  // uma conta equivalente e vincula os canais órfãos sem pedir a chave de novo.
  if ((data ?? []).length === 0) {
    const legacyApiKey = (await getCredential(orgId, 'zernio_api_key'))?.trim();
    if (legacyApiKey) {
      const { data: migrated, error: insertError } = await supabase
        .schema('whatsapp_hub')
        .from('zernio_credentials')
        .insert({
          org_id: orgId,
          label: 'Conta principal',
          api_key_encrypted: encrypt(legacyApiKey),
        })
        .select('id, label, created_at')
        .single();
      if (insertError) throw insertError;

      const { error: linkError } = await supabase
        .schema('whatsapp_hub')
        .from('channels')
        .update({ zernio_credential_id: migrated.id })
        .eq('org_id', orgId)
        .eq('provider', 'zernio')
        .is('zernio_credential_id', null);
      if (linkError) throw linkError;
      data = [migrated];
    }
  }
  return res.status(200).json({ success: true, accounts: (data ?? []) as ZernioCredentialRow[] });
}

async function handlePost(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as { label?: unknown; apiKey?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    return res.status(400).json({ success: false, message: 'Cole a API Key do Zernio.' });
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .schema('whatsapp_hub')
    .from('zernio_credentials')
    .insert({
      org_id: orgId,
      label: label || 'Conta Zernio',
      api_key_encrypted: encrypt(apiKey),
    })
    .select('id, label, created_at')
    .single();
  if (error) throw error;

  return res.status(200).json({ success: true, account: data as ZernioCredentialRow });
}

async function handleDelete(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as { id?: unknown };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) {
    return res.status(400).json({ success: false, message: 'id da conta é obrigatório.' });
  }

  const supabase = getSupabaseAdmin();

  // Avisa quantos canais ficarão sem chave (não bloqueia — só informa).
  const { data: affected } = await supabase
    .schema('whatsapp_hub')
    .from('channels')
    .select('id, label')
    .eq('org_id', orgId)
    .eq('zernio_credential_id', id);

  const { error } = await supabase
    .schema('whatsapp_hub')
    .from('zernio_credentials')
    .delete()
    .eq('id', id)
    .eq('org_id', orgId);
  if (error) throw error;

  return res.status(200).json({
    success: true,
    affectedChannels: (affected ?? []).map((c: { id: string; label: string }) => c.label),
  });
}

async function handlePut(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as { id?: unknown; label?: unknown; apiKey?: unknown };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!id) {
    return res.status(400).json({ success: false, message: 'id da conta é obrigatório.' });
  }
  if (!label && !apiKey) {
    return res.status(400).json({ success: false, message: 'Informe um novo nome ou uma nova chave.' });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (label) patch.label = label;
  if (apiKey) patch.api_key_encrypted = encrypt(apiKey);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .schema('whatsapp_hub')
    .from('zernio_credentials')
    .update(patch)
    .eq('id', id)
    .eq('org_id', orgId)
    .select('id, label, created_at')
    .single();
  if (error) throw error;

  return res.status(200).json({ success: true, account: data as ZernioCredentialRow });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
      return res.status(405).end();
    }

    const auth = await requireAdmin(authHeaderOf(req));
    if (isAuthFailure(auth)) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    // `await` é essencial — sem ele, uma rejeição escapa do try/catch como
    // unhandled rejection e a Vercel devolve FUNCTION_INVOCATION_FAILED em vez
    // do JSON de erro tratado.
    if (req.method === 'GET') return await handleGet(auth.orgId, res);
    if (req.method === 'POST') return await handlePost(auth.orgId, req, res);
    if (req.method === 'PUT') return await handlePut(auth.orgId, req, res);
    return await handleDelete(auth.orgId, req, res);
  } catch (err) {
    console.error('zernio-accounts error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
