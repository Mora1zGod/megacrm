// ============================================================================
// public-api — VERSAO STANDALONE (sem _shared) para deploy pelo editor web
// do Supabase, que teve problema pra empacotar imports relativos de _shared.
// Tudo nesse arquivo unico: cliente admin + cors + rotas.
// ============================================================================

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.0';

export function getAdminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'whatsapp_hub' },
  });
}

// Separate admin client that talks to the auth schema (e.g. for admin.* APIs).
export function getAuthAdminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Shared CORS headers for every Edge Function in this app.
// Supabase Edge Functions don't add CORS by default; the browser needs these
// to talk to the function from the Vite dev server or production domain.

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
};

export function jsonResponse(
  body: unknown,
  init: ResponseInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
      ...(init.headers ?? {}),
    },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }
  return null;
}

// ============================================================================
// public-api
// ----------------------------------------------------------------------------
// API pública do CRM, autenticada por API Key (não é o login de usuário).
// Pensada pra você integrar outros sistemas seus com o CRM.
//
// AUTENTICAÇÃO
//   Header: Authorization: Bearer amai_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
//   A chave nunca é guardada em texto puro no banco — comparamos pelo hash
//   (SHA-256). Toda chamada atualiza last_used_at (best-effort).
//
// ROTAS (todas relativas a /functions/v1/public-api)
//   GET    /contacts              lista (paginação: ?limit=&offset=)
//   GET    /contacts/:id          um contato
//   POST   /contacts              cria { phone, name?, email?, source? }
//   PATCH  /contacts/:id          atualiza campos parciais
//
//   GET    /deals                 lista (?limit=&offset=&status=)
//   GET    /deals/:id             um negócio
//   POST   /deals                 cria { contact_id, title, value?, pipeline_id?, stage_id? }
//   PATCH  /deals/:id             atualiza campos parciais
//
//   GET    /visits                lista (?limit=&offset=&from=&to=)
//   GET    /visits/:id            uma visita
//   POST   /visits                cria { contact_id, visit_date, visit_time, party_size? }
//   PATCH  /visits/:id            atualiza campos parciais
//
// Todas as respostas são JSON: sucesso { data: ... }, erro { error: "..." }.
// Tudo é automaticamente filtrado pela organização dona da chave — nunca
// vaza dado de outra org, mesmo que o id exista lá.
//
// PROPOSITALMENTE DE FORA NESTA V1: conversas/mensagens (regras de negócio
// demais — janela de 24h, IA, handoff — não dá pra expor cru numa API
// genérica sem risco de bypass; se precisar disso no futuro, é uma rota
// própria, pensada com cuidado, não um CRUD genérico).
// ============================================================================

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface AuthedKey {
  id: string;
  orgId: string;
  scopes: string[];
}

async function authenticate(admin: ReturnType<typeof getAdminClient>, req: Request): Promise<AuthedKey | null> {
  const header = req.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const key = match[1].trim();
  if (!key.startsWith('amai_')) return null;
  const hash = await sha256Hex(key);

  const { data, error } = await admin
    .from('api_keys')
    .select('id, org_id, scopes, revoked_at')
    .eq('key_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();
  if (error || !data) return null;

  // Best-effort — nunca bloqueia a request por causa disso.
  void admin.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', data.id);

  return { id: data.id, orgId: data.org_id, scopes: (data.scopes ?? []) as string[] };
}

function paginationOf(url: URL): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50), 1), 200);
  const offset = Math.max(Number(url.searchParams.get('offset') ?? 0), 0);
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Contatos
// ---------------------------------------------------------------------------
const CONTACT_FIELDS = 'id, phone, name, email, source, created_at, updated_at';
const CONTACT_WRITABLE = ['phone', 'name', 'email', 'source'] as const;

async function handleContacts(
  admin: ReturnType<typeof getAdminClient>,
  auth: AuthedKey,
  req: Request,
  url: URL,
  id: string | null,
): Promise<Response> {
  if (req.method === 'GET' && !id) {
    const { limit, offset } = paginationOf(url);
    const { data, error, count } = await admin
      .from('contacts')
      .select(CONTACT_FIELDS, { count: 'exact' })
      .eq('org_id', auth.orgId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ data, pagination: { limit, offset, total: count ?? 0 } });
  }

  if (req.method === 'GET' && id) {
    const { data, error } = await admin.from('contacts').select(CONTACT_FIELDS).eq('org_id', auth.orgId).eq('id', id).maybeSingle();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!data) return jsonResponse({ error: 'Contato não encontrado.' }, { status: 404 });
    return jsonResponse({ data });
  }

  if (req.method === 'POST' && !id) {
    if (!auth.scopes.includes('write')) return jsonResponse({ error: 'Esta chave não tem permissão de escrita.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (!body.phone || typeof body.phone !== 'string') {
      return jsonResponse({ error: 'Campo "phone" é obrigatório.' }, { status: 400 });
    }
    const payload: Record<string, unknown> = { org_id: auth.orgId, phone: body.phone };
    for (const f of CONTACT_WRITABLE) if (f !== 'phone' && body[f] !== undefined) payload[f] = body[f];
    const { data, error } = await admin.from('contacts').insert(payload).select(CONTACT_FIELDS).single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ data }, { status: 201 });
  }

  if (req.method === 'PATCH' && id) {
    if (!auth.scopes.includes('write')) return jsonResponse({ error: 'Esta chave não tem permissão de escrita.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    for (const f of CONTACT_WRITABLE) if (body[f] !== undefined) patch[f] = body[f];
    if (Object.keys(patch).length === 0) return jsonResponse({ error: 'Nenhum campo válido pra atualizar.' }, { status: 400 });
    const { data, error } = await admin.from('contacts').update(patch).eq('org_id', auth.orgId).eq('id', id).select(CONTACT_FIELDS).maybeSingle();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!data) return jsonResponse({ error: 'Contato não encontrado.' }, { status: 404 });
    return jsonResponse({ data });
  }

  return jsonResponse({ error: 'Método não suportado nessa rota.' }, { status: 405 });
}

// ---------------------------------------------------------------------------
// Negócios (deals)
// ---------------------------------------------------------------------------
const DEAL_FIELDS = 'id, contact_id, pipeline_id, stage_id, title, value, status, created_at, updated_at';
const DEAL_WRITABLE = ['title', 'value', 'pipeline_id', 'stage_id', 'status'] as const;

async function handleDeals(
  admin: ReturnType<typeof getAdminClient>,
  auth: AuthedKey,
  req: Request,
  url: URL,
  id: string | null,
): Promise<Response> {
  if (req.method === 'GET' && !id) {
    const { limit, offset } = paginationOf(url);
    let q = admin.from('deals').select(DEAL_FIELDS, { count: 'exact' }).eq('org_id', auth.orgId);
    const status = url.searchParams.get('status');
    if (status) q = q.eq('status', status);
    const { data, error, count } = await q.order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ data, pagination: { limit, offset, total: count ?? 0 } });
  }

  if (req.method === 'GET' && id) {
    const { data, error } = await admin.from('deals').select(DEAL_FIELDS).eq('org_id', auth.orgId).eq('id', id).maybeSingle();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!data) return jsonResponse({ error: 'Negócio não encontrado.' }, { status: 404 });
    return jsonResponse({ data });
  }

  if (req.method === 'POST' && !id) {
    if (!auth.scopes.includes('write')) return jsonResponse({ error: 'Esta chave não tem permissão de escrita.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (!body.contact_id || !body.title) {
      return jsonResponse({ error: 'Campos "contact_id" e "title" são obrigatórios.' }, { status: 400 });
    }
    // Confere que o contato é da mesma org da chave — nunca cria negócio
    // pendurado num contato de outra organização.
    const { data: contact } = await admin.from('contacts').select('id').eq('org_id', auth.orgId).eq('id', body.contact_id).maybeSingle();
    if (!contact) return jsonResponse({ error: 'contact_id não encontrado nesta organização.' }, { status: 400 });

    const payload: Record<string, unknown> = { org_id: auth.orgId, contact_id: body.contact_id, title: body.title };
    for (const f of DEAL_WRITABLE) if (f !== 'title' && body[f] !== undefined) payload[f] = body[f];
    const { data, error } = await admin.from('deals').insert(payload).select(DEAL_FIELDS).single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ data }, { status: 201 });
  }

  if (req.method === 'PATCH' && id) {
    if (!auth.scopes.includes('write')) return jsonResponse({ error: 'Esta chave não tem permissão de escrita.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    for (const f of DEAL_WRITABLE) if (body[f] !== undefined) patch[f] = body[f];
    if (Object.keys(patch).length === 0) return jsonResponse({ error: 'Nenhum campo válido pra atualizar.' }, { status: 400 });
    const { data, error } = await admin.from('deals').update(patch).eq('org_id', auth.orgId).eq('id', id).select(DEAL_FIELDS).maybeSingle();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!data) return jsonResponse({ error: 'Negócio não encontrado.' }, { status: 404 });
    return jsonResponse({ data });
  }

  return jsonResponse({ error: 'Método não suportado nessa rota.' }, { status: 405 });
}

// ---------------------------------------------------------------------------
// Visitas
// ---------------------------------------------------------------------------
const VISIT_FIELDS = 'id, contact_id, visit_date, visit_time, party_size, status, notes, created_at';
const VISIT_WRITABLE = ['visit_date', 'visit_time', 'party_size', 'status', 'notes'] as const;

async function handleVisits(
  admin: ReturnType<typeof getAdminClient>,
  auth: AuthedKey,
  req: Request,
  url: URL,
  id: string | null,
): Promise<Response> {
  if (req.method === 'GET' && !id) {
    const { limit, offset } = paginationOf(url);
    let q = admin.from('park_visits').select(VISIT_FIELDS, { count: 'exact' }).eq('org_id', auth.orgId);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (from) q = q.gte('visit_date', from);
    if (to) q = q.lte('visit_date', to);
    const { data, error, count } = await q.order('visit_date', { ascending: false }).range(offset, offset + limit - 1);
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ data, pagination: { limit, offset, total: count ?? 0 } });
  }

  if (req.method === 'GET' && id) {
    const { data, error } = await admin.from('park_visits').select(VISIT_FIELDS).eq('org_id', auth.orgId).eq('id', id).maybeSingle();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!data) return jsonResponse({ error: 'Visita não encontrada.' }, { status: 404 });
    return jsonResponse({ data });
  }

  if (req.method === 'POST' && !id) {
    if (!auth.scopes.includes('write')) return jsonResponse({ error: 'Esta chave não tem permissão de escrita.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    if (!body.contact_id || !body.visit_date || !body.visit_time) {
      return jsonResponse({ error: 'Campos "contact_id", "visit_date" e "visit_time" são obrigatórios.' }, { status: 400 });
    }
    const { data: contact } = await admin.from('contacts').select('id').eq('org_id', auth.orgId).eq('id', body.contact_id).maybeSingle();
    if (!contact) return jsonResponse({ error: 'contact_id não encontrado nesta organização.' }, { status: 400 });

    const payload: Record<string, unknown> = {
      org_id: auth.orgId,
      contact_id: body.contact_id,
      visit_date: body.visit_date,
      visit_time: body.visit_time,
      party_size: body.party_size ?? 1,
      status: 'pending',
    };
    const { data, error } = await admin.from('park_visits').insert(payload).select(VISIT_FIELDS).single();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    return jsonResponse({ data }, { status: 201 });
  }

  if (req.method === 'PATCH' && id) {
    if (!auth.scopes.includes('write')) return jsonResponse({ error: 'Esta chave não tem permissão de escrita.' }, { status: 403 });
    const body = await req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    for (const f of VISIT_WRITABLE) if (body[f] !== undefined) patch[f] = body[f];
    if (Object.keys(patch).length === 0) return jsonResponse({ error: 'Nenhum campo válido pra atualizar.' }, { status: 400 });
    const { data, error } = await admin.from('park_visits').update(patch).eq('org_id', auth.orgId).eq('id', id).select(VISIT_FIELDS).maybeSingle();
    if (error) return jsonResponse({ error: error.message }, { status: 500 });
    if (!data) return jsonResponse({ error: 'Visita não encontrada.' }, { status: 404 });
    return jsonResponse({ data });
  }

  return jsonResponse({ error: 'Método não suportado nessa rota.' }, { status: 405 });
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const admin = getAdminClient();
  const auth = await authenticate(admin, req);
  if (!auth) {
    return jsonResponse({ error: 'API key ausente ou inválida. Use: Authorization: Bearer <sua_chave>' }, { status: 401 });
  }

  const url = new URL(req.url);
  // Remove o prefixo da própria function do path: /public-api/contacts/123 → ['contacts', '123']
  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('public-api');
  const segments = idx >= 0 ? parts.slice(idx + 1) : parts;
  const [resource, id] = segments;

  try {
    if (resource === 'contacts') return await handleContacts(admin, auth, req, url, id ?? null);
    if (resource === 'deals') return await handleDeals(admin, auth, req, url, id ?? null);
    if (resource === 'visits') return await handleVisits(admin, auth, req, url, id ?? null);
    return jsonResponse({ error: `Recurso "${resource ?? ''}" não existe. Use: contacts, deals, visits.` }, { status: 404 });
  } catch (err) {
    console.error(JSON.stringify({ event: 'public_api_error', resource, message: err instanceof Error ? err.message : String(err) }));
    return jsonResponse({ error: 'Erro interno.' }, { status: 500 });
  }
});
