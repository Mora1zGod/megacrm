// ============================================================================
// improve-message  (chamada pelo Inbox, botão "Melhorar")
// ----------------------------------------------------------------------------
// Reescreve o rascunho do OPERADOR aplicando o tom da marca (Base Global do
// agente) e corrigindo erros de digitação/pontuação — sem enviar nada.
// O operador revisa e decide.
//
// ISOLAMENTO: esta função é READ-ONLY. Ela NÃO envia mensagem, não escreve em
// messages/conversations, não muda status nem aciona automação. Só devolve
// texto para a tela substituir na caixa de digitação.
//
// Por que usa a Base Global e não um prompt solto: o operador escrevendo com a
// voz da AMAI e a AMAIA respondendo com outra voz criaria duas personalidades
// na mesma conversa. A fonte do tom é a mesma dos dois lados.
//
// O contexto das últimas mensagens entra para o texto fazer sentido na
// conversa (ex.: rascunho "pode sim" vira algo coerente com a pergunta feita).
// ============================================================================

import { getAdminClient } from '../_shared/supabase-admin.ts';
import { jsonResponse, preflight } from '../_shared/cors.ts';
import { loadAppCredentials } from '../_shared/tenant-credentials.ts';
import { callLLM, type LLMProvider } from '../_shared/llm.ts';

const HISTORY_LIMIT = 6;
const MAX_DRAFT_CHARS = 2000;

interface Body {
  conversation_id?: string;
  text?: string;
  // 'whatsapp' = mensagem ao cliente (tom da marca).
  // 'note' = nota interna (só clareza, sem tom comercial).
  kind?: 'whatsapp' | 'note';
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return jsonResponse({ ok: false, error: 'Não autenticado.' }, { status: 401 });

  const admin = getAdminClient();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return jsonResponse({ ok: false, error: 'Sessão inválida.' }, { status: 401 });
  }
  const meta = (userData.user.app_metadata ?? {}) as Record<string, unknown>;
  const orgId = typeof meta.org_id === 'string' ? meta.org_id : null;
  if (!orgId) return jsonResponse({ ok: false, error: 'Usuário sem organização.' }, { status: 403 });

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonResponse({ ok: false, error: 'JSON inválido.' }, { status: 400 });
  }

  const draft = (body.text ?? '').trim();
  if (!draft) return jsonResponse({ ok: false, error: 'Nada para melhorar.' }, { status: 400 });
  if (draft.length > MAX_DRAFT_CHARS) {
    return jsonResponse({ ok: false, error: 'Mensagem muito longa para melhorar.' }, { status: 400 });
  }
  const isNote = body.kind === 'note';

  // Contexto: últimas mensagens da conversa (se informada e da org do usuário).
  let contexto = '';
  if (body.conversation_id) {
    const { data: conv } = await admin
      .from('conversations')
      .select('id, contact_id')
      .eq('id', body.conversation_id)
      .eq('org_id', orgId)
      .maybeSingle();
    if (conv) {
      const { data: msgs } = await admin
        .from('messages')
        .select('content, direction, sender_type')
        .eq('conversation_id', body.conversation_id)
        .eq('is_private_note', false)
        .not('content', 'is', null)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT);
      const rows = ((msgs ?? []) as Array<{ content: string; direction: string; sender_type: string }>).reverse();
      if (rows.length > 0) {
        contexto = rows
          .map((m) => `${m.direction === 'inbound' ? 'Cliente' : 'Atendimento'}: ${m.content}`)
          .join('\n');
      }
    }
  }

  // Tom da marca: mesma Base Global usada pelo agente.
  const { data: cfgRow } = await admin
    .from('ai_agent_config')
    .select('guardrails_prompt, system_prompt, model, variables')
    .eq('org_id', orgId)
    .maybeSingle();
  const cfg = (cfgRow as {
    guardrails_prompt: string | null;
    system_prompt: string | null;
    model: string | null;
    variables: Record<string, string> | null;
  } | null) ?? null;

  const empresa = cfg?.variables?.nome_da_empresa ?? 'a empresa';
  const brandVoice = isNote ? '' : (cfg?.guardrails_prompt ?? cfg?.system_prompt ?? '').trim();

  const systemPrompt = isNote
    ? `Você reescreve NOTAS INTERNAS de atendimento. Corrija ortografia, pontuação e ` +
      `deixe o texto claro e objetivo para outro atendente entender depois. ` +
      `NÃO adicione saudação, emoji ou tom comercial — é nota interna, não vai para o cliente. ` +
      `Devolva APENAS o texto reescrito, sem aspas, sem comentários e sem explicações.`
    : `Você reescreve rascunhos de atendentes humanos de ${empresa} antes do envio ao cliente no WhatsApp.\n\n` +
      `REGRAS DA REESCRITA:\n` +
      `- Corrija ortografia, acentuação e pontuação.\n` +
      `- Aplique o tom da marca descrito abaixo.\n` +
      `- PRESERVE INTEGRALMENTE o sentido e a decisão do atendente. Se ele disse "não", continua "não".\n` +
      `- NUNCA invente informação que não esteja no rascunho: nada de preço, data, prazo, ` +
      `benefício ou promessa que o atendente não escreveu.\n` +
      `- NÃO acrescente pergunta nova nem ofereça algo que ele não ofereceu.\n` +
      `- Mantenha curto. Se o rascunho é curto, a versão melhorada também é.\n` +
      `- No máximo 1 emoji, e só se combinar.\n` +
      `- Não escreva [HANDOFF] nem [MEDIA:...] — esses marcadores são só do agente automático.\n\n` +
      `Devolva APENAS o texto reescrito, sem aspas, sem comentários e sem explicações.\n\n` +
      `═══ TOM DA MARCA ═══\n${brandVoice.slice(0, 6000)}`;

  const userPrompt =
    (contexto ? `Conversa até agora:\n${contexto}\n\n` : '') +
    `Rascunho do atendente para reescrever:\n${draft}`;

  const creds = await loadAppCredentials(orgId);
  const llmKey = creds.llm_api_key?.trim();
  if (!llmKey) {
    return jsonResponse({ ok: false, error: 'Chave da IA não configurada.' }, { status: 400 });
  }

  try {
    const result = await callLLM({
      provider: creds.llm_provider as LLMProvider,
      apiKey: llmKey,
      model: cfg?.model ?? undefined,
      systemPrompt,
      userPrompt,
      temperature: 0.4, // baixa: reescrever, não recriar
      maxTokens: 600,
    });
    // Tira aspas que o modelo às vezes coloca em volta e qualquer marcador
    // que tenha escapado.
    const improved = result.content
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, '')
      .replace(/\[\s*handoff\s*\]/gi, '')
      .replace(/\[media:[^\]]*\]/gi, '')
      .trim();
    if (!improved) throw new Error('resposta vazia');
    return jsonResponse({ ok: true, original: draft, improved });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `llm: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
});
