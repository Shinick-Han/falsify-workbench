import {replaceMarkerGlyph} from './paragraph-pdf-marker-surgery.mjs';
const near=(a,b)=>Number.isFinite(a)&&Math.abs(a-b)<0.025;
function glyphs(doc,index,mupdf) {
 const page=doc.loadPage(index), out=[];
 try { const m=mupdf.Matrix.invert(page.getTransform()), s=page.toStructuredText('preserve-whitespace');
  try { s.walk({onChar(c,o,f,size,quad){out.push({c,fontName:f.getName(),size,pdf:[o[0]*m[0]+o[1]*m[2]+m[4],o[0]*m[1]+o[1]*m[3]+m[5]],quad:[...quad]});}}); } finally {s.destroy();} return out;
 } finally {page.destroy();}
}
function normalize(gs) {let text='',map=[]; for(let i=0;i<gs.length;i++){let c=gs[i].c;if(/\s/u.test(c)){if(text.endsWith(' ')){map[map.length-1][1]=i;continue;}c=' ';} for(const unit of c.split('')){text+=unit;map.push([i,i]);}}return {text,map};}
function abort(signal){if(signal?.aborted)throw new DOMException('PDF editing cancelled.','AbortError');}
/* A visitor types a superscript as they see it ("Ragas 2" for Ragas¹): a space in After where Before has none,
   right beside the changed character, is not part of the change. */
function tightAfter(before,after){
   if(after.length===before.length)return after;
   const out=[];let i=0;
   for(let j=0;j<after.length;j++){if(/\s/u.test(after[j])&&!/\s/u.test(before[i]||'')&&after.length-j>before.length-i)continue;out.push(after[j]);i++;}
   return out;
}
function singleMarkerChange(edit){
   const before=[...edit.before],after=tightAfter(before,[...edit.after]);if(before.length!==after.length)return null;const diff=before.map((c,i)=>c!==after[i]?i:-1).filter(i=>i>=0);if(diff.length!==1||before[diff[0]].length!==1||after[diff[0]].length!==1)return null;
   return {before,after,diff};
}
function planMarkerEdit(edit,count,cache,plans,original,mupdf){if(!Number.isInteger(edit.pageIndex)||edit.pageIndex<0||edit.pageIndex>=count||typeof edit.before!=='string'||typeof edit.after!=='string'||!edit.before.trim())return null;
   const change=singleMarkerChange(edit);if(!change)return null;const {before,after,diff}=change;
   const all=cache.get(edit.pageIndex)||glyphs(original,edit.pageIndex,mupdf);cache.set(edit.pageIndex,all);const {text,map}=normalize(all),needle=edit.before.replace(/\s+/g,' '),first=text.indexOf(needle);if(first<0||text.indexOf(needle,first+1)>=0)return null;
   const a=map[first][0],b=map[first+needle.length-1][1];if(plans.some(p=>p.pageIndex===edit.pageIndex&&a<=p.b&&b>=p.a))return null;
   const offset=first+before.slice(0,diff[0]).join('').replace(/\s+/g,' ').length, target=map[offset];if(!target||target[0]!==target[1]||all[target[0]].c!==before[diff[0]])return null;
   return {edit,pageIndex:edit.pageIndex,a,b,target:target[0],replacement:after[diff[0]]};
}
/* The face a changed marker is drawn in: Latin Modern 7 for Computer Modern superscripts (CMR7). A footnote
   or affiliation symbol (†, ∗, ♢ in CMSY) that becomes a digit takes the document's own text face when the snapshot
   holds it: Latin Modern 7, else Liberation Serif (metric twin of the Times faces papers set in). A raised Times
   footnote number takes Liberation Serif. */
const fontBase=name=>String(name||'').replace(/^[A-Z]{6}\+/,'');
/* A Times-face glyph is a marker only when it is set smaller and higher than the text before it (Ragas¹). */
function raisedMarker(all,index){const g=all[index];let k=index-1;while(k>=0&&/\s/u.test(all[k].c))k--;const prev=all[k];
   return !!prev&&g.size<prev.size*0.85&&g.pdf[1]>prev.pdf[1]+0.5;
}
function markerFace(all,index,fontSnapshot){const base=fontBase(all[index].fontName),find=name=>fontSnapshot.fonts.find(f=>f.postscriptName===name)||null;
   if(/^(?:CMR7|LMRoman7(?:-Regular)?)$/i.test(base))return find('LMRoman7-Regular');
   if(/^CMSY(?:5|6|7|8|9|10)$/i.test(base))return find('LMRoman7-Regular')||find('LiberationSerif');
   if(/^NimbusRomNo9L-Regu$|^Times-Roman$|^TimesNewRomanPSMT$/i.test(base)&&raisedMarker(all,index))return find('LiberationSerif');
   return null;
}
/* Spans of same-font glyphs on the marker's baseline that hold the changed one, longest first: a show may hold the
   whole run ("∗♢") or only part of it. */
function markerRuns(all,plan,target){let start=plan.target,end=plan.target;
   const same=g=>g&&g.fontName===target.fontName&&near(g.size,target.size)&&near(g.pdf[1],target.pdf[1]);while(start>0&&same(all[start-1]))start--;while(end+1<all.length&&same(all[end+1]))end++;
   const runs=[];for(let a=start;a<=plan.target;a++)for(let b=end;b>=plan.target;b--)runs.push([a,b]);
   return runs.sort((x,y)=>(y[1]-y[0])-(x[1]-x[0])).map(([a,b])=>({glyphs:all.slice(a,b+1),at:plan.target-a}));
}
async function replaceMarkerRun(working,plan,all,target,fontSnapshot,deps){const face=markerFace(all,plan.target,fontSnapshot);if(!face)return null;
   for(const run of markerRuns(all,plan,target)){abort(deps.signal);
     const after=run.glyphs.map((g,i)=>i===run.at?plan.replacement:g.c).join('');
     const result=await deps.replaceMarkerGlyph({bytes:working,pageIndex:plan.pageIndex,glyphs:run.glyphs,after,fontSnapshot,fontPostscriptName:face.postscriptName,scanTextShows:deps.scanTextShows,mupdf:deps.mupdf});
     if(result)return result;
   }
   return null;
}
export async function trySourceMarkerEdits({bytes,edits,fontSnapshot,signal},{mupdf,scanTextShows}) {
 abort(signal); if(!(bytes instanceof Uint8Array)||!Array.isArray(edits)||!edits.length||!mupdf||!fontSnapshot?.fonts)return null;
 let original;
 try {original=new mupdf.PDFDocument(bytes);if(original.needsPassword())return null;const count=original.countPages(),cache=new Map(),plans=[];
  for(const edit of edits){abort(signal);const plan=planMarkerEdit(edit,count,cache,plans,original,mupdf);if(!plan)return null;plans.push(plan);}
  let working=bytes.slice();const reports=[];
  for(const plan of plans){abort(signal);const current=new mupdf.PDFDocument(working);let all;try{all=glyphs(current,plan.pageIndex,mupdf);}finally{current.destroy();}const target=all[plan.target];if(!target)return null;
   const result=await replaceMarkerRun(working,plan,all,target,fontSnapshot,{replaceMarkerGlyph,scanTextShows,mupdf,signal});abort(signal);if(!result)return null;working=result.bytes;reports.push({...result.report,id:plan.edit.id});
  }return {bytes:working,pageCount:count,reports};
 }catch(error){abort(signal);return null;}finally{original?.destroy();}
}
