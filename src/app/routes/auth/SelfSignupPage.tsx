import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckCircle2, Eye, EyeOff, Loader2, Lock, Mail, Phone, User, UserPlus } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { maskPhoneBR } from '@/lib/phone';

// /cadastro/:token — a pessoa se cadastra pelo link que o administrador mandou.
// A conta fica aguardando aprovação; só depois dela é possível entrar.
// Cargo NÃO é pedido aqui: quem define é o administrador (no convite ou na aprovação).
//
// Página pública de marca: cores fixas (cartão sempre claro sobre o cenário do parque),
// não segue o tema claro/escuro do CRM.

type Org = { name: string; logo_url: string | null };
type State =
  | { s: 'loading' }
  | { s: 'invalid'; message: string }
  | { s: 'form'; org: Org }
  | { s: 'done'; org: Org };

async function callSignup(body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; org?: Org }> {
  const { data, error } = await getSupabase().functions.invoke('public-signup', { body });
  if (data) return data as { ok: boolean; error?: string; org?: Org };
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try { return await ctx.json(); } catch { /* ignore */ }
  }
  return { ok: false, error: error?.message ?? 'Não foi possível falar com o servidor.' };
}

const inputCls =
  'h-11 w-full rounded-xl border border-[#D3DCEA] bg-[#F3F6FB] px-3.5 text-[15px] text-[#0F1B2E] outline-none transition placeholder:text-[#7A879C] focus:border-[#1D4ED8] focus:bg-white focus:ring-4 focus:ring-[#1D4ED8]/15';

// ---------------------------------------------------------------- cenário (céu, palmeiras, piscina)
function Scenery() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,#0B5ED7 0%,#2E8BF0 38%,#7CC6F7 62%,#BFE6FB 70%)' }} />
      <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full" style={{ background: 'radial-gradient(circle,rgba(255,236,150,.55) 0%,rgba(255,236,150,0) 65%)' }} />
      {/* piscina */}
      <div className="absolute inset-x-0 bottom-0 h-[34%]" style={{ background: 'linear-gradient(180deg,#38B6F0 0%,#1593DD 45%,#0B74C4 100%)' }} />
      <svg className="absolute inset-x-0 bottom-0 h-[34%] w-full opacity-30" viewBox="0 0 1200 300" preserveAspectRatio="none">
        {[30, 80, 135, 195].map((y, i) => (
          <path key={y} d={`M0 ${y} Q 75 ${y - 10} 150 ${y} T 300 ${y} T 450 ${y} T 600 ${y} T 750 ${y} T 900 ${y} T 1050 ${y} T 1200 ${y}`}
            stroke="#fff" strokeWidth={i < 2 ? 2 : 3} fill="none" />
        ))}
      </svg>
      {/* borda da piscina */}
      <div className="absolute inset-x-0 bottom-[34%] h-3 bg-[#E9F3FB]" />
      {/* palmeiras */}
      <Palm className="absolute -left-10 bottom-[30%] h-[78%] max-h-[720px]" />
      <Palm className="absolute -right-10 bottom-[30%] h-[70%] max-h-[640px] -scale-x-100" />
      {/* onda amarela/azul no rodapé */}
      <svg className="absolute inset-x-0 bottom-0 h-24 w-full" viewBox="0 0 1200 120" preserveAspectRatio="none">
        <path d="M0 70 C 250 20 450 120 700 70 S 1050 10 1200 50 L1200 120 L0 120 Z" fill="#FFD23F" />
        <path d="M0 90 C 260 50 470 135 720 92 S 1060 40 1200 78 L1200 120 L0 120 Z" fill="#0B3FA8" />
      </svg>
    </div>
  );
}

function Palm({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 260 700" fill="none">
      <path d="M128 700 C 120 520 110 360 140 190" stroke="#5B3A1E" strokeWidth="16" strokeLinecap="round" />
      <path d="M128 700 C 120 520 110 360 140 190" stroke="#7A5230" strokeWidth="6" strokeDasharray="4 18" strokeLinecap="round" />
      {[
        'M140 190 C 90 150 40 160 0 210 C 50 180 95 185 140 196 Z',
        'M140 190 C 110 120 60 90 10 100 C 60 115 100 145 140 194 Z',
        'M140 190 C 150 120 190 80 250 80 C 200 100 170 140 142 194 Z',
        'M140 190 C 190 160 240 175 260 230 C 215 195 180 192 142 198 Z',
        'M140 190 C 140 130 120 70 80 30 C 115 80 128 130 138 192 Z',
      ].map((d) => <path key={d} d={d} fill="#1E7A3C" />)}
      {[
        'M140 192 C 100 165 60 170 25 200',
        'M140 192 C 112 140 75 112 35 108',
        'M142 192 C 160 135 195 102 238 92',
      ].map((d) => <path key={d} d={d} stroke="#2FA052" strokeWidth="3" fill="none" />)}
    </svg>
  );
}

function Shell({ org, children }: { org?: Org; children: ReactNode }) {
  const name = org?.name ?? 'AMAI Park';
  return (
    <div className="relative min-h-screen bg-[#0B74C4] px-4 py-6 sm:py-10">
      <Scenery />
      <div className="mx-auto flex w-full max-w-[1100px] flex-col items-center">
        <div className="mb-5 rounded-3xl bg-white p-2 shadow-[0_12px_40px_rgba(8,40,110,.35)] sm:mb-7">
          <img src={org?.logo_url || '/amai-logo.png'} alt={name} className="h-20 w-20 rounded-2xl object-contain sm:h-24 sm:w-24" />
        </div>
        <div className="relative w-full lg:flex lg:justify-center">
          <Headline name={name} className="mb-5 text-center lg:absolute lg:left-0 lg:top-10 lg:mb-0 lg:w-[250px] lg:text-left" />
          <div className="mx-auto w-full max-w-[520px]">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Headline({ name, className }: { name: string; className: string }) {
  return (
    <div className={className} aria-hidden="true">
      <p className="text-[22px] font-extrabold leading-tight text-white [text-shadow:0_2px_12px_rgba(0,30,90,.45)] lg:text-[34px]">
        Seu acesso ao {name}{' '}
        <span className="relative inline-block italic text-[#FFD23F]">
          começa aqui!
          <svg className="absolute -bottom-2 left-0 h-3 w-full" viewBox="0 0 200 12" preserveAspectRatio="none">
            <path d="M2 9 C 60 2 140 2 198 6" stroke="#FFD23F" strokeWidth="4" fill="none" strokeLinecap="round" />
          </svg>
        </span>
      </p>
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-[28px] bg-white p-5 shadow-[0_24px_60px_rgba(8,40,110,.35)] sm:p-8">{children}</div>;
}

function CardHeader({ title, subtitle, icon }: { title: string; subtitle: string; icon: ReactNode }) {
  return (
    <div className="mb-6 flex items-center gap-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl sm:h-14 sm:w-14 bg-[#E7EFFD] text-[#1D4ED8]">{icon}</div>
      <div className="min-w-0 border-l border-[#E2E8F0] pl-4">
        <h1 className="text-[22px] font-extrabold leading-tight text-[#0F1B2E] sm:text-[26px]">{title}</h1>
        <p className="mt-0.5 text-sm text-[#475569]">{subtitle}</p>
      </div>
    </div>
  );
}

function Row({ icon, label, htmlFor, children }: { icon: ReactNode; label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[22px_1fr] items-start gap-x-3">
      <span className="mt-0.5 text-[#0F1B2E]">{icon}</span>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="mb-1.5 block text-[15px] font-bold text-[#0F1B2E]">
          {label} <span className="text-[#DC2626]">*</span>
        </label>
        {children}
      </div>
    </div>
  );
}

function Password({ id, value, onChange, placeholder }: { id: string; value: string; onChange: (v: string) => void; placeholder: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={show ? 'text' : 'password'} required autoComplete="new-password" value={value}
        onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={`${inputCls} pr-11`} />
      <button type="button" tabIndex={-1} onClick={() => setShow((v) => !v)} aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#475569] hover:bg-[#E7EFFD] hover:text-[#1D4ED8]">
        {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </button>
    </div>
  );
}

const LoginLink = ({ text }: { text: string }) => (
  <p className="text-center text-sm text-[#334155]">
    {text} <Link to="/auth/login" className="font-bold text-[#1D4ED8] hover:underline">Entrar</Link>
  </p>
);

export default function SelfSignupPage() {
  const { token = '' } = useParams();
  const [state, setState] = useState<State>({ s: 'loading' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await callSignup({ action: 'info', token });
      if (cancelled) return;
      if (!r.ok || !r.org) setState({ s: 'invalid', message: r.error ?? 'Link de cadastro inválido.' });
      else setState({ s: 'form', org: { name: r.org.name, logo_url: r.org.logo_url ?? null } });
    })();
    return () => { cancelled = true; };
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state.s !== 'form') return;
    if (name.trim().length < 3) { toast.error('Informe seu nome.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) { toast.error('E-mail inválido.'); return; }
    if (phone.replace(/\D/g, '').length < 10) { toast.error('Informe o celular com DDD.'); return; }
    if (password.length < 8) { toast.error('A senha precisa ter pelo menos 8 caracteres.'); return; }
    if (password !== confirm) { toast.error('As senhas não coincidem.'); return; }
    setSending(true);
    const r = await callSignup({ action: 'submit', token, display_name: name.trim(), email: email.trim(), phone, password });
    setSending(false);
    if (!r.ok) { toast.error('Não foi possível concluir o cadastro', { description: r.error }); return; }
    setState({ s: 'done', org: state.org });
  };

  if (state.s === 'loading') {
    return (
      <Shell>
        <Card>
          <div className="flex flex-col items-center gap-3 py-10 text-[#475569]">
            <Loader2 className="h-6 w-6 animate-spin text-[#1D4ED8]" /> Verificando o link…
          </div>
        </Card>
      </Shell>
    );
  }

  if (state.s === 'invalid') {
    return (
      <Shell>
        <Card>
          <CardHeader title="Link indisponível" subtitle={state.message} icon={<Lock className="h-7 w-7" />} />
          <LoginLink text="Já tem cadastro?" />
        </Card>
      </Shell>
    );
  }

  if (state.s === 'done') {
    return (
      <Shell org={state.org}>
        <Card>
          <div className="flex flex-col items-center gap-4 py-2 text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#DCFCE7] text-[#16A34A]">
              <CheckCircle2 className="h-9 w-9" />
            </div>
            <h1 className="text-2xl font-extrabold text-[#0F1B2E]">Cadastro enviado!</h1>
            <p className="text-[15px] text-[#475569]">
              Agora é só aguardar: um administrador da {state.org.name} vai aprovar o seu acesso.
            </p>
            <p className="text-sm text-[#475569]">
              Depois da aprovação, entre com o e-mail <b className="text-[#0F1B2E]">{email.trim().toLowerCase()}</b> e a senha que você acabou de criar.
            </p>
            <Link to="/auth/login" className="mt-1 inline-flex h-11 items-center rounded-xl bg-[#0B3FA8] px-6 font-bold text-white hover:bg-[#08348C]">
              Ir para o login
            </Link>
          </div>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell org={state.org}>
      <Card>
        <CardHeader title={`Cadastro • ${state.org.name.toUpperCase()}`} subtitle="Preencha seus dados para realizar o cadastro." icon={<UserPlus className="h-7 w-7" />} />
        <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
          <Row icon={<User className="h-5 w-5" />} label="Nome" htmlFor="su-name">
            <input id="su-name" autoFocus required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="Ex.: Maria da Silva" />
          </Row>
          <Row icon={<Mail className="h-5 w-5" />} label="E-mail" htmlFor="su-email">
            <input id="su-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} placeholder="voce@email.com" />
          </Row>
          <Row icon={<Phone className="h-5 w-5" />} label="Celular / WhatsApp" htmlFor="su-phone">
            <input id="su-phone" required inputMode="tel" autoComplete="tel" maxLength={15} value={phone} onChange={(e) => setPhone(maskPhoneBR(e.target.value))} className={inputCls} placeholder="(68) 99999-0000" />
          </Row>
          <Row icon={<Lock className="h-5 w-5" />} label="Crie uma senha" htmlFor="su-pass">
            <Password id="su-pass" value={password} onChange={setPassword} placeholder="Mínimo de 8 caracteres" />
          </Row>
          <Row icon={<Lock className="h-5 w-5" />} label="Repita a senha" htmlFor="su-pass2">
            <Password id="su-pass2" value={confirm} onChange={setConfirm} placeholder="Confirme sua senha" />
          </Row>
          <button type="submit" disabled={sending}
            className="mt-2 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#0B3FA8] text-[17px] font-bold text-white shadow-[0_8px_20px_rgba(11,63,168,.35)] transition hover:bg-[#08348C] disabled:opacity-70">
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <UserPlus className="h-5 w-5" />} {sending ? 'Enviando…' : 'Cadastrar'}
          </button>
          <div className="border-t border-[#E2E8F0] pt-4">
            <LoginLink text="Já tem cadastro?" />
          </div>
        </form>
      </Card>
    </Shell>
  );
}
