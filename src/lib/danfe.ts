// DANFE (Documento Auxiliar da NF-e) a partir do XML guardado da nota de entrada.
// Abre uma página A4 pronta para imprimir / "Salvar como PDF" (mesmo jeito dos relatórios do sistema).
// Leitura no navegador com fast-xml-parser (mesma configuração de src/lib/nfe.ts) — nada vai para servidor.
import { XMLParser } from 'fast-xml-parser';
import { toast } from 'sonner';

type N = Record<string, unknown>;
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true,
  parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: true,
  isArray: (name) => name === 'det' || name === 'dup' || name === 'detPag' || name === 'vol',
});
const obj = (v: unknown): N => (v && typeof v === 'object' && !Array.isArray(v) ? (v as N) : {});
const txt = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? String((v as N)['#text'] ?? '') : String(v));
const arr = (v: unknown): N[] => (!v ? [] : (Array.isArray(v) ? v : [v]).map(obj));
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const dig = (v: unknown) => txt(v).replace(/\D/g, '');

const money = (v: unknown) => {
  const n = Number(txt(v) || 0);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0,00';
};
const qty = (v: unknown, d = 4, min = 0) => {
  const n = Number(txt(v) || 0);
  return Number.isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: min, maximumFractionDigits: d }) : '';
};
const fmtDoc = (v: unknown) => {
  const d = dig(v);
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return d;
};
const fmtCep = (v: unknown) => dig(v).replace(/^(\d{5})(\d{3})$/, '$1-$2');
const fmtDate = (v: unknown) => { const s = txt(v); const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return m ? `${m[3]}/${m[2]}/${m[1]}` : ''; };
const fmtTime = (v: unknown) => { const m = /T(\d{2}:\d{2}:\d{2})/.exec(txt(v)); return m ? m[1] : ''; };
const fmtKey = (k: string) => k.replace(/(\d{4})(?=\d)/g, '$1 ');
const MODFRETE: Record<string, string> = { '0': '0 - Emitente', '1': '1 - Destinatário', '2': '2 - Terceiros', '3': '3 - Próprio rem.', '4': '4 - Próprio dest.', '9': '9 - Sem frete' };

// ------------------------------------------------------------------ Código de barras (Code 128, conjunto C)
// Larguras barra/espaço de cada símbolo (0–105) + parada. Conferido contra a tabela do JsBarcode.
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232'];
const C128_STOP = '2331112';

export function code128cSvg(digits: string, height = 46): string {
  if (!/^\d+$/.test(digits) || digits.length % 2) return '';
  const codes = [105];
  for (let i = 0; i < digits.length; i += 2) codes.push(Number(digits.slice(i, i + 2)));
  const check = codes.reduce((sum, c, i) => sum + c * (i === 0 ? 1 : i), 0) % 103;
  const pattern = [...codes, check].map((c) => C128[c]).join('') + C128_STOP;
  let x = 10; // zona livre
  let bars = '';
  for (let i = 0; i < pattern.length; i++) {
    const w = Number(pattern[i]);
    if (i % 2 === 0) bars += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
    x += w;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x + 10} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px"><g fill="#000">${bars}</g></svg>`;
}

// ------------------------------------------------------------------ DANFE
export function buildDanfeHtml(xml: string): string {
  if (/<!DOCTYPE/i.test(xml)) throw new Error('XML inválido.');
  const root = parser.parse(xml) as N;
  const nfe = obj(obj(root.nfeProc).NFe ?? root.NFe);
  const inf = obj(nfe.infNFe);
  if (!Object.keys(inf).length) throw new Error('Este arquivo não é o XML completo de uma NF-e.');
  const prot = obj(obj(obj(root.nfeProc).protNFe).infProt);
  const key = dig(txt(prot.chNFe) || txt(inf['@Id']));
  const ide = obj(inf.ide), emit = obj(inf.emit), ee = obj(emit.enderEmit), dest = obj(inf.dest), ed = obj(dest.enderDest);
  const tot = obj(obj(inf.total).ICMSTot), transp = obj(inf.transp), tr = obj(transp.transporta), vols = arr(transp.vol);
  const veic = obj(transp.veicTransp);
  const dups = arr(obj(inf.cobr).dup), fat = obj(obj(inf.cobr).fat);
  const adic = obj(inf.infAdic);
  const num = txt(ide.nNF).padStart(9, '0').replace(/(\d{3})(\d{3})(\d{3})/, '$1.$2.$3');
  const tpNF = txt(ide.tpNF);
  const protTxt = txt(prot.nProt) ? `${txt(prot.nProt)} - ${fmtDate(prot.dhRecbto)} ${fmtTime(prot.dhRecbto)}` : 'Sem protocolo de autorização no XML';
  const homolog = txt(ide.tpAmb) === '2';

  const box = (label: string, value: unknown, cls = '') => `<div class="f ${cls}"><b>${esc(label)}</b><span>${esc(value) || '&nbsp;'}</span></div>`;
  const row = (...cells: string[]) => `<div class="row">${cells.join('')}</div>`;

  const endEmit = [txt(ee.xLgr), txt(ee.nro), txt(ee.xCpl)].filter(Boolean).join(', ');
  const items = arr(inf.det).map((d) => {
    const p = obj(d.prod);
    const imp = obj(d.imposto);
    const icmsGroup = obj(Object.values(obj(imp.ICMS))[0]);
    const ipi = obj(obj(imp.IPI).IPITrib);
    const cst = txt(icmsGroup.orig) + (txt(icmsGroup.CST) || txt(icmsGroup.CSOSN));
    return `<tr><td>${esc(txt(p.cProd))}</td><td class="desc">${esc(txt(p.xProd))}${txt(d.infAdProd) ? `<br><small>${esc(txt(d.infAdProd))}</small>` : ''}</td>
      <td class="c">${esc(txt(p.NCM))}</td><td class="c">${esc(cst)}</td><td class="c">${esc(txt(p.CFOP))}</td><td class="c">${esc(txt(p.uCom))}</td>
      <td class="r">${qty(p.qCom)}</td><td class="r">${qty(p.vUnCom, 4, 2)}</td><td class="r">${money(p.vProd)}</td>
      <td class="r">${money(icmsGroup.vBC)}</td><td class="r">${money(icmsGroup.vICMS)}</td><td class="r">${money(ipi.vIPI)}</td>
      <td class="r">${qty(icmsGroup.pICMS, 2, 2)}</td><td class="r">${qty(ipi.pIPI, 2, 2)}</td></tr>`;
  }).join('');

  const dupHtml = dups.length
    ? `<div class="sec">FATURA / DUPLICATAS</div><div class="dups">${dups.map((d) => `<div class="dup"><span>Nº ${esc(txt(d.nDup))}</span><span>Venc. ${esc(fmtDate(d.dVenc))}</span><b>R$ ${money(d.vDup)}</b></div>`).join('')}</div>`
    : txt(fat.vLiq) ? `<div class="sec">FATURA</div>${row(box('Número', txt(fat.nFat)), box('Valor original', money(fat.vOrig)), box('Desconto', money(fat.vDesc)), box('Valor líquido', money(fat.vLiq)))}` : '';
  const vol = vols[0] ?? {};

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>DANFE NF-e ${esc(txt(ide.nNF))} - ${esc(txt(emit.xNome))}</title>
<style>
@page{size:A4 portrait;margin:7mm}
*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}
html,body{margin:0}body{font:8px/1.2 Arial,Helvetica,sans-serif;color:#000;background:#e9edf3}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:8px;align-items:center;justify-content:flex-end;padding:10px 16px;background:#0f1b2e;color:#fff;font-size:13px}
.bar span{margin-right:auto;opacity:.85}.bar button{border:0;border-radius:8px;padding:8px 14px;font:600 13px Arial,sans-serif;cursor:pointer}
.b1{background:#2563eb;color:#fff}.b2{background:#fff;color:#0f1b2e}
.page{width:210mm;min-height:297mm;margin:16px auto;background:#fff;padding:7mm;box-shadow:0 4px 24px rgba(15,27,46,.15);position:relative}
.row{display:flex;border:1px solid #000;border-top:0}.row:first-child{border-top:1px solid #000}
.f{flex:1;padding:2px 4px;border-left:1px solid #000;min-width:0}.f:first-child{border-left:0}
.f b{display:block;font-size:6px;font-weight:700;text-transform:uppercase}.f span{display:block;font-size:9px;min-height:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.w2{flex:2}.w3{flex:3}.w4{flex:4}.w05{flex:.6}
.sec{font-size:7px;font-weight:700;margin:5px 0 1px}
.canhoto{display:flex;border:1px solid #000;margin-bottom:4px}.canhoto .f{min-height:28px}
.cut{border-top:1px dashed #000;margin:3px 0 5px}
.top{display:flex;border:1px solid #000}
.emit{flex:3.2;padding:5px 6px;border-right:1px solid #000}.emit h2{margin:0 0 3px;font-size:12px}.emit p{margin:1px 0;font-size:8px}
.dan{flex:1.6;padding:4px;border-right:1px solid #000;text-align:center}.dan h1{margin:0;font-size:15px}.dan p{margin:2px 0;font-size:7.5px}
.tp{display:inline-flex;align-items:center;gap:6px;margin:4px 0;font-size:8px}.tp i{font-style:normal;border:1px solid #000;padding:2px 7px;font-size:12px;font-weight:700}
.dan .n{font-size:10px;font-weight:700}
.key{flex:3.2;padding:4px 6px}.key .lbl{font-size:6px;font-weight:700}.key .k{font-size:9.5px;font-weight:700;letter-spacing:.3px;margin:3px 0}
.key p{margin:3px 0 0;font-size:7.5px;text-align:center}
table{width:100%;border-collapse:collapse;border:1px solid #000;table-layout:fixed}
th{font-size:6px;border:1px solid #000;padding:2px;background:#f1f1f1;text-transform:uppercase}
td{font-size:7.5px;border-left:1px solid #000;border-right:1px solid #000;padding:1.5px 2px;vertical-align:top;overflow:hidden}
tbody tr{border-bottom:1px dotted #999}tbody tr{break-inside:avoid}
td small{font-size:6.5px;color:#333}.r{text-align:right}.c{text-align:center}.desc{white-space:normal}
.dups{display:flex;flex-wrap:wrap;border:1px solid #000}.dup{display:flex;gap:8px;padding:2px 5px;border-right:1px solid #000;font-size:8px}
.adic{display:flex;border:1px solid #000;min-height:70px}.adic div{padding:3px 5px;font-size:7.5px;white-space:pre-wrap}.adic div:first-child{flex:3;border-right:1px solid #000}.adic div:last-child{flex:1.4}
.adic b{display:block;font-size:6px;margin-bottom:2px}
.hml{position:absolute;top:45%;left:0;right:0;text-align:center;font-size:44px;font-weight:700;color:rgba(220,38,38,.18);transform:rotate(-20deg)}
.note{margin-top:6px;font-size:6.5px;color:#555;text-align:right}
@media print{body{background:#fff}.bar{display:none}.page{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
</style></head><body>
<div class="bar"><span>Para baixar: clique em "Salvar PDF" e, no destino, escolha <b>Salvar como PDF</b>.</span>
<button class="b2" onclick="window.print()">Imprimir</button><button class="b1" onclick="window.print()">Salvar PDF</button></div>
<div class="page">
${homolog ? '<div class="hml">SEM VALOR FISCAL — HOMOLOGAÇÃO</div>' : ''}
<div class="canhoto"><div class="f w4"><b>Recebemos de ${esc(txt(emit.xNome))} os produtos/serviços constantes da nota fiscal indicada ao lado</b><span></span></div>
<div class="f"><b>Data de recebimento</b><span></span></div><div class="f w2"><b>Identificação e assinatura do recebedor</b><span></span></div>
<div class="f c"><b>NF-e</b><span style="font-weight:700">Nº ${esc(num)}<br>Série ${esc(txt(ide.serie))}</span></div></div>
<div class="cut"></div>
<div class="top">
  <div class="emit"><h2>${esc(txt(emit.xNome))}</h2>
    ${txt(emit.xFant) ? `<p>${esc(txt(emit.xFant))}</p>` : ''}
    <p>${esc(endEmit)}</p><p>${esc(txt(ee.xBairro))} — ${esc(fmtCep(ee.CEP))}</p>
    <p>${esc(txt(ee.xMun))} / ${esc(txt(ee.UF))}${txt(ee.fone) ? ` — Fone: ${esc(dig(ee.fone))}` : ''}</p></div>
  <div class="dan"><h1>DANFE</h1><p>Documento Auxiliar da<br>Nota Fiscal Eletrônica</p>
    <div class="tp"><span>0 - Entrada<br>1 - Saída</span><i>${esc(tpNF)}</i></div>
    <div class="n">Nº ${esc(num)}</div><div class="n">Série ${esc(txt(ide.serie))}</div><p>Folha 1/1</p></div>
  <div class="key">${code128cSvg(key)}<div class="lbl">CHAVE DE ACESSO</div><div class="k">${esc(fmtKey(key))}</div>
    <p>Consulta de autenticidade no portal nacional da NF-e<br>www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora</p></div>
</div>
${row(box('Natureza da operação', txt(ide.natOp), 'w3'), box('Protocolo de autorização de uso', protTxt, 'w2'))}
${row(box('Inscrição estadual', txt(emit.IE)), box('Insc. estadual do subst. trib.', txt(emit.IEST)), box('CNPJ / CPF', fmtDoc(emit.CNPJ || emit.CPF)))}
<div class="sec">DESTINATÁRIO / REMETENTE</div>
${row(box('Nome / razão social', txt(dest.xNome), 'w4'), box('CNPJ / CPF', fmtDoc(dest.CNPJ || dest.CPF), 'w2'), box('Data da emissão', fmtDate(ide.dhEmi || ide.dEmi)))}
${row(box('Endereço', [txt(ed.xLgr), txt(ed.nro), txt(ed.xCpl)].filter(Boolean).join(', '), 'w4'), box('Bairro / distrito', txt(ed.xBairro), 'w2'), box('CEP', fmtCep(ed.CEP)), box('Data da saída/entrada', fmtDate(ide.dhSaiEnt)))}
${row(box('Município', txt(ed.xMun), 'w3'), box('UF', txt(ed.UF), 'w05'), box('Fone / fax', dig(ed.fone)), box('Inscrição estadual', txt(dest.IE)), box('Hora da saída/entrada', fmtTime(ide.dhSaiEnt)))}
${dupHtml}
<div class="sec">CÁLCULO DO IMPOSTO</div>
${row(box('Base de cálc. do ICMS', money(tot.vBC)), box('Valor do ICMS', money(tot.vICMS)), box('Base de cálc. ICMS S.T.', money(tot.vBCST)), box('Valor do ICMS subst.', money(tot.vST)), box('Valor imp. importação', money(tot.vII)), box('Valor do PIS', money(tot.vPIS)), box('Valor total dos produtos', money(tot.vProd)))}
${row(box('Valor do frete', money(tot.vFrete)), box('Valor do seguro', money(tot.vSeg)), box('Desconto', money(tot.vDesc)), box('Outras despesas', money(tot.vOutro)), box('Valor total do IPI', money(tot.vIPI)), box('Valor da COFINS', money(tot.vCOFINS)), box('Valor total da nota', money(tot.vNF)))}
<div class="sec">TRANSPORTADOR / VOLUMES TRANSPORTADOS</div>
${row(box('Nome / razão social', txt(tr.xNome), 'w3'), box('Frete por conta', MODFRETE[txt(transp.modFrete)] ?? txt(transp.modFrete), 'w2'), box('Código ANTT', txt(veic.RNTC)), box('Placa do veículo', txt(veic.placa)), box('UF', txt(veic.UF), 'w05'), box('CNPJ / CPF', fmtDoc(tr.CNPJ || tr.CPF), 'w2'))}
${row(box('Endereço', txt(tr.xEnder), 'w3'), box('Município', txt(tr.xMun), 'w2'), box('UF', txt(tr.UF), 'w05'), box('Inscrição estadual', txt(tr.IE), 'w2'))}
${row(box('Quantidade', txt(vol.qVol)), box('Espécie', txt(vol.esp)), box('Marca', txt(vol.marca)), box('Numeração', txt(vol.nVol)), box('Peso bruto', qty(vol.pesoB, 3)), box('Peso líquido', qty(vol.pesoL, 3)))}
<div class="sec">DADOS DOS PRODUTOS / SERVIÇOS</div>
<table><colgroup><col style="width:7%"><col style="width:25%"><col style="width:7%"><col style="width:4%"><col style="width:4.5%"><col style="width:4%"><col style="width:6.5%"><col style="width:7%"><col style="width:7.5%"><col style="width:6.5%"><col style="width:6%"><col style="width:5.5%"><col style="width:4.5%"><col style="width:4.5%"></colgroup>
<thead><tr><th>Código</th><th>Descrição do produto / serviço</th><th>NCM/SH</th><th>CST</th><th>CFOP</th><th>Un.</th><th>Quant.</th><th>Valor unit.</th><th>Valor total</th><th>B. cálc. ICMS</th><th>Valor ICMS</th><th>Valor IPI</th><th>Alíq. ICMS</th><th>Alíq. IPI</th></tr></thead>
<tbody>${items}</tbody></table>
<div class="sec">DADOS ADICIONAIS</div>
<div class="adic"><div><b>INFORMAÇÕES COMPLEMENTARES</b>${esc(txt(adic.infCpl))}</div><div><b>RESERVADO AO FISCO</b>${esc(txt(adic.infAdFisco))}</div></div>
<div class="note">Gerado pelo sistema a partir do XML da nota. Impresso em ${esc(new Date().toLocaleString('pt-BR'))}.</div>
</div></body></html>`;
}

// Baixa o XML do Storage (link assinado) e abre o DANFE.
export async function openDanfe(signedXmlUrl: () => Promise<string | null>) {
  const w = window.open('', '_blank');
  if (!w) { toast.error('O navegador bloqueou a janela. Libere pop-ups para este site.'); return; }
  w.document.write('<p style="font:14px Arial;padding:24px;color:#475569">Gerando DANFE…</p>');
  try {
    const url = await signedXmlUrl();
    if (!url) throw new Error('Não consegui abrir o XML da nota.');
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Não consegui baixar o XML (${r.status}).`);
    const html = buildDanfeHtml(await r.text());
    w.document.open(); w.document.write(html); w.document.close();
  } catch (e) {
    w.close();
    toast.error('Não foi possível gerar o PDF da nota', { description: e instanceof Error ? e.message : String(e) });
  }
}
