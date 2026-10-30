import {hex} from './paragraph-pdf-crypto.mjs';

const enc = new TextEncoder();
const hashPattern = /^[0-9a-f]{64}$/;
const png = [137,80,78,71,13,10,26,10];
const fail = code => { throw Object.assign(new Error(code), {code}); };
const finite = v => typeof v === 'number' && Number.isFinite(v);
const escapeMap = {'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}','-':'{-}','`':'\\textasciigrave{}',"'":'\\textquotesingle{}'};
function plain(text) {
  let unsupported = false, output = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (escapeMap[ch]) output += escapeMap[ch];
    else if (ch === '\n' || ch === '\r' || ch === '\t') output += ' ';
    else if (cp >= 32 && cp <= 126) output += ch;
    else { unsupported = true; output += `\\fbox{U+${cp.toString(16).toUpperCase()}}`; }
  }
  return {output,unsupported};
}
function evidenceValid(ref, hash, pages) {
  return ref && ref.sourceSha256 === hash && Number.isInteger(ref.pageIndex) && pages.has(ref.pageIndex) && ref.frame === 'mupdf-display' && Array.isArray(ref.bbox) && ref.bbox.length === 4 && ref.bbox.every(finite) && ref.bbox[0] <= ref.bbox[2] && ref.bbox[1] <= ref.bbox[3] && (!ref.range || Number.isInteger(ref.range.start) && Number.isInteger(ref.range.end) && ref.range.start >= 0 && ref.range.end >= ref.range.start);
}
function validRefs(refs, hash, pages) { return Array.isArray(refs) && refs.length > 0 && refs.every(r=>evidenceValid(r,hash,pages)); }

// Decisions are explicit baseline transcriptions: {itemId, sourceSha256, tex, evidence}.
// The caller binds the resulting project ID after createLatexProject().
export function serializeReconstruction({model, decisions=[], engine='pdflatex'}={}) {
  if (engine !== 'pdflatex') fail('UNSUPPORTED_ENGINE');
  if (!model || model.schema !== 'falsify.pdf-latex-reconstruction.v1' || !hashPattern.test(model.sourceSha256) || !Array.isArray(model.pages) || !model.pages.length || !Array.isArray(model.items) || !Array.isArray(model.assets) || !Array.isArray(model.diagnostics) || !Array.isArray(model.relations) || !Array.isArray(decisions)) fail('INVALID_MODEL');
  const hash=model.sourceSha256, pages=new Map();
  for (const p of model.pages) {
    if (!p || !Number.isInteger(p.pageIndex) || p.pageIndex !== pages.size || !finite(p.width) || !finite(p.height) || p.width <= 0 || p.height <= 0 || p.width > 14400 || p.height > 14400 || p.frame !== 'mupdf-display' || !Array.isArray(p.transform) || p.transform.length !== 6 || !p.transform.every(finite)) fail('INVALID_PAGE');
    pages.set(p.pageIndex,p);
  }
  const items=new Map();
  for (const item of model.items) {
    if (!item || typeof item.id !== 'string' || !item.id || !['observed','proposed','confirmed','unsupported'].includes(item.status) || items.has(item.id) || !validRefs(item.evidence,hash,pages) || item.evidence.some(r=>r.pageIndex!==item.evidence[0].pageIndex)) fail('INVALID_ITEM');
    items.set(item.id,item);
  }
  const choices=new Map();
  for (const d of decisions) {
    const item=items.get(d?.itemId);
    if (!item || choices.has(d.itemId) || d.sourceSha256!==hash || typeof d.tex!=='string' || !d.tex.trim() || !validRefs(d.evidence,hash,pages) || JSON.stringify(d.evidence)!==JSON.stringify(item.evidence)) fail('INVALID_DECISION');
    choices.set(d.itemId,d);
  }
  const assets=new Map();
  for (const a of model.assets) {
    if (!a || typeof a.id !== 'string' || !a.id || assets.has(a.id) || !(a.bytes instanceof Uint8Array) || a.mediaType!=='image/png' || !['region-raster','image'].includes(a.representation) || a.editable!==false || !validRefs(a.evidence,hash,pages) || !hashPattern.test(a.sha256) || hex(a.bytes)!==a.sha256 || !png.every((v,i)=>a.bytes[i]===v)) fail('INVALID_ASSET');
    assets.set(a.id,a);
  }
  const diagnostics=model.diagnostics.map(d=>({...d})), bindings=[], files=[];
  let status = diagnostics.some(d=>d.severity==='error') ? 'unsupported' : diagnostics.some(d=>d.severity==='warning') ? 'needs-review' : 'ready';
  const issue=(code,item,severity='warning')=>{diagnostics.push({code,severity,...(item?{itemId:item.id,pageIndex:item.evidence[0].pageIndex}:{})}); if(severity==='error') status='unsupported'; else if(status==='ready') status='needs-review';};
  let source='\\documentclass{article}\n\\usepackage{graphicx}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0pt}\n\\setlength{\\parskip}{6pt}\n\\begin{document}\n';
  const append=(item, body, bindingStatus)=>{const start=source.length; source+=body; bindings.push({itemId:item.id,projectId:null,path:'main.tex',start,end:source.length,evidence:structuredClone(item.evidence),status:bindingStatus}); source+='\n\n';};
  if (!model.items.length) issue('MISSING_CONTENT',null,'error');
  for (const relation of model.relations) if (relation.status!=='confirmed') issue('RELATION_REVIEW');
  let previousPage=-1;
  for (const item of model.items) {const page=item.evidence[0].pageIndex; if(page<previousPage) issue('PAGE_ORDER_REVIEW',item); previousPage=page;}
  let assetNumber=0;
  for (const [index,p] of pages) {
    if(index) source+='\\newpage\n';
    if (!model.items.some(i=>i.evidence[0].pageIndex===index)) { issue('EMPTY_PAGE_REVIEW'); source+='\\null\n'; }
    source+=`\\pdfpagewidth=${p.width}pt\\pdfpageheight=${p.height}pt\n\\setlength{\\textwidth}{${Math.max(1,p.width-72)}pt}\\setlength{\\textheight}{${Math.max(1,p.height-72)}pt}\\hsize=\\textwidth\\vsize=\\textheight\n\\setlength{\\oddsidemargin}{-36pt}\\setlength{\\topmargin}{-72pt}\\setlength{\\headheight}{0pt}\\setlength{\\headsep}{0pt}\n`;
    for (const item of model.items.filter(i=>i.evidence[0].pageIndex===index)) {
      const decision=choices.get(item.id);
      if (decision) {append(item,decision.tex,'reviewed'); continue;}
      if (item.extensions?.columns > 1) issue('MULTICOLUMN_REVIEW',item);
      if (item.kind==='table' && item.table) {
        const rows=item.table.rows;
        const width=Array.isArray(rows)&&rows[0]?.length;
        const valid=width>0 && rows.every(row=>Array.isArray(row)&&row.length===width&&row.every(c=>c&&typeof c.text==='string'&&(c.colSpan===undefined||c.colSpan===1)&&(c.rowSpan===undefined||c.rowSpan===1)&&validRefs(c.evidence,hash,pages)&&c.evidence.every(r=>r.pageIndex===index)));
        if(valid) {
          const cells=rows.map(row=>row.map(c=>plain(c.text)));
          if(cells.flat().some(c=>c.unsupported)) issue('UNICODE_REVIEW',item);
          const original=cells.flat().some(c=>c.unsupported) ? rows.flat().map(c=>'% Original UTF-8 cell: '+c.text.replace(/[\r\n]/g,' ')).join('\n')+'\n' : '';
          append(item,original+'\\begin{tabular}{'+('l'.repeat(width))+'}\n'+cells.map(row=>row.map(c=>c.output).join(' & ')+' \\\\').join('\n')+'\n\\end{tabular}','reviewed');
          continue;
        }
        issue('TABLE_STRUCTURE_REVIEW',item);
      }
      if (item.assetId) {
        const a=assets.get(item.assetId);
        if (!a || a.evidence.some(r=>r.pageIndex!==index)) fail('INVALID_ASSET_REFERENCE');
        const path=`assets/region-${++assetNumber}.png`;
        files.push({path,bytes:a.bytes.slice()});
        append(item,`\\includegraphics[width=\\linewidth,keepaspectratio]{${path}}`,'noneditable');
        issue('NONEDITABLE_REGION',item); continue;
      }
      const semantic = ['math','footnote','citation'].includes(item.kind) || item.reason==='inline-script-candidate' || !!item.extensions?.candidates?.length;
      if (typeof item.text==='string' && item.text.length) {
        const text=plain(item.text);
        if (text.unsupported) issue('UNICODE_REVIEW',item);
        if (/\s{2}|[\r\n\t]/.test(item.text)) issue('TEXT_SPACING_REVIEW',item);
        if (semantic) issue('TRANSCRIPTION_REVIEW',item);
        if (!['paragraph','heading'].includes(item.kind)) issue('ITEM_KIND_REVIEW',item);
        if (item.status==='unsupported') issue('UNSUPPORTED_ITEM',item);
        const original=text.unsupported ? '% Original UTF-8 text: '+item.text.replace(/[\r\n]/g,' ')+'\n' : '';
        const body=original+(item.kind==='heading' ? `\\textbf{${text.output}}` : text.output);
        append(item,body,'exact-text');
      } else {
        issue('MISSING_CONTENT',item,'error');
        source+=`% Content missing for item ${index + 1}; review source evidence.\n`;
      }
    }
  }
  source+='\\end{document}\n';
  files.unshift({path:'main.tex',bytes:enc.encode(source)});
  return {status,files,mainFile:'main.tex',bindings,diagnostics};
}
