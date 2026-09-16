// ============================================================================
// connectors/pocket.ts — Pocket / F2WAY (financeiro, compras, estoque) · STUB
// ----------------------------------------------------------------------------
// Sistema do fornecedor. HOJE NÃO TEMOS acesso a API nem a banco (disputa
// contratual em andamento). Este arquivo é o CONTRATO pronto: os nomes, a
// descrição e os argumentos das tools que vão existir quando o acesso sair.
//
// Enquanto `enabled: false`, o registry NUNCA executa o corpo destas funções —
// ele substitui a execução pelo aviso padrão de fonte desconectada. Ou seja:
// mesmo que alguém comece a implementar um corpo aqui, nada vaza para o
// WhatsApp antes de a flag virar.
//
// PARA ATIVAR (quando tivermos acesso):
//   1. implemente o corpo de cada execute() abaixo (chamando a API do Pocket);
//   2. troque `enabled: false` por `true` no final deste arquivo.
// Nada mais no sistema muda — nem o núcleo do agente, nem o roteamento do
// webhook, nem o registry.
//
// NUNCA inventar número aqui. Sem fonte, a resposta é "não tenho acesso".
// ============================================================================

import type { JarvisConnector, JarvisTool } from '../types.ts';

export const POCKET_OFFLINE =
  'Ainda não tenho acesso ao Pocket/F2WAY para essa informação — a integração '
  + 'não está liberada. Consulte direto no sistema do fornecedor por enquanto.';

function pendente(tool: Omit<JarvisTool, 'execute'>): JarvisTool {
  return {
    ...tool,
    // Corpo a ser implementado quando o acesso ao Pocket sair. Enquanto
    // enabled=false, o registry nem chega a invocar isto.
    execute: () => Promise.resolve(POCKET_OFFLINE),
  };
}

export const pocketConnector: JarvisConnector = {
  name: 'pocket',
  description:
    'Pocket/F2WAY — sistema do fornecedor: financeiro (caixa, faturamento), '
    + 'compras e estoque do parque. Fonte AINDA NÃO CONECTADA.',
  enabled: false,
  tools: [
    pendente({
      name: 'pocket_consultar_estoque',
      description:
        'Posição de estoque de um item ou categoria (quantidade, mínimo, ruptura). '
        + 'FONTE AINDA NÃO CONECTADA — hoje só responde que não tem acesso.',
      parameters: {
        type: 'object',
        properties: {
          item: { type: 'string', description: 'Nome do produto/insumo. Omitir para visão geral.' },
          apenas_abaixo_do_minimo: {
            type: 'boolean',
            description: 'Filtrar só o que está abaixo do estoque mínimo.',
          },
        },
      },
    }),
    pendente({
      name: 'pocket_financeiro_dia',
      description:
        'Movimento financeiro de um dia: entradas, saídas, saldo e formas de pagamento. '
        + 'FONTE AINDA NÃO CONECTADA — hoje só responde que não tem acesso.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data no formato AAAA-MM-DD. Default: hoje.' },
        },
      },
    }),
    pendente({
      name: 'pocket_compras_pendentes',
      description:
        'Pedidos de compra em aberto: fornecedor, valor, previsão de entrega. '
        + 'FONTE AINDA NÃO CONECTADA — hoje só responde que não tem acesso.',
      parameters: {
        type: 'object',
        properties: {
          fornecedor: { type: 'string', description: 'Filtrar por fornecedor.' },
        },
      },
    }),
    pendente({
      name: 'pocket_contas_a_pagar',
      description:
        'Contas a pagar com vencimento num intervalo, incluindo atrasadas. '
        + 'FONTE AINDA NÃO CONECTADA — hoje só responde que não tem acesso.',
      parameters: {
        type: 'object',
        properties: {
          ate: { type: 'string', description: 'Vencimento até AAAA-MM-DD.' },
          apenas_atrasadas: { type: 'boolean' },
        },
      },
    }),
  ],
};
