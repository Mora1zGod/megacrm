import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { HardDrive, Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { KEEP_MEDIA_TAG } from '@/lib/mediaRetention';

// Configurações → Atendimento → Retenção de mídia (20261017120000_media_retention.sql + edge media-retention-purge).
const inputCls =
  'h-10 w-24 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

interface Cfg { enabled: boolean; hours: number; days: number }
interface Result {
  files: number; mb: number; by_rule: Record<string, { files: number; mb: number }>;
  orphans: { files: number; mb: number }; messages_marked?: number; errors?: string[]; truncated?: boolean;
}
const RULE_LABEL: Record<string, string> = { concluida: 'Conversas concluídas', antiga: 'Mídia antiga' };
const brMb = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

async function callPurge(body: Record<string, unknown>): Promise<{ results: Result[] }> {
  const { data, error } = await getSupabase().functions.invoke('media-retention-purge', { body });
  const res = data as { ok?: boolean; error?: string; results?: Result[] } | null;
  if (error || !res?.ok) {
    let msg = res?.error ?? error?.message ?? 'Falha';
    const ctx = (error as { context?: Response } | null)?.context;
    if (ctx && typeof ctx.json === 'function') {
      const j = await ctx.json().catch(() => null) as { error?: string } | null;
      if (j?.error) msg = j.error;
    }
    throw new Error(msg);
  }
  return { results: res.results ?? [] };
}

export function MediaRetentionSettings() {
  const { orgId } = useAppUser();
  const perms = usePermission();
  const canEdit = perms.can('settings.edit');
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [missing, setMissing] = useState(false);
  const [hours, setHours] = useState('24');
  const [days, setDays] = useState('30');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'dry' | 'purge' | null>(null);
  const [preview, setPreview] = useState<Result | null>(null);
  const [lastPurge, setLastPurge] = useState<Result | null>(null);

  useEffect(() => {
    if (!orgId) return;
    void getSupabase().from('app_settings').select('*').eq('org_id', orgId).limit(1).maybeSingle().then(({ data }) => {
      const row = data as { media_retention_enabled?: boolean; purge_on_close_after_hours?: number; purge_inactive_after_days?: number } | null;
      if (!row || row.media_retention_enabled === undefined) { setMissing(true); return; }
      const c = { enabled: row.media_retention_enabled, hours: row.purge_on_close_after_hours ?? 24, days: row.purge_inactive_after_days ?? 30 };
      setCfg(c); setHours(String(c.hours)); setDays(String(c.days));
    });
  }, [orgId]);

  const save = async (enabled: boolean) => {
    if (!orgId || !cfg) return;
    const h = Number(hours), d = Number(days);
    if (!Number.isInteger(h) || h < 1 || h > 8760) { toast.error('Horas depois de concluir: número inteiro de 1 a 8760.'); return; }
    if (!Number.isInteger(d) || d < 1 || d > 3650) { toast.error('Dias: número inteiro de 1 a 3650.'); return; }
    setSaving(true);
    const { error } = await getSupabase().from('app_settings')
      .update({ media_retention_enabled: enabled, purge_on_close_after_hours: h, purge_inactive_after_days: d }).eq('org_id', orgId);
    setSaving(false);
    if (error) { toast.error('Não foi possível salvar', { description: error.message }); return; }
    setCfg({ enabled, hours: h, days: d });
    toast.success(enabled ? 'Retenção de mídia ligada. A limpeza roda de hora em hora.' : 'Retenção de mídia salva (desligada).');
  };

  const simulate = async () => {
    setBusy('dry');
    try { setPreview((await callPurge({ dry_run: true })).results[0] ?? null); }
    catch (e) { toast.error('Não foi possível simular', { description: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(null); }
  };

  const purgeNow = async () => {
    if (!preview) return;
    const total = preview.mb + preview.orphans.mb;
    if (!window.confirm(`Apagar agora ${preview.files + preview.orphans.files} arquivo(s) (${brMb(total)} MB) do Storage?\n\nAs mensagens continuam no histórico com o aviso de mídia removida. Isto não tem volta.`)) return;
    setBusy('purge');
    try {
      const r = (await callPurge({ dry_run: false, confirm: true })).results[0] ?? null;
      setLastPurge(r); setPreview(null);
      toast.success(`Limpeza feita: ${r?.files ?? 0} arquivo(s) e ${r?.orphans.files ?? 0} órfão(s).`, {
        description: r?.truncated ? 'Ainda há arquivos para sair — o restante sai nas próximas horas (ou clique de novo).' : undefined,
      });
    } catch (e) {
      toast.error('Não foi possível limpar', { description: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(null); }
  };

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center gap-2 text-base font-semibold text-[var(--color-text-primary)]">
        <HardDrive className="h-4 w-4 text-[var(--accent-primary)]" /> Retenção de mídia
      </div>
      <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
        Apaga do armazenamento as fotos, áudios, vídeos e documentos antigos das conversas. A mensagem continua no histórico com o
        aviso “Mídia removida pela política de retenção”. Contato com a etiqueta <b>{KEEP_MEDIA_TAG}</b> nunca perde a mídia
        (ligue no menu ⋮ da conversa). Antes de apagar dá para baixar tudo em <b>.zip</b> pelo mesmo menu.
      </p>
      {missing ? (
        <p className="rounded-lg bg-[var(--color-surface-hover)] p-3 text-sm">Falta rodar no Supabase o SQL da retenção de mídia (20261017120000_media_retention).</p>
      ) : !cfg ? <Loader2 className="h-4 w-4 animate-spin" /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <Label htmlFor="ret-hours">Conversa concluída: apagar depois de (horas)</Label>
              <input id="ret-hours" type="number" min={1} max={8760} value={hours} disabled={!canEdit} onChange={(e) => setHours(e.target.value)} className={inputCls} />
            </div>
            <div>
              <Label htmlFor="ret-days">Qualquer mídia com mais de (dias)</Label>
              <input id="ret-days" type="number" min={1} max={3650} value={days} disabled={!canEdit} onChange={(e) => setDays(e.target.value)} className={inputCls} />
            </div>
            {canEdit && (
              <>
                <Button variant="outline" disabled={saving} onClick={() => void save(cfg.enabled)}>Salvar prazos</Button>
                <Button disabled={saving} onClick={() => void save(!cfg.enabled)} variant={cfg.enabled ? 'outline' : 'default'}>
                  {cfg.enabled ? 'Desligar a retenção' : 'Ligar a retenção'}
                </Button>
              </>
            )}
          </div>
          <div className="text-sm">
            Situação: {cfg.enabled
              ? <b className="text-[var(--color-success)]">ligada — roda sozinha de hora em hora</b>
              : <b className="text-[var(--color-text-secondary)]">desligada — nada é apagado</b>}
          </div>

          {canEdit && (
            <div className="space-y-3 border-t border-[var(--color-border-soft)] pt-4">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy !== null} onClick={() => void simulate()}>
                  {busy === 'dry' ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Simular (não apaga nada)
                </Button>
                {preview && cfg.enabled && preview.files + preview.orphans.files > 0 && (
                  <Button disabled={busy !== null} onClick={() => void purgeNow()} className="bg-[var(--color-error)] hover:opacity-90">
                    {busy === 'purge' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Apagar agora
                  </Button>
                )}
              </div>
              {preview && (
                <div className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] p-3 text-sm">
                  <div className="font-semibold">Sairia agora: {preview.files} arquivo(s) · {brMb(preview.mb)} MB{preview.truncated ? ' (ou mais)' : ''}</div>
                  <ul className="mt-1 text-[var(--color-text-secondary)]">
                    {Object.entries(preview.by_rule).map(([k, v]) => <li key={k}>{RULE_LABEL[k] ?? k}: {v.files} · {brMb(v.mb)} MB</li>)}
                    <li>Arquivos órfãos (sem nenhuma mensagem): {preview.orphans.files} · {brMb(preview.orphans.mb)} MB</li>
                  </ul>
                  {!cfg.enabled && <p className="mt-2 text-xs text-[var(--color-text-muted)]">Para apagar, ligue a retenção primeiro.</p>}
                </div>
              )}
              {lastPurge && (
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Última limpeza: {lastPurge.files} arquivo(s) ({brMb(lastPurge.mb)} MB), {lastPurge.orphans.files} órfão(s), {lastPurge.messages_marked ?? 0} mensagem(ns) marcadas.
                  {lastPurge.errors?.length ? ` Erros: ${lastPurge.errors.join('; ')}` : ''}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
