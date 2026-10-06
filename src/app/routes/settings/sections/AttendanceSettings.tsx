import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PenLine, Reply, Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { useSlaConfig } from '@/hooks/useSlaConfig';

const inputCls =
  'h-10 w-24 rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

// Configurações → Atendimento: tempo de resposta (SLA) da equipe.
export function AttendanceSettings() {
  const { sla, loading, save } = useSlaConfig();
  const [warn, setWarn] = useState(String(sla.warn));
  const [late, setLate] = useState(String(sla.late));
  const [saving, setSaving] = useState(false);

  useEffect(() => { setWarn(String(sla.warn)); setLate(String(sla.late)); }, [sla.warn, sla.late]);

  const submit = async () => {
    const w = Number(warn);
    const l = Number(late);
    if (!Number.isInteger(w) || !Number.isInteger(l) || w < 1 || l < 1 || w > 1440 || l > 1440) {
      toast.error('Use minutos inteiros entre 1 e 1440.');
      return;
    }
    if (l < w) { toast.error('O limite vermelho precisa ser maior ou igual ao amarelo.'); return; }
    setSaving(true);
    const err = await save({ warn: w, late: l });
    setSaving(false);
    if (err) {
      toast.error('Não foi possível salvar', {
        description: /sla_/.test(err) ? 'Falta rodar o SQL do painel de atendimento no Supabase.' : err,
      });
      return;
    }
    toast.success('Tempo de resposta salvo.');
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="mb-1 flex items-center gap-2 text-base font-semibold text-[var(--color-text-primary)]">
          <Timer className="h-4 w-4 text-[var(--accent-primary)]" /> Tempo de resposta (SLA)
        </div>
        <p className="mb-4 text-sm text-[var(--color-text-secondary)]">
          Na lista de conversas aparece há quanto tempo o cliente espera resposta. A etiqueta fica
          amarela e depois vermelha; as vermelhas também aparecem na aba <b>Atrasadas</b>.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="sla-warn">Amarelo a partir de (min)</Label>
            <input id="sla-warn" type="number" min={1} max={1440} value={warn} disabled={loading}
              onChange={(e) => setWarn(e.target.value)} className={inputCls} />
          </div>
          <div>
            <Label htmlFor="sla-late">Vermelho a partir de (min)</Label>
            <input id="sla-late" type="number" min={1} max={1440} value={late} disabled={loading}
              onChange={(e) => setLate(e.target.value)} className={inputCls} />
          </div>
          <Button onClick={() => void submit()} disabled={saving || loading}>{saving ? 'Salvando…' : 'Salvar'}</Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="mb-2 text-base font-semibold text-[var(--color-text-primary)]">Outros recursos do atendimento</div>
        <ul className="space-y-2 text-sm text-[var(--color-text-secondary)]">
          <li className="flex gap-2"><Reply className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
            <span><b>Responder citando</b> e <b>encaminhar</b>: passe o mouse na mensagem da conversa e use os botões ao lado do balão.</span></li>
          <li className="flex gap-2"><PenLine className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
            <span><b>Assinatura</b>: cada atendente liga no botão de caneta do campo de mensagem. A mensagem sai com o nome dele no começo (o nome vem de Configurações → Conta).</span></li>
        </ul>
      </Card>
    </div>
  );
}
