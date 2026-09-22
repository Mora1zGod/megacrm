import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Briefcase, CalendarDays, ChevronLeft, ChevronRight, List, MessageSquare, Plus, User, X } from 'lucide-react';
import { getSupabase } from '@/lib/supabase';
import { cn } from '@/lib/utils';
import { LoadErrorBanner } from '@/components/LoadErrorBanner';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

type VisitsView = 'agenda' | 'lista';

interface ContactLite {
  id: string;
  name: string | null;
  phone: string | null;
}

interface Visit {
  id: string;
  contact_id: string;
  visit_date: string;
  visit_time: string;
  party_size: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  notes: string | null;
  contact?: ContactLite;
}

const STATUS_STYLE: Record<Visit['status'], { label: string; className: string }> = {
  pending: { label: 'Aguardando', className: 'bg-[rgba(148,163,184,0.18)] text-[var(--color-text-secondary)]' },
  confirmed: { label: 'Confirmada', className: 'bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]' },
  completed: { label: 'Concluída', className: 'bg-[rgba(16,185,129,0.18)] text-[#10B981]' },
  cancelled: { label: 'Cancelada', className: 'bg-[rgba(239,68,68,0.18)] text-[#EF4444]' },
  no_show: { label: 'Não compareceu', className: 'bg-[rgba(242,185,55,0.18)] text-[#F2B937]' },
};

const WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() - copy.getDay());
  copy.setHours(0, 0, 0, 0);
  return copy;
}

export default function VisitsPage() {
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(() => new Date());
  const [visits, setVisits] = useState<Visit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailVisit, setDetailVisit] = useState<Visit | null>(null);
  const [reagendarVisit, setReagendarVisit] = useState<Visit | null>(null);
  const [view, setView] = useState<VisitsView>('agenda');
  const [todayCount, setTodayCount] = useState<number | null>(null);

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);
      return d;
    }),
    [weekStart],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    const supabase = getSupabase();
    const from = toISODate(weekDays[0]);
    const to = toISODate(weekDays[6]);
    const { data, error: err } = await supabase
      .from('park_visits')
      .select('id, contact_id, visit_date, visit_time, party_size, status, notes, contacts(id, name, phone)')
      .gte('visit_date', from)
      .lte('visit_date', to)
      .order('visit_time', { ascending: true });
    if (err) {
      setError(err.message);
      setLoading(false);
      return;
    }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      contact_id: r.contact_id as string,
      visit_date: r.visit_date as string,
      visit_time: r.visit_time as string,
      party_size: r.party_size as number,
      status: r.status as Visit['status'],
      notes: r.notes as string | null,
      contact: r.contacts as ContactLite | undefined,
    }));
    setVisits(rows);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStart.getTime()]);

  // Visitas hoje — independente da semana em navegação (KPI sempre real).
  useEffect(() => {
    const today = toISODate(new Date());
    void getSupabase()
      .from('park_visits')
      .select('id', { count: 'exact', head: true })
      .eq('visit_date', today)
      .then(({ count }) => setTodayCount(count ?? 0));
  }, []);

  // KPIs da semana em navegação — só dado real, sem tendência % inventada.
  const kpis = useMemo(() => {
    const pessoas = visits.reduce((s, v) => s + (v.party_size || 0), 0);
    const passadas = visits.filter((v) => v.status === 'completed' || v.status === 'no_show');
    const compareceu = visits.filter((v) => v.status === 'completed').length;
    const taxaComparecimento = passadas.length > 0 ? (compareceu / passadas.length) * 100 : null;
    return { totalSemana: visits.length, pessoas, taxaComparecimento };
  }, [visits]);

  const visitsByDay = useMemo(() => {
    const map = new Map<string, Visit[]>();
    for (const v of visits) {
      const key = v.visit_date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(v);
    }
    return map;
  }, [visits]);

  const updateStatus = async (visit: Visit, status: Visit['status']) => {
    const supabase = getSupabase();
    const { error: err } = await supabase.from('park_visits').update({ status }).eq('id', visit.id);
    if (err) {
      toast.error('Não foi possível atualizar a visita.', { description: err.message });
      return;
    }
    toast.success(status === 'cancelled' ? 'Visita cancelada.' : 'Visita atualizada.');
    setDetailVisit(null);
    void load();
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl glass-card flex items-center justify-center">
            <CalendarDays className="h-5 w-5 text-[var(--accent-primary)]" />
          </div>
          <div>
            <div className="text-label">Seção</div>
            <h1 className="text-2xl font-bold text-display">Visitas</h1>
            <p className="text-sm text-[var(--color-text-secondary)]">Agendamento e lembretes automáticos</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold text-white"
          style={{ background: 'var(--cta)' }}
        >
          <Plus className="h-4 w-4" />
          Nova visita
        </button>
      </div>

      {error && <LoadErrorBanner message={error} onRetry={() => void load()} />}

      {/* KPIs — só dado real, sem tendência % inventada */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{todayCount === null ? '…' : todayCount}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Visitas hoje</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{kpis.totalSemana}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Visitas esta semana</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{kpis.taxaComparecimento === null ? '—' : `${kpis.taxaComparecimento.toFixed(0)}%`}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Taxa de comparecimento</div>
        </div>
        <div className="glass-card p-3">
          <div className="text-lg font-bold text-[var(--color-text-primary)]">{kpis.pessoas}</div>
          <div className="text-xs text-[var(--color-text-secondary)]">Visitantes (pessoas) na semana</div>
        </div>
      </div>

      {/* Abas de visualização */}
      <div className="flex items-center gap-1 rounded-lg border border-[rgba(14,154,160,0.12)] p-1 bg-[var(--color-fill-subtle)] w-fit">
        {([
          ['agenda', 'Agenda', CalendarDays],
          ['lista', 'Lista', List],
        ] as [VisitsView, string, typeof CalendarDays][]).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
              view === id ? 'bg-[var(--accent-primary)] text-white' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            <Icon className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
      </div>

      {view === 'lista' ? (
        <VisitsListView visits={visits} onOpen={setDetailVisit} />
      ) : (
      <div className="glass-card rounded-2xl p-4">
        <div className="flex items-center justify-between mb-4">
          <button
            type="button"
            onClick={() => setAnchor((d) => { const n = new Date(d); n.setDate(n.getDate() - 7); return n; })}
            className="rounded-lg p-2 hover:bg-[rgba(14,154,160,0.1)]"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="text-sm font-semibold text-display">
            {weekDays[0].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })} –{' '}
            {weekDays[6].toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
          </div>
          <button
            type="button"
            onClick={() => setAnchor((d) => { const n = new Date(d); n.setDate(n.getDate() + 7); return n; })}
            className="rounded-lg p-2 hover:bg-[rgba(14,154,160,0.1)]"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-2">
          {weekDays.map((day, i) => {
            const key = toISODate(day);
            const dayVisits = visitsByDay.get(key) ?? [];
            const isToday = key === toISODate(new Date());
            return (
              <div key={key} className="min-h-[220px] rounded-xl border border-[var(--color-border-soft)] p-2">
                <div className={cn('text-center text-xs font-semibold mb-2', isToday && 'text-[var(--accent-primary)]')}>
                  {WEEKDAYS[i]} {day.getDate()}
                </div>
                <div className="space-y-1.5">
                  {loading && dayVisits.length === 0 ? (
                    <>
                      <Skeleton className="h-8" />
                      <Skeleton className="h-8" />
                    </>
                  ) : dayVisits.map((v) => {
                    // Muito contato do WhatsApp vem com nome vazio ou só emoji
                    // (o próprio perfil do cliente). Nesses casos o telefone é
                    // o único identificador útil pro operador.
                    const nome = (v.contact?.name ?? '').trim();
                    const temLetra = /\p{L}/u.test(nome);
                    const rotulo = temLetra ? nome : (v.contact?.phone ?? 'Sem nome');
                    return (
                      <button
                        key={v.id}
                        type="button"
                        onClick={() => setDetailVisit(v)}
                        className={cn(
                          'w-full text-left rounded-lg px-2 py-1.5 text-xs',
                          STATUS_STYLE[v.status].className,
                        )}
                      >
                        <div className="font-semibold truncate">{v.visit_time.slice(0, 5)} · {rotulo}</div>
                        {v.party_size > 1 && <div className="opacity-80">{v.party_size} pessoas</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {!loading && visits.length === 0 && (
          <div className="mt-3 rounded-xl border border-dashed border-[var(--color-border-soft)] p-6 text-center">
            <p className="text-sm text-[var(--color-text-secondary)] mb-2">Nenhuma visita agendada neste período.</p>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Nova visita
            </Button>
          </div>
        )}
      </div>
      )}

      {createOpen && (
        <CreateVisitDialog
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void load(); }}
        />
      )}

      {detailVisit && (
        <Dialog
          open
          onClose={() => setDetailVisit(null)}
          title={
            /\p{L}/u.test((detailVisit.contact?.name ?? '').trim())
              ? (detailVisit.contact?.name as string)
              : (detailVisit.contact?.phone ?? 'Visita')
          }
        >
          <div className="space-y-3 text-sm">
            <div><span className="text-label">Data</span> {new Date(`${detailVisit.visit_date}T00:00:00`).toLocaleDateString('pt-BR')}</div>
            <div><span className="text-label">Horário</span> {detailVisit.visit_time.slice(0, 5)}</div>
            <div><span className="text-label">Pessoas</span> {detailVisit.party_size}</div>
            <div><span className="text-label">Telefone</span> {detailVisit.contact?.phone ?? '—'}</div>
            {detailVisit.notes && <div><span className="text-label">Observações</span> {detailVisit.notes}</div>}
            <div>
              <span className="text-label">Status</span>{' '}
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_STYLE[detailVisit.status].className)}>
                {STATUS_STYLE[detailVisit.status].label}
              </span>
            </div>
            <VisitDealLink contactId={detailVisit.contact_id} />
          </div>

          <div className="flex flex-wrap gap-2 pt-3 border-t border-[rgba(14,154,160,0.1)] mt-3">
            <Button size="sm" variant="outline" onClick={() => navigate(`/contacts/${detailVisit.contact_id}`)}>
              <User className="h-3.5 w-3.5" /> Abrir contato
            </Button>
            <Button size="sm" variant="outline" onClick={() => navigate(`/inbox?contact=${detailVisit.contact_id}`)}>
              <MessageSquare className="h-3.5 w-3.5" /> Abrir conversa
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 pt-3">
            {(detailVisit.status === 'pending' || detailVisit.status === 'confirmed') && (
              <>
                {detailVisit.status === 'pending' && (
                  <button type="button" onClick={() => void updateStatus(detailVisit, 'confirmed')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(14,154,160,0.18)] text-[var(--accent-primary)]">Confirmar presença</button>
                )}
                {detailVisit.status === 'confirmed' && (
                  <button type="button" onClick={() => void updateStatus(detailVisit, 'completed')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(16,185,129,0.18)] text-[#10B981]">Marcar compareceu</button>
                )}
                <button type="button" onClick={() => void updateStatus(detailVisit, 'no_show')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(242,185,55,0.18)] text-[#F2B937]">Não compareceu</button>
                <button type="button" onClick={() => { setReagendarVisit(detailVisit); setDetailVisit(null); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[var(--color-fill-subtle)] text-[var(--color-text-primary)]">Reagendar</button>
                <button type="button" onClick={() => void updateStatus(detailVisit, 'cancelled')} className="rounded-lg px-3 py-1.5 text-xs font-semibold bg-[rgba(239,68,68,0.18)] text-[#EF4444]">Cancelar</button>
              </>
            )}
          </div>
        </Dialog>
      )}

      {reagendarVisit && (
        <ReagendarDialog
          visit={reagendarVisit}
          onClose={() => setReagendarVisit(null)}
          onSaved={() => { setReagendarVisit(null); void load(); }}
        />
      )}
    </div>
  );
}

function CreateVisitDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ContactLite[]>([]);
  const [selected, setSelected] = useState<ContactLite | null>(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('09:00');
  const [partySize, setPartySize] = useState(1);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .or(`name.ilike.%${query}%,phone.ilike.%${query}%`)
        .limit(8);
      setResults((data ?? []) as ContactLite[]);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const submit = async () => {
    if (!selected) {
      toast.error('Escolhe um contato primeiro.');
      return;
    }
    setSaving(true);
    const supabase = getSupabase();
    const { error: err } = await supabase.from('park_visits').insert({
      contact_id: selected.id,
      visit_date: date,
      visit_time: time,
      party_size: partySize,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (err) {
      toast.error('Não foi possível agendar.', { description: err.message });
      return;
    }
    toast.success('Visita agendada!');
    onCreated();
  };

  return (
    <Dialog open onClose={onClose} title="Nova visita">
      <div className="space-y-3">
          <div>
            <Label>Contato</Label>
            {selected ? (
              <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-soft)] px-3 py-2 text-sm">
                <span>{selected.name ?? selected.phone}</span>
                <button type="button" onClick={() => setSelected(null)}><X className="h-4 w-4" /></button>
              </div>
            ) : (
              <div className="relative">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Nome ou telefone..."
                  className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm"
                />
                {results.length > 0 && (
                  <div className="absolute z-10 mt-1 w-full rounded-lg border border-[var(--color-border-soft)] bg-[var(--color-bg-primary)] shadow-lg max-h-48 overflow-auto">
                    {results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => { setSelected(c); setResults([]); setQuery(''); }}
                        className="block w-full text-left px-3 py-2 text-sm hover:bg-[rgba(14,154,160,0.1)]"
                      >
                        {c.name ?? 'Sem nome'} — {c.phone}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="visit-date">Data</Label>
              <input id="visit-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
            </div>
            <div>
              <Label htmlFor="visit-time">Horário</Label>
              <input id="visit-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
            </div>
          </div>
          <div>
            <Label htmlFor="party-size">Nº de pessoas</Label>
            <input id="party-size" type="number" min={1} value={partySize} onChange={(e) => setPartySize(Number(e.target.value))} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
          <div>
            <Label htmlFor="visit-notes">Observações (opcional)</Label>
            <input id="visit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-4">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-semibold text-[var(--color-text-secondary)]">Cancelar</button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void submit()}
            className="rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: 'var(--cta)' }}
          >
            {saving ? 'Salvando...' : 'Agendar'}
          </button>
        </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Negócio vinculado — busca o negócio aberto mais recente do contato. Sem
// coluna própria de "negócio da visita" no banco; usa o mesmo critério já
// usado no Inbox (ConversationDealBar) e no Contato 360.
// ---------------------------------------------------------------------------
function VisitDealLink({ contactId }: { contactId: string }) {
  const [deal, setDeal] = useState<{ id: string; title: string; stage_id: string | null } | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void getSupabase()
      .from('deals')
      .select('id, title, stage_id')
      .eq('contact_id', contactId)
      .eq('status', 'open')
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => { if (alive) setDeal((data?.[0] as { id: string; title: string; stage_id: string | null } | undefined) ?? null); });
    return () => { alive = false; };
  }, [contactId]);

  if (deal === undefined) return null;
  if (deal === null) return <div className="text-xs text-[var(--color-text-secondary)] opacity-70">Sem negócio aberto vinculado.</div>;

  return (
    <Link to={`/funil?deal=${deal.id}`} className="flex items-center gap-1.5 text-xs font-semibold text-[var(--accent-secondary)] hover:text-[var(--accent-primary)]">
      <Briefcase className="h-3.5 w-3.5" /> {deal.title} — abrir no funil
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Reagendar — atualiza data/horário no MESMO registro (histórico da data
// anterior fica só nas observações; o banco não tem uma tabela de histórico
// de reagendamento própria, então não inventei uma).
// ---------------------------------------------------------------------------
function ReagendarDialog({ visit, onClose, onSaved }: { visit: Visit; onClose: () => void; onSaved: () => void }) {
  const [date, setDate] = useState(visit.visit_date);
  const [time, setTime] = useState(visit.visit_time.slice(0, 5));
  const [saving, setSaving] = useState(false);

  const salvar = async () => {
    setSaving(true);
    const notaAnterior = `[Reagendada de ${new Date(`${visit.visit_date}T00:00:00`).toLocaleDateString('pt-BR')} ${visit.visit_time.slice(0, 5)}]`;
    const { error } = await getSupabase()
      .from('park_visits')
      .update({
        visit_date: date,
        visit_time: time,
        status: 'pending',
        notes: [notaAnterior, visit.notes].filter(Boolean).join(' '),
      })
      .eq('id', visit.id);
    setSaving(false);
    if (error) { toast.error('Não consegui reagendar.', { description: error.message }); return; }
    toast.success('Visita reagendada.');
    onSaved();
  };

  return (
    <Dialog open onClose={onClose} title="Reagendar visita">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="reagendar-date">Nova data</Label>
            <input id="reagendar-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
          <div>
            <Label htmlFor="reagendar-time">Novo horário</Label>
            <input id="reagendar-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-full rounded-lg border border-[var(--color-border-soft)] bg-transparent px-3 py-2 text-sm" />
          </div>
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] opacity-70">
          A visita volta pro status "Aguardando" — confirme de novo com o cliente.
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-4">
        <Button type="button" variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void salvar()} loading={saving}>Reagendar</Button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Visão Lista — todas as visitas já carregadas (semana atual), em tabela.
// ---------------------------------------------------------------------------
function VisitsListView({ visits, onOpen }: { visits: Visit[]; onOpen: (v: Visit) => void }) {
  const sorted = [...visits].sort((a, b) => (a.visit_date + a.visit_time).localeCompare(b.visit_date + b.visit_time));
  if (sorted.length === 0) {
    return (
      <div className="glass-card p-6 text-center">
        <p className="text-sm text-[var(--color-text-secondary)]">Nenhuma visita nesta semana.</p>
        <p className="text-xs text-[var(--color-text-muted)] mt-1">Troque a semana no calendário acima ou agende uma nova visita.</p>
      </div>
    );
  }
  return (
    <div className="glass-card overflow-hidden p-0">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[rgba(14,154,160,0.12)] text-left text-xs text-[var(--color-text-secondary)]">
            <th className="px-4 py-2 font-medium">Data</th>
            <th className="px-4 py-2 font-medium">Horário</th>
            <th className="px-4 py-2 font-medium">Contato</th>
            <th className="px-4 py-2 font-medium">Telefone</th>
            <th className="px-4 py-2 font-medium">Pessoas</th>
            <th className="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => {
            const nome = (v.contact?.name ?? '').trim();
            const rotulo = /\p{L}/u.test(nome) ? nome : (v.contact?.phone ?? 'Sem nome');
            return (
              <tr key={v.id} onClick={() => onOpen(v)} className="cursor-pointer border-b border-[rgba(14,154,160,0.08)] last:border-0 hover:bg-[var(--color-fill-subtle)]">
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{new Date(`${v.visit_date}T00:00:00`).toLocaleDateString('pt-BR')}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{v.visit_time.slice(0, 5)}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-primary)]">{rotulo}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)] font-mono text-xs">{v.contact?.phone ?? '—'}</td>
                <td className="px-4 py-2.5 text-[var(--color-text-secondary)]">{v.party_size}</td>
                <td className="px-4 py-2.5">
                  <span className={cn('rounded-full px-2 py-0.5 text-xs font-semibold', STATUS_STYLE[v.status].className)}>
                    {STATUS_STYLE[v.status].label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
