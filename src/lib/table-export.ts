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

export function exportPdf(title: string, subtitle: string, header: string[], rows: Cell[][], opts: { rightCols?: number[]; footer?: Cell[] } = {}) {
  const right = new Set(opts.rightCols ?? []);
  const th = header.map((h, i) => `<th${right.has(i) ? ' class="r"' : ''}>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${right.has(i) ? ' class="r"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('');
  const foot = opts.footer ? `<tfoot><tr>${opts.footer.map((c, i) => `<td${right.has(i) ? ' class="r"' : ''}>${esc(c)}</td>`).join('')}</tr></tfoot>` : '';
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>@page{size:A4 landscape;margin:12mm}body{font:11px Inter,Arial,sans-serif;color:#0f1b2e}h1{font-size:16px;margin:0}p{margin:2px 0 10px;color:#475569}
table{width:100%;border-collapse:collapse}th,td{padding:4px 6px;border-bottom:1px solid #dae1ec;text-align:left;vertical-align:top}
th{background:#eef2f8;font-size:10px;text-transform:uppercase}.r{text-align:right;white-space:nowrap}tfoot td{font-weight:700;border-top:2px solid #94a3b8}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(subtitle)}</p><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody>${foot}</table>
<script>window.onload=function(){window.print()}</script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { toast.error('O navegador bloqueou a janela do PDF. Libere pop-ups para este site.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
}
