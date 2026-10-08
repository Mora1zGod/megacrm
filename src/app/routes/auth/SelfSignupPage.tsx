import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { getSupabase } from '@/lib/supabase';
import { maskPhoneBR } from '@/lib/phone';
import { AuthShell } from './AuthShell';

const inputCls =
  'h-10 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--accent-primary)]';

type State =
  | { s: 'loading' }
  | { s: 'invalid'; message: string }
  | { s: 'form'; orgName: string }
  | { s: 'done'; orgName: string };

async function callSignup(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; org?: { name: string } }> {
  const { data, error } = await getSupabase().functions.invoke('public-signup', { body });
  if (data) return data as { ok: boolean; error?: string; org?: { name: string } };
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try { return await ctx.json(); } catch { /* ignore */ }
  }
  return { ok: false, error: error?.message ?? 'Não foi possível falar com o servidor.' };
}

// /cadastro/:token — a pessoa se cadastra pelo link que o administrador mandou.
// A conta fica aguardando aprovação; só depois dela é possível entrar.
export default function SelfSignupPage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>({ s: 'loading' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [job, setJob] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await callSignup({ action: 'info', token });
      if (cancelled) return;
      if (!r.ok || !r.org) setState({ s: 'invalid', message: r.error ?? 'Link de cadastro inválido.' });
      else setState({ s: 'form', orgName: r.org.name });
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.s !== 'form') return;
    if (name.trim().length < 3) { toast.error('Informe seu nome completo.'); return; }
    if (phone && phone.replace(/\D/g, '').length < 10) { toast.error('Telefone incompleto.'); return; }
    if (password.length < 8) { toast.error('A senha precisa ter pelo menos 8 caracteres.'); return; }
    if (password !== confirm) { toast.error('As senhas não coincidem.'); return; }
    setSending(true);
    const r = await callSignup({
      action: 'submit', token, display_name: name.trim(), email: email.trim(), phone: phone || null, job_title: job.trim() || null, password,
    });
    setSending(false);
    if (!r.ok) { toast.error('Não foi possível concluir o cadastro', { description: r.error }); return; }
    setState({ s: 'done', orgName: state.orgName });
  };

  if (state.s === 'loading') {
    return (
      <AuthShell title="Cadastro" subtitle="Verificando o link…">
        <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-[var(--accent-primary)]" /></div>
      </AuthShell>
    );
  }

  if (state.s === 'invalid') {
    return (
      <AuthShell title="Link indisponível" subtitle={state.message}>
        <Link to="/auth/login" className="block text-center text-sm font-semibold text-[var(--accent-primary)] hover:underline">Ir para o login</Link>
      </AuthShell>
    );
  }

  if (state.s === 'done') {
    return (
      <AuthShell title="Cadastro enviado!" subtitle={`Agora é só aguardar: um administrador da ${state.orgName} vai aprovar o seu acesso.`}>
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(34,197,94,0.12)] text-[var(--color-success)]">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Depois da aprovação, entre com o e-mail <b className="text-[var(--color-text-primary)]">{email.trim().toLowerCase()}</b> e a senha que você acabou de criar.
          </p>
          <Link to="/auth/login" className="text-sm font-semibold text-[var(--accent-primary)] hover:underline">Ir para o login</Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title={`Cadastro · ${state.orgName}`} subtitle="Preencha seus dados. O acesso é liberado depois que um administrador aprovar.">
      <form onSubmit={(e) => void submit(e)} className="space-y-3.5">
        <div className="space-y-1.5">
          <Label htmlFor="su-name">Nome completo</Label>
          <input id="su-name" autoFocus required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Ex.: Maria da Silva" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="su-email">E-mail</Label>
          <input id="su-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="voce@email.com" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="su-phone">Celular</Label>
            <input id="su-phone" inputMode="tel" autoComplete="tel" maxLength={15} value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} className={inputCls} placeholder="(68) 99999-0000" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="su-job">Cargo</Label>
            <input id="su-job" autoComplete="organization-title" value={job} onChange={(e) => setJob(e.target.value)} className={inputCls} placeholder="Ex.: Atendente" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="su-pass">Crie uma senha</Label>
          <PasswordInput id="su-pass" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mínimo 8 caracteres" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="su-pass2">Repita a senha</Label>
          <PasswordInput id="su-pass2" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <Button type="submit" className="w-full" disabled={sending}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} {sending ? 'Enviando…' : 'Enviar cadastro'}
        </Button>
        <p className="text-center text-xs text-[var(--color-text-muted)]">
          Já tem acesso? <Link to="/auth/login" className="font-semibold text-[var(--accent-primary)] hover:underline">Entrar</Link>
        </p>
      </form>
    </AuthShell>
  );
}
