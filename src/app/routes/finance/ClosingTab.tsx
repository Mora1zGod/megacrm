import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Lock, LockOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { addDays, fmtDate, fmtDateTime, rpc, todaySP, type Company, type Lookups } from './data';
import { AuditList } from './AuditList';
import { EmptyRow, Field, inputCls, ReasonDialog, TableWrap, tdCls, thCls } from './ui';

interface PeriodLock { company_id: string; closed_until: string | null; last_reason: string | null; updated_at: string }

// Fechamento de período por empresa: nada entra, muda ou é estornado com data até o fechamento.
export function ClosingTab({ lookups }: { lookups: Lookups }) {
  const perms = usePermission();
  const [locks, setLocks] = useState<PeriodLock[]>([]);
  const [closing, setClosing] = useState<Company | null>(null);
  const [reopening, setReopening] = useState<{ company: Company; lock: PeriodLock } | null>(null);

  const load = useCallback(async () => {
    const { data } = await getSupabase().from('fin_period_locks').select('*');
    setLocks((data ?? []) as PeriodLock[]);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const can = perms.can('financial.period_close');
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--color-text-secondary)]">
        Fechar o período trava o financeiro da empresa até a data escolhida: nenhum lançamento, baixa, transferência ou estorno pode usar uma data dentro do período fechado.
      </p>
      <TableWrap minWidth={640}>
        <thead><tr className="border-b border-[var(--color-border-card)]">
          <th className={thCls}>Empresa</th><th className={thCls}>Fechado até</th><th className={thCls}>Última ação</th><th className={`${thCls} text-right`}>Ações</th>
        </tr></thead>
        <tbody>
          {lookups.companies.length === 0 && <EmptyRow cols={4} text="Cadastre as empresas primeiro." />}
          {lookups.companies.map((c) => {
            const l = locks.find((x) => x.company_id === c.id);
            return (
              <tr key={c.id} className="border-b border-[var(--color-border-soft)] last:border-0">
                <td className={tdCls}><b>{c.name}</b>{c.is_default && <span className="ml-1 text-xs text-[var(--color-text-muted)]">(padrão)</span>}</td>
                <td className={tdCls}>{l?.closed_until ? <span className="inline-flex items-center gap-1 font-semibold"><Lock className="h-3.5 w-3.5" /> {fmtDate(l.closed_until)}</span> : <span className="text-[var(--color-text-muted)]">Aberto</span>}</td>
                <td className={`${tdCls} text-xs text-[var(--color-text-secondary)]`}>{l ? `${l.last_reason ?? ''} · ${fmtDateTime(l.updated_at)}` : '—'}</td>
                <td className={`${tdCls} text-right`}>
                  {can && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => setClosing(c)}><Lock className="h-3.5 w-3.5" /> Fechar</Button>
                      {l?.closed_until && <Button size="sm" variant="outline" onClick={() => setReopening({ company: c, lock: l })}><LockOpen className="h-3.5 w-3.5" /> Reabrir</Button>}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>

      <h3 className="text-sm font-semibold">Histórico de fechamentos</h3>
      <AuditList tables={['fin_period_locks']} />

      {closing && <CloseDialog company={closing} current={locks.find((l) => l.company_id === closing.id)?.closed_until ?? null}
        onClose={() => setClosing(null)} onDone={() => { setClosing(null); void load(); }} />}
      {reopening && (
        <ReopenDialog company={reopening.company} lock={reopening.lock} onClose={() => setReopening(null)} onDone={() => { setReopening(null); void load(); }} />
      )}
    </div>
  );
}

function CloseDialog({ company, current, onClose, onDone }: { company: Company; current: string | null; onClose: () => void; onDone: () => void }) {
  const yesterday = addDays(todaySP(), -1);
  const [until, setUntil] = useState(yesterday);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onClose={onClose} title={`Fechar período · ${company.name}`} description={current ? `Hoje está fechado até ${fmtDate(current)}.` : 'O período desta empresa está aberto.'}>
      <Field label="Fechar até (inclusive)" required htmlFor="cl-until" hint="Só até ontem ou antes.">
        <input id="cl-until" type="date" max={yesterday} value={until} onChange={(e) => setUntil(e.target.value)} className={inputCls} />
      </Field>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button disabled={busy} onClick={async () => {
          setBusy(true);
          try { await rpc('fin_close_period', { p_company: company.id, p_until: until }); toast.success(`Financeiro de ${company.name} fechado até ${fmtDate(until)}.`); onDone(); }
          catch (e) { toast.error('Não foi possível fechar', { description: e instanceof Error ? e.message : String(e) }); }
          finally { setBusy(false); }
        }}><Lock className="h-4 w-4" /> Fechar período</Button>
      </div>
    </Dialog>
  );
}

function ReopenDialog({ company, lock, onClose, onDone }: { company: Company; lock: PeriodLock; onClose: () => void; onDone: () => void }) {
  const [until, setUntil] = useState('');
  return (
    <ReasonDialog title={`Reabrir período · ${company.name}`} confirmLabel="Reabrir"
      description={`Fechado até ${fmtDate(lock.closed_until)}. A reabertura fica registrada na auditoria.`}
      extra={
        <div className="mb-3">
          <Field label="Novo fechamento (opcional)" htmlFor="ro-until" hint="Deixe em branco para reabrir tudo, ou escolha uma data anterior.">
            <input id="ro-until" type="date" max={lock.closed_until ? addDays(lock.closed_until, -1) : undefined} value={until} onChange={(e) => setUntil(e.target.value)} className={inputCls} />
          </Field>
        </div>
      }
      onClose={onClose}
      onConfirm={async (reason) => {
        try { await rpc('fin_reopen_period', { p_company: company.id, p_until: until || null, p_reason: reason }); toast.success('Período reaberto.'); onDone(); }
        catch (e) { toast.error('Não foi possível reabrir', { description: e instanceof Error ? e.message : String(e) }); }
      }} />
  );
}
