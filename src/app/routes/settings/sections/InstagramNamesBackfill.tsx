import { useState } from 'react';
import { Instagram } from 'lucide-react';
import { toast } from 'sonner';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';

// Completar nome de exibição + @ dos contatos do Instagram que já existem (função
// instagram-profile-backfill). Primeiro mostra o que mudaria (nada é gravado); só grava ao confirmar.
interface Change {
  contact_id: string;
  current_name: string | null;
  current_username: string | null;
  new_name: string | null;
  new_username: string | null;
  source: 'zernio' | 'nome_atual';
}

async function runAll(apply: boolean): Promise<{ changes: Change[]; scanned: number; failures: number }> {
  const supabase = getSupabase();
  const changes: Change[] = [];
  let scanned = 0;
  let failures = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const { data, error } = await supabase.functions.invoke('instagram-profile-backfill', { body: { apply, cursor } });
    const body = data as { ok?: boolean; error?: string; changes?: Change[]; scanned?: number; profile_failures?: number; next_cursor?: string | null } | null;
    if (error || !body?.ok) {
      let msg = body?.error ?? error?.message ?? 'Falha';
      const ctx = (error as { context?: Response } | null)?.context;
      if (ctx && typeof ctx.json === 'function') {
        const j = await ctx.json().catch(() => null) as { error?: string } | null;
        if (j?.error) msg = j.error;
      }
      throw new Error(msg);
    }
    changes.push(...(body.changes ?? []));
    scanned += body.scanned ?? 0;
    failures += body.profile_failures ?? 0;
    cursor = body.next_cursor ?? null;
    if (!cursor) break;
  }
  return { changes, scanned, failures };
}

export function InstagramNamesBackfill() {
  const perms = usePermission();
  const [busy, setBusy] = useState<'dry' | 'apply' | null>(null);
  const [preview, setPreview] = useState<{ changes: Change[]; scanned: number; failures: number } | null>(null);

  const dryRun = async () => {
    setBusy('dry');
    try {
      setPreview(await runAll(false));
    } catch (e) {
      toast.error('Não foi possível conferir', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy('apply');
    try {
      const r = await runAll(true);
      toast.success(r.changes.length ? `${r.changes.length} contato(s) atualizado(s).` : 'Nada para atualizar.');
      setPreview(null);
    } catch (e) {
      toast.error('Não foi possível atualizar', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  if (!perms.can('settings.edit')) return null;
  return (
    <section>
      <div className="glass-card space-y-3 p-5">
        <div className="flex items-center gap-2">
          <Instagram className="h-4 w-4 text-[#E1306C]" />
          <div className="text-sm font-semibold text-[var(--color-text-primary)]">Nomes dos contatos do Instagram</div>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Completa o nome de exibição e o @ dos contatos que entraram pelo Instagram. Nome editado pela equipe não é
          trocado. Primeiro mostra o que vai mudar; só grava quando você confirmar.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void dryRun()}
            disabled={busy !== null}
            className="rounded-lg border border-[var(--color-border-card)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-60"
          >
            {busy === 'dry' ? 'Conferindo…' : 'Ver o que muda'}
          </button>
          {preview && preview.changes.length > 0 && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={busy !== null}
              className="rounded-lg bg-[var(--accent-fill)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--accent-fill-hover)] disabled:opacity-60"
            >
              {busy === 'apply' ? 'Atualizando…' : `Aplicar em ${preview.changes.length} contato(s)`}
            </button>
          )}
        </div>
        {preview && (
          <div className="space-y-2">
            <div className="text-xs text-[var(--color-text-muted)]">
              {preview.scanned} contato(s) do Instagram conferido(s) · {preview.changes.length} mudaria(m)
              {preview.failures > 0 && ` · ${preview.failures} sem resposta do Zernio (usa o nome atual quando ele é claramente um @)`}
            </div>
            {preview.changes.length > 0 && (
              <div className="max-h-72 overflow-auto rounded-lg border border-[var(--color-border-soft)]">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--color-fill-subtle)] text-left text-[var(--color-text-secondary)]">
                    <tr><th className="px-2 py-1.5">Hoje</th><th className="px-2 py-1.5">Fica</th><th className="px-2 py-1.5">Fonte</th></tr>
                  </thead>
                  <tbody>
                    {preview.changes.map((c) => (
                      <tr key={c.contact_id} className="border-t border-[var(--color-border-soft)]">
                        <td className="px-2 py-1.5">
                          <div className="text-[var(--color-text-primary)]">{c.current_name || '—'}</div>
                          <div className="text-[var(--color-text-muted)]">{c.current_username ? `@${c.current_username}` : 'sem @'}</div>
                        </td>
                        <td className="px-2 py-1.5">
                          <div className="text-[var(--color-text-primary)]">{c.new_name || '—'}</div>
                          <div className="text-[var(--color-text-muted)]">{c.new_username ? `@${c.new_username}` : 'sem @'}</div>
                        </td>
                        <td className="px-2 py-1.5 text-[var(--color-text-secondary)]">{c.source === 'zernio' ? 'Perfil no Zernio' : 'Nome atual (é um @)'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
