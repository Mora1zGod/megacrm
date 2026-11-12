import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { CheckCircle2, FileText, ImagePlus, Loader2, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import { maskPhoneBR } from '@/lib/phone';
import { maskDoc } from '@/lib/format';

// /recadastro/:token — PÚBLICA. O associado do AMAI 10 ou do AMAI Infinity informa os dados dele e dos
// dependentes e manda as fotos dos documentos. Tudo passa pela Edge Function recadastro-public
// (o navegador nunca escreve no banco). A equipe confere em /recadastramentos e lança no Pocket.

type Plan = 'amai10' | 'infinity' | 'nao_sei';
type Rel = 'pai' | 'mae' | 'sogro' | 'sogra' | 'conjuge' | 'filho' | 'outro';
type Kind = 'passaporte' | 'documento' | 'certidao_casamento';

interface Person {
  key: number;
  name: string;
  birth: string;
  relationship: Rel | '';
  relationshipOther: string;
  cpf: string;
  email: string;
  files: File[];
}

interface UploadItem {
  kind: Kind;
  personPosition: number | null;
  file: File;
  done: boolean;
}

const REL_OPTIONS: { value: Rel; label: string }[] = [
  { value: 'conjuge', label: 'Esposo(a) / companheiro(a)' },
  { value: 'filho', label: 'Filho(a)' },
  { value: 'pai', label: 'Pai' },
  { value: 'mae', label: 'Mãe' },
  { value: 'sogro', label: 'Sogro' },
  { value: 'sogra', label: 'Sogra' },
  { value: 'outro', label: 'Outro' },
];
const ONLY_ONE: Rel[] = ['pai', 'mae', 'sogro', 'sogra', 'conjuge'];
const NEEDS_MARRIAGE: Rel[] = ['conjuge', 'sogro', 'sogra'];
const MAX_FILE = 8 * 1024 * 1024;

const inputCls =
  'h-11 w-full rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 text-[15px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--accent-primary)]';

type Resp = { ok: boolean; error?: string; [k: string]: unknown };

async function callFn(body: Record<string, unknown>): Promise<Resp> {
  const { data, error } = await getSupabase().functions.invoke('recadastro-public', { body });
  if (data) return data as Resp;
  const ctx = (error as { context?: Response } | null)?.context;
  if (ctx && typeof ctx.json === 'function') {
    try { return (await ctx.json()) as Resp; } catch { /* ignore */ }
  }
  return { ok: false, error: 'Sem conexão com o servidor. Confira a internet e tente de novo.' };
}

// Foto do celular costuma ter 4–8 MB: reduz para no máx. 1800 px (JPEG) antes de mandar. PDF vai como está.
async function toBase64(file: File): Promise<string> {
  let blob: Blob = file;
  if (file.type.startsWith('image/') && file.type !== 'image/gif') {
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('img'))), 'image/jpeg', 0.85));
    } catch {
      blob = file; // formato que o navegador não abre (ex.: HEIC) — o servidor recusa com mensagem clara
    }
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

function cpfValid(raw: string): boolean {
  const cpf = raw.replace(/\D/g, '');
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

function Section({ n, title, hint, children }: { n: number; title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-sm font-bold text-white">{n}</span>
        <div>
          <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
          {hint && <p className="mt-0.5 text-sm text-[var(--color-text-secondary)]">{hint}</p>}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({ label, children, optional }: { label: string; children: ReactNode; optional?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-[var(--color-text-label)]">
        {label} {optional && <span className="font-normal text-[var(--color-text-muted)]">(se tiver)</span>}
      </span>
      {children}
    </label>
  );
}

function FilePicker({ label, files, onChange }: { label: string; files: File[]; onChange: (f: File[]) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium text-[var(--color-text-label)]">{label}</div>
      {files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] px-2.5 py-1.5 text-sm">
              <FileText className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">{f.name}</span>
              <button type="button" aria-label="Remover arquivo" className="rounded p-1 text-[var(--color-text-muted)] hover:text-[var(--color-error)]" onClick={() => onChange(files.filter((_, j) => j !== i))}>
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={ref}
        type="file"
        accept="image/*,application/pdf"
        multiple
        className="hidden"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []).filter((f) => f.size <= MAX_FILE * 3);
          onChange([...files, ...list].slice(0, 6));
          e.target.value = '';
        }}
      />
      <Button type="button" variant="outline" className="w-full" onClick={() => ref.current?.click()}>
        <ImagePlus className="h-4 w-4" /> {files.length ? 'Adicionar mais (ex.: verso)' : 'Tirar foto ou escolher arquivo'}
      </Button>
    </div>
  );
}

export default function RecadastroPage() {
  const { token = '' } = useParams();
  const [phase, setPhase] = useState<'loading' | 'invalid' | 'form' | 'sending' | 'done'>('loading');
  const [invalidMsg, setInvalidMsg] = useState('');
  const [orgName, setOrgName] = useState('AMAI Park');
  const [logo, setLogo] = useState<string | null>(null);

  const [plan, setPlan] = useState<Plan | ''>('');
  const [peopleCount, setPeopleCount] = useState('');
  const [passportNumber, setPassportNumber] = useState('');
  const [passportFiles, setPassportFiles] = useState<File[]>([]);
  const [holder, setHolder] = useState({ name: '', cpf: '', birth: '', email: '', phone: '' });
  const [holderFiles, setHolderFiles] = useState<File[]>([]);
  const [portal, setPortal] = useState<'email' | 'whatsapp' | ''>('');
  const [people, setPeople] = useState<Person[]>([]);
  const [marriageFiles, setMarriageFiles] = useState<File[]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [protocol, setProtocol] = useState<number | null>(null);
  const pending = useRef<{ submissionId: string; uploadKey: string; queue: UploadItem[] } | null>(null);
  const nextKey = useRef(1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await callFn({ action: 'info', token });
      if (cancelled) return;
      if (!r.ok) { setInvalidMsg(r.error ?? 'Link inválido.'); setPhase('invalid'); return; }
      const org = r.org as { name: string; logo_url: string | null };
      setOrgName(org.name); setLogo(org.logo_url); setPhase('form');
    })();
    return () => { cancelled = true; };
  }, [token]);

  const maxDependents = plan === 'amai10' ? Math.max(0, (Number(peopleCount) || 1) - 1) : 30;
  const relOptions = plan === 'infinity' ? REL_OPTIONS.filter((o) => o.value !== 'outro') : REL_OPTIONS;
  const needsMarriage = people.some((p) => p.relationship && NEEDS_MARRIAGE.includes(p.relationship as Rel));
  const usedOnce = useMemo(() => new Set(people.map((p) => p.relationship).filter((r) => ONLY_ONE.includes(r as Rel))), [people]);

  const setPerson = (key: number, patch: Partial<Person>) => setPeople((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const addPerson = () => setPeople((ps) => [...ps, { key: nextKey.current++, name: '', birth: '', relationship: '', relationshipOther: '', cpf: '', email: '', files: [] }]);

  // AMAI 10: se diminuir a quantidade, corta os dependentes que não cabem mais.
  useEffect(() => {
    if (plan === 'amai10') setPeople((ps) => ps.slice(0, maxDependents));
    if (plan === 'infinity') setPeople((ps) => ps.map((p) => (p.relationship === 'outro' ? { ...p, relationship: '' } : p)));
  }, [plan, maxDependents]);

  function validate(): string | null {
    if (!plan) return 'Escolha o seu passaporte (AMAI 10 ou AMAI Infinity).';
    if (plan === 'amai10' && !(Number(peopleCount) >= 1 && Number(peopleCount) <= 10)) return 'No AMAI 10, diga para quantas pessoas foi a compra (de 1 a 10, contando você).';
    if (!passportFiles.length) return 'Envie a foto do passaporte, título, contrato ou comprovante de pagamento.';
    const name = holder.name.trim();
    if (name.length < 5 || !name.includes(' ')) return 'Informe o nome completo do titular.';
    if (!cpfValid(holder.cpf)) return 'CPF do titular inválido.';
    if (holder.phone.replace(/\D/g, '').length < 10) return 'Informe o WhatsApp com DDD.';
    if (!portal) return 'Escolha como quer receber o acesso ao Portal do Associado.';
    if (portal === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(holder.email.trim())) return 'Informe um e-mail válido para receber o acesso ao portal.';
    if (!holderFiles.length) return 'Envie a foto do RG ou CNH do titular.';
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      const n = `Dependente ${i + 1}`;
      if (p.name.trim().length < 5 || !p.name.trim().includes(' ')) return `${n}: informe o nome completo.`;
      if (!p.birth) return `${n}: informe a data de nascimento.`;
      if (!p.relationship) return `${n}: escolha o parentesco.`;
      if (p.relationship === 'outro' && !p.relationshipOther.trim()) return `${n}: diga qual é o parentesco.`;
      if (p.cpf && !cpfValid(p.cpf)) return `${n}: CPF inválido.`;
      if (!p.files.length) return `${n}: envie a foto do RG, CNH ou certidão de nascimento.`;
    }
    if (needsMarriage && !marriageFiles.length) return 'Envie a certidão de casamento ou o documento da união estável.';
    if (!consent) return 'Marque que concorda com o uso dos dados para o recadastramento.';
    return null;
  }

  async function runUploads() {
    const pend = pending.current!;
    for (const item of pend.queue) {
      if (item.done) continue;
      const data = await toBase64(item.file);
      const r = await callFn({
        action: 'upload', token, submission_id: pend.submissionId, upload_key: pend.uploadKey,
        kind: item.kind, person_position: item.personPosition, data_base64: data,
      });
      if (!r.ok) throw new Error(`${item.file.name}: ${r.error ?? 'falha no envio'}`);
      item.done = true;
      setProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    const fin = await callFn({ action: 'finish', token, submission_id: pend.submissionId, upload_key: pend.uploadKey });
    if (!fin.ok) throw new Error(fin.error ?? 'Não foi possível concluir.');
    setProtocol(Number(fin.protocol));
    setPhase('done');
    window.scrollTo({ top: 0 });
  }

  async function send() {
    setError(null);
    if (pending.current) {
      // Já criado: só tenta de novo o que faltou.
      setPhase('sending');
      try { await runUploads(); } catch (e) { setError((e as Error).message); setPhase('form'); }
      return;
    }
    const problem = validate();
    if (problem) { setError(problem); return; }
    setPhase('sending');
    const r = await callFn({
      action: 'submit', token, consent: true, plan,
      people_count: plan === 'amai10' ? Number(peopleCount) : null,
      passport_number: passportNumber.trim() || null,
      portal_access: portal,
      holder: { name: holder.name.trim(), cpf: holder.cpf, birth: holder.birth || null, email: holder.email.trim() || null, phone: holder.phone },
      people: people.map((p) => ({
        name: p.name.trim(), birth: p.birth, relationship: p.relationship,
        relationship_other: p.relationship === 'outro' ? p.relationshipOther.trim() : null,
        cpf: p.cpf || null, email: p.email.trim() || null,
      })),
    });
    if (!r.ok) { setError(r.error ?? 'Não foi possível enviar.'); setPhase('form'); return; }
    const queue: UploadItem[] = [
      ...passportFiles.map((file) => ({ kind: 'passaporte' as Kind, personPosition: null, file, done: false })),
      ...holderFiles.map((file) => ({ kind: 'documento' as Kind, personPosition: null, file, done: false })),
      ...people.flatMap((p, i) => p.files.map((file) => ({ kind: 'documento' as Kind, personPosition: i + 1, file, done: false }))),
      ...(needsMarriage ? marriageFiles.map((file) => ({ kind: 'certidao_casamento' as Kind, personPosition: null, file, done: false })) : []),
    ];
    pending.current = { submissionId: String(r.submission_id), uploadKey: String(r.upload_key), queue };
    setProgress({ done: 0, total: queue.length });
    try { await runUploads(); } catch (e) { setError(`${(e as Error).message} Toque em "Tentar de novo".`); setPhase('form'); }
  }

  const header = (
    <header className="flex items-center gap-3">
      {logo ? <img src={logo} alt="" className="h-12 w-12 rounded-xl object-contain" /> : <img src="/amai-logo.png" alt="" className="h-12 w-12 rounded-xl" />}
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{orgName}</div>
        <h1 className="text-xl font-bold text-[var(--color-text-primary)]">Atualização cadastral</h1>
      </div>
    </header>
  );

  if (phase === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-[var(--color-bg-primary)]"><Loader2 className="h-6 w-6 animate-spin text-[var(--accent-primary)]" /></div>;
  }

  if (phase === 'invalid') {
    return (
      <div className="min-h-screen bg-[var(--color-bg-primary)] px-4 py-10">
        <div className="mx-auto max-w-xl space-y-4">{header}<p className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-[var(--color-text-secondary)]">{invalidMsg}</p></div>
      </div>
    );
  }

  if (phase === 'done') {
    return (
      <div className="min-h-screen bg-[var(--color-bg-primary)] px-4 py-10">
        <div className="mx-auto max-w-xl space-y-5">
          {header}
          <div className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-5 text-center">
            <CheckCircle2 className="mx-auto h-12 w-12 text-[var(--color-success)]" />
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Recebemos o seu recadastramento!</h2>
            <p className="text-[var(--color-text-secondary)]">Protocolo <b className="text-[var(--color-text-primary)]">#{protocol}</b></p>
            <div className="space-y-2 text-left text-sm text-[var(--color-text-secondary)]">
              <p>• A nossa equipe vai analisar os dados e os documentos.</p>
              <p>• Depois de concluído, você recebe o acesso ao <b>Portal do Associado</b> por {portal === 'email' ? 'e-mail' : 'WhatsApp'}.</p>
              <p>• No portal, você tira a <b>foto do rosto</b> — sua e de cada dependente — para o reconhecimento facial na entrada. <b>Essa foto é feita uma única vez</b>, então faça com calma, em lugar claro.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const sending = phase === 'sending';
  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] px-4 py-6 sm:py-10">
      <div className="mx-auto max-w-xl space-y-4">
        {header}
        <p className="text-sm text-[var(--color-text-secondary)]">
          Preencha os seus dados e os dos dependentes e envie as fotos dos documentos. Leva uns 5 minutos.
          Tenha em mãos: foto do passaporte (ou comprovante de pagamento) e o RG ou CNH de todos.
        </p>

        <Section n={1} title="Seu passaporte">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {([['amai10', 'AMAI 10'], ['infinity', 'AMAI Infinity'], ['nao_sei', 'Não sei']] as const).map(([v, l]) => (
              <button key={v} type="button" onClick={() => setPlan(v)}
                className={`h-11 rounded-[var(--radius-control)] border text-sm font-semibold ${plan === v ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]'}`}>
                {l}
              </button>
            ))}
          </div>
          {plan === 'amai10' && (
            <Field label="Para quantas pessoas foi a compra? (contando você)">
              <select className={inputCls} value={peopleCount} onChange={(e) => setPeopleCount(e.target.value)}>
                <option value="">Escolha…</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} {n === 1 ? 'pessoa (só eu)' : 'pessoas'}</option>)}
              </select>
            </Field>
          )}
          {plan === 'infinity' && <p className="text-sm text-[var(--color-text-secondary)]">O AMAI Infinity é familiar: podem entrar pai, mãe, sogro, sogra, esposo(a) e filhos.</p>}
          <Field label="Número do passaporte ou contrato" optional>
            <input className={inputCls} value={passportNumber} maxLength={40} onChange={(e) => setPassportNumber(e.target.value)} />
          </Field>
          <FilePicker label="Foto do passaporte, título, contrato ou comprovante de pagamento" files={passportFiles} onChange={setPassportFiles} />
        </Section>

        <Section n={2} title="Titular">
          <Field label="Nome completo"><input className={inputCls} autoComplete="name" value={holder.name} onChange={(e) => setHolder({ ...holder, name: e.target.value })} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="CPF"><input className={inputCls} inputMode="numeric" value={holder.cpf} onChange={(e) => setHolder({ ...holder, cpf: maskDoc(e.target.value).slice(0, 14) })} placeholder="000.000.000-00" /></Field>
            <Field label="Data de nascimento" optional><input type="date" className={inputCls} value={holder.birth} onChange={(e) => setHolder({ ...holder, birth: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="WhatsApp com DDD"><input className={inputCls} inputMode="tel" autoComplete="tel" value={holder.phone} maxLength={15} onChange={(e) => setHolder({ ...holder, phone: maskPhoneBR(e.target.value) })} placeholder="(68) 99999-0000" /></Field>
            <Field label="E-mail"><input type="email" className={inputCls} autoComplete="email" value={holder.email} onChange={(e) => setHolder({ ...holder, email: e.target.value })} /></Field>
          </div>
          <div className="space-y-1">
            <span className="text-sm font-medium text-[var(--color-text-label)]">Receber o acesso ao Portal do Associado por</span>
            <div className="grid grid-cols-2 gap-2">
              {([['whatsapp', 'WhatsApp'], ['email', 'E-mail']] as const).map(([v, l]) => (
                <button key={v} type="button" onClick={() => setPortal(v)}
                  className={`h-11 rounded-[var(--radius-control)] border text-sm font-semibold ${portal === v ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]'}`}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <FilePicker label="Foto do RG ou CNH do titular (frente e verso)" files={holderFiles} onChange={setHolderFiles} />
        </Section>

        <Section n={3} title="Dependentes"
          hint={plan === 'amai10'
            ? (maxDependents ? `Seu AMAI 10 permite até ${maxDependents} dependente(s).` : 'Compra para 1 pessoa: não há dependentes.')
            : 'Só quem vai usar o passaporte com você.'}>
          {people.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">Nenhum dependente adicionado.</p>}
          {people.map((p, i) => (
            <div key={p.key} className="space-y-3 rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--color-text-primary)]">Dependente {i + 1}</span>
                <button type="button" className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-error)]" onClick={() => setPeople((ps) => ps.filter((x) => x.key !== p.key))}>
                  <Trash2 className="h-4 w-4" /> Remover
                </button>
              </div>
              <Field label="Nome completo"><input className={inputCls} value={p.name} onChange={(e) => setPerson(p.key, { name: e.target.value })} /></Field>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Data de nascimento"><input type="date" className={inputCls} value={p.birth} onChange={(e) => setPerson(p.key, { birth: e.target.value })} /></Field>
                <Field label="Parentesco">
                  <select className={inputCls} value={p.relationship} onChange={(e) => setPerson(p.key, { relationship: e.target.value as Rel })}>
                    <option value="">Escolha…</option>
                    {relOptions.map((o) => (
                      <option key={o.value} value={o.value} disabled={o.value !== p.relationship && usedOnce.has(o.value)}>{o.label}</option>
                    ))}
                  </select>
                </Field>
              </div>
              {p.relationship === 'outro' && (
                <Field label="Qual parentesco?"><input className={inputCls} maxLength={40} value={p.relationshipOther} onChange={(e) => setPerson(p.key, { relationshipOther: e.target.value })} /></Field>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="CPF" optional><input className={inputCls} inputMode="numeric" value={p.cpf} onChange={(e) => setPerson(p.key, { cpf: maskDoc(e.target.value).slice(0, 14) })} /></Field>
                <Field label="E-mail" optional><input type="email" className={inputCls} value={p.email} onChange={(e) => setPerson(p.key, { email: e.target.value })} /></Field>
              </div>
              <FilePicker label="RG ou CNH (criança sem RG: certidão de nascimento)" files={p.files} onChange={(files) => setPerson(p.key, { files })} />
            </div>
          ))}
          {plan && people.length < maxDependents && (
            <Button type="button" variant="outline" className="w-full" onClick={addPerson}><Plus className="h-4 w-4" /> Adicionar dependente</Button>
          )}
          {!plan && <p className="text-sm text-[var(--color-text-muted)]">Escolha o passaporte no passo 1 para adicionar dependentes.</p>}
        </Section>

        {needsMarriage && (
          <Section n={4} title="Comprovante de casamento ou união" hint="Como você incluiu esposo(a), sogro ou sogra, envie a certidão de casamento ou o documento que comprove a união estável.">
            <FilePicker label="Certidão de casamento ou união estável" files={marriageFiles} onChange={setMarriageFiles} />
          </Section>
        )}

        <label className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-secondary)]">
          <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            <ShieldCheck className="mr-1 inline h-4 w-4 text-[var(--accent-primary)]" />
            Concordo que o {orgName} use estes dados e documentos somente para o recadastramento e o acesso ao parque, conforme a LGPD.
          </span>
        </label>

        {error && <p role="alert" className="rounded-[var(--radius-control)] border border-[var(--color-error)] bg-[rgba(220,38,38,0.08)] p-3 text-sm text-[var(--color-error)]">{error}</p>}

        <Button type="button" className="h-12 w-full text-base" disabled={sending} onClick={() => void send()}>
          {sending
            ? <><Loader2 className="h-5 w-5 animate-spin" /> Enviando {progress.total ? `${progress.done}/${progress.total} arquivos` : '…'}</>
            : pending.current ? 'Tentar de novo' : 'Enviar recadastramento'}
        </Button>
        <p className="pb-6 text-center text-xs text-[var(--color-text-muted)]">Seus dados são enviados com segurança e vistos só pela equipe do {orgName}.</p>
      </div>
    </div>
  );
}
