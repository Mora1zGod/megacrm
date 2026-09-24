import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react';
import { toast } from 'sonner';
import { AtSign, Loader2, Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import { CHAT_MAX_BYTES, formatBytes } from '@/lib/chatAttachments';

interface ChatComposerProps {
  // Participantes da sala — universo do autocomplete de menção.
  members: Operator[];
  disabled?: boolean;
  onSendText: (text: string, mentions: string[]) => Promise<boolean>;
  onSendFile: (file: File, caption?: string) => Promise<boolean>;
}

// Token de menção em digitação: um "@algo" grudado no fim do texto. Só o fim
// importa — é onde o cursor está enquanto a pessoa escreve.
const MENTION_AT_END = /(?:^|\s)@([\p{L}\p{N}._-]*)$/u;

export function ChatComposer({ members, disabled, onSendText, onSendFile }: ChatComposerProps) {
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Menções já escolhidas nesta redação: userId → rótulo inserido no texto.
  // No envio, só vale o que AINDA está escrito (a pessoa pode ter apagado).
  const chosen = useRef<Map<string, string>>(new Map());

  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionQuery = useMemo(() => {
    const m = MENTION_AT_END.exec(content);
    return m ? m[1].toLowerCase() : null;
  }, [content]);

  const mentionMatches = useMemo(() => {
    if (mentionQuery === null) return [];
    return members
      .filter((op) => operatorLabel(op).toLowerCase().includes(mentionQuery))
      .slice(0, 6);
  }, [mentionQuery, members]);

  const mentionOpen = mentionQuery !== null && mentionMatches.length > 0;
  useEffect(() => { setMentionIndex(0); }, [mentionQuery]);

  const applyMention = (op: Operator) => {
    const label = operatorLabel(op);
    setContent((prev) => {
      const m = MENTION_AT_END.exec(prev);
      if (!m) return prev;
      // m[0] pode começar com o espaço separador — preserva ele.
      const start = prev.length - m[0].length + (m[0].startsWith('@') ? 0 : 1);
      return `${prev.slice(0, start)}@${label} `;
    });
    chosen.current.set(op.user_id, label);
  };

  const onPickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f && f.size > CHAT_MAX_BYTES) {
      toast.error(`Arquivo excede ${formatBytes(CHAT_MAX_BYTES)}.`);
      e.target.value = '';
      return;
    }
    setFile(f);
  };

  const clearFile = () => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submit = async () => {
    if (disabled || sending) return;

    if (file) {
      setSending(true);
      const ok = await onSendFile(file, content.trim() || undefined);
      setSending(false);
      if (!ok) {
        toast.error('Falha ao enviar o anexo.');
        return;
      }
      clearFile();
      setContent('');
      chosen.current.clear();
      return;
    }

    const text = content.trim();
    if (!text) return;
    // Só menciona quem continua escrito na mensagem final.
    const mentions = [...chosen.current.entries()]
      .filter(([, label]) => text.includes(`@${label}`))
      .map(([userId]) => userId);
    setContent('');
    chosen.current.clear();
    await onSendText(text, mentions);
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applyMention(mentionMatches[mentionIndex]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-[var(--color-border-card)] p-4 space-y-3 glass-surface"
    >
      {file && (
        <div className="flex items-center gap-2 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-xs">
          <Paperclip className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
          <span className="truncate text-[var(--color-text-primary)]">{file.name}</span>
          <span className="text-[var(--color-text-secondary)]">{formatBytes(file.size)}</span>
          <button
            type="button"
            onClick={clearFile}
            className="ml-auto text-[var(--color-text-secondary)] hover:text-[var(--color-error)]"
            aria-label="Remover arquivo"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={onPickFile}
          disabled={disabled || sending}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending}
          aria-label="Anexar arquivo"
          title={`Anexar arquivo (máx ${formatBytes(CHAT_MAX_BYTES)})`}
        >
          <Paperclip className="h-4 w-4" />
        </Button>

        <div className="relative flex-1">
          {mentionOpen && (
            <div className="absolute bottom-[calc(100%+6px)] left-0 z-20 w-full max-w-sm rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1 shadow-lg">
              {mentionMatches.map((op, i) => (
                <button
                  key={op.user_id}
                  type="button"
                  // onMouseDown + preventDefault: o textarea não pode perder o
                  // foco, senão o cursor sai do lugar ao inserir a menção.
                  onMouseDown={(e) => { e.preventDefault(); applyMention(op); }}
                  className={
                    i === mentionIndex
                      ? 'flex w-full items-center gap-2 rounded-md bg-[var(--color-accent-subtle)] px-2.5 py-1.5 text-left'
                      : 'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--color-surface-hover)]'
                  }
                >
                  <Avatar src={op.avatar_url} name={operatorLabel(op)} size="sm" className="h-6 w-6 text-[10px]" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold text-[var(--color-text-primary)]">
                      {operatorLabel(op)}
                    </span>
                    <span className="block truncate text-[11px] text-[var(--color-text-secondary)]">
                      {op.email}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKey}
            rows={2}
            disabled={disabled || sending}
            placeholder={file ? 'Legenda (opcional)…' : 'Mensagem para a equipe… ("@" menciona alguém)'}
            className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)] resize-none"
          />
        </div>

        <Button
          type="submit"
          disabled={(!content.trim() && !file) || sending || disabled}
          aria-label="Enviar"
          title="Enviar"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          <span className="hidden sm:inline">Enviar</span>
        </Button>
      </div>

      <p className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)] opacity-70">
        <AtSign className="h-3 w-3" />
        Conversa interna da equipe — nada daqui é enviado ao contato.
      </p>
    </form>
  );
}
