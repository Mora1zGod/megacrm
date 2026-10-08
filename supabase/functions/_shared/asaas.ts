// ============================================================================
// _shared/asaas.ts — client mínimo do ASAAS (cobrança boleto/PIX)
// ----------------------------------------------------------------------------
// Docs: docs.asaas.com — base https://api.asaas.com/v3 (produção) e
// https://api-sandbox.asaas.com/v3 (sandbox); chave no header `access_token`.
// Endpoints usados: POST /customers, POST /payments, GET /payments/{id}/pixQrCode,
// DELETE /payments/{id}, POST /payments/{id}/refund.
// Credenciais POR ORG (public.org_settings): asaas_api_key, asaas_env
// ('sandbox' | 'production'), asaas_webhook_token.
// ============================================================================

import { getCredential } from './credentials.ts';

export class AsaasError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

export interface AsaasContext {
  baseUrl: string;
  apiKey: string;
  env: 'sandbox' | 'production';
}

export async function loadAsaas(orgId: string): Promise<AsaasContext> {
  const apiKey = (await getCredential(orgId, 'asaas_api_key'))?.trim();
  if (!apiKey) throw new AsaasError('O ASAAS ainda não foi configurado. Vá em Financeiro → Configurações → Cobrança ASAAS e informe a chave da API.', 400);
  const env = (await getCredential(orgId, 'asaas_env')) === 'sandbox' ? 'sandbox' : 'production';
  return {
    apiKey,
    env,
    baseUrl: env === 'sandbox' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3',
  };
}

// Mensagem do ASAAS: { errors: [{ code, description }] }.
function asaasMessage(body: unknown, status: number): string {
  const errs = (body as { errors?: Array<{ description?: string }> } | null)?.errors;
  const d = Array.isArray(errs) ? errs.map((e) => e?.description).filter(Boolean).join(' ') : '';
  if (status === 401) return 'A chave da API do ASAAS foi recusada. Confira a chave e o ambiente (sandbox/produção) nas configurações.';
  return d ? `O ASAAS recusou: ${d}` : `O ASAAS não respondeu como esperado (${status}). Tente de novo em alguns minutos.`;
}

export async function asaasFetch(ctx: AsaasContext, path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${ctx.baseUrl}${path}`, {
      ...init,
      headers: { access_token: ctx.apiKey, 'Content-Type': 'application/json', accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch {
    throw new AsaasError('Não consegui falar com o ASAAS agora. Tente de novo em alguns minutos.');
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) throw new AsaasError(asaasMessage(body, res.status), res.status === 401 ? 400 : 502);
  return (body ?? {}) as Record<string, unknown>;
}

// Centavos (inteiro) → valor do ASAAS (reais com 2 casas), sem passar por float na conta.
export function centsToAsaas(cents: number): number {
  const s = `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')}`;
  return Number(s);
}

// Valor do ASAAS (ex.: 100.9) → centavos (inteiro) pela representação em texto.
export function asaasToCents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return 0;
  const [int, dec = ''] = n.toFixed(2).split('.');
  return Number(int) * 100 + (int.startsWith('-') ? -1 : 1) * Number(dec.padEnd(2, '0'));
}
