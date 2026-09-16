// ============================================================================
// connectors/crm.ts — CRM WhatsApp (schema whatsapp_hub) · ATIVO
// ----------------------------------------------------------------------------
// Fonte real e única deste conector: o próprio Postgres do CRM, via service
// role. Toda query é filtrada por org_id (a Edge Function bypassa RLS, então o
// escopo de org é responsabilidade do código aqui).
//
// Tabelas/colunas usadas — todas conferidas nas migrations do repositório do
// CRM (nada inferido):
//   conversations  (org_id, status, channel, created_at, last_message_at,
//                   unread_count, ai_paused, assigned_to, contact_id)
//                  · 20260422120006_conversations.sql + 20260711130000 (channel)
//                    + 20260810120001_mt_backfill.sql (org_id)
//   messages       (org_id, conversation_id, direction, sender_type, content,
//                   content_type, created_at, is_private_note)
//                  · 20260422120006_conversations.sql
//   contacts       (org_id, phone, name, email, source, created_at)
//                  · 20260422120003_contacts_and_tags.sql
//   deals          (org_id, contact_id, pipeline_id, stage_id, title, value,
//                   status, won_at, lost_at, created_at)
//                  · 20260630120000_crm_layer.sql
//   stages         (org_id, pipeline_id, name, position, is_won, is_lost)
//   pipelines      (org_id, name, kind)
// ============================================================================

import type { JarvisConnector, JarvisTool, JarvisToolContext } from '../types.ts';
import { dataHoraLocal, PERIODOS, resolverPeriodo } from '../time.ts';

const periodoParam = {
  type: 'object',
  properties: {
    periodo: {
      type: 'string',
      enum: PERIODOS,
      description: 'Janela de tempo. Default: hoje.',
    },
  },
} as const;

function brl(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function contar(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const k = String(row[key] ?? 'indefinido');
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function listarContagem(mapa: Record<string, number>): string {
  const entradas = Object.entries(mapa).sort((a, b) => b[1] - a[1]);
  if (entradas.length === 0) return 'nenhum';
  return entradas.map(([k, v]) => `${k}: ${v}`).join(', ');
}

// ---------------------------------------------------------------------------
// conversas novas no período
// ---------------------------------------------------------------------------

const conversasNovas: JarvisTool = {
  name: 'crm_conversas_novas',
  description:
    'Quantas conversas NOVAS entraram no CRM num período (primeiro contato do lead), '
    + 'com quebra por canal (whatsapp/instagram) e por status atual.',
  parameters: periodoParam as unknown as Record<string, unknown>,
  async execute(params, ctx: JarvisToolContext) {
    const janela = resolverPeriodo(params.periodo as string | undefined, ctx.timezone);
    const { data, error } = await ctx.admin
      .from('conversations')
      .select('id, channel, status, created_at')
      .eq('org_id', ctx.orgId)
      .gte('created_at', janela.fromISO)
      .lt('created_at', janela.toISO);
    if (error) throw new Error(`consulta conversations: ${error.message}`);

    const rows = (data ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) return `Nenhuma conversa nova ${janela.label}.`;
    return [
      `Conversas novas ${janela.label}: ${rows.length}`,
      `Por canal — ${listarContagem(contar(rows, 'channel'))}`,
      `Por status atual — ${listarContagem(contar(rows, 'status'))}`,
    ].join('\n');
  },
};

// ---------------------------------------------------------------------------
// foto do inbox agora
// ---------------------------------------------------------------------------

const inboxAgora: JarvisTool = {
  name: 'crm_inbox_agora',
  description:
    'Situação do inbox neste momento: conversas com a IA (AMAIA), conversas em '
    + 'atendimento humano, quantas têm mensagem não lida e quantas estão sem resposta.',
  parameters: { type: 'object', properties: {} },
  async execute(_params, ctx: JarvisToolContext) {
    const { data, error } = await ctx.admin
      .from('conversations')
      .select('id, status, unread_count, ai_paused, assigned_to, last_message_at')
      .eq('org_id', ctx.orgId)
      .neq('status', 'closed');
    if (error) throw new Error(`consulta conversations: ${error.message}`);

    const rows = (data ?? []) as Array<{
      status: string;
      unread_count: number | null;
      ai_paused: boolean | null;
      assigned_to: string | null;
      last_message_at: string | null;
    }>;
    if (rows.length === 0) return 'Nenhuma conversa aberta no inbox agora.';

    const comIA = rows.filter((r) => r.status === 'ai_active' && !r.ai_paused).length;
    const humano = rows.filter((r) => r.status === 'human_active').length;
    const naoLidas = rows.filter((r) => (r.unread_count ?? 0) > 0).length;
    const semDono = rows.filter((r) => r.status === 'human_active' && !r.assigned_to).length;
    const ultima = rows
      .map((r) => r.last_message_at)
      .filter((v): v is string => Boolean(v))
      .sort()
      .pop() ?? null;

    return [
      `Conversas abertas: ${rows.length}`,
      `Com a IA (AMAIA): ${comIA}`,
      `Em atendimento humano: ${humano} (sem operador atribuído: ${semDono})`,
      `Com mensagem não lida: ${naoLidas}`,
      `Última mensagem do inbox: ${dataHoraLocal(ultima, ctx.timezone)}`,
    ].join('\n');
  },
};

// ---------------------------------------------------------------------------
// volume de mensagens
// ---------------------------------------------------------------------------

const mensagensPeriodo: JarvisTool = {
  name: 'crm_mensagens_periodo',
  description:
    'Volume de mensagens num período: recebidas dos clientes, enviadas, e quantas '
    + 'saíram da IA (AMAIA) versus operador humano.',
  parameters: periodoParam as unknown as Record<string, unknown>,
  async execute(params, ctx: JarvisToolContext) {
    const janela = resolverPeriodo(params.periodo as string | undefined, ctx.timezone);
    const { data, error } = await ctx.admin
      .from('messages')
      .select('id, direction, sender_type, conversation_id')
      .eq('org_id', ctx.orgId)
      .eq('is_private_note', false)
      .gte('created_at', janela.fromISO)
      .lt('created_at', janela.toISO);
    if (error) throw new Error(`consulta messages: ${error.message}`);

    const rows = (data ?? []) as Array<{
      direction: string;
      sender_type: string;
      conversation_id: string;
    }>;
    if (rows.length === 0) return `Nenhuma mensagem registrada ${janela.label}.`;

    const recebidas = rows.filter((r) => r.direction === 'inbound').length;
    const enviadas = rows.filter((r) => r.direction === 'outbound').length;
    const daIA = rows.filter((r) => r.sender_type === 'ai').length;
    const deOperador = rows.filter((r) => r.sender_type === 'operator').length;
    const conversas = new Set(rows.map((r) => r.conversation_id)).size;

    return [
      `Mensagens ${janela.label}: ${rows.length} (em ${conversas} conversas)`,
      `Recebidas de clientes: ${recebidas}`,
      `Enviadas: ${enviadas} — IA: ${daIA}, operador: ${deOperador}`,
    ].join('\n');
  },
};

// ---------------------------------------------------------------------------
// funil de leads
// ---------------------------------------------------------------------------

const funilLeads: JarvisTool = {
  name: 'crm_funil_leads',
  description:
    'Leads em aberto no funil: quantidade e valor por estágio, e o total do pipeline. '
    + 'Sem argumento traz todos os funis.',
  parameters: {
    type: 'object',
    properties: {
      pipeline: {
        type: 'string',
        description: 'Nome (ou parte do nome) do funil. Omitir para somar todos.',
      },
    },
  },
  async execute(params, ctx: JarvisToolContext) {
    const filtroPipeline = (params.pipeline as string | undefined)?.trim();

    const { data: pipeData, error: pipeErr } = await ctx.admin
      .from('pipelines')
      .select('id, name, kind')
      .eq('org_id', ctx.orgId);
    if (pipeErr) throw new Error(`consulta pipelines: ${pipeErr.message}`);
    let pipelines = (pipeData ?? []) as Array<{ id: string; name: string; kind: string }>;
    if (filtroPipeline) {
      const alvo = filtroPipeline.toLowerCase();
      pipelines = pipelines.filter((p) => p.name.toLowerCase().includes(alvo));
      if (pipelines.length === 0) {
        return `Nenhum funil com nome parecido com "${filtroPipeline}". `
          + `Funis existentes: ${((pipeData ?? []) as Array<{ name: string }>).map((p) => p.name).join(', ') || 'nenhum'}.`;
      }
    }
    if (pipelines.length === 0) return 'Nenhum funil cadastrado no CRM.';
    const pipelineIds = pipelines.map((p) => p.id);

    const { data: stageData, error: stageErr } = await ctx.admin
      .from('stages')
      .select('id, pipeline_id, name, position, is_won, is_lost')
      .eq('org_id', ctx.orgId)
      .in('pipeline_id', pipelineIds);
    if (stageErr) throw new Error(`consulta stages: ${stageErr.message}`);
    const stages = (stageData ?? []) as Array<{
      id: string;
      pipeline_id: string;
      name: string;
      position: number;
      is_won: boolean;
      is_lost: boolean;
    }>;

    const { data: dealData, error: dealErr } = await ctx.admin
      .from('deals')
      .select('id, stage_id, pipeline_id, value, status')
      .eq('org_id', ctx.orgId)
      .eq('status', 'open')
      .in('pipeline_id', pipelineIds);
    if (dealErr) throw new Error(`consulta deals: ${dealErr.message}`);
    const deals = (dealData ?? []) as Array<{
      stage_id: string | null;
      pipeline_id: string | null;
      value: number | string | null;
    }>;

    if (deals.length === 0) {
      return `Nenhum lead em aberto${filtroPipeline ? ` no funil "${filtroPipeline}"` : ''}.`;
    }

    const linhas: string[] = [];
    let totalGeral = 0;
    let qtdGeral = 0;
    for (const pipe of pipelines) {
      const doPipe = deals.filter((d) => d.pipeline_id === pipe.id);
      if (doPipe.length === 0) continue;
      const valorPipe = doPipe.reduce((s, d) => s + Number(d.value ?? 0), 0);
      totalGeral += valorPipe;
      qtdGeral += doPipe.length;
      linhas.push(`Funil "${pipe.name}" (${pipe.kind}): ${doPipe.length} leads · ${brl(valorPipe)}`);
      const doPipeStages = stages
        .filter((s) => s.pipeline_id === pipe.id)
        .sort((a, b) => a.position - b.position);
      for (const stage of doPipeStages) {
        const noStage = doPipe.filter((d) => d.stage_id === stage.id);
        if (noStage.length === 0) continue;
        const valor = noStage.reduce((s, d) => s + Number(d.value ?? 0), 0);
        linhas.push(`  · ${stage.name}: ${noStage.length} · ${brl(valor)}`);
      }
      const semStage = doPipe.filter((d) => !d.stage_id).length;
      if (semStage > 0) linhas.push(`  · (sem estágio): ${semStage}`);
    }
    linhas.push(`TOTAL em aberto: ${qtdGeral} leads · ${brl(totalGeral)}`);
    return linhas.join('\n');
  },
};

// ---------------------------------------------------------------------------
// vendas registradas no CRM (deals ganhos/perdidos)
// ---------------------------------------------------------------------------

const vendasPeriodo: JarvisTool = {
  name: 'crm_negocios_fechados',
  description:
    'Negócios GANHOS e PERDIDOS no período, com valor — segundo o funil do CRM. '
    + 'Atenção: é o que está marcado no CRM, NÃO é o faturamento do caixa do parque.',
  parameters: periodoParam as unknown as Record<string, unknown>,
  async execute(params, ctx: JarvisToolContext) {
    const janela = resolverPeriodo(params.periodo as string | undefined, ctx.timezone);
    const [ganhos, perdidos] = await Promise.all([
      ctx.admin
        .from('deals')
        .select('id, title, value, won_at')
        .eq('org_id', ctx.orgId)
        .eq('status', 'won')
        .gte('won_at', janela.fromISO)
        .lt('won_at', janela.toISO),
      ctx.admin
        .from('deals')
        .select('id, title, value, lost_at')
        .eq('org_id', ctx.orgId)
        .eq('status', 'lost')
        .gte('lost_at', janela.fromISO)
        .lt('lost_at', janela.toISO),
    ]);
    if (ganhos.error) throw new Error(`consulta deals ganhos: ${ganhos.error.message}`);
    if (perdidos.error) throw new Error(`consulta deals perdidos: ${perdidos.error.message}`);

    const g = (ganhos.data ?? []) as Array<{ title: string; value: number | string | null }>;
    const p = (perdidos.data ?? []) as Array<{ title: string; value: number | string | null }>;
    const valorG = g.reduce((s, d) => s + Number(d.value ?? 0), 0);
    const valorP = p.reduce((s, d) => s + Number(d.value ?? 0), 0);

    if (g.length === 0 && p.length === 0) {
      return `Nenhum negócio ganho ou perdido ${janela.label} no CRM.`;
    }
    const linhas = [
      `Negócios ${janela.label} (marcados no CRM):`,
      `Ganhos: ${g.length} · ${brl(valorG)}`,
      `Perdidos: ${p.length} · ${brl(valorP)}`,
    ];
    if (g.length > 0 && g.length <= 10) {
      linhas.push(`Ganhos: ${g.map((d) => `${d.title} (${brl(Number(d.value ?? 0))})`).join('; ')}`);
    }
    return linhas.join('\n');
  },
};

// ---------------------------------------------------------------------------
// ficha de um contato
// ---------------------------------------------------------------------------

const contatoDetalhe: JarvisTool = {
  name: 'crm_contato',
  description:
    'Busca um contato por nome ou telefone e traz a ficha dele: dados, status da '
    + 'conversa, negócios e as últimas mensagens trocadas.',
  parameters: {
    type: 'object',
    properties: {
      busca: {
        type: 'string',
        description: 'Nome (parcial) ou telefone do contato.',
      },
      limite_mensagens: {
        type: 'integer',
        description: 'Quantas mensagens recentes trazer (1-20). Default 8.',
      },
    },
    required: ['busca'],
  },
  async execute(params, ctx: JarvisToolContext) {
    const busca = String(params.busca ?? '').trim();
    if (!busca) return 'Preciso de um nome ou telefone para buscar o contato.';
    const limite = Math.min(Math.max(Number(params.limite_mensagens ?? 8) || 8, 1), 20);

    // O CRM guarda o telefone em E.164 com '+', então casamos por trecho de
    // dígitos. Vírgula/parênteses quebram o parser do or() do PostgREST —
    // removidos do termo de nome.
    const digitos = busca.replace(/\D/g, '');
    const nomeSeguro = busca.replace(/[,()*]/g, ' ').trim();
    const filtros: string[] = [];
    if (digitos.length >= 6) filtros.push(`phone.ilike.%${digitos}%`);
    if (nomeSeguro) filtros.push(`name.ilike.%${nomeSeguro}%`);
    if (filtros.length === 0) return `Busca inválida: "${busca}".`;
    const filtro = filtros.join(',');

    const { data, error } = await ctx.admin
      .from('contacts')
      .select('id, name, phone, email, source, created_at')
      .eq('org_id', ctx.orgId)
      .or(filtro)
      .limit(5);
    if (error) throw new Error(`consulta contacts: ${error.message}`);
    const contatos = (data ?? []) as Array<{
      id: string;
      name: string | null;
      phone: string | null;
      email: string | null;
      source: string | null;
      created_at: string;
    }>;
    if (contatos.length === 0) return `Nenhum contato encontrado para "${busca}".`;
    if (contatos.length > 1) {
      return `Achei ${contatos.length} contatos para "${busca}": `
        + contatos.map((c) => `${c.name ?? 'sem nome'} (${c.phone ?? 'sem telefone'})`).join('; ')
        + '. Qual deles?';
    }

    const contato = contatos[0];
    const [convRes, dealRes] = await Promise.all([
      ctx.admin
        .from('conversations')
        .select('id, status, ai_paused, unread_count, last_message_at, created_at, channel')
        .eq('org_id', ctx.orgId)
        .eq('contact_id', contato.id)
        .maybeSingle(),
      ctx.admin
        .from('deals')
        .select('id, title, value, status, created_at')
        .eq('org_id', ctx.orgId)
        .eq('contact_id', contato.id)
        .order('created_at', { ascending: false })
        .limit(5),
    ]);
    if (convRes.error) throw new Error(`consulta conversations: ${convRes.error.message}`);
    if (dealRes.error) throw new Error(`consulta deals: ${dealRes.error.message}`);

    const conv = convRes.data as {
      id: string;
      status: string;
      ai_paused: boolean | null;
      unread_count: number | null;
      last_message_at: string | null;
      channel: string | null;
    } | null;

    const linhas = [
      `Contato: ${contato.name ?? 'sem nome'}`,
      `Telefone: ${contato.phone ?? '—'} · E-mail: ${contato.email ?? '—'}`,
      `Origem: ${contato.source ?? '—'} · Cadastrado em ${dataHoraLocal(contato.created_at, ctx.timezone)}`,
    ];

    const deals = (dealRes.data ?? []) as Array<{
      title: string;
      value: number | string | null;
      status: string;
    }>;
    linhas.push(
      deals.length === 0
        ? 'Negócios: nenhum'
        : `Negócios: ${deals.map((d) => `${d.title} — ${d.status} (${brl(Number(d.value ?? 0))})`).join('; ')}`,
    );

    if (!conv) {
      linhas.push('Conversa: nenhuma conversa aberta no inbox.');
      return linhas.join('\n');
    }
    linhas.push(
      `Conversa (${conv.channel ?? 'whatsapp'}): ${conv.status}`
      + `${conv.ai_paused ? ' · IA pausada' : ''}`
      + ` · não lidas: ${conv.unread_count ?? 0}`
      + ` · última mensagem ${dataHoraLocal(conv.last_message_at, ctx.timezone)}`,
    );

    const { data: msgData, error: msgErr } = await ctx.admin
      .from('messages')
      .select('direction, sender_type, content, content_type, created_at')
      .eq('org_id', ctx.orgId)
      .eq('conversation_id', conv.id)
      .eq('is_private_note', false)
      .order('created_at', { ascending: false })
      .limit(limite);
    if (msgErr) throw new Error(`consulta messages: ${msgErr.message}`);
    const msgs = ((msgData ?? []) as Array<{
      direction: string;
      sender_type: string;
      content: string | null;
      content_type: string;
      created_at: string;
    }>).reverse();

    if (msgs.length > 0) {
      linhas.push(`Últimas ${msgs.length} mensagens:`);
      for (const m of msgs) {
        const quem = m.sender_type === 'contact' ? contato.name ?? 'cliente' : m.sender_type;
        const texto = m.content?.trim() || `[${m.content_type}]`;
        linhas.push(`  [${dataHoraLocal(m.created_at, ctx.timezone)}] ${quem}: ${texto}`);
      }
    }
    return linhas.join('\n');
  },
};

export const crmConnector: JarvisConnector = {
  name: 'crm',
  description: 'CRM WhatsApp do Amai Park (schema whatsapp_hub): conversas, mensagens, contatos e funil de leads.',
  enabled: true,
  tools: [conversasNovas, inboxAgora, mensagensPeriodo, funilLeads, vendasPeriodo, contatoDetalhe],
};
