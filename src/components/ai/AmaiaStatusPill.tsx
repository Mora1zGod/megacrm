import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, Instagram, MessageCircle, Power } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { useAppUser } from '@/app/providers/AppUserProvider';

interface AiConfig {
  id: string;
  is_active: boolean;
  active_whatsapp: boolean;
  active_instagram: boolean;
}

// Pill "AMAIA ativa" no topo: status geral da IA da organização. O admin liga
// e desliga por canal ali mesmo; operador só vê o status.
export function AmaiaStatusPill() {
  const { role } = useAppUser();
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getSupabase()
      .from('ai_agent_config')
      .select('id, is_active, active_whatsapp, active_instagram')
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const d = data as Partial<AiConfig> & { id: string };
          setCfg({
            id: d.id,
            is_active: Boolean(d.is_active),
            active_whatsapp: Boolean(d.active_whatsapp ?? true),
            active_instagram: Boolean(d.active_instagram ?? false),
          });
        }
      });
  }, []);

  if (!cfg) return null;
  const on = cfg.is_active && (cfg.active_whatsapp || cfg.active_instagram);
  const isAdmin = role === 'admin';

  const save = async (patch: Partial<Omit<AiConfig, 'id'>>, msg: string) => {
    setSaving(true);
    const { error } = await getSupabase().from('ai_agent_config').update(patch).eq('id', cfg.id);
    setSaving(false);
    if (error) {
      toast.error('Não foi possível alterar a AMAIA', { description: error.message });
      return;
    }
    setCfg({ ...cfg, ...patch });
    toast.success(msg);
  };

  return (
    <div className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex min-h-10 items-center gap-2 rounded-full px-3.5 text-sm font-semibold transition-colors ${on ? 'bg-[rgba(34,197,94,0.12)] amaia-on' : 'bg-[var(--color-fill-subtle)] text-[var(--color-text-secondary)]'}`}
      >
        <span className={`h-2.5 w-2.5 rounded-full ${on ? 'bg-[#22C55E]' : 'bg-[var(--color-text-muted)]'}`} />
        <span className="hidden min-[1440px]:inline">{on ? 'AMAIA ativa' : 'AMAIA desligada'}</span>
        <span className="min-[1440px]:hidden">AMAIA</span>
        <ChevronDown className="h-4 w-4 opacity-70" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[var(--z-dropdown)]" onClick={() => setOpen(false)} />
          <div role="menu" className="fade-scale-in absolute right-0 top-[calc(100%+6px)] z-[calc(var(--z-dropdown)+1)] w-72 space-y-1 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-2 shadow-[var(--shadow-lg)]">
            <div className="px-2 pb-1 pt-0.5 text-xs text-[var(--color-text-muted)]">
              {isAdmin ? 'Liga/desliga a AMAIA para todos os atendimentos.' : 'Só o admin pode alterar.'}
            </div>
            <ToggleRow icon={<Power className="h-4 w-4" />} label="AMAIA (geral)" checked={cfg.is_active} disabled={!isAdmin || saving}
              onChange={(v) => void save({ is_active: v }, v ? 'AMAIA ligada.' : 'AMAIA desligada para todos.')} />
            <ToggleRow icon={<MessageCircle className="h-4 w-4 text-[#25D366]" />} label="WhatsApp" checked={cfg.active_whatsapp} disabled={!isAdmin || saving || !cfg.is_active}
              onChange={(v) => void save({ active_whatsapp: v }, v ? 'AMAIA ligada no WhatsApp.' : 'AMAIA desligada no WhatsApp.')} />
            <ToggleRow icon={<Instagram className="h-4 w-4 text-[#E1306C]" />} label="Instagram" checked={cfg.active_instagram} disabled={!isAdmin || saving || !cfg.is_active}
              onChange={(v) => void save({ active_instagram: v }, v ? 'AMAIA ligada no Instagram.' : 'AMAIA desligada no Instagram.')} />
            <Link to="/ai-agent" onClick={() => setOpen(false)} className="block rounded-[var(--radius-control)] px-2 py-2 text-sm font-medium text-[var(--accent-primary)] hover:bg-[var(--color-surface-hover)]">
              Configurar AMAIA
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

function ToggleRow({ icon, label, checked, disabled, onChange }: { icon: React.ReactNode; label: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={`flex min-h-10 items-center justify-between gap-2 rounded-[var(--radius-control)] px-2 text-sm text-[var(--color-text-primary)] ${disabled ? 'opacity-60' : 'cursor-pointer hover:bg-[var(--color-surface-hover)]'}`}>
      <span className="flex items-center gap-2">{icon} {label}</span>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#16A34A]" />
    </label>
  );
}
