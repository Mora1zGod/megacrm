import { useState } from 'react';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { toast } from 'sonner';
import { Repeat } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { RECURRENCE_LABELS, type TaskRecurrence } from '@/lib/tasks';

export interface TaskFormValues {
  id?: string;
  title?: string;
  description?: string | null;
  due_at?: string | null;
  assigned_to?: string | null;
  recurrence?: string | null;
  contact_id?: string | null;
  deal_id?: string | null;
  conversation_id?: string | null;
}

const inputCls =
  'w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--accent-primary)]';

const p2 = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const localTime = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;

const RECURRENCES: TaskRecurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];

// Formulário único de tarefa (criar e editar): título, descrição, responsável,
// data/hora e recorrência. Usado em Tarefas, Agenda e no topo.
export function TaskFormDialog({ initial, defaultDate, onClose, onSaved }: {
  initial?: TaskFormValues;
  defaultDate?: string; // yyyy-mm-dd
  onClose: () => void;
  onSaved: () => void;
}) {
  const { userId } = useAppUser();
  const perms = usePermission();
  const canAssign = perms.can('tasks.assign');
  const { operators } = useOperators();
  const editing = Boolean(initial?.id);
  const due = initial?.due_at ? new Date(initial.due_at) : null;

  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [assignee, setAssignee] = useState<string>(initial ? (initial.assigned_to ?? '') : (userId ?? ''));
  const [date, setDate] = useState(due ? localDate(due) : editing ? '' : (defaultDate ?? localDate(new Date())));
  const [time, setTime] = useState(due ? localTime(due) : '');
  const [recurrence, setRecurrence] = useState<TaskRecurrence>(
    (RECURRENCES as string[]).includes(initial?.recurrence ?? '') ? (initial!.recurrence as TaskRecurrence) : 'none',
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) { toast.error('Dê um título à tarefa.'); return; }
    if (recurrence !== 'none' && !date) { toast.error('Tarefa recorrente precisa de uma data de início.'); return; }
    let dueAt: string | null = null;
    if (date) dueAt = new Date(`${date}T${time || '23:59'}:00`).toISOString();

    const payload: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim() || null,
      due_at: dueAt,
      assigned_to: assignee || null,
    };
    // Só manda a coluna quando necessário: funciona mesmo antes do SQL de
    // recorrência rodar, para tarefas que não repetem.
    if (recurrence !== 'none' || (initial?.recurrence && initial.recurrence !== 'none')) payload.recurrence = recurrence;

    setSaving(true);
    const supabase = getSupabase();
    const { error } = editing
      ? await supabase.from('tasks').update(payload).eq('id', initial!.id!)
      : await supabase.from('tasks').insert({
          ...payload,
          created_by: userId,
          contact_id: initial?.contact_id ?? null,
          deal_id: initial?.deal_id ?? null,
          conversation_id: initial?.conversation_id ?? null,
        });
    setSaving(false);
    if (error) {
      const msg = /recurrence/.test(error.message)
        ? 'A recorrência ainda não foi ativada no banco (falta rodar o SQL de tarefas).'
        : error.message;
      toast.error(editing ? 'Não foi possível salvar a tarefa' : 'Não foi possível criar a tarefa', { description: msg });
      return;
    }
    toast.success(editing ? 'Tarefa atualizada.' : 'Tarefa criada.');
    onSaved();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? 'Editar tarefa' : 'Nova tarefa'}
      description={editing ? undefined : 'Crie uma tarefa para você ou para alguém da equipe.'}
    >
      <div className="space-y-3.5">
        <div>
          <Label htmlFor="tf-title">Título</Label>
          <input id="tf-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            placeholder="Ex.: Revisar e-mails" className={inputCls} />
        </div>
        <div>
          <Label htmlFor="tf-desc">Descrição</Label>
          <textarea id="tf-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={3}
            placeholder="Detalhes da tarefa (opcional)" className={cn(inputCls, 'resize-y')} />
        </div>
        <div>
          <Label htmlFor="tf-who">Responsável</Label>
          <select id="tf-who" value={assignee} onChange={(e) => setAssignee(e.target.value)} disabled={!canAssign}
            title={canAssign ? undefined : 'Seu perfil não permite atribuir tarefas para outra pessoa'} className={cn(inputCls, 'h-10 py-0')}>
            <option value="">Sem responsável</option>
            {operators.map((o) => (
              <option key={o.user_id} value={o.user_id}>{operatorLabel(o)}{o.user_id === userId ? ' (eu)' : ''}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="tf-date">{recurrence === 'none' ? 'Data' : 'Começa em'}</Label>
            <input id="tf-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(inputCls, 'h-10 py-0')} />
          </div>
          <div>
            <Label htmlFor="tf-time">Horário (opcional)</Label>
            <input id="tf-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(inputCls, 'h-10 py-0')} />
          </div>
        </div>
        <div>
          <Label className="flex items-center gap-1.5"><Repeat className="h-3.5 w-3.5 text-[var(--accent-primary)]" /> Recorrência</Label>
          <div role="radiogroup" aria-label="Recorrência" className="flex flex-wrap gap-1.5">
            {RECURRENCES.map((r) => (
              <button key={r} type="button" role="radio" aria-checked={recurrence === r} onClick={() => setRecurrence(r)}
                className={cn(
                  'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                  recurrence === r
                    ? 'border-[var(--accent-fill)] bg-[var(--accent-fill)] text-white'
                    : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]',
                )}>
                {RECURRENCE_LABELS[r]}
              </button>
            ))}
          </div>
          {recurrence !== 'none' && (
            <p className="mt-1.5 text-xs text-[var(--color-text-muted)]">
              Ao concluir, a próxima tarefa é criada automaticamente{recurrence === 'weekdays' ? ' (segunda a sexta)' : ''}.
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-5">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving || !title.trim()}>
          {saving ? 'Salvando…' : editing ? 'Salvar alterações' : 'Criar tarefa'}
        </Button>
      </div>
    </Dialog>
  );
}
