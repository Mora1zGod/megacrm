import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { Camera, Check, CheckCircle2, ChevronLeft, ChevronRight, FileText, Info, Loader2, Pencil, Plus, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getSupabase } from '@/lib/supabase';
import { maskPhoneBR } from '@/lib/phone';
import { maskDoc } from '@/lib/format';

// /recadastro/:token — PÚBLICA. O associado do AMAI 10 ou do AMAI INFINITY informa os dados dele e dos
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
  // a imagem frente+verso já vem do joinFrontBack no tamanho certo (até 3200 px de altura)
  if (file.type.startsWith('image/') && file.type !== 'image/gif' && file.name !== 'passaporte-frente-verso.jpg') {
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

// Passaporte com frente e verso em foto: junta as duas numa imagem só (frente em cima, verso embaixo) — chega 1 arquivo para a equipe.
async function joinFrontBack(files: File[]): Promise<File[]> {
  if (files.length !== 2 || !files.every((f) => f.type.startsWith('image/') && f.type !== 'image/gif')) return files;
  try {
    const [a, b] = await Promise.all(files.map((f) => createImageBitmap(f)));
    const w = Math.min(1600, Math.max(a.width, b.width));
    const ha = Math.round(a.height * (w / a.width));
    const hb = Math.round(b.height * (w / b.width));
    const gap = 16;
    const scale = Math.min(1, 3200 / (ha + hb + gap));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round((ha + hb + gap) * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(a, 0, 0, canvas.width, Math.round(ha * scale));
    ctx.drawImage(b, 0, Math.round((ha + gap) * scale), canvas.width, Math.round(hb * scale));
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((x) => (x ? res(x) : rej(new Error('img'))), 'image/jpeg', 0.85));
    return [new File([blob], 'passaporte-frente-verso.jpg', { type: 'image/jpeg' })];
  } catch {
    return files; // o navegador não abriu a imagem: manda as duas como estão
  }
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

// Aviso que aparece no começo e na conferência: nada é liberado na hora.
// O login do Portal vai SEMPRE pelos dois: WhatsApp e e-mail informados pelo titular.
function ReviewNotice() {
  const via = 'no seu WhatsApp e no seu e-mail';
  return (
    <div className="flex gap-3 rounded-[var(--radius-card)] border border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] p-4 text-sm text-[var(--color-text-primary)]">
      <Info className="mt-0.5 h-5 w-5 shrink-0 text-[var(--accent-primary)]" />
      <div className="space-y-1">
        <p className="font-semibold">Seus dados passam por análise da nossa equipe.</p>
        <p className="text-[var(--color-text-secondary)]">
          Em até <b className="text-[var(--color-text-primary)]">5 dias úteis</b> após o envio entramos em contato {via}. Estando tudo certo, você recebe o
          <b className="text-[var(--color-text-primary)]"> login e a senha do Portal do Associado</b>. O acesso não é liberado na hora.
        </p>
      </div>
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 sm:p-5">
      <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">{title}</h2>
      {hint && <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
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

// Fluxo fácil no celular: depois de escolher/adicionar algo, rola a tela até o próximo campo (o elemento
// seguinte no mesmo bloco ou no bloco de cima). Sem próximo, vai para o fim — o botão Continuar fica fixo embaixo.
function scrollToNext(from: HTMLElement | null) {
  window.setTimeout(() => {
    let el: Element | null = from;
    while (el && !el.nextElementSibling) el = el.parentElement;
    const next = el?.nextElementSibling as HTMLElement | null | undefined;
    if (next && next.getBoundingClientRect().height > 0) next.scrollIntoView({ behavior: 'smooth', block: 'center' });
    else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }, 150);
}

function Choice<T extends string>({ value, options, onChange, cols = 2 }: { value: T | ''; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; cols?: 2 | 3 }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} className={`grid grid-cols-1 gap-2 ${cols === 3 ? 'sm:grid-cols-3' : 'grid-cols-2'}`}>
      {options.map(([v, l]) => (
        <button key={v} type="button" onClick={() => { onChange(v); scrollToNext(ref.current); }}
          className={`h-12 rounded-[var(--radius-control)] border text-[15px] font-semibold ${value === v ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]' : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)]'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}

// Data digitada em 3 caixas (dia / mês / ano) com teclado numérico. Devolve 'AAAA-MM-DD' ou '' se incompleta/inválida.
function DateInput({ value, onChange, label, optional }: { value: string; onChange: (iso: string) => void; label: string; optional?: boolean }) {
  const init = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-') : ['', '', ''];
  const [d, setD] = useState(init[2]);
  const [m, setM] = useState(init[1]);
  const [y, setY] = useState(init[0]);
  const mRef = useRef<HTMLInputElement>(null);
  const yRef = useRef<HTMLInputElement>(null);
  const full = d.length >= 1 && m.length >= 1 && y.length === 4;
  let iso = '';
  if (full) {
    const dd = Number(d), mm = Number(m), yy = Number(y);
    const dt = new Date(Date.UTC(yy, mm - 1, dd));
    const ok = yy >= 1900 && dt.getUTCFullYear() === yy && dt.getUTCMonth() === mm - 1 && dt.getUTCDate() === dd && dt.getTime() <= Date.now();
    if (ok) iso = `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  useEffect(() => { if (iso !== value) onChange(iso); }, [iso]); // eslint-disable-line react-hooks/exhaustive-deps
  const box = `${inputCls} text-center`;
  const num = (s: string, n: number) => s.replace(/\D/g, '').slice(0, n);
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium text-[var(--color-text-label)]">
        {label} {optional && <span className="font-normal text-[var(--color-text-muted)]">(se tiver)</span>}
      </span>
      <div className="grid grid-cols-[1fr_1fr_1.5fr] gap-2">
        <input aria-label="Dia" className={box} inputMode="numeric" placeholder="Dia" value={d}
          onChange={(e) => { const v = num(e.target.value, 2); setD(v); if (v.length === 2) mRef.current?.focus(); }} />
        <input ref={mRef} aria-label="Mês" className={box} inputMode="numeric" placeholder="Mês" value={m}
          onChange={(e) => { const v = num(e.target.value, 2); setM(v); if (v.length === 2) yRef.current?.focus(); }} />
        <input ref={yRef} aria-label="Ano" className={box} inputMode="numeric" placeholder="Ano" value={y}
          onChange={(e) => setY(num(e.target.value, 4))} />
      </div>
      {full && !iso && <p className="text-sm text-[var(--color-error)]">Data inválida. Confira dia, mês e ano.</p>}
    </div>
  );
}

function Thumb({ file }: { file: File }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  if (!url) {
    return <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-1 text-[var(--color-text-muted)]"><FileText className="h-7 w-7" /><span className="w-full truncate text-center text-[10px]">{file.name}</span></div>;
  }
  return <img src={url} alt="" className="h-full w-full object-cover" />;
}

// Fotos de documento: "Tirar foto" (abre a câmera) separado de "Escolher arquivo"; mostra o que já foi
// escolhido, com excluir; depois da 1ª, o botão vira "Adicionar verso / outra foto".
// max = quantas fotos (passaporte: 2 = frente e verso). Um PDF vale pelo documento inteiro: PDF escolhido substitui as fotos.
function PhotoPicker({ label, hint, files, onChange, max = 6 }: { label: string; hint?: string; files: File[]; onChange: (f: File[]) => void; max?: number }) {
  const camRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const add = (list: FileList | null) => {
    const ok = Array.from(list ?? []).filter((f) => f.size <= MAX_FILE * 3);
    if (!ok.length) return;
    const pdf = ok.find((f) => f.type === 'application/pdf');
    if (pdf) onChange([pdf]);
    else onChange([...files.filter((f) => f.type !== 'application/pdf'), ...ok].slice(0, max));
    // Deixa à vista a miniatura e o próximo passo (verso / próximo campo / Continuar).
    scrollToNext(boxRef.current);
  };
  return (
    <div ref={boxRef} className="space-y-2">
      <div className="text-[15px] font-semibold text-[var(--color-text-primary)]">{label}</div>
      <p className="flex items-start gap-1.5 text-sm text-[var(--color-text-secondary)]">
        <Camera className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{hint ?? 'Fotografe o documento inteiro, sem cortar as bordas, em lugar claro e sem reflexo.'}</span>
      </p>
      {files.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="relative aspect-[3/4] overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-border-card)] bg-[var(--color-surface-raised)]">
              <Thumb file={f} />
              <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">{f.type === 'application/pdf' ? 'PDF' : i === 0 ? 'Frente' : i === 1 ? 'Verso' : `${i + 1}ª`}</span>
              <button type="button" aria-label="Excluir foto" onClick={() => onChange(files.filter((_, j) => j !== i))}
                className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      <input ref={fileRef} type="file" accept="image/*,application/pdf" multiple={max > 1} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
      {files.length < max && !files.some((f) => f.type === 'application/pdf') && (
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" className="h-12" onClick={() => camRef.current?.click()}>
            <Camera className="h-5 w-5" /> {files.length ? 'Foto do verso' : 'Tirar foto'}
          </Button>
          <Button type="button" variant="outline" className="h-12" onClick={() => fileRef.current?.click()}>
            <Upload className="h-5 w-5" /> Escolher arquivo
          </Button>
        </div>
      )}
      {max <= 2 && files.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">Até 2 fotos (frente e verso) ou 1 PDF.</p>}
    </div>
  );
}

const STEPS = ['Passaporte', 'Titular', 'Documentos', 'Dependentes', 'Conferência'] as const;

function relLabel(p: Person) {
  if (p.relationship === 'outro') return p.relationshipOther || 'Outro';
  return REL_OPTIONS.find((o) => o.value === p.relationship)?.label ?? '—';
}
function brDate(iso: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.split('-').reverse().join('/') : '—';
}

export default function RecadastroPage() {
  const { token = '' } = useParams();
  const [phase, setPhase] = useState<'loading' | 'invalid' | 'form' | 'sending' | 'done'>('loading');
  const [invalidMsg, setInvalidMsg] = useState('');
  const [orgName, setOrgName] = useState('AMAI Park');
  const [logo, setLogo] = useState<string | null>(null);
  const [step, setStep] = useState(0);

  const [plan, setPlan] = useState<Plan | ''>('');
  const [peopleCount, setPeopleCount] = useState('');
  const [passportNumber, setPassportNumber] = useState('');
  const [passportFiles, setPassportFiles] = useState<File[]>([]);
  const [holder, setHolder] = useState({ name: '', cpf: '', birth: '', email: '', phone: '' });
  const [holderFiles, setHolderFiles] = useState<File[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [openKey, setOpenKey] = useState<number | null>(null);
  const [marriageFiles, setMarriageFiles] = useState<File[]>([]);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [protocol, setProtocol] = useState<number | null>(null);
  const pending = useRef<{ submissionId: string; uploadKey: string; queue: UploadItem[] } | null>(null);
  const nextKey = useRef(1);
  const openedRef = useRef<number | null>(null);

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
  const addPerson = () => {
    const key = nextKey.current++;
    setPeople((ps) => [...ps, { key, name: '', birth: '', relationship: '', relationshipOther: '', cpf: '', email: '', files: [] }]);
    setOpenKey(key);
    openedRef.current = key; // o cartão novo rola até o topo e foca o nome
  };

  // AMAI 10: se diminuir a quantidade, corta os dependentes que não cabem mais.
  useEffect(() => {
    if (plan === 'amai10') setPeople((ps) => ps.slice(0, maxDependents));
    if (plan === 'infinity') setPeople((ps) => ps.map((p) => (p.relationship === 'outro' ? { ...p, relationship: '' } : p)));
  }, [plan, maxDependents]);

  function personProblem(p: Person, i: number): string | null {
    const n = `Dependente ${i + 1}`;
    if (p.name.trim().length < 5 || !p.name.trim().includes(' ')) return `${n}: informe o nome completo.`;
    if (!p.birth) return `${n}: informe a data de nascimento (dia, mês e ano).`;
    if (!p.relationship) return `${n}: escolha o parentesco.`;
    if (p.relationship === 'outro' && !p.relationshipOther.trim()) return `${n}: diga qual é o parentesco.`;
    if (!p.cpf) return `${n}: informe o CPF (criança também tem CPF; está na certidão de nascimento).`;
    if (!cpfValid(p.cpf)) return `${n}: CPF inválido.`;
    if (!p.files.length) return `${n}: envie a foto do RG, CNH ou certidão de nascimento.`;
    return null;
  }

  function stepProblem(s: number): string | null {
    if (s === 0) {
      if (!plan) return 'Escolha o seu passaporte (AMAI 10 ou AMAI INFINITY).';
      if (plan === 'amai10' && !(Number(peopleCount) >= 1 && Number(peopleCount) <= 10)) return 'No AMAI 10, diga para quantas pessoas foi a compra (de 1 a 10, contando você).';
      if (!passportFiles.length) return 'Envie a foto do passaporte, título, contrato ou comprovante de pagamento.';
    }
    if (s === 1) {
      const name = holder.name.trim();
      if (name.length < 5 || !name.includes(' ')) return 'Informe o nome completo do titular.';
      if (!cpfValid(holder.cpf)) return 'CPF do titular inválido.';
      if (holder.phone.replace(/\D/g, '').length < 10) return 'Informe o WhatsApp com DDD.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(holder.email.trim())) return 'Informe um e-mail válido: o login do Portal também vai para ele.';
    }
    if (s === 2 && !holderFiles.length) return 'Envie a foto do RG ou CNH do titular.';
    if (s === 3) {
      for (let i = 0; i < people.length; i++) {
        const pr = personProblem(people[i], i);
        if (pr) { setOpenKey(people[i].key); return pr; }
      }
      if (plan === 'amai10' && people.length < maxDependents) {
        const falta = maxDependents - people.length;
        return `Seu AMAI 10 é para ${peopleCount} pessoas: falta${falta > 1 ? 'm' : ''} cadastrar ${falta} dependente${falta > 1 ? 's' : ''}. Toque em "Adicionar dependente".`;
      }
      if (needsMarriage && !marriageFiles.length) return 'Envie a certidão de casamento ou o documento da união estável.';
    }
    if (s === 4 && !consent) return 'Marque que concorda com o uso dos dados para o recadastramento.';
    return null;
  }

  function goTo(s: number) {
    setError(null);
    setStep(s);
    window.scrollTo({ top: 0 });
  }

  function next() {
    const pr = stepProblem(step);
    if (pr) { setError(pr); return; }
    if (step === 3) setOpenKey(null);
    goTo(step + 1);
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
    for (let s = 0; s <= 4; s++) {
      const pr = stepProblem(s);
      if (pr) { setError(pr); if (s !== 4) setStep(s); return; }
    }
    setPhase('sending');
    const r = await callFn({
      action: 'submit', token, consent: true, plan,
      people_count: plan === 'amai10' ? Number(peopleCount) : null,
      passport_number: passportNumber.trim() || null,
      portal_access: 'whatsapp', // login vai pelos dois (WhatsApp e e-mail); campo mantido por compatibilidade
      holder: { name: holder.name.trim(), cpf: holder.cpf, birth: holder.birth || null, email: holder.email.trim() || null, phone: holder.phone },
      people: people.map((p) => ({
        name: p.name.trim(), birth: p.birth, relationship: p.relationship,
        relationship_other: p.relationship === 'outro' ? p.relationshipOther.trim() : null,
        cpf: p.cpf || null, email: p.email.trim() || null,
      })),
    });
    if (!r.ok) { setError(r.error ?? 'Não foi possível enviar.'); setPhase('form'); return; }
    const passportUpload = await joinFrontBack(passportFiles);
    const queue: UploadItem[] = [
      ...passportUpload.map((file) => ({ kind: 'passaporte' as Kind, personPosition: null, file, done: false })),
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
    const via = 'no seu WhatsApp e no seu e-mail';
    return (
      <div className="min-h-screen bg-[var(--color-bg-primary)] px-4 py-10">
        <div className="mx-auto max-w-xl space-y-5">
          {header}
          <div className="space-y-4 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-5">
            <div className="text-center">
              <CheckCircle2 className="mx-auto h-12 w-12 text-[var(--color-success)]" />
              <h2 className="mt-2 text-lg font-bold text-[var(--color-text-primary)]">Recebemos o seu envio!</h2>
              <p className="text-[var(--color-text-secondary)]">Protocolo <b className="text-[var(--color-text-primary)]">#{protocol}</b> · guarde este número</p>
            </div>
            <ol className="space-y-3 text-sm text-[var(--color-text-secondary)]">
              <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-xs font-bold text-white">1</span>
                <span><b className="text-[var(--color-text-primary)]">Análise.</b> Nossa equipe vai analisar os dados e os documentos enviados.
                  O recebimento deste envio não representa aprovação nem confirmação de cadastro.</span></li>
              <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-xs font-bold text-white">2</span>
                <span><b className="text-[var(--color-text-primary)]">Retorno em até 5 dias úteis após o envio.</b> Entramos em contato {via}.
                  Estando tudo certo, você recebe o <b>login e a senha do Portal do Associado</b>. Se faltar algum dado ou documento,
                  avisamos para você refazer a atualização cadastral.</span></li>
              <li className="flex gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent-fill)] text-xs font-bold text-white">3</span>
                <span><b className="text-[var(--color-text-primary)]">Foto do rosto.</b> Com o acesso liberado, no portal você cadastra o rosto — o seu e o de cada
                  dependente — para o reconhecimento facial na entrada. <b>Essa foto é feita uma única vez</b>: faça com calma, em lugar claro.</span></li>
            </ol>
            <p className="text-center text-sm text-[var(--color-text-secondary)]">Agora é só aguardar o nosso contato. Não precisa enviar de novo.</p>
          </div>
        </div>
      </div>
    );
  }

  const sending = phase === 'sending';
  const pct = Math.round(((step + 1) / STEPS.length) * 100);
  const holderLabel = 'RG ou CNH do titular (frente e verso)';

  return (
    <div className="min-h-screen bg-[var(--color-bg-primary)] px-4 pb-32 pt-6 sm:pt-10">
      <div className="mx-auto max-w-xl space-y-4" onChangeCapture={() => setError(null)} onClickCapture={() => setError(null)}>
        {header}

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-[var(--color-text-primary)]">{STEPS[step]}</span>
            <span className="text-[var(--color-text-muted)]">Etapa {step + 1} de {STEPS.length}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-[var(--color-border-soft)]">
            <div className="h-full rounded-full bg-[var(--accent-fill)] transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>

        {step === 0 && (
          <>
            <ReviewNotice />
            <Card title="Seu passaporte" hint="Leva uns 5 minutos. Tenha em mãos a foto do passaporte (ou do comprovante de pagamento) e o RG ou CNH de todos.">
              <Choice value={plan} cols={3} onChange={setPlan}
                options={[['amai10', 'AMAI 10'], ['infinity', 'AMAI INFINITY'], ['nao_sei', 'Não sei']] as const} />
              {plan === 'amai10' && (
                <Field label="Para quantas pessoas foi a compra? (contando você)">
                  <select className={inputCls} value={peopleCount} onChange={(e) => setPeopleCount(e.target.value)}>
                    <option value="">Escolha…</option>
                    {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} {n === 1 ? 'pessoa (só eu)' : 'pessoas'}</option>)}
                  </select>
                </Field>
              )}
              {plan === 'infinity' && <p className="text-sm text-[var(--color-text-secondary)]">O AMAI INFINITY é familiar: podem entrar pai, mãe, sogro, sogra, esposo(a) e filhos.</p>}
              <Field label="Número do passaporte ou contrato" optional>
                <input className={inputCls} value={passportNumber} maxLength={40} onChange={(e) => setPassportNumber(e.target.value)} />
              </Field>
              <PhotoPicker label="Foto do passaporte, título, contrato ou comprovante de pagamento"
                hint="Fotografe o documento inteiro, com os dados legíveis. Também pode ser o print ou PDF do comprovante."
                files={passportFiles} onChange={setPassportFiles} max={2} />
            </Card>
          </>
        )}

        {step === 1 && (
          <Card title="Dados do titular" hint="Quem comprou o passaporte.">
            <Field label="Nome completo"><input className={inputCls} autoComplete="name" value={holder.name} onChange={(e) => setHolder({ ...holder, name: e.target.value })} /></Field>
            <Field label="CPF"><input className={inputCls} inputMode="numeric" value={holder.cpf} onChange={(e) => setHolder({ ...holder, cpf: maskDoc(e.target.value).slice(0, 14) })} placeholder="000.000.000-00" /></Field>
            <DateInput label="Data de nascimento" optional value={holder.birth} onChange={(birth) => setHolder((h) => ({ ...h, birth }))} />
            <Field label="WhatsApp com DDD"><input className={inputCls} inputMode="tel" autoComplete="tel" value={holder.phone} maxLength={15} onChange={(e) => setHolder({ ...holder, phone: maskPhoneBR(e.target.value) })} placeholder="(68) 99999-0000" /></Field>
            <Field label="E-mail"><input type="email" inputMode="email" className={inputCls} autoComplete="email" value={holder.email} onChange={(e) => setHolder({ ...holder, email: e.target.value })} /></Field>
            <div className="flex gap-3 rounded-[var(--radius-control)] border border-[rgba(245,158,11,0.5)] bg-[rgba(245,158,11,0.1)] p-3 text-sm text-[var(--color-text-primary)]">
              <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#b45309] dark:text-[#fbbf24]" />
              <p>
                <b>Atenção aos dados!</b> Depois da conferência, o <b>login e a senha do Portal do Associado</b> serão enviados
                <b> para este WhatsApp e para este e-mail</b>. Confira se estão corretos — com dado errado, o acesso não chega até você.
              </p>
            </div>
          </Card>
        )}

        {step === 2 && (
          <Card title="Documento do titular" hint={`${holder.name.trim() || 'Titular'}: envie o RG ou a CNH. Se for RG, mande a frente e o verso.`}>
            <PhotoPicker label={holderLabel} files={holderFiles} onChange={setHolderFiles} />
          </Card>
        )}

        {step === 3 && (
          <Card title="Dependentes"
            hint={plan === 'amai10'
              ? (maxDependents ? `Seu AMAI 10 é para ${peopleCount} pessoas: você + ${maxDependents} dependente(s). Cadastre todos para continuar.` : 'Compra para 1 pessoa (só você): não há dependentes. Toque em Continuar.')
              : plan === 'infinity'
                ? 'AMAI INFINITY: pai, mãe, sogro, sogra, esposo(a) e filhos. Só quem vai usar o passaporte com você.'
                : 'Só quem vai usar o passaporte com você.'}>
            {people.length === 0 && maxDependents > 0 && <p className="text-sm text-[var(--color-text-muted)]">{plan === 'amai10' ? 'Nenhum dependente adicionado ainda.' : 'Nenhum dependente adicionado. Se não tiver, toque em Continuar.'}</p>}
            {people.map((p, i) => (
              openKey === p.key ? (
                <div key={p.key} className="scroll-mt-4 space-y-4 rounded-[var(--radius-control)] border-2 border-[var(--accent-primary)] p-3"
                  ref={(el) => { if (el && openedRef.current === p.key) { openedRef.current = null; window.setTimeout(() => { el.querySelector('input')?.focus({ preventScroll: true }); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 120); } }}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-[var(--color-text-primary)]">Dependente {i + 1}</span>
                    <button type="button" className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-error)]" onClick={() => { setPeople((ps) => ps.filter((x) => x.key !== p.key)); setOpenKey(null); }}>
                      <Trash2 className="h-4 w-4" /> Remover
                    </button>
                  </div>
                  <Field label="Nome completo"><input className={inputCls} value={p.name} onChange={(e) => setPerson(p.key, { name: e.target.value })} /></Field>
                  <Field label="Parentesco">
                    <select className={inputCls} value={p.relationship} onChange={(e) => setPerson(p.key, { relationship: e.target.value as Rel })}>
                      <option value="">Escolha…</option>
                      {relOptions.map((o) => (
                        <option key={o.value} value={o.value} disabled={o.value !== p.relationship && usedOnce.has(o.value)}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                  {p.relationship === 'outro' && (
                    <Field label="Qual parentesco?"><input className={inputCls} maxLength={40} value={p.relationshipOther} onChange={(e) => setPerson(p.key, { relationshipOther: e.target.value })} /></Field>
                  )}
                  <DateInput label="Data de nascimento" value={p.birth} onChange={(birth) => setPerson(p.key, { birth })} />
                  <Field label="CPF"><input className={inputCls} inputMode="numeric" value={p.cpf} placeholder="000.000.000-00" onChange={(e) => setPerson(p.key, { cpf: maskDoc(e.target.value).slice(0, 14) })} /></Field>
                  <p className="-mt-2 text-xs text-[var(--color-text-muted)]">Criança também tem CPF: o número está na certidão de nascimento.</p>
                  <PhotoPicker label="RG ou CNH (criança sem RG: certidão de nascimento)" files={p.files} onChange={(files) => setPerson(p.key, { files })} />
                  <Button type="button" className="h-12 w-full" onClick={() => {
                    const pr = personProblem(p, i);
                    if (pr) { setError(pr); return; }
                    setError(null); setOpenKey(null);
                    window.setTimeout(() => {
                      const nxt = document.getElementById('recad-dep-next');
                      if (nxt) nxt.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      else window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
                    }, 150);
                  }}>
                    <Check className="h-5 w-5" /> Salvar dependente
                  </Button>
                </div>
              ) : (
                <div key={p.key} className="flex items-center gap-3 rounded-[var(--radius-control)] border border-[var(--color-border-card)] p-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-subtle)] text-sm font-bold text-[var(--accent-primary)]">{i + 1}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-semibold text-[var(--color-text-primary)]">{p.name.trim() || `Dependente ${i + 1}`}</div>
                    <div className="text-sm text-[var(--color-text-secondary)]">
                      {relLabel(p)} · {brDate(p.birth)} · {p.files.length} foto(s)
                      {personProblem(p, i) && <span className="ml-1 font-semibold text-[var(--color-error)]">· incompleto</span>}
                    </div>
                  </div>
                  <button type="button" aria-label="Editar" className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" onClick={() => { setError(null); setOpenKey(p.key); }}>
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button type="button" aria-label="Remover" className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-muted)] hover:text-[var(--color-error)]" onClick={() => setPeople((ps) => ps.filter((x) => x.key !== p.key))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )
            ))}
            {people.length < maxDependents && openKey === null && (
              <Button id="recad-dep-next" type="button" variant="outline" className="h-12 w-full" onClick={addPerson}>
                <Plus className="h-5 w-5" /> Adicionar dependente {plan === 'amai10' ? `(${people.length} de ${maxDependents})` : ''}
              </Button>
            )}
            {needsMarriage && (
              <div className="rounded-[var(--radius-control)] border border-[var(--color-border-soft)] p-3">
                <PhotoPicker label="Certidão de casamento ou união estável"
                  hint="Como você incluiu esposo(a), sogro ou sogra, envie a certidão de casamento ou o documento da união estável."
                  files={marriageFiles} onChange={setMarriageFiles} />
              </div>
            )}
          </Card>
        )}

        {step === 4 && (
          <>
            <Card title="Confira antes de enviar">
              <Summary title="Passaporte" onEdit={() => goTo(0)}>
                {plan === 'amai10' ? `AMAI 10 · ${peopleCount} pessoa(s)` : plan === 'infinity' ? 'AMAI INFINITY' : 'Não sei'}
                {passportNumber.trim() && ` · nº ${passportNumber.trim()}`} · {passportFiles.length} foto(s)
              </Summary>
              <Summary title="Titular" onEdit={() => goTo(1)}>
                {holder.name.trim()} · CPF {holder.cpf}{holder.birth && ` · ${brDate(holder.birth)}`}<br />
                {holder.phone}{holder.email.trim() && ` · ${holder.email.trim()}`}<br />
                Login do Portal vai para este WhatsApp e este e-mail
              </Summary>
              <Summary title="Documento do titular" onEdit={() => goTo(2)}>{holderFiles.length} foto(s)</Summary>
              <Summary title={`Dependentes (${people.length})`} onEdit={() => goTo(3)}>
                {people.length ? people.map((p) => <div key={p.key}>{p.name.trim()} — {relLabel(p)} · {brDate(p.birth)} · CPF {p.cpf}</div>) : 'Nenhum'}
                {needsMarriage && <div>Certidão de casamento/união: {marriageFiles.length} foto(s)</div>}
              </Summary>
            </Card>
            <ReviewNotice />
            <label className="flex items-start gap-3 rounded-[var(--radius-card)] border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-text-secondary)]">
              <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                <ShieldCheck className="mr-1 inline h-4 w-4 text-[var(--accent-primary)]" />
                Concordo que o {orgName} use estes dados e documentos somente para o recadastramento e o acesso ao parque, conforme a LGPD.
              </span>
            </label>
          </>
        )}

        <p className="text-center text-xs text-[var(--color-text-muted)]">Seus dados são enviados com segurança e vistos só pela equipe do {orgName}.</p>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[var(--color-border-card)] bg-[var(--color-surface)] px-4 py-3">
        {error && <p role="alert" className="mx-auto mb-2 max-w-xl rounded-[var(--radius-control)] border border-[var(--color-error)] bg-[rgba(220,38,38,0.08)] p-2.5 text-sm text-[var(--color-error)]">{error}</p>}
        <div className="mx-auto flex max-w-xl gap-2">
          {step > 0 && (
            <Button type="button" variant="outline" className="h-12 px-4" disabled={sending} onClick={() => goTo(step - 1)}>
              <ChevronLeft className="h-5 w-5" /> Voltar
            </Button>
          )}
          {step < 4 ? (
            <Button type="button" className="h-12 flex-1 text-base" onClick={next}>
              Continuar <ChevronRight className="h-5 w-5" />
            </Button>
          ) : (
            <Button type="button" className="h-12 flex-1 text-base" disabled={sending} onClick={() => void send()}>
              {sending
                ? <><Loader2 className="h-5 w-5 animate-spin" /> Enviando {progress.total ? `${progress.done}/${progress.total}` : '…'}</>
                : pending.current ? 'Tentar de novo' : 'Enviar para conferência'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 border-b border-[var(--color-border-soft)] pb-3 last:border-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</div>
        <div className="mt-0.5 break-words text-sm text-[var(--color-text-secondary)]">{children}</div>
      </div>
      <button type="button" className="text-sm font-semibold text-[var(--accent-primary)]" onClick={onEdit}>Alterar</button>
    </div>
  );
}
