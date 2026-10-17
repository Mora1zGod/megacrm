// ============================================================================
// media-retention-purge
// ----------------------------------------------------------------------------
// Retenção de mídia do Atendimento (20261017120000_media_retention.sql).
// Apaga do bucket whatsapp-hub-media SÓ o arquivo das mensagens que passaram do prazo; a mensagem fica
// no histórico com messages.media_purged_at (o chat mostra "Mídia removida pela política de retenção").
//   * Quem decide o que sai: whatsapp_hub.media_retention_candidates (concluída há X horas, mídia com mais de
//     Y dias, nunca contato com a tag "guardar-midia", nunca foto de contato, arquivo compartilhado só se
//     todas as mensagens estiverem no prazo) e media_retention_orphans (arquivo que ninguém usa, > 1 dia).
//   * Apaga SEMPRE pela Storage API (remove, lotes de 100) — DELETE em storage.objects não libera o arquivo.
//
// Chamada:
//   * pg_cron (service role), de hora em hora: todas as orgs ativas com media_retention_enabled = true.
//   * Tela (usuário com settings.edit): só a org do token. POST { dry_run?: boolean (padrão true),
//     confirm?: true (obrigatório para apagar de verdade), include_orphans?: boolean (padrão true) }.
// dry_run = true só lista: totais por regra em arquivos/MB, órfãos e uma amostra dos caminhos. Nada é apagado.
// Resultado real vai para o audit_log da org (action 'media.retention_purge').
// ============================================================================

import { AuthError, requirePermission, requireServiceRole } from '../_shared/auth.ts';
import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { audit, listCandidates, listOrphans, mb, purgeOrg, summarize, type OrgResult } from './logic.ts';

const SAMPLE = 200;
const TIME_BUDGET_MS = 110_000; // a função tem ~150 s; o resto fica para a próxima hora

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const started = Date.now();
  const deadline = started + TIME_BUDGET_MS;
  const admin = getAdminClient();
  const body = (await req.json().catch(() => ({}))) as { dry_run?: boolean; confirm?: boolean; include_orphans?: boolean };
  const includeOrphans = body.include_orphans !== false;

  // 1) Cron (service role): todas as orgs com a retenção ligada.
  let isService = false;
  try { await requireServiceRole(req); isService = true; } catch { /* não é o cron */ }

  try {
    if (isService) {
      const dryRun = body.dry_run === true;
      const { data: cfg, error } = await admin.from('app_settings').select('org_id').eq('media_retention_enabled', true);
      if (error) throw new Error(error.message);
      const orgIds = [...new Set(((cfg ?? []) as Array<{ org_id: string }>).map((r) => r.org_id))];
      const { data: orgs } = orgIds.length
        ? await admin.from('organizations').select('id, name, status').in('id', orgIds)
        : { data: [] as Array<{ id: string; name: string; status: string }> };
      const results: OrgResult[] = [];
      for (const o of (orgs ?? []) as Array<{ id: string; name: string; status: string }>) {
        if (o.status !== 'active' || Date.now() > deadline) continue;
        if (dryRun) {
          results.push(summarize(o.id, o.name, await listCandidates(admin, o.id), includeOrphans ? await listOrphans(admin, o.id) : [], true));
          continue;
        }
        const r = await purgeOrg(admin, o.id, includeOrphans, deadline);
        if (r.marked || r.orphanFiles || r.errors.length) {
          await audit(admin, o.id, { id: null, email: null }, { by: 'cron', ...r, removed_mb: mb(r.removedBytes), orphan_mb: mb(r.orphanBytes) });
        }
        results.push({
          org_id: o.id, org_name: o.name, dry_run: false, files: r.removedFiles, mb: mb(r.removedBytes), by_rule: {},
          orphans: { files: r.orphanFiles, mb: mb(r.orphanBytes) }, messages_marked: r.marked, errors: r.errors,
        });
      }
      return jsonResponse({ ok: true, mode: 'cron', results, ms: Date.now() - started });
    }

    // 2) Tela: só a org do usuário, com settings.edit.
    const caller = await requirePermission(req, 'settings.edit');
    const { data: org } = await admin.from('organizations').select('id, name').eq('id', caller.orgId).maybeSingle();
    const orgName = (org as { name: string } | null)?.name ?? null;
    const dryRun = body.dry_run !== false;

    if (dryRun) {
      const cands = await listCandidates(admin, caller.orgId);
      const orphans = includeOrphans ? await listOrphans(admin, caller.orgId) : [];
      const res = summarize(caller.orgId, orgName, cands, orphans, true);
      res.sample = cands.slice(0, SAMPLE).map((c) => ({ path: c.path, mb: mb(Number(c.bytes ?? 0)), rule: c.rule }));
      return jsonResponse({ ok: true, mode: 'dry_run', results: [res], orphans_sample: orphans.slice(0, 50).map((o) => o.path) });
    }

    if (body.confirm !== true) {
      return jsonResponse({ ok: false, error: 'Para apagar de verdade, confirme (confirm: true). Rode antes a simulação.' }, { status: 400 });
    }
    const { data: setting } = await admin.from('app_settings').select('media_retention_enabled').eq('org_id', caller.orgId).maybeSingle();
    if (!(setting as { media_retention_enabled?: boolean } | null)?.media_retention_enabled) {
      return jsonResponse({ ok: false, error: 'Ligue a retenção de mídia nas configurações antes de limpar.' }, { status: 400 });
    }
    const r = await purgeOrg(admin, caller.orgId, includeOrphans, deadline);
    await audit(admin, caller.orgId, { id: caller.userId, email: caller.email }, { by: 'manual', ...r, removed_mb: mb(r.removedBytes), orphan_mb: mb(r.orphanBytes) });
    const left = (await listCandidates(admin, caller.orgId, 1)).length > 0;
    return jsonResponse({
      ok: true, mode: 'purge',
      results: [{ org_id: caller.orgId, org_name: orgName, dry_run: false, files: r.removedFiles, mb: mb(r.removedBytes), by_rule: {},
        orphans: { files: r.orphanFiles, mb: mb(r.orphanBytes) }, messages_marked: r.marked, errors: r.errors, truncated: left }],
    });
  } catch (err) {
    if (err instanceof AuthError) return jsonResponse({ ok: false, error: err.message }, { status: err.status });
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'media_retention_error', message: msg }));
    if (/media_retention_candidates|schema cache|Could not find the function/i.test(msg)) {
      return jsonResponse({ ok: false, error: 'Falta rodar no Supabase o SQL da retenção de mídia (20261017120000_media_retention).' }, { status: 400 });
    }
    return jsonResponse({ ok: false, error: msg }, { status: 500 });
  }
});
