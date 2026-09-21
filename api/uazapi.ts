import { createClient } from '@supabase/supabase-js';
import { requireAdmin, isAuthFailure } from '../src/lib/admin-auth.js';
import { decrypt, encrypt, getCredential } from '../src/lib/credentials.js';
import { UazapiError, configureWebhook, instanceStatus, connectInstance } from '../src/lib/uazapi.js';

// ============================================================================
// api/uazapi  (?action=connect | ?action=qrcode)
// ----------------------------------------------------------------------------
// Integração DIRETA com a UAZAPI (não passa pelo Zernio). Multi-número: cada
// instância UAZAPI é um CANAL da org (whatsapp_hub.channels, provider='uazapi')
// com server_url + token cifrado na linha e um webhook_secret próprio — o
// webhook é roteado por ?secret=<webhook_secret do canal>.
//
// Junta os antigos api/uazapi-connect.ts e api/uazapi-qrcode.ts num único
// arquivo (a Vercel Hobby limita a 12 Serverless Functions por deployment;
// dois endpoints minúsculos e correlatos viraram um só pra caber no limite —
// nenhum comportamento mudou, só a URL: /api/uazapi-connect e
// /api/uazapi-qrcode viraram /api/uazapi?action=connect e ?action=qrcode).
//
// action=connect:
//   GET  → lista os canais UAZAPI da org com status de conexão.
//   POST → cria/atualiza um canal:
//          { channelId? , serverUrl?, token?, label?, phone? }
//          · channelId ausente + serverUrl/token → cria canal novo
//          · channelId presente → revalida/atualiza o canal (token opcional)
//          · nada → fallback legado: usa as credenciais uazapi_server_url /
//            uazapi_instance_token migradas do cofre da org (seed pós-migração)
//          Sempre valida a instância e cadastra/atualiza o webhook na UAZAPI.
//
// action=qrcode (GET ?channelId=<uuid>):
//   QR Code (base64) pra escanear e conectar a instância UAZAPI daquele
//   canal. Pensado pra polling pelo frontend (o QR expira em ~20-60s na
//   UAZAPI, então cada chamada aqui pede um novo) sem repetir a
//   validação/cadastro do webhook.
// ============================================================================

type ApiRequest = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
};
type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (body: unknown) => void;
  end: () => void;
};

interface ChannelRow {
  id: string;
  org_id: string;
  label: string;
  phone: string | null;
  uazapi_server_url: string | null;
  uazapi_token_encrypted: string | null;
  webhook_secret: string;
  assigned_member: string | null;
  is_active: boolean;
}

function authHeaderOf(req: ApiRequest): string | string[] | undefined {
  return req.headers?.authorization ?? req.headers?.Authorization;
}

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase core nao configurado.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function channelsTable() {
  return getSupabaseAdmin().schema('whatsapp_hub').from('channels');
}

function webhookUrl(secret: string): string {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('SUPABASE_URL ausente para montar a URL do webhook.');
  return `${base.replace(/\/$/, '')}/functions/v1/uazapi-webhook?secret=${secret}`;
}

// Decifra o token do canal usando o mesmo AES-GCM do cofre.
function decryptToken(payload: string): string {
  return decrypt(payload);
}

// ---------------------------------------------------------------------------
// action=connect
// ---------------------------------------------------------------------------

async function handleConnectGet(orgId: string, res: ApiResponse) {
  const { data, error } = await channelsTable()
    .select('id, label, phone, uazapi_server_url, uazapi_token_encrypted, assigned_member, is_active')
    .eq('org_id', orgId)
    .eq('provider', 'uazapi')
    .order('created_at');
  if (error) throw error;

  const channels = await Promise.all(
    ((data ?? []) as ChannelRow[]).map(async (ch) => {
      let connected = false;
      let status: string | null = null;
      try {
        if (ch.uazapi_server_url && ch.uazapi_token_encrypted) {
          const st = await instanceStatus(
            ch.uazapi_server_url,
            decryptToken(ch.uazapi_token_encrypted),
          );
          connected = st.connected;
          status = st.status;
        } else {
          status = 'não configurado';
        }
      } catch (err) {
        status = err instanceof Error ? err.message : 'erro';
      }
      return {
        id: ch.id,
        label: ch.label,
        phone: ch.phone,
        assigned_member: ch.assigned_member,
        is_active: ch.is_active,
        connected,
        status,
      };
    }),
  );

  return res.status(200).json({
    success: true,
    configured: channels.length > 0,
    connected: channels.some((c) => c.connected),
    channels,
  });
}

async function handleConnectPost(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as {
    channelId?: unknown;
    serverUrl?: unknown;
    token?: unknown;
    label?: unknown;
    phone?: unknown;
  };
  const channelId = typeof body.channelId === 'string' ? body.channelId.trim() : '';
  let serverUrl = typeof body.serverUrl === 'string'
    ? body.serverUrl.trim().replace(/\/+$/, '')
    : '';
  let token = typeof body.token === 'string' ? body.token.trim() : '';
  const label = typeof body.label === 'string' && body.label.trim()
    ? body.label.trim()
    : 'WhatsApp UAZAPI';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : null;

  let channel: ChannelRow | null = null;

  if (channelId) {
    const { data, error } = await channelsTable()
      .select('id, org_id, label, phone, uazapi_server_url, uazapi_token_encrypted, webhook_secret, assigned_member, is_active')
      .eq('id', channelId)
      .eq('org_id', orgId)
      .eq('provider', 'uazapi')
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ success: false, message: 'Canal não encontrado.' });
    }
    channel = data as ChannelRow;
    serverUrl = serverUrl || channel.uazapi_server_url || '';
    token = token || (channel.uazapi_token_encrypted
      ? decryptToken(channel.uazapi_token_encrypted)
      : '');
  } else if (!serverUrl || !token) {
    // Fallback legado (seed pós-migração): credenciais globais migradas para o
    // cofre da org viram o primeiro canal UAZAPI.
    serverUrl = serverUrl || ((await getCredential(orgId, 'uazapi_server_url'))?.trim() ?? '');
    token = token || ((await getCredential(orgId, 'uazapi_instance_token'))?.trim() ?? '');
  }

  if (!serverUrl || !token) {
    return res.status(400).json({
      success: false,
      message: 'Informe o Server URL e o Instance Token da UAZAPI.',
    });
  }

  // Valida token/instância antes de mexer no canal/webhook.
  const st = await instanceStatus(serverUrl, token);

  const encryptedToken = encrypt(token);
  if (channel) {
    const { error } = await channelsTable()
      .update({
        uazapi_server_url: serverUrl,
        uazapi_token_encrypted: encryptedToken,
        ...(typeof body.label === 'string' && body.label.trim() ? { label } : {}),
        ...(phone ? { phone } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', channel.id);
    if (error) throw error;
  } else {
    // Reusa canal existente com o mesmo server_url (idempotência do seed).
    const { data: existing } = await channelsTable()
      .select('id, org_id, label, phone, uazapi_server_url, uazapi_token_encrypted, webhook_secret, assigned_member, is_active')
      .eq('org_id', orgId)
      .eq('provider', 'uazapi')
      .eq('uazapi_server_url', serverUrl)
      .maybeSingle();
    if (existing) {
      channel = existing as ChannelRow;
      const { error } = await channelsTable()
        .update({
          uazapi_token_encrypted: encryptedToken,
          updated_at: new Date().toISOString(),
        })
        .eq('id', channel.id);
      if (error) throw error;
    } else {
      const { data: created, error } = await channelsTable()
        .insert({
          org_id: orgId,
          provider: 'uazapi',
          label,
          phone,
          uazapi_server_url: serverUrl,
          uazapi_token_encrypted: encryptedToken,
        })
        .select('id, org_id, label, phone, uazapi_server_url, uazapi_token_encrypted, webhook_secret, assigned_member, is_active')
        .single();
      if (error) throw error;
      channel = created as ChannelRow;
    }
  }

  // Cadastra/atualiza o webhook na UAZAPI apontando para o secret DO CANAL.
  // Falha aqui é não-fatal: o canal já está no banco e aparece na lista;
  // o operador pode reconectar manualmente para retentar o webhook.
  let webhookId: string | null = null;
  let webhookWarning: string | undefined;
  try {
    const wh = await configureWebhook(serverUrl, token, {
      url: webhookUrl(channel.webhook_secret),
      existingId: null,
    });
    webhookId = wh.id;
  } catch (whErr) {
    webhookWarning = whErr instanceof Error ? whErr.message : 'Falha ao cadastrar o webhook na UAZAPI.';
    console.error('uazapi connect webhook warning', whErr);
  }

  // Se ainda não conectou (número novo ou sessão nunca pareada), já busca o
  // QR Code de cara — evita o operador precisar de um segundo clique só pra
  // ver o QR depois de salvar. Falha aqui também é não-fatal: o canal já está
  // salvo e o front pode pedir o QR de novo via /api/uazapi?action=qrcode.
  let qrcode: string | null = null;
  let paircode: string | null = null;
  if (!st.connected) {
    try {
      const conn = await connectInstance(serverUrl, token, phone ?? undefined);
      qrcode = conn.qrcode;
      paircode = conn.paircode;
    } catch (qrErr) {
      console.error('uazapi connect qrcode warning', qrErr);
    }
  }

  return res.status(200).json({
    success: true,
    channelId: channel.id,
    connected: st.connected,
    status: st.status,
    qrcode,
    paircode,
    webhookId,
    webhookWarning,
  });
}

// ---------------------------------------------------------------------------
// action=qrcode
// ---------------------------------------------------------------------------

async function handleQrcode(orgId: string, req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const channelIdRaw = req.query?.channelId;
  const channelId = Array.isArray(channelIdRaw) ? channelIdRaw[0] : channelIdRaw;
  if (!channelId) {
    return res.status(400).json({ success: false, message: 'Informe o channelId.' });
  }

  const { data, error } = await channelsTable()
    .select('id, uazapi_server_url, uazapi_token_encrypted, phone')
    .eq('id', channelId)
    .eq('org_id', orgId)
    .eq('provider', 'uazapi')
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.uazapi_server_url || !data.uazapi_token_encrypted) {
    return res.status(404).json({ success: false, message: 'Instância UAZAPI não encontrada.' });
  }

  const serverUrl = data.uazapi_server_url as string;
  const token = decrypt(data.uazapi_token_encrypted as string);

  // Já conectado — nem precisa gastar um QR novo.
  const st = await instanceStatus(serverUrl, token);
  if (st.connected) {
    return res.status(200).json({ success: true, connected: true, status: st.status });
  }

  const conn = await connectInstance(serverUrl, token, (data.phone as string | null) ?? undefined);
  return res.status(200).json({
    success: true,
    connected: conn.connected,
    status: conn.status,
    qrcode: conn.qrcode,
    paircode: conn.paircode,
  });
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    const actionRaw = req.query?.action;
    const action = Array.isArray(actionRaw) ? actionRaw[0] : actionRaw;

    const auth = await requireAdmin(authHeaderOf(req));
    if (isAuthFailure(auth)) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    if (action === 'qrcode') {
      return await handleQrcode(auth.orgId, req, res);
    }

    // action=connect (ou ausente — mantém o comportamento antigo como default).
    if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();
    return await (req.method === 'GET'
      ? handleConnectGet(auth.orgId, res)
      : handleConnectPost(auth.orgId, req, res));
  } catch (err) {
    if (err instanceof UazapiError) {
      return res.status(err.status === 401 ? 401 : 502).json({ success: false, message: err.message });
    }
    console.error('uazapi api error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
