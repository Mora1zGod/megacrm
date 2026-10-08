import { useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { useFinanceLookups } from './data';
import { EntriesTab } from './EntriesTab';
import { BanksTab } from './BanksTab';
import { ReportsTab } from './ReportsTab';
import { ClosingTab } from './ClosingTab';
import { SetupTab } from './SetupTab';
import { SettingsTab } from './SettingsTab';
import { AuditList } from './AuditList';

type Tab = 'pagar' | 'receber' | 'bancos' | 'relatorios' | 'fechamento' | 'cadastros' | 'config' | 'auditoria';

// Financeiro do grupo (várias empresas na mesma organização).
export default function FinancePage() {
  const perms = usePermission();
  const lookups = useFinanceLookups();
  const [params, setParams] = useSearchParams();
  const tabs: [Tab, string, boolean][] = [
    ['pagar', 'Contas a pagar', true],
    ['receber', 'Contas a receber', true],
    ['bancos', 'Bancos e transferências', true],
    ['relatorios', 'Relatórios', perms.can('financial.ledger_reports')],
    ['fechamento', 'Fechamento', true],
    ['cadastros', 'Cadastros', true],
    ['config', 'Configurações', perms.can('financial.setup')],
    ['auditoria', 'Auditoria', perms.can('audit.view') || perms.can('financial.setup')],
  ];
  const visible = tabs.filter(([, , show]) => show);
  const tab = (visible.find(([k]) => k === params.get('tab'))?.[0] ?? 'pagar') as Tab;
  const setTab = (t: Tab) => setParams((p) => { p.set('tab', t); return p; }, { replace: true });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><Wallet className="h-5 w-5" /></span>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Financeiro</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Contas a pagar e a receber, bancos, fechamento e relatórios de todas as empresas do grupo.</p>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border-card)] print:hidden" role="tablist">
        {visible.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn('-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors',
              tab === id ? 'border-[var(--accent-fill)] text-[var(--accent-primary)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]')}>
            {label}
          </button>
        ))}
      </div>

      {lookups.error && (
        <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{lookups.error}</div>
      )}

      <div className="min-h-0 flex-1">
        {tab === 'pagar' && <EntriesTab key="payable" kind="payable" lookups={lookups} />}
        {tab === 'receber' && <EntriesTab key="receivable" kind="receivable" lookups={lookups} />}
        {tab === 'bancos' && <BanksTab lookups={lookups} />}
        {tab === 'relatorios' && <ReportsTab lookups={lookups} />}
        {tab === 'fechamento' && <ClosingTab lookups={lookups} />}
        {tab === 'cadastros' && <SetupTab lookups={lookups} />}
        {tab === 'config' && <SettingsTab />}
        {tab === 'auditoria' && <AuditList />}
      </div>
    </div>
  );
}
