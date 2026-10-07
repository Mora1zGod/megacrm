import { useState, type FormEvent, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { KeyRound, LogOut, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/app/providers/AuthProvider';
import { usePermission } from '@/app/providers/PermissionsProvider';
import { AuthShell } from '@/app/routes/auth/AuthShell';

// Portão depois do login:
//  * usuário desativado/bloqueado → tela "Acesso desativado" (o banco já não
//    entrega mais nenhum dado; aqui só explicamos e oferecemos sair);
//  * troca de senha exigida pelo admin → tela de nova senha antes de tudo.
export function AccessGate({ children }: { children: ReactElement }) {
  const perms = usePermission();
  if (perms.loading) return children; // o RequirePermission de cada rota já mostra o carregamento
  if (!perms.legacy && !perms.active) return <BlockedScreen />;
  if (perms.mustChangePassword) return <ForcePasswordChange onDone={() => void perms.reload()} />;
  return children;
}

function BlockedScreen() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <AuthShell title="Acesso desativado" subtitle="Sua conta foi desativada por um administrador.">
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(239,68,68,0.1)] text-[var(--color-error)]">
          <ShieldOff className="h-7 w-7" />
        </div>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Se isso for um engano, fale com o administrador do CRM para reativar o seu acesso.
        </p>
        <Button className="w-full" onClick={async () => { await signOut(); navigate('/auth/login', { replace: true }); }}>
          <LogOut className="h-4 w-4" /> Sair
        </Button>
      </div>
    </AuthShell>
  );
}

function ForcePasswordChange({ onDone }: { onDone: () => void }) {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) { toast.error('A senha precisa ter pelo menos 8 caracteres.'); return; }
    if (password !== confirm) { toast.error('As senhas não coincidem.'); return; }
    setSaving(true);
    const sb = getSupabase();
    const { error } = await sb.auth.updateUser({ password });
    if (error) {
      setSaving(false);
      toast.error('Não foi possível trocar a senha', {
        description: /should be different|same/i.test(error.message) ? 'A nova senha precisa ser diferente da atual.' : error.message,
      });
      return;
    }
    const { error: flagErr } = await sb.rpc('clear_my_password_flag');
    setSaving(false);
    if (flagErr) { toast.error('Senha trocada, mas não consegui liberar o acesso', { description: flagErr.message }); return; }
    toast.success('Senha atualizada. Bem-vindo!');
    onDone();
  };

  return (
    <AuthShell title="Crie uma nova senha" subtitle="O administrador pediu que você troque a senha antes de continuar.">
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="np">Nova senha</Label>
          <PasswordInput id="np" autoFocus autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="np2">Repita a nova senha</Label>
          <PasswordInput id="np2" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" className="w-full" disabled={saving}>
          <KeyRound className="h-4 w-4" /> {saving ? 'Salvando…' : 'Salvar nova senha'}
        </Button>
        <button type="button" onClick={async () => { await signOut(); navigate('/auth/login', { replace: true }); }}
          className="w-full text-center text-xs text-[var(--color-text-muted)] hover:underline">
          Sair
        </button>
      </form>
    </AuthShell>
  );
}
