import { useState } from 'react';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { toast } from 'sonner';
import { ArrowLeft, Bell, Pencil, Plus, Trash2, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { REMINDER_COLORS, toLocalInput, useReminders, type Reminder, type ReminderColor } from '@/hooks/useReminders';

const inputCls =
  'w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--accent-primary)]';

function dueLabel(iso: string): { text: string; late: boolean } {
  const d = new Date(iso);
  const now = new Date();
  const hm = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const tomorrow = new Date(); tomorrow.setDate(now.getDate() + 1);
  const late = d.getTime() < now.getTime();
  if (d.toDateString() === now.toDateString()) return { text: `Hoje, ${hm}`, late };
  if (d.toDateString() === tomorrow.toDateString()) return { text: `Amanhã, ${hm}`, late };
  return { text: `${d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}, ${hm}`, late };
}

// Botão "Lembretes" do topo: notas rápidas pessoais (ou da equipe), com cor e
// data opcional. Com data, aparecem também na Agenda.
export function RemindersPopover() {
  const { userId } = useAppUser();
  const perms = usePermission();
  const { reminders, create, update, setDone, remove } = useReminders();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [color, setColor] = useState<ReminderColor>('green');
  const [due, setDue] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reset = () => { setTitle(''); setNotes(''); setColor('green'); setDue(''); setShared(false); setEditingId(null); };

  const startEdit = (r: Reminder) => {
    setEditingId(r.id);
    setTitle(r.title);
    setNotes(r.notes ?? '');
    setColor(r.color);
    setDue(toLocalInput(r.due_at));
    setShared(r.shared);
    setMode('new');
  };

  const save = async () => {
    if (!title.trim()) { toast.error('Dê um título ao lembrete.'); return; }
    setSaving(true);
    try {
      const input = { title, notes, color, due_at: due ? new Date(due).toISOString() : null, shared };
      if (editingId) { await update(editingId, input); toast.success('Lembrete atualizado.'); }
      else { await create(input); toast.success('Lembrete adicionado.'); }
      reset();
      setMode('list');
    } catch (e) {
      toast.error('Não foi possível salvar o lembrete', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); reset(); setMode(reminders.length || !perms.can('reminders.create') ? 'list' : 'new'); }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-3 text-sm font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        <Bell className="h-4 w-4 text-[var(--accent-primary)]" />
        <span className="hidden min-[1800px]:inline">Lembretes</span>
        {reminders.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--accent-fill)] px-1 text-[10px] font-bold text-white">{reminders.length}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setOpen(false)} />
          <div role="dialog" aria-label="Lembretes" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-[340px] max-w-[calc(100vw-24px)] rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-4 shadow-[var(--shadow-lg)]">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[15px] font-bold text-[var(--color-text-primary)]">
                {mode === 'new' && reminders.length > 0 && (
                  <button type="button" onClick={() => { reset(); setMode('list'); }} aria-label="Voltar" className="rounded p-0.5 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><ArrowLeft className="h-4 w-4" /></button>
                )}
                <Bell className="h-4 w-4 text-[var(--accent-primary)]" />
                {mode === 'new' ? (editingId ? 'Editar lembrete' : 'Novo lembrete') : 'Lembretes'}
              </div>
              <div className="flex items-center gap-1">
                {mode === 'list' && perms.can('reminders.create') && (
                  <button type="button" onClick={() => { reset(); setMode('new'); }} aria-label="Novo lembrete" title="Novo lembrete" className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-fill)] text-white hover:bg-[var(--accent-fill-hover)]"><Plus className="h-4 w-4" /></button>
                )}
                <button type="button" onClick={() => setOpen(false)} aria-label="Fechar" className="rounded p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {mode === 'new' ? (
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]" htmlFor="rem-title">Título do lembrete</label>
                  <input id="rem-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex: Reunião com cliente" className={inputCls} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]" htmlFor="rem-notes">Notas (opcional)</label>
                  <textarea id="rem-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Adicione mais detalhes..." className={inputCls} />
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium text-[var(--color-text-secondary)]">Cor</div>
                  <div className="flex gap-2">
                    {(Object.keys(REMINDER_COLORS) as ReminderColor[]).map((c) => (
                      <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Cor ${c}`} aria-pressed={color === c}
                        className={`h-7 w-7 rounded-full transition ${color === c ? 'ring-2 ring-offset-2 ring-[var(--color-text-primary)] ring-offset-[var(--color-surface-raised)]' : ''}`}
                        style={{ background: REMINDER_COLORS[c] }} />
                    ))}
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-[var(--color-text-secondary)]" htmlFor="rem-due">Data limite (opcional)</label>
                  <input id="rem-due" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
                </div>
                {perms.can('reminders.share') && <label className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-3 py-2">
                  <span>
                    <span className="block text-sm font-medium text-[var(--color-text-primary)]">Compartilhar com equipe</span>
                    <span className="block text-xs text-[var(--color-text-muted)]">Todos da equipe poderão ver</span>
                  </span>
                  <input type="checkbox" role="switch" checked={shared} onChange={(e) => setShared(e.target.checked)} className="h-4 w-4 accent-[var(--accent-fill)]" />
                </label>}
                <Button className="w-full" onClick={() => void save()} disabled={saving || !title.trim()}>
                  {saving ? 'Salvando…' : editingId ? 'Salvar alterações' : 'Adicionar lembrete'}
                </Button>
              </div>
            ) : (
              <ul className="max-h-80 space-y-1.5 overflow-y-auto">
                {reminders.map((r) => {
                  const due = r.due_at ? dueLabel(r.due_at) : null;
                  const mine = r.created_by === userId;
                  const canEdit = mine && perms.can('reminders.edit');
                  const canDelete = mine && perms.can('reminders.delete');
                  return (
                    <li key={r.id} className="group flex items-start gap-2.5 rounded-lg border border-[var(--color-border-soft)] px-2.5 py-2">
                      <input type="checkbox" checked={r.done} disabled={!mine} title={mine ? 'Concluir' : 'Só quem criou pode concluir'}
                        onChange={() => void setDone(r.id, !r.done).catch((e) => toast.error('Falha', { description: String(e) }))}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-fill)]" />
                      <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: REMINDER_COLORS[r.color] }} />
                      <div
                        className={`min-w-0 flex-1 ${canEdit ? 'cursor-pointer' : ''}`}
                        onClick={canEdit ? () => startEdit(r) : undefined}
                        title={canEdit ? 'Clique para editar' : undefined}
                      >
                        <div className="text-sm font-medium text-[var(--color-text-primary)]">{r.title}</div>
                        {r.notes && <div className="line-clamp-2 text-xs text-[var(--color-text-secondary)]">{r.notes}</div>}
                        <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                          {due && <span className={due.late ? 'text-[var(--color-error)]' : 'text-[var(--color-text-muted)]'}>{due.text}</span>}
                          {r.shared && <span className="inline-flex items-center gap-0.5 text-[var(--color-text-muted)]"><Users className="h-3 w-3" /> equipe</span>}
                        </div>
                      </div>
                      {canEdit && (
                        <button type="button" onClick={() => startEdit(r)} aria-label="Editar lembrete" title="Editar" className="rounded p-1 text-[var(--color-text-muted)] transition hover:text-[var(--accent-primary)]">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {canDelete && (
                        <button type="button" onClick={() => void remove(r.id)} aria-label="Apagar lembrete" className="rounded p-1 text-[var(--color-text-muted)] opacity-0 transition group-hover:opacity-100 hover:text-[var(--color-error)] focus:opacity-100">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
