import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Minus, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { inputCls } from './ui';
import type { Permission } from './useAccessData';

export type Effect = 'inherit' | 'allow' | 'deny';

const EFFECTS: [Effect, string][] = [['inherit', 'Padrão'], ['allow', 'Liberar'], ['deny', 'Bloquear']];

// Permissões individuais de UMA pessoa: perfil + liberadas − bloqueadas.
// Busca, ações em massa (tudo / por módulo) e módulos que abrem e fecham.
export function OverridesEditor({ modules, base, ov, onChange, roleName }: {
  modules: { module: string; label: string; perms: Permission[] }[];
  base: Set<string>;                      // o que o perfil já dá
  ov: Map<string, Effect>;
  onChange: (next: Map<string, Effect>) => void;
  roleName?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  const shown = useMemo(() => {
    const t = norm(q.trim());
    if (!t) return modules;
    return modules
      .map((g) => (norm(g.label).includes(t) ? g : { ...g, perms: g.perms.filter((p) => norm(p.label).includes(t)) }))
      .filter((g) => g.perms.length > 0);
  }, [modules, q]);

  const isOn = (key: string) => { const e = ov.get(key) ?? 'inherit'; return e === 'allow' || (e === 'inherit' && base.has(key)); };
  const setMany = (keys: string[], e: Effect) => {
    const next = new Map(ov);
    for (const k of keys) { if (e === 'inherit') next.delete(k); else next.set(k, e); }
    onChange(next);
  };
  const groupEffect = (keys: string[]): Effect | null => {
    const set = new Set(keys.map((k) => ov.get(k) ?? 'inherit'));
    return set.size === 1 ? [...set][0] : null;
  };

  const allKeys = shown.flatMap((g) => g.perms.map((p) => p.key));
  const totalOn = modules.flatMap((g) => g.perms).filter((p) => isOn(p.key)).length;
  const totalAll = modules.reduce((n, g) => n + g.perms.length, 0);
  const searching = q.trim().length > 0;
  const toggleOpen = (m: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(m)) n.delete(m); else n.add(m); return n; });

  return (
    <div className="mt-3 space-y-3">
      {/* Barra: busca + ações em massa */}
      <div className="sticky top-0 z-[1] space-y-2 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-surface)] p-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar permissão ou módulo (ex.: e-mail, excluir)"
              aria-label="Buscar permissão" className={cn(inputCls, 'h-9 pl-8 text-sm')} />
          </label>
          <span className="text-xs font-semibold text-[var(--color-text-secondary)]">{totalOn} de {totalAll} ativas</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-[var(--color-text-muted)]">{searching ? 'Nos resultados:' : 'Em tudo:'}</span>
          <button type="button" onClick={() => setMany(allKeys, 'allow')} className="rounded-md bg-[var(--color-success)] px-2.5 py-1 font-semibold text-white">Liberar tudo</button>
          <button type="button" onClick={() => setMany(allKeys, 'deny')} className="rounded-md bg-[var(--color-error)] px-2.5 py-1 font-semibold text-white">Bloquear tudo</button>
          <button type="button" onClick={() => setMany(allKeys, 'inherit')} className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border-card)] px-2.5 py-1 font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">
            <X className="h-3 w-3" /> Tudo igual ao perfil{roleName ? ` ${roleName}` : ''}
          </button>
          <span className="ml-auto flex gap-2">
            <button type="button" onClick={() => setOpen(new Set(modules.map((g) => g.module)))} className="font-medium text-[var(--accent-primary)] hover:underline">Abrir todos</button>
            <button type="button" onClick={() => setOpen(new Set())} className="font-medium text-[var(--accent-primary)] hover:underline">Fechar todos</button>
          </span>
        </div>
      </div>

      {shown.length === 0 && <p className="px-1 text-sm text-[var(--color-text-secondary)]">Nenhuma permissão com “{q}”.</p>}

      {shown.map((g) => {
        const keys = g.perms.map((p) => p.key);
        const on = keys.filter(isOn).length;
        const ge = groupEffect(keys);
        const expanded = searching || open.has(g.module);
        return (
          <div key={g.module} className="overflow-hidden rounded-lg border border-[var(--color-border-soft)]">
            <div className="flex flex-wrap items-center gap-2 bg-[var(--color-fill-subtle)] px-3 py-2">
              <button type="button" onClick={() => toggleOpen(g.module)} aria-expanded={expanded}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-sm font-semibold text-[var(--color-text-primary)]">
                {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <span className="truncate">{g.label}</span>
                <span className={cn('ml-1 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                  on === keys.length ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]'
                    : on === 0 ? 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)]' : 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]')}>
                  {on}/{keys.length}
                </span>
              </button>
              <Segmented value={ge} onPick={(e) => setMany(keys, e)} label={`Tudo de ${g.label}`} />
            </div>
            {expanded && (
              <ul className="divide-y divide-[var(--color-border-soft)]">
                {g.perms.map((p) => {
                  const inRole = base.has(p.key);
                  const eff = ov.get(p.key) ?? 'inherit';
                  const finalOn = isOn(p.key);
                  return (
                    <li key={p.key} className="flex items-center gap-3 px-3 py-1.5">
                      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', finalOn ? 'bg-[var(--color-success)] text-white' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-muted)]')}>
                        {finalOn ? <Check className="h-3 w-3" strokeWidth={3} /> : <Minus className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1 text-sm text-[var(--color-text-primary)]">
                        {p.label}
                        {inRole && <span className="ml-1.5 text-[11px] text-[var(--color-text-muted)]">(no perfil)</span>}
                      </span>
                      <Segmented value={eff} onPick={(e) => setMany([p.key], e)} label={p.label} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Segmented({ value, onPick, label }: { value: Effect | null; onPick: (e: Effect) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 overflow-hidden rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] text-[11px] font-semibold">
      {EFFECTS.map(([v, l]) => (
        <button key={v} type="button" onClick={() => onPick(v)} aria-pressed={value === v}
          className={cn('px-2 py-1 transition-colors',
            value === v
              ? v === 'allow' ? 'bg-[var(--color-success)] text-white' : v === 'deny' ? 'bg-[var(--color-error)] text-white' : 'bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
              : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
          {l}
        </button>
      ))}
    </div>
  );
}
