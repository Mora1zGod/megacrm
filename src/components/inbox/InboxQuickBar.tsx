import { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ConversationWithContact } from '@/types/inbox';
import type { InboxFilterState } from './inbox-filters';

export type QuickChip =
  | 'todas' | 'minhas' | 'sem_dono' | 'nao_lidas' | 'aguardando' | 'aguardando_cliente'
  | 'ia_pausada' | 'favoritas' | 'grupos';

// "Sem dono" = conversa que precisa de gente e ninguém pegou: aberta, fora da
// mão da IA e sem responsável. Conversa que a IA está atendendo não conta —
// ela tem dono (a IA), e contá-la aqui faria o número inchar com atendimento
// que não precisa de ninguém.
export function isSemDono(c: ConversationWithContact): boolean {
  return !c.assigned_to && c.status === 'human_active';
}

// Grupo do WhatsApp (UAZAPI): o contato do grupo tem como "telefone" o JID
// do grupo (…@g.us). Grupos ficam só na aba Grupos — não misturam com os
// atendimentos 1:1 nem entram nos contadores das outras abas.
export function isGroupConversation(c: ConversationWithContact): boolean {
  return (c.contact?.phone ?? '').endsWith('@g.us');
}

interface Props {
  // Busca livre: nome OU telefone. Um campo só, como no WhatsApp — o operador
  // não quer escolher em qual campo procurar, quer achar a pessoa.
  busca: string;
  onBuscaChange: (v: string) => void;
  chip: QuickChip;
  onChipChange: (c: QuickChip) => void;
  // Lista JÁ filtrada pelos filtros avançados, mas ANTES da busca/chip — é a
  // base correta para os contadores refletirem o que o clique vai mostrar.
  base: ConversationWithContact[];
  filters: InboxFilterState;
  // Operador logado — é quem define o que é "Minhas".
  userId: string | null;
}

// Aguardando resposta = a última mensagem foi do contato.
export function isAguardando(c: ConversationWithContact): boolean {
  return c.lastMessageDirection === 'inbound';
}

export function matchesQuickChip(
  c: ConversationWithContact,
  chip: QuickChip,
  userId: string | null = null,
): boolean {
  if (chip === 'grupos') return isGroupConversation(c);
  if (isGroupConversation(c)) return false;
  switch (chip) {
    case 'minhas':
      return Boolean(userId) && c.assigned_to === userId;
    case 'sem_dono':
      return isSemDono(c);
    case 'nao_lidas':
      return (c.unread_count ?? 0) > 0;
    case 'aguardando':
      return isAguardando(c);
    // Aguardando cliente = a equipe/IA já respondeu e espera o contato voltar
    // (oposto de "aguardando" — que é a equipe devendo resposta ao contato).
    case 'aguardando_cliente':
      return c.status !== 'closed' && !isAguardando(c);
    case 'ia_pausada':
      return Boolean(c.ai_paused);
    case 'favoritas':
      return Boolean(c.is_favorite);
    default:
      return true;
  }
}

export function matchesBusca(c: ConversationWithContact, busca: string): boolean {
  const q = busca.trim().toLowerCase();
  if (!q) return true;
  const nome = (c.contact?.name ?? '').toLowerCase();
  if (nome.includes(q)) return true;
  const digitos = q.replace(/\D/g, '');
  if (digitos) {
    const fone = (c.contact?.phone ?? '').replace(/\D/g, '');
    if (fone.includes(digitos)) return true;
  }
  // Busca também na prévia da última mensagem — é assim que a pessoa lembra
  // da conversa ("aquele que perguntou do day use").
  const ultima = (c.lastMessagePreview ?? '').toLowerCase();
  return ultima.includes(q);
}

export function InboxQuickBar({ busca, onBuscaChange, chip, onChipChange, base, userId }: Props) {
  const contagem = useMemo(() => {
    let minhas = 0;
    let semDono = 0;
    let naoLidas = 0;
    let aguardando = 0;
    let aguardandoCliente = 0;
    let iaPausada = 0;
    let favoritas = 0;
    let grupos = 0;
    let todas = 0;
    for (const c of base) {
      if (isGroupConversation(c)) { grupos++; continue; }
      todas++;
      if (matchesQuickChip(c, 'minhas', userId)) minhas++;
      if (isSemDono(c)) semDono++;
      if ((c.unread_count ?? 0) > 0) naoLidas++;
      if (isAguardando(c)) aguardando++;
      else if (c.status !== 'closed') aguardandoCliente++;
      if (c.ai_paused) iaPausada++;
      if (c.is_favorite) favoritas++;
    }
    return { todas, minhas, semDono, naoLidas, aguardando, aguardandoCliente, iaPausada, favoritas, grupos };
  }, [base, userId]);

  const chips: Array<{ id: QuickChip; label: string; count: number }> = [
    { id: 'todas', label: 'Tudo', count: contagem.todas },
    { id: 'minhas', label: 'Minhas', count: contagem.minhas },
    { id: 'sem_dono', label: 'Sem dono', count: contagem.semDono },
    { id: 'nao_lidas', label: 'Não lidas', count: contagem.naoLidas },
    { id: 'aguardando', label: 'Aguardando equipe', count: contagem.aguardando },
    { id: 'aguardando_cliente', label: 'Aguardando cliente', count: contagem.aguardandoCliente },
    { id: 'ia_pausada', label: 'IA pausada', count: contagem.iaPausada },
    { id: 'favoritas', label: 'Favoritas', count: contagem.favoritas },
    { id: 'grupos', label: 'Grupos', count: contagem.grupos },
  ];

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--color-text-secondary)]" />
        <input
          value={busca}
          onChange={(e) => onBuscaChange(e.target.value)}
          aria-label="Buscar por nome, telefone ou mensagem" placeholder="Buscar conversa..."
          className="w-full rounded-lg border border-[var(--color-border-card)] bg-[var(--color-fill-subtle)] py-1.5 pl-8 pr-8 text-sm text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-secondary)] focus:border-[var(--accent-primary)]"
        />
        {busca && (
          <button
            type="button"
            onClick={() => onBuscaChange('')}
            aria-label="Limpar busca"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="inbox-quick-filters">
        {chips.map((c) => {
          const ativo = chip === c.id;
          // Chip sem nada para mostrar fica oculto — não faz sentido oferecer
          // um filtro que resultaria em lista vazia. "Minhas" e "Sem dono"
          // ficam sempre: são as abas fixas de quem atende, e zero ali é
          // informação ("não tem nada esperando"), não ruído.
          const fixo = c.id === 'todas' || c.id === 'grupos' || c.id === 'minhas' || c.id === 'sem_dono';
          if (!fixo && c.count === 0 && !ativo) return null;
          return (
            <button
              key={c.id}
              type="button"
              aria-pressed={ativo} onClick={() => onChipChange(ativo && c.id !== 'todas' ? 'todas' : c.id)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold transition-colors',
                ativo
                  ? 'border-[var(--accent-primary)] bg-[var(--color-accent-subtle)] text-[var(--accent-primary)]'
                  : 'border-[var(--color-border-card)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
              )}
            >
              {c.label}
              {c.count > 0 && c.id !== 'todas' && (
                <span className="ml-1 opacity-80">{c.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
