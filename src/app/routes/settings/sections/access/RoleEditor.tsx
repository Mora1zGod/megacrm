import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { Drawer, Field, inputCls } from './ui';
import { SCOPE_LABELS, SCOPE_MODULES, type AccessRole, type Permission } from './useAccessData';

type ScopeVal = 'own' | 'team' | 'all';

// Editor visual do perfil: nome, descrição, escopo de visualização e matriz
// de permissões agrupada por módulo (com "acesso ao módulo" = permissão .view).
export function RoleEditor({ role, modules, rolePerms, onClose, onSaved }: {
  role: AccessRole | null; // null = novo perfil
  modules: { module: string; label: string; perms: Permission[] }[];
  rolePerms: Map<string, Set<string>>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const creating = !role;
  const readOnlyAdmin = Boolean(role?.is_admin);
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [scopes, setScopes] = useState<Record<string, ScopeVal>>(() => ({
    inbox: role?.scopes?.inbox ?? 'own',
    deals: role?.scopes?.deals ?? 'own',
    tasks: role?.scopes?.tasks ?? 'own',
    visits: role?.scopes?.visits ?? 'all',
  }));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(role ? rolePerms.get(role.id) ?? [] : []));
  const [saving, setSaving] = useState(false);
  const allKeys = useMemo(() => modules.flatMap((g) => g.perms.map((p) => p.key)), [modules]);

  const toggle = (key: string) => setSelected((cur) => {
    const next = new Set(cur);
    if (next.has(key)) next.delete(key); else next.add(key);
    // Ação sem acesso ao módulo não faz sentido: liga o ".view" junto.
    const mod = key.split('.')[0];
    const view = `${mod}.view`;
    if (next.has(key) && key !== view && allKeys.includes(view)) next.add(view);
    // Tirou o acesso ao módulo: tira as ações do módulo.
    if (!next.has(key) && key === view) for (const k of [...next]) if (k.startsWith(`${mod}.`)) next.delete(k);
    return next;
  });

  const setModule = (keys: string[], on: boolean) => setSelected((cur) => {
    const next = new Set(cur);
    for (const k of keys) { if (on) next.add(k); else next.delete(k); }
    return next;
  });

  const save = async () => {
    if (!name.trim()) { toast.error('Dê um nome ao perfil.'); return; }
    setSaving(true);
    const { error } = await getSupabase().rpc('save_access_role', {
      p_id: role?.id ?? null,
      p_name: name.trim(),
      p_description: description.trim() || null,
      p_scopes: scopes,
      p_permissions: [...selected],
    });
    setSaving(false);
    if (error) { toast.error('Não foi possível salvar o perfil', { description: error.message }); return; }
    toast.success(creating ? 'Perfil criado.' : 'Perfil salvo. Vale na hora para quem usa este perfil.');
    onSaved();
  };

  return (
    <Drawer
      open
      wide
      title={creating ? 'Novo perfil de acesso' : `Perfil: ${role.name}`}
      subtitle={readOnlyAdmin ? 'Acesso total — não usa a matriz.' : 'Marque o que este perfil pode ver e fazer.'}
      onClose={onClose}
      footer={readOnlyAdmin ? <Button variant="outline" onClick={onClose}>Fechar</Button> : <>
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving}>{saving ? 'Salvando…' : 'Salvar perfil'}</Button>
      </>}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nome do perfil" htmlFor="r-name" hint={role?.is_system ? 'Perfil padrão: o nome não muda (duplique para criar outro).' : undefined}>
          <input id="r-name" value={name} onChange={(e) => setName(e.target.value)} disabled={role?.is_system} className={inputCls} placeholder="Ex.: Gerente Comercial" />
        </Field>
        <Field label="Descrição" htmlFor="r-desc">
          <input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnlyAdmin} className={inputCls} placeholder="Ex.: Atendimento + Leads + Relatórios" />
        </Field>
      </div>

      {readOnlyAdmin ? (
        <div className="mt-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-accent-subtle)] p-4 text-sm text-[var(--color-text-primary)]">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
          <div>
            <div className="font-semibold">Acesso total</div>
            <p className="mt-0.5 text-[var(--color-text-secondary)]">
              O Administrador vê e faz tudo na organização e não pode perder esse acesso.
              Para um perfil parecido mas com limites, use <b>Duplicar</b> e ajuste a cópia.
            </p>
          </div>
        </div>
      ) : (
        <>
          <section className="mt-6">
            <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">O que este perfil enxerga</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {SCOPE_MODULES.map((s) => (
                <div key={s.key} className="rounded-lg border border-[var(--color-border-soft)] px-3 py-2">
                  <div className="mb-1.5 text-sm font-semibold text-[var(--color-text-primary)]">{s.label}</div>
                  <div className="flex flex-wrap gap-1">
                    {(['own', 'team', 'all'] as ScopeVal[]).map((v) => (
                      <button key={v} type="button" onClick={() => setScopes((c) => ({ ...c, [s.key]: v }))} aria-pressed={scopes[s.key] === v}
                        className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                          scopes[s.key] === v ? 'border-[var(--accent-fill)] bg-[var(--accent-fill)] text-white' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]')}>
                        {SCOPE_LABELS[v]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--color-text-muted)]">“Somente próprios” inclui também o que está sem responsável. Por enquanto vale para as conversas do Atendimento; leads, tarefas e agenda entram na próxima etapa.</p>
          </section>

          <section className="mt-6">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]">Permissões ({selected.size}/{allKeys.length})</h3>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setSelected(new Set(allKeys))}>MARCAR TODOS</Button>
                <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>LIMPAR TODOS</Button>
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              {modules.map((g) => {
                const keys = g.perms.map((p) => p.key);
                const on = keys.filter((k) => selected.has(k)).length;
                const view = g.perms.find((p) => p.action === 'view');
                const moduleOn = view ? selected.has(view.key) : on > 0;
                return (
                  <div key={g.module} className={cn('rounded-[var(--radius-card)] border', moduleOn ? 'border-[var(--accent-primary)]/50' : 'border-[var(--color-border-card)]')}>
                    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-2">
                      <span className="text-sm font-bold text-[var(--color-text-primary)]">{g.label}</span>
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="text-[var(--color-text-muted)]">{on}/{keys.length}</span>
                        <button type="button" onClick={() => setModule(keys, on < keys.length)} className="font-semibold text-[var(--accent-primary)] hover:underline">
                          {on < keys.length ? 'Todos' : 'Nenhum'}
                        </button>
                      </div>
                    </div>
                    <ul className="px-3 py-1.5">
                      {g.perms.map((p) => (
                        <li key={p.key}>
                          <label className={cn('flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-[var(--color-surface-hover)]',
                            p.action === 'view' ? 'font-semibold text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)]')}>
                            <input type="checkbox" checked={selected.has(p.key)} onChange={() => toggle(p.key)} className="h-4 w-4 accent-[var(--accent-fill)]" />
                            {p.action === 'view' ? `${p.label} (acesso ao módulo)` : p.label}
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </Drawer>
  );
}
