/* Portable, offline external response adapter. AGPL-3.0-only. */
(function(root,factory){if(typeof module==='object'&&module.exports){let s=null;try{s=require('./blue-defect-sensor-core.js');}catch{}module.exports=factory(require('./external-red.js'),s);}else root.FalsifyExternalExchange=factory(root.FalsifyExternalRed,root.FalsifyBlueDefectSensor);})(typeof globalThis==='object'?globalThis:this,function(red,sensor){
  'use strict';
  const getSensor=()=>sensor||globalThis.FalsifyBlueDefectSensor||null;
  const id=()=>typeof crypto!=='undefined'&&crypto.randomUUID?crypto.randomUUID():'external-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
  const strings=v=>Array.isArray(v)?v.filter(x=>typeof x==='string'):typeof v==='string'&&v?[v]:[];
  const evidence=v=>Array.isArray(v)?v.map(x=>JSON.parse(JSON.stringify(x))):typeof v==='string'&&v?[v]:[];
  // Each output code unit retains the corresponding original start/end offsets.
  function normalize(text){
    let value='',starts=[],ends=[];
    for(let i=0;i<text.length;){
      if(text[i]==='-'&&/\r|\n/.test(text[i+1]||'')){let j=i+1;while(j<text.length&&/\s/.test(text[j]))j++;if(j<text.length&&/[\p{L}]/u.test(text[j])){i=j;continue;}}
      if(/\s/.test(text[i])){let j=i+1;while(j<text.length&&/\s/.test(text[j]))j++;value+=' ';starts.push(i);ends.push(j);i=j;continue;}
      value+=text[i];starts.push(i);ends.push(i+1);i++;
    }
    return {value,starts,ends};
  }
  function locate(item,segments,needle){
    const q=normalize(needle).value.trim();if(!q)return;
    if(locateWithAnchors(item,segments,needle))return;
    let scope=segments;
    if(item.segmentId)scope=scope.filter(s=>s.id===item.segmentId);
    if(item.pageIndex!=null)scope=scope.filter((s,i)=>(s.pageIndex??red.pageIndexFromLabel(s.label)??segments.indexOf(s))===item.pageIndex);
    const matches=locateMatches(scope,segments,q);
    if(!matches.length&&(item.pageIndex!=null||item.segmentId)){const hintPage=item.pageIndex,hintSegment=item.segmentId;item.pageIndex=null;item.segmentId=null;locate(item,segments,needle);if(item.matchStatus==='missing'){item.pageIndex=hintPage;item.segmentId=hintSegment;}return;}
    item.matches=matches;item.matchStatus=matches.length===1?'matched':matches.length?'ambiguous':'missing';
    bindMatch(item,segments,matches);
  }
  function locateMatches(scope,segments,q){
    const matches=[];
    for(const s of scope){const n=normalize(s.text);let at=0;while((at=n.value.indexOf(q,at))!==-1){const start=n.starts[at],end=n.ends[at+q.length-1],pageIndex=s.pageIndex??red.pageIndexFromLabel(s.label)??segments.indexOf(s);matches.push({segmentId:s.id,pageIndex,start,end});at++;if(matches.length>100)break;}}
    return matches;
  }
  function bindMatch(item,segments,matches){
    if(matches.length===1){const m=matches[0],s=segments.find(x=>x.id===m.segmentId);item.segmentId=m.segmentId;item.pageIndex=m.pageIndex;item.anchor={start:m.start,end:m.end};if(item.kind==='change')item.before=s.text.slice(m.start,m.end);else item.sourceQuote=s.text.slice(m.start,m.end);}
    else item.anchor=null;
  }
  function locateWithAnchors(item,segments,needle){
    const finder=globalThis.FalsifyPaperAnchors?.find;
    if(typeof finder==='function'){
      const found=finder({quote:needle,segments,pageIndex:item.pageIndex,segmentId:item.segmentId});
      if(found&&Array.isArray(found.matches)){
        item.matches=found.matches;item.matchStatus=found.status;item.anchor=null;
        if(found.status==='matched'&&found.matches.length===1){const m=found.matches[0],s=segments.find(x=>x.id===m.segmentId);if(s&&Number.isInteger(m.start)&&Number.isInteger(m.end)){item.segmentId=m.segmentId;item.pageIndex=m.pageIndex;item.anchor={start:m.start,end:m.end};if(item.kind==='change')item.before=s.text.slice(m.start,m.end);else item.sourceQuote=s.text.slice(m.start,m.end);}}
        return true;
      }
    }
    return false;
  }
  function json(raw){const text=raw.trim().replace(/^\uFEFF/,'');try{return JSON.parse(text);}catch{}const fence=/```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);if(fence){try{return JSON.parse(fence[1]);}catch{}}return null;}
  const tableCells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(x=>x.trim().replace(/\\\|/g,'|'));
  const sepLine=line=>/^\s*\|?[\s:|\-]+\|?\s*$/.test(line||'')&&line.includes('-');
  function parsePageNum(v){
    if(typeof v==='number')return Number.isInteger(v)&&v>0&&v<=100000?v:undefined;
    const text=String(v||'').trim();
    if(!text)return undefined;
    const m=/^(?:PDF\s*)?(?:p(?:age)?\.?\s*)?(\d{1,5})(?:\s*(?:쪽|p(?:age)?\.?))?(?:\s*[\(\[\/|,·].*)?$/i.exec(text);
    if(!m)return undefined;
    const n=Number(m[1]);
    return Number.isInteger(n)&&n>0&&n<=100000?n:undefined;
  }
  const normHeader=text=>String(text||'').replace(/^\uFEFF/,'').replace(/\s+/g,'').replace(/[·・･∙]/g,'·').toLowerCase();
  const normCompare=text=>String(text||'').replace(/\s+/g,' ').trim().toLowerCase();
  function findHeader(headers,match){return headers.findIndex(match);}
  function isEvidenceHeader(h){
    return h==='왜결함인가'||h==='대응근거·이유·검산'||h.startsWith('대응근거·이유·검산(')||h==='대응근거,이유,검산'||h.startsWith('대응근거,이유,검산(');
  }
  function isLocationHeader(h){
    return h==='위치(절·그림·표)'||h==='위치(절,그림,표)'||h==='위치(절/그림/표)'||h==='위치';
  }
  function findingHeaderIndices(header){
    const h=header.map(normHeader);
    const cols={
      id:findHeader(h,x=>x==='id'||x==='번호'),
      page:findHeader(h,x=>x==='물리페이지'||x==='쪽'||x==='페이지'||x==='pdf쪽'),
      location:findHeader(h,isLocationHeader),
      type:findHeader(h,x=>x==='유형'||x==='결함유형'),
      verdict:findHeader(h,x=>x==='판정'||x.startsWith('판정(')),
      severity:findHeader(h,x=>x==='심각도'),
      quote:findHeader(h,x=>x==='정확한원문인용'||x==='인용한원문'||x==='원문인용'),
      evidence:findHeader(h,isEvidenceHeader),
      confidence:findHeader(h,x=>x==='확신'||x==='확신도'),
      uncertainty:findHeader(h,x=>x==='추가로필요한정보'||x==='추가필요정보'),
      model:findHeader(h,x=>x==='모델'),
      condition:findHeader(h,x=>x==='조건')
    };
    const core=[cols.id,cols.page,cols.location,cols.type,cols.quote,cols.evidence,cols.confidence];
    if(core.some(n=>n<0)||(cols.severity<0&&cols.verdict<0))return null;
    return cols;
  }
  function parseEvidenceMarkerLine(body){
    const split=/^(.*?)\s*\|\s*인용:\s*([\s\S]+)$/.exec(body);
    if(split)return {relation:split[1].trim(),quote:split[2].trim()};
    const qOnly=/^인용:\s*([\s\S]+)$/.exec(body);
    if(qOnly)return {relation:'',quote:qOnly[1].trim()};
    return body.trim();
  }
  function appendEvidenceContinuation(list,line){
    const last=list[list.length-1];
    if(typeof last==='string')list[list.length-1]=last+'\n'+line;
    else if(last.quote)last.quote+='\n'+line;
    else last.relation+='\n'+line;
  }
  function parseEvidenceCellText(rawText){
    const text=String(rawText||'');
    if(!/(?:^|\n)\[(?:근거(?:\s+\d+)?|참고(?:\s+\d+)?)\]/.test(text))return {rationale:text,evidence:[],references:[]};
    const rationaleLines=[],evidenceList=[],refList=[];
    let active='';
    for(const line of text.split(/\r?\n/)){
      const ev=/^\[근거(?:\s+\d+)?\]\s*(.*)$/.exec(line);
      if(ev){active='ev';const parsed=parseEvidenceMarkerLine(ev[1]);if(parsed)evidenceList.push(parsed);continue;}
      const ref=/^\[참고(?:\s+\d+)?\]\s*(.*)$/.exec(line);
      if(ref){active='ref';if(ref[1].trim())refList.push(ref[1].trim());continue;}
      if(active==='ev'&&evidenceList.length)appendEvidenceContinuation(evidenceList,line);
      else if(active==='ref'&&refList.length)refList[refList.length-1]+='\n'+line;
      else rationaleLines.push(line);
    }
    return {rationale:rationaleLines.join('\n').trim(),evidence:evidenceList,references:refList};
  }
  function cellAt(row,idx){return idx>=0&&idx<row.length?String(row[idx]??''):'';}
  function mapFindingRow(row,cols){
    const ev=parseEvidenceCellText(cellAt(row,cols.evidence));
    const sevRaw=cols.severity>=0?cellAt(row,cols.severity):cellAt(row,cols.verdict);
    const entry={
      reportNumber:cellAt(row,cols.id).trim(),
      page:parsePageNum(cellAt(row,cols.page)),
      locationLabel:cellAt(row,cols.location).trim(),
      findingType:cellAt(row,cols.type).trim(),
      severity:sevRaw.trim(),
      quote:cellAt(row,cols.quote),
      rationale:ev.rationale,
      confidence:cellAt(row,cols.confidence).trim()
    };
    if(ev.evidence.length)entry.evidence=ev.evidence;
    if(ev.references.length)entry.references=ev.references;
    if(cols.verdict>=0)entry.verdictLabel=cellAt(row,cols.verdict).trim();
    if(cols.uncertainty>=0)entry.uncertainty=cellAt(row,cols.uncertainty);
    return entry;
  }
  function collectUniformMeta(rows,idx){
    if(idx<0)return '';
    const values=new Set();
    for(const row of rows){const v=cellAt(row,idx).trim();if(v)values.add(v);}
    return values.size===1?[...values][0]:'';
  }
  function readTableRows(lines,startRow,headerLen,mapRow){
    const entries=[],malformed=[];let j=startRow;const fenced=startRow>=3&&/^\s*`{3,}(?:\w+)?\s*$/.test(lines[startRow-3]);
    for(;j<lines.length;j++){if(!lines[j].includes('|')||!lines[j].trim())break;const row=tableCells(lines[j]);if(row.length<headerLen){malformed.push(j+1);continue;}entries.push(mapRow(row));}
    if(fenced&&/^\s*`{3,}\s*$/.test(lines[j]||''))j++;
    return {entries,malformed,endLine:j};
  }
  function markdownStage1(lines){
    for(let i=0;i+1<lines.length;i++){
      if(!sepLine(lines[i+1]))continue;
      const h=tableCells(lines[i]).map(x=>x.replace(/\s/g,'').toLowerCase());
      const cols=['후보id','쪽','위치','유형','인용한원문','의심내용'].map(n=>h.indexOf(n));
      if(cols.some(n=>n<0))continue;
      const res=readTableRows(lines,i+2,h.length,row=>{const v=cols.map(n=>row[n]);return {candidateId:v[0],page:parsePageNum(v[1]),locationLabel:v[2],defectFamily:v[3],quote:v[4],suspicion:v[5]};});
      if(res.entries.length)return res;
    }
    return null;
  }
  function markdownFindings(raw){
    const lines=raw.split(/\r?\n/),stage1=markdownStage1(lines),startAt=stage1?stage1.endLine:0;
    for(let i=startAt;i+1<lines.length;i++){
      if(!sepLine(lines[i+1]))continue;
      const header=tableCells(lines[i]),cols=findingHeaderIndices(header);if(!cols)continue;
      const rawRows=[];
      const res=readTableRows(lines,i+2,header.length,row=>{rawRows.push(row);return mapFindingRow(row,cols);});
      const meta={model:collectUniformMeta(rawRows,cols.model),condition:collectUniformMeta(rawRows,cols.condition)};
      if(stage1&&getSensor()?.reconcileCandidateLedger){
        const rec=getSensor().reconcileCandidateLedger(stage1.entries,res.entries);
        return {entries:rec.findings,malformed:res.malformed,report:lines.slice(res.endLine).join('\n').trim(),zeroDropSummary:rec.summary,meta};
      }
      if(res.entries.length)return {entries:res.entries,malformed:res.malformed,report:lines.slice(res.endLine).join('\n').trim(),meta};
    }
    return null;
  }
  function isCsvProseStop(stopOnProse,rows,row){
    return stopOnProse&&rows.length&&row.length===1&&/^(?:#{1,6}\s|```|---+$)/.test(row[0].trim());
  }
  function stepQuotedCsv(src,i,st){
    const ch=src[i];
    if(ch==='"'&&src[i+1]==='"'){st.cell+='"';return i+1;}
    if(ch==='"'){st.inQuotes=false;return i;}
    if(ch==='\n')st.lineNum++;
    st.cell+=ch;
    return i;
  }
  function commitCsvLine(st,stopOnProse){
    st.row.push(st.cell);
    const blank=st.row.length===1&&!st.row[0].trim();
    if(blank){st.row=[];st.cell='';return false;}
    if(isCsvProseStop(stopOnProse,st.rows,st.row))return true;
    st.rows.push({cells:st.row,line:st.rowStart});
    st.row=[];st.cell='';
    return false;
  }
  function parseCsvRecords(text,stopOnProse){
    const src=String(text||'').replace(/^\uFEFF/,'');
    const st={rows:[],row:[],cell:'',inQuotes:false,lineNum:1,rowStart:1};
    for(let i=0;i<src.length;i++){
      if(st.inQuotes){i=stepQuotedCsv(src,i,st);continue;}
      const ch=src[i];
      if(ch==='"'&&!st.cell){st.inQuotes=true;continue;}
      if(ch===','){st.row.push(st.cell);st.cell='';continue;}
      if(ch==='\r'||ch==='\n'){
        if(ch==='\r'&&src[i+1]==='\n')i++;
        if(commitCsvLine(st,stopOnProse))return {rows:st.rows,unclosed:false};
        st.lineNum++;st.rowStart=st.lineNum;
        continue;
      }
      st.cell+=ch;
    }
    if(st.inQuotes)return {rows:st.rows,unclosed:true,unclosedLine:st.rowStart};
    if(st.cell.length||st.row.length)commitCsvLine(st,false);
    return {rows:st.rows,unclosed:false};
  }
  function buildCsvResult(parsed,cols,headerLen){
    const entries=[],malformed=[],rawRows=[];
    for(let i=1;i<parsed.rows.length;i++){
      const r=parsed.rows[i];
      if(r.cells.length<headerLen){malformed.push(r.line);continue;}
      rawRows.push(r.cells);
      entries.push(mapFindingRow(r.cells,cols));
    }
    if(parsed.unclosed)malformed.push(parsed.unclosedLine||parsed.rows.length+1);
    if(!entries.length&&!malformed.length)return null;
    return {entries,malformed,meta:{model:collectUniformMeta(rawRows,cols.model),condition:collectUniformMeta(rawRows,cols.condition)}};
  }
  function parseCsvCandidate(text,stopOnProse){
    const parsed=parseCsvRecords(text,stopOnProse);
    if(!parsed.rows.length)return null;
    const cols=findingHeaderIndices(parsed.rows[0].cells);
    return cols?buildCsvResult(parsed,cols,parsed.rows[0].cells.length):null;
  }
  function findEmbeddedCsvStart(raw){
    const lines=raw.split(/\r?\n/);let inFence=false,offset=0;
    for(let i=0;i<lines.length;i++){
      const line=lines[i];
      if(/^\s*`{3,}/.test(line)){inFence=!inFence;offset+=line.length+1;continue;}
      if(!inFence&&line.includes(',')&&!line.trim().startsWith('|')){
        const head=parseCsvRecords(line,false).rows[0]?.cells;
        if(head&&findingHeaderIndices(head))return offset;
      }
      offset+=line.length+1;
    }
    return -1;
  }
  function csvFindings(raw){
    const direct=parseCsvCandidate(raw,false);
    if(direct)return direct;
    const fenceRe=/```([^\n`]*)\n([\s\S]*?)```/g;
    let match;
    while((match=fenceRe.exec(raw))){
      const info=match[1].trim().toLowerCase();
      if(info&&info!=='csv'&&info!=='text'&&info!=='txt')continue;
      const res=parseCsvCandidate(match[2],false);
      if(res)return res;
    }
    const at=findEmbeddedCsvStart(raw);
    return at>=0?parseCsvCandidate(raw.slice(at),true):null;
  }
  function uniqueReportIdSet(entries){
    const counts=new Map();
    for(const e of entries){const k=normCompare(e.reportNumber);if(k)counts.set(k,(counts.get(k)||0)+1);}
    return new Set([...counts.entries()].filter(([,n])=>n===1).map(([k])=>k));
  }
  function entryMatchesPair(a,b,uniqueA,uniqueB){
    const idA=normCompare(a.reportNumber),idB=normCompare(b.reportNumber);
    if(idA&&idA===idB&&uniqueA.has(idA)&&uniqueB.has(idB))return true;
    const qA=normCompare(a.quote),qB=normCompare(b.quote);
    const rA=normCompare(a.rationale),rB=normCompare(b.rationale);
    if(a.page!==b.page)return false;
    if(qA&&qA===qB)return true;
    return !qA&&!qB&&!!rA&&rA===rB;
  }
  function mergeSingleEntry(primary,fallback){
    const out={...primary};
    for(const k of ['reportNumber','locationLabel','findingType','verdictLabel','severity','quote','rationale','confidence','uncertainty']){
      if(!out[k]&&fallback[k])out[k]=fallback[k];
    }
    if(out.page===undefined&&fallback.page!==undefined)out.page=fallback.page;
    if(!out.evidence?.length&&fallback.evidence?.length)out.evidence=fallback.evidence;
    if(!out.references?.length&&fallback.references?.length)out.references=fallback.references;
    return out;
  }
  function mergeTableAndCsv(md,csv){
    if(!md)return csv;
    if(!csv)return md;
    const uniqueMd=uniqueReportIdSet(md.entries),uniqueCsv=uniqueReportIdSet(csv.entries);
    const usedMd=new Set(),merged=[];
    for(const c of csv.entries){
      const hit=md.entries.findIndex((m,i)=>!usedMd.has(i)&&entryMatchesPair(c,m,uniqueCsv,uniqueMd));
      if(hit>=0){usedMd.add(hit);merged.push(mergeSingleEntry(c,md.entries[hit]));}
      else merged.push(c);
    }
    md.entries.forEach((m,i)=>{if(!usedMd.has(i))merged.push(m);});
    return {
      entries:merged,
      malformed:[...(md.malformed||[]),...(csv.malformed||[])],
      report:md.report||'',
      zeroDropSummary:md.zeroDropSummary,
      meta:{model:csv.meta?.model||md.meta?.model||'',condition:csv.meta?.condition||md.meta?.condition||''}
    };
  }
  function canUseRedFallback(role,segments,options){
    return role==='red'&&red&&(segments.length||Array.isArray(options.tables)||Array.isArray(options.figures));
  }
  function recoverBlueJsonTail(text){
    if(!/^\{\s*"/u.test(text))return null;
    const entriesText=text.replace(/\](?:\s*\})?$/u,'');
    if(entriesText===text)return null;
    try{
      const entries=JSON.parse('['+entriesText+']');
      return entries.every(entry=>entry&&(typeof entry.reportNumber==='string'||typeof entry.id==='string'))?entries:null;
    }catch{return null;}
  }
  function appendBlueTextFallback(raw,segments,batch,options){
    const trimmed=raw.trim();
    const fence=/^```json[ \t]*\r?\n([\s\S]*?)(?:\r?\n```)?$/i.exec(trimmed);
    const text=fence?fence[1].trim():trimmed;
    const recovered=recoverBlueJsonTail(text);
    if(recovered){
      recovered.forEach((entry,index)=>appendResponseItem(entry,index,'blue',segments,batch,options));
      if(batch.items.length){
        batch.partial=true;
        batch.diagnostics.push({code:'partial-blue-json',message:'일부가 빠진 JSON에서 읽을 수 있는 항목을 가져왔어요.'});
        return;
      }
    }
    if(fence||/^\s*(?:\{\s*"|\[\s*(?:\{|"))/u.test(text)||/(?:^|\n)[ \t]*```json\b/i.test(text)){
      batch.diagnostics.push({code:'invalid-blue-json',message:'JSON에서 지적 항목을 읽지 못했어요. 붙여넣은 내용은 그대로 있어요.'});
      return;
    }
    batch.items.push({id:id(),kind:'finding',rationale:trimmed,evidence:[],references:[],attackTypes:[],uncertainty:'',segmentId:null,pageIndex:null,matchStatus:'missing',anchor:null,matches:[]});
  }
  function parse(raw,options={}){
    if(typeof raw!=='string')throw new TypeError('Response must be text');
    const role=options.role;if(role!=='red'&&role!=='blue')throw new Error('Invalid role');
    const segments=Array.isArray(options.segments)?options.segments.filter(s=>s&&typeof s.id==='string'&&typeof s.text==='string'):[];
    const batch={schema:'falsify.external-batch.v1',id:id(),role,fileHash:options.fileHash,raw,importedAt:new Date().toISOString(),status:'unparsed',items:[],diagnostics:[]};
    copyBatchOptions(options,batch);
    if(raw.length>red.LIMITS.inputChars){batch.diagnostics.push({code:'input-limit',message:'응답이 길이 한도를 넘어 자동으로 읽지 못했습니다. 원문은 보관됩니다.'});return batch;}
    const obj=json(raw);
    readBatchMetadata(obj,options,role,batch);
    const list=responseItems(raw,obj,role,batch);
    if(Array.isArray(list))list.forEach((entry,index)=>appendResponseItem(entry,index,role,segments,batch,options));
    else if(canUseRedFallback(role,segments,options))appendRedFallback(raw,segments,options,batch);
    else if(role==='blue'&&raw.trim()&&!obj)appendBlueTextFallback(raw,segments,batch,options);
    if(batch.items.length)batch.status='ok';
    return batch;
  }
  function copyBatchOptions(options,batch){
    for(const key of ['model','prompt','harness','requestId','condition'])if(options[key]!=null)batch[key]=options[key];
  }
  function fallbackChunks(raw){
    return raw.split(/\n[ \t]*---[ \t]*(?:\n|$)/).filter(c=>/(?:^|\n)[ \t]*(?:before|이전|Table\s*Edit|표\s*셀\s*변경|Chart\s*Edit|Visual\s*Edit|차트\s*수치\s*변경)/i.test(c));
  }
  function chunkField(chunk,names){
    for(const name of names){const m=new RegExp('(?:^|\\n)[ \\t]*'+name+'[ \\t]*:[ \\t]*([^\\n]*)','i').exec(chunk);if(m)return m[1].trim();}
    return '';
  }
  function appendRedFallback(raw,segments,options,batch){
    const parsed=red.parse(raw,{segments,fileHash:options.fileHash||'exchange-fallback',tables:options.tables,figures:options.figures});
    batch.diagnostics.push(...parsed.diagnostics);
    const chunks=fallbackChunks(raw);
    for(const [index,p] of parsed.proposals.entries()){
      const chunk=chunks[index]||'';
      const item={id:id(),kind:p.kind||'change',before:p.before,after:p.after,rationale:chunkField(chunk,['rationale','근거','이유']),evidence:strings(chunkField(chunk,['evidence','출처'])),references:strings(chunkField(chunk,['references','참고'])),attackTypes:[],uncertainty:chunkField(chunk,['uncertainty','불확실성']),segmentId:p.segmentId,pageIndex:p.pageIndex,matchStatus:p.matchStatus||p.status,anchor:p.anchor,matches:p.matches};
      if(p.kind==='table-cell'){item.tableTarget=p.tableTarget;}
      else if(p.kind==='chart-point'){item.visualTarget=p.visualTarget;}
      else locate(item,segments,item.before);
      batch.items.push(item);
    }
  }
  function structuredKind(entry){
    const k=entry&&(entry.kind||entry.targetKind);
    if(k==='table-cell')return 'table-cell';
    if(k==='chart-point'||k==='visual-edit')return 'chart-point';
    return null;
  }
  function appendStructuredRedItem(entry,kind,segments,batch,options){
    const resolved=kind==='table-cell'
      ?red.resolveTableEdit(entry,{segments,tables:options.tables,diagnostics:batch.diagnostics})
      :red.resolveVisualEdit(entry,{figures:options.figures,diagnostics:batch.diagnostics});
    if(!resolved)return;
    const item=createResponseItem(entry,'red');
    item.kind=resolved.kind;
    item.before=resolved.before;
    item.after=resolved.after;
    item.segmentId=resolved.segmentId;
    item.pageIndex=resolved.pageIndex;
    item.matchStatus=resolved.matchStatus||resolved.status;
    item.anchor=resolved.anchor;
    item.matches=resolved.matches;
    if(resolved.kind==='table-cell')item.tableTarget=resolved.tableTarget;
    else item.visualTarget=resolved.visualTarget;
    batch.items.push(item);
  }
  function populateBlueItem(item,entry,index,segments,batch){
    copyFindingFields(item,entry);
    if(['rejected','unresolved'].includes(entry.status || entry.state)) item.status=entry.status || entry.state;
    if(typeof entry.quote==='string'&&entry.quote){item.quote=entry.quote;locate(item,segments,item.quote);}
    if(!item.quote&&!item.rationale&&!item.evidence.length){batch.diagnostics.push({code:'malformed-item',index,message:'내용이 없는 지적입니다.'});return false;}
    return true;
  }
  function appendResponseItem(entry,index,role,segments,batch,options={}){
    if(!entry||typeof entry!=='object'||Array.isArray(entry)){batch.diagnostics.push({code:'malformed-item',index,message:'이 항목을 읽지 못했습니다.'});return;}
    const sk=role==='red'?structuredKind(entry):null;
    if(sk){appendStructuredRedItem(entry,sk,segments,batch,options);return;}
    const item=createResponseItem(entry,role);
    if(role==='red'){
      if(typeof entry.before!=='string'||!entry.before.trim()||typeof entry.after!=='string'){batch.diagnostics.push({code:'malformed-item',index,message:'이 항목을 읽지 못했습니다.'});return;}
      item.before=entry.before;item.after=entry.after;locate(item,segments,item.before);
    }else if(!populateBlueItem(item,entry,index,segments,batch))return;
    batch.items.push(item);
  }
  const EXTRA_STRING_ALIASES=[
    ['reportNumber',['id']],
    ['findingType',['defect_type','type']],
    ['verdictLabel',['verdict']],
    ['locationLabel',['location']],
    ['uncertainty',['additionalInfo','neededInfo']]
  ];
  function copyAliasField(item,entry,target,aliases){
    if(item[target])return;
    for(const key of aliases){
      const val=entry[key];
      if(typeof val==='string'&&val.trim()){item[target]=target==='uncertainty'?val:val.trim();return;}
    }
  }
  function copyExtraFindingFields(item,entry){
    for(const [target,aliases] of EXTRA_STRING_ALIASES)copyAliasField(item,entry,target,aliases);
    if(item.confidence===undefined&&typeof entry.confidence==='number'&&Number.isFinite(entry.confidence))item.confidence=String(entry.confidence);
  }
  function copyFindingFields(item,entry){
        for(const key of ['findingType','severity','confidence','locationLabel','reportNumber','verdictLabel','defectFamily'])if(typeof entry[key]==='string')item[key]=entry[key];copyExtraFindingFields(item,entry);if(entry.zeroDropRecovered===true)item.zeroDropRecovered=true;if(item.pageIndex===null&&Number.isInteger(entry.page)&&entry.page>0)item.pageIndex=entry.page-1;
  }
  function rationaleOf(entry){
    for(const key of ['rationale','description','message','reason'])if(typeof entry[key]==='string')return entry[key];
    return '';
  }
  function createResponseItem(entry,role){
        return {id:id(),kind:role==='red'?'change':'finding',rationale:rationaleOf(entry),evidence:evidence(entry.evidence),references:evidence(entry.references),attackTypes:strings(entry.attackTypes),uncertainty:typeof entry.uncertainty==='string'?entry.uncertainty:'',segmentId:typeof entry.segmentId==='string'?entry.segmentId:null,pageIndex:Number.isInteger(entry.pageIndex)&&entry.pageIndex>=0?entry.pageIndex:null,matchStatus:'missing',anchor:null,matches:[]};
  }
  function collectRedJsonList(obj,batch){
    const prose=obj.changes??obj.candidates??obj.edits;
    const out=Array.isArray(prose)?prose.slice():[];
    if(obj.tableEdits!==undefined){
      if(Array.isArray(obj.tableEdits))out.push(...obj.tableEdits.map(x=>x&&typeof x==='object'&&!Array.isArray(x)?{...x,kind:'table-cell'}:x));
      else batch.diagnostics.push({code:'malformed-item',message:'tableEdits가 배열이 아닙니다.'});
    }
    if(obj.visualEdits!==undefined){
      if(Array.isArray(obj.visualEdits))out.push(...obj.visualEdits.map(x=>x&&typeof x==='object'&&!Array.isArray(x)?{...x,kind:'chart-point'}:x));
      else batch.diagnostics.push({code:'malformed-item',message:'visualEdits가 배열이 아닙니다.'});
    }
    if(out.length||Array.isArray(prose)||Array.isArray(obj.tableEdits)||Array.isArray(obj.visualEdits))return out;
    return null;
  }
  function applyZeroDropResult(batch,rec){
    if(!rec||!rec.summary)return;
    batch.zeroDropSummary=rec.summary;
    if(rec.summary.recoveredCount>0){
      batch.diagnostics.push({code:'zero-drop-recovered',count:rec.summary.recoveredCount,message:'1단계 의심 원장 중 최종 보고에서 누락된 '+rec.summary.recoveredCount+'건을 확인필요 항목으로 자동 복원했습니다.'});
    }
  }
  function blueJsonItems(obj,batch){
    let list=obj.findings??obj.verdicts??obj.items;
    if(!Array.isArray(list)&&(typeof obj.quote==='string'||typeof obj.rationale==='string'))list=[obj];
    if(Array.isArray(obj.candidateLedger)){
      const s=getSensor(),rawList=Array.isArray(list)?list:[];
      if(s&&typeof s.reconcileCandidateLedger==='function'){const rec=s.reconcileCandidateLedger(obj.candidateLedger,rawList);applyZeroDropResult(batch,rec);return rec.findings;}
      return rawList;
    }
    return list;
  }
  function responseItems(raw,obj,role,batch){
    const table=readFindingTable(raw,obj,role,batch);
    if(table)return table.entries;
    if(Array.isArray(obj))return obj;
    if(obj&&typeof obj==='object'){
      if(role==='blue')return blueJsonItems(obj,batch);
      let list=collectRedJsonList(obj,batch);
      if(!Array.isArray(list)&&(typeof obj.before==='string'||structuredKind(obj)))list=[obj];
      return list;
    }
    return null;
  }
  function readFindingTable(raw,obj,role,batch){
    if(role!=='blue'||obj)return null;
    const table=mergeTableAndCsv(markdownFindings(raw),csvFindings(raw));
    if(!table)return null;
    if(table.report)batch.report=table.report;
    if(table.meta?.model&&batch.model==null)batch.model=table.meta.model;
    if(table.meta?.condition&&batch.condition==null)batch.condition=table.meta.condition;
    if(table.zeroDropSummary)applyZeroDropResult(batch,{summary:table.zeroDropSummary});
    for(const line of table.malformed||[])batch.diagnostics.push({code:'malformed-item',line,message:'이 표 행을 읽지 못했습니다.'});
    return table;
  }
  function readBatchMetadata(obj,options,role,batch){
if(obj&&typeof obj==='object'&&!Array.isArray(obj)){
      for(const key of ['model','prompt','harness','requestId','condition'])if(batch[key]==null&&obj[key]!=null)batch[key]=obj[key];
      for(const key of ['fileHash','sourceHash'])if(typeof obj[key]==='string'&&obj[key]&&typeof options[key]==='string'&&obj[key]!==options[key])batch.diagnostics.push({code:'file-hash-mismatch',message:'응답의 원문 식별이 현재 파일과 다릅니다. 확인이 필요합니다.',identity:key,claimed:obj[key]});
      if(typeof obj.role==='string'&&obj.role.toLowerCase()!==role)batch.diagnostics.push({code:'role-mismatch',message:'응답의 역할이 현재 작업과 다릅니다.'});
      if(['abstain','refusal'].includes(obj.status))batch.status=obj.status;
    }
  }
  function visualPromptAppendix(options){
    if(options.role==='blue')return '';
    const hasTables=Array.isArray(options.tables)&&options.tables.length>0;
    const hasFigures=Array.isArray(options.figures)&&options.figures.length>0;
    if(!options.includeVisualSchema&&!options.paperPdf&&!options.isPdf&&!hasTables&&!hasFigures)return '';
    const lines=['선택적 표·차트 변경 필드: "tableEdits":[{"page":"PDF p. 4","tableId":"table-1","row":0,"column":0,"before":"원래 값","after":"새 값","rationale":"이유"}], "visualEdits":[{"page":"PDF p. 6","figureId":"figure-2","series":"Series","pointIndex":0,"before":{"x":1,"y":2},"after":{"x":1,"y":3},"rationale":"이유"}]'];
    if(hasTables)lines.push('표: '+options.tables.slice(0,20).map(t=>(t.id||'table')+'(p.'+(Number.isInteger(t.pageIndex)?t.pageIndex+1:'?')+')').join(', '));
    if(hasFigures)lines.push('차트/그림: '+options.figures.slice(0,20).map(f=>(f.id||'figure')+'(p.'+(Number.isInteger(f.pageIndex)?f.pageIndex+1:'?')+')').join(', '));
    return lines.join('\n');
  }
  function buildPrompt(options={}){const role=options.role==='blue'?'blue':'red';const text=role==='red'?'원문의 취약한 주장에 대한 Before와 After를 제안하세요. 삭제는 빈 After입니다.':'원문의 문제점을 검토하고 근거와 참고자료를 제시하세요. 인용이 없으면 생략하세요.';const shape=role==='red'?'{"changes":[{"before":"원문 인용","after":"변경문","rationale":"이유","evidence":[],"references":[]}]}':'{"findings":[{"quote":"원문 인용 (선택)","rationale":"지적","evidence":[],"references":[]}]}';return [options.prompt||text,options.harness?(typeof options.harness==='string'?options.harness:JSON.stringify(options.harness,null,2)):'',Array.isArray(options.attackTypes)&&options.attackTypes.length?'공격 유형: '+options.attackTypes.join(', '):'', '응답 형식 (선택): '+shape,visualPromptAppendix(options),options.fileHash?'fileHash: '+options.fileHash:'',options.includeSource!==true?'첨부된 원본 PDF를 기준으로 검토하세요.':(options.segments||[]).map(s=>'--- '+s.id+' ---\n'+s.text).join('\n\n')].filter(Boolean).join('\n\n');}
  return {parse,buildPrompt};
});
