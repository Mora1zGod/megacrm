import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, ClipboardList, Clock, Copy, ExternalLink, IdCard, Link2, Loader2, RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { usePermission } from '../../providers/PermissionsProvider';
import RecadDetail from './RecadDetail';
import { PLAN, SUB_COLS, StatusChip, copy, fmtDateTime, type Status, type Submission } from './recadShared';

// Central de Recadastramento (13/11/2026). O associado preenche o link público /recadastro/<token>; aqui a equipe confere
// dados e documentos, registra pendências e observações (banco, tempo real), chama no WhatsApp e lança no Pocket.
// Os valores têm data-pocket="…" e os botões data-pocket-action="…" (extensão do navegador que copia para o Pocket).
// Layout por container (@container): ≥1040 px = 3 colunas; ≥760 px = lista + cadastro; abaixo = lista OU cadastro.

const FILTERS: [string, Status[] | null][] = [
  ['A conferir', ['novo', 'em_analise']],
  ['Aguardando retorno', ['pendente']],
  ['Prontos para lançar', ['conferido']],
  ['Lançados', ['lancado']],
  ['Recusados', ['recusado']],
  ['Incompletos', ['enviando']],
  ['Todos', null],
];

function LinkCard({ canManage }: { canManage: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data } = await getSupabase().from('recad_links').select('id, token').eq('is_active', true).order('created_at', { ascending: false }).limit(1).maybeSingle();
    setToken((data as { token: string } | null)?.token ?? null);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const url = token ? `${window.location.origin}/recadastro/${token}` : '';

  async function regenerate() {
    if (!window.confirm('Gerar um link novo? O link atual para de funcionar na hora (inclusive o que a AMAIA manda).')) return;
    setBusy(true);
    const sb = getSupabase();
    const { error: e1 } = await sb.from('recad_links').update({ is_active: false }).eq('is_active', true);
    const { error: e2 } = e1 ? { error: e1 } : await sb.from('recad_links').insert({});
    setBusy(false);
    if (e2) { toast.error('Não foi possível gerar o link', { description: e2.message }); return; }
    toast.success('Link novo gerado. Atualize o link da AMAIA (variável link_recadastro) e o /atualizar.');
    void load();
  }

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
      <Link2 className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
      <span className="min-w-0 max-w-[260px] truncate text-xs text-[var(--color-text-secondary)]" title={url}>{url || 'nenhum link ativo'}</span>
      {url && <Button size="sm" variant="outline" onClick={() => void copy(url, 'Link copiado')}><Copy className="h-3.5 w-3.5" /> Copiar link</Button>}
      {url && <a href={url} target="_blank" rel="noreferrer"><Button size="sm" variant="ghost"><ExternalLink className="h-3.5 w-3.5" /> Abrir</Button></a>}
      {canManage && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void regenerate()}><RefreshCw className="h-3.5 w-3.5" /> Gerar novo</Button>}
    </div>
  );
}

export default function RecadastramentosPage() {
  const perms = usePermission();
  const canManage = perms.can('recad.manage');
  const { allOperators } = useOperators();
  const [rows, setRows] = useState<Submission[] | null>(null);
  const [openCount, setOpenCount] = useState<Record<string, number>>({});
  const [centralReady, setCentralReady] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(0);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const nameOf = useCallback((uid: string | null) => {
    if (!uid) return 'Equipe';
    const op = allOperators.find((o) => o.user_id === uid);
    return op ? operatorLabel(op) : 'Equipe';
  }, [allOperators]);

  const loadSubs = useCallback(async () => {
    const { data, error: e } = await getSupabase().from('recad_submissions').select(SUB_COLS).order('created_at', { ascending: false }).limit(2000);
    if (e) { setError(/recad_submissions/.test(e.message) ? 'O módulo de recadastramento ainda não foi instalado no banco.' : e.message); setRows([]); return; }
    setError(null);
    setRows((data ?? []) as Submission[]);
  }, []);
  const loadCounts = useCallback(async () => {
    const { data, error: e } = await getSupabase().from('recad_issues').select('submission_id').eq('status', 'aberta').is('deleted_at', null).limit(10000);
    if (e) { setCentralReady(false); return; }
    setCentralReady(true);
    const m: Record<string, number> = {};
    for (const r of (data ?? []) as { submission_id: string }[]) m[r.submission_id] = (m[r.submission_id] ?? 0) + 1;
    setOpenCount(m);
  }, []);

  // tempo real: envios (lista/contadores) e pendências/observações (painel + contadores) — com debounce
  const timers = useRef<{ s?: ReturnType<typeof setTimeout>; i?: ReturnType<typeof setTimeout> }>({});
  useEffect(() => {
    void loadSubs();
    void loadCounts();
    const t = timers.current;
    const onSub = () => { if (t.s) clearTimeout(t.s); t.s = setTimeout(() => void loadSubs(), 800); };
    const onSide = () => {
      if (t.i) clearTimeout(t.i);
      t.i = setTimeout(() => { void loadCounts(); setTick((x) => x + 1); }, 500);
    };
    const ch = getSupabase().channel('recad-central')
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'recad_submissions' }, onSub)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'recad_issues' }, onSide)
      .on('postgres_changes', { event: '*', schema: 'whatsapp_hub', table: 'recad_notes' }, onSide)
      .subscribe();
    // ao voltar para a aba, confere de novo (realtime pode ter caído)
    const vis = () => { if (document.visibilityState === 'visible') { onSub(); onSide(); } };
    document.addEventListener('visibilitychange', vis);
    return () => {
      if (t.s) clearTimeout(t.s);
      if (t.i) clearTimeout(t.i);
      document.removeEventListener('visibilitychange', vis);
      void getSupabase().removeChannel(ch);
    };
  }, [loadSubs, loadCounts]);

  const statuses = FILTERS[filter][1];
  const list = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const qd = qq.replace(/\D/g, '');
    return (rows ?? []).filter((r) => (!statuses || statuses.includes(r.status)) && (!qq
      || r.holder_name.toLowerCase().includes(qq) || String(r.protocol).includes(qq) || (PLAN[r.plan] ?? '').toLowerCase().includes(qq)
      || (qd.length >= 3 && (r.holder_cpf.includes(qd) || (r.holder_phone ?? '').includes(qd)))));
  }, [rows, statuses, q]);
  const counts = useMemo(() => FILTERS.map(([, st]) => (rows ?? []).filter((r) => (st ? st.includes(r.status) : r.status !== 'enviando')).length), [rows]);
  const metrics: [string, number, typeof ClipboardList, number | null][] = [
    ['Solicitações', counts[6], ClipboardList, 6],
    ['A conferir', counts[0], AlertTriangle, 0],
    ['Aguardando retorno', counts[1], Clock, 1],
    ['Prontos para lançar', counts[2], CheckCircle2, 2],
  ];
  const current = (rows ?? []).find((r) => r.id === selected) ?? null;

  return (
    <div className="@container flex h-full min-h-0 flex-col gap-3">
      <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2', current && 'hidden @min-[760px]:flex')}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><IdCard className="h-5 w-5" /></span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Central de Recadastramento</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">Conferência de solicitações, documentos e pendências em um só lugar.</p>
          </div>
        </div>
        <LinkCard canManage={canManage} />
      </div>

      <div className={cn('grid grid-cols-2 gap-2 @min-[760px]:grid-cols-4', current && 'hidden @min-[760px]:grid')}>
        {metrics.map(([label, n, Icon, fi]) => (
          <button key={label} type="button" onClick={() => fi !== null && setFilter(fi)}
            className={cn('flex min-w-0 items-center gap-2.5 rounded-[var(--radius-card)] border bg-[var(--color-surface)] p-2.5 text-left hover:bg-[var(--color-surface-hover)]',
              filter === fi ? 'border-[var(--accent-primary)]' : 'border-[var(--color-border-card)]')}>
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]"><Icon className="h-4 w-4" /></span>
            <span className="min-w-0">
              <span className="block truncate text-[11px] font-medium text-[var(--color-text-muted)]">{label}</span>
              <span className="block text-lg font-semibold leading-tight text-[var(--color-text-primary)]">{rows === null ? '…' : n}</span>
            </span>
          </button>
        ))}
      </div>

      {error && <div className="rounded-[var(--radius-card)] border border-[rgba(239,68,68,0.3)] bg-[rgba(239,68,68,0.06)] p-3 text-sm text-[var(--color-error)]">{error}</div>}

      <div className="flex min-h-0 flex-1 gap-3">
        {/* LISTA */}
        <aside className={cn('flex min-h-0 w-full flex-col rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] @min-[760px]:w-[280px] @min-[760px]:shrink-0',
          current && 'hidden @min-[760px]:flex')} aria-label="Solicitações">
          <div className="space-y-2 border-b border-[var(--color-border-card)] p-2.5">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-[var(--color-text-primary)]">Solicitações</span>
              <span className="text-xs text-[var(--color-text-muted)]">{list.length}</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, CPF, WhatsApp ou protocolo" aria-label="Buscar solicitações"
                className="h-9 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] pl-8 pr-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]" />
            </div>
            <div className="flex max-w-full flex-wrap gap-1">
              {FILTERS.map(([label], i) => (
                <button key={label} type="button" onClick={() => setFilter(i)}
                  className={cn('rounded-full border px-2 py-0.5 text-[11px] font-semibold', filter === i ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]')}>
                  {label} <span className="opacity-70">{counts[i]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {rows === null && <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>}
            {rows !== null && list.length === 0 && <p className="p-6 text-center text-sm text-[var(--color-text-muted)]">Nenhuma solicitação neste filtro.</p>}
            {list.map((r) => {
              const n = openCount[r.id] ?? 0;
              return (
                <button key={r.id} type="button" onClick={() => setSelected(r.id)} data-pocket-item={r.protocol} data-pocket-status={r.status}
                  className={cn('block w-full border-b border-l-2 border-b-[var(--color-border-soft)] px-3 py-2.5 text-left hover:bg-[var(--color-surface-hover)]',
                    selected === r.id ? 'border-l-[var(--accent-primary)] bg-[var(--color-accent-subtle)]' : 'border-l-transparent')}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate text-sm font-semibold text-[var(--color-text-primary)]">{r.holder_name}</span>
                    <StatusChip status={r.status} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">#{r.protocol} · {fmtDateTime(r.completed_at ?? r.created_at)}</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-[var(--color-text-secondary)]">{PLAN[r.plan]}{r.people_count ? ` · ${r.people_count} pess.` : ''}</span>
                    {centralReady && (n
                      ? <span className="shrink-0 rounded-full bg-[rgba(239,68,68,0.12)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-error)]">{n} pendência{n > 1 ? 's' : ''}</span>
                      : <span className="shrink-0 text-[11px] text-[var(--color-text-muted)]">sem pendências</span>)}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* CADASTRO */}
        <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', !current && 'hidden @min-[760px]:flex')}>
          {current
            ? <RecadDetail key={current.id} sub={current} canManage={canManage} centralReady={centralReady} tick={tick} nameOf={nameOf}
                onClose={() => setSelected(null)}
                onChanged={(s) => setRows((rs) => (rs ?? []).map((x) => (x.id === s.id ? s : x)))}
                onIssuesChanged={() => void loadCounts()} />
            : <div className="flex h-full items-center justify-center rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-6 text-sm text-[var(--color-text-muted)]">Escolha uma solicitação na lista.</div>}
        </div>
      </div>
    </div>
  );
}
