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
  'w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[var(--accent-primary)]';

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
  const [, setMovePickerOpen] = useState(false);
  const [novoComentario, setNovoComentario] = useState('');
  const [novoAnexoUrl, setNovoAnexoUrl] = useState('');
  const [novoAnexoNome, setNovoAnexoNome] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const [datesOpen, setDatesOpen] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [commentFocus, setCommentFocus] = useState(false);

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
      position: Math.max(0, ...labels.map((l) => Number(l.position) || 0)) + 1000,
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
    const { error } = await supabase.from('card_checklists').insert({ card_id: card.id, title: 'Checklist', position: Math.max(0, ...card.checklists.map((c) => Number(c.position) || 0)) + 1000 });
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
    const { error } = await supabase.from('card_checklist_items').insert({ checklist_id: checklistId, text: text.trim(), position: Math.max(0, ...(card.checklists.find((c) => c.id === checklistId)?.items ?? []).map((i) => Number(i.position) || 0)) + 1000 });
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
    // Vai para o fim da lista. Segundos (não milissegundos): cabe em coluna integer.
    await onPatch({ list_id: listId, position: Math.floor(Date.now() / 1000) });
    await supabase.from('card_activity').insert({
      card_id: card.id, user_id: currentUserId, kind: 'move',
      content: `Movido para "${lists.find((l) => l.id === listId)?.name ?? '—'}"`,
    });
    await onReload();
  };

  const comments = card.activity.filter((x) => x.kind === 'comment');
  const shownActivity = showDetails ? card.activity : comments;
  const due = card.due_date ? new Date(card.due_date) : null;
  const dueSt = !due ? null : card.done ? 'done' : due.getTime() < Date.now() ? 'late' : due.getTime() - Date.now() < 86400000 ? 'soon' : 'ok';
  const chip = 'inline-flex items-center gap-1.5 rounded-md bg-[var(--color-surface-hover)] px-2.5 py-1.5 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-border-soft)]';
  const actBtn = 'inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-card)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]';
  const isImg = (url: string) => /\.(png|jpe?g|gif|webp|svg)(\?|$)/i.test(url);

  return (
    <Dialog open onClose={onClose} widthClass="max-w-6xl" opaque>
      <div className="-m-6">
        {/* Topo: lista (troca) + seguir + mais */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-5 py-3 pr-14">
          <div className="relative">
            <button type="button" onClick={() => setListPickerOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-primary)] px-2.5 py-1 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">
              {currentList?.name ?? '—'} <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {listPickerOpen && (
              <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1 shadow-[var(--shadow-lg)]">
                {lists.map((l) => (
                  <button key={l.id} type="button" onClick={() => { setListPickerOpen(false); void moverPara(l.id); }}
                    className={cn('w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)]', l.id === card.list_id ? 'font-semibold text-[var(--accent-primary)]' : 'text-[var(--color-text-primary)]')}>{l.name}</button>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" onClick={() => void toggleWatch()} title={isWatching ? 'Parar de seguir' : 'Seguir este cartão'}
              className={cn('flex h-8 w-8 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)]', isWatching ? 'text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)]')}>
              {isWatching ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
            </button>
            <div className="relative">
              <button type="button" onClick={() => setActionsOpen((v) => !v)} aria-label="Mais ações" className="flex h-8 w-8 items-center justify-center rounded-md text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><MoreHorizontal className="h-4 w-4" /></button>
              {actionsOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-1 shadow-[var(--shadow-lg)]">
                  {[
                    { icon: CheckSquare, label: card.done ? 'Reabrir cartão' : 'Marcar concluído', run: () => void alternarFeito() },
                    { icon: ArrowRightLeft, label: 'Mover', run: () => setListPickerOpen(true) },
                    { icon: Copy, label: 'Copiar', run: () => void copiarCartao() },
                    { icon: Archive, label: 'Arquivar', run: () => void arquivar() },
                  ].map((x) => (
                    <button key={x.label} type="button" disabled={busy} onClick={() => { setActionsOpen(false); x.run(); }}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]"><x.icon className="h-4 w-4" /> {x.label}</button>
                  ))}
                  <div className="my-1 border-t border-[var(--color-border-soft)]" />
                  <button type="button" onClick={() => { setActionsOpen(false); void excluir(); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--color-error)] hover:bg-[var(--color-surface-hover)]"><Trash2 className="h-4 w-4" /> Excluir</button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="grid max-h-[calc(100vh-10rem)] grid-cols-1 overflow-hidden lg:grid-cols-[1fr_420px]">
          {/* Coluna principal */}
          <div className="min-w-0 space-y-6 overflow-y-auto px-6 py-5">
            <div className="flex items-start gap-3">
              <button type="button" onClick={() => void alternarFeito()} title={card.done ? 'Reabrir cartão' : 'Marcar concluído'} className="mt-1.5 shrink-0 text-[var(--color-text-secondary)] hover:text-[var(--color-success)]">
                {card.done ? <CheckCircle2 className="h-6 w-6 text-[var(--color-success)]" /> : <Circle className="h-6 w-6" />}
              </button>
              <div className="min-w-0 flex-1">
                {editingTitle ? (
                  <textarea autoFocus rows={2} value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void salvarTitulo()}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === 'Escape') { setTitle(card.title); setEditingTitle(false); } }}
                    className="w-full resize-none rounded-md border-2 border-[var(--accent-primary)] bg-[var(--color-surface)] px-2 py-1 text-2xl font-bold text-[var(--color-text-primary)] outline-none" />
                ) : (
                  <h2 onClick={() => setEditingTitle(true)} className={cn('cursor-text break-words rounded-md px-2 py-1 -mx-2 text-2xl font-bold text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]', card.done && 'line-through opacity-70')}>{card.title}</h2>
                )}
              </div>
            </div>

            {/* Ações como no Trello */}
            <div className="flex flex-wrap gap-2 pl-9">
              <label className={cn(actBtn, 'cursor-pointer')}><Plus className="h-4 w-4" /> Adicionar
                <input type="file" className="hidden" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFileAttachment(f); e.target.value = ''; }} />
              </label>
              <button type="button" onClick={() => setLabelPickerOpen((v) => !v)} className={actBtn}><Tag className="h-4 w-4" /> Etiquetas</button>
              <button type="button" onClick={() => setDatesOpen((v) => !v)} className={actBtn}><Calendar className="h-4 w-4" /> Datas</button>
              <button type="button" onClick={() => void addChecklist()} className={actBtn}><CheckSquare className="h-4 w-4" /> Checklist</button>
              <button type="button" onClick={() => setMemberPickerOpen((v) => !v)} className={actBtn}><UserPlus className="h-4 w-4" /> Membros</button>
            </div>

            {/* Membros / Etiquetas / Datas */}
            {(members.length > 0 || cardLabels.length > 0 || due || card.start_date || labelPickerOpen || memberPickerOpen || datesOpen) && (
              <div className="flex flex-wrap gap-6 pl-9">
                {(members.length > 0 || memberPickerOpen) && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">Membros</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {members.map((m) => <span key={m.user_id} title={operatorLabel(m)}><Avatar src={m.avatar_url} name={m.display_name ?? m.email} className="h-8 w-8 text-xs" /></span>)}
                      <button type="button" onClick={() => setMemberPickerOpen((v) => !v)} aria-label="Adicionar membro" className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-hover)] hover:bg-[var(--color-border-soft)]"><Plus className="h-4 w-4" /></button>
                    </div>
                  </div>
                )}
                {(cardLabels.length > 0 || labelPickerOpen) && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">Etiquetas</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {cardLabels.map((l) => <span key={l.id} className="h-8 min-w-[48px] rounded-md px-3 py-1.5 text-sm font-semibold text-white" style={{ background: l.color }}>{l.name ?? ' '}</span>)}
                      <button type="button" onClick={() => setLabelPickerOpen((v) => !v)} aria-label="Etiquetas" className="flex h-8 w-8 items-center justify-center rounded-md bg-[var(--color-surface-hover)] hover:bg-[var(--color-border-soft)]"><Plus className="h-4 w-4" /></button>
                    </div>
                  </div>
                )}
                {(due || card.start_date || datesOpen) && (
                  <div>
                    <div className="mb-1.5 text-xs font-semibold text-[var(--color-text-secondary)]">Datas</div>
                    <button type="button" onClick={() => setDatesOpen((v) => !v)} className={chip}>
                      {card.start_date && <>{new Date(card.start_date).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '')} – </>}
                      {due ? due.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).replace('.', '') : 'Definir'}
                      {dueSt === 'late' && <span className="rounded bg-[#C9372C] px-1.5 text-xs text-white">Atrasado</span>}
                      {dueSt === 'soon' && <span className="rounded bg-[#F5CD47] px-1.5 text-xs text-[#172B4D]">Vence logo</span>}
                      {dueSt === 'done' && <span className="rounded bg-[#1F845A] px-1.5 text-xs text-white">Concluído</span>}
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {labelPickerOpen && (
              <div className="ml-9 max-w-sm space-y-1.5 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-lg)]">
                <div className="mb-1 flex items-center justify-between text-sm font-semibold">Etiquetas <button type="button" aria-label="Fechar" onClick={() => setLabelPickerOpen(false)}><X className="h-4 w-4" /></button></div>
                {labels.map((l) => (
                  <div key={l.id} className="flex items-center gap-2">
                    <input type="checkbox" checked={card.labelIds.includes(l.id)} onChange={() => void toggleLabel(l.id)} aria-label={l.name ?? 'Etiqueta'} className="h-4 w-4 accent-[var(--accent-fill)]" />
                    <span className="h-8 flex-1 rounded-md" style={{ background: l.color }} />
                    <input defaultValue={l.name ?? ''} placeholder="nome" onBlur={(e) => { if (e.target.value !== (l.name ?? '')) void renomearEtiqueta(l.id, e.target.value); }}
                      className="h-8 w-28 rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-xs" />
                  </div>
                ))}
                <div className="pt-1 text-xs text-[var(--color-text-muted)]">Criar etiqueta:</div>
                <div className="flex flex-wrap gap-1.5">{LABEL_COLORS.map((c) => <button key={c} type="button" onClick={() => void criarEtiqueta(c)} title="Nova etiqueta desta cor" className="h-7 w-10 rounded-md hover:ring-2 hover:ring-[var(--accent-primary)]" style={{ background: c }} />)}</div>
              </div>
            )}
            {memberPickerOpen && (
              <div className="ml-9 max-w-sm rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-3 shadow-[var(--shadow-lg)]">
                <div className="mb-2 flex items-center justify-between text-sm font-semibold">Membros <button type="button" aria-label="Fechar" onClick={() => setMemberPickerOpen(false)}><X className="h-4 w-4" /></button></div>
                <div className="max-h-64 space-y-0.5 overflow-y-auto">
                  {operators.map((o) => (
                    <button key={o.user_id} type="button" onClick={() => void toggleMember(o.user_id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--color-surface-hover)]">
                      <Avatar src={o.avatar_url} name={o.display_name ?? o.email} className="h-7 w-7 text-[10px]" /><span className="flex-1 truncate">{operatorLabel(o)}</span>
                      {card.memberIds.includes(o.user_id) && <CheckCircle2 className="h-4 w-4 text-[var(--accent-primary)]" />}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {datesOpen && (
              <div className="ml-9 grid max-w-md grid-cols-1 gap-2 rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface-raised)] p-3 sm:grid-cols-2">
                <label className="text-xs text-[var(--color-text-secondary)]">Início<input type="datetime-local" defaultValue={toLocalInput(card.start_date)} onBlur={(e) => void onPatch({ start_date: fromLocalInput(e.target.value) })} className={fieldCls} /></label>
                <label className="text-xs text-[var(--color-text-secondary)]">Entrega<input type="datetime-local" defaultValue={toLocalInput(card.due_date)} onBlur={(e) => void onPatch({ due_date: fromLocalInput(e.target.value) })} className={fieldCls} /></label>
              </div>
            )}

            {/* Descrição */}
            <section className="space-y-2">
              <h3 className="flex items-center gap-3 text-base font-semibold text-[var(--color-text-primary)]"><AlignLeft className="h-5 w-5" /> Descrição</h3>
              <div className="pl-8">
                {editingDesc ? (
                  <div className="space-y-2">
                    <textarea autoFocus rows={6} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Adicione uma descrição mais detalhada…" className={fieldCls} />
                    <div className="flex gap-2"><Button size="sm" onClick={() => { void salvarDescricao(); setEditingDesc(false); }}>Salvar</Button><Button size="sm" variant="ghost" onClick={() => { setDescription(card.description ?? ''); setEditingDesc(false); }}>Cancelar</Button></div>
                  </div>
                ) : card.description ? (
                  <div onClick={() => setEditingDesc(true)} className="cursor-text whitespace-pre-wrap rounded-md px-1 py-1 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)]">{card.description}</div>
                ) : (
                  <button type="button" onClick={() => setEditingDesc(true)} className="w-full rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-3 text-left text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]">Adicione uma descrição mais detalhada…</button>
                )}
              </div>
            </section>

            {/* Anexos */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-3 text-base font-semibold text-[var(--color-text-primary)]"><Paperclip className="h-5 w-5" /> Anexos</h3>
                <label className={cn(actBtn, 'cursor-pointer')}><Upload className="h-4 w-4" /> {uploading ? 'Enviando…' : 'Adicionar'}
                  <input type="file" className="hidden" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadFileAttachment(f); e.target.value = ''; }} />
                </label>
              </div>
              <div className="space-y-2 pl-8">
                {card.attachments.length > 0 && <div className="text-xs font-semibold text-[var(--color-text-secondary)]">Arquivos e links</div>}
                {card.attachments.map((att) => (
                  <div key={att.id} className="group flex items-center gap-3">
                    <a href={att.url} target="_blank" rel="noreferrer" className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--color-surface-hover)]">
                      {att.kind === 'file' && isImg(att.url) ? <img src={att.url} alt="" className="h-full w-full object-cover" /> : att.kind === 'file' ? <Paperclip className="h-5 w-5 text-[var(--color-text-secondary)]" /> : <LinkIcon className="h-5 w-5 text-[var(--color-text-secondary)]" />}
                    </a>
                    <div className="min-w-0 flex-1">
                      <a href={att.url} target="_blank" rel="noreferrer" className="block truncate text-sm font-semibold text-[var(--color-text-primary)] hover:underline">{att.name}</a>
                      <div className="text-xs text-[var(--color-text-muted)]">Adicionado {new Date(att.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                    </div>
                    <button type="button" onClick={() => void removeAttachment(att)} aria-label="Remover anexo" className="opacity-0 group-hover:opacity-100"><X className="h-4 w-4 text-[var(--color-text-secondary)] hover:text-[var(--color-error)]" /></button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center gap-1.5">
                  <input value={novoAnexoUrl} onChange={(e) => setNovoAnexoUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void addLinkAttachment(); }} placeholder="Colar um link https://…" className="h-9 min-w-[180px] flex-1 rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                  <input value={novoAnexoNome} onChange={(e) => setNovoAnexoNome(e.target.value)} placeholder="Nome (opcional)" className="h-9 w-40 rounded-md border border-[var(--color-border-card)] bg-[var(--color-surface)] px-2 text-sm" />
                  <Button size="sm" variant="outline" disabled={!novoAnexoUrl.trim()} onClick={() => void addLinkAttachment()}><LinkIcon className="h-3.5 w-3.5" /> Anexar link</Button>
                </div>
              </div>
            </section>

            {/* Checklists */}
            {card.checklists.map((cl) => {
              const total = cl.items.length;
              const done = cl.items.filter((i) => i.done).length;
              const pct = total > 0 ? Math.round((done / total) * 100) : 0;
              return (
                <section key={cl.id} className="space-y-2">
                  <div className="flex items-center gap-3">
                    <CheckSquare className="h-5 w-5 shrink-0" />
                    <input defaultValue={cl.title} onBlur={(e) => { if (e.target.value !== cl.title) void renameChecklist(cl.id, e.target.value); }}
                      className="min-w-0 flex-1 rounded bg-transparent px-1 text-base font-semibold text-[var(--color-text-primary)] outline-none focus:bg-[var(--color-surface-hover)]" />
                    <Button size="sm" variant="outline" onClick={() => void deleteChecklist(cl.id)}>Excluir</Button>
                  </div>
                  <div className="flex items-center gap-2 pl-1">
                    <span className="w-8 text-xs text-[var(--color-text-secondary)]">{pct}%</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-hover)]"><div className={cn('h-full rounded-full transition-all', pct === 100 ? 'bg-[#1F845A]' : 'bg-[var(--accent-fill)]')} style={{ width: `${pct}%` }} /></div>
                  </div>
                  <div className="space-y-0.5 pl-8">
                    {cl.items.map((item) => (
                      <div key={item.id} className="group flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-[var(--color-surface-hover)]">
                        <input type="checkbox" checked={item.done} onChange={(e) => void toggleItem(item.id, e.target.checked)} className="h-4 w-4 accent-[var(--accent-fill)]" />
                        <span className={cn('flex-1', item.done && 'line-through opacity-60')}>{item.text}</span>
                        <button type="button" onClick={() => void deleteItem(item.id)} aria-label="Remover item" className="opacity-0 group-hover:opacity-100"><X className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" /></button>
                      </div>
                    ))}
                    <ChecklistItemInput onAdd={(text) => void addItem(cl.id, text)} />
                  </div>
                </section>
              );
            })}
          </div>

          {/* Comentários e atividade */}
          <aside className="flex min-h-0 flex-col border-t border-[var(--color-border-soft)] bg-[var(--color-bg-primary)] lg:border-l lg:border-t-0">
            <div className="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
              <h3 className="flex items-center gap-2 text-base font-semibold text-[var(--color-text-primary)]"><MessageSquare className="h-5 w-5" /> Comentários e atividade</h3>
              <Button size="sm" variant="outline" onClick={() => setShowDetails((v) => !v)}>{showDetails ? 'Ocultar detalhes' : 'Mostrar detalhes'}</Button>
            </div>
            <div className="px-5 pb-3">
              <textarea rows={commentFocus || novoComentario ? 3 : 1} value={novoComentario} onFocus={() => setCommentFocus(true)} onBlur={() => setCommentFocus(false)}
                onChange={(e) => setNovoComentario(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void enviarComentario(); }}
                placeholder="Escrever um comentário…" className={cn(fieldCls, 'resize-none')} />
              {(commentFocus || novoComentario) && <div className="mt-2 flex justify-end"><Button size="sm" onMouseDown={(e) => e.preventDefault()} disabled={!novoComentario.trim()} onClick={() => void enviarComentario()}>Salvar</Button></div>}
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-5">
              {shownActivity.length === 0 && <p className="text-sm text-[var(--color-text-muted)]">{showDetails ? 'Nenhuma atividade ainda.' : 'Nenhum comentário ainda.'}</p>}
              {shownActivity.map((x) => {
                const op = operators.find((o) => o.user_id === x.user_id);
                const when = new Date(x.created_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace('.', '');
                return (
                  <div key={x.id} className="flex gap-2.5">
                    <Avatar src={op?.avatar_url ?? null} name={operatorName(x.user_id)} className="h-8 w-8 shrink-0 text-xs" />
                    <div className="min-w-0 flex-1 text-sm">
                      {x.kind === 'comment' ? (
                        <>
                          <div><b className="text-[var(--color-text-primary)]">{operatorName(x.user_id)}</b> <span className="text-xs text-[var(--accent-primary)]">{when}</span></div>
                          <div className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-[var(--color-border-card)] bg-[var(--color-surface)] px-3 py-2 text-[var(--color-text-primary)] shadow-sm">{x.content}</div>
                        </>
                      ) : (
                        <>
                          <div className="text-[var(--color-text-secondary)]"><b className="text-[var(--color-text-primary)]">{operatorName(x.user_id)}</b> {x.content ?? (x.kind === 'archive' ? 'arquivou este cartão' : x.kind === 'create' ? 'criou este cartão' : 'alterou este cartão')}</div>
                          <div className="text-xs text-[var(--accent-primary)]">{when}</div>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </aside>
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
      className="w-full rounded-md border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] px-2 py-1.5 text-xs text-[var(--color-text-primary)]"
    />
  );
}
