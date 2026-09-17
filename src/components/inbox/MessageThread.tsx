import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, CheckCheck, Clock, FileText, Loader2, Smartphone, StickyNote, User } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { getSupabase } from '@/lib/supabase';
import { ImageLightbox } from './ImageLightbox';
import { useAuth } from '@/app/providers/AuthProvider';
import type { Message } from '@/types/inbox';
import type { ThreadMessage } from '@/hooks/useMessages';

// URLs de mídia inbound apontam para a API do Zernio e exigem Bearer — o
// browser não tem a key, então passam pelo proxy autenticado /api/zernio-media
// (valida a sessão via `t`). URLs de upload-direct do operador são públicas e
// seguem diretas.
function resolveMediaUrl(url: string, accessToken: string | null): string {
  if (!accessToken) return url;
  if (!/^https:\/\/zernio\.com\/api\/v1\//i.test(url)) return url;
  return `/api/zernio-media?url=${encodeURIComponent(url)}&t=${encodeURIComponent(accessToken)}`;
}

interface MessageThreadProps {
  messages: ThreadMessage[];
  loading: boolean;
  onRetry?: (tempId: string) => void;
  onDismiss?: (tempId: string) => void;
}

function StatusTicks({ status }: { status: Message['meta_status'] }) {
  if (!status) return null;
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1 font-semibold text-[#FCA5A5] text-[10px]">
        <AlertCircle className="h-3 w-3" />
        não entregue
      </span>
    );
  }
  if (status === 'read') return <CheckCheck className="h-3 w-3 text-[#0E9AA0]" />;
  if (status === 'delivered') return <CheckCheck className="h-3 w-3 opacity-60" />;
  return <Check className="h-3 w-3 opacity-60" />;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Chave do dia local (não UTC) — usada para decidir onde inserir o separador.
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function formatDayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (dayKey(iso) === dayKey(today.toISOString())) return 'Hoje';
  if (dayKey(iso) === dayKey(yesterday.toISOString())) return 'Ontem';

  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString('pt-BR', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

function DateSeparator({ iso }: { iso: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="h-px flex-1 bg-[var(--color-border-card)]" />
      <span className="rounded-full border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
        {formatDayLabel(iso)}
      </span>
      <div className="h-px flex-1 bg-[var(--color-border-card)]" />
    </div>
  );
}

function SenderIcon({ sender }: { sender: Message['sender_type'] }) {
  if (sender === 'ai') return <Bot className="h-3.5 w-3.5" />;
  if (sender === 'owner') return <Smartphone className="h-3.5 w-3.5" />;
  if (sender === 'operator') return <User className="h-3.5 w-3.5" />;
  return null;
}

const MEDIA_LABEL: Record<string, string> = {
  image: 'Imagem',
  audio: 'Áudio',
  video: 'Vídeo',
  document: 'Documento',
};

const MEDIA_RECEIVED: Record<string, string> = {
  image: 'Imagem recebida',
  audio: 'Áudio recebido',
  video: 'Vídeo recebido',
  document: 'Documento recebido',
};

// Renderiza mídia quando `media_url` já é uma URL http(s). No modelo Zernio,
// tanto a mídia inbound (URL do attachment no webhook) quanto a outbound do
// operador (URL do /media/upload-direct) chegam já como URL — o placeholder
// abaixo só aparece em linhas antigas sem URL resolvida.
function MediaContent({ message }: { message: Message }) {
  const { session } = useAuth();
  const rawUrl = message.media_url ?? '';
  const url = resolveMediaUrl(rawUrl, session?.access_token ?? null);
  const isHttp = /^https?:\/\//i.test(rawUrl);
  const label = MEDIA_LABEL[message.content_type] ?? 'Mídia';
  const caption = message.content?.trim();

  if (isHttp) {
    if (message.content_type === 'image') {
      return <ImageContent url={url} alt={caption || label} caption={caption} />;
    }
    if (message.content_type === 'audio') {
      // A transcrição do áudio é gravada no próprio `content` pela função
      // transcribe-audio. Antes o player era retornado sozinho e o texto era
      // descartado — o operador tinha que ouvir cada áudio, mesmo já existindo
      // a transcrição pronta no banco.
      return <AudioContent message={message} url={url} caption={caption} />;
    }
    if (message.content_type === 'video') {
      return <video controls src={url} className="max-h-64 rounded-lg" />;
    }
    // Documento/arquivo: cartão em vez de link solto — dá alvo de clique
    // maior e deixa claro que é anexo, não texto da conversa.
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-lg border border-current/20 bg-black/10 px-2.5 py-2 transition hover:bg-black/20"
      >
        <FileText className="h-4 w-4 shrink-0 opacity-80" />
        <span className="min-w-0 flex-1 truncate text-sm">{caption || label}</span>
        <span className="shrink-0 text-[0.65rem] uppercase tracking-wide opacity-60">abrir</span>
      </a>
    );
  }

  // Sem URL resolvida — placeholder informativo (ver débito técnico: pipeline
  // de download de mídia da Meta ainda não implementado).
  const received = MEDIA_RECEIVED[message.content_type] ?? 'Mídia recebida';
  return (
    <div className="italic opacity-80">
      {received}
      {caption ? `: ${caption}` : ' — visualização indisponível nesta versão.'}
    </div>
  );
}


// Áudio + transcrição. A transcrição vem pronta no `content` (gravada pela
// função transcribe-audio). Quando ela falhou — o texto começa com
// "[áudio · transcrição falhou" — mostramos um botão para tentar de novo, em
// vez de deixar o operador sem alternativa a ouvir.

// Imagem da conversa: miniatura clicável que abre em tela cheia.
// Muito documento chega como foto (contrato, comprovante, título) e na
// miniatura não dá para ler — que é o motivo de o operador abrir.
function ImageContent({ url, alt, caption }: { url: string; alt: string; caption?: string }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="space-y-1">
      <img
        src={url}
        alt={alt}
        loading="lazy"
        onClick={() => setAberto(true)}
        className="max-h-64 cursor-zoom-in rounded-lg transition hover:brightness-110"
      />
      {caption && <div className="whitespace-pre-wrap break-words">{caption}</div>}
      {aberto && <ImageLightbox src={url} alt={alt} onClose={() => setAberto(false)} />}
    </div>
  );
}

function AudioContent({
  message,
  url,
  caption,
}: {
  message: Message;
  url: string;
  caption?: string;
}) {
  const { session } = useAuth();
  const [texto, setTexto] = useState<string | undefined>(caption);
  const [transcrevendo, setTranscrevendo] = useState(false);

  useEffect(() => setTexto(caption), [caption]);

  const falhou = !texto || /^\[[áa]udio\b/i.test(texto);

  const transcrever = async () => {
    if (transcrevendo || !session) return;
    setTranscrevendo(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1/transcribe-audio`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message_id: message.id }),
        },
      );
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.error ?? 'falha na transcrição');
      // A função grava no banco; relemos a linha para pegar o texto final.
      const { data: row } = await getSupabase()
        .from('messages')
        .select('content')
        .eq('id', message.id)
        .maybeSingle();
      const novo = (row as { content: string | null } | null)?.content ?? null;
      if (novo && !/^\[[áa]udio\b/i.test(novo)) {
        setTexto(novo);
        toast.success('Áudio transcrito.');
      } else {
        toast.error('Não consegui transcrever este áudio.');
      }
    } catch (err) {
      toast.error('Não consegui transcrever.', {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setTranscrevendo(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <audio controls src={url} className="max-w-full" />
      {!falhou && (
        <div className="rounded-lg bg-black/15 px-2 py-1.5 text-[0.8rem] leading-snug">
          <div className="mb-0.5 flex items-center gap-1 text-[0.65rem] uppercase tracking-wide opacity-70">
            <FileText className="h-3 w-3" /> Transcrição
          </div>
          <div className="whitespace-pre-wrap break-words">{texto}</div>
        </div>
      )}
      {falhou && (
        <button
          type="button"
          onClick={() => void transcrever()}
          disabled={transcrevendo}
          className="inline-flex items-center gap-1 rounded-lg bg-black/15 px-2 py-1 text-[0.7rem] hover:bg-black/25 disabled:opacity-60"
        >
          {transcrevendo ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
          {transcrevendo ? 'Transcrevendo...' : 'Transcrever áudio'}
        </button>
      )}
    </div>
  );
}

function FailedActions({
  tempId,
  onRetry,
  onDismiss,
  inverse,
}: {
  tempId: string;
  onRetry?: (tempId: string) => void;
  onDismiss?: (tempId: string) => void;
  inverse?: boolean;
}) {
  // inverse=true → dentro do balão azul (texto claro); senão card claro.
  const base = inverse ? 'text-white/90' : 'text-[var(--color-error)]';
  return (
    <div className={cn('mt-1 flex items-center gap-2 text-[10px]', base)}>
      <span className="font-semibold">Não enviou.</span>
      <button type="button" onClick={() => onRetry?.(tempId)} className="underline hover:opacity-80">
        Reenviar
      </button>
      <button type="button" onClick={() => onDismiss?.(tempId)} className="underline opacity-70 hover:opacity-100">
        Descartar
      </button>
    </div>
  );
}

export function MessageThread({ messages, loading, onRetry, onDismiss }: MessageThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Auto-scroll to newest message. Setting block to 'end' and using a ref
    // target below the last bubble avoids fighting with user scroll-up.
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-label opacity-60">Carregando mensagens...</div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-label opacity-60">Nenhuma mensagem nesta conversa.</div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-3">
      {messages.map((m, i) => {
        const showDate = i === 0 || dayKey(m.created_at) !== dayKey(messages[i - 1].created_at);
        const separator = showDate ? <DateSeparator iso={m.created_at} /> : null;
        const isNote = m.is_private_note;
        const isInbound = m.direction === 'inbound';
        // Anima só o que é novo: balão otimista em envio ou linha recém-criada
        // (< 4s). Mensagens antigas montam sem animação → carregamento limpo.
        // A key é estável (`_key`) para a troca otimista→real não re-animar.
        const isFresh =
          m._state === 'pending' || Date.now() - new Date(m.created_at).getTime() < 4000;

        if (isNote) {
          // Internal note — no bubble alignment; full-width yellow-tinted card.
          return (
            <div key={m._key ?? m.id}>
              {separator}
            <div
              className={cn(
                'mx-auto max-w-[85%] rounded-lg border border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.06)] p-3',
                m._state === 'pending' && 'opacity-70',
                isFresh && 'message-in',
              )}
            >
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[#FBBF24] mb-1">
                <StickyNote className="h-3 w-3" />
                Nota privada entre operadores
                <span className="ml-auto opacity-70 inline-flex items-center gap-1">
                  {m._state === 'pending' && <Clock className="h-3 w-3 animate-pulse" />}
                  {formatTime(m.created_at)}
                </span>
              </div>
              <div className="text-sm text-[var(--color-text-primary)] whitespace-pre-wrap break-words">
                {m.content}
              </div>
              {m._state === 'failed' && m._tempId && (
                <FailedActions tempId={m._tempId} onRetry={onRetry} onDismiss={onDismiss} />
              )}
            </div>
            </div>
          );
        }

        return (
          <div key={m._key ?? m.id}>
            {separator}
          <div
            className={cn('flex', isInbound ? 'justify-start' : 'justify-end', isFresh && 'message-in')}
          >
            <div
              className={cn(
                'max-w-[70%] rounded-2xl px-4 py-2.5 text-sm shadow-sm transition-opacity',
                isInbound
                  ? 'bg-[var(--color-surface-raised)] text-[var(--color-text-primary)] rounded-bl-md'
                  : m.sender_type === 'ai'
                    // AMAIA: contorno na cor de marca, fundo transparente —
                    // identidade própria sem virar mais uma caixa teal sólida
                    // igual ao operador humano (era a mesma cor pros dois).
                    ? 'border border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)] rounded-br-md'
                    : 'bg-[var(--accent-primary)] text-white rounded-br-md',
                m._state === 'pending' && 'opacity-70',
                (m._state === 'failed' || m.meta_status === 'failed') &&
                  'ring-1 ring-[var(--color-error)]',
              )}
            >
              {!isInbound && m.sender_type !== 'contact' && (
                <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70 mb-1">
                  <SenderIcon sender={m.sender_type} />
                  {m.sender_type === 'ai' ? 'AMAIA' : m.sender_type === 'owner' ? 'WhatsApp' : 'Operador'}
                </div>
              )}
              {m.content_type === 'text' || m.content_type === 'note' ? (
                <div className="whitespace-pre-wrap break-words">{m.content}</div>
              ) : m.content_type === 'template' ? (
                // Template é texto renderizado (body com variáveis já substituídas),
                // não mídia — exibe o conteúdo com um rótulo discreto de template.
                <div className="space-y-1">
                  <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide opacity-70">
                    <FileText className="h-3 w-3" />
                    Template
                  </div>
                  <div className="whitespace-pre-wrap break-words">{m.content}</div>
                </div>
              ) : (
                <MediaContent message={m} />
              )}
              {!isInbound && m.meta_status === 'failed' && m.error_reason && (
                <div className="mt-1.5 rounded-md bg-black/25 px-2 py-1.5 text-[11px] leading-snug text-[#FCA5A5]">
                  <span className="font-semibold">Motivo: </span>
                  {m.error_reason}
                </div>
              )}
              <div
                className={cn(
                  'flex items-center gap-1 text-[10px] mt-1 opacity-70',
                  isInbound ? 'justify-start' : 'justify-end',
                )}
              >
                <span>{formatTime(m.created_at)}</span>
                {!isInbound && m._state === 'pending' && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3 animate-pulse" /> enviando
                  </span>
                )}
                {!isInbound && m._state !== 'pending' && m._state !== 'failed' && (
                  <StatusTicks status={m.meta_status} />
                )}
              </div>
              {m._state === 'failed' && m._tempId && (
                <FailedActions tempId={m._tempId} onRetry={onRetry} onDismiss={onDismiss} inverse />
              )}
            </div>
          </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
