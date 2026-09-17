import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, CheckCircle2, Copy, FileText, History, Loader2, Play, Plus, Send, Trash2, X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog } from '@/components/ui/dialog';
import { getSupabase } from '@/lib/supabase';
import { useAuth } from '@/app/providers/AuthProvider';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { cn } from '@/lib/utils';

interface Profile {
  id: string;
  name: string;
  description: string | null;
  body: string;
  status: 'draft' | 'active' | 'archived';
  is_active: boolean;
  updated_at: string;
}

interface Activation {
  id: string;
  profile_name: string;
  previous_name: string | null;
  note: string | null;
  activated_at: string;
}

interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  actions?: { handoff: boolean; media: string[] };
}

const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function AIAgentProfiles() {
  const { session } = useAuth();
  const { role } = useAppUser();
  const isAdmin = role === 'admin';

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [testing, setTesting] = useState<Profile | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    const supabase = getSupabase();
    const [{ data: pData, error: pErr }, { data: aData }] = await Promise.all([
      supabase.from('ai_agent_profiles').select('id, name, description, body, status, is_active, updated_at').order('is_active', { ascending: false }).order('name'),
      supabase.from('ai_agent_profile_activations').select('id, profile_name, previous_name, note, activated_at').order('activated_at', { ascending: false }).limit(50),
    ]);
    if (pErr) toast.error('Não foi possível carregar os modelos.', { description: pErr.message });
    setProfiles((pData ?? []) as Profile[]);
    setActivations((aData ?? []) as Activation[]);
    setLoading(false);
  };

  useEffect(() => { void load(); }, []);

  const activate = async (p: Profile) => {
    if (!confirm(`Ativar "${p.name}"?\n\nA AMAIA passa a usar este modelo em TODOS os atendimentos reais imediatamente.`)) return;
    const supabase = getSupabase();
    const { error } = await supabase.rpc('activate_agent_profile', { p_profile_id: p.id, p_note: null });
    if (error) {
      toast.error('Não foi possível ativar.', { description: error.message });
      return;
    }
    toast.success(`"${p.name}" agora está ativo.`);
    void load();
  };

  const duplicate = async (p: Profile) => {
    const supabase = getSupabase();
    const { error } = await supabase.from('ai_agent_profiles').insert({
      name: `${p.name} (cópia)`,
      description: p.description,
      body: p.body,
      status: 'draft',
      is_active: false,
    });
    if (error) {
      toast.error('Não foi possível duplicar.', { description: error.message });
      return;
    }
    toast.success('Modelo duplicado como rascunho.');
    void load();
  };

  const remove = async (p: Profile) => {
    if (p.is_active) {
      toast.error('Não dá para excluir o modelo ativo.', { description: 'Ative outro modelo antes.' });
      return;
    }
    if (!confirm(`Excluir "${p.name}"? Esta ação não pode ser desfeita.`)) return;
    const supabase = getSupabase();
    const { error } = await supabase.from('ai_agent_profiles').delete().eq('id', p.id);
    if (error) {
      toast.error('Não foi possível excluir.', { description: error.message });
      return;
    }
    toast.success('Modelo excluído.');
    void load();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-bold text-display">Modelos operacionais</h2>
          <p className="text-sm text-[var(--color-text-secondary)] max-w-2xl">
            O prompt final da AMAIA é montado assim: <strong>Base Global</strong> (regras
            permanentes, na aba Agente) + <strong>modelo ativo</strong> (abaixo) +{' '}
            <strong>variáveis</strong> + histórico da conversa. Só um modelo fica ativo por vez.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4 mr-1.5" /> Histórico
          </Button>
          {isAdmin && (
            <Button onClick={() => setEditing({ id: '', name: '', description: '', body: '', status: 'draft', is_active: false, updated_at: '' })}>
              <Plus className="h-4 w-4 mr-1.5" /> Novo modelo
            </Button>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : profiles.length === 0 ? (
        <div className="glass-card rounded-xl p-6 text-center">
          <p className="text-sm text-[var(--color-text-secondary)] mb-3">Nenhum modelo cadastrado ainda.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {profiles.map((p) => (
            <div key={p.id} className={cn('glass-card rounded-xl p-4', p.is_active && 'ring-1 ring-[var(--accent-primary)]')}>
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-display">{p.name}</span>
                    {p.is_active ? (
                      <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-bold bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]">
                        <CheckCircle2 className="h-3 w-3" /> ATIVO
                      </span>
                    ) : (
                      <span className="rounded-full px-2 py-0.5 text-[0.65rem] font-bold bg-[rgba(242,185,55,0.18)] text-[#F2B937]">
                        RASCUNHO
                      </span>
                    )}
                  </div>
                  {p.description && (
                    <p className="mt-1 text-xs text-[var(--color-text-secondary)] max-w-2xl">{p.description}</p>
                  )}
                  {p.updated_at && (
                    <p className="mt-1 text-[0.7rem] text-[var(--color-text-secondary)] opacity-70">
                      Editado em {fmtDateTime(p.updated_at)}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Button variant="outline" size="sm" onClick={() => setTesting(p)}>
                    <Play className="h-3.5 w-3.5 mr-1" /> Testar
                  </Button>
                  {isAdmin && (
                    <>
                      <Button variant="outline" size="sm" onClick={() => setEditing(p)}>Editar</Button>
                      <Button variant="outline" size="sm" onClick={() => void duplicate(p)}>
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      {!p.is_active && (
                        <>
                          <Button size="sm" onClick={() => void activate(p)}>Ativar</Button>
                          <Button variant="outline" size="sm" onClick={() => void remove(p)}>
                            <Trash2 className="h-3.5 w-3.5 text-[#EF4444]" />
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <ProfileEditor
          profile={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}

      {testing && session && (
        <ProfileTester
          profile={testing}
          accessToken={session.access_token}
          onClose={() => setTesting(null)}
        />
      )}

      {historyOpen && (
        <Dialog open onClose={() => setHistoryOpen(false)} title="Histórico de ativações" widthClass="max-w-2xl">
          {activations.length === 0 ? (
            <p className="text-sm text-[var(--color-text-secondary)]">Nenhuma ativação registrada ainda.</p>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-auto">
              {activations.map((a) => (
                <div key={a.id} className="rounded-lg border border-[var(--color-border-soft)] p-3 text-sm">
                  <div className="font-semibold">{a.profile_name}</div>
                  <div className="text-xs text-[var(--color-text-secondary)]">
                    {a.previous_name ? `Substituiu: ${a.previous_name}` : 'Primeira ativação'} · {fmtDateTime(a.activated_at)}
                  </div>
                  {a.note && <div className="mt-1 text-xs italic opacity-80">{a.note}</div>}
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function ProfileEditor({ profile, onClose, onSaved }: { profile: Profile; onClose: () => void; onSaved: () => void }) {
  const isNew = !profile.id;
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? '');
  const [body, setBody] = useState(profile.body);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) { toast.error('Dê um nome ao modelo.'); return; }
    if (!body.trim()) { toast.error('O modelo não pode ficar vazio.'); return; }
    setSaving(true);
    const supabase = getSupabase();
    const payload = { name: name.trim(), description: description.trim() || null, body };
    const { error } = isNew
      ? await supabase.from('ai_agent_profiles').insert({ ...payload, status: 'draft', is_active: false })
      : await supabase.from('ai_agent_profiles').update(payload).eq('id', profile.id);
    setSaving(false);
    if (error) { toast.error('Não foi possível salvar.', { description: error.message }); return; }
    toast.success(isNew ? 'Modelo criado.' : 'Modelo salvo.');
    onSaved();
  };

  return (
    <Dialog open onClose={onClose} title={isNew ? 'Novo modelo' : `Editar: ${profile.name}`} widthClass="max-w-3xl" opaque>
      <div className="space-y-3">
        {profile.is_active && (
          <div className="flex items-start gap-2 rounded-lg bg-[rgba(242,185,55,0.12)] p-3 text-xs text-[#F2B937]">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>Este modelo está <strong>ATIVO</strong>. Ao salvar, a mudança vale imediatamente para todos os atendimentos reais.</span>
          </div>
        )}
        <div>
          <Label htmlFor="p-name">Nome</Label>
          <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="AMAIA — Nova fase" />
        </div>
        <div>
          <Label htmlFor="p-desc">Descrição (opcional)</Label>
          <Input id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Quando este modelo deve ser usado" />
        </div>
        <div>
          <Label htmlFor="p-body">Conteúdo do modelo</Label>
          <p className="mb-1 text-xs text-[var(--color-text-secondary)]">
            Só o comportamento desta fase. Regras permanentes ficam na Base Global (aba Agente).
            Use <code>{'{variavel}'}</code> para dados dinâmicos.
          </p>
          <textarea
            id="p-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={18}
            className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm font-mono"
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button variant="outline" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Salvar'}
        </Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sandbox: "Ver prompt montado" + "Testar com a AMAIA"
// ---------------------------------------------------------------------------
function ProfileTester({ profile, accessToken, onClose }: { profile: Profile; accessToken: string; onClose: () => void }) {
  const [tab, setTab] = useState<'preview' | 'chat'>('preview');
  const [preview, setPreview] = useState<string>('');
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const call = async (payload: Record<string, unknown>) => {
    const url = `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1/test-agent-profile`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_id: profile.id, ...payload }),
    });
    return res.json();
  };

  useEffect(() => {
    void (async () => {
      setLoadingPreview(true);
      const d = await call({ mode: 'preview' });
      if (d?.ok) {
        setPreview(d.system_prompt ?? '');
        setUnresolved(d.unresolved_variables ?? []);
      } else {
        toast.error('Não foi possível montar o prompt.', { description: d?.error });
      }
      setLoadingPreview(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  const send = async () => {
    const msg = input.trim();
    if (!msg) return;
    setInput('');
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [...t, { role: 'user', content: msg }]);
    setSending(true);
    const d = await call({ mode: 'chat', message: msg, history });
    setSending(false);
    if (!d?.ok) {
      toast.error('A IA não respondeu.', { description: d?.error });
      return;
    }
    setTurns((t) => [...t, { role: 'assistant', content: d.reply ?? '', actions: d.simulated_actions }]);
  };

  return (
    <Dialog open onClose={onClose} title={`Testar: ${profile.name}`} widthClass="max-w-3xl" opaque>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className={cn(
          'rounded-full px-2 py-0.5 text-[0.65rem] font-bold',
          profile.is_active
            ? 'bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]'
            : 'bg-[rgba(242,185,55,0.18)] text-[#F2B937]',
        )}>
          {profile.is_active ? 'ATIVO' : 'RASCUNHO'}
        </span>
        <span className="text-xs text-[var(--color-text-secondary)]">
          Modo de teste — nada é enviado ao WhatsApp e nenhum registro real é alterado.
        </span>
      </div>

      <div className="flex gap-1 mb-3">
        <button
          type="button"
          onClick={() => setTab('preview')}
          className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold', tab === 'preview' ? 'bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)]')}
        >
          <FileText className="h-3.5 w-3.5 inline mr-1" /> Ver prompt montado
        </button>
        <button
          type="button"
          onClick={() => setTab('chat')}
          className={cn('rounded-lg px-3 py-1.5 text-xs font-semibold', tab === 'chat' ? 'bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]' : 'text-[var(--color-text-secondary)]')}
        >
          <Play className="h-3.5 w-3.5 inline mr-1" /> Testar com a AMAIA
        </button>
      </div>

      {unresolved.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-[rgba(242,185,55,0.12)] p-3 text-xs text-[#F2B937] mb-3">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Variáveis sem valor: <strong>{unresolved.join(', ')}</strong>. Preencha na aba Agente antes de ativar este modelo.
          </span>
        </div>
      )}

      {tab === 'preview' ? (
        <div>
          {loadingPreview ? (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <Loader2 className="h-4 w-4 animate-spin" /> Montando...
            </div>
          ) : (
            <>
              <p className="mb-2 text-xs text-[var(--color-text-secondary)]">
                Base Global + este modelo + variáveis. É exatamente o que a IA recebe.
              </p>
              <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border-soft)] p-3 text-[0.7rem] leading-relaxed">
                {preview}
              </pre>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => { void navigator.clipboard.writeText(preview); toast.success('Copiado.'); }}
              >
                <Copy className="h-3.5 w-3.5 mr-1" /> Copiar
              </Button>
            </>
          )}
        </div>
      ) : (
        <div>
          <div className="min-h-[240px] max-h-[45vh] overflow-auto rounded-lg border border-[var(--color-border-soft)] p-3 space-y-3">
            {turns.length === 0 && (
              <p className="text-xs text-[var(--color-text-secondary)]">
                Escreva como se fosse um cliente no WhatsApp e veja como a AMAIA responderia.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={cn('max-w-[85%] rounded-lg px-3 py-2 text-sm', t.role === 'user' ? 'ml-auto bg-[rgba(14,154,160,0.15)]' : 'bg-[rgba(255,255,255,0.05)]')}>
                <div className="whitespace-pre-wrap">{t.content}</div>
                {t.actions && (t.actions.handoff || t.actions.media.length > 0) && (
                  <div className="mt-2 space-y-1 border-t border-[var(--color-border-divider)] pt-2">
                    {t.actions.handoff && (
                      <div className="text-[0.7rem] text-[#F2B937]">
                        ⚠ Em produção, transferiria para um atendente humano (não executado no teste).
                      </div>
                    )}
                    {t.actions.media.length > 0 && (
                      <div className="text-[0.7rem] text-[#F2B937]">
                        ⚠ Em produção, enviaria a mídia: {t.actions.media.join(', ')} (não executado).
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> AMAIA está escrevendo...
              </div>
            )}
          </div>
          <div className="flex gap-2 mt-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
              placeholder="Ex: quanto custa o passaporte?"
              disabled={sending}
            />
            <Button onClick={() => void send()} disabled={sending || !input.trim()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center justify-between mt-2">
            <p className="text-[0.7rem] text-[var(--color-text-secondary)] opacity-70">
              Os testes utilizam a API de IA e podem gerar consumo de tokens.
            </p>
            {turns.length > 0 && (
              <button type="button" onClick={() => setTurns([])} className="text-[0.7rem] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
                <X className="h-3 w-3 inline" /> Limpar conversa
              </button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
