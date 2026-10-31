import {hex} from './paragraph-pdf-crypto.mjs';
import {inferTypographyProfile} from './paper-typography-profile.mjs';
const enc=new TextEncoder(), fail=code=>{throw Object.assign(new Error(code),{code});};
const escapeMap={'\\':'\\textbackslash{}','{':'\\{','}':'\\}','$':'\\$','&':'\\&','#':'\\#','%':'\\%','_':'\\_','~':'\\textasciitilde{}','^':'\\textasciicircum{}'};
const escape=text=>Array.from(text, c=>escapeMap[c]??(c==='\r'||c==='\n'||c==='\t'?' ':c)).join('');
const num=n=>Number(n.toFixed(4)).toString();
const good=(x,min,max)=>Number.isFinite(x)&&x>=min&&x<=max;
export function serializeFlowReconstruction({model,decisions=[],profile,fontFiles=[]}={}) {
  if(model?.schema!=='falsify.pdf-latex-reconstruction.v1'||!/^[a-f0-9]{64}$/.test(model.sourceSha256||'')||!Array.isArray(model.pages)||!model.pages.length||!Array.isArray(model.items)||!Array.isArray(model.assets)||!Array.isArray(model.relations)||!Array.isArray(model.diagnostics)||!Array.isArray(decisions)||!Array.isArray(fontFiles)) fail('INVALID_MODEL');
  const pages=new Map(model.pages.map((p,i)=>{if(p.pageIndex!==i||!good(p.width,1,14400)||!good(p.height,1,14400)||p.frame!=='mupdf-display') fail('INVALID_PAGE');return [i,p];}));
  const refs=rs=>Array.isArray(rs)&&rs.length>0&&rs.every(r=>r?.sourceSha256===model.sourceSha256&&pages.has(r.pageIndex)&&r.frame==='mupdf-display'&&Array.isArray(r.bbox)&&r.bbox.length===4&&r.bbox.every(Number.isFinite)&&r.bbox[0]<=r.bbox[2]&&r.bbox[1]<=r.bbox[3]);
  const items=new Map(); for(const i of model.items){if(!i?.id||items.has(i.id)||!refs(i.evidence)||i.evidence.some(r=>r.pageIndex!==i.evidence[0].pageIndex)||!['observed','proposed','confirmed','unsupported'].includes(i.status))fail('INVALID_ITEM');items.set(i.id,i);}
  const choices=new Map();for(const d of decisions){const i=items.get(d?.itemId);if(!i||choices.has(d.itemId)||d.sourceSha256!==model.sourceSha256||typeof d.tex!=='string'||!d.tex.trim()||JSON.stringify(d.evidence)!==JSON.stringify(i.evidence))fail('INVALID_DECISION');choices.set(d.itemId,d);}
  const assets=new Map();for(const a of model.assets){if(!a?.id||assets.has(a.id)||!(a.bytes instanceof Uint8Array)||a.mediaType!=='image/png'||!['image','region-raster'].includes(a.representation)||a.editable!==false||!refs(a.evidence)||hex(a.bytes)!==a.sha256||![137,80,78,71,13,10,26,10].every((x,i)=>a.bytes[i]===x))fail('INVALID_ASSET');assets.set(a.id,a);}
  const t=profile?structuredClone(profile):inferTypographyProfile(model), p=t.page, body=t.body;
  if(t.schema!=='falsify.paper-typography.v1'||!p||![1,2].includes(p.columns)||!good(p.widthBp,72,14400)||!good(p.heightBp,72,14400)||!good(p.gutterBp,0,200)||!p.margins||!['left','right','top','bottom'].every(k=>good(p.margins[k],0,1000))||p.margins.left+p.margins.right>=p.widthBp||p.margins.top+p.margins.bottom>=p.heightBp||!good(body?.indentEm,0,10)||!good(body?.paragraphGapEm,0,10))fail('INVALID_TYPOGRAPHY');
  for(const r of ['body','heading','caption','footnote'])if(!good(t.roles?.[r]?.sizeBp,4,72)||!good(t.roles[r].leadingBp,4,150))fail('INVALID_TYPOGRAPHY');
  const files=[],fontPaths=new Map();for(const f of fontFiles){if(!(f?.bytes instanceof Uint8Array)||!f.bytes.length||!/\.(otf|ttf)$/i.test(f.path||'')||!['serif'].includes(f.role||'serif')||!['regular','bold','italic','bolditalic'].includes(f.style||'regular'))fail('INVALID_FONT');const k=f.style||'regular';if(fontPaths.has(k))fail('INVALID_FONT');const path=`fonts/${hex(f.bytes)}.${f.path.split('.').pop().toLowerCase()}`;fontPaths.set(k,path);files.push({path,bytes:f.bytes.slice()});}
  if(fontPaths.size&&!fontPaths.has('regular'))fail('INVALID_FONT');
  const diagnostics=model.diagnostics.map(d=>({...d})),bindings=[];let status=diagnostics.some(d=>d.severity==='error')?'unsupported':diagnostics.some(d=>d.severity==='warning')?'needs-review':'ready';
  const issue=(code,item,severity='warning')=>{diagnostics.push({code,severity,...(item?{itemId:item.id,pageIndex:item.evidence[0].pageIndex}:{})});if(severity==='error')status='unsupported';else if(status==='ready')status='needs-review';};
  issue('FLOW_LAYOUT_UNVERIFIED');for(const rel of model.relations)if(rel.status!=='confirmed')issue('RELATION_REVIEW');
  const font=fontPaths.has('regular')?`\\setmainfont[NFSSFamily=FalsifyBody,Path=fonts/,UprightFont={${fontPaths.get('regular').slice(6)}},${[...fontPaths].filter(([k])=>k!=='regular').map(([k,v])=>`${{bold:'BoldFont',italic:'ItalicFont',bolditalic:'BoldItalicFont'}[k]}={${v.slice(6)}}`).join(',')}]{FalsifyPublication}`:'\\setmainfont{Latin Modern Roman}';
  if(!fontPaths.size&&t.fonts?.serif!=='Latin Modern Roman')fail('INVALID_FONT');
  let source=`% !TeX program = lualatex\n\\documentclass${p.columns===2?'[twocolumn]':''}{article}\n\\usepackage{fontspec}\n\\usepackage{microtype}\n\\usepackage{graphicx}\n\\usepackage[paperwidth=${num(p.widthBp)}bp,paperheight=${num(p.heightBp)}bp,left=${num(p.margins.left)}bp,right=${num(p.margins.right)}bp,top=${num(p.margins.top)}bp,bottom=${num(p.margins.bottom)}bp]{geometry}\n${font}\n`;
  source+=t.packages?.needspace?'\\IfFileExists{needspace.sty}{\\usepackage{needspace}}{\\newcommand{\\Needspace}[1]{}}\n':'\\newcommand{\\Needspace}[1]{}\n';
  if(t.packages?.luaWidowControl)source+='\\IfFileExists{lua-widow-control.sty}{\\usepackage{lua-widow-control}}{}\n';
  source+=`\\setlength{\\columnsep}{${num(p.gutterBp)}bp}\n\\setlength{\\parindent}{${num(body.indentEm)}em}\n\\setlength{\\parskip}{${num(body.paragraphGapEm)}em}\n\\pagestyle{empty}\n\\begin{document}\n`;
  const append=(i,s,state)=>{const start=source.length;source+=s;bindings.push({itemId:i.id,projectId:null,path:'main.tex',start,end:source.length,evidence:structuredClone(i.evidence),status:state});};
  const role=i=>i.kind==='heading'?'heading':i.kind==='caption'||i.reason==='caption-proposal'?'caption':i.kind==='footnote'?'footnote':'body';
  const emitText=(i,text)=>{if(/[^\x00-\x7f]/u.test(text))issue('UNICODE_GLYPH_COVERAGE_UNVERIFIED',i);if(i.extensions?.candidates?.length||i.reason==='inline-script-candidate')issue('SEMANTIC_TRANSCRIPTION_REVIEW',i);return escape(text);};
  // Only the emitter's evidence-bound, adjacent caption relation can move into
  // a float. Other relations remain visible as review diagnostics.
  const groups=new Map(), groupedCaptions=new Set();
  for(const rel of model.relations){
    const figure=items.get(rel.from), caption=items.get(rel.to);
    const fi=model.items.indexOf(figure), ci=model.items.indexOf(caption);
    const expected=figure&&caption?[...figure.evidence,...caption.evidence]:null;
    if(rel.kind==='caption' && ['proposed','confirmed'].includes(rel.status) && figure?.assetId && role(caption||{})==='caption' && Math.abs(fi-ci)===1 && JSON.stringify(rel.evidence)===JSON.stringify(expected) && !groups.has(figure.id) && !groupedCaptions.has(caption.id) && figure.evidence[0].pageIndex===caption.evidence[0].pageIndex){groups.set(figure.id,caption.id);groupedCaptions.add(caption.id);}
    else if(rel.status==='confirmed')issue('RELATION_REVIEW');
  }
  const floatStart=new Map(), floatEnd=new Set();
  for(const [fid,cid] of groups){const fi=model.items.findIndex(i=>i.id===fid),ci=model.items.findIndex(i=>i.id===cid);floatStart.set(Math.min(fi,ci),true);floatEnd.add(Math.max(fi,ci));}
  for(const [index,i] of model.items.entries()){if(floatStart.has(index))source+='\\begin{figure}[htbp]\n\\centering\n';const r=role(i),style=t.roles[r],decision=choices.get(i.id);if(r==='heading')source+='\\Needspace{4\\baselineskip}\n';if(i.assetId||r==='caption')source+='\\Needspace{5\\baselineskip}\n';source+=`{\\fontsize{${num(style.sizeBp)}bp}{${num(style.leadingBp)}bp}\\selectfont `;if(r==='heading')source+='\\bfseries ';
    if(decision)append(i,decision.tex,'reviewed');
    else if(i.assetId){const a=assets.get(i.assetId);if(!a||a.evidence.some(e=>e.pageIndex!==i.evidence[0].pageIndex))fail('INVALID_ASSET_REFERENCE');const path=`assets/${a.sha256}.png`;if(!files.some(f=>f.path===path))files.push({path,bytes:a.bytes.slice()});append(i,`\\includegraphics[width=\\linewidth,height=.7\\textheight,keepaspectratio]{${path}}`,'noneditable');issue('NONEDITABLE_REGION',i);if(i.text){if(a.representation==='region-raster')issue('RASTER_TEXT_NONEDITABLE',i);else source+=' '+emitText(i,i.text);}}
    else if(i.kind==='table'&&i.table?.rows?.length){const rows=i.table.rows;if(!rows.every(row=>Array.isArray(row)&&row.length===rows[0].length&&row.every(c=>typeof c?.text==='string'&&refs(c.evidence)&&(c.colSpan??1)===1&&(c.rowSpan??1)===1)))fail('INVALID_TABLE');const content='\\begin{tabular}{'+'l'.repeat(rows[0].length)+'}\n'+rows.map(row=>row.map(c=>emitText(i,c.text)).join(' & ')+' \\\\').join('\n')+'\n\\end{tabular}';append(i,content,'review-required');issue('TABLE_LAYOUT_REVIEW',i);}
    else if(typeof i.text==='string'&&i.text.length)append(i,emitText(i,i.text),/[^\x00-\x7f]/u.test(i.text)||i.extensions?.candidates?.length||i.reason==='inline-script-candidate'?'review-required':'exact-text');
    else {issue('MISSING_CONTENT',i,'error');source+='% Missing source content';}
    source+='\\par}\n\n';
    if(r==='heading')source+='\\nopagebreak[4]\n';
    if(floatEnd.has(index))source+='\\end{figure}\n';
  }
  if(!model.items.length)issue('MISSING_CONTENT',null,'error');source+='\\end{document}\n';files.unshift({path:'main.tex',bytes:enc.encode(source)});return {files,mainFile:'main.tex',engine:'lualatex',bindings,diagnostics,status,typography:t};
}
