// ============================================================================
// test-agent-profile  (chamada pela tela, NÃO por cron)
// ----------------------------------------------------------------------------
// Sandbox do agente. Dois modos:
//
//   mode: 'preview'  → devolve APENAS o prompt final montado
//                      (Base Global + modelo escolhido + variáveis). Zero
//                      chamada à IA, zero token.
//   mode: 'chat'     → chama a IA de verdade, com o MESMO modelo/temperatura/
//                      max_tokens do atendimento real, e devolve a resposta.
//
// GARANTIAS DE ISOLAMENTO (o ponto central desta função):
// Esta função é READ-ONLY sobre o domínio. Ela não escreve em nenhuma tabela
// operacional. Concretamente, ela NÃO:
//   · envia nada para WhatsApp/Instagram (não importa nenhum helper de envio)
//   · cria ou altera conversations / messages
//   · cria ou altera contacts, deals, tags, visitas
//   · executa handoff real (não toca em conversations.status)
//   · muda qual modelo está ativo
//   · dispara automação, webhook ou qualquer ação externa
//
// Marcadores que a IA emitir ([HANDOFF], [MEDIA:x]) são DETECTADOS e devolvidos
// como metadados para a tela desenhar "o que aconteceria" — nunca executados.
// Por isso o texto é analisado aqui, mas nada é acionado.
//
// O histórico da conversa de teste vem no corpo da requisição (o cliente
// mantém o estado); nada é persistido entre chamadas.
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { callLLM, type LLMProvider } from '../_shared/llm.ts';
import { buildSystemPrompt, loadProfileById, loadActiveProfile } from '../_shared/agent-prompt.ts';

interface TestRequest {
  mode: 'preview' | 'chat';
  profile_id?: string | null;
  message?: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

interface AgentConfigRow {
  system_prompt: string | null;
  guardrails_prompt: string | null;
  temperature: number | null;
  max_tokens: number | null;
  model: string | null;
  timezone: string | null;
  variables: Record<string, string> | null;
}

// Detecta os marcadores SEM executá-los. Devolve o texto limpo (como o contato
// veria) e o que teria sido acionado em produção.
// Reconhece [HANDOFF] em QUALQUER posição — o modelo costuma emitir no fim da
// frase, não em linha própria (mesma correção aplicada no process-ai-message).
function inspectMarkers(reply: string): {
  text: string;
  wouldHandoff: boolean;
  wouldSendMedia: string[];
  wouldClose: boolean;
} {
  const wouldSendMedia: string[] = [];
  let text = reply.replace(/\[media:\s*([a-z0-9_-]+)\s*\]/gi, (_w, label: string) => {
    wouldSendMedia.push(String(label).toLowerCase());
    return '';
  });
  const wouldHandoff = /\[\s*handoff\s*\]/i.test(text);
  const wouldClose = /\[\s*encerrar\s*\]/i.test(text) && !wouldHandoff;
  text = text
    .replace(/\[\s*handoff\s*\]/gi, '')
    .replace(/\[\s*encerrar\s*\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { text, wouldHandoff, wouldSendMedia, wouldClose };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  // Autenticação: exige um JWT de usuário logado e resolve a org a partir dele
  // (não aceita org_id vindo do corpo — senão daria para espiar outra org).
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ ok: false, error: 'Não autenticado.' }, { status: 401 });

  const admin = getAdminClient();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return jsonResponse({ ok: false, error: 'Sessão inválida.' }, { status: 401 });
  }
  const meta = (userData.user.app_metadata ?? {}) as Record<string, unknown>;
  const orgId = typeof meta.org_id === 'string' ? meta.org_id : null;
  const role = typeof meta.role === 'string' ? meta.role : null;
  if (!orgId) return jsonResponse({ ok: false, error: 'Usuário sem organização.' }, { status: 403 });
  if (role !== 'admin') {
    return jsonResponse({ ok: false, error: 'Apenas admin pode testar modelos.' }, { status: 403 });
  }

  let body: TestRequest;
  try {
    body = (await req.json()) as TestRequest;
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
  }
  const mode = body.mode === 'chat' ? 'chat' : 'preview';

  const { data: cfgRow } = await admin
    .from('ai_agent_config')
    .select('system_prompt, guardrails_prompt, temperature, max_tokens, model, timezone, variables')
    .eq('org_id', orgId)
    .maybeSingle();
  const cfg = (cfgRow as AgentConfigRow | null) ?? null;

  // Modelo a testar: o informado (pode ser RASCUNHO) ou, sem id, o ativo.
  const profile = body.profile_id
    ? await loadProfileById(admin, orgId, body.profile_id)
    : await loadActiveProfile(admin, orgId);
  if (body.profile_id && !profile) {
    return jsonResponse({ ok: false, error: 'Modelo não encontrado.' }, { status: 404 });
  }

  // Mídias: listadas só para compor {midias_disponiveis} no prompt. Nenhuma
  // é enviada em modo de teste.
  const { data: mediaRows } = await admin
    .from('ai_agent_media')
    .select('label, content_type, usage_note')
    .eq('org_id', orgId);
  const mediaList = (mediaRows ?? []) as Array<{
    label: string; content_type: string; usage_note: string | null;
  }>;
  const midiasDisponiveis = mediaList.length
    ? mediaList
        .map((m) => `[MEDIA:${m.label}] (${m.content_type})${m.usage_note ? ' — ' + m.usage_note : ''}`)
        .join('; ')
    : 'nenhuma';

  // Variáveis de runtime que dependem da conversa real recebem valores
  // explicitamente rotulados como simulados — assim fica claro na tela que
  // aquele trecho vai variar em produção.
  const vars: Record<string, string> = {
    ...(cfg?.variables ?? {}),
    nome_do_contato: 'Contato de teste',
    agora: new Date().toLocaleString('pt-BR', { timeZone: cfg?.timezone ?? 'America/Rio_Branco' }),
    dentro_do_horario: 'sim (simulado no modo de teste)',
    horario_atendimento: '(horário real configurado em Horário de atendimento)',
    mensagem_fora_horario: '(mensagem real configurada em Horário de atendimento)',
    midias_disponiveis: midiasDisponiveis,
  };

  const systemPrompt = buildSystemPrompt({
    guardrails: cfg?.guardrails_prompt ?? null,
    profileBody: profile?.body ?? null,
    legacySystemPrompt: cfg?.system_prompt ?? null,
    vars,
  });

  // Placeholders que ficaram sem valor — sinalizados para a tela avisar antes
  // de o admin ativar um modelo pela metade.
  const unresolved = [...new Set(
    (systemPrompt.match(/\{[a-z0-9_]+\}/gi) ?? []).map((m) => m.slice(1, -1).toLowerCase()),
  )];

  const profileInfo = profile
    ? { id: profile.id, name: profile.name, status: profile.status, is_active: profile.is_active }
    : null;

  if (mode === 'preview') {
    return jsonResponse({
      ok: true,
      mode,
      profile: profileInfo,
      system_prompt: systemPrompt,
      unresolved_variables: unresolved,
      model: cfg?.model ?? null,
      temperature: cfg?.temperature ?? 0.7,
      max_tokens: cfg?.max_tokens ?? 1000,
    });
  }

  // ---- mode: 'chat' — chamada REAL à IA, sem nenhum efeito colateral ----
  const userMessage = (body.message ?? '').trim();
  if (!userMessage) {
    return jsonResponse({ ok: false, error: 'Mensagem de teste vazia.' }, { status: 400 });
  }

  const creds = await loadAppCredentials(orgId);
  // Mesmo provider/chave do atendimento real — testar em outro provider
  // invalidaria o teste.
  const llmProvider = creds.llm_provider as LLMProvider;
  const llmKey = creds.llm_api_key?.trim();
  if (!llmKey) {
    return jsonResponse(
      { ok: false, error: 'Chave da IA não configurada. Configure em Agente de IA.' },
      { status: 400 },
    );
  }

  // Histórico vem do cliente — nada é lido nem gravado em conversations.
  const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
  const userPrompt = [
    ...history.map((h) => `${h.role === 'user' ? 'Contato' : 'Você'}: ${h.content}`),
    `Contato: ${userMessage}`,
  ].join('\n');

  let reply: string;
  try {
    const result = await callLLM({
      provider: llmProvider,
      apiKey: llmKey,
      model: cfg?.model ?? undefined,
      systemPrompt,
      userPrompt,
      temperature: cfg?.temperature ?? 0.7,
      maxTokens: cfg?.max_tokens ?? 1000,
    });
    reply = result.content.trim();
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `llm: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }

  const inspected = inspectMarkers(reply);

  return jsonResponse({
    ok: true,
    mode,
    profile: profileInfo,
    reply: inspected.text,
    raw_reply: reply,
    // O que ACONTECERIA em produção — apenas informativo, nada foi executado.
    simulated_actions: {
      handoff: inspected.wouldHandoff,
      media: inspected.wouldSendMedia,
      close: inspected.wouldClose,
    },
    unresolved_variables: unresolved,
    model: cfg?.model ?? null,
  });
});
