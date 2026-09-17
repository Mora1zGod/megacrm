import { useAuditLog } from '@/hooks/useAuditLog';

const ACTION_LABELS: Record<string, string> = {
  team_invite: 'Convidou membro da equipe',
  team_remove: 'Removeu membro da equipe',
};

export default function AuditLogPage() {
  const { rows, loading, error } = useAuditLog();

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="mb-4 shrink-0">
        <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Logs de auditoria</h1>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Quem fez o quê, e quando. Cobertura parcial — hoje registra convites e remoções da
          equipe; mais ações entram conforme forem instrumentadas.
        </p>
      </div>

      {error && <p className="text-sm text-[var(--color-error)] mb-3">{error}</p>}

      <div className="flex-1 overflow-y-auto rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)]">
        {loading ? (
          <p className="p-4 text-sm text-[var(--color-text-secondary)]">Carregando...</p>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-sm text-[var(--color-text-secondary)]">
            Nenhum evento registrado ainda.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border-card)] text-left text-xs text-[var(--color-text-secondary)]">
                <th className="px-4 py-2 font-medium">Quando</th>
                <th className="px-4 py-2 font-medium">Quem</th>
                <th className="px-4 py-2 font-medium">Ação</th>
                <th className="px-4 py-2 font-medium">Detalhe</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-[var(--color-border-card)] last:border-0">
                  <td className="px-4 py-2 text-[var(--color-text-secondary)] whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-text-primary)]">{r.actor_email ?? '—'}</td>
                  <td className="px-4 py-2 text-[var(--color-text-primary)]">{ACTION_LABELS[r.action] ?? r.action}</td>
                  <td className="px-4 py-2 text-[var(--color-text-secondary)]">
                    {r.meta ? JSON.stringify(r.meta) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
