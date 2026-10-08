// Leitura de XML de NF-e (servidor). Usado por api/sefaz.ts para:
//   * nota completa (procNFe / NFe) → dados para pur_invoice_import
//   * resumo da SEFAZ (resNFe) e eventos (resEvento / procEventoNFe)
// Valores em CENTAVOS (inteiros), datas em AAAA-MM-DD.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  parseTagValue: false,      // tudo como texto: CNPJ/CEP/códigos sem perder zeros
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  isArray: (name) => name === 'det' || name === 'dup' || name === 'docZip' || name === 'retEvento' || name === 'detPag',
});

type Node = Record<string, unknown>;

export function parseXml(xml: string): Node {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('XML inválido (DOCTYPE não é aceito).');
  return parser.parse(xml) as Node;
}

function obj(v: unknown): Node {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Node) : {};
}
function txt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const t = (v as Node)['#text'];
    return t === undefined ? '' : String(t);
  }
  return String(v);
}
function arr(v: unknown): Node[] {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).map(obj);
}

// "1234.56" → 123456 (sem erro de ponto flutuante).
export function toCents(v: unknown): number {
  const s = txt(v).trim();
  if (!s) return 0;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return Math.round(Number(s) * 100) || 0;
  const frac = ((m[3] ?? '') + '000').slice(0, 3);
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1;
  return m[1] ? -cents : cents;
}
function toQty(v: unknown): number {
  const n = Number(txt(v));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
}
function toDate(v: unknown): string | null {
  const s = txt(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}
const digits = (v: unknown) => txt(v).replace(/\D/g, '');

export interface SupplierInfo {
  doc: string; name: string; trade_name: string | null; state_registration: string | null;
  street: string | null; street_number: string | null; complement: string | null; district: string | null;
  city: string | null; state: string | null; zip_code: string | null; phone: string | null;
}

export interface InvoicePayload {
  access_key: string; number: string; series: string | null; issue_date: string | null;
  supplier_doc: string; supplier_name: string; dest_doc: string | null;
  total_cents: number; products_cents: number | null; freight_cents: number | null; discount_cents: number | null; other_cents: number | null;
  has_full_xml: boolean; situation?: string | null;
  items: Array<{ line: number; code: string; description: string; ncm: string | null; cfop: string | null; unit: string; qty: number; unit_cents: number; total_cents: number; gtin: string | null }>;
  dues: Array<{ number: string; due_date: string; amount_cents: number }>;
  supplier?: SupplierInfo;
}

// NF-e completa (procNFe com protocolo, ou NFe sozinha).
export function parseFullNfe(xml: string): InvoicePayload {
  const root = parseXml(xml);
  const nfe = obj(obj(root.nfeProc).NFe ?? root.NFe);
  const inf = obj(nfe.infNFe);
  if (!Object.keys(inf).length) throw new Error('Este arquivo não é o XML de uma NF-e (não achei infNFe).');
  const prot = obj(obj(obj(root.nfeProc).protNFe).infProt);
  const id = txt(inf['@Id']);
  const key = digits(txt(prot.chNFe) || id);
  if (key.length !== 44) throw new Error('Não encontrei a chave de acesso (44 números) no XML.');
  const ide = obj(inf.ide);
  const emit = obj(inf.emit);
  const ender = obj(emit.enderEmit);
  const dest = obj(inf.dest);
  const tot = obj(obj(inf.total).ICMSTot);
  const items = arr(inf.det).map((d, i) => {
    const p = obj(d.prod);
    const gtin = txt(p.cEAN);
    return {
      line: Number(txt(d['@nItem'])) || i + 1,
      code: txt(p.cProd),
      description: txt(p.xProd) || 'Item',
      ncm: txt(p.NCM) || null,
      cfop: txt(p.CFOP) || null,
      unit: txt(p.uCom) || 'UN',
      qty: toQty(p.qCom),
      unit_cents: toCents(p.vUnCom),
      total_cents: toCents(p.vProd),
      gtin: gtin && gtin !== 'SEM GTIN' ? gtin : null,
    };
  });
  const dues = arr(obj(obj(inf.cobr)).dup).map((d, i) => ({
    number: txt(d.nDup) || String(i + 1),
    due_date: toDate(d.dVenc) ?? '',
    amount_cents: toCents(d.vDup),
  })).filter((d) => d.due_date && d.amount_cents > 0);
  const supplierDoc = digits(emit.CNPJ) || digits(emit.CPF);
  return {
    access_key: key,
    number: txt(ide.nNF) || '?',
    series: txt(ide.serie) || null,
    issue_date: toDate(ide.dhEmi) ?? toDate(ide.dEmi),
    supplier_doc: supplierDoc,
    supplier_name: txt(emit.xNome),
    dest_doc: digits(dest.CNPJ) || digits(dest.CPF) || null,
    total_cents: toCents(tot.vNF),
    products_cents: toCents(tot.vProd),
    freight_cents: toCents(tot.vFrete),
    discount_cents: toCents(tot.vDesc),
    other_cents: toCents(tot.vOutro),
    has_full_xml: true,
    items,
    dues,
    supplier: {
      doc: supplierDoc,
      name: txt(emit.xNome),
      trade_name: txt(emit.xFant) || null,
      state_registration: txt(emit.IE) || null,
      street: txt(ender.xLgr) || null,
      street_number: txt(ender.nro) || null,
      complement: txt(ender.xCpl) || null,
      district: txt(ender.xBairro) || null,
      city: txt(ender.xMun) || null,
      state: txt(ender.UF) || null,
      zip_code: digits(ender.CEP) || null,
      phone: digits(ender.fone) || null,
    },
  };
}

// Resumo que a SEFAZ manda antes da ciência (resNFe).
export function parseSummary(xml: string): InvoicePayload | null {
  const r = obj(parseXml(xml).resNFe);
  const key = digits(r.chNFe);
  if (key.length !== 44) return null;
  // Só notas de ENTRADA para nós (tpNF 1 = saída do emitente = entrada aqui).
  const sit = txt(r.cSitNFe);
  return {
    access_key: key,
    number: String(Number(key.slice(25, 34))),
    series: String(Number(key.slice(22, 25))),
    issue_date: toDate(r.dhEmi),
    supplier_doc: digits(r.CNPJ) || digits(r.CPF),
    supplier_name: txt(r.xNome),
    dest_doc: null,
    total_cents: toCents(r.vNF),
    products_cents: null, freight_cents: null, discount_cents: null, other_cents: null,
    has_full_xml: false,
    situation: sit === '1' ? 'autorizada' : sit === '2' ? 'denegada' : sit === '3' ? 'cancelada' : sit || null,
    items: [],
    dues: [],
  };
}

// Evento (resEvento / procEventoNFe): devolve a chave e o tipo.
export function parseEvent(xml: string): { key: string; type: string; description: string } | null {
  const root = parseXml(xml);
  const res = obj(root.resEvento);
  if (Object.keys(res).length) {
    return { key: digits(res.chNFe), type: txt(res.tpEvento), description: txt(res.xEvento) };
  }
  const inf = obj(obj(obj(root.procEventoNFe).evento).infEvento);
  if (Object.keys(inf).length) {
    return { key: digits(inf.chNFe), type: txt(inf.tpEvento), description: txt(obj(inf.detEvento).descEvento) };
  }
  return null;
}

// Resposta do NFeDistribuicaoDFe.
export interface DistResult {
  cStat: string; xMotivo: string; ultNSU: string; maxNSU: string;
  docs: Array<{ nsu: string; schema: string; xml: string }>;
}

export function parseDistResponse(soapXml: string, gunzip: (b: Buffer) => Buffer): DistResult {
  const root = parseXml(soapXml);
  const env = obj(root.Envelope);
  const body = obj(env.Body);
  const resp = obj(body.nfeDistDFeInteresseResponse);
  const result = obj(resp.nfeDistDFeInteresseResult);
  const ret = obj(result.retDistDFeInt ?? body.retDistDFeInt);
  if (!Object.keys(ret).length) {
    const fault = obj(body.Fault);
    const reason = txt(obj(fault.Reason).Text) || txt(fault.faultstring);
    throw new Error(reason ? `SEFAZ: ${reason}` : 'Resposta inesperada da SEFAZ.');
  }
  const docs = arr(obj(ret.loteDistDFeInt).docZip).map((d) => ({
    nsu: txt(d['@NSU']),
    schema: txt(d['@schema']),
    xml: gunzip(Buffer.from(txt(d), 'base64')).toString('utf8'),
  }));
  return { cStat: txt(ret.cStat), xMotivo: txt(ret.xMotivo), ultNSU: txt(ret.ultNSU), maxNSU: txt(ret.maxNSU), docs };
}

export function parseEventResponse(soapXml: string): { cStat: string; xMotivo: string } {
  const root = parseXml(soapXml);
  const body = obj(obj(root.Envelope).Body);
  const ret = obj(obj(body.nfeResultMsg).retEnvEvento ?? body.retEnvEvento);
  const ev = arr(ret.retEvento)[0];
  const inf = obj(ev?.infEvento);
  if (Object.keys(inf).length) return { cStat: txt(inf.cStat), xMotivo: txt(inf.xMotivo) };
  if (Object.keys(ret).length) return { cStat: txt(ret.cStat), xMotivo: txt(ret.xMotivo) };
  const fault = obj(body.Fault);
  return { cStat: '', xMotivo: txt(obj(fault.Reason).Text) || 'Resposta inesperada da SEFAZ.' };
}
