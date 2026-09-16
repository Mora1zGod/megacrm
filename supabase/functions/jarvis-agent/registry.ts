// ============================================================================
// jarvis-agent/registry.ts — REGISTRY CENTRAL DE CONECTORES
// ----------------------------------------------------------------------------
// É o ÚNICO arquivo que precisa ser tocado para ligar/desligar uma fonte de
// dado. O núcleo (index.ts) só consome buildTools()/executeTool() — ele não
// sabe o que é CRM, Pocket ou plataforma.
//
// Adicionar uma fonte nova:
//   1. crie connectors/<fonte>.ts exportando um JarvisConnector;
//   2. importe aqui e some 1 linha no array CONNECTORS.
//
// Ligar um stub existente: troque `enabled` para true no arquivo do conector,
// depois de implementar os corpos.
// ============================================================================

import type { JarvisConnector, JarvisTool, JarvisToolContext } from './types.ts';
import { crmConnector } from './connectors/crm.ts';
import { pocketConnector } from './connectors/pocket.ts';
import { platformConnector } from './connectors/platform.ts';

// --- os conectores registrados ---------------------------------------------
export const CONNECTORS: JarvisConnector[] = [
  crmConnector,      // ATIVO  — whatsapp_hub (CRM em produção)
  pocketConnector,   // STUB   — Pocket/F2WAY: sem acesso hoje
  platformConnector, // STUB   — amai-park-platform: ainda não existe
];

export interface OpenAIToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface Registered {
  connector: JarvisConnector;
  tool: JarvisTool;
}

function indexTools(): Map<string, Registered> {
  const map = new Map<string, Registered>();
  for (const connector of CONNECTORS) {
    for (const tool of connector.tools) {
      if (map.has(tool.name)) {
        // Nome duplicado entre conectores quebraria o despacho — falha alto e
        // cedo, no deploy, em vez de responder com a tool errada.
        throw new Error(`Tool duplicada no registry: ${tool.name}`);
      }
      map.set(tool.name, { connector, tool });
    }
  }
  return map;
}

const TOOL_INDEX = indexTools();

/**
 * Lista de tools no formato da OpenAI.
 *
 * Por que as tools dos conectores DESLIGADOS também vão para o modelo: é o que
 * garante a resposta honesta. Se o modelo não enxergasse `pocket_*`, ele teria
 * que adivinhar o que fazer com "quanto vendi hoje" — e modelo que adivinha,
 * inventa. Enxergando a tool, ele a chama, recebe "fonte não conectada" e
 * repassa isso. A execução do stub é interceptada em executeTool().
 */
export function buildTools(): OpenAIToolDef[] {
  return [...TOOL_INDEX.values()].map(({ connector, tool }) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: connector.enabled
        ? tool.description
        : `[FONTE NÃO CONECTADA - ${connector.name}] ${tool.description}`,
      parameters: tool.parameters,
    },
  }));
}

export interface ToolRun {
  ok: boolean;
  output: string;
  connector: string;
  /** true quando a fonte está desligada (não é erro, é resposta honesta). */
  offline: boolean;
}

/**
 * Despacha pelo nome. Conector desligado NUNCA executa o corpo da tool —
 * devolve o aviso padrão da fonte. Erro de execução vira texto para o modelo
 * (nada de derrubar a resposta inteira por causa de uma query).
 */
export async function executeTool(
  name: string,
  params: Record<string, unknown>,
  ctx: JarvisToolContext,
): Promise<ToolRun> {
  const entry = TOOL_INDEX.get(name);
  if (!entry) {
    return { ok: false, output: `Tool desconhecida: ${name}.`, connector: '-', offline: false };
  }
  const { connector, tool } = entry;

  if (!connector.enabled) {
    return {
      ok: true,
      output: await tool.execute(params, ctx), // stub: só o aviso de desconectado
      connector: connector.name,
      offline: true,
    };
  }

  try {
    return { ok: true, output: await tool.execute(params, ctx), connector: connector.name, offline: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'jarvis_tool_error', tool: name, message }));
    return {
      ok: false,
      output: `Erro ao consultar ${connector.name} (${name}): ${message}. `
        + 'Não invente o dado — avise que a consulta falhou.',
      connector: connector.name,
      offline: false,
    };
  }
}

/** Resumo das fontes para o system prompt — o agente sabe o que tem e o que não tem. */
export function fontesBrief(): string {
  const linhas = CONNECTORS.map((c) =>
    `· ${c.name}: ${c.enabled ? 'CONECTADO' : 'NÃO CONECTADO'} — ${c.description}`,
  );
  return linhas.join('\n');
}
