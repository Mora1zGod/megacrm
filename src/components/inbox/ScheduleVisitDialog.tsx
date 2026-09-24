import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';

interface ScheduleVisitDialogProps {
  contactId: string;
  contactName: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

// Agendamento de visita direto da conversa — o operador está falando com a
// pessoa e marca ali mesmo, sem trocar de tela e sem ter que procurar o
// contato de novo em /visitas.
export function ScheduleVisitDialog({ contactId, contactName, onClose, onSaved }: ScheduleVisitDialogProps) {
  const hoje = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(hoje);
  const [time, setTime] = useState('09:00');
  const [partySize, setPartySize] = useState(1);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!date || !time) {
      toast.error('Informe data e horário.');
      return;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error } = await supabase.from('park_visits').insert({
      contact_id: contactId,
      visit_date: date,
      visit_time: time,
      party_size: partySize,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast.error('Não foi possível agendar.', { description: error.message });
      return;
    }
    const quando = new Date(`${date}T00:00:00`).toLocaleDateString('pt-BR');
    toast.success(`Visita agendada para ${quando} às ${time}.`, {
      description: 'O lembrete automático sai na manhã do dia da visita.',
    });
    onSaved?.();
    onClose();
  };

  return (
    <Dialog open onClose={onClose} title={`Agendar visita — ${contactName?.trim() || 'contato'}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="sv-date">Data</Label>
            <input
              id="sv-date"
              type="date"
              value={date}
              min={hoje}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
            />
          </div>
          <div>
            <Label htmlFor="sv-time">Horário</Label>
            <input
              id="sv-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="sv-party">Quantas pessoas</Label>
          <input
            id="sv-party"
            type="number"
            min={1}
            value={partySize}
            onChange={(e) => setPartySize(Math.max(1, Number(e.target.value) || 1))}
            className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
        <div>
          <Label htmlFor="sv-notes">Observações (opcional)</Label>
          <input
            id="sv-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Ex.: associado, vem de Cruzeiro do Sul"
            className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void submit()} disabled={saving}>
          {saving ? 'Agendando...' : 'Agendar visita'}
        </Button>
      </div>
    </Dialog>
  );
}
