// ============================================================================
// instagram-profile-backfill
// ----------------------------------------------------------------------------
// Completa nome de exibição + @usuário dos contatos do Instagram que já existem
// (20261016100000_inbox_search_instagram.sql). Idempotente.
//
// POST { apply?: boolean, cursor?: string | null }
//   apply=false (padrão) → DRY-RUN: só lista o que mudaria, não grava nada.
//   apply=true           → grava as mesmas regras.
// Processa até 100 contatos por chamada (ordem de id); devolve next_cursor
// para a próxima página (null = acabou).
//
// Fonte do nome: rota de perfil do Zernio (GET /accounts/{accountId}/follow-status/{IGSID}
// → username + name). Sem resposta do Zernio: se o nome atual é claramente um @
// ("danielgato2015.da"), copia para instagram_username e deixa o nome de exibição
// para a próxima mensagem recebida. Nome editado pela equipe nunca é trocado.
// Permissão: settings.edit da organização em uso. Só mexe em contatos da org do token.
// ============================================================================

import { requirePermission, AuthError } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { getCredential } from '../_shared/credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { getInstagramProfile, type InstagramProfile } from '../_shared/zernio.ts';
import { decideIgIdentity, needsProfileLookup } from '../_shared/instagram-identity.ts';

const PAGE = 100;
const CONCURRENCY = 5;

interface Row {
  id: string;
  name: string | null;
  instagram_id: string;
  instagram_username: string | null;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const caller = await requirePermission(req, 'settings.edit');
    const body = (await req.json().catch(() => ({}))) as { apply?: boolean; cursor?: string | null };
    const apply = body.apply === true;
    const admin = getAdminClient();

    let q = admin
      .from('contacts')
      .select('id, name, instagram_id, instagram_username')
      .eq('org_id', caller.orgId)
      .not('instagram_id', 'is', null)
      .order('id')
      .limit(PAGE);
    if (body.cursor) q = q.gt('id', body.cursor);
    const { data, error } = await q;
    if (error) {
      if (/instagram_username/.test(error.message)) {
        return jsonResponse({ ok: false, error: 'Falta rodar no Supabase o SQL da busca da inbox (20261016100000_inbox_search_instagram).' }, { status: 400 });
      }
      throw error;
    }
    const rows = (data ?? []) as Row[];
    const next_cursor = rows.length === PAGE ? rows[rows.length - 1].id : null;
    const todo = rows.filter((r) => needsProfileLookup({ name: r.name, username: r.instagram_username }, r.instagram_id, null));

    // Conta do Instagram no Zernio de cada contato = a da conversa mais recente dele.
    const accountByContact = new Map<string, string>();
    if (todo.length) {
      const { data: convs } = await admin
        .from('conversations')
        .select('contact_id, zernio_account_id, last_message_at')
        .eq('org_id', caller.orgId)
        .eq('channel', 'instagram')
        .not('zernio_account_id', 'is', null)
        .in('contact_id', todo.map((r) => r.id))
        .order('last_message_at', { ascending: false, nullsFirst: false });
      for (const c of (convs ?? []) as Array<{ contact_id: string; zernio_account_id: string }>) {
        if (!accountByContact.has(c.contact_id)) accountByContact.set(c.contact_id, c.zernio_account_id);
      }
    }
    const apiKey = (await getCredential(caller.orgId, 'zernio_api_key'))?.trim() || null;

    const changes: Array<{
      contact_id: string;
      current_name: string | null;
      current_username: string | null;
      new_name: string | null;
      new_username: string | null;
      source: 'zernio' | 'nome_atual';
    }> = [];
    let profileFailures = 0;

    const work = todo.slice();
    async function worker() {
      for (let r = work.shift(); r; r = work.shift()) {
        const accountId = accountByContact.get(r.id) ?? null;
        let profile: InstagramProfile | null = null;
        const canLookup = !!apiKey && !!accountId && /^\d+$/.test(r.instagram_id);
        if (canLookup) {
          profile = await getInstagramProfile({ apiKey: apiKey!, accountId: accountId!, userId: r.instagram_id });
          if (!profile) profileFailures++;
        }
        const current = { name: r.name, username: r.instagram_username };
        const patch = decideIgIdentity({ current, igId: r.instagram_id, payloadName: r.name, payloadUsername: null, profile });
        if (!patch.name && !patch.instagram_username) {
          if (apply && canLookup) {
            await admin.from('contacts').update({ instagram_profile_checked_at: new Date().toISOString() }).eq('id', r.id).eq('org_id', caller.orgId);
          }
          continue;
        }
        changes.push({
          contact_id: r.id,
          current_name: r.name,
          current_username: r.instagram_username,
          new_name: patch.name ?? r.name,
          new_username: patch.instagram_username ?? r.instagram_username,
          source: profile ? 'zernio' : 'nome_atual',
        });
        if (apply) {
          await admin
            .from('contacts')
            .update({ ...patch, ...(canLookup ? { instagram_profile_checked_at: new Date().toISOString() } : {}) })
            .eq('id', r.id)
            .eq('org_id', caller.orgId);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    return jsonResponse({
      ok: true,
      apply,
      scanned: rows.length,
      candidates: todo.length,
      profile_failures: profileFailures,
      changes,
      next_cursor,
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    console.error('instagram-profile-backfill error', err);
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Erro interno' }, { status: 500 });
  }
});
