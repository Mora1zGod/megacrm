// ============================================================================
// connectors/platform.ts — amai-park-platform (Fastify/Prisma) · STUB
// ----------------------------------------------------------------------------
// A plataforma própria do parque ainda está em planejamento: NENHUM endpoint
// existe hoje. Este arquivo é só o contrato das tools que ela vai expor.
//
// Mesma regra do Pocket: com `enabled: false` o registry devolve o aviso de
// fonte desconectada sem executar nada. Nenhum dado é inventado.
//
// PARA ATIVAR (quando a plataforma subir):
//   1. implemente o corpo de cada execute() chamando a API da plataforma
//      (a base URL e o token devem entrar como credencial cifrada em
//      public.org_settings, via getCredential — NÃO como env var nova);
//   2. troque `enabled: false` por `true` no final deste arquivo.
// ============================================================================

import type { JarvisConnector, JarvisTool } from '../types.ts';

export const PLATFORM_OFFLINE =
  'A plataforma do parque (amai-park-platform) ainda não está no ar, então não '
  + 'tenho essa informação. Assim que os endpoints existirem eu passo a responder.';

function pendente(tool: Omit<JarvisTool, 'execute'>): JarvisTool {
  return {
    ...tool,
    execute: () => Promise.resolve(PLATFORM_OFFLINE),
  };
}

export const platformConnector: JarvisConnector = {
  name: 'platform',
  description:
    'amai-park-platform — plataforma própria do parque (catraca, bilheteria, PDV). '
    + 'AINDA NÃO EXISTE em produção.',
  enabled: false,
  tools: [
    pendente({
      name: 'platform_ocupacao_agora',
      description:
        'Ocupação do parque em tempo real pela catraca: pessoas dentro, entradas e '
        + 'saídas do dia, % da capacidade. FONTE AINDA NÃO DISPONÍVEL.',
      parameters: { type: 'object', properties: {} },
    }),
    pendente({
      name: 'platform_vendas_dia',
      description:
        'Vendas do dia na bilheteria/PDV: ingressos por tipo, ticket médio, total. '
        + 'FONTE AINDA NÃO DISPONÍVEL.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data AAAA-MM-DD. Default: hoje.' },
        },
      },
    }),
    pendente({
      name: 'platform_acessos_periodo',
      description:
        'Histórico de acessos pela catraca num período (por dia e por faixa de horário), '
        + 'para comparar movimento. FONTE AINDA NÃO DISPONÍVEL.',
      parameters: {
        type: 'object',
        properties: {
          de: { type: 'string', description: 'Início AAAA-MM-DD.' },
          ate: { type: 'string', description: 'Fim AAAA-MM-DD.' },
        },
      },
    }),
    pendente({
      name: 'platform_estacionamento',
      description:
        'Situação do estacionamento: vagas ocupadas/livres e faturamento do dia. '
        + 'FONTE AINDA NÃO DISPONÍVEL.',
      parameters: { type: 'object', properties: {} },
    }),
  ],
};
