// ============================================================================
// jarvis-agent/usage.ts — custo em whatsapp_hub.ai_usage_log
// ----------------------------------------------------------------------------
// kind='jarvis' (chat) e kind='jarvis_transcription' (Whisper). O front filtra
// kind='chat' para contar mensagens do AMAIA, então o Jarvis não contamina essa
// contagem — mas ENTRA na soma de custo do período (é custo de IA de verdade,
// pago na mesma conta).
//
// A tabela pode não existir / ter shape diferente no projeto (ela é lida pelo
// front mas não é criada por migration no repositório do CRM — ver a migration
// 20260916120000_jarvis_core.sql). Por isso o insert é best-effort: falhou,
// loga e segue. Custo não registrado nunca pode impedir a resposta.
// ============================================================================

import type { Admin } from './types.ts';

// Preço de referência OpenAI em USD por 1M de tokens. Atualize aqui quando a
// tabela de preços mudar — é o único lugar que sabe disso.
const PRECO_POR_MILHAO: Record<string, { entrada: number; saida: number }> = {
  'gpt-4.1': { entrada: 2.00, saida: 8.00 },
  'gpt-4.1-mini': { entrada: 0.40, saida: 1.60 },
  'gpt-4.1-nano': { entrada: 0.10, saida: 0.40 },
  'gpt-4o': { entrada: 2.50, saida: 10.00 },
  'gpt-4o-mini': { entrada: 0.15, saida: 0.60 },
};

// Whisper: USD por minuto de áudio.
const PRECO_WHISPER_MINUTO = 0.006;

export function estimarCustoChat(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  // Modelos com sufixo de data (gpt-4.1-mini-2025-04-14) caem no preço da base.
  //
  // A ordem importa: 'gpt-4.1-mini' COMEÇA com 'gpt-4.1-', então uma busca na
  // ordem de inserção casaria o preço do gpt-4.1 (5x mais caro) para o modelo
  // default. Match exato primeiro; depois o prefixo MAIS LONGO.
  const base = Object.keys(PRECO_POR_MILHAO).includes(model)
    ? model
    : Object.keys(PRECO_POR_MILHAO)
      .filter((k) => model.startsWith(`${k}-`))
      .sort((a, b) => b.length - a.length)[0];
  if (!base) {
    console.log(JSON.stringify({ event: 'jarvis_preco_desconhecido', model }));
    return 0;
  }
  const preco = PRECO_POR_MILHAO[base];
  const custo = (promptTokens / 1_000_000) * preco.entrada
    + (completionTokens / 1_000_000) * preco.saida;
  return Number(custo.toFixed(6));
}

export function estimarCustoWhisper(segundos: number): number {
  return Number(((segundos / 60) * PRECO_WHISPER_MINUTO).toFixed(6));
}

export async function registrarUso(
  admin: Admin,
  input: {
    orgId: string;
    kind: 'jarvis' | 'jarvis_transcription';
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    custoUsd: number;
  },
): Promise<void> {
  const { error } = await admin.from('ai_usage_log').insert({
    org_id: input.orgId,
    // O Jarvis não roda dentro de uma conversa do CRM.
    conversation_id: null,
    kind: input.kind,
    model: input.model,
    prompt_tokens: input.promptTokens ?? null,
    completion_tokens: input.completionTokens ?? null,
    estimated_cost_usd: input.custoUsd,
  });
  if (error) {
    console.error(JSON.stringify({
      event: 'jarvis_usage_log_failed',
      message: error.message,
      kind: input.kind,
      cost: input.custoUsd,
    }));
  }
}
