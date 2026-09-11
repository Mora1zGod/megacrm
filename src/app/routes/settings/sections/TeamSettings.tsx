import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Circle, Loader2, Mail, Plus, Settings2, Trash2, UserPlus, Users } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { extractFunctionErrorMessage } from '@/lib/functionError';
import { logAudit } from '@/hooks/useAuditLog';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { Avatar } from '@/components/ui/Avatar';
import { cn } from '@/lib/utils';

type Role = 'admin' | 'operator';

interface Member {
  id: string;
  user_id: string;
  role: Role;
  display_name: string | null;
  avatar_url: string | null;
  is_online: boolean;
  accepted_at: string | null;
  email: string | null;
}

interface Queue {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  is_default: boolean;
  position: number;
}

interface Channel {
  id: string;
  label: string | null;
  provider: string;
  queue_id: string | null;
}

export function TeamSettings() {
  const { role: callerRole, userId } = useAppUser();
  const isAdmin = callerRole === 'admin';

  const [members, setMembers] = useState<Member[]>([]);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [membership, setMembership] = useState<Record<string, Set<string>>>({});
  const [loading, setLoading] = useState(true);
  const [convidando, setConvidando] = useState(false);
  const [novaFila, setNovaFila] = useState(false);
  const [editandoFila, setEditandoFila] = useState<Queue | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = getSupabase();
    // O e-mail não está em app_users: vem da RPC list_operators (SECURITY
    // DEFINER, faz o join com auth.users já filtrado pela org).
    const [mem, qs, chs, qm, ops] = await Promise.all([
      supabase.from('app_users')
        .select('id, user_id, role, display_name, avatar_url, is_online, accepted_at')
        .order('invited_at'),
      supabase.from('queues').select('id, name, description, color, is_default, position').order('position'),
      supabase.from('channels').select('id, label, provider, queue_id'),
      supabase.from('queue_members').select('queue_id, user_id'),
      supabase.schema('whatsapp_hub').rpc('list_operators'),
    ]);

    if (mem.error) {
      toast.error('Não consegui carregar a equipe.', { description: mem.error.message });
      setLoading(false);
      return;
    }

    const opByUser = new Map<string, { email: string; display_name: string | null; avatar_url: string | null }>(
      ((ops.data ?? []) as Array<{ user_id: string; email: string; display_name: string | null; avatar_url: string | null }>)
        .map((o) => [o.user_id, { email: o.email, display_name: o.display_name, avatar_url: o.avatar_url }]),
    );

    setMembers(
      ((mem.data ?? []) as Array<Record<string, unknown>>).map((row) => {
        const op = opByUser.get(row.user_id as string);
        return {
          id: row.id as string,
          user_id: row.user_id as string,
          role: row.role as Role,
          display_name: op?.display_name ?? (row.display_name as string | null) ?? null,
          avatar_url: op?.avatar_url ?? (row.avatar_url as string | null) ?? null,
          is_online: Boolean(row.is_online),
          accepted_at: (row.accepted_at as string | null) ?? null,
          email: op?.email ?? null,
        };
      }),
    );
    setQueues((qs.data ?? []) as Queue[]);
    setChannels((chs.data ?? []) as Channel[]);

    const map: Record<string, Set<string>> = {};
    for (const row of (qm.data ?? []) as Array<{ queue_id: string; user_id: string }>) {
      (map[row.queue_id] ??= new Set()).add(row.user_id);
    }
    setMembership(map);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const operadores = useMemo(() => members.filter((m) => m.role !== 'admin'), [members]);

  const semFila = useMemo(
    () => operadores.filter((m) => !Object.values(membership).some((s) => s.has(m.user_id))),
    [operadores, membership],
  );

  const toggleMembro = async (queueId: string, memberUserId: string, entrar: boolean) => {
    // Otimista: marcar/desmarcar precisa responder na hora.
    setMembership((prev) => {
      const novo = { ...prev };
      const set = new Set(novo[queueId] ?? []);
      if (entrar) set.add(memberUserId); else set.delete(memberUserId);
      novo[queueId] = set;
      return novo;
    });
    const supabase = getSupabase();
    const { error } = entrar
      ? await supabase.from('queue_members').insert({ queue_id: queueId, user_id: memberUserId })
      : await supabase.from('queue_members').delete().eq('queue_id', queueId).eq('user_id', memberUserId);
    if (error) {
      toast.error('Não consegui atualizar a fila.', { description: error.message });
      void load();
    }
  };

  const mudarCanalFila = async (channelId: string, queueId: string) => {
    const anterior = channels;
    setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, queue_id: queueId || null } : c)));
    const { error } = await getSupabase().from('channels').update({ queue_id: queueId || null }).eq('id', channelId);
    if (error) {
      setChannels(anterior);
      toast.error('Não consegui alterar o canal.', { description: error.message });
      return;
    }
    toast.success('Canal atualizado.');
  };

  const mudarRole = async (member: Member, novo: Role) => {
    if (member.user_id === userId) { toast.error('Você não pode alterar o próprio papel.'); return; }
    const anterior = members;
    setMembers((prev) => prev.map((m) => (m.id === member.id ? { ...m, role: novo } : m)));
    const { error } = await getSupabase().from('app_users').update({ role: novo }).eq('id', member.id);
    if (error) {
      setMembers(anterior);
      toast.error('Não consegui alterar o papel.', { description: error.message });
      return;
    }
    toast.success(`Agora é ${novo === 'admin' ? 'administrador' : 'operador'}.`);
  };

  const remover = async (member: Member) => {
    if (member.user_id === userId) { toast.error('Você não pode remover a si mesmo.'); return; }
    if (!confirm(`Remover ${member.display_name ?? member.email ?? 'este membro'} da equipe?`)) return;
    const { data, error } = await getSupabase().functions.invoke('delete-team-member', {
      body: { user_id: member.user_id },
    });
    const erro = (data as { ok?: boolean; error?: string } | null)?.ok === false || error
      ? await extractFunctionErrorMessage(error, (data as { error?: string } | null)?.error)
      : null;
    if (erro) { toast.error('Não consegui remover.', { description: erro }); return; }
    const { data: authData } = await getSupabase().auth.getUser();
    void logAudit({
      actorId: userId, actorEmail: authData?.user?.email ?? null, action: 'team_remove',
      entityType: 'app_users', entityId: member.user_id,
      meta: { removed_name: member.display_name, removed_email: member.email },
    });
    toast.success('Membro removido.');
    void load();
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando equipe...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Membros */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-display flex items-center gap-2">
              <Users className="h-4 w-4 text-[var(--accent-primary)]" /> Membros
            </h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Administrador vê tudo. Operador vê apenas as filas de que participa.
            </p>
          </div>
          {isAdmin && (
            <Button onClick={() => setConvidando(true)}>
              <UserPlus className="h-4 w-4" /> Convidar
            </Button>
          )}
        </div>

        {members.length === 0 ? (
          <div className="rounded-xl border border-[rgba(242,185,55,0.3)] bg-[rgba(242,185,55,0.06)] p-4 text-sm text-[#F2B937]">
            Nenhum membro nesta organização. Sem membros, a distribuição por fila e as
            notificações de transferência não têm a quem apontar.
          </div>
        ) : (
          <div className="space-y-2">
            {members.map((m) => (
              <div key={m.id} className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap">
                <Avatar src={m.avatar_url} name={m.display_name ?? m.email ?? '?'} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-sm truncate">{m.display_name ?? '—'}</span>
                    <Circle className={cn('h-2 w-2', m.is_online ? 'fill-[#10B981] text-[#10B981]' : 'fill-[#6B7280] text-[#6B7280]')} />
                  </div>
                  <div className="text-xs text-[var(--color-text-secondary)] truncate">{m.email ?? '—'}</div>
                  {!m.accepted_at && (
                    <span className="mt-0.5 inline-block rounded-full bg-[rgba(242,185,55,0.15)] px-1.5 py-0.5 text-[0.6rem] font-semibold text-[#F2B937]">
                      convite pendente
                    </span>
                  )}
                </div>
                {isAdmin ? (
                  <>
                    <select
                      value={m.role}
                      onChange={(e) => void mudarRole(m, e.target.value as Role)}
                      disabled={m.user_id === userId}
                      className="rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-2 py-1 text-xs text-[var(--color-text-primary)] disabled:opacity-50"
                    >
                      <option value="admin">Administrador</option>
                      <option value="operator">Operador</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => void remover(m)}
                      disabled={m.user_id === userId}
                      aria-label="Remover membro"
                      className="rounded-lg p-1.5 hover:bg-white/5 disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4 text-[#EF4444]" />
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {m.role === 'admin' ? 'Administrador' : 'Operador'}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        {semFila.length > 0 && (
          <div className="rounded-lg border border-[rgba(242,185,55,0.25)] bg-[rgba(242,185,55,0.06)] p-3 text-xs text-[#F2B937]">
            <strong>{semFila.length}</strong>{' '}
            {semFila.length === 1 ? 'operador não está em nenhuma fila — só vê' : 'operadores não estão em nenhuma fila — só veem'}{' '}
            conversas atribuídas diretamente. Marque as filas abaixo.
          </div>
        )}
      </section>

      {/* Filas */}
      <section className="space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-bold text-display">Filas de atendimento</h2>
            <p className="text-sm text-[var(--color-text-secondary)] max-w-2xl">
              A conversa entra na fila do número por onde chegou. Quem é da fila vê os
              atendimentos disponíveis; ao assumir, a conversa passa a ter responsável.
            </p>
          </div>
          {isAdmin && (
            <Button variant="outline" onClick={() => setNovaFila(true)}>
              <Plus className="h-4 w-4" /> Nova fila
            </Button>
          )}
        </div>

        <div className="space-y-2">
          {queues.map((q) => {
            const doQueue = membership[q.id] ?? new Set<string>();
            const canaisDaFila = channels.filter((c) => c.queue_id === q.id);
            return (
              <div key={q.id} className="glass-card rounded-xl p-3 space-y-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: q.color ?? 'var(--accent-primary)' }} />
                  <span className="font-semibold text-sm">{q.name}</span>
                  {q.is_default && (
                    <span className="rounded-full bg-[rgba(14,154,160,0.15)] px-1.5 py-0.5 text-[0.6rem] font-semibold text-[var(--accent-primary)]">
                      padrão
                    </span>
                  )}
                  <span className="text-[0.65rem] text-[var(--color-text-secondary)]">
                    {doQueue.size} {doQueue.size === 1 ? 'membro' : 'membros'}
                    {canaisDaFila.length > 0 && ` · ${canaisDaFila.length} canal`}
                  </span>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => setEditandoFila(q)}
                      aria-label="Editar fila"
                      className="ml-auto rounded-lg p-1 hover:bg-white/5"
                    >
                      <Settings2 className="h-3.5 w-3.5 text-[var(--color-text-secondary)]" />
                    </button>
                  )}
                </div>

                {q.description && <p className="text-xs text-[var(--color-text-secondary)]">{q.description}</p>}

                {operadores.length === 0 ? (
                  <p className="text-xs text-[var(--color-text-secondary)] opacity-70">
                    Nenhum operador cadastrado ainda.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {operadores.map((m) => {
                      const dentro = doQueue.has(m.user_id);
                      return (
                        <button
                          key={m.user_id}
                          type="button"
                          disabled={!isAdmin}
                          onClick={() => void toggleMembro(q.id, m.user_id, !dentro)}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[0.7rem] font-semibold transition-colors disabled:opacity-60',
                            dentro
                              ? 'border-[var(--accent-primary)] bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]'
                              : 'border-[rgba(14,154,160,0.2)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]',
                          )}
                        >
                          {m.display_name ?? m.email ?? '—'}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Canais → fila */}
      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-bold text-display">Números e canais</h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Define para qual fila vai cada conversa nova, conforme o número por onde ela chega.
          </p>
        </div>
        {channels.length === 0 ? (
          <p className="text-sm text-[var(--color-text-secondary)]">
            Nenhum canal conectado. Configure em Configurações → Canais.
          </p>
        ) : (
          <div className="space-y-2">
            {channels.map((c) => (
              <div key={c.id} className="glass-card rounded-xl p-3 flex items-center gap-3 flex-wrap">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold truncate">{c.label ?? 'Sem nome'}</div>
                  <div className="text-[0.65rem] uppercase tracking-wide text-[var(--color-text-secondary)]">{c.provider}</div>
                </div>
                <select
                  value={c.queue_id ?? ''}
                  disabled={!isAdmin}
                  onChange={(e) => void mudarCanalFila(c.id, e.target.value)}
                  className="rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-2 py-1.5 text-xs text-[var(--color-text-primary)] disabled:opacity-60"
                >
                  <option value="">Sem fila</option>
                  {queues.map((q) => (
                    <option key={q.id} value={q.id}>{q.name}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </section>

      {convidando && <ConviteDialog onClose={() => setConvidando(false)} onDone={() => { setConvidando(false); void load(); }} />}
      {novaFila && <FilaDialog onClose={() => setNovaFila(false)} onDone={() => { setNovaFila(false); void load(); }} />}
      {editandoFila && (
        <FilaDialog fila={editandoFila} onClose={() => setEditandoFila(null)} onDone={() => { setEditandoFila(null); void load(); }} />
      )}
    </div>
  );
}

function ConviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { userId } = useAppUser();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [enviando, setEnviando] = useState(false);

  const enviar = async () => {
    const e = email.trim();
    if (!e || !e.includes('@')) { toast.error('Informe um e-mail válido.'); return; }
    setEnviando(true);
    const { data, error } = await getSupabase().functions.invoke('invite-team-member', {
      body: { email: e, role, app_url: window.location.origin },
    });
    setEnviando(false);
    const erro = (data as { ok?: boolean; error?: string } | null)?.ok === false || error
      ? await extractFunctionErrorMessage(error, (data as { error?: string } | null)?.error)
      : null;
    if (erro) { toast.error('Não consegui convidar.', { description: erro }); return; }
    const { data: authData } = await getSupabase().auth.getUser();
    void logAudit({
      actorId: userId, actorEmail: authData?.user?.email ?? null, action: 'team_invite',
      entityType: 'app_users', meta: { invited_email: e, role },
    });
    toast.success('Convite enviado.', { description: 'A pessoa define a senha pelo link do e-mail.' });
    onDone();
  };

  return (
    <Dialog open onClose={onClose} title="Convidar membro">
      <div className="space-y-3">
        <div>
          <Label htmlFor="inv-email">E-mail</Label>
          <Input id="inv-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pessoa@amaipark.com" />
        </div>
        <div>
          <Label htmlFor="inv-role">Papel</Label>
          <select
            id="inv-role"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="w-full rounded-lg border border-[rgba(14,154,160,0.2)] bg-white/[0.03] px-3 py-2 text-sm text-[var(--color-text-primary)]"
          >
            <option value="operator">Operador — vê só as filas dele</option>
            <option value="admin">Administrador — vê tudo</option>
          </select>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)]">
          Depois de aceitar, marque as filas dele na seção Filas.
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void enviar()} disabled={enviando}>
          {enviando ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Mail className="h-4 w-4" /> Enviar convite</>}
        </Button>
      </div>
    </Dialog>
  );
}

function FilaDialog({ fila, onClose, onDone }: { fila?: Queue; onClose: () => void; onDone: () => void }) {
  const editando = Boolean(fila);
  const [name, setName] = useState(fila?.name ?? '');
  const [description, setDescription] = useState(fila?.description ?? '');
  const [salvando, setSalvando] = useState(false);

  const salvar = async () => {
    if (!name.trim()) { toast.error('Dê um nome à fila.'); return; }
    setSalvando(true);
    const supabase = getSupabase();
    const payload = { name: name.trim(), description: description.trim() || null };
    const { error } = editando
      ? await supabase.from('queues').update(payload).eq('id', fila!.id)
      : await supabase.from('queues').insert({ ...payload, position: Date.now() });
    setSalvando(false);
    if (error) { toast.error('Não consegui salvar.', { description: error.message }); return; }
    toast.success(editando ? 'Fila atualizada.' : 'Fila criada.');
    onDone();
  };

  const excluir = async () => {
    if (!fila) return;
    if (fila.is_default) { toast.error('A fila padrão não pode ser excluída.'); return; }
    if (!confirm(`Excluir a fila "${fila.name}"? As conversas dela ficam sem fila.`)) return;
    const { error } = await getSupabase().from('queues').delete().eq('id', fila.id);
    if (error) { toast.error('Não consegui excluir.', { description: error.message }); return; }
    toast.success('Fila excluída.');
    onDone();
  };

  return (
    <Dialog open onClose={onClose} title={editando ? `Editar: ${fila!.name}` : 'Nova fila'}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="q-name">Nome</Label>
          <Input id="q-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Jurídico" />
        </div>
        <div>
          <Label htmlFor="q-desc">Descrição</Label>
          <Input id="q-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="O que entra nesta fila" />
        </div>
      </div>
      <div className="flex items-center justify-between pt-4">
        {editando && !fila!.is_default ? (
          <Button variant="outline" onClick={() => void excluir()}>
            <Trash2 className="h-4 w-4 text-[#EF4444]" />
          </Button>
        ) : <span />}
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancelar</Button>
          <Button onClick={() => void salvar()} disabled={salvando}>
            {salvando ? 'Salvando...' : 'Salvar'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
