import { FunctionsHttpError } from '@supabase/supabase-js';

// O client supabase-js NÃO lê o corpo da resposta quando uma Edge Function
// devolve status não-2xx — `error.message` fica genérico ("Edge Function
// returned a non-2xx status code"), mesmo quando a function mandou um JSON
// { ok: false, error: "motivo real" } no corpo. O corpo de verdade mora em
// `error.context` (um Response) quando o erro é um FunctionsHttpError. Esta
// função lê ele; se não achar nada útil, cai pro que já tínhamos.
export async function extractFunctionErrorMessage(
  error: unknown,
  fallback?: string | null,
): Promise<string> {
  if (error instanceof FunctionsHttpError) {
    try {
      const body = await error.context.clone().json();
      const msg = body && typeof body === 'object' ? (body as Record<string, unknown>).error : null;
      if (typeof msg === 'string' && msg.trim()) return msg;
    } catch {
      // corpo não era JSON — segue pro fallback
    }
  }
  if (fallback && fallback.trim()) return fallback;
  if (error instanceof Error && error.message) return error.message;
  return 'Erro desconhecido.';
}
