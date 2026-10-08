import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Link2, Loader2, MessageCircle, Plus, UserCheck, XCircle } from 'lucide-react';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import { Field, inputCls } from './ui';
import { invokeManage, memberLabel, type AccessRole, type Member, type Team } from './useAccessData';
import { formatPhone } from '@/lib/format';

interface SignupLink {
  id: string;
  token: string;
  access_role_id: string | null;
  team_id: string | null;
  is_active: boolean;
  expires_at: string | null;
  uses: number;
  created_at: string;
}

export function signupUrl(token: string): string {
  return `${window.location.origin}/cadastro/${token}`;
}

function linkExpired(l: SignupLink): boolean {
  return Boolean(l.expires_at && new Date(l.expires_at).getTime() < Date.now());
}

// Perfil sugerido padrão: "Atendimento" (o mais restrito do dia a dia).
function defaultRole(roles: AccessRole[]): AccessRole | undefined {
  return roles.find((r) => r.name === 'Atendimento') ?? roles.find((r) => !r.is_admin) ?? roles[0];
}

// ---------------------------------------------------------------------------
// "Link de cadastro": gerar, copiar, mandar no WhatsApp, desativar.
// ---------------------------------------------------------------------------
export function SignupLinkDialog({ roles, teams, onClose }: { roles: AccessRole[]; teams: Team[]; onClose: () => void }) {
  const [links, setLinks] = useState<SignupLink[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [roleId, setRoleId] = useState(defaultRole(roles)?.id ?? '');
  const [teamId, setTeamId] = useState('');
  const [validity, setValidity] = useState<'none' | '7' | '30'>('none');

  const load = useCallback(async () => {
    const { data, error: err } = await getSupabase()
      .from('signup_links')
      .select('id, token, access_role_id, team_id, is_active, expires_at, uses, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (err) {
      setError(/signup_links/.test(err.message) ? 'Falta rodar o SQL do cadastro por link no Supabase.' : err.message);
      setLinks([]);
      return;
    }
    const list = ((data ?? []) as SignupLink[]).filter((l) => !linkExpired(l));
    setLinks(list);
    if (list.length === 0) setShowNew(true);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setCreating(true);
    const expires = validity === 'none' ? null : new Date(Date.now() + Number(validity) * 86_400_000).toISOString();
    const { error: err } = await getSupabase().from('signup_links').insert({
      access_role_id: roleId || null,
      team_id: teamId || null,
      expires_at: expires,
    });
    setCreating(false);
    if (err) { toast.error('Não foi possível gerar o link', { description: err.message }); return; }
    toast.success('Link de cadastro gerado.');
    setShowNew(false);
    void load();
  };

  const deactivate = async (l: SignupLink) => {
    if (!window.confirm('Desativar este link? Quem ainda não se cadastrou não vai conseguir usar.')) return;
    const { error: err } = await getSupabase().from('signup_links').update({ is_active: false }).eq('id', l.id);
    if (err) { toast.error('Não foi possível desativar', { description: err.message }); return; }
    toast.success('Link desativado.');
    void load();
  };

  const copy = async (l: SignupLink) => {
    try {
      await navigator.clipboard.writeText(signupUrl(l.token));
      toast.success('Link copiado.');
    } catch {
      toast.error('Não consegui copiar. Selecione o link e copie manualmente.');
    }
  };

  const whatsapp = (l: SignupLink) => {
    const text = `Olá! Faça seu cadastro no nosso CRM por este link: ${signupUrl(l.token)}\nAssim que você terminar, eu aprovo o seu acesso.`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  };

  const roleName = (id: string | null) => roles.find((r) => r.id === id)?.name ?? 'Definir na aprovação';
  const teamName = (id: string | null) => teams.find((t) => t.id === id)?.name ?? 'Sem equipe';

  return (
    <Dialog open onClose={onClose} title="Link de cadastro" description="Mande o link para a pessoa. Ela se cadastra e o acesso só é liberado quando você aprovar." widthClass="max-w-xl">
      {error && <div className="mb-3 rounded-lg bg-[rgba(239,68,68,0.08)] px-3 py-2 text-sm text-[var(--color-error)]">{error}</div>}
      {links === null ? (
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>
      ) : (
        <div className="space-y-3">
          {links.map((l) => (
            <div key={l.id} className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] p-3">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                <input readOnly value={signupUrl(l.token)} onFocus={(e) => e.currentTarget.select()} aria-label="Link de cadastro"
                  className="min-w-0 flex-1 bg-transparent text-sm font-medium text-[var(--color-text-primary)] outline-none" />
              </div>
              <div className="mt-1.5 text-xs text-[var(--color-text-muted)]">
                Perfil sugerido: <b className="text-[var(--color-text-secondary)]">{roleName(l.access_role_id)}</b> · {teamName(l.team_id)} ·{' '}
                {l.expires_at ? `vale até ${new Date(l.expires_at).toLocaleDateString('pt-BR')}` : 'sem validade'} ·{' '}
                {l.uses} cadastro{l.uses === 1 ? '' : 's'}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void copy(l)}><Copy className="h-3.5 w-3.5" /> Copiar link</Button>
                <Button size="sm" variant="outline" onClick={() => whatsapp(l)}><MessageCircle className="h-3.5 w-3.5" /> Enviar no WhatsApp</Button>
                <Button size="sm" variant="outline" onClick={() => void deactivate(l)} className="text-[var(--color-error)]"><XCircle className="h-3.5 w-3.5" /> Desativar</Button>
              </div>
            </div>
          ))}

          {showNew ? (
            <div className="space-y-3 rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-card)] p-3">
              <div className="text-sm font-semibold text-[var(--color-text-primary)]">{links.length ? 'Novo link' : 'Gerar link de cadastro'}</div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Perfil sugerido" required htmlFor="sl-role" hint="Você pode trocar na hora de aprovar.">
                  <select id="sl-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} className={inputCls}>
                    {roles.filter((r) => !r.is_admin).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </Field>
                <Field label="Equipe / setor" htmlFor="sl-team">
                  <select id="sl-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} className={inputCls}>
                    <option value="">Sem equipe</option>
                    {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Validade" htmlFor="sl-valid">
                  <select id="sl-valid" value={validity} onChange={(e) => setValidity(e.target.value as 'none' | '7' | '30')} className={inputCls}>
                    <option value="none">Sem validade</option>
                    <option value="7">7 dias</option>
                    <option value="30">30 dias</option>
                  </select>
                </Field>
              </div>
              <div className="flex justify-end gap-2">
                {links.length > 0 && <Button variant="outline" onClick={() => setShowNew(false)}>Cancelar</Button>}
                <Button onClick={() => void create()} disabled={creating || Boolean(error)}>
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />} Gerar link
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setShowNew(true)}><Plus className="h-4 w-4" /> Gerar outro link</Button>
          )}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Aprovar cadastro: escolhe perfil e equipe e libera o acesso.
// ---------------------------------------------------------------------------
export function ApproveSignupDialog({ member, roles, teams, canGrantAdmin, onClose, onDone }: {
  member: Member;
  roles: AccessRole[];
  teams: Team[];
  canGrantAdmin: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [roleId, setRoleId] = useState(member.access_role_id ?? defaultRole(roles)?.id ?? '');
  const [teamId, setTeamId] = useState(member.team_id ?? '');
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    if (!roleId) { toast.error('Escolha o perfil de acesso.'); return; }
    setBusy(true);
    const err = await invokeManage({ action: 'approve', user_id: member.user_id, access_role_id: roleId, team_id: teamId || null });
    setBusy(false);
    if (err) { toast.error('Não foi possível aprovar', { description: err }); return; }
    toast.success(`${memberLabel(member)} foi aprovado e já pode entrar.`);
    onDone();
  };

  return (
    <Dialog open onClose={onClose} title="Aprovar cadastro" description="Escolha o que essa pessoa vai poder acessar.">
      <div className="mb-4 rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-fill-subtle)] px-3 py-2.5 text-sm">
        <div className="font-semibold text-[var(--color-text-primary)]">{memberLabel(member)}</div>
        <div className="text-[var(--color-text-secondary)]">{member.email}</div>
        {(member.phone || member.job_title) && (
          <div className="text-xs text-[var(--color-text-muted)]">{[member.job_title, formatPhone(member.phone)].filter(Boolean).join(' · ')}</div>
        )}
      </div>
      <div className="space-y-3">
        <Field label="Perfil de acesso" required htmlFor="ap-role">
          <select id="ap-role" value={roleId} onChange={(e) => setRoleId(e.target.value)} className={inputCls}>
            {roles.filter((r) => canGrantAdmin || !r.is_admin).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Equipe / setor" htmlFor="ap-team">
          <select id="ap-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} className={inputCls}>
            <option value="">Sem equipe</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-5">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void approve()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />} Aprovar acesso
        </Button>
      </div>
    </Dialog>
  );
}
