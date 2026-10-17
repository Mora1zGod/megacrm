// Lógica da retenção (separada do Deno.serve para poder testar com um cliente falso).
import type { getAdminClient } from '../_shared/supabase-admin.ts';

export const BUCKET = 'whatsapp-hub-media';
export const BATCH = 100;
export const LIST_LIMIT = 50000;

export type Admin = ReturnType<typeof getAdminClient>;
export interface Candidate { path: string; bytes: number | null; message_ids: string[]; rule: 'concluida' | 'antiga' }
export interface Orphan { path: string; bytes: number | null }
export interface OrgResult {
  org_id: string;
  org_name: string | null;
  dry_run: boolean;
  files: number;
  mb: number;
  by_rule: Record<string, { files: number; mb: number }>;
  orphans: { files: number; mb: number };
  messages_marked?: number;
  removed_files?: number;
  removed_mb?: number;
  errors?: string[];
  sample?: Array<{ path: string; mb: number; rule: string }>;
  truncated?: boolean;
}

export const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;

export async function listCandidates(admin: Admin, orgId: string, limit = LIST_LIMIT): Promise<Candidate[]> {
  const { data, error } = await admin.rpc('media_retention_candidates', { p_org: orgId, p_limit: limit });
  if (error) throw new Error(`candidatos: ${error.message}`);
  return (data ?? []) as Candidate[];
}
export async function listOrphans(admin: Admin, orgId: string, limit = LIST_LIMIT): Promise<Orphan[]> {
  const { data, error } = await admin.rpc('media_retention_orphans', { p_org: orgId, p_limit: limit });
  if (error) throw new Error(`órfãos: ${error.message}`);
  return (data ?? []) as Orphan[];
}

export function summarize(orgId: string, orgName: string | null, cands: Candidate[], orphans: Orphan[], dryRun: boolean): OrgResult {
  const byRule: Record<string, { files: number; bytes: number }> = {};
  let bytes = 0;
  for (const c of cands) {
    const b = Number(c.bytes ?? 0);
    bytes += b;
    byRule[c.rule] = byRule[c.rule] ?? { files: 0, bytes: 0 };
    byRule[c.rule].files++;
    byRule[c.rule].bytes += b;
  }
  const orphanBytes = orphans.reduce((a, o) => a + Number(o.bytes ?? 0), 0);
  return {
    org_id: orgId,
    org_name: orgName,
    dry_run: dryRun,
    files: cands.length,
    mb: mb(bytes),
    by_rule: Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, { files: v.files, mb: mb(v.bytes) }])),
    orphans: { files: orphans.length, mb: mb(orphanBytes) },
    truncated: cands.length >= LIST_LIMIT || orphans.length >= LIST_LIMIT,
  };
}

// Remove em lotes de 100 pela Storage API e marca as mensagens. Arquivo que já não existe no bucket
// (bytes null) só é marcado. Se o remove de um lote falhar, aquele lote NÃO é marcado.
export async function purgeOrg(admin: Admin, orgId: string, includeOrphans: boolean, deadline: number) {
  let removedFiles = 0, removedBytes = 0, marked = 0;
  const errors: string[] = [];
  const doneMessages = new Set<string>();

  while (Date.now() < deadline) {
    const cands = (await listCandidates(admin, orgId, 1000)).filter((c) => !c.message_ids.every((id) => doneMessages.has(id)));
    if (!cands.length) break;
    for (let i = 0; i < cands.length && Date.now() < deadline; i += BATCH) {
      const batch = cands.slice(i, i + BATCH);
      const present = batch.filter((c) => c.bytes !== null).map((c) => c.path);
      if (present.length) {
        const { data, error } = await admin.storage.from(BUCKET).remove(present);
        if (error) { errors.push(`remove: ${error.message}`); continue; }
        removedFiles += (data ?? []).length;
        removedBytes += batch.filter((c) => c.bytes !== null).reduce((a, c) => a + Number(c.bytes ?? 0), 0);
      }
      const ids = batch.flatMap((c) => c.message_ids);
      const { error: upErr } = await admin.from('messages').update({ media_purged_at: new Date().toISOString() })
        .in('id', ids).eq('org_id', orgId).is('media_purged_at', null);
      if (upErr) errors.push(`marcar: ${upErr.message}`);
      else marked += ids.length;
      ids.forEach((id) => doneMessages.add(id));
    }
    if (errors.length > 5) break;
  }

  let orphanFiles = 0, orphanBytes = 0;
  if (includeOrphans && Date.now() < deadline) {
    const orphans = await listOrphans(admin, orgId, 5000);
    for (let i = 0; i < orphans.length && Date.now() < deadline; i += BATCH) {
      const batch = orphans.slice(i, i + BATCH);
      const { data, error } = await admin.storage.from(BUCKET).remove(batch.map((o) => o.path));
      if (error) { errors.push(`órfãos: ${error.message}`); continue; }
      orphanFiles += (data ?? []).length;
      orphanBytes += batch.reduce((a, o) => a + Number(o.bytes ?? 0), 0);
    }
  }
  return { removedFiles, removedBytes, marked, orphanFiles, orphanBytes, errors };
}

export async function audit(admin: Admin, orgId: string, actor: { id: string | null; email: string | null }, meta: Record<string, unknown>) {
  const { error } = await admin.from('audit_log').insert({
    org_id: orgId, actor_id: actor.id, actor_email: actor.email,
    action: 'media.retention_purge', entity_type: 'storage', entity_id: null, meta,
  });
  if (error) console.error(JSON.stringify({ event: 'media_retention_audit_failed', org_id: orgId, message: error.message }));
}

