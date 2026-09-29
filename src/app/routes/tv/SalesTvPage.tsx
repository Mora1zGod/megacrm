import { useCallback, useEffect, useRef, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Maximize2, Volume2, VolumeX } from 'lucide-react';
import { useMonthRevenue, type MonthSale } from '@/hooks/useSales';
import { operatorLabel, useOperators } from '@/hooks/useOperators';
import { useAppUser } from '@/app/providers/AppUserProvider';
import { Avatar } from '@/components/ui/Avatar';
import { formatBRL, formatBRLShort } from '@/lib/sales';

// ============================================================================
// Painel TV de vendas — tela cheia para deixar numa TV da equipe.
// Meta do mês, vendido, ranking de vendedores, vendas por dia e as últimas
// vendas. Quando entra uma venda nova (realtime), mostra a comemoração e,
// se o som estiver ligado, toca um "caixa registradora" sintetizado.
// ============================================================================

function playCashSound(ctx: AudioContext) {
  const now = ctx.currentTime;
  const tone = (freq: number, start: number, dur: number, gain: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(freq, now + start);
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.exponentialRampToValueAtTime(gain, now + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    o.connect(g).connect(ctx.destination);
    o.start(now + start);
    o.stop(now + start + dur + 0.05);
  };
  tone(1318.5, 0, 0.18, 0.25); // E6
  tone(1760, 0.09, 0.5, 0.3); // A6
  tone(2637, 0.09, 0.35, 0.12);
}

export default function SalesTvPage() {
  const { orgName, orgLogoUrl } = useAppUser();
  const { operators } = useOperators();
  const [celebrate, setCelebrate] = useState<MonthSale | null>(null);
  const [soundOn, setSoundOn] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  const soundRef = useRef(false);
  soundRef.current = soundOn;
  const [now, setNow] = useState(new Date());

  const onNewSale = useCallback((sale: MonthSale) => {
    setCelebrate(sale);
    if (soundRef.current && audioRef.current) {
      try { playCashSound(audioRef.current); } catch { /* áudio indisponível */ }
    }
    window.setTimeout(() => setCelebrate((cur) => (cur?.id === sale.id ? null : cur)), 7000);
  }, []);

  const { data, loading } = useMonthRevenue({ onNewSale });

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const toggleSound = () => {
    // O navegador só libera áudio depois de um clique na página.
    if (!audioRef.current) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioRef.current = new Ctx();
    }
    void audioRef.current.resume();
    setSoundOn((v) => {
      if (!v && audioRef.current) playCashSound(audioRef.current);
      return !v;
    });
  };

  const fullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };

  const op = (id: string | null) => operators.find((o) => o.user_id === id);
  const nameOf = (id: string | null) => (id ? operatorLabel(op(id)) || 'Vendedor' : 'Sem vendedor');
  const pct = data.goal ? Math.min(100, (data.sold / data.goal) * 100) : 0;
  const monthName = now.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  const today = now.getDate();

  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--color-bg-primary)] p-4 text-[var(--color-text-primary)] sm:p-8">
      {/* Topo */}
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {orgLogoUrl ? <img src={orgLogoUrl} alt="" className="h-12 w-12 rounded-xl object-contain" /> : null}
          <div className="min-w-0">
            <div className="truncate text-2xl font-bold sm:text-3xl">{orgName ?? 'Vendas'}</div>
            <div className="text-sm capitalize text-[var(--color-text-secondary)] sm:text-base">Vendas de {monthName}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden text-3xl font-semibold tabular-nums text-[var(--color-text-secondary)] sm:block">
            {now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </div>
          <button type="button" onClick={toggleSound} className="rounded-xl border border-[var(--color-border-card)] p-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-label={soundOn ? 'Desligar som' : 'Ligar som'} title={soundOn ? 'Desligar som' : 'Ligar som de venda'}>
            {soundOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          </button>
          <button type="button" onClick={fullscreen} className="rounded-xl border border-[var(--color-border-card)] p-3 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]" aria-label="Tela cheia" title="Tela cheia">
            <Maximize2 className="h-5 w-5" />
          </button>
        </div>
      </header>

      {loading ? (
        <div className="grid h-[60vh] place-items-center text-xl text-[var(--color-text-secondary)]">Carregando…</div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr] xl:gap-6">
          <div className="space-y-4 xl:space-y-6">
            {/* Número grande + meta */}
            <section className="rounded-3xl border border-[var(--color-border-card)] bg-[var(--color-surface)] p-6 sm:p-8">
              <div className="text-base font-medium text-[var(--color-text-secondary)] sm:text-lg">Vendido no mês</div>
              <div className="mt-1 text-5xl font-extrabold tabular-nums tracking-tight sm:text-7xl">{formatBRL(data.sold)}</div>
              <div className="mt-2 text-base text-[var(--color-text-secondary)] sm:text-lg">
                {data.salesCount} {data.salesCount === 1 ? 'venda' : 'vendas'}
                {data.goal ? <> · meta {formatBRL(data.goal)}</> : null}
              </div>
              {data.goal ? (
                <div className="mt-6">
                  <div className="h-6 overflow-hidden rounded-full bg-[var(--color-surface-hover)]">
                    <div className="h-full rounded-full bg-[var(--color-success)] transition-[width] duration-1000" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 flex justify-between text-base font-semibold sm:text-xl">
                    <span>{Math.floor(pct)}%</span>
                    <span className="text-[var(--color-text-secondary)]">
                      {pct >= 100 ? 'Meta batida! 🎉' : `Faltam ${formatBRL(Math.max(0, data.goal - data.sold))}`}
                    </span>
                  </div>
                </div>
              ) : null}
            </section>

            {/* Vendas por dia */}
            <section className="rounded-3xl border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 sm:p-6">
              <div className="mb-2 text-base font-semibold sm:text-lg">Vendas por dia</div>
              <div className="h-48 sm:h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.daily.filter((d) => d.day <= today)}>
                    <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: 'var(--color-text-muted)', fontSize: 12 }} />
                    <Tooltip
                      cursor={{ fill: 'var(--color-surface-hover)' }}
                      contentStyle={{ background: 'var(--color-surface-raised)', border: '1px solid var(--color-border-card)', borderRadius: 12, color: 'var(--color-text-primary)' }}
                      formatter={(v: number) => [formatBRL(v), 'Vendido']}
                      labelFormatter={(d) => `Dia ${d}`}
                    />
                    <Bar dataKey="value" fill="var(--color-accent-secondary)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          <div className="space-y-4 xl:space-y-6">
            {/* Ranking */}
            <section className="rounded-3xl border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 sm:p-6">
              <div className="mb-3 text-base font-semibold sm:text-lg">Ranking de vendedores</div>
              {data.ranking.length === 0 ? (
                <div className="py-6 text-center text-[var(--color-text-secondary)]">Nenhuma venda este mês ainda.</div>
              ) : (
                <ol className="space-y-2">
                  {data.ranking.slice(0, 6).map((r, i) => (
                    <li key={r.owner_id ?? 'none'} className={`flex items-center gap-3 rounded-2xl p-3 ${i === 0 ? 'bg-[var(--color-accent-subtle)]' : ''}`}>
                      <span className="w-8 text-center text-2xl font-bold">{['🥇', '🥈', '🥉'][i] ?? `${i + 1}º`}</span>
                      <Avatar src={op(r.owner_id)?.avatar_url ?? null} name={nameOf(r.owner_id)} size="md" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-base font-semibold sm:text-lg">{nameOf(r.owner_id)}</div>
                        <div className="text-sm text-[var(--color-text-secondary)]">{r.count} {r.count === 1 ? 'venda' : 'vendas'}</div>
                      </div>
                      <div className="text-lg font-bold tabular-nums sm:text-xl">{formatBRLShort(r.value)}</div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            {/* Últimas vendas */}
            <section className="rounded-3xl border border-[var(--color-border-card)] bg-[var(--color-surface)] p-4 sm:p-6">
              <div className="mb-3 text-base font-semibold sm:text-lg">Últimas vendas</div>
              {data.recent.length === 0 ? (
                <div className="py-4 text-center text-[var(--color-text-secondary)]">—</div>
              ) : (
                <ul className="space-y-2">
                  {data.recent.slice(0, 5).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-sm sm:text-base">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{s.contact_name || s.title}</div>
                        <div className="truncate text-xs text-[var(--color-text-muted)] sm:text-sm">
                          {nameOf(s.owner_id)} · {new Date(s.won_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}
                        </div>
                      </div>
                      <div className="shrink-0 font-semibold tabular-nums">{formatBRL(s.value)}</div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      {/* Comemoração de venda nova */}
      {celebrate && (
        <div className="fade-in fixed inset-0 z-50 grid place-items-center bg-black/70 p-6" onClick={() => setCelebrate(null)}>
          <div className="fade-scale-in rounded-3xl border border-[var(--color-success)] bg-[var(--color-surface-raised)] px-10 py-10 text-center shadow-[var(--shadow-lg)]">
            <div className="text-7xl">🎉</div>
            <div className="mt-4 text-2xl font-semibold text-[var(--color-text-secondary)]">Nova venda!</div>
            <div className="mt-2 text-6xl font-extrabold tabular-nums text-[var(--color-success)]">{formatBRL(celebrate.value)}</div>
            <div className="mt-4 text-2xl font-semibold">{nameOf(celebrate.owner_id)}</div>
            {celebrate.contact_name && <div className="mt-1 text-lg text-[var(--color-text-secondary)]">{celebrate.contact_name}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
