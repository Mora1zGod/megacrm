// ============================================================================
// _shared/agent-prompt.ts — montagem do system prompt em camadas
// ----------------------------------------------------------------------------
//   BASE GLOBAL (guardrails)  →  ai_agent_config.guardrails_prompt
//        + MODELO ATIVO       →  ai_agent_profiles WHERE is_active
//        + VARIÁVEIS          →  aplicadas sobre o texto JÁ concatenado
//
// Vive aqui — e não dentro do process-ai-message — porque a tela de teste
// ("Ver prompt montado" / "Testar com a AMAIA") precisa montar EXATAMENTE o
// mesmo prompt do atendimento real. Se cada lado montasse do seu jeito, o
// teste validaria uma coisa e a produção rodaria outra, que é justamente o
// problema que o modo de teste existe para evitar.
//
// Fallback: sem modelo ativo, cai no system_prompt legado (coluna antiga) e,
// se nem isso houver, num prompt mínimo. Assim a migração é reversível.
// ============================================================================

import type { getAdminClient } from './supabase-admin.ts';

type Admin = ReturnType<typeof getAdminClient>;

const FALLBACK_PROMPT =
  'Você é um assistente de atendimento via WhatsApp. Responda em português brasileiro, de forma objetiva e educada.';

export interface AgentProfileLite {
  id: string;
  name: string;
  status: string;
  is_active: boolean;
  body: string;
}

// Substitui {chave} pelo valor. Chave sem valor correspondente é mantida como
// está — assim um placeholder esquecido aparece literalmente no teste em vez
// de sumir silenciosamente, o que torna o erro visível.
export function applyVariables(text: string, vars: Record<string, string>): string {
  return text.replace(/\{([a-z0-9_]+)\}/gi, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : whole,
  );
}

// Busca o modelo ativo da org. Retorna null quando não há nenhum.
export async function loadActiveProfile(
  admin: Admin,
  orgId: string,
): Promise<AgentProfileLite | null> {
  const { data } = await admin
    .from('ai_agent_profiles')
    .select('id, name, status, is_active, body')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .maybeSingle();
  return (data as AgentProfileLite | null) ?? null;
}

// Busca um modelo específico — usado pelo modo de teste, que precisa poder
// montar o prompt de um RASCUNHO sem ativá-lo.
export async function loadProfileById(
  admin: Admin,
  orgId: string,
  profileId: string,
): Promise<AgentProfileLite | null> {
  const { data } = await admin
    .from('ai_agent_profiles')
    .select('id, name, status, is_active, body')
    .eq('org_id', orgId)
    .eq('id', profileId)
    .maybeSingle();
  return (data as AgentProfileLite | null) ?? null;
}

export interface BuildPromptInput {
  guardrails: string | null;
  profileBody: string | null;
  legacySystemPrompt: string | null;
  vars: Record<string, string>;
}

// Concatena as camadas e só então aplica as variáveis — assim um {placeholder}
// funciona tanto na Base Global quanto dentro do corpo do modelo.
export function buildSystemPrompt(input: BuildPromptInput): string {
  const guardrails = (input.guardrails ?? '').trim();
  const body = (input.profileBody ?? '').trim();

  let composed: string;
  if (guardrails && body) {
    composed = `${guardrails}\n\n${body}`;
  } else if (guardrails) {
    composed = guardrails;
  } else if (body) {
    composed = body;
  } else {
    composed = (input.legacySystemPrompt ?? '').trim() || FALLBACK_PROMPT;
  }

  return applyVariables(composed, input.vars);
}
