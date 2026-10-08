// Gera a imagem (PNG) do resumo de contas para mandar no WhatsApp — mesmo visual do card:
// cabeçalho, 3 indicadores, lista de lançamentos com data, bolinha de status, nome, descrição,
// valor e selo, e a legenda. Desenhado direto no <canvas> (sem dependência).

export type BillStatus = 'overdue' | 'open' | 'partial' | 'paid';
export interface BillItem { date: string; name: string; desc: string; amount: string; status: BillStatus }
export interface BillsImage {
  title: string;
  period: string;
  company?: string | null;
  count: number;
  total: string;
  open: string;
  overdue: string;
  items: BillItem[];
}

const W = 1080;
const PAD = 40;
const FONT = '"Inter","Segoe UI",Roboto,Arial,sans-serif';
const C = {
  bg: '#F3FBF5', card: '#FFFFFF', ink: '#10231A', soft: '#5B6B63', line: '#E3EFE7', chip: '#EEF4F0',
  green: '#1F9D55', orange: '#EA6A12',
  st: {
    overdue: { dot: '#E5484D', bg: '#FDE2E3', fg: '#C21F2B', label: 'Vencida' },
    open: { dot: '#F5C431', bg: '#FFF3C9', fg: '#B45309', label: 'Em aberto' },
    partial: { dot: '#F28C38', bg: '#FFE6D2', fg: '#C2410C', label: 'Parcial' },
    paid: { dot: '#2FB45A', bg: '#DCF5E4', fg: '#15803D', label: 'Paga' },
  },
} as const;
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
// WhatsApp reduz imagem muito comprida — por isso a lista vai em várias imagens (1ª com os indicadores).
const FIRST_PAGE_ITEMS = 8;
const PAGE_ITEMS = 10;
const MAX_PAGES = 5;
export const MAX_IMAGE_ITEMS = FIRST_PAGE_ITEMS + PAGE_ITEMS * (MAX_PAGES - 1);

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}
function font(ctx: CanvasRenderingContext2D, size: number, weight = 400) { ctx.font = `${weight} ${size}px ${FONT}`; }
// Quebra em até `max` linhas; a última ganha "…" se sobrar texto.
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(t).width <= width) { cur = t; continue; }
    if (cur) lines.push(cur);
    cur = w;
    if (lines.length === max) break;
  }
  if (lines.length < max && cur) lines.push(cur);
  if (lines.length > max) lines.length = max;
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length && lines.length) {
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}
function icon(ctx: CanvasRenderingContext2D, kind: 'doc' | 'bars' | 'clock' | 'list' | 'tag', x: number, y: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (kind === 'doc') {
    ctx.moveTo(x - 10, y - 14); ctx.lineTo(x + 4, y - 14); ctx.lineTo(x + 12, y - 6); ctx.lineTo(x + 12, y + 14); ctx.lineTo(x - 10, y + 14); ctx.closePath();
    ctx.moveTo(x - 4, y); ctx.lineTo(x + 6, y); ctx.moveTo(x - 4, y + 6); ctx.lineTo(x + 6, y + 6); ctx.stroke();
  } else if (kind === 'bars') {
    ctx.moveTo(x - 8, y + 12); ctx.lineTo(x - 8, y + 2); ctx.moveTo(x, y + 12); ctx.lineTo(x, y - 10); ctx.moveTo(x + 8, y + 12); ctx.lineTo(x + 8, y - 3); ctx.stroke();
  } else if (kind === 'clock') {
    ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.moveTo(x, y - 7); ctx.lineTo(x, y); ctx.lineTo(x + 6, y + 4); ctx.stroke();
  } else if (kind === 'list') {
    for (const dy of [-8, 0, 8]) { ctx.moveTo(x - 4, y + dy); ctx.lineTo(x + 12, y + dy); }
    ctx.stroke();
    for (const dy of [-8, 0, 8]) { ctx.beginPath(); ctx.arc(x - 11, y + dy, 2, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.moveTo(x - 12, y - 12); ctx.lineTo(x + 1, y - 12); ctx.lineTo(x + 13, y); ctx.lineTo(x + 1, y + 12); ctx.lineTo(x - 12, y - 1); ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 5, y - 5, 2.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Devolve 1 a 5 PNGs (base64, sem o prefixo data:).
export async function renderBillsImages(d: BillsImage): Promise<string[]> {
  const pages: BillItem[][] = [d.items.slice(0, FIRST_PAGE_ITEMS)];
  for (let i = FIRST_PAGE_ITEMS; i < Math.min(d.items.length, MAX_IMAGE_ITEMS); i += PAGE_ITEMS) pages.push(d.items.slice(i, i + PAGE_ITEMS));
  const extra = Math.max(0, d.items.length - MAX_IMAGE_ITEMS);
  return pages.map((items, i) => renderPage(d, items, { page: i + 1, pages: pages.length, extra: i === pages.length - 1 ? extra : 0 }));
}

function renderPage(d: BillsImage, shown: BillItem[], o: { page: number; pages: number; extra: number }): string {
  const first = o.page === 1;
  const last = o.page === o.pages;
  const extra = o.extra;
  // Medição: cada linha tem altura conforme a descrição (1 ou 2 linhas).
  const probe = document.createElement('canvas').getContext('2d')!;
  font(probe, 26);
  const descW = W - PAD * 2 - 450;
  const rows = shown.map((it) => ({ it, desc: wrap(probe, it.desc.toUpperCase(), descW, 2) }));
  const rowH = (n: number) => (n > 1 ? 150 : 116);
  const listH = rows.reduce((s, r) => s + rowH(r.desc.length) + 14, 0) + (extra > 0 ? 60 : 0);
  const H = PAD + 150 + (first ? 190 + 90 : 0) + listH + (last ? 100 : 0) + PAD;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);

  // Cabeçalho: ícone de documento com $ + título + período
  let y = PAD;
  rr(ctx, PAD, y + 10, 92, 110, 14, C.green);
  ctx.fillStyle = '#FFFFFF'; font(ctx, 60, 800); ctx.textAlign = 'center'; ctx.fillText('$', PAD + 46, y + 66);
  ctx.textAlign = 'left';
  ctx.fillStyle = C.ink; font(ctx, 62, 800); ctx.fillText(d.title, PAD + 120, y + 42);
  if (o.pages > 1) {
    const tw = ctx.measureText(d.title).width;
    ctx.fillStyle = C.soft; font(ctx, 30, 600); ctx.fillText(`(${o.page}/${o.pages})`, PAD + 120 + tw + 16, y + 46);
  }
  ctx.fillStyle = C.soft; font(ctx, 32, 500);
  ctx.fillText(`Período: ${d.period}${d.company ? `  ·  ${d.company}` : ''}`, PAD + 120, y + 100);
  y += 150;

  if (first) {
    // 3 indicadores
    const gap = 18;
    const cw = [(W - PAD * 2 - gap * 2) * 0.27, (W - PAD * 2 - gap * 2) * 0.33, (W - PAD * 2 - gap * 2) * 0.40];
    let x = PAD;
    const kpi = (w: number, ic: 'doc' | 'bars' | 'clock', icBg: string, icFg: string, label: string, value: string, valueColor: string, sub?: string) => {
      rr(ctx, x, y, w, 168, 22, C.card);
      rr(ctx, x + 20, y + 22, 64, 64, 14, icBg);
      icon(ctx, ic, x + 52, y + 54, icFg);
      ctx.fillStyle = C.soft; font(ctx, 26, 500); ctx.fillText(label, x + 100, y + 44);
      // Valor diminui até caber no card.
      let fs = 40;
      font(ctx, fs, 800);
      while (fs > 22 && ctx.measureText(value).width > w - 120) { fs -= 2; font(ctx, fs, 800); }
      ctx.fillStyle = valueColor; ctx.fillText(value, x + 100, y + 92);
      if (sub) { ctx.fillStyle = C.soft; font(ctx, 23, 500); ctx.textAlign = 'right'; ctx.fillText(sub, x + w - 22, y + 140); ctx.textAlign = 'left'; }
      x += w + gap;
    };
    kpi(cw[0], 'doc', C.chip, C.ink, 'Parcelas', String(d.count), C.ink);
    kpi(cw[1], 'bars', '#E6F4EA', C.green, 'Total geral', d.total, C.ink);
    kpi(cw[2], 'clock', '#FFEBDD', C.orange, 'Em aberto', d.open, C.orange, `Vencidas: ${d.overdue}`);
    y += 190;

    // Título da lista
    rr(ctx, PAD, y, 64, 60, 14, C.chip);
    icon(ctx, 'list', PAD + 34, y + 30, C.green);
    ctx.fillStyle = C.ink; font(ctx, 34, 800); ctx.fillText('Lançamentos do período', PAD + 88, y + 31);
    y += 90;
  }

  for (const { it, desc } of rows) {
    const h = rowH(desc.length);
    rr(ctx, PAD, y, W - PAD * 2, h, 18, C.card);
    // Data
    const [dd, mm] = it.date.split('/');
    rr(ctx, PAD + 20, y + (h - 84) / 2, 84, 84, 14, C.chip);
    ctx.textAlign = 'center';
    ctx.fillStyle = C.ink; font(ctx, 32, 800); ctx.fillText(dd ?? '', PAD + 62, y + h / 2 - 12);
    ctx.fillStyle = C.soft; font(ctx, 22, 600); ctx.fillText(MONTHS[Number(mm) - 1] ?? '', PAD + 62, y + h / 2 + 22);
    ctx.textAlign = 'left';
    // Bolinha
    const st = C.st[it.status];
    ctx.beginPath(); ctx.arc(PAD + 140, y + 42, 13, 0, Math.PI * 2); ctx.fillStyle = st.dot; ctx.fill();
    // Nome + descrição
    ctx.fillStyle = C.ink; font(ctx, 30, 800);
    ctx.fillText(wrap(ctx, it.name.toUpperCase(), descW, 1)[0] ?? '', PAD + 172, y + 42);
    ctx.fillStyle = C.soft; font(ctx, 26, 500);
    desc.forEach((l, i) => ctx.fillText(l, PAD + 172, y + 84 + i * 34));
    // Valor + selo
    ctx.textAlign = 'right';
    ctx.fillStyle = C.ink; font(ctx, 32, 800); ctx.fillText(it.amount, W - PAD - 24, y + 40);
    font(ctx, 24, 600);
    const lw = ctx.measureText(st.label).width + 36;
    rr(ctx, W - PAD - 24 - lw, y + 66, lw, 44, 14, st.bg);
    ctx.fillStyle = st.fg; ctx.fillText(st.label, W - PAD - 24 - 18, y + 89);
    ctx.textAlign = 'left';
    y += h + 14;
  }
  if (extra > 0) {
    ctx.fillStyle = C.soft; font(ctx, 26, 600); ctx.textAlign = 'center';
    ctx.fillText(`+ ${extra} conta(s) — veja a lista completa no texto`, W / 2, y + 24);
    ctx.textAlign = 'left';
    y += 60;
  }

  if (last) {
    // Legenda
    y += 10;
    rr(ctx, PAD, y, W - PAD * 2, 76, 18, '#E8F3EC');
    icon(ctx, 'tag', PAD + 40, y + 38, C.ink);
    ctx.fillStyle = C.ink; font(ctx, 26, 800); ctx.fillText('Legenda:', PAD + 72, y + 39);
    let lx = PAD + 210;
    for (const k of ['overdue', 'open', 'partial', 'paid'] as const) {
      ctx.beginPath(); ctx.arc(lx + 12, y + 38, 12, 0, Math.PI * 2); ctx.fillStyle = C.st[k].dot; ctx.fill();
      ctx.fillStyle = C.ink; font(ctx, 25, 500); ctx.fillText(C.st[k].label, lx + 34, y + 39);
      lx += 34 + ctx.measureText(C.st[k].label).width + 42;
    }
  }

  return cv.toDataURL('image/png').split(',')[1];
}
