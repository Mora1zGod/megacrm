import { useSearchParams } from 'react-router-dom';
import { ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { usePurLookups } from './data';
import { RequisitionsTab } from './RequisitionsTab';
import { QuotationsTab } from './QuotationsTab';
import { OrdersTab } from './OrdersTab';
import { ReceiptsTab } from './ReceiptsTab';
import { InvoicesTab } from './InvoicesTab';
import { SuppliersTab } from './SuppliersTab';
import { CatalogTab } from './CatalogTab';
import { PurchaseSettingsTab } from './PurchaseSettingsTab';

export type PurTab = 'requisicoes' | 'cotacoes' | 'pedidos' | 'recebimentos' | 'notas' | 'fornecedores' | 'itens' | 'config';
const KIND_TAB: Record<string, PurTab> = { requisition: 'requisicoes', quotation: 'cotacoes', order: 'pedidos', receipt: 'recebimentos', invoice: 'notas', supplier: 'fornecedores' };

// Compras: Requisição → Cotação → Pedido → Recebimento → Nota de entrada.
export default function PurchasesPage() {
  const perms = usePermission();
  const lookups = usePurLookups();
  const [params, setParams] = useSearchParams();
  const tabs: [PurTab, string, boolean][] = [
    ['requisicoes', 'Requisições', true],
    ['cotacoes', 'Cotações', true],
    ['pedidos', 'Pedidos', true],
    ['recebimentos', 'Recebimentos', true],
    ['notas', 'Notas de entrada', true],
    ['fornecedores', 'Fornecedores', true],
    ['itens', 'Itens e locais', perms.can('inventory.view') || perms.can('inventory.setup')],
    ['config', 'Alçadas', perms.can('purchases.setup')],
  ];
  const visible = tabs.filter(([, , show]) => show);
  const tab = (visible.find(([k]) => k === params.get('tab'))?.[0] ?? 'requisicoes') as PurTab;
  const doc = params.get('doc');
  const go = (t: PurTab, id?: string | null) => setParams((p) => {
    p.set('tab', t);
    if (id) p.set('doc', id); else p.delete('doc');
    return p;
  }, { replace: !id });
  const open = (kind: string, id: string) => { const t = KIND_TAB[kind]; if (t) go(t, id); };
  const closeDoc = () => go(tab, null);
  const common = { lookups, openId: doc, onOpen: open, onCloseDoc: closeDoc };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><ShoppingCart className="h-5 w-5" /></span>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Compras</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">Requisição, cotação, pedido, recebimento e notas de entrada — tudo ligado ao Financeiro e ao estoque.</p>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--color-border-card)] print:hidden" role="tablist">
        {visible.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => go(id)}
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
        {tab === 'requisicoes' && <RequisitionsTab {...common} />}
        {tab === 'cotacoes' && <QuotationsTab {...common} />}
        {tab === 'pedidos' && <OrdersTab {...common} />}
        {tab === 'recebimentos' && <ReceiptsTab {...common} />}
        {tab === 'notas' && <InvoicesTab {...common} />}
        {tab === 'fornecedores' && <SuppliersTab {...common} />}
        {tab === 'itens' && <CatalogTab lookups={lookups} />}
        {tab === 'config' && <PurchaseSettingsTab lookups={lookups} />}
      </div>
    </div>
  );
}
