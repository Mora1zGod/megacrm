// ============================================================================
// jarvis-agent/openai.ts — chamada OpenAI com tool calling + Whisper
// ----------------------------------------------------------------------------
// Por que não reusar _shared/llm.ts: aquele módulo é prompt→texto, sem suporte
// a tools (e mexer nele mudaria o caminho do AMAIA). Aqui fica o cliente com
// tool calling, isolado no Jarvis. A CREDENCIAL é a mesma (openai_api_key /
// llm_api_key de public.org_settings) — nenhuma chave nova.
// ============================================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatResult {
  message: ChatMessage;
  usage: Usage;
  finish_reason: string;
}

export async function chatWithTools(input: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools: unknown[];
  temperature?: number;
  maxTokens?: number;
}): Promise<ChatResult> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: input.model,
      temperature: input.temperature ?? 0.3,
      max_tokens: input.maxTokens ?? 900,
      messages: input.messages,
      tools: input.tools,
      tool_choice: 'auto',
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  const choice = body.choices?.[0];
  if (!choice) throw new Error('OpenAI devolveu resposta sem choices');
  return {
    message: choice.message as ChatMessage,
    finish_reason: choice.finish_reason ?? 'stop',
    usage: {
      prompt_tokens: body.usage?.prompt_tokens ?? 0,
      completion_tokens: body.usage?.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Whisper — mesma receita de supabase/functions/transcribe-audio/index.ts
// (o Jarvis não passa por messages, então não dá para reusar aquela função:
// ela trabalha a partir de uma linha de whatsapp_hub.messages).
// ---------------------------------------------------------------------------

export async function transcreverAudio(apiKey: string, mediaUrl: string): Promise<string> {
  const download = await fetch(mediaUrl);
  if (!download.ok) throw new Error(`download do áudio ${download.status}`);
  const blob = await download.blob();
  const mime = download.headers.get('content-type') ?? 'audio/ogg';
  const ext = mime.includes('mpeg') ? 'mp3'
    : mime.includes('wav') ? 'wav'
    : mime.includes('mp4') ? 'mp4'
    : 'ogg';

  const form = new FormData();
  form.append('file', blob, `audio.${ext}`);
  form.append('model', 'whisper-1');
  form.append('language', 'pt');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) throw new Error(`OpenAI whisper ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body?.text;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Whisper retornou texto vazio');
  return text.trim();
}
