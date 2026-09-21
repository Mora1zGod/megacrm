import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Film, Image as ImageIcon, Music, Paperclip, Search } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { Skeleton } from '@/components/ui/skeleton';
import type { ContentType } from '@/types/inbox';

interface FileRow {
  id: string;
  conversation_id: string;
  content_type: ContentType;
  content: string | null;
  media_url: string;
  created_at: string;
}

interface ContactInfo {
  name: string | null;
  phone: string | null;
}

const PAGE_SIZE = 40;

const TYPE_FILTERS: { id: ContentType | 'all'; label: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'image', label: 'Imagens' },
  { id: 'video', label: 'Vídeos' },
  { id: 'audio', label: 'Áudios' },
  { id: 'document', label: 'Documentos' },
];

function typeIcon(t: ContentType) {
  switch (t) {
    case 'image': return ImageIcon;
    case 'video': return Film;
    case 'audio': return Music;
    default: return FileText;
  }
}

function fileNameFromUrl(url: string): string {
  try {
    const clean = url.split('?')[0];
    return decodeURIComponent(clean.split('/').pop() || 'arquivo');
  } catch {
    return 'arquivo';
  }
}

// Biblioteca de todos os arquivos trocados nas conversas (imagem, áudio,
// vídeo, documento) — inspirado na "Lista de arquivos" de outros CRMs de
// WhatsApp. Sem tabela nova: consulta direto `messages.media_url`.
export default function FilesPage() {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [contacts, setContacts] = useState<Record<string, ContactInfo>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [typeFilter, setTypeFilter] = useState<ContentType | 'all'>('all');
  const [search, setSearch] = useState('');

  const loadPage = useCallback(async (offset: number, type: ContentType | 'all') => {
    const supabase = getSupabase();
    let query = supabase
      .from('messages')
      .select('id, conversation_id, content_type, content, media_url, created_at')
      .not('media_url', 'is', null)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (type !== 'all') query = query.eq('content_type', type);
    const { data, error } = await query;
    if (error) return { items: [] as FileRow[], error };
    return { items: (data ?? []) as FileRow[], error: null };
  }, []);

  const loadContactsFor = useCallback(async (items: FileRow[]) => {
    const convIds = [...new Set(items.map((r) => r.conversation_id))].filter(
      (id) => !(id in contacts),
    );
    if (convIds.length === 0) return;
    const supabase = getSupabase();
    const { data: convs } = await supabase
      .from('conversations')
      .select('id, contact_id')
      .in('id', convIds);
    const contactIds = [...new Set((convs ?? []).map((c) => (c as { contact_id: string }).contact_id))];
    if (contactIds.length === 0) return;
    const { data: people } = await supabase
      .from('contacts')
      .select('id, name, phone')
      .in('id', contactIds);
    const personById = new Map(
      (people ?? []).map((p) => [(p as { id: string }).id, p as unknown as ContactInfo & { id: string }]),
    );
    const patch: Record<string, ContactInfo> = {};
    for (const c of (convs ?? []) as { id: string; contact_id: string }[]) {
      const person = personById.get(c.contact_id);
      patch[c.id] = { name: person?.name ?? null, phone: person?.phone ?? null };
    }
    setContacts((prev) => ({ ...prev, ...patch }));
  }, [contacts]);

  useEffect(() => {
    setLoading(true);
    setRows([]);
    setHasMore(true);
    void (async () => {
      const { items } = await loadPage(0, typeFilter);
      setRows(items);
      setHasMore(items.length === PAGE_SIZE);
      setLoading(false);
      void loadContactsFor(items);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter]);

  const loadMore = async () => {
    setLoadingMore(true);
    const { items } = await loadPage(rows.length, typeFilter);
    setRows((prev) => [...prev, ...items]);
    setHasMore(items.length === PAGE_SIZE);
    setLoadingMore(false);
    void loadContactsFor(items);
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const contact = contacts[r.conversation_id];
      return (
        fileNameFromUrl(r.media_url).toLowerCase().includes(q)
        || (r.content ?? '').toLowerCase().includes(q)
        || (contact?.name ?? '').toLowerCase().includes(q)
        || (contact?.phone ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, contacts]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
          <Paperclip className="h-5 w-5 text-[var(--accent-primary)]" />
        </div>
        <div>
          <div className="text-label">Operação</div>
          <h1 className="text-2xl font-bold text-display">Arquivos</h1>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Toda imagem, áudio, vídeo e documento trocado nas conversas
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-text-secondary)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome do arquivo ou contato..."
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] pl-9 pr-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--accent-primary)]"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTypeFilter(t.id)}
              className={
                typeFilter === t.id
                  ? 'rounded-full bg-[var(--color-accent-subtle)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-primary)]'
                  : 'rounded-full border border-[rgba(14,154,160,0.2)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[rgba(148,163,184,0.25)] p-6 text-center text-sm text-[var(--color-text-secondary)]">
          <Paperclip className="mx-auto mb-2 h-6 w-6 opacity-50" />
          Nenhum arquivo encontrado.{' '}
          {search ? 'Tente outro termo de busca.' : 'Arquivos trocados nas conversas aparecem aqui.'}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const Icon = typeIcon(r.content_type);
            const contact = contacts[r.conversation_id];
            return (
              <a
                key={r.id}
                href={r.media_url}
                target="_blank"
                rel="noreferrer"
                className="glass-card flex items-center gap-3 p-3 transition hover:border-[var(--accent-primary)]"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-accent-subtle)]">
                  <Icon className="h-4.5 w-4.5 text-[var(--accent-primary)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">
                    {fileNameFromUrl(r.media_url)}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">
                    <Link
                      to={`/inbox?conversation=${r.conversation_id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="hover:underline"
                    >
                      {contact?.name || contact?.phone || 'Conversa'}
                    </Link>
                    <span>·</span>
                    <span>{new Date(r.created_at).toLocaleString('pt-BR')}</span>
                  </div>
                </div>
              </a>
            );
          })}
          {hasMore && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] py-2.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-60"
            >
              {loadingMore ? 'Carregando...' : 'Carregar mais'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
