import { randomBytes, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../src/lib/admin-auth.js';

// ============================================================================
// api/api-keys
// ----------------------------------------------------------------------------
// CRUD das chaves da API pública do CRM (whatsapp_hub.api_keys). Só admin
// pode gerar/revogar — é acesso de sistema, não de usuário comum.
//
//  GET    → lista as chaves da org (sem a chave nem o hash).
//  POST   → gera uma chave nova { label, scopes? }. A chave completa só
//           aparece NESTA resposta — depois disso é irrecuperável (só dá
//           pra revogar e gerar outra).
//  DELETE → revoga uma chave { id }.
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

function generateApiKey(): { full: string; prefix: string; hash: string } {
  const raw = randomBytes(24).toString('hex'); // 48 chars
  const full = `amai_live_${raw}`;
  const prefix = full.slice(0, 18); // "amai_live_" + 8 chars, dá pra reconhecer
  const hash = createHash('sha256').update(full).digest('hex');
  return { full, prefix, hash };
}

interface ApiKeyRow {
  id: string;
  label: string;
  key_prefix: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

async function handleGet(orgId: string, res: ApiResponse) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .schema('whatsapp_hub')
    .from('api_keys')
    .select('id, label, key_prefix, scopes, created_at, last_used_at, revoked_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return res.status(200).json({ success: true, keys: (data ?? []) as ApiKeyRow[] });
}

async function handlePost(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as { label?: unknown; scopes?: unknown };
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) {
    return res.status(400).json({ success: false, message: 'Dê um nome pra essa chave (ex.: "Site institucional").' });
  }
  const scopes = Array.isArray(body.scopes) && body.scopes.every((s) => typeof s === 'string')
    ? (body.scopes as string[])
    : ['read', 'write'];

  const { full, prefix, hash } = generateApiKey();
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .schema('whatsapp_hub')
    .from('api_keys')
    .insert({ org_id: orgId, label, key_prefix: prefix, key_hash: hash, scopes })
    .select('id, label, key_prefix, scopes, created_at, last_used_at, revoked_at')
    .single();
  if (error) throw error;

  // A chave completa só existe nesta resposta — nunca mais é recuperável.
  return res.status(200).json({ success: true, key: data as ApiKeyRow, fullKey: full });
}

async function handleDelete(orgId: string, req: ApiRequest, res: ApiResponse) {
  const body = (req.body ?? {}) as { id?: unknown };
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return res.status(400).json({ success: false, message: 'id da chave é obrigatório.' });

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .schema('whatsapp_hub')
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', orgId);
  if (error) throw error;
  return res.status(200).json({ success: true });
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
      return res.status(405).end();
    }
    const auth = await requireAdmin(authHeaderOf(req));
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, message: auth.message });
    }
    if (req.method === 'GET') return await handleGet(auth.orgId, res);
    if (req.method === 'POST') return await handlePost(auth.orgId, req, res);
    return await handleDelete(auth.orgId, req, res);
  } catch (err) {
    console.error('api-keys error', err);
    return res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : 'Erro interno',
    });
  }
}
