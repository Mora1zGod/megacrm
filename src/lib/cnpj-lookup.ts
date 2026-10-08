// Consulta de CNPJ e CEP pelo navegador, com serviços de reserva.
// A BrasilAPI às vezes cai (devolve 500/503 quando a fonte dela está fora). Aí tentamos a
// CNPJ.ws pública e a CNPJá aberta, e devolvemos tudo no MESMO formato da BrasilAPI.
import type { CnpjData } from '@/app/routes/purchases/data';

export type CnpjResult = CnpjData & { state_registration?: string | null; source: string };

class NotFound extends Error {}

async function getJson(url: string, ms = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (r.status === 404) throw new NotFound('CNPJ não encontrado na Receita.');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

type O = Record<string, unknown>;
const o = (v: unknown): O => (v && typeof v === 'object' && !Array.isArray(v) ? (v as O) : {});
const a = (v: unknown): O[] => (Array.isArray(v) ? v.map(o) : []);
const s = (v: unknown): string | undefined => (v === null || v === undefined || v === '' || v === 'null' ? undefined : String(v));
const n = (v: unknown): number | undefined => { const x = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(x) ? x : undefined; };
const yes = (v: unknown): boolean | null => (v === true || v === 'Sim' ? true : v === false || v === 'Não' ? false : null);

// CNPJ.ws (publica.cnpj.ws)
function fromCnpjWs(j: O): CnpjResult {
  const e = o(j.estabelecimento);
  const ap = o(e.atividade_principal);
  const ie = a(e.inscricoes_estaduais).find((x) => x.ativo !== false);
  return {
    source: 'CNPJ.ws',
    cnpj: s(e.cnpj), razao_social: s(j.razao_social), nome_fantasia: s(e.nome_fantasia),
    descricao_situacao_cadastral: s(e.situacao_cadastral), data_situacao_cadastral: s(e.data_situacao_cadastral),
    data_inicio_atividade: s(e.data_inicio_atividade),
    cnae_fiscal: n(ap.id), cnae_fiscal_descricao: s(ap.descricao),
    cnaes_secundarios: a(e.atividades_secundarias).map((x) => ({ codigo: n(x.id) ?? 0, descricao: s(x.descricao) ?? '' })),
    porte: s(o(j.porte).descricao), natureza_juridica: s(o(j.natureza_juridica).descricao),
    opcao_pelo_simples: yes(o(j.simples).simples), opcao_pelo_mei: yes(o(j.simples).mei),
    capital_social: n(j.capital_social), descricao_identificador_matriz_filial: s(e.tipo)?.toUpperCase(),
    email: s(e.email) ?? null,
    ddd_telefone_1: s(e.ddd1) && s(e.telefone1) ? `${e.ddd1}${e.telefone1}` : undefined,
    ddd_telefone_2: s(e.ddd2) && s(e.telefone2) ? `${e.ddd2}${e.telefone2}` : undefined,
    cep: s(e.cep), descricao_tipo_de_logradouro: s(e.tipo_logradouro), logradouro: s(e.logradouro), numero: s(e.numero),
    complemento: s(e.complemento), bairro: s(e.bairro), municipio: s(o(e.cidade).nome), uf: s(o(e.estado).sigla),
    qsa: a(j.socios).map((x) => ({ nome_socio: s(x.nome) ?? '', qualificacao_socio: s(o(x.qualificacao_socio).descricao), data_entrada_sociedade: s(x.data_entrada) })),
    state_registration: ie ? s(ie.inscricao_estadual) ?? null : null,
  };
}

// CNPJá aberta (open.cnpja.com)
function fromCnpja(j: O): CnpjResult {
  const c = o(j.company); const ad = o(j.address); const ma = o(j.mainActivity);
  const phones = a(j.phones).map((p) => `${s(p.area) ?? ''}${s(p.number) ?? ''}`).filter(Boolean);
  const reg = a(j.registrations).find((r) => s(o(r.status).text)?.toLowerCase().includes('sem restri') || r.enabled === true);
  return {
    source: 'CNPJá',
    cnpj: s(j.taxId), razao_social: s(c.name), nome_fantasia: s(j.alias),
    descricao_situacao_cadastral: s(o(j.status).text), data_situacao_cadastral: s(j.statusDate),
    data_inicio_atividade: s(j.founded),
    cnae_fiscal: n(ma.id), cnae_fiscal_descricao: s(ma.text),
    cnaes_secundarios: a(j.sideActivities).map((x) => ({ codigo: n(x.id) ?? 0, descricao: s(x.text) ?? '' })),
    porte: s(o(c.size).text), natureza_juridica: s(o(c.nature).text),
    opcao_pelo_simples: typeof o(c.simples).optant === 'boolean' ? (o(c.simples).optant as boolean) : null,
    opcao_pelo_mei: typeof o(c.simei).optant === 'boolean' ? (o(c.simei).optant as boolean) : null,
    capital_social: n(c.equity), descricao_identificador_matriz_filial: j.head === true ? 'MATRIZ' : j.head === false ? 'FILIAL' : undefined,
    email: s(a(j.emails)[0]?.address) ?? null,
    ddd_telefone_1: phones[0], ddd_telefone_2: phones[1],
    cep: s(ad.zip), logradouro: s(ad.street), numero: s(ad.number), complemento: s(ad.details), bairro: s(ad.district),
    municipio: s(ad.city), uf: s(ad.state),
    qsa: a(c.members).map((m) => ({ nome_socio: s(o(m.person).name) ?? '', qualificacao_socio: s(o(m.role).text), data_entrada_sociedade: s(m.since) })),
    state_registration: reg ? s(reg.number) ?? null : null,
  };
}

export async function lookupCnpj(cnpj: string): Promise<CnpjResult> {
  const d = cnpj.replace(/\D/g, '');
  const tries: Array<[string, (j: O) => CnpjResult]> = [
    [`https://brasilapi.com.br/api/cnpj/v1/${d}`, (j) => ({ ...(j as CnpjData), source: 'BrasilAPI' })],
    [`https://publica.cnpj.ws/cnpj/${d}`, fromCnpjWs],
    [`https://open.cnpja.com/office/${d}`, fromCnpja],
  ];
  let notFound = 0;
  for (const [url, map] of tries) {
    try {
      const r = map(o(await getJson(url)));
      if (r.razao_social) return r;
    } catch (e) {
      if (e instanceof NotFound) notFound++;
    }
  }
  if (notFound >= 2) throw new Error('CNPJ não encontrado na Receita.');
  throw new Error('Os serviços de consulta de CNPJ não responderam agora. Tente de novo em instantes ou preencha à mão.');
}

export interface CepResult { street?: string; district?: string; city?: string; state?: string }

export async function lookupCep(cep: string): Promise<CepResult | null> {
  const d = cep.replace(/\D/g, '');
  if (d.length !== 8) return null;
  try {
    const c = o(await getJson(`https://brasilapi.com.br/api/cep/v1/${d}`, 6000));
    return { street: s(c.street), district: s(c.neighborhood), city: s(c.city), state: s(c.state) };
  } catch { /* reserva abaixo */ }
  try {
    const c = o(await getJson(`https://viacep.com.br/ws/${d}/json/`, 6000));
    if (c.erro) return null;
    return { street: s(c.logradouro), district: s(c.bairro), city: s(c.localidade), state: s(c.uf) };
  } catch { return null; }
}
