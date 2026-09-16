// ============================================================================
// jarvis-agent  (service-role only)
// ----------------------------------------------------------------------------
// Agente pessoal do Gabriel. Só é acionado pelo desvio em _shared/jarvis-routing.ts,
// que roda dentro do zernio-webhook quando o remetente está em
// whatsapp_hub.jarvis_users. Cliente nunca chega aqui — e o AMAIA nunca vê a
// mensagem que chega aqui.
//
// Fluxo:
//   1. requireServiceRole (mesmo gate das funções disparadas por trigger/cron).
//   2. Carrega jarvis_config + jarvis_users (org, fuso, modelo, persona).
//   3. Texto: usa direto. Áudio: transcreve no Whisper (mesma openai_api_key).
//   4. Monta o contexto (histórico em jarvis_messages) e roda o loop de tool
//      calling com as tools que vierem do REGISTRY — o núcleo não sabe de onde
//      vem o dado, só despacha pelo nome.
//   5. Responde pelo WhatsApp e grava o turno no histórico.
//   6. Loga o custo em ai_usage_log com kind='jarvis'.
//
// Deploy: supabase functions deploy jarvis-agent   (com verificação de JWT,
// padrão — o chamador manda a service role key).
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { AuthError, requireServiceRole } from '../_shared/auth.ts';
import { buildTools, executeTool, fontesBrief } from './registry.ts';
import { chatWithTools, transcreverAudio, type ChatMessage } from './openai.ts';
import { responderWhatsApp } from './reply.ts';
import { estimarCustoChat, registrarUso } from './usage.ts';
import { agoraLocal } from './time.ts';
import type { JarvisToolContext, JarvisUser } from './types.ts';

interface JarvisRequest {
  org_id: string;
  jarvis_user_id: string;
  phone: string;
  text: string | null;
  media_url: string | null;
  content_type: string | null;
  zernio_account_id: string | null;
  zernio_conversation_id: string | null;
  zernio_message_id: string | null;
}

interface JarvisConfigRow {
  is_active: boolean;
  model: string;
  system_prompt: string | null;
  timezone: string;
  max_tool_rounds: number;
  history_limit: number;
}

const CONFIG_PADRAO: JarvisConfigRow = {
  is_active: true,
  model: 'gpt-4.1-mini',
  system_prompt: null,
  timezone: 'America/Rio_Branco',
  max_tool_rounds: 4,
  history_limit: 12,
};

function personaPadrao(nome: string, timezone: string): string {
  return [
    `Você é o Jarvis, assistente pessoal do ${nome}, diretor do Amai Park.`,
    'Você fala com ELE, não com cliente. Português brasileiro, direto, sem enrolação,',
    'sem saudação cerimoniosa. Resposta de WhatsApp: curta, com número na frente.',
    '',
    `Agora são ${agoraLocal(timezone)} (fuso ${timezone}).`,
    '',
    'REGRA INEGOCIÁVEL: você só afirma número que veio de uma ferramenta.',
    'Nunca estime, nunca arredonde "de cabeça", nunca complete dado que faltou.',
    'Se a ferramenta disser que a fonte não está conectada, repasse isso na lata',
    '— é resposta certa, não é falha. Se a consulta der erro, diga que falhou.',
    '',
    'Fontes de dado registradas:',
    fontesBrief(),
    '',
    'Quando a pergunta for de mais de uma fonte, responda o que tem e diga',
    'claramente o que ainda não dá para responder.',
  ].join('\n');
}

async function carregarConfig(
  admin: ReturnType<typeof getAdminClient>,
  orgId: string,
): Promise<JarvisConfigRow> {
  const { data, error } = await admin
    .from('jarvis_config')
    .select('is_active, model, system_prompt, timezone, max_tool_rounds, history_limit')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) {
    console.error(JSON.stringify({ event: 'jarvis_config_error', message: error.message }));
    return CONFIG_PADRAO;
  }
  return { ...CONFIG_PADRAO, ...((data ?? {}) as Partial<JarvisConfigRow>) };
}

async function carregarHistorico(
  admin: ReturnType<typeof getAdminClient>,
  jarvisUserId: string,
  limite: number,
): Promise<ChatMessage[]> {
  if (limite <= 0) return [];
  const { data, error } = await admin
    .from('jarvis_messages')
    .select('role, content, created_at')
    .eq('jarvis_user_id', jarvisUserId)
    .order('created_at', { ascending: false })
    .limit(limite);
  if (error) {
    console.error(JSON.stringify({ event: 'jarvis_history_error', message: error.message }));
    return [];
  }
  return ((data ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>)
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
}

async function gravarTurno(
  admin: ReturnType<typeof getAdminClient>,
  input: {
    orgId: string;
    jarvisUserId: string;
    pergunta: string;
    resposta: string;
    toolsUsadas: string[];
  },
): Promise<void> {
  const { error } = await admin.from('jarvis_messages').insert([
    { org_id: input.orgId, jarvis_user_id: input.jarvisUserId, role: 'user', content: input.pergunta },
    {
      org_id: input.orgId,
      jarvis_user_id: input.jarvisUserId,
      role: 'assistant',
      content: input.resposta,
      tools_used: input.toolsUsadas,
    },
  ]);
  if (error) {
    console.error(JSON.stringify({ event: 'jarvis_history_insert_failed', message: error.message }));
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const admin = getAdminClient();
  let body: JarvisRequest;

  try {
    await requireServiceRole(req);
    body = await req.json() as JarvisRequest;
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 400;
    return jsonResponse({ ok: false, error: err instanceof Error ? err.message : 'Bad request' }, { status });
  }

  if (!body?.org_id || !body?.jarvis_user_id || !body?.phone) {
    return jsonResponse({ ok: false, error: 'org_id, jarvis_user_id e phone são obrigatórios' }, { status: 400 });
  }

  try {
    // --- usuário autorizado (revalidado aqui: a função é um endpoint próprio) ---
    const { data: userData, error: userErr } = await admin
      .from('jarvis_users')
      .select('id, org_id, phone, display_name')
      .eq('id', body.jarvis_user_id)
      .eq('org_id', body.org_id)
      .eq('is_active', true)
      .maybeSingle();
    if (userErr) throw new Error(`consulta jarvis_users: ${userErr.message}`);
    const user = userData as JarvisUser | null;
    if (!user || user.phone !== body.phone) {
      console.log(JSON.stringify({ event: 'jarvis_user_nao_autorizado', org_id: body.org_id }));
      return jsonResponse({ ok: true, skipped: 'nao_autorizado' });
    }

    const config = await carregarConfig(admin, body.org_id);
    if (!config.is_active) {
      return jsonResponse({ ok: true, skipped: 'jarvis_inativo' });
    }

    const creds = await loadAppCredentials(body.org_id);
    // Mesma credencial que já paga o AMAIA. Nenhuma chave nova.
    const openaiKey = creds.llm_api_key ?? creds.openai_api_key;
    if (!openaiKey) {
      throw new Error('openai_api_key/llm_api_key não configurada em org_settings.');
    }

    // --- entrada: texto ou áudio ---------------------------------------------
    let pergunta = (body.text ?? '').trim();
    const tipo = (body.content_type ?? 'text').toLowerCase();

    if (!pergunta && tipo === 'audio' && body.media_url) {
      try {
        pergunta = await transcreverAudio(openaiKey, body.media_url);
        console.log(JSON.stringify({ event: 'jarvis_audio_transcrito', chars: pergunta.length }));
      } catch (err) {
        console.error(JSON.stringify({ event: 'jarvis_transcricao_falhou', message: String(err) }));
        await responderWhatsApp(admin, {
          orgId: body.org_id,
          phone: body.phone,
          zernioAccountId: body.zernio_account_id,
          texto: 'Não consegui ouvir esse áudio. Manda por texto?',
        });
        return jsonResponse({ ok: true, skipped: 'transcricao_falhou' });
      }
    }

    if (!pergunta) {
      const aviso = tipo === 'text'
        ? 'Chegou vazio aqui. Manda de novo?'
        : `Por enquanto eu só leio texto e áudio — esse "${tipo}" eu ainda não processo.`;
      await responderWhatsApp(admin, {
        orgId: body.org_id,
        phone: body.phone,
        zernioAccountId: body.zernio_account_id,
        texto: aviso,
      });
      return jsonResponse({ ok: true, skipped: `sem_texto:${tipo}` });
    }

    // --- montagem do contexto -------------------------------------------------
    const nome = user.display_name?.split(' ')[0] ?? 'Gabriel';
    const systemPrompt = config.system_prompt?.trim()
      ? `${config.system_prompt.trim()}\n\nAgora são ${agoraLocal(config.timezone)} (fuso ${config.timezone}).`
        + `\n\nFontes de dado registradas:\n${fontesBrief()}`
        + '\n\nNunca invente número: só afirme o que veio de uma ferramenta.'
      : personaPadrao(nome, config.timezone);

    const historico = await carregarHistorico(admin, user.id, config.history_limit);
    const mensagens: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...historico,
      { role: 'user', content: pergunta },
    ];

    const toolCtx: JarvisToolContext = {
      admin,
      orgId: body.org_id,
      user,
      timezone: config.timezone,
    };
    const tools = buildTools();

    // --- loop de tool calling -------------------------------------------------
    let promptTokens = 0;
    let completionTokens = 0;
    const toolsUsadas: string[] = [];
    let resposta = '';

    for (let rodada = 0; rodada <= config.max_tool_rounds; rodada++) {
      const ultimaRodada = rodada === config.max_tool_rounds;
      const resultado = await chatWithTools({
        apiKey: openaiKey,
        model: config.model,
        messages: mensagens,
        // Na última rodada tira as tools: o modelo é obrigado a concluir com o
        // que já tem, em vez de pedir consulta que não vai mais rodar.
        tools: ultimaRodada ? [] : tools,
      });
      promptTokens += resultado.usage.prompt_tokens;
      completionTokens += resultado.usage.completion_tokens;

      const msg = resultado.message;
      const chamadas = msg.tool_calls ?? [];
      if (chamadas.length === 0) {
        resposta = (msg.content ?? '').trim();
        break;
      }

      mensagens.push({ role: 'assistant', content: msg.content ?? null, tool_calls: chamadas });
      for (const chamada of chamadas) {
        const run = await executeTool(chamada.function.name, parseArgs(chamada.function.arguments), toolCtx);
        toolsUsadas.push(chamada.function.name);
        console.log(JSON.stringify({
          event: 'jarvis_tool_run',
          tool: chamada.function.name,
          connector: run.connector,
          offline: run.offline,
          ok: run.ok,
        }));
        mensagens.push({ role: 'tool', tool_call_id: chamada.id, content: run.output });
      }
    }

    if (!resposta) {
      resposta = 'Consultei aqui mas não consegui fechar uma resposta. Tenta perguntar de outro jeito?';
    }

    // --- resposta + persistência ---------------------------------------------
    await responderWhatsApp(admin, {
      orgId: body.org_id,
      phone: body.phone,
      zernioAccountId: body.zernio_account_id,
      texto: resposta,
    });

    await gravarTurno(admin, {
      orgId: body.org_id,
      jarvisUserId: user.id,
      pergunta,
      resposta,
      toolsUsadas,
    });

    await registrarUso(admin, {
      orgId: body.org_id,
      kind: 'jarvis',
      model: config.model,
      promptTokens,
      completionTokens,
      custoUsd: estimarCustoChat(config.model, promptTokens, completionTokens),
    });

    return jsonResponse({
      ok: true,
      tools: toolsUsadas,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'jarvis_agent_error', message }));
    // Tenta avisar no WhatsApp em vez de deixar no vácuo. Se nem isso der,
    // o erro já está no log da função.
    try {
      await responderWhatsApp(admin, {
        orgId: body.org_id,
        phone: body.phone,
        zernioAccountId: body.zernio_account_id,
        texto: 'Deu erro aqui do meu lado e não consegui responder. O log tem o detalhe.',
      });
    } catch { /* já logado acima */ }
    return jsonResponse({ ok: false, error: message }, { status: 500 });
  }
});
