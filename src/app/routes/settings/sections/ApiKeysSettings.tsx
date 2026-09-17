import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy, Key, Plus, Trash2 } from 'lucide-react';
import { useApiKeys } from '@/hooks/useApiKeys';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

const BASE_URL = 'https://hneqnopjvvwquyqogwdu.supabase.co/functions/v1/public-api';

export function ApiKeysSettings() {
  const { keys, loading, createKey, revokeKey } = useApiKeys();
  const [novaOpen, setNovaOpen] = useState(false);
  const [novaChave, setNovaChave] = useState<string | null>(null);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">API do CRM</h3>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Chaves pra você integrar outros sistemas seus com o CRM (ler e criar contatos, negócios e visitas).
        </p>
      </div>

      <div className="rounded-lg border border-[rgba(14,154,160,0.15)] bg-white/[0.02] p-4 space-y-2 text-sm">
        <div className="font-semibold text-[var(--color-text-primary)]">Como usar</div>
        <p className="text-[var(--color-text-secondary)]">
          Toda chamada precisa do header <code className="text-[var(--accent-primary)]">Authorization: Bearer sua_chave</code>.
        </p>
        <pre className="rounded-lg bg-black/30 p-3 text-xs text-[var(--color-text-secondary)] overflow-x-auto">
{`curl "${BASE_URL}/contacts" \\
  -H "Authorization: Bearer amai_live_..."`}
        </pre>
        <p className="text-[var(--color-text-secondary)]">
          Recursos disponíveis: <code>/contacts</code>, <code>/deals</code>, <code>/visits</code> — GET (listar/ver), POST (criar), PATCH (atualizar).
        </p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[var(--color-text-primary)]">Suas chaves</span>
        <Button onClick={() => setNovaOpen(true)}>
          <Plus className="h-4 w-4" /> Gerar nova chave
        </Button>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-text-secondary)]">Carregando...</p>
      ) : keys.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[rgba(148,163,184,0.25)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
          Nenhuma chave gerada ainda.
        </div>
      ) : (
        <div className="space-y-2">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-3 rounded-lg border border-[rgba(14,154,160,0.12)] px-4 py-2.5">
              <div className="flex items-center gap-2.5 min-w-0">
                <Key className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                <div className="min-w-0">
                  <div className="text-sm text-[var(--color-text-primary)] truncate">{k.label}</div>
                  <div className="text-xs text-[var(--color-text-secondary)] font-mono">
                    {k.key_prefix}••••••••
                    {k.revoked_at && <span className="ml-2 text-[#EF4444]">revogada</span>}
                    {k.last_used_at && !k.revoked_at && (
                      <span className="ml-2 opacity-70">usada em {new Date(k.last_used_at).toLocaleDateString('pt-BR')}</span>
                    )}
                  </div>
                </div>
              </div>
              {!k.revoked_at && (
                <button
                  onClick={() => {
                    if (!window.confirm(`Revogar "${k.label}"? Quem estiver usando essa chave para de funcionar na hora.`)) return;
                    void revokeKey(k.id).then(() => toast.success('Chave revogada.')).catch((e) => toast.error('Falha', { description: e.message }));
                  }}
                  aria-label="Revogar"
                  className="shrink-0 rounded-lg border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.08)] p-2 text-[#F87171] hover:bg-[rgba(239,68,68,0.16)]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {novaOpen && (
        <NovaChaveDialog
          onClose={() => { setNovaOpen(false); setNovaChave(null); }}
          onCreate={async (label) => {
            const full = await createKey(label);
            setNovaChave(full);
          }}
          fullKey={novaChave}
        />
      )}
    </div>
  );
}

function NovaChaveDialog({
  onClose, onCreate, fullKey,
}: { onClose: () => void; onCreate: (label: string) => Promise<void>; fullKey: string | null }) {
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const gerar = async () => {
    if (!label.trim()) { toast.error('Dê um nome pra essa chave.'); return; }
    setSaving(true);
    try {
      await onCreate(label.trim());
    } catch (err) {
      toast.error('Falha ao gerar', { description: err instanceof Error ? err.message : undefined });
    } finally {
      setSaving(false);
    }
  };

  if (fullKey) {
    return (
      <Dialog open onClose={onClose} title="Chave gerada">
        <div className="space-y-3">
          <div className="rounded-lg border border-[rgba(245,158,11,0.3)] bg-[rgba(245,158,11,0.08)] px-3 py-2 text-xs text-[#FBBF24]">
            Copia agora — essa chave não vai aparecer de novo. Se perder, precisa revogar e gerar outra.
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-card)] bg-black/30 px-3 py-2">
            <code className="flex-1 text-xs text-[var(--color-text-primary)] break-all">{fullKey}</code>
            <button
              onClick={() => { navigator.clipboard.writeText(fullKey); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
              className="shrink-0 text-[var(--accent-primary)]"
              aria-label="Copiar"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <div className="flex justify-end pt-4">
          <Button onClick={onClose}>Fechar</Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open onClose={onClose} title="Gerar nova chave">
      <div className="space-y-3">
        <div>
          <Label htmlFor="key-label">Nome (pra você reconhecer depois)</Label>
          <input
            id="key-label"
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ex.: Site institucional, Uniklin CRM..."
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void gerar()} disabled={saving || !label.trim()}>{saving ? 'Gerando...' : 'Gerar chave'}</Button>
      </div>
    </Dialog>
  );
}
