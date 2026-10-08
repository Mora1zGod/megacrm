// SEFAZ (NF-e de entrada) com o certificado digital A1 da empresa.
//
// POST /api/sefaz  { action, ... }   — Authorization: Bearer <sessão do usuário>
//   cert_status  {}                                    → empresas, certificado, última busca
//   save_cert    { company_id, pfx_base64, password }  → valida e guarda cifrado (purchases.setup)
//   remove_cert  { company_id }                        (purchases.setup)
//   set_enabled  { company_id, enabled }               (purchases.setup)
//   sync         { company_id }                        → busca notas novas por NSU (purchases.invoice)
//   manifest     { invoice_id }                        → ciência da operação + baixa o XML completo
//   fetch_by_key { invoice_id }                        → tenta baixar o XML completo pela chave
//   import_xml   { xml, company_id? }                  → importa um XML enviado pela tela
//
// O certificado e a senha ficam em public.org_settings (AES-256-GCM, CRYPTO_KEY):
//   sefaz_cert_pfx:<empresa>, sefaz_cert_pass:<empresa>. Nunca voltam para a tela.
// As gravações de notas usam a SESSÃO DO USUÁRIO (RLS + permissões valem).
import https from 'node:https';
import { gunzipSync } from 'node:zlib';
import forge from 'node-forge';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getCredential, setCredential } from '../src/lib/credentials.js';
import { parseDistResponse, parseEvent, parseEventResponse, parseFullNfe, parseSummary, type InvoicePayload } from '../src/lib/nfe.js';

type ApiRequest = { method?: string; body?: unknown; headers?: Record<string, string | string[] | undefined> };
type ApiResponse = { status: (code: number) => ApiResponse; json: (body: unknown) => void; end: () => void };

const DIST_URL = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
const DIST_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse';
const EVENT_URL = 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx';
const EVENT_ACTION = 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4/nfeRecepcaoEvento';
const BUCKET = 'whatsapp-hub-purchases';
const MAX_ROUNDS = 6;          // chamadas por "Buscar notas" (cada uma traz até 50 documentos)
const ROUND_BUDGET_MS = 25_000; // não começa outra rodada depois disso (a função tem 60 s)
const CONCURRENCY = 6;          // notas gravadas em paralelo
const WAIT_MS = 60 * 60 * 1000; // regra da SEFAZ: sem documento novo → esperar 1 hora

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ------------------------------------------------------------------ Supabase
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new HttpError(500, `Servidor sem ${name} configurado.`);
  return v;
}
function admin(): SupabaseClient {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
}
// Cliente com a sessão do usuário: o Postgres enxerga auth.uid() e as permissões dele.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function asUser(token: string): SupabaseClient<any, any, any> {
  // apikey = chave pública: o papel vem SÓ do token do usuário.
  return createClient(env('SUPABASE_URL'), process.env.SUPABASE_ANON_KEY || env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'whatsapp_hub' },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Ctx { token: string; userId: string; orgId: string; db: SupabaseClient<any, any, any>; sys: SupabaseClient; canSup?: boolean }

async function auth(req: ApiRequest): Promise<Ctx> {
  const h = req.headers?.authorization ?? req.headers?.Authorization;
  const header = Array.isArray(h) ? h[0] : h;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'Sessão ausente. Entre de novo.');
  const sys = admin();
  const { data, error } = await sys.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Sessão expirada. Entre de novo.');
  const orgId = (data.user.app_metadata as { org_id?: string } | undefined)?.org_id;
  if (!orgId) throw new HttpError(403, 'Sessão sem organização. Entre de novo.');
  return { token, userId: data.user.id, orgId, db: asUser(token), sys };
}

async function requirePerm(ctx: Ctx, key: string, what: string) {
  const { data, error } = await ctx.db.rpc('has_perm', { p_key: key });
  if (error) throw new HttpError(500, 'Não foi possível conferir sua permissão.');
  if (data !== true) throw new HttpError(403, `Seu perfil não permite ${what}. Peça ao administrador para liberar.`);
}

async function company(ctx: Ctx, id: unknown) {
  const cid = String(id ?? '');
  const { data } = await ctx.sys.schema('whatsapp_hub').from('fin_companies').select('id, org_id, name, cnpj').eq('id', cid).maybeSingle();
  if (!data || data.org_id !== ctx.orgId) throw new HttpError(404, 'Empresa não encontrada.');
  return data as { id: string; org_id: string; name: string; cnpj: string | null };
}

async function setState(ctx: Ctx, companyId: string, patch: Record<string, unknown>) {
  const { error } = await ctx.sys.schema('whatsapp_hub').from('pur_sefaz_state')
    .upsert({ company_id: companyId, org_id: ctx.orgId, ...patch, updated_at: new Date().toISOString() }, { onConflict: 'company_id' });
  if (error) throw new HttpError(500, 'Não foi possível salvar o estado da SEFAZ.');
}

// ------------------------------------------------------------------ certificado
interface Cert { keyPem: string; certPem: string; certB64: string; cnpj: string | null; subject: string; validUntil: Date; key: forge.pki.rsa.PrivateKey }

export function readPfx(pfxB64: string, password: string): Cert {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const der = forge.util.decode64(pfxB64);
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(der), false, password);
  } catch {
    throw new HttpError(400, 'Não consegui abrir o certificado. Confira se é o arquivo .pfx/.p12 (A1) e se a senha está certa.');
  }
  const keyBag = (p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? [])[0]
    ?? (p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? [])[0];
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const key = keyBag?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new HttpError(400, 'O arquivo não tem a chave privada. Exporte o certificado A1 com a chave.');
  // O certificado da empresa é o que casa com a chave (os outros são da cadeia).
  const mine = certBags.map((b) => b.cert!).find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub.n && pub.n.equals(key.n);
  });
  if (!mine) throw new HttpError(400, 'Não achei o certificado da chave dentro do arquivo.');
  const cn = String(mine.subject.getField('CN')?.value ?? '');
  // CNPJ: no CN ("RAZAO SOCIAL:12345678000199") ou na extensão ICP-Brasil 2.16.76.1.3.3.
  let cnpj = /:(\d{14})\b/.exec(cn)?.[1] ?? null;
  if (!cnpj) {
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(mine)).getBytes();
    const at = der.indexOf('\x60\x4c\x01\x03\x03'); // OID 2.16.76.1.3.3 (CNPJ da PJ)
    cnpj = at >= 0 ? /\d{14}/.exec(der.slice(at, at + 64))?.[0] ?? null : null;
  }
  const certPem = forge.pki.certificateToPem(mine);
  const chainPem = certBags.map((b) => b.cert!).filter((c) => c !== mine).map((c) => forge.pki.certificateToPem(c)).join('');
  return {
    keyPem: forge.pki.privateKeyToPem(key),
    certPem: certPem + chainPem,
    certB64: forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(mine)).getBytes()),
    cnpj,
    subject: cn,
    validUntil: mine.validity.notAfter,
    key,
  };
}

async function loadCert(ctx: Ctx, companyId: string): Promise<Cert> {
  const [pfx, pass] = await Promise.all([
    getCredential(ctx.orgId, `sefaz_cert_pfx:${companyId}`),
    getCredential(ctx.orgId, `sefaz_cert_pass:${companyId}`),
  ]);
  if (!pfx || pass === null) throw new HttpError(400, 'Esta empresa ainda não tem certificado digital. Envie em Compras → Configurações.');
  const cert = readPfx(pfx, pass);
  if (cert.validUntil.getTime() < Date.now()) throw new HttpError(400, 'O certificado digital desta empresa está vencido. Envie o novo em Compras → Configurações.');
  return cert;
}

function docFor(cert: Cert, comp: { cnpj: string | null }): string {
  const c = (comp.cnpj ?? '').replace(/\D/g, '');
  const doc = c.length === 14 ? c : cert.cnpj;
  if (!doc) throw new HttpError(400, 'Cadastre o CNPJ da empresa no Financeiro (Cadastros → Empresas).');
  if (cert.cnpj && cert.cnpj.slice(0, 8) !== doc.slice(0, 8)) {
    throw new HttpError(400, `O certificado é do CNPJ ${cert.cnpj}, mas a empresa está com ${doc}. Confira o cadastro ou o certificado.`);
  }
  return doc;
}

// ------------------------------------------------------------------ SOAP
// A SEFAZ usa certificado de servidor ICP-Brasil, que não vem no Node. Se
// SEFAZ_CA_PEM (cadeia ICP-Brasil em PEM) estiver configurada, a conexão é
// conferida; sem ela, a conexão segue cifrada mas sem conferir o servidor.
function soap(url: string, action: string, body: string, cert: Cert): Promise<string> {
  const ca = process.env.SEFAZ_CA_PEM?.replace(/\\n/g, '\n');
  const envelope = '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">'
    + `<soap12:Body>${body}</soap12:Body></soap12:Envelope>`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.hostname, path: u.pathname, method: 'POST', port: 443,
      key: cert.keyPem, cert: cert.certPem,
      ...(ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }),
      headers: { 'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`, 'Content-Length': Buffer.byteLength(envelope) },
      timeout: 25000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 500 && !/Envelope/.test(text)) reject(new HttpError(502, `A SEFAZ respondeu com erro (${res.statusCode}). Tente mais tarde.`));
        else resolve(text);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new HttpError(504, 'A SEFAZ demorou demais para responder. Tente de novo em alguns minutos.')); });
    req.on('error', (e: NodeJS.ErrnoException) => {
      const m = /certificate|SSL|TLS/i.test(e.message) ? 'Falha na conexão segura com a SEFAZ (certificado).' : 'Não foi possível falar com a SEFAZ agora.';
      reject(new HttpError(502, `${m} ${e.code ?? ''}`.trim()));
    });
    req.end(envelope);
  });
}

function distBody(doc: string, uf: string, inner: string): string {
  const who = doc.length === 14 ? `<CNPJ>${doc}</CNPJ>` : `<CPF>${doc}</CPF>`;
  return '<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>'
    + `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>1</tpAmb><cUFAutor>${uf}</cUFAutor>${who}${inner}</distDFeInt>`
    + '</nfeDadosMsg></nfeDistDFeInteresse>';
}

// Assinatura XMLDSig (enveloped, C14N, RSA-SHA1) do infEvento.
export function signEvent(infEventoInner: string, id: string, cert: Cert): string {
  const NS = 'http://www.portalfiscal.inf.br/nfe';
  const DS = 'http://www.w3.org/2000/09/xmldsig#';
  const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  const canonInf = `<infEvento xmlns="${NS}" Id="${id}">${infEventoInner}</infEvento>`;
  const sha1b64 = (s: string) => { const md = forge.md.sha1.create(); md.update(s, 'utf8'); return forge.util.encode64(md.digest().getBytes()); };
  const digest = sha1b64(canonInf);
  const signedInfoBody = `<CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod>`
    + `<SignatureMethod Algorithm="${DS}rsa-sha1"></SignatureMethod>`
    + `<Reference URI="#${id}"><Transforms><Transform Algorithm="${DS}enveloped-signature"></Transform><Transform Algorithm="${C14N}"></Transform></Transforms>`
    + `<DigestMethod Algorithm="${DS}sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference>`;
  const canonSignedInfo = `<SignedInfo xmlns="${DS}">${signedInfoBody}</SignedInfo>`;
  const md = forge.md.sha1.create();
  md.update(canonSignedInfo, 'utf8');
  const signature = forge.util.encode64(cert.key.sign(md));
  return `<infEvento Id="${id}">${infEventoInner}</infEvento>`
    + `<Signature xmlns="${DS}"><SignedInfo>${signedInfoBody}</SignedInfo><SignatureValue>${signature}</SignatureValue>`
    + `<KeyInfo><X509Data><X509Certificate>${cert.certB64}</X509Certificate></X509Data></KeyInfo></Signature>`;
}

// Hora do Acre (UTC−5, sem horário de verão), formato da SEFAZ.
function nowAcre(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 19) + '-05:00';
}

// ------------------------------------------------------------------ gravação
async function storeXml(ctx: Ctx, key: string, xml: string): Promise<string | null> {
  const path = `${ctx.orgId}/nfe/${key}.xml`;
  const { error } = await ctx.sys.storage.from(BUCKET).upload(path, Buffer.from(xml, 'utf8'), { contentType: 'application/xml', upsert: false });
  return error ? null : path;
}

async function importPayload(ctx: Ctx, p: InvoicePayload, extra: Record<string, unknown>, xml?: string): Promise<string> {
  const { supplier, ...rest } = p;
  const { data, error } = await ctx.db.rpc('pur_invoice_import', { p: { ...rest, ...extra } });
  if (error) throw new HttpError(400, error.message);
  const id = String(data);
  // XML guardado só DEPOIS de importar, e nunca por cima de um já guardado.
  if (xml) {
    const t = ctx.sys.schema('whatsapp_hub').from('pur_invoices');
    const { data: inv } = await t.select('xml_path').eq('id', id).eq('org_id', ctx.orgId).maybeSingle();
    if (inv && !inv.xml_path) {
      const path = await storeXml(ctx, p.access_key, xml);
      if (path) await t.update({ xml_path: path }).eq('id', id);
    }
  }
  // Completa o cadastro do fornecedor com o que veio no XML (só campos vazios).
  if (ctx.canSup === undefined) {
    const { data: canSup } = await ctx.db.rpc('has_perm', { p_key: 'purchases.suppliers' });
    ctx.canSup = canSup === true;
  }
  if (supplier?.doc && ctx.canSup) {
    const { data: party } = await ctx.sys.schema('whatsapp_hub').from('fin_parties')
      .select('*').eq('org_id', ctx.orgId).eq('doc', supplier.doc).maybeSingle();
    if (party) {
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(supplier)) {
        if (k === 'doc' || k === 'name' || !v) continue;
        if (party[k] === null || party[k] === undefined || party[k] === '') patch[k] = v;
      }
      if (/^Fornecedor \d+$/.test(String(party.name)) && supplier.name) patch.name = supplier.name;
      if (Object.keys(patch).length) await ctx.sys.schema('whatsapp_hub').from('fin_parties').update(patch).eq('id', party.id);
    }
  }
  return id;
}

// Nota cancelada na SEFAZ: guarda a situação; se ainda não foi lançada, marca cancelada.
async function applyCancel(ctx: Ctx, key: string) {
  const t = ctx.sys.schema('whatsapp_hub').from('pur_invoices');
  const { data } = await t.select('id, status, fin_entry_id').eq('org_id', ctx.orgId).eq('access_key', key).maybeSingle();
  if (!data) return;
  if (data.status !== 'posted' && !data.fin_entry_id) await t.update({ status: 'canceled_sefaz', sefaz_situation: 'cancelada', canceled_reason: 'Cancelada pelo emitente na SEFAZ' }).eq('id', data.id);
  else await t.update({ sefaz_situation: 'cancelada' }).eq('id', data.id);
}

interface DocResult { notas: number; completas: number; eventos: number; falhas: number; erros: string[]; minIssue: string | null; maxIssue: string | null }

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

async function processDocs(ctx: Ctx, companyId: string, docs: Array<{ nsu: string; schema: string; xml: string }>): Promise<DocResult> {
  const r: DocResult = { notas: 0, completas: 0, eventos: 0, falhas: 0, erros: [], minIssue: null, maxIssue: null };
  const seen = (d: string | null) => {
    if (!d) return;
    if (!r.minIssue || d < r.minIssue) r.minIssue = d;
    if (!r.maxIssue || d > r.maxIssue) r.maxIssue = d;
  };
  const fail = (d: { nsu: string; schema: string }, e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    r.falhas++;
    if (r.erros.length < 5) r.erros.push(`NSU ${Number(d.nsu)}: ${msg}`);
    console.error('sefaz doc', d.nsu, d.schema, msg);
  };
  // Notas primeiro (em paralelo); eventos depois, porque o cancelamento procura a nota já gravada.
  // Notas do MESMO fornecedor ficam na mesma fila: o cadastro automático do fornecedor não pode correr em dobro.
  const isNote = (d: { schema: string }) => d.schema.startsWith('procNFe') || d.schema.startsWith('resNFe');
  const groups = new Map<string, Array<{ d: typeof docs[number]; p: InvoicePayload; full: boolean }>>();
  for (const d of docs.filter(isNote)) {
    try {
      const full = d.schema.startsWith('procNFe');
      const p = full ? parseFullNfe(d.xml) : parseSummary(d.xml);
      if (!p) continue;
      const k = p.supplier_doc || p.access_key;
      groups.set(k, [...(groups.get(k) ?? []), { d, p, full }]);
    } catch (e) { fail(d, e); }
  }
  await pool([...groups.values()], CONCURRENCY, async (list) => {
    for (const { d, p, full } of list) {
      try {
        if (full) {
          await importPayload(ctx, p, { source: 'sefaz', company_id: companyId, nsu: d.nsu }, d.xml);
          r.completas++;
        } else {
          await importPayload(ctx, p, { source: 'sefaz', company_id: companyId, nsu: d.nsu });
          if (p.situation === 'cancelada') await applyCancel(ctx, p.access_key);
          r.notas++;
        }
        seen(p.issue_date);
      } catch (e) { fail(d, e); }
    }
  });
  for (const d of docs) {
    if (isNote(d) || !(d.schema.startsWith('resEvento') || d.schema.startsWith('procEventoNFe'))) continue;
    try {
      const ev = parseEvent(d.xml);
      if (ev && ev.type === '110111') await applyCancel(ctx, ev.key);
      r.eventos++;
    } catch (e) { fail(d, e); }
  }
  return r;
}

// ------------------------------------------------------------------ ações
async function certStatus(ctx: Ctx) {
  await requirePerm(ctx, 'purchases.view', 'ver Compras');
  const w = ctx.sys.schema('whatsapp_hub');
  const [{ data: comps }, { data: states }, { data: keys }] = await Promise.all([
    w.from('fin_companies').select('id, name, cnpj, is_default, is_active').eq('org_id', ctx.orgId).order('name'),
    w.from('pur_sefaz_state').select('*').eq('org_id', ctx.orgId),
    ctx.sys.from('org_settings').select('key').eq('org_id', ctx.orgId).like('key', 'sefaz_cert_pfx:%'),
  ]);
  const has = new Set((keys ?? []).map((k: { key: string }) => k.key.split(':')[1]));
  return {
    strict_tls: Boolean(process.env.SEFAZ_CA_PEM),
    companies: (comps ?? []).map((c: Record<string, unknown>) => {
      const s = (states ?? []).find((x: Record<string, unknown>) => x.company_id === c.id) as Record<string, unknown> | undefined;
      return {
        ...c, has_cert: has.has(String(c.id)),
        enabled: s?.enabled ?? false, cert_cnpj: s?.cert_cnpj ?? null, cert_subject: s?.cert_subject ?? null,
        cert_valid_until: s?.cert_valid_until ?? null, last_nsu: s?.last_nsu ?? null, max_nsu: s?.max_nsu ?? null,
        last_sync_at: s?.last_sync_at ?? null, next_sync_after: s?.next_sync_after ?? null, last_status: s?.last_status ?? null,
      };
    }),
  };
}

async function saveCert(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.setup', 'configurar o certificado digital');
  const comp = await company(ctx, b.company_id);
  const pfx = String(b.pfx_base64 ?? '').replace(/^data:[^,]*,/, '');
  const password = String(b.password ?? '');
  if (!pfx) throw new HttpError(400, 'Escolha o arquivo do certificado (.pfx ou .p12).');
  if (pfx.length > 200_000) throw new HttpError(400, 'Arquivo grande demais para um certificado A1.');
  const cert = readPfx(pfx, password);
  if (cert.validUntil.getTime() < Date.now()) throw new HttpError(400, `Este certificado venceu em ${cert.validUntil.toLocaleDateString('pt-BR')}.`);
  docFor(cert, comp); // confere CNPJ da empresa x certificado
  await setCredential(ctx.orgId, `sefaz_cert_pfx:${comp.id}`, pfx);
  await setCredential(ctx.orgId, `sefaz_cert_pass:${comp.id}`, password);
  // Empresa sem CNPJ: assume o do certificado (as notas passam a cair na empresa certa).
  if (!(comp.cnpj ?? '').replace(/\D/g, '') && cert.cnpj) {
    await ctx.sys.schema('whatsapp_hub').from('fin_companies').update({ cnpj: cert.cnpj }).eq('id', comp.id).eq('org_id', ctx.orgId);
  }
  await setState(ctx, comp.id, { enabled: true, cert_cnpj: cert.cnpj, cert_subject: cert.subject.slice(0, 200), cert_valid_until: cert.validUntil.toISOString(), last_status: 'Certificado salvo.' });
  return { ok: true, cnpj: cert.cnpj, subject: cert.subject, valid_until: cert.validUntil.toISOString() };
}

async function removeCert(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.setup', 'configurar o certificado digital');
  const comp = await company(ctx, b.company_id);
  await ctx.sys.from('org_settings').delete().eq('org_id', ctx.orgId).in('key', [`sefaz_cert_pfx:${comp.id}`, `sefaz_cert_pass:${comp.id}`]);
  await setState(ctx, comp.id, { enabled: false, cert_cnpj: null, cert_subject: null, cert_valid_until: null, last_status: 'Certificado removido.' });
  return { ok: true };
}

async function setEnabled(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.setup', 'configurar a busca na SEFAZ');
  const comp = await company(ctx, b.company_id);
  await setState(ctx, comp.id, { enabled: b.enabled === true });
  return { ok: true };
}

async function sync(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.invoice', 'buscar notas na SEFAZ');
  const started = Date.now();
  const comp = await company(ctx, b.company_id);
  const { data: st } = await ctx.sys.schema('whatsapp_hub').from('pur_sefaz_state').select('*').eq('company_id', comp.id).eq('org_id', ctx.orgId).maybeSingle();
  if (st && st.enabled === false) throw new HttpError(400, 'A busca automática está desligada para esta empresa.');
  if (st?.next_sync_after && new Date(st.next_sync_after).getTime() > Date.now()) {
    const at = new Date(st.next_sync_after).toLocaleTimeString('pt-BR', { timeZone: 'America/Rio_Branco', hour: '2-digit', minute: '2-digit' });
    return {
      ok: true, waiting: true, more: false, next_sync_after: st.next_sync_after, last_nsu: st.last_nsu ?? null, max_nsu: st.max_nsu ?? null,
      message: `A SEFAZ só libera nova busca às ${at} (regra dela: 1 hora de espera quando não há nada novo ou quando pede para aguardar).`,
    };
  }
  const cert = await loadCert(ctx, comp.id);
  const doc = docFor(cert, comp);
  const uf = String(st?.uf_code ?? '12');
  let nsu = String(st?.last_nsu ?? '000000000000000').padStart(15, '0');
  let maxNsu = String(st?.max_nsu ?? '');
  const total: DocResult = { notas: 0, completas: 0, eventos: 0, falhas: 0, erros: [], minIssue: null, maxIssue: null };
  let status = ''; let wait = false; let finished = false;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (round > 0 && Date.now() - started > ROUND_BUDGET_MS) break; // deixa o resto para a próxima chamada
    const xml = await soap(DIST_URL, DIST_ACTION, distBody(doc, uf, `<distNSU><ultNSU>${nsu}</ultNSU></distNSU>`), cert);
    const r = parseDistResponse(xml, gunzipSync);
    status = `${r.cStat} — ${r.xMotivo}`;
    if (r.cStat === '656') { wait = true; break; }           // consumo indevido
    if (r.cStat === '137') { wait = true; finished = true; if (r.ultNSU) nsu = r.ultNSU; if (r.maxNSU) maxNsu = r.maxNSU; break; }
    if (r.cStat !== '138') throw new HttpError(400, `SEFAZ: ${status}`);
    // Grava o ultNSU ANTES de processar: repetir um NSU já respondido faz a SEFAZ bloquear por 1 hora (656).
    nsu = r.ultNSU || nsu; maxNsu = r.maxNSU || maxNsu;
    await setState(ctx, comp.id, { last_nsu: nsu, max_nsu: maxNsu || null, last_sync_at: new Date().toISOString(), last_status: status });
    const got = await processDocs(ctx, comp.id, r.docs);
    total.notas += got.notas; total.completas += got.completas; total.eventos += got.eventos; total.falhas += got.falhas;
    total.erros.push(...got.erros.slice(0, 5 - total.erros.length));
    for (const d of [got.minIssue, got.maxIssue]) {
      if (!d) continue;
      if (!total.minIssue || d < total.minIssue) total.minIssue = d;
      if (!total.maxIssue || d > total.maxIssue) total.maxIssue = d;
    }
    if (maxNsu && nsu >= maxNsu) { wait = true; finished = true; break; }
  }
  await setState(ctx, comp.id, {
    last_nsu: nsu, max_nsu: maxNsu || null, last_sync_at: new Date().toISOString(), last_status: status,
    next_sync_after: wait ? new Date(Date.now() + WAIT_MS).toISOString() : null,
  });
  const n = total.notas + total.completas;
  return {
    ok: true, notas: total.notas, completas: total.completas, eventos: total.eventos, falhas: total.falhas, erros: total.erros,
    min_issue: total.minIssue, max_issue: total.maxIssue, last_nsu: nsu, max_nsu: maxNsu || null,
    more: !wait, finished, waiting: wait && !finished,
    message: n ? `${n} nota(s) recebida(s) da SEFAZ${total.eventos ? ` e ${total.eventos} evento(s)` : ''}.` : 'Nenhuma nota nova nesta busca.',
  };
}

async function invoiceFor(ctx: Ctx, id: unknown) {
  const { data } = await ctx.db.from('pur_invoices').select('id, org_id, company_id, access_key, status, has_full_xml').eq('id', String(id ?? '')).maybeSingle();
  if (!data) throw new HttpError(404, 'Nota não encontrada.');
  if (!data.access_key) throw new HttpError(400, 'Esta nota não tem chave de acesso.');
  return data as { id: string; company_id: string; access_key: string; status: string; has_full_xml: boolean };
}

async function fetchByKey(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.invoice', 'baixar notas da SEFAZ');
  const inv = await invoiceFor(ctx, b.invoice_id);
  const comp = await company(ctx, inv.company_id);
  const cert = await loadCert(ctx, comp.id);
  const doc = docFor(cert, comp);
  const xml = await soap(DIST_URL, DIST_ACTION, distBody(doc, '12', `<consChNFe><chNFe>${inv.access_key}</chNFe></consChNFe>`), cert);
  const r = parseDistResponse(xml, gunzipSync);
  if (r.cStat !== '138') return { ok: true, full: false, message: `SEFAZ: ${r.cStat} — ${r.xMotivo}. Se acabou de dar ciência, tente de novo em alguns minutos.` };
  const got = await processDocs(ctx, comp.id, r.docs);
  return { ok: true, full: got.completas > 0, message: got.completas ? 'XML completo baixado.' : 'A SEFAZ ainda não liberou o XML completo. Tente de novo em alguns minutos.' };
}

async function manifest(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.invoice', 'dar ciência em notas');
  const inv = await invoiceFor(ctx, b.invoice_id);
  const comp = await company(ctx, inv.company_id);
  const cert = await loadCert(ctx, comp.id);
  const doc = docFor(cert, comp);
  const id = `ID210210${inv.access_key}01`;
  const who = doc.length === 14 ? `<CNPJ>${doc}</CNPJ>` : `<CPF>${doc}</CPF>`;
  const inner = `<cOrgao>91</cOrgao><tpAmb>1</tpAmb>${who}<chNFe>${inv.access_key}</chNFe><dhEvento>${nowAcre()}</dhEvento>`
    + '<tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento>'
    + '<detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento>';
  const evento = `<evento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00">${signEvent(inner, id, cert)}</evento>`;
  const body = '<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4">'
    + `<envEvento xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.00"><idLote>${String(Date.now()).slice(-15)}</idLote>${evento}</envEvento></nfeDadosMsg>`;
  const r = parseEventResponse(await soap(EVENT_URL, EVENT_ACTION, body, cert));
  if (!['135', '136', '573'].includes(r.cStat)) throw new HttpError(400, `SEFAZ recusou a ciência: ${r.cStat} — ${r.xMotivo}`);
  await ctx.sys.schema('whatsapp_hub').from('pur_invoices').update({ manifested_at: new Date().toISOString() }).eq('id', inv.id);
  const full = await fetchByKey(ctx, b).catch(() => ({ ok: true, full: false, message: 'Ciência registrada. O XML completo pode levar alguns minutos.' }));
  return { ok: true, full: full.full, message: `Ciência registrada na SEFAZ. ${full.message}` };
}

async function importXml(ctx: Ctx, b: Record<string, unknown>) {
  await requirePerm(ctx, 'purchases.invoice', 'importar notas');
  const xml = String(b.xml ?? '');
  if (!xml.trim()) throw new HttpError(400, 'Arquivo vazio.');
  if (xml.length > 3_000_000) throw new HttpError(400, 'XML grande demais.');
  let p: InvoicePayload;
  try { p = parseFullNfe(xml); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'XML inválido.'); }
  const extra: Record<string, unknown> = { source: 'xml' };
  if (b.company_id) extra.company_id = (await company(ctx, b.company_id)).id;
  const id = await importPayload(ctx, p, extra, xml);
  return { ok: true, id, number: p.number, supplier: p.supplier_name, total_cents: p.total_cents };
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ message: 'Use POST.' });
  try {
    const ctx = await auth(req);
    const b = (req.body && typeof req.body === 'object' ? req.body : JSON.parse(String(req.body ?? '{}'))) as Record<string, unknown>;
    const action = String(b.action ?? '');
    const out = action === 'cert_status' ? await certStatus(ctx)
      : action === 'save_cert' ? await saveCert(ctx, b)
      : action === 'remove_cert' ? await removeCert(ctx, b)
      : action === 'set_enabled' ? await setEnabled(ctx, b)
      : action === 'sync' ? await sync(ctx, b)
      : action === 'manifest' ? await manifest(ctx, b)
      : action === 'fetch_by_key' ? await fetchByKey(ctx, b)
      : action === 'import_xml' ? await importXml(ctx, b)
      : null;
    if (out === null) return res.status(400).json({ message: 'Ação desconhecida.' });
    return res.status(200).json(out);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const message = e instanceof Error ? e.message : 'Erro inesperado.';
    if (status >= 500) console.error('sefaz', message);
    return res.status(status).json({ message: status === 500 && !(e instanceof HttpError) ? 'Erro inesperado no servidor. Tente de novo.' : message });
  }
}
