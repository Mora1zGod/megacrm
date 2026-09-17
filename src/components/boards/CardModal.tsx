import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlignLeft, Archive, ArrowRightLeft, Calendar, CheckCircle2, CheckSquare, ChevronDown, Circle, Copy, Eye, EyeOff,
  Link as LinkIcon, MessageSquare, MoreHorizontal, Paperclip, Plus, Tag, Trash2, Upload, UserPlus, X,
} from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { Dialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/Avatar';
import { operatorLabel, type Operator } from '@/hooks/useOperators';
import { positionBetween, type Attachment, type BoardCard, type BoardList, type Label } from '@/hooks/useBoards';

const fieldCls =
  'w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';
const sectionLabel = 'flex items-center gap-1.5 text-label mb-1.5';

const LABEL_COLORS = ['#EF4444', '#F2B937', '#10B981', '#0E9AA0', '#60A5FA', '#A78BFA', '#F472B6', '#94A3B8'];

// Datetime-local <-> ISO. O input exige "YYYY-MM-DDTHH:mm" sem timezone.
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v: string): string | null {
  if (!v) return null;
  return new Date(v).toISOString();
}

interface CardModalProps {
  card: BoardCard;
  boardId: string;
  lists: BoardList[];
  labels: Label[];
  operators: Operator[];
  currentUserId: string | null;
  onClose: () => void;
  // Patch direto em board_cards (título, descrição, datas, done, list/position).
  onPatch: (patch: Record<string, unknown>) => Promise<void>;
  // Refaz a busca do quadro inteiro — usado após mexer em tabelas relacionadas
  // (etiquetas, membros, checklists, anexos, comentários).
  onReload: () => Promise<void>;
  onArchived: () => void;
  onDeleted: () => void;
}

export function CardModal({
  card, boardId, lists, labels, operators, currentUserId, onClose, onPatch, onReload, onArchived, onDeleted,
}: CardModalProps) {
  const [title, setTitle] = useState(card.title);
  const [editingTitle, setEditingTitle] = useState(false);
  const [description, setDescription] = useState(card.description ?? '');
  const [labelPickerOpen, setLabelPickerOpen] = useState(false);
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [novoComentario, setNovoComentario] = useState('');
  const [novoAnexoUrl, setNovoAnexoUrl] = useState('');
  const [novoAnexoNome, setNovoAnexoNome] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [datesOpen, setDatesOpen] = useState(Boolean(card.due_date || card.start_date));

  const supabase = getSupabase();
  const cardLabels = card.labelIds.map((id) => labels.find((l) => l.id === id)).filter(Boolean) as Label[];
  const members = card.memberIds.map((id) => operators.find((o) => o.user_id === id)).filter(Boolean) as Operator[];
  const isWatching = currentUserId ? card.watcherIds.includes(currentUserId) : false;
  const currentList = lists.find((l) => l.id === card.list_id);

  const salvarTitulo = async () => {
    setEditingTitle(false);
    const t = title.trim();
    if (!t || t === card.title) { setTitle(card.title); return; }
    await onPatch({ title: t });
  };

  const salvarDescricao = async () => {
    const d = description.trim() || null;
    if (d === card.description) return;
    await onPatch({ description: d });
  };

  // ---- Etiquetas --------------------------------------------------------
  const toggleLabel = async (labelId: string) => {
    const tem = card.labelIds.includes(labelId);
    const { error } = tem
      ? await supabase.from('card_labels').delete().eq('card_id', card.id).eq('label_id', labelId)
      : await supabase.from('card_labels').insert({ card_id: card.id, label_id: labelId });
    if (error) { toast.error('Não consegui atualizar a etiqueta.', { description: error.message }); return; }
    await onReload();
  };

  const criarEtiqueta = async (color: string) => {
    const { error } = await supabase.from('board_labels').insert({
      board_id: boardId,
      color,
      position: Date.now(),
    });
    if (error) { toast.error('Não consegui criar a etiqueta.', { description: error.message }); return; }
    await onReload();
  };

  const renomearEtiqueta = async (labelId: string, name: string) => {
    const { error } = await supabase.from('board_labels').update({ name: name.trim() || null }).eq('id', labelId);
    if (error) { toast.error('Não consegui renomear.', { description: error.message }); return; }
    await onReload();
  };

  // ---- Membros e observador ----------------------------------------------
  const toggleMember = async (userId: string) => {
    const tem = card.memberIds.includes(userId);
    const { error } = tem
      ? await supabase.from('card_members').delete().eq('card_id', card.id).eq('user_id', userId)
      : await supabase.from('card_members').insert({ card_id: card.id, user_id: userId });
    if (error) { toast.error('Não consegui atualizar.', { description: error.message }); return; }
    await onReload();
  };

  const toggleWatch = async () => {
    if (!currentUserId) return;
    const { error } = isWatching
      ? await supabase.from('card_watchers').delete().eq('card_id', card.id).eq('user_id', currentUserId)
      : await supabase.from('card_watchers').insert({ card_id: card.id, user_id: currentUserId });
    if (error) { toast.error('Não consegui atualizar.', { description: error.message }); return; }
    await onReload();
  };

  // ---- Checklists ---------------------------------------------------------
  const addChecklist = async () => {
    const { error } = await supabase.from('card_checklists').insert({ card_id: card.id, title: 'Checklist', position: Date.now() });
    if (error) { toast.error('Não consegui criar o checklist.', { description: error.message }); return; }
    await onReload();
  };

  const renameChecklist = async (checklistId: string, title2: string) => {
    if (!title2.trim()) return;
    const { error } = await supabase.from('card_checklists').update({ title: title2.trim() }).eq('id', checklistId);
    if (error) { toast.error('Não consegui renomear.', { description: error.message }); return; }
    await onReload();
  };

  const deleteChecklist = async (checklistId: string) => {
    if (!confirm('Excluir este checklist e todos os itens?')) return;
    const { error } = await supabase.from('card_checklists').delete().eq('id', checklistId);
    if (error) { toast.error('Não consegui excluir.', { description: error.message }); return; }
    await onReload();
  };

  const addItem = async (checklistId: string, text: string) => {
    if (!text.trim()) return;
    const { error } = await supabase.from('card_checklist_items').insert({ checklist_id: checklistId, text: text.trim(), position: Date.now() });
    if (error) { toast.error('Não consegui adicionar.', { description: error.message }); return; }
    await onReload();
  };

  const toggleItem = async (itemId: string, done: boolean) => {
    const { error } = await supabase.from('card_checklist_items').update({ done }).eq('id', itemId);
    if (error) { toast.error('Não consegui atualizar.', { description: error.message }); return; }
    await onReload();
  };

  const deleteItem = async (itemId: string) => {
    const { error } = await supabase.from('card_checklist_items').delete().eq('id', itemId);
    if (error) { toast.error('Não consegui remover.', { description: error.message }); return; }
    await onReload();
  };

  // ---- Anexos ---------------------------------------------------------------
  const addLinkAttachment = async () => {
    const url = novoAnexoUrl.trim();
    if (!url) return;
    const name = novoAnexoNome.trim() || url;
    const { error } = await supabase.from('card_attachments').insert({
      card_id: card.id, name, url, kind: 'link', added_by: currentUserId,
    });
    if (error) { toast.error('Não consegui anexar.', { description: error.message }); return; }
    setNovoAnexoUrl(''); setNovoAnexoNome('');
    await onReload();
  };

  const uploadFileAttachment = async (file: File) => {
    setUploading(true);
    const path = `${card.id}/${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from('card-attachments').upload(path, file);
    if (upErr) {
      setUploading(false);
      toast.error('Não consegui subir o arquivo.', { description: upErr.message });
      return;
    }
    const { data: pub } = supabase.storage.from('card-attachments').getPublicUrl(path);
    const { error } = await supabase.from('card_attachments').insert({
      card_id: card.id, name: file.name, url: pub.publicUrl, kind: 'file', added_by: currentUserId,
    });
    setUploading(false);
    if (error) { toast.error('Não consegui salvar o anexo.', { description: error.message }); return; }
    await onReload();
  };

  const removeAttachment = async (att: Attachment) => {
    if (!confirm(`Remover o anexo "${att.name}"?`)) return;
    if (att.kind === 'file') {
      // Extrai o path relativo ao bucket a partir da URL pública.
      const marker = '/card-attachments/';
      const idx = att.url.indexOf(marker);
      if (idx >= 0) {
        await supabase.storage.from('card-attachments').remove([att.url.slice(idx + marker.length)]);
      }
    }
    const { error } = await supabase.from('card_attachments').delete().eq('id', att.id);
    if (error) { toast.error('Não consegui remover.', { description: error.message }); return; }
    await onReload();
  };

  // ---- Atividade / comentários ----------------------------------------------
  const enviarComentario = async () => {
    const texto = novoComentario.trim();
    if (!texto) return;
    const { error } = await supabase.from('card_activity').insert({
      card_id: card.id, user_id: currentUserId, kind: 'comment', content: texto,
    });
    if (error) { toast.error('Não consegui comentar.', { description: error.message }); return; }
    setNovoComentario('');
    await onReload();
  };

  const operatorName = (userId: string | null) => {
    if (!userId) return 'Alguém';
    const op = operators.find((o) => o.user_id === userId);
    return op ? operatorLabel(op) : 'Alguém';
  };

  // ---- Ações ------------------------------------------------------------------
  const alternarFeito = async () => {
    await onPatch({ done: !card.done });
  };

  const arquivar = async () => {
    setBusy(true);
    await supabase.from('card_activity').insert({ card_id: card.id, user_id: currentUserId, kind: 'archive', content: null });
    const { error } = await supabase.from('board_cards').update({ archived: true }).eq('id', card.id);
    setBusy(false);
    if (error) { toast.error('Não consegui arquivar.', { description: error.message }); return; }
    toast.success('Cartão arquivado.');
    onArchived();
  };

  const excluir = async () => {
    if (!confirm(`Excluir "${card.title}" definitivamente? Não tem como desfazer.`)) return;
    const { error } = await supabase.from('board_cards').delete().eq('id', card.id);
    if (error) { toast.error('Não consegui excluir.', { description: error.message }); return; }
    onDeleted();
  };

  const copiarCartao = async () => {
    setBusy(true);
    const { error } = await supabase.from('board_cards').insert({
      list_id: card.list_id,
      title: `${card.title} (cópia)`,
      description: card.description,
      due_date: card.due_date,
      start_date: card.start_date,
      position: positionBetween(card.position, null),
    });
    setBusy(false);
    if (error) { toast.error('Não consegui copiar.', { description: error.message }); return; }
    toast.success('Cartão copiado.');
    await onReload();
  };

  const moverPara = async (listId: string) => {
    setMovePickerOpen(false);
    if (listId === card.list_id) return;
    await onPatch({ list_id: listId, position: Date.now() });
    await supabase.from('card_activity').insert({
      card_id: card.id, user_id: currentUserId, kind: 'move',
      content: `Movido para "${lists.find((l) => l.id === listId)?.name ?? '—'}"`,
    });
    await onReload();
  };

  return (
    <Dialog open onClose={onClose} widthClass="max-w-3xl">
      <div className="space-y-5 pr-2">
        {/* Breadcrumb da lista + ações */}
        <div className="flex items-center justify-between gap-2 pr-8">
          <div className="relative">
            <button
              type="button"
              onClick={() => setListPickerOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]"
            >
              {currentList?.name ?? '—'}
              <ChevronDown className="h-3 w-3" />
            </button>
            {listPickerOpen && (
              <div className="absolute left-0 top-full mt-1 w-52 rounded-lg border border-[rgba(14,154,160,0.25)] bg-[#0F1223] p-1 shadow-lg z-10">
                {lists.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => { setListPickerOpen(false); void moverPara(l.id); }}
                    className={cn(
                      'w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5',
                      l.id === card.list_id ? 'text-[var(--accent-primary)] font-semibold' : 'text-[var(--color-text-primary)]',
                    )}
                  >
                    {l.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => void toggleWatch()}
              title={isWatching ? 'Parar de observar' : 'Observar este cartão'}
              className={cn(
                'h-7 w-7 flex items-center justify-center rounded-md',
                isWatching ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {isWatching ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => setActionsOpen((v) => !v)}
                aria-label="Mais ações"
                className="h-7 w-7 flex items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-white/5 hover:text-[var(--color-text-primary)]"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
              {actionsOpen && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-lg border border-[rgba(14,154,160,0.25)] bg-[#0F1223] p-1 shadow-lg z-10">
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); void alternarFeito(); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-primary)] hover:bg-white/5"
                  >
                    <CheckSquare className="h-3.5 w-3.5" /> {card.done ? 'Reabrir cartão' : 'Marcar concluído'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); setListPickerOpen(true); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-primary)] hover:bg-white/5"
                  >
                    <ArrowRightLeft className="h-3.5 w-3.5" /> Mover
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); void copiarCartao(); }}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-primary)] hover:bg-white/5"
                  >
                    <Copy className="h-3.5 w-3.5" /> Copiar
                  </button>
                  <div className="my-1 border-t border-[rgba(14,154,160,0.15)]" />
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); void arquivar(); }}
                    disabled={busy}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[var(--color-text-primary)] hover:bg-white/5"
                  >
                    <Archive className="h-3.5 w-3.5" /> Arquivar
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActionsOpen(false); void excluir(); }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-[#EF4444] hover:bg-white/5"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Excluir
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Título */}
        <div className="flex items-start gap-2 -mt-2">
          <button
            type="button"
            onClick={() => void alternarFeito()}
            title={card.done ? 'Reabrir cartão' : 'Marcar concluído'}
            className="mt-1 shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--accent-primary)]"
          >
            {card.done ? <CheckCircle2 className="h-5 w-5 text-[var(--color-success)]" /> : <Circle className="h-5 w-5" />}
          </button>
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => void salvarTitulo()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { setTitle(card.title); setEditingTitle(false); }
                }}
                className="w-full rounded-lg border border-[var(--accent-primary)] bg-white/[0.03] px-2 py-1 text-lg font-bold text-display text-[var(--color-text-primary)]"
              />
            ) : (
              <h2
                onClick={() => setEditingTitle(true)}
                className={cn('cursor-text rounded-lg px-2 py-1 -mx-2 text-lg font-bold text-display hover:bg-white/5', card.done && 'line-through opacity-70')}
              >
                {card.title}
              </h2>
            )}
          </div>
        </div>

        {/* Barra rápida — só aparece o botão pra seções ainda vazias */}
        <div className="flex flex-wrap gap-1.5 pl-7">
          {cardLabels.length === 0 && (
            <button
              type="button"
              onClick={() => setLabelPickerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(14,154,160,0.2)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
            >
              <Tag className="h-3.5 w-3.5" /> Etiquetas
            </button>
          )}
          {!datesOpen && (
            <button
              type="button"
              onClick={() => setDatesOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(14,154,160,0.2)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
            >
              <Calendar className="h-3.5 w-3.5" /> Datas
            </button>
          )}
          {card.checklists.length === 0 && (
            <button
              type="button"
              onClick={() => void addChecklist()}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(14,154,160,0.2)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
            >
              <CheckSquare className="h-3.5 w-3.5" /> Checklist
            </button>
          )}
          {members.length === 0 && (
            <button
              type="button"
              onClick={() => setMemberPickerOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(14,154,160,0.2)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--color-text-primary)]"
            >
              <UserPlus className="h-3.5 w-3.5" /> Membros
            </button>
          )}
        </div>

        {/* Etiquetas + Membros */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={cardLabels.length === 0 && !labelPickerOpen ? 'hidden' : ''}>
            <div className={sectionLabel}><Tag className="h-3.5 w-3.5" /> Etiquetas</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {cardLabels.map((l) => (
                <span
                  key={l.id}
                  className="rounded-md px-2.5 py-1 text-[11px] font-semibold text-[#062720]"
                  style={{ background: l.color }}
                >
                  {l.name ?? '\u00A0\u00A0\u00A0\u00A0'}
                </span>
              ))}
              <button
                type="button"
                onClick={() => setLabelPickerOpen((v) => !v)}
                className="h-6 w-6 flex items-center justify-center rounded-md border border-[rgba(14,154,160,0.25)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--accent-primary)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {labelPickerOpen && (
              <div className="mt-2 space-y-1.5 rounded-lg border border-[rgba(14,154,160,0.2)] bg-[#0F1223] p-2">
                {labels.map((l) => (
                  <div key={l.id} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void toggleLabel(l.id)}
                      className={cn(
                        'flex-1 flex items-center justify-between rounded-md px-2.5 py-1.5 text-[11px] font-semibold text-[#062720]',
                        !card.labelIds.includes(l.id) && 'opacity-50',
                      )}
                      style={{ background: l.color }}
                    >
                      <span>{l.name ?? 'Sem nome'}</span>
                      {card.labelIds.includes(l.id) && <span>✓</span>}
                    </button>
                    <input
                      defaultValue={l.name ?? ''}
                      placeholder="nome"
                      onBlur={(e) => { if (e.target.value !== (l.name ?? '')) void renomearEtiqueta(l.id, e.target.value); }}
                      className="w-20 rounded-md border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-1.5 py-1 text-[10px] text-[var(--color-text-primary)]"
                    />
                  </div>
                ))}
                <div className="flex flex-wrap gap-1 pt-1">
                  {LABEL_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => void criarEtiqueta(c)}
                      title="Nova etiqueta desta cor"
                      className="h-5 w-5 rounded-md hover:ring-2 hover:ring-white/40"
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className={members.length === 0 && !memberPickerOpen ? 'hidden' : ''}>
            <div className={sectionLabel}><UserPlus className="h-3.5 w-3.5" /> Membros</div>
            <div className="flex flex-wrap items-center gap-1.5">
              {members.map((m) => (
                <span key={m.user_id} className="inline-flex items-center gap-1 rounded-full bg-white/5 pl-0.5 pr-2 py-0.5 text-[11px]">
                  <Avatar src={m.avatar_url} name={m.display_name ?? m.email} className="h-5 w-5 text-[9px]" />
                  {operatorLabel(m)}
                </span>
              ))}
              <button
                type="button"
                onClick={() => setMemberPickerOpen((v) => !v)}
                className="h-6 w-6 flex items-center justify-center rounded-md border border-[rgba(14,154,160,0.25)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-[var(--accent-primary)]"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
            </div>
            {memberPickerOpen && (
              <div className="mt-2 flex flex-wrap gap-1.5 rounded-lg border border-[rgba(14,154,160,0.2)] bg-[#0F1223] p-2">
                {operators.map((o) => (
                  <button
                    key={o.user_id}
                    type="button"
                    onClick={() => void toggleMember(o.user_id)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                      card.memberIds.includes(o.user_id)
                        ? 'border-[var(--accent-primary)] bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]'
                        : 'border-[rgba(14,154,160,0.2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                    )}
                  >
                    {operatorLabel(o)}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Datas */}
        {datesOpen && (
        <div>
          <div className={sectionLabel}><Calendar className="h-3.5 w-3.5" /> Datas</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <span className="text-[10px] text-[var(--color-text-secondary)]">Início</span>
              <input
                type="datetime-local"
                defaultValue={toLocalInput(card.start_date)}
                onBlur={(e) => void onPatch({ start_date: fromLocalInput(e.target.value) })}
                className={fieldCls}
              />
            </div>
            <div>
              <span className="text-[10px] text-[var(--color-text-secondary)]">Prazo</span>
              <input
                type="datetime-local"
                defaultValue={toLocalInput(card.due_date)}
                onBlur={(e) => void onPatch({ due_date: fromLocalInput(e.target.value) })}
                className={fieldCls}
              />
            </div>
          </div>
        </div>
        )}

        {/* Descrição */}
        <div>
          <div className={sectionLabel}><AlignLeft className="h-3.5 w-3.5" /> Descrição</div>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={() => void salvarDescricao()}
            placeholder="Detalhe o que precisa ser feito…"
            className={fieldCls}
          />
        </div>

        {/* Checklists */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className={cn(sectionLabel, 'mb-0')}><CheckSquare className="h-3.5 w-3.5" /> Checklists</div>
            <button
              type="button"
              onClick={() => void addChecklist()}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[var(--accent-primary)] hover:opacity-80"
            >
              <Plus className="h-3.5 w-3.5" /> Novo checklist
            </button>
          </div>
          {card.checklists.map((cl) => {
            const total = cl.items.length;
            const done = cl.items.filter((i) => i.done).length;
            const pct = total > 0 ? Math.round((done / total) * 100) : 0;
            return (
              <div key={cl.id} className="rounded-lg border border-[rgba(14,154,160,0.15)] p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <input
                    defaultValue={cl.title}
                    onBlur={(e) => { if (e.target.value !== cl.title) void renameChecklist(cl.id, e.target.value); }}
                    className="flex-1 bg-transparent text-sm font-semibold text-[var(--color-text-primary)] outline-none focus:underline"
                  />
                  <button type="button" onClick={() => void deleteChecklist(cl.id)} aria-label="Excluir checklist">
                    <Trash2 className="h-3.5 w-3.5 text-[var(--color-text-secondary)] hover:text-[#EF4444]" />
                  </button>
                </div>
                {total > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 rounded-full bg-white/10 overflow-hidden">
                      <div className="h-full rounded-full bg-[var(--accent-primary)] transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[10px] text-[var(--color-text-secondary)] shrink-0">{done}/{total}</span>
                  </div>
                )}
                <div className="space-y-1">
                  {cl.items.map((item) => (
                    <div key={item.id} className="flex items-center gap-2 text-sm group">
                      <input type="checkbox" checked={item.done} onChange={(e) => void toggleItem(item.id, e.target.checked)} />
                      <span className={cn('flex-1', item.done && 'line-through opacity-60')}>{item.text}</span>
                      <button
                        type="button"
                        onClick={() => void deleteItem(item.id)}
                        aria-label="Remover item"
                        className="opacity-0 group-hover:opacity-100"
                      >
                        <X className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
                      </button>
                    </div>
                  ))}
                </div>
                <ChecklistItemInput onAdd={(text) => void addItem(cl.id, text)} />
              </div>
            );
          })}
        </div>

        {/* Anexos */}
        <div>
          <div className={sectionLabel}><Paperclip className="h-3.5 w-3.5" /> Anexos</div>
          <div className="space-y-1.5 mb-2">
            {card.attachments.map((att) => (
              <div key={att.id} className="flex items-center gap-2 rounded-lg border border-[rgba(14,154,160,0.15)] px-2.5 py-1.5 text-xs group">
                {att.kind === 'file' ? <Upload className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" /> : <LinkIcon className="h-3.5 w-3.5 shrink-0 text-[var(--color-text-secondary)]" />}
                <a href={att.url} target="_blank" rel="noreferrer" className="flex-1 truncate text-[var(--accent-primary)] hover:underline">
                  {att.name}
                </a>
                <span className="shrink-0 text-[10px] text-[var(--color-text-secondary)]">
                  {new Date(att.created_at).toLocaleDateString('pt-BR')}
                </span>
                <button type="button" onClick={() => void removeAttachment(att)} className="opacity-0 group-hover:opacity-100 shrink-0">
                  <X className="h-3.5 w-3.5 text-[var(--color-text-secondary)] hover:text-[#EF4444]" />
                </button>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={novoAnexoNome}
              onChange={(e) => setNovoAnexoNome(e.target.value)}
              placeholder="Nome (opcional)"
              className="w-36 rounded-md border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
            />
            <input
              value={novoAnexoUrl}
              onChange={(e) => setNovoAnexoUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addLinkAttachment(); }}
              placeholder="https://…"
              className="flex-1 min-w-[140px] rounded-md border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
            />
            <Button size="sm" variant="outline" onClick={() => void addLinkAttachment()}>
              <LinkIcon className="h-3.5 w-3.5" /> Link
            </Button>
            <label className="inline-flex items-center gap-1 cursor-pointer rounded-lg border border-[rgba(14,154,160,0.2)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              <Upload className="h-3.5 w-3.5" /> {uploading ? 'Enviando…' : 'Arquivo'}
              <input
                type="file"
                className="hidden"
                disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFileAttachment(f); e.target.value = ''; }}
              />
            </label>
          </div>
        </div>

        {/* Atividade / comentários */}
        <div>
          <div className={sectionLabel}><MessageSquare className="h-3.5 w-3.5" /> Atividade</div>
          <div className="flex gap-2 mb-3">
            <textarea
              rows={2}
              value={novoComentario}
              onChange={(e) => setNovoComentario(e.target.value)}
              placeholder="Escreva um comentário…"
              className={fieldCls}
            />
            <Button size="sm" onClick={() => void enviarComentario()} className="self-end shrink-0">Enviar</Button>
          </div>
          <div className="space-y-2.5 max-h-64 overflow-y-auto">
            {card.activity.length === 0 && (
              <p className="text-xs text-[var(--color-text-secondary)] opacity-60">Nenhuma atividade ainda.</p>
            )}
            {card.activity.map((a) => (
              <div key={a.id} className="text-xs">
                <div className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
                  <span className="font-semibold text-[var(--color-text-primary)]">{operatorName(a.user_id)}</span>
                  <span>{a.kind === 'comment' ? 'comentou' : a.kind === 'move' ? 'moveu' : a.kind === 'archive' ? 'arquivou' : a.kind === 'create' ? 'criou' : 'alterou'}</span>
                  <span className="ml-auto shrink-0">{new Date(a.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                {a.content && <div className="mt-0.5 whitespace-pre-wrap text-[var(--color-text-primary)]">{a.content}</div>}
              </div>
            ))}
          </div>
        </div>

        {/* Ações */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[rgba(14,154,160,0.1)] pt-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => void alternarFeito()}>
              <CheckSquare className="h-3.5 w-3.5" /> {card.done ? 'Reabrir' : 'Concluir'}
            </Button>
            <div className="relative">
              <Button variant="outline" size="sm" onClick={() => setMovePickerOpen((v) => !v)}>
                <ArrowRightLeft className="h-3.5 w-3.5" /> Mover
              </Button>
              {movePickerOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-48 rounded-lg border border-[rgba(14,154,160,0.25)] bg-[#0F1223] p-1 shadow-lg z-10">
                  {lists.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => void moverPara(l.id)}
                      className={cn(
                        'w-full rounded-md px-2 py-1.5 text-left text-xs hover:bg-white/5',
                        l.id === card.list_id ? 'text-[var(--accent-primary)] font-semibold' : 'text-[var(--color-text-primary)]',
                      )}
                    >
                      {l.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={() => void copiarCartao()} disabled={busy}>
              <Copy className="h-3.5 w-3.5" /> Copiar
            </Button>
            <Button variant="outline" size="sm" onClick={() => void arquivar()} disabled={busy}>
              <Archive className="h-3.5 w-3.5" /> Arquivar
            </Button>
            <Button variant="outline" size="sm" onClick={() => void excluir()}>
              <Trash2 className="h-3.5 w-3.5 text-[#EF4444]" />
            </Button>
          </div>
          <Button size="sm" onClick={onClose}>Fechar</Button>
        </div>
      </div>
    </Dialog>
  );
}

function ChecklistItemInput({ onAdd }: { onAdd: (text: string) => void }) {
  const [txt, setTxt] = useState('');
  return (
    <input
      value={txt}
      onChange={(e) => setTxt(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && txt.trim()) { e.preventDefault(); onAdd(txt); setTxt(''); }
      }}
      placeholder="Adicionar item + Enter"
      className="w-full rounded-md border border-[rgba(14,154,160,0.15)] bg-white/[0.02] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
    />
  );
}
