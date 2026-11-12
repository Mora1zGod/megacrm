// ============================================================================
// recadastro-public  (PÚBLICA — sem verificação de JWT)
// ----------------------------------------------------------------------------
// Formulário /recadastro/<token>: o associado do AMAI 10 ou do AMAI Infinity
// informa os dados dele e dos dependentes e manda as fotos dos documentos.
// A equipe confere em /recadastramentos e lança no Pocket.
//
//   { action: 'info',   token }                         → nome/logo da organização
//   { action: 'submit', token, plan, people_count?, passport_number?, holder, portal_access,
//                       consent: true, people: [...] }   → cria o envio (status 'enviando')
//   { action: 'upload', token, submission_id, upload_key, kind, person_position?, mime, data_base64 }
//   { action: 'finish', token, submission_id, upload_key } → confere os documentos e conclui
//
// Regras (as mesmas que a AMAIA explica):
//   AMAI 10  = individual, 1 a 10 pessoas CONTANDO o titular;
//   Infinity = familiar: pai, mãe, sogro, sogra, cônjuge e filhos.
// Nada de org/status vem do navegador: a org sai do link no banco.
// Limites: 5 envios por IP a cada 30 min; 8 MB por arquivo; 60 arquivos por envio.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';

const TOKEN_RE = /^[0-9a-f]{20,64}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const BUCKET = 'whatsapp-hub-recadastro';
const MAX_PER_IP = 5;
const MAX_FILES = 60;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_PEOPLE = 30;
const KEY_TTL_MS = 6 * 60 * 60 * 1000;
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};
const INFINITY_REL = new Set(['pai', 'mae', 'sogro', 'sogra', 'conjuge', 'filho']);
const ALL_REL = new Set([...INFINITY_REL, 'outro']);
const ONLY_ONE = new Set(['pai', 'mae', 'sogro', 'sogra', 'conjuge']);
const NEEDS_MARRIAGE = new Set(['conjuge', 'sogro', 'sogra']);
const REL_LABEL: Record<string, string> = {
  pai: 'pai', mae: 'mãe', sogro: 'sogro', sogra: 'sogra', conjuge: 'esposo(a)/companheiro(a)', filho: 'filho(a)', outro: 'outro',
};

type Db = ReturnType<typeof getAdminClient>;

function fail(error: string, status = 400) {
  return jsonResponse({ ok: false, error }, { status });
}

function clean(v: unknown, max = 120): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t ? t.slice(0, max) : null;
}

function digits(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\D/g, '') : '';
}

function cpfValid(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

// Aceita AAAA-MM-DD (input date) ou DD/MM/AAAA. Devolve AAAA-MM-DD ou null.
function parseDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let y: number, m: number, d: number;
  let mm = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; } else {
    mm = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!mm) return null;
    d = +mm[1]; m = +mm[2]; y = +mm[3];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  const now = new Date();
  if (y < 1900 || dt.getTime() > now.getTime()) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function clientIp(req: Request): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim().slice(0, 64) || null;
  return (req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? '').trim().slice(0, 64) || null;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/^data:[^,]*,/, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// Confere a assinatura do arquivo (não confia só no tipo que o navegador diz).
function sniffMime(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return null;
}

// Envio em andamento: confere link, envio e segredo de upload.
async function loadPending(db: Db, orgId: string, body: Record<string, unknown>) {
  const subId = typeof body.submission_id === 'string' ? body.submission_id : '';
  const key = typeof body.upload_key === 'string' ? body.upload_key : '';
  if (!UUID_RE.test(subId) || !/^[0-9a-f]{64}$/.test(key)) return { error: 'Envio inválido. Recomece o formulário.' } as const;
  const { data: sub } = await db
    .from('recad_submissions')
    .select('id, org_id, status, plan, protocol, holder_phone')
    .eq('id', subId).eq('org_id', orgId).maybeSingle();
  if (!sub) return { error: 'Envio não encontrado. Recomece o formulário.' } as const;
  if (sub.status !== 'enviando') return { error: 'Este envio já foi concluído.' } as const;
  const { data: k } = await db.from('recad_upload_keys').select('key_hash, expires_at').eq('submission_id', subId).maybeSingle();
  if (!k || k.key_hash !== (await sha256(key)) || new Date(k.expires_at).getTime() < Date.now()) {
    return { error: 'O tempo para enviar os documentos acabou. Recomece o formulário.' } as const;
  }
  return { sub: sub as { id: string; org_id: string; status: string; plan: string; protocol: number; holder_phone: string | null } } as const;
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return fail('Método não permitido.', 405);

  try {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return fail('Dados inválidos.');
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!TOKEN_RE.test(token)) return fail('Link de recadastramento inválido.', 404);

    const db = getAdminClient();
    const { data: link } = await db
      .from('recad_links').select('id, org_id, is_active').eq('token', token).maybeSingle();
    if (!link || !link.is_active) return fail('Este link não existe ou foi desativado. Peça um novo pelo WhatsApp do AMAI.', 404);
    const { data: org } = await db
      .from('organizations').select('id, name, status, logo_url').eq('id', link.org_id).maybeSingle();
    if (!org || org.status !== 'active') return fail('Este link não está mais disponível.', 404);

    // ------------------------------------------------------------------ info
    if (body.action === 'info') {
      return jsonResponse({ ok: true, org: { name: org.name, logo_url: org.logo_url } });
    }

    // ---------------------------------------------------------------- submit
    if (body.action === 'submit') {
      if (body.consent !== true) return fail('É preciso aceitar o uso dos dados para o recadastramento.');
      const plan = body.plan;
      if (plan !== 'amai10' && plan !== 'infinity' && plan !== 'nao_sei') return fail('Escolha o seu passaporte.');
      const portal = body.portal_access;
      if (portal !== 'email' && portal !== 'whatsapp') return fail('Escolha como quer receber o acesso ao Portal do Associado.');

      const h = (body.holder ?? {}) as Record<string, unknown>;
      const holderName = clean(h.name, 120);
      const holderCpf = digits(h.cpf);
      const holderBirth = h.birth ? parseDate(h.birth) : null;
      const holderEmail = (clean(h.email, 254) ?? '').toLowerCase() || null;
      const holderPhone = digits(h.phone) || null;
      if (!holderName || holderName.length < 5 || !holderName.includes(' ')) return fail('Informe o nome completo do titular.');
      if (!cpfValid(holderCpf)) return fail('CPF do titular inválido.');
      if (h.birth && !holderBirth) return fail('Data de nascimento do titular inválida.');
      if (holderEmail && !EMAIL_RE.test(holderEmail)) return fail('E-mail do titular inválido.');
      if (portal === 'email' && !holderEmail) return fail('Informe o e-mail para receber o acesso ao portal.');
      if (!holderPhone || holderPhone.length < 10 || holderPhone.length > 13) return fail('Informe o WhatsApp com DDD.');

      let peopleCount: number | null = null;
      if (plan === 'amai10') {
        peopleCount = Number(body.people_count);
        if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > 10) {
          return fail('No AMAI 10, informe de 1 a 10 pessoas (contando o titular).');
        }
      }
      const passport = clean(body.passport_number, 40);

      const rawPeople = Array.isArray(body.people) ? body.people : [];
      if (rawPeople.length > MAX_PEOPLE) return fail('Muitos dependentes em um envio só.');
      if (plan === 'amai10' && rawPeople.length > (peopleCount ?? 1) - 1) {
        return fail(`Seu AMAI 10 é para ${peopleCount} pessoa(s) contando você: cabem até ${(peopleCount ?? 1) - 1} dependente(s).`);
      }
      const seenCpf = new Set<string>([holderCpf]);
      const relCount: Record<string, number> = {};
      const people: Array<Record<string, unknown>> = [];
      for (let i = 0; i < rawPeople.length; i++) {
        const p = (rawPeople[i] ?? {}) as Record<string, unknown>;
        const n = i + 1;
        const name = clean(p.name, 120);
        const birth = parseDate(p.birth);
        const rel = typeof p.relationship === 'string' ? p.relationship : '';
        const relOther = rel === 'outro' ? clean(p.relationship_other, 40) : null;
        const cpf = digits(p.cpf) || null;
        const email = (clean(p.email, 254) ?? '').toLowerCase() || null;
        if (!name || name.length < 5 || !name.includes(' ')) return fail(`Dependente ${n}: informe o nome completo.`);
        if (!birth) return fail(`Dependente ${n}: data de nascimento inválida.`);
        if (!ALL_REL.has(rel)) return fail(`Dependente ${n}: escolha o parentesco.`);
        if (plan === 'infinity' && !INFINITY_REL.has(rel)) {
          return fail(`Dependente ${n}: no AMAI Infinity entram pai, mãe, sogro, sogra, esposo(a) e filhos.`);
        }
        if (rel === 'outro' && !relOther) return fail(`Dependente ${n}: diga qual é o parentesco.`);
        relCount[rel] = (relCount[rel] ?? 0) + 1;
        if (ONLY_ONE.has(rel) && relCount[rel] > 1) return fail(`Só pode haver um(a) ${REL_LABEL[rel]}.`);
        if (cpf) {
          if (!cpfValid(cpf)) return fail(`Dependente ${n}: CPF inválido.`);
          if (seenCpf.has(cpf)) return fail(`Dependente ${n}: CPF repetido.`);
          seenCpf.add(cpf);
        }
        if (email && !EMAIL_RE.test(email)) return fail(`Dependente ${n}: e-mail inválido.`);
        people.push({ position: n, name, birth_date: birth, relationship: rel, relationship_other: relOther, cpf, email });
      }

      const ip = clientIp(req);
      if (ip) {
        const since = new Date(Date.now() - 30 * 60_000).toISOString();
        const { count } = await db
          .from('recad_submissions').select('id', { count: 'exact', head: true })
          .eq('ip', ip).gte('created_at', since);
        if ((count ?? 0) >= MAX_PER_IP) return fail('Muitos envios em sequência. Aguarde alguns minutos.', 429);
      }

      const { data: sub, error: subErr } = await db
        .from('recad_submissions')
        .insert({
          org_id: org.id, link_id: link.id, status: 'enviando', plan, people_count: peopleCount,
          passport_number: passport, holder_name: holderName, holder_cpf: holderCpf, holder_birth: holderBirth,
          holder_email: holderEmail, holder_phone: holderPhone, portal_access: portal,
          consent_at: new Date().toISOString(), ip, user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300) || null,
        })
        .select('id, protocol')
        .single();
      if (subErr || !sub) {
        console.error(JSON.stringify({ event: 'recad_submit_failed', message: subErr?.message }));
        return fail('Não foi possível salvar. Tente novamente.', 500);
      }
      if (people.length) {
        const { error: pErr } = await db.from('recad_people').insert(people.map((p) => ({ ...p, submission_id: sub.id, org_id: org.id })));
        if (pErr) {
          console.error(JSON.stringify({ event: 'recad_people_failed', message: pErr.message }));
          await db.from('recad_submissions').delete().eq('id', sub.id);
          return fail('Não foi possível salvar os dependentes. Confira os dados e tente novamente.', 500);
        }
      }
      const uploadKey = randomHex(32);
      await db.from('recad_upload_keys').insert({
        submission_id: sub.id, key_hash: await sha256(uploadKey), expires_at: new Date(Date.now() + KEY_TTL_MS).toISOString(),
      });
      return jsonResponse({ ok: true, submission_id: sub.id, upload_key: uploadKey, protocol: sub.protocol });
    }

    // ---------------------------------------------------------------- upload
    if (body.action === 'upload') {
      const pend = await loadPending(db, org.id, body);
      if ('error' in pend) return fail(pend.error, 409);
      const sub = pend.sub;
      const kind = body.kind;
      if (kind !== 'passaporte' && kind !== 'documento' && kind !== 'certidao_casamento') return fail('Tipo de arquivo inválido.');
      let personId: string | null = null;
      if (body.person_position != null) {
        if (kind !== 'documento') return fail('Tipo de arquivo inválido.');
        const pos = Number(body.person_position);
        const { data: person } = await db
          .from('recad_people').select('id').eq('submission_id', sub.id).eq('position', pos).maybeSingle();
        if (!person) return fail('Dependente não encontrado.');
        personId = person.id;
      }
      const bytes = typeof body.data_base64 === 'string' ? b64ToBytes(body.data_base64) : null;
      if (!bytes || bytes.length < 100) return fail('Arquivo vazio ou corrompido.');
      if (bytes.length > MAX_BYTES) return fail('Arquivo maior que 8 MB.');
      const mime = sniffMime(bytes);
      if (!mime) return fail('Envie foto (JPG, PNG, WEBP) ou PDF.');
      const { count } = await db.from('recad_files').select('id', { count: 'exact', head: true }).eq('submission_id', sub.id);
      if ((count ?? 0) >= MAX_FILES) return fail('Limite de arquivos atingido.');

      const who = personId ? `dep${body.person_position}` : 'titular';
      const path = `${sub.org_id}/${sub.id}/${kind}-${who}-${randomHex(6)}.${MIME_EXT[mime]}`;
      const { error: upErr } = await db.storage.from(BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
      if (upErr) {
        console.error(JSON.stringify({ event: 'recad_upload_failed', message: upErr.message }));
        return fail('Não foi possível enviar o arquivo. Tente de novo.', 500);
      }
      const { data: f, error: fErr } = await db
        .from('recad_files')
        .insert({ submission_id: sub.id, org_id: sub.org_id, person_id: personId, kind, path, mime, size_bytes: bytes.length })
        .select('id').single();
      if (fErr || !f) {
        await db.storage.from(BUCKET).remove([path]);
        return fail('Não foi possível registrar o arquivo. Tente de novo.', 500);
      }
      return jsonResponse({ ok: true, file_id: f.id });
    }

    // ---------------------------------------------------------------- finish
    if (body.action === 'finish') {
      const pend = await loadPending(db, org.id, body);
      if ('error' in pend) return fail(pend.error, 409);
      const sub = pend.sub;
      const [{ data: people }, { data: files }] = await Promise.all([
        db.from('recad_people').select('id, position, name, relationship').eq('submission_id', sub.id).order('position'),
        db.from('recad_files').select('kind, person_id').eq('submission_id', sub.id),
      ]);
      const fl = (files ?? []) as Array<{ kind: string; person_id: string | null }>;
      const missing: string[] = [];
      if (!fl.some((f) => f.kind === 'passaporte')) missing.push('foto do passaporte, título, contrato ou comprovante de pagamento');
      if (!fl.some((f) => f.kind === 'documento' && f.person_id == null)) missing.push('RG ou CNH do titular');
      for (const p of (people ?? []) as Array<{ id: string; position: number; name: string; relationship: string }>) {
        if (!fl.some((f) => f.kind === 'documento' && f.person_id === p.id)) missing.push(`documento de ${p.name.split(' ')[0]}`);
      }
      const needsMarriage = ((people ?? []) as Array<{ relationship: string }>).some((p) => NEEDS_MARRIAGE.has(p.relationship));
      if (needsMarriage && !fl.some((f) => f.kind === 'certidao_casamento')) missing.push('certidão de casamento ou documento da união estável');
      if (missing.length) return jsonResponse({ ok: false, error: `Falta enviar: ${missing.join('; ')}.`, missing }, { status: 400 });

      // Liga ao contato do WhatsApp quando o número bater (ajuda a equipe a achar a conversa).
      let contactId: string | null = null;
      const ph = sub.holder_phone ?? '';
      if (ph) {
        const full = ph.length <= 11 ? `55${ph}` : ph;
        const { data: c } = await db.from('contacts').select('id').eq('org_id', sub.org_id).in('phone', [`+${full}`, full]).limit(1).maybeSingle();
        contactId = (c as { id: string } | null)?.id ?? null;
      }
      const { error: upErr } = await db
        .from('recad_submissions')
        .update({ status: 'novo', completed_at: new Date().toISOString(), contact_id: contactId })
        .eq('id', sub.id).eq('status', 'enviando');
      if (upErr) return fail('Não foi possível concluir. Tente novamente.', 500);
      await db.from('recad_upload_keys').delete().eq('submission_id', sub.id);
      return jsonResponse({ ok: true, protocol: sub.protocol });
    }

    return fail('Ação inválida.');
  } catch (err) {
    console.error('recadastro-public error', err);
    return fail('Erro interno. Tente novamente.', 500);
  }
});
