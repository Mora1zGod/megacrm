// Leitura de boleto a partir do texto (corpo do e-mail ou nome do arquivo):
// linha digitável de boleto bancário (47 dígitos) e de arrecadação/concessionária (48 dígitos, começa com 8),
// ou código de barras (44 dígitos). Devolve valor (centavos) e vencimento quando o código traz.

export interface BoletoInfo {
  kind: 'bancario' | 'arrecadacao';
  digits: string;        // linha digitável (só dígitos) — 47 ou 48
  barcode: string;       // 44 dígitos
  amount_cents: number | null;
  due_date: string | null; // YYYY-MM-DD
}

const DAY = 86_400_000;
const isoUTC = (t: number) => new Date(t).toISOString().slice(0, 10);

// Fator de vencimento: base 07/10/1997; em 22/02/2025 o fator voltou a 1000 (regra FEBRABAN).
// Fica o candidato mais perto de hoje.
export function dueFromFactor(factor: number, today = Date.now()): string | null {
  if (!factor || factor < 1000) return null;
  const a = Date.UTC(1997, 9, 7) + factor * DAY;
  const b = Date.UTC(2025, 1, 22) + (factor - 1000) * DAY;
  return isoUTC(Math.abs(a - today) <= Math.abs(b - today) ? a : b);
}

function bankFromLine(d: string): BoletoInfo | null {
  if (d.length !== 47) return null;
  // Campos: 1(0-9) DV 2(10-20) DV 3(21-31) DV 4=K(32) 5(33-46)=fator+valor
  const barcode = d.slice(0, 4) + d[32] + d.slice(33, 47) + d.slice(4, 9) + d.slice(10, 20) + d.slice(21, 31);
  const factor = Number(d.slice(33, 37));
  const value = Number(d.slice(37, 47));
  return { kind: 'bancario', digits: d, barcode, amount_cents: value || null, due_date: dueFromFactor(factor) };
}

function collectFromLine(d: string): BoletoInfo | null {
  if (d.length !== 48 || d[0] !== '8') return null;
  const barcode = d.slice(0, 11) + d.slice(12, 23) + d.slice(24, 35) + d.slice(36, 47);
  return fromCollectBarcode(barcode, d);
}

function fromCollectBarcode(barcode: string, digits?: string): BoletoInfo {
  // Posição 3: 6/7 = valor efetivo em reais; 8/9 = quantidade/referência (sem valor confiável).
  const valueId = barcode[2];
  const value = ['6', '7'].includes(valueId) ? Number(barcode.slice(4, 15)) : 0;
  return { kind: 'arrecadacao', digits: digits ?? barcode, barcode, amount_cents: value || null, due_date: null };
}

function fromBankBarcode(b: string): BoletoInfo {
  const factor = Number(b.slice(5, 9));
  const value = Number(b.slice(9, 19));
  return { kind: 'bancario', digits: b, barcode: b, amount_cents: value || null, due_date: dueFromFactor(factor) };
}

// Procura códigos no texto (aceita pontos, espaços e hífens entre os blocos).
export function findBoletos(text: string): BoletoInfo[] {
  const out: BoletoInfo[] = [];
  const seen = new Set<string>();
  const re = /(?:\d[\d.\-\s]{42,70}\d)/g;
  for (const m of text.matchAll(re)) {
    const d = m[0].replace(/\D/g, '');
    let info: BoletoInfo | null = null;
    if (d.length === 48 && d[0] === '8') info = collectFromLine(d);
    else if (d.length === 47) info = bankFromLine(d);
    else if (d.length === 44) info = d[0] === '8' ? fromCollectBarcode(d) : fromBankBarcode(d);
    if (info && !seen.has(info.barcode)) { seen.add(info.barcode); out.push(info); }
  }
  return out;
}

// Outras pistas do texto: CNPJ, valor "R$ 1.234,56" e "vencimento 15/10/2026".
export function findHints(text: string): { cnpjs: string[]; amount_cents: number | null; due_date: string | null } {
  const cnpjs = [...new Set([...text.matchAll(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g)].map((m) => m[0].replace(/\D/g, '')).filter((x) => x.length === 14))];
  const money = [...text.matchAll(/R\$\s*([\d.]{1,12},\d{2})/g)].map((m) => Math.round(Number(m[1].replace(/\./g, '').replace(',', '.')) * 100));
  const dueM = /venc[a-zçã]*\D{0,25}(\d{2})\/(\d{2})\/(\d{4})/i.exec(text);
  return {
    cnpjs,
    amount_cents: money.length ? Math.max(...money) : null,
    due_date: dueM ? `${dueM[3]}-${dueM[2]}-${dueM[1]}` : null,
  };
}

export const htmlToText = (html: string) =>
  html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ');
