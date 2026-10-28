/* Portable quote matching for canonical and layout segments. AGPL-3.0-only. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.FalsifyPaperAnchors=factory();})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  function normalize(text){
    let value='',starts=[],ends=[];
    for(let i=0;i<text.length;){
      if(text[i]==='-'&&/[\r\n]/.test(text[i+1]||'')){let j=i+1;while(j<text.length&&/\s/.test(text[j]))j++;if(/[\p{L}]/u.test(text[j]||'')){i=j;continue;}}
      if(/\s/.test(text[i])){let j=i+1;while(j<text.length&&/\s/.test(text[j]))j++;value+=' ';starts.push(i);ends.push(j);i=j;continue;}
      const cp=text.codePointAt(i),raw=String.fromCodePoint(cp),fold=/[\uFB00-\uFB06]/.test(raw)?raw.normalize('NFKC'):raw;
      for(let k=0;k<fold.length;k++){value+=fold[k];starts.push(i);ends.push(i+raw.length);}i+=raw.length;
    }
    return {value,starts,ends};
  }
  function page(s,i){const m=/PDF p\.\s*(\d+)/i.exec(s.label||'');return Number.isInteger(s.pageIndex)?s.pageIndex:m?+m[1]-1:i;}
  function distance(a,b,limit){if(Math.abs(a.length-b.length)>limit)return limit+1;let prev=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let cur=[i],min=i;for(let j=1;j<=b.length;j++){cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));min=Math.min(min,cur[j]);}if(min>limit)return limit+1;prev=cur;}return prev[b.length];}
  function find({quote,segments,pageIndex,segmentId,prefix,suffix}={}){
    const q=normalize(typeof quote==='string'?quote:'').value.trim();if(!q||!Array.isArray(segments))return {status:'missing',matches:[]};
    const source=segments.filter(s=>s&&typeof s.id==='string'&&typeof s.text==='string').map((s,i)=>({s,i,n:normalize(s.text),pageIndex:page(s,i)}));
    const make=(x,a,b,extra)=>({segmentId:x.s.id,pageIndex:x.pageIndex,start:x.n.starts[a],end:x.n.ends[b-1],before:x.s.text.slice(x.n.starts[a],x.n.ends[b-1]),...extra});
    function hints(matches){let out=matches;for(const [key,val] of [['segmentId',segmentId],['pageIndex',pageIndex]]){if(val!=null){const narrowed=out.filter(m=>m[key]===val);if(narrowed.length)out=narrowed;}}if(out.length>1&&(prefix||suffix)){const narrowed=out.filter(m=>{const s=source.find(x=>x.s.id===m.segmentId).s.text;return (!prefix||normalize(s.slice(0,m.start)).value.trim().endsWith(normalize(prefix).value.trim()))&&(!suffix||normalize(s.slice(m.end)).value.trim().startsWith(normalize(suffix).value.trim()));});if(narrowed.length)out=narrowed;}return out;}
    for(const alias of [false,true]){let matches=[];for(const x of source){if(x.s.id.startsWith('layout:')!==alias)continue;let at=0;while((at=x.n.value.indexOf(q,at))>=0){matches.push(make(x,at,at+q.length,{basis:alias?'layout':'canonical'}));at++;if(matches.length>=100)break;}}if(matches.length){matches=hints(matches);return {status:matches.length===1?'matched':'ambiguous',matches};}}
    // Compare bounded word windows, keeping the actual source span and never auto-binding.
    if(q.length<12||q.length>500)return {status:'missing',matches:[]};
    const words=q.split(/\s+/),limit=Math.max(1,Math.floor(q.length*0.18));let matches=[],examined=0;
    for(const x of source){const tokens=[...x.n.value.matchAll(/\S+/g)];if(tokens.length>20000)continue;for(let i=0;i<tokens.length;i++){if(examined>=1000)break;if(words[0].length>=4&&!tokens[i][0].toLowerCase().startsWith(words[0].slice(0,3).toLowerCase()))continue;for(let count=Math.max(1,words.length-2);count<=words.length+2&&i+count<=tokens.length;count++){let a=tokens[i].index,b=tokens[i+count-1].index+tokens[i+count-1][0].length,v=x.n.value.slice(a,b);if(Math.abs(v.length-q.length)>limit)continue;examined++;let d=distance(q,v,limit);if(d<=limit)matches.push(make(x,a,b,{score:1-d/Math.max(q.length,v.length),basis:'fuzzy'}));}}}
    matches.sort((a,b)=>b.score-a.score);matches=hints(matches).slice(0,10);return {status:matches.length?'suggested':'missing',matches};
  }
  return {find};
});
