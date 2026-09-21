import { createClient } from '@supabase/supabase-js';
import { requireAdmin, isAuthFailure } from '../src/lib/admin-auth.js';
import { decrypt } from '../src/lib/credentials.js';
import { UazapiError, instanceStatus, connectInstance } from '../src/lib/uazapi.js';

// ============================================================================
// api/uazapi-qrcode
// ----------------------------------------------------------------------------
// GET ?channelId=<uuid> → QR Code (base64) pra escanear e conectar a instância
// UAZAPI daquele canal. Separado de uazapi-connect pra poder ser chamado em
// polling pelo frontend (o QR expira em ~20-60s na UAZAPI, então cada
// chamada aqui pede um novo) sem repetir a validação/cadastro do webhook.
//
// Fluxo: 1) checa instanceStatus — se já conectado, devolve connected:true
//           sem gastar um novo QR;
//        2) senão, chama connectInstance (POST /instance/connect na UAZAPI)
//           e devolve o qrcode/paircode pro frontend renderizar.
// ============================================================================

type ApiRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
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

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'GET') return res.status(405).end();

    const auth = await requireAdmin(authHeaderOf(req));
    if (isAuthFailure(auth)) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }

    const channelIdRaw = req.query?.channelId;
    const channelId = Array.isArray(channelIdRaw) ? channelIdRaw[0] : channelIdRaw;
    if (!channelId) {
      return res.status(400).json({ success: false, message: 'Informe o channelId.' });
    }

    const { data, error } = await getSupabaseAdmin()
      .schema('whatsapp_hub')
      .from('channels')
      .select('id, uazapi_server_url, uazapi_token_encrypted, phone')
      .eq('id', channelId)
      .eq('org_id', auth.orgId)
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
  } catch (err) {
    if (err instanceof UazapiError) {
      return res.status(err.status === 401 ? 401 : 502).json({ success: false, message: err.message });
    }
    console.error('uazapi-qrcode error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
