import { useCallback, useEffect, useState } from 'react';
import { getSupabase } from '@/lib/supabase';

// Item legado (coluna board_cards.checklist, jsonb) — mantido só pro tipo não
// quebrar em algo antigo que ainda referencie; a UI nova usa `checklists`.
export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface ChecklistItemRow {
  id: string;
  checklist_id: string;
  text: string;
  done: boolean;
  position: number;
}

export interface Checklist {
  id: string;
  card_id: string;
  title: string;
  position: number;
  items: ChecklistItemRow[];
}

export interface Attachment {
  id: string;
  card_id: string;
  name: string;
  url: string;
  kind: 'link' | 'file';
  added_by: string | null;
  created_at: string;
}

export type ActivityKind = 'comment' | 'move' | 'create' | 'archive' | 'unarchive' | 'field_change';

export interface ActivityItem {
  id: string;
  card_id: string;
  user_id: string | null;
  kind: ActivityKind;
  content: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

export interface Label {
  id: string;
  board_id: string;
  name: string | null;
  color: string;
  position: number;
}

export interface BoardCard {
  id: string;
  list_id: string;
  title: string;
  description: string | null;
  position: number;
  due_date: string | null;
  start_date: string | null;
  checklist: ChecklistItem[]; // legado — não usar em UI nova
  done: boolean;
  archived: boolean;
  cover_color: string | null;
  labelIds: string[];
  memberIds: string[];
  watcherIds: string[];
  checklists: Checklist[];
  attachments: Attachment[];
  activity: ActivityItem[];
}

export interface BoardList {
  id: string;
  board_id: string;
  name: string;
  position: number;
  archived: boolean;
}

export interface Board {
  id: string;
  name: string;
  description: string | null;
  position: number;
}

// Calcula a posição para inserir entre dois itens. Usar a média em float
// evita renumerar a coluna inteira a cada arraste — só o item movido muda.
export function positionBetween(antes: number | null, depois: number | null): number {
  if (antes == null && depois == null) return 1000;
  if (antes == null) return (depois as number) / 2;
  if (depois == null) return antes + 1000;
  return (antes + depois) / 2;
}

export function useBoards() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await getSupabase()
      .from('boards')
      .select('id, name, description, position')
      .eq('archived', false)
      .order('position');
    if (err) setError(err.message);
    else setBoards((data ?? []) as Board[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);
  return { boards, loading, error, reload: load, setBoards };
}

export function useBoardContent(boardId: string | null) {
  const [lists, setLists] = useState<BoardList[]>([]);
  const [cards, setCards] = useState<BoardCard[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!boardId) { setLists([]); setCards([]); setLabels([]); return; }
    setLoading(true);
    setError(null);
    const supabase = getSupabase();

    const [lRes, labRes] = await Promise.all([
      supabase.from('board_lists').select('id, board_id, name, position, archived')
        .eq('board_id', boardId).eq('archived', false).order('position'),
      supabase.from('board_labels').select('id, board_id, name, color, position')
        .eq('board_id', boardId).order('position'),
    ]);
    if (lRes.error) { setError(lRes.error.message); setLoading(false); return; }
    const listas = (lRes.data ?? []) as BoardList[];
    setLists(listas);
    setLabels((labRes.data ?? []) as Label[]);

    if (listas.length === 0) { setCards([]); setLoading(false); return; }
    const listIds = listas.map((x) => x.id);

    const cRes = await supabase
      .from('board_cards')
      .select('id, list_id, title, description, position, due_date, start_date, checklist, done, archived, cover_color')
      .in('list_id', listIds)
      .eq('archived', false)
      .order('position');
    if (cRes.error) { setError(cRes.error.message); setLoading(false); return; }
    const baseCards = (cRes.data ?? []) as Omit<BoardCard, 'labelIds' | 'memberIds' | 'watcherIds' | 'checklists' | 'attachments' | 'activity'>[];
    const cardIds = baseCards.map((c) => c.id);

    if (cardIds.length === 0) { setCards([]); setLoading(false); return; }

    const [clRes, cmRes, cwRes, chkRes, itemsRes, attRes, actRes] = await Promise.all([
      supabase.from('card_labels').select('card_id, label_id').in('card_id', cardIds),
      supabase.from('card_members').select('card_id, user_id').in('card_id', cardIds),
      supabase.from('card_watchers').select('card_id, user_id').in('card_id', cardIds),
      supabase.from('card_checklists').select('id, card_id, title, position').in('card_id', cardIds).order('position'),
      supabase.from('card_checklist_items').select('id, checklist_id, text, done, position').order('position'),
      supabase.from('card_attachments').select('id, card_id, name, url, kind, added_by, created_at').in('card_id', cardIds).order('created_at'),
      supabase.from('card_activity').select('id, card_id, user_id, kind, content, meta, created_at').in('card_id', cardIds).order('created_at', { ascending: false }),
    ]);

    const labelsByCard = new Map<string, string[]>();
    for (const r of (clRes.data ?? []) as Array<{ card_id: string; label_id: string }>) {
      (labelsByCard.get(r.card_id) ?? labelsByCard.set(r.card_id, []).get(r.card_id)!).push(r.label_id);
    }
    const membersByCard = new Map<string, string[]>();
    for (const r of (cmRes.data ?? []) as Array<{ card_id: string; user_id: string }>) {
      (membersByCard.get(r.card_id) ?? membersByCard.set(r.card_id, []).get(r.card_id)!).push(r.user_id);
    }
    const watchersByCard = new Map<string, string[]>();
    for (const r of (cwRes.data ?? []) as Array<{ card_id: string; user_id: string }>) {
      (watchersByCard.get(r.card_id) ?? watchersByCard.set(r.card_id, []).get(r.card_id)!).push(r.user_id);
    }
    const itemsByChecklist = new Map<string, ChecklistItemRow[]>();
    for (const r of (itemsRes.data ?? []) as ChecklistItemRow[]) {
      (itemsByChecklist.get(r.checklist_id) ?? itemsByChecklist.set(r.checklist_id, []).get(r.checklist_id)!).push(r);
    }
    const checklistsByCard = new Map<string, Checklist[]>();
    for (const r of (chkRes.data ?? []) as Array<Omit<Checklist, 'items'>>) {
      const withItems: Checklist = { ...r, items: itemsByChecklist.get(r.id) ?? [] };
      (checklistsByCard.get(r.card_id) ?? checklistsByCard.set(r.card_id, []).get(r.card_id)!).push(withItems);
    }
    const attachmentsByCard = new Map<string, Attachment[]>();
    for (const r of (attRes.data ?? []) as Attachment[]) {
      (attachmentsByCard.get(r.card_id) ?? attachmentsByCard.set(r.card_id, []).get(r.card_id)!).push(r);
    }
    const activityByCard = new Map<string, ActivityItem[]>();
    for (const r of (actRes.data ?? []) as ActivityItem[]) {
      (activityByCard.get(r.card_id) ?? activityByCard.set(r.card_id, []).get(r.card_id)!).push(r);
    }

    const merged: BoardCard[] = baseCards.map((c) => ({
      ...c,
      labelIds: labelsByCard.get(c.id) ?? [],
      memberIds: membersByCard.get(c.id) ?? [],
      watcherIds: watchersByCard.get(c.id) ?? [],
      checklists: checklistsByCard.get(c.id) ?? [],
      attachments: attachmentsByCard.get(c.id) ?? [],
      activity: activityByCard.get(c.id) ?? [],
    }));
    setCards(merged);
    setLoading(false);
  }, [boardId]);

  useEffect(() => { void load(); }, [load]);

  // Move um cartão de coluna/posição. Otimista — arrastar precisa parecer
  // instantâneo; reverte se o banco recusar.
  const moveCard = useCallback(
    async (cardId: string, destListId: string, novaPos: number) => {
      const anterior = cards;
      setCards((prev) =>
        prev.map((c) => (c.id === cardId ? { ...c, list_id: destListId, position: novaPos } : c)),
      );
      const { error: err } = await getSupabase()
        .from('board_cards')
        .update({ list_id: destListId, position: novaPos })
        .eq('id', cardId);
      if (err) {
        setCards(anterior);
        throw new Error(err.message);
      }
    },
    [cards],
  );

  // Reordena uma lista (drag do cabeçalho). Mesmo padrão otimista.
  const moveList = useCallback(
    async (listId: string, novaPos: number) => {
      const anterior = lists;
      setLists((prev) =>
        [...prev.map((l) => (l.id === listId ? { ...l, position: novaPos } : l))].sort((a, b) => a.position - b.position),
      );
      const { error: err } = await getSupabase().from('board_lists').update({ position: novaPos }).eq('id', listId);
      if (err) {
        setLists(anterior);
        throw new Error(err.message);
      }
    },
    [lists],
  );

  return { lists, cards, labels, loading, error, reload: load, setCards, setLists, setLabels, moveCard, moveList };
}

// Membros com acesso ao quadro. Lista vazia = quadro visível a todos (mesma
// regra das filas do Inbox). O reforço de verdade (RLS) ainda depende de ver
// as policies atuais de boards/board_lists/board_cards — por ora o filtro é
// feito no frontend (ver useVisibleBoards).
export function useBoardMembers(boardId: string | null) {
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!boardId) { setMemberIds([]); return; }
    setLoading(true);
    const { data } = await getSupabase()
      .from('board_members')
      .select('user_id')
      .eq('board_id', boardId);
    setMemberIds(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
    setLoading(false);
  }, [boardId]);

  useEffect(() => { void load(); }, [load]);

  const toggleMember = useCallback(
    async (userId: string) => {
      if (!boardId) return;
      const supabase = getSupabase();
      const tem = memberIds.includes(userId);
      const { error } = tem
        ? await supabase.from('board_members').delete().eq('board_id', boardId).eq('user_id', userId)
        : await supabase.from('board_members').insert({ board_id: boardId, user_id: userId });
      if (error) throw new Error(error.message);
      await load();
    },
    [boardId, memberIds, load],
  );

  return { memberIds, loading, toggleMember, reload: load };
}

// Todas as linhas de board_members do sistema, num Map<board_id, user_id[]>.
// Usado pra filtrar as abas de quadro no frontend: quadro sem entrada aqui é
// visível a todos; com entrada, só quem tá na lista (+ admin) enxerga.
export function useAllBoardMembers() {
  const [byBoard, setByBoard] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await getSupabase().from('board_members').select('board_id, user_id');
    const m = new Map<string, string[]>();
    for (const r of (data ?? []) as Array<{ board_id: string; user_id: string }>) {
      (m.get(r.board_id) ?? m.set(r.board_id, []).get(r.board_id)!).push(r.user_id);
    }
    setByBoard(m);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return { byBoard, loading, reload: load };
}
