// Resumo de contas para o WhatsApp: imagens (PNG, desenhadas no <canvas>) + texto curto.
// Visual aprovado: fundo verde-claro, cards brancos, data em bloco, fornecedor em destaque, valor à direita, selo de status.
// Só muda a APRESENTAÇÃO — nunca soma, remove ou altera conta, valor, vencimento ou status.
//
// Regras:
// - Até 12 contas por imagem (60 contas = 5 imagens); cabeçalho completo só na 1ª, as outras têm "Continuação".
// - Ordem: vencidas → em aberto → parciais → pagas; dentro de cada grupo, vencimento crescente.
// - Cada conta ocupa no máximo 2 linhas. Modo pelo total: normal (≤12), compacto (13–40), super compacto (>40:
//   a 2ª linha só aparece se a descrição tiver um documento, ex. "NF 1537").
// - Rodapé "Página X/Y · N contas"; legenda só na última.
// - Texto do WhatsApp nunca passa de 1.500 caracteres (`buildBillsText`).

export type BillStatus = 'overdue' | 'open' | 'partial' | 'paid';
export interface BillItem {
  date: string;   // dd/mm/aaaa (exibição)
  due?: string;   // aaaa-mm-dd (ordenação; sem ele usa `date`)
  name: string;
  desc: string;
  amount: string;
  status: BillStatus;
}
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
export type BillsMode = 'normal' | 'compacto' | 'super_compacto';

export const ITEMS_PER_IMAGE = 12;
export const MAX_TEXT_CHARS = 1500;

const W = 1080;
const PAD = 36;
const FONT = '"Inter","Segoe UI",Roboto,Arial,sans-serif';
const C = {
  bg: '#E9F6EC', card: '#FFFFFF', ink: '#10231A', soft: '#5B6B63', chip: '#EEF4F0', green: '#1F9D55',
  amber: '#D97706', red: '#C21F2B',
  st: {
    overdue: { dot: '#E5484D', bg: '#FDE2E3', fg: '#C21F2B', label: 'Vencida', emoji: '🔴' },
    open: { dot: '#F5C431', bg: '#FFF3C9', fg: '#A16207', label: 'Em aberto', emoji: '🟡' },
    partial: { dot: '#F28C38', bg: '#FFE6D2', fg: '#C2410C', label: 'Parcial', emoji: '🟠' },
    paid: { dot: '#2FB45A', bg: '#DCF5E4', fg: '#15803D', label: 'Paga', emoji: '🟢' },
  },
} as const;
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const RANK: Record<BillStatus, number> = { overdue: 0, open: 1, partial: 2, paid: 3 };

// ------------------------------------------------------------------ regras de apresentação (puras, testáveis)
export function billsMode(n: number): BillsMode {
  if (n > 40) return 'super_compacto';
  if (n > 12) return 'compacto';
  return 'normal';
}

const isoOf = (it: BillItem) => {
  if (it.due) return it.due;
  const [d, m, y] = it.date.split('/');
  return y && m && d ? `${y}-${m}-${d}` : it.date;
};
export function sortBills(items: BillItem[]): BillItem[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => RANK[a.it.status] - RANK[b.it.status] || isoOf(a.it).localeCompare(isoOf(b.it)) || a.i - b.i)
    .map((x) => x.it);
}

export function paginate<T>(items: T[], per = ITEMS_PER_IMAGE): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += per) pages.push(items.slice(i, i + per));
  return pages.length ? pages : [[]];
}

const SUFFIX = /\s*(?:[-–,]\s*)?\b(?:LTDA\.?|EIRELI|EPP|MEI|ME|S\/A|S\.A\.?|SA)\s*$/;
const STOP = new Set(['DE', 'DA', 'DO', 'DOS', 'DAS', 'E']);
const ABBR: Record<string, string> = {
  EMPRESA: 'EMP.', COMERCIO: 'COM.', 'COMÉRCIO': 'COM.', DISTRIBUIDORA: 'DIST.', INDUSTRIA: 'IND.', 'INDÚSTRIA': 'IND.',
  SERVICOS: 'SERV.', 'SERVIÇOS': 'SERV.', PRODUTOS: 'PROD.', CONSTRUCOES: 'CONSTR.', 'CONSTRUÇÕES': 'CONSTR.',
  ADMINISTRADORA: 'ADM.', TRANSPORTES: 'TRANSP.', REPRESENTACOES: 'REPR.', 'REPRESENTAÇÕES': 'REPR.',
  EQUIPAMENTOS: 'EQUIP.', TECNOLOGIA: 'TEC.', COMERCIAL: 'COM.', BRASIL: 'BR', BRASILEIRA: 'BRAS.', NACIONAL: 'NAC.',
  ENGENHARIA: 'ENG.', SOLUCOES: 'SOL.', 'SOLUÇÕES': 'SOL.', IMPORTACAO: 'IMP.', 'IMPORTAÇÃO': 'IMP.', EXPORTACAO: 'EXP.', 'EXPORTAÇÃO': 'EXP.',
};
// Nome do fornecedor curto e sempre igual para o mesmo nome (mesma entrada → mesma saída).
export function abbreviateParty(name: string, max = 26): string {
  let s = (name || '—').toUpperCase().replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  for (let i = 0; i < 3 && SUFFIX.test(s); i++) s = s.replace(SUFFIX, '').trim();
  if (s.length <= max) return s;
  s = s.split(' ').filter((w) => !STOP.has(w)).map((w) => ABBR[w] ?? w).join(' ');
  return s;
}

export function shortDesc(desc: string, max = 45): string {
  const s = (desc || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// Documento citado na descrição (NF 1537, DOC 66606/1, Fatura 10/2026, Pedido 7788…). Nada achado = null.
const DOC_RE = /\b(NF-?e|NFS-?e|NFSE|NFE|NF|N\.F\.|DOC(?:TO)?|DOCUMENTO|FATURA|FAT|BOLETO|PEDIDO|PED|DUPLICATA|DUP|PARCELA|PARC|CONTRATO|UC|NOTA)\b\.?\s*(?:N[º°o.]?\s*)?[:#-]?\s*([A-Z0-9][\w./-]*\d[\w./-]*)/i;
export function docRef(desc: string): string | null {
  const m = DOC_RE.exec(desc || '');
  if (!m) return null;
  const kind = m[1].toUpperCase().replace(/\./g, '').replace(/^NFE$/, 'NF-e').replace(/^NOTA$/, 'NF');
  return `${kind} ${m[2]}`.slice(0, 30);
}

// Texto do WhatsApp. Com imagens: só o resumo financeiro. Sem imagens (Atendimento / meu WhatsApp): resumo + quantas
// contas couberem em 1 linha cada, sempre ≤ 1.500 caracteres.
export function buildBillsText(d: BillsImage, opts: { withImages: boolean; max?: number }): string {
  const max = opts.max ?? MAX_TEXT_CHARS;
  const head = [
    `*${d.title} — ${d.period}*${d.company ? `\n${d.company}` : ''}`,
    '',
    `${d.count} parcela${d.count === 1 ? '' : 's'}`,
    `Total: *${d.total}*`,
    `Em aberto: *${d.open}*`,
    `Vencidas: *${d.overdue}*`,
  ].join('\n');
  if (opts.withImages) return `${head}\n\n📎 Segue o relatório detalhado nas imagens.`.slice(0, max);
  const items = sortBills(d.items);
  const tail = (left: number) => (left > 0 ? `\n… e mais ${left} conta${left === 1 ? '' : 's'} (lista completa no CRM)` : '');
  const legend = `\n\n🔴 vencida · 🟡 em aberto · 🟠 parcial · 🟢 paga`;
  let body = `${head}\n`;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const line = `\n${C.st[it.status].emoji} ${it.date.slice(0, 5)} | ${abbreviateParty(it.name, 22)} | ${it.amount}`;
    const reserve = tail(items.length - i - 1).length + legend.length + 60;
    if ((body + line).length + reserve > max) { body += tail(items.length - i); break; }
    body += line;
  }
  return `${body}${legend}`.slice(0, max);
}

// ------------------------------------------------------------------ desenho
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
// Corta com "…" até caber na largura (nunca quebra linha).
function fit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}
type IconKind = 'doc' | 'layers' | 'bars' | 'clock' | 'alert' | 'list' | 'info';
function icon(ctx: CanvasRenderingContext2D, kind: IconKind, x: number, y: number, color: string, s = 1) {
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (kind === 'doc') {
    ctx.moveTo(-11, -15); ctx.lineTo(4, -15); ctx.lineTo(12, -7); ctx.lineTo(12, 15); ctx.lineTo(-11, 15); ctx.closePath();
    ctx.moveTo(-5, -1); ctx.lineTo(6, -1); ctx.moveTo(-5, 6); ctx.lineTo(6, 6); ctx.stroke();
  } else if (kind === 'layers') {
    ctx.moveTo(0, -12); ctx.lineTo(13, -5); ctx.lineTo(0, 2); ctx.lineTo(-13, -5); ctx.closePath();
    ctx.moveTo(-13, 2); ctx.lineTo(0, 9); ctx.lineTo(13, 2); ctx.moveTo(-13, 8); ctx.lineTo(0, 15); ctx.lineTo(13, 8); ctx.stroke();
  } else if (kind === 'bars') {
    ctx.lineWidth = 5; ctx.moveTo(-9, 12); ctx.lineTo(-9, 3); ctx.moveTo(0, 12); ctx.lineTo(0, -4); ctx.moveTo(9, 12); ctx.lineTo(9, -12); ctx.stroke();
  } else if (kind === 'clock') {
    ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.moveTo(0, -6); ctx.lineTo(0, 0); ctx.lineTo(5, 4); ctx.stroke();
  } else if (kind === 'alert') {
    ctx.moveTo(0, -13); ctx.lineTo(14, 12); ctx.lineTo(-14, 12); ctx.closePath(); ctx.moveTo(0, -4); ctx.lineTo(0, 3); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 8, 1.8, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'list') {
    for (const dy of [-8, 0, 8]) { ctx.moveTo(-4, dy); ctx.lineTo(12, dy); }
    ctx.stroke();
    for (const dy of [-8, 0, 8]) { ctx.beginPath(); ctx.arc(-11, dy, 2, 0, Math.PI * 2); ctx.fill(); }
  } else {
    ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.font = `800 16px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('i', 0, 1);
  }
  ctx.restore();
}

interface Metrics { rowH1: number; rowH2: number; gap: number; date: number; dd: number; mm: number; name: number; sub: number; amount: number; pill: number; pillH: number }
const METRICS: Record<BillsMode, Metrics> = {
  normal: { rowH1: 78, rowH2: 96, gap: 10, date: 70, dd: 30, mm: 19, name: 29, sub: 23, amount: 30, pill: 23, pillH: 44 },
  compacto: { rowH1: 70, rowH2: 84, gap: 8, date: 62, dd: 27, mm: 17, name: 27, sub: 21, amount: 28, pill: 21, pillH: 40 },
  super_compacto: { rowH1: 62, rowH2: 78, gap: 7, date: 56, dd: 25, mm: 16, name: 26, sub: 20, amount: 27, pill: 20, pillH: 38 },
};

// Devolve 1 PNG (base64, sem "data:") a cada 12 contas.
export async function renderBillsImages(d: BillsImage): Promise<string[]> {
  const mode = billsMode(d.items.length);
  const pages = paginate(sortBills(d.items));
  return pages.map((items, i) => renderPage(d, items, { page: i + 1, pages: pages.length, mode }));
}

function renderPage(d: BillsImage, shown: BillItem[], o: { page: number; pages: number; mode: BillsMode }): string {
  const first = o.page === 1;
  const last = o.page === o.pages;
  const m = METRICS[o.mode];
  const innerX = PAD + 16;
  const innerW = W - PAD * 2 - 32;

  // Cada conta: linha 1 = fornecedor; linha 2 = descrição (normal/compacto) ou documento (super compacto, só se houver).
  const rows = shown.map((it) => {
    const sub = o.mode === 'super_compacto' ? docRef(it.desc) : shortDesc(it.desc) || null;
    return { it, sub, h: sub ? m.rowH2 : m.rowH1 };
  });
  const headerH = first ? 118 + 150 + 74 : 108;
  const listH = rows.reduce((s, r) => s + r.h + m.gap, 0);
  const footerH = last ? 132 : 64;
  const H = PAD + headerH + listH + footerH + PAD;

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#EFEAE2'; ctx.fillRect(0, 0, W, H);
  // Balão verde (o "card" da mensagem)
  rr(ctx, PAD - 16, PAD - 16, W - (PAD - 16) * 2, H - (PAD - 16) * 2, 28, C.bg);

  let y = PAD;
  if (first) {
    rr(ctx, innerX, y + 8, 76, 88, 16, '#DDF0E3');
    icon(ctx, 'doc', innerX + 38, y + 52, C.green, 1.4);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink; font(ctx, 46, 800); ctx.fillText(d.title, innerX + 100, y + 34);
    ctx.fillStyle = '#2F4A3B'; font(ctx, 28, 500);
    ctx.fillText(fit(ctx, `Período: ${d.period}${d.company ? `  ·  ${d.company}` : ''}`, innerW - 100), innerX + 100, y + 80);
    y += 118;

    // 4 indicadores
    const gap = 14;
    const cw = (innerW - gap * 3) / 4;
    const kpis: Array<[IconKind, string, string, string]> = [
      ['layers', 'Parcelas', String(d.count), C.ink],
      ['bars', 'Total geral', d.total, C.green],
      ['clock', 'Em aberto', d.open, C.amber],
      ['alert', 'Vencidas', d.overdue, C.red],
    ];
    kpis.forEach(([ic, label, value, color], i) => {
      const x = innerX + i * (cw + gap);
      rr(ctx, x, y, cw, 128, 18, C.card);
      ctx.fillStyle = C.soft; font(ctx, 23, 500); ctx.textAlign = 'left'; ctx.fillText(label, x + 18, y + 34);
      icon(ctx, ic, x + cw - 30, y + 34, i === 0 ? C.soft : color, 0.9);
      let fs = 36;
      font(ctx, fs, 800);
      while (fs > 20 && ctx.measureText(value).width > cw - 32) { fs -= 2; font(ctx, fs, 800); }
      ctx.fillStyle = color; ctx.fillText(value, x + 18, y + 88);
    });
    y += 150;

    // Título da lista + página
    rr(ctx, innerX, y, innerW, 60, 16, 'rgba(255,255,255,0.55)');
    icon(ctx, 'list', innerX + 30, y + 30, C.ink, 0.9);
    ctx.fillStyle = C.ink; font(ctx, 28, 800); ctx.textAlign = 'left'; ctx.fillText('Lançamentos do período', innerX + 60, y + 31);
    ctx.fillStyle = C.soft; font(ctx, 22, 500); ctx.textAlign = 'right';
    ctx.fillText(`Página ${o.page}/${o.pages}  ·  ${shown.length} conta${shown.length === 1 ? '' : 's'}`, innerX + innerW - 20, y + 31);
    y += 74;
  } else {
    // Continuação: cabeçalho curto
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink; font(ctx, 38, 800); ctx.fillText(d.title, innerX, y + 30);
    ctx.fillStyle = C.soft; font(ctx, 25, 500); ctx.fillText(`Continuação  ·  Página ${o.page} de ${o.pages}`, innerX, y + 72);
    y += 108;
  }

  // Colunas: data | fornecedor/descrição | valor | selo
  const pillW = 150;
  const pillX = innerX + innerW - 16 - pillW;
  const amountRight = pillX - 18;
  const textX = innerX + 16 + m.date + 22;
  font(ctx, m.amount, 800);
  const amountW = Math.max(...rows.map((r) => ctx.measureText(r.it.amount).width), 120);
  const textW = amountRight - amountW - 24 - textX;

  for (const { it, sub, h } of rows) {
    rr(ctx, innerX, y, innerW, h, 14, C.card);
    const cy = y + h / 2;
    // Data em bloco
    const [dd, mm] = it.date.split('/');
    rr(ctx, innerX + 14, cy - m.date / 2, m.date, m.date, 12, C.chip);
    ctx.textAlign = 'center';
    ctx.fillStyle = C.ink; font(ctx, m.dd, 800); ctx.fillText(dd ?? '', innerX + 14 + m.date / 2, cy - m.date * 0.16);
    ctx.fillStyle = C.soft; font(ctx, m.mm, 600); ctx.fillText(MONTHS[Number(mm) - 1] ?? '', innerX + 14 + m.date / 2, cy + m.date * 0.24);
    // Fornecedor (+ 2ª linha curta)
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink; font(ctx, m.name, 800);
    const nameY = sub ? y + h * 0.36 : cy;
    ctx.fillText(fit(ctx, abbreviateParty(it.name), textW), textX, nameY);
    if (sub) { ctx.fillStyle = C.soft; font(ctx, m.sub, 500); ctx.fillText(fit(ctx, sub, textW), textX, y + h * 0.7); }
    // Valor
    ctx.textAlign = 'right';
    ctx.fillStyle = C.ink; font(ctx, m.amount, 800); ctx.fillText(it.amount, amountRight, cy);
    // Selo
    const st = C.st[it.status];
    rr(ctx, pillX, cy - m.pillH / 2, pillW, m.pillH, m.pillH / 2, st.bg);
    ctx.textAlign = 'center';
    ctx.fillStyle = st.fg; font(ctx, m.pill, 700); ctx.fillText(st.label, pillX + pillW / 2, cy + 1);
    y += h + m.gap;
  }

  // Rodapé
  y += 6;
  ctx.textAlign = 'left';
  if (last) {
    rr(ctx, innerX, y, innerW, 58, 16, 'rgba(255,255,255,0.7)');
    ctx.fillStyle = C.ink; font(ctx, 23, 800); ctx.fillText('Legenda:', innerX + 20, y + 30);
    let lx = innerX + 140;
    for (const k of ['overdue', 'open', 'partial', 'paid'] as const) {
      ctx.beginPath(); ctx.arc(lx + 10, y + 29, 10, 0, Math.PI * 2); ctx.fillStyle = C.st[k].dot; ctx.fill();
      ctx.fillStyle = C.ink; font(ctx, 23, 500); ctx.fillText(C.st[k].label, lx + 28, y + 30);
      lx += 28 + ctx.measureText(C.st[k].label).width + 36;
    }
    y += 72;
    ctx.fillStyle = C.soft; font(ctx, 23, 600);
    ctx.fillText(`Página ${o.page}/${o.pages}  ·  ${d.items.length} conta${d.items.length === 1 ? '' : 's'} no total`, innerX + 4, y + 22);
  } else {
    icon(ctx, 'info', innerX + 16, y + 24, '#7A8C82', 0.85);
    ctx.fillStyle = C.soft; font(ctx, 22, 500);
    ctx.fillText('Legenda completa na última página.', innerX + 38, y + 25);
    ctx.textAlign = 'right'; font(ctx, 22, 600);
    ctx.fillText(`Página ${o.page}/${o.pages}  ·  ${shown.length} contas`, innerX + innerW - 4, y + 25);
  }

  return cv.toDataURL('image/png').split(',')[1];
}
