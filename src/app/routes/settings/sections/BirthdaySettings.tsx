import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

interface BirthdayConfigRow {
  auto_send: boolean;
  send_days_before: number;
  template_name: string | null;
  template_language: string;
}

const DEFAULTS: BirthdayConfigRow = {
  auto_send: false,
  send_days_before: 0,
  template_name: '',
  template_language: 'pt_BR',
};

export function BirthdaySettings() {
  const { userId, orgId } = useAppUser();
  const [cfg, setCfg] = useState<BirthdayConfigRow>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!userId || !orgId) return;
    const supabase = getSupabase();
    setLoading(true);
    supabase
      .schema('whatsapp_hub')
      .from('birthday_config')
      .select('auto_send, send_days_before, template_name, template_language')
      .eq('org_id', orgId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setCfg({
            auto_send: Boolean((data as BirthdayConfigRow).auto_send),
            send_days_before: (data as BirthdayConfigRow).send_days_before ?? 0,
            template_name: (data as BirthdayConfigRow).template_name ?? '',
            template_language: (data as BirthdayConfigRow).template_language || 'pt_BR',
          });
        }
        setLoading(false);
      });
  }, [userId, orgId]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId || !orgId) return;
    setSaving(true);
    const supabase = getSupabase();
    // upsert: a linha da org em birthday_config já existe desde o cadastro
    // (seed_org_defaults), mas o upsert cobre o caso raro de faltar.
    const { error } = await supabase
      .schema('whatsapp_hub')
      .from('birthday_config')
      .upsert(
        {
          org_id: orgId,
          auto_send: cfg.auto_send,
          send_days_before: cfg.send_days_before,
          template_name: cfg.template_name?.trim() || null,
          template_language: cfg.template_language || 'pt_BR',
        },
        { onConflict: 'org_id' },
      );
    setSaving(false);
    if (error) {
      toast.error('Falha ao salvar', { description: error.message });
      return;
    }
    toast.success('Configuração de aniversário salva.');
  };

  if (loading) {
    return (
      <Card>
        <div className="flex items-center gap-3 py-10 justify-center text-sm text-[var(--color-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando configuração...
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} className="space-y-6">
        <header className="space-y-1">
          <h2 className="text-xl font-bold text-display">Config. Aniversário</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Envia automaticamente um template de aniversário pra cada contato
            que tem data de nascimento cadastrada (campo "Aniversário" no
            cadastro do contato). Roda 1x por dia, respeitando o horário de
            atendimento.
          </p>
        </header>

        <div className="flex items-start gap-3 p-3 rounded-lg border border-[rgba(14,154,160,0.1)] bg-white/[0.02]">
          <input
            id="birthday_auto_send"
            type="checkbox"
            checked={cfg.auto_send}
            onChange={(e) => setCfg((prev) => ({ ...prev, auto_send: e.target.checked }))}
            disabled={saving}
            className="accent-[var(--accent-primary)] h-4 w-4 mt-0.5"
          />
          <div>
            <Label htmlFor="birthday_auto_send" className="cursor-pointer">
              Ativar disparo automático
            </Label>
            <p className="text-xs text-[var(--color-text-secondary)] opacity-70">
              Kill-switch — desligado por padrão até o template estar aprovado
              e testado.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label htmlFor="birthday_template_name">Nome do template (Meta)</Label>
            <Input
              id="birthday_template_name"
              value={cfg.template_name ?? ''}
              onChange={(e) => setCfg((prev) => ({ ...prev, template_name: e.target.value }))}
              placeholder="feliz_aniversario"
              disabled={saving}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="birthday_template_language">Idioma do template</Label>
            <Input
              id="birthday_template_language"
              value={cfg.template_language}
              onChange={(e) => setCfg((prev) => ({ ...prev, template_language: e.target.value }))}
              placeholder="pt_BR"
              disabled={saving}
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="birthday_send_days_before">Disparar quantos dias antes</Label>
            <Input
              id="birthday_send_days_before"
              type="number"
              min={0}
              max={30}
              value={cfg.send_days_before}
              onChange={(e) =>
                setCfg((prev) => ({ ...prev, send_days_before: Math.max(0, Number(e.target.value) || 0) }))
              }
              disabled={saving}
              className="max-w-[160px]"
            />
            <p className="text-[11px] text-[var(--color-text-secondary)] opacity-70">
              0 = envia no próprio dia do aniversário. 1 = envia na véspera.
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Salvando...
              </>
            ) : (
              <>Salvar alterações</>
            )}
          </Button>
        </div>
      </form>
    </Card>
  );
}
