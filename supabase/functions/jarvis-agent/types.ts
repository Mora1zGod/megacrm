// ============================================================================
// jarvis-agent/types.ts — contrato dos conectores
// ----------------------------------------------------------------------------
// O núcleo do agente NÃO sabe de onde vem o dado. Ele monta a lista de tools a
// partir do registry e chama execute(params, ctx) pelo nome que o modelo pediu.
//
// Ligar uma fonte nova = criar um arquivo em connectors/ exportando um
// JarvisConnector e somar 1 linha no registry.ts. Nada mais muda.
// ============================================================================

import type { getAdminClient } from '../_shared/supabase-admin.ts';

export type Admin = ReturnType<typeof getAdminClient>;

export interface JarvisUser {
  id: string;
  org_id: string;
  phone: string;
  display_name: string | null;
}

export interface JarvisToolContext {
  admin: Admin;
  orgId: string;
  user: JarvisUser;
  /** Fuso de whatsapp_hub.jarvis_config.timezone — resolve "hoje"/"ontem". */
  timezone: string;
}

/**
 * Uma ferramenta exposta ao modelo.
 *
 * `parameters` é JSON Schema puro (o formato que a OpenAI espera em
 * tools[].function.parameters). Use `{ type: 'object', properties: {} }` para
 * tool sem argumento.
 *
 * `execute` SEMPRE devolve texto pronto para o modelo ler — nunca lança para
 * erro de negócio (ex.: fonte desligada). Exceção só para bug real; o núcleo
 * captura e devolve o erro ao modelo como resultado da tool.
 */
export interface JarvisTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(params: Record<string, unknown>, ctx: JarvisToolContext): Promise<string>;
}

export interface JarvisConnector {
  /** Prefixo lógico das tools (ex.: 'crm'). Só documental/diagnóstico. */
  name: string;
  description: string;
  /**
   * false = conector registrado porém desligado. As tools NÃO vão para o
   * modelo; o núcleo usa a lista só para responder honestamente que a fonte
   * ainda não está conectada (ver registry.disabledSourcesBrief).
   */
  enabled: boolean;
  tools: JarvisTool[];
}
