import { toast } from 'sonner';

// Exporta uma tabela simples (cabeçalho + linhas) para Excel ou para PDF (janela de impressão → "Salvar como PDF").
export type Cell = string | number | null | undefined;

export async function exportExcel(fileName: string, sheet: string, header: string[], rows: Cell[][]) {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows.map((r) => r.map((c) => (c === null || c === undefined ? '' : c)))]);
  ws['!cols'] = header.map((h, i) => ({ wch: Math.min(60, Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)) + 2) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheet.slice(0, 31));
  XLSX.writeFile(wb, fileName.endsWith('.xlsx') ? fileName : `${fileName}.xlsx`);
}

const esc = (s: Cell) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// ---------------------------------------------------------------------------------------------------------------
// Relatório para impressão/PDF no modelo profissional: logo + título + dados do relatório, faixa de indicadores,
// tabela com cabeçalho azul-claro, linhas zebradas, status em selo colorido, total e rodapé "Página X de Y".
// "print" abre e já chama a impressão; "pdf" abre a prévia com o botão "Salvar PDF" (destino "Salvar como PDF").
export type ReportIcon = 'doc' | 'coins' | 'clock' | 'alert' | 'check' | 'box';
export interface ReportKpi { label: string; value: string; hint?: string; icon?: ReportIcon; tone?: 'error' | 'success' | 'warn' }
export interface ReportOptions {
  title: string;
  subtitle?: string;
  meta?: Array<[string, string]>;
  kpis?: ReportKpi[];
  header: string[];
  rows: Cell[][];
  align?: Array<'left' | 'right' | 'center' | undefined>;
  statusCol?: number;
  footer?: Cell[];
  logoUrl?: string | null;
  brand?: string | null;
  fileName?: string;
  orientation?: 'portrait' | 'landscape';
}

const ICONS: Record<ReportIcon, string> = {
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/>',
  coins: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>',
};
const STATUS_TONE: Array<[RegExp, string]> = [
  [/vencid|atras|recusad|erro|falh/i, 'st-red'],
  [/pago|recebid|conclu|lançad|lancad|ok\b|aprovad/i, 'st-green'],
  [/parcial|aguard|pendent|confer/i, 'st-amber'],
  [/cancel|ignorad|inativ/i, 'st-gray'],
  [/abert|emitid|ativo/i, 'st-blue'],
];

async function toDataUrl(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { mode: 'cors' });
    if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => res(null); fr.readAsDataURL(b); });
  } catch { return null; }
}

export async function openReport(o: ReportOptions, mode: 'print' | 'pdf' = 'pdf') {
  // A janela abre já (antes do await) para o navegador não bloquear como pop-up.
  const w = window.open('', '_blank');
  if (!w) { toast.error('O navegador bloqueou a janela do relatório. Libere pop-ups para este site.'); return; }
  w.document.write('<p style="font:14px Arial;padding:24px;color:#475569">Gerando relatório…</p>');
  const logo = (o.logoUrl && (await toDataUrl(o.logoUrl))) || (await toDataUrl(`${window.location.origin}/amai-logo.png`));
  const al = (i: number) => (o.align?.[i] ? ` class="${o.align[i] === 'right' ? 'r' : o.align[i] === 'center' ? 'c' : ''}"` : '');
  const cell = (c: Cell, i: number) => {
    if (i === o.statusCol && c != null && c !== '') {
      const tone = STATUS_TONE.find(([re]) => re.test(String(c)))?.[1] ?? 'st-gray';
      return `<td class="c"><span class="st ${tone}">${esc(c)}</span></td>`;
    }
    return `<td${al(i)}>${esc(c)}</td>`;
  };
  const landscape = o.orientation ? o.orientation === 'landscape' : o.header.length > 9;
  const meta = (o.meta ?? []).map(([k, v]) => `<div class="mk">${esc(k)}:</div><div class="mv">${esc(v)}</div>`).join('');
  const kpis = (o.kpis ?? []).map((k) => `<div class="kpi"><div class="ki ${k.tone ? `k-${k.tone}` : ''}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k.icon ?? 'doc']}</svg></div>
    <div><div class="kl">${esc(k.label)}</div><div class="kv ${k.tone ? `t-${k.tone}` : ''}">${esc(k.value)}${k.hint ? ` <span class="kh">${esc(k.hint)}</span>` : ''}</div></div></div>`).join('');
  const th = o.header.map((h, i) => `<th${i === o.statusCol ? ' class="c"' : al(i)}>${esc(h)}</th>`).join('');
  const body = o.rows.length ? o.rows.map((r) => `<tr>${r.map(cell).join('')}</tr>`).join('') : `<tr><td colspan="${o.header.length}" class="c empty">Nenhum registro no filtro escolhido.</td></tr>`;
  const foot = o.footer ? `<tfoot><tr>${o.footer.map((c, i) => `<td${al(i)}>${esc(c)}</td>`).join('')}</tr></tfoot>` : '';
  const brandBlock = logo ? `<img class="logo" src="${logo}" alt="">` : `<div class="brand">${esc(o.brand ?? '')}</div>`;
  const fileTitle = o.fileName ?? o.title;
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(fileTitle)}</title>
<style>
@page{size:A4 ${landscape ? 'landscape' : 'portrait'};margin:12mm 10mm 16mm;
  @bottom-left{content:"Documento gerado automaticamente pelo sistema.";font:9px Inter,Arial,sans-serif;color:#64748b}
  @bottom-right{content:"Página " counter(page) " de " counter(pages);font:9px Inter,Arial,sans-serif;color:#64748b}}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0}
body{font:10.5px/1.35 Inter,"Segoe UI",Arial,sans-serif;color:#0f1b2e;background:#e9edf3}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:10px 16px;background:#0f1b2e;color:#fff;font-size:13px}
.bar span{margin-right:auto;opacity:.8}
.bar button{border:0;border-radius:8px;padding:8px 14px;font:600 13px Inter,Arial,sans-serif;cursor:pointer}
.b1{background:#2563eb;color:#fff}.b2{background:#fff;color:#0f1b2e}
.page{width:${landscape ? '297mm' : '210mm'};min-height:${landscape ? '210mm' : '297mm'};margin:18px auto;background:#fff;padding:12mm 10mm;box-shadow:0 4px 24px rgba(15,27,46,.15)}
.head{display:flex;align-items:center;gap:22px;padding-bottom:14px;border-bottom:1px solid #dae1ec}
.logo{height:64px;max-width:150px;object-fit:contain}
.brand{font:800 20px Inter,Arial;color:#1d4ed8;max-width:150px}
.vr{width:1px;align-self:stretch;background:#dae1ec}
.ttl{flex:1}.ttl h1{margin:0;font-size:24px;line-height:1.1;color:#0f1b2e;letter-spacing:-.01em}.ttl p{margin:4px 0 0;font-size:13px;color:#64748b}
.meta{display:grid;grid-template-columns:auto auto;gap:3px 14px;font-size:11px}.mk{font-weight:700;color:#0f1b2e}.mv{color:#334155}
.kpis{display:flex;margin:14px 0 12px;padding:12px 0;border-bottom:1px solid #dae1ec}
.kpi{flex:1;display:flex;align-items:center;gap:12px;padding:0 14px;border-left:1px solid #dae1ec}.kpi:first-child{border-left:0;padding-left:4px}
.ki{width:40px;height:40px;flex:none;border-radius:10px;background:#e7effd;color:#1d4ed8;display:flex;align-items:center;justify-content:center}.ki svg{width:22px;height:22px}
.k-error{background:#fde8e8;color:#b91c1c}.k-success{background:#e3f6ec;color:#15803d}.k-warn{background:#fff4e0;color:#b45309}
.kl{font-size:11px;color:#475569;white-space:nowrap}.kv{font-size:16px;font-weight:800;color:#0f1b2e;white-space:nowrap}.kh{font-size:11px;font-weight:400;color:#64748b}
.t-error{color:#b91c1c}.t-success{color:#15803d}.t-warn{color:#b45309}
table{width:100%;border-collapse:collapse}
thead th{background:#e3ecfa;color:#0f1b2e;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.02em;padding:7px 6px;text-align:left;border-bottom:1px solid #c9d6ec}
tbody td{padding:6px;border-bottom:1px solid #e6ebf2;vertical-align:middle;text-transform:uppercase}
tbody tr:nth-child(even) td{background:#f7f9fc}
tbody tr{break-inside:avoid}
.r{text-align:right;white-space:nowrap}.c{text-align:center}
.st{display:inline-block;padding:2px 9px;border-radius:5px;font-size:9.5px;font-weight:700;text-transform:none;white-space:nowrap}
.st-red{background:#fde2e2;color:#b91c1c}.st-green{background:#dcf5e6;color:#15803d}.st-amber{background:#fff1d6;color:#b45309}.st-gray{background:#eef1f5;color:#475569}.st-blue{background:#dfeafd;color:#1d4ed8}
tfoot td{background:#e3ecfa;font-weight:800;padding:8px 6px;font-size:11px;border-top:1px solid #c9d6ec}
.empty{padding:24px;color:#64748b;text-transform:none}
.foot{display:flex;justify-content:space-between;margin-top:18px;padding-top:8px;border-top:1px solid #dae1ec;color:#64748b;font-size:9px}
@media print{body{background:#fff}.bar,.foot{display:none}.page{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
</style></head><body>
<div class="bar"><span>${mode === 'pdf' ? 'Para baixar: clique em "Salvar PDF" e, no destino, escolha <b>Salvar como PDF</b>.' : 'Prévia de impressão'}</span>
<button class="b2" onclick="window.print()">Imprimir</button><button class="b1" onclick="window.print()">Salvar PDF</button></div>
<div class="page">
<div class="head">${brandBlock}<div class="vr"></div><div class="ttl"><h1>${esc(o.title)}</h1>${o.subtitle ? `<p>${esc(o.subtitle)}</p>` : ''}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>
${kpis ? `<div class="kpis">${kpis}</div>` : '<div style="height:12px"></div>'}
<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${foot}</table>
<div class="foot"><span>Documento gerado automaticamente pelo sistema.</span><span>${o.rows.length} registro(s)</span></div>
</div>
${mode === 'print' ? '<script>window.addEventListener("load",function(){setTimeout(function(){window.print()},200)})</script>' : ''}
</body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
}

const nowTxt = () => new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(',', ',');

// Compatível com as chamadas antigas: mesmo relatório novo, sem indicadores.
export function exportPdf(title: string, subtitle: string, header: string[], rows: Cell[][], opts: { rightCols?: number[]; footer?: Cell[]; statusCol?: number } = {}) {
  const right = new Set(opts.rightCols ?? []);
  void openReport({ title, subtitle, header, rows, footer: opts.footer, statusCol: opts.statusCol,
    align: header.map((_, i) => (right.has(i) ? 'right' : undefined)), meta: [['Gerado em', nowTxt()]] }, 'pdf');
}
export { nowTxt as reportNow };
