// Independent, bounded observations of the generated PDF. Boxes use MuPDF display coordinates.
const valid = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2]>b[0] && b[3]>b[1];
const area = b => Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const intersection = (a,b) => [Math.max(a[0],b[0]),Math.max(a[1],b[1]),Math.min(a[2],b[2]),Math.min(a[3],b[3])];
const contains = (a,b) => a[0]<=b[0]+1 && a[1]<=b[1]+1 && a[2]>=b[2]-1 && a[3]>=b[3]-1;
const union = boxes => [Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const norm = s => s.replace(/\s+/gu,' ').trim();

/** Optional profile: bodyFontSize, bodyFontNames, captions [{text, assetPageIndex, assetBbox}], columns.
 * Metadata nominates a relationship; both caption text and an image placement must be observed independently. */
export function inspectLayoutQuality({bytes,mupdf,profile={}}={}) {
  const issues=[], pages=[], captionObservations=[], limitations=[
    'Text paint bounds are glyph ink extents; structured text character boxes are font metrics.',
    'Only axis-aligned rectangular clip paths are checked; arbitrary clips, transparency, occlusion, rotated text, vector figure ownership, and reading order remain unverified.',
    'Scores measure detected defects only; they are not proof of visual quality.'
  ];
  const add=(type,pageIndex,bbox,penalty,evidence)=>issues.push({type,pageIndex,bbox:bbox.map(x=>Math.round(x*100)/100),penalty,evidence});
  if (!mupdf?.Document || !mupdf?.Device) return {schema:'falsify.layout-quality.v1',status:'unavailable',score:null,penaltyTerms:{},issues,limitations:[...limitations,'MuPDF unavailable.']};
  let doc;
  try {
    doc=mupdf.Document.openDocument(bytes,'application/pdf');
    if(doc.countPages()>500) throw Error('page limit exceeded');
    for(let p=0;p<doc.countPages();p++) {
      const page=doc.loadPage(p); let st,dev;
      try {
        const bounds=[...page.getBounds()], runs=[],images=[],lines=[],vectors=[], clips=[]; let unsupportedClips=0;
        if(!valid(bounds) || bounds[0]!==0 || bounds[1]!==0) throw Error('unsupported page bounds');
        st=page.toStructuredText('preserve-whitespace,preserve-images');
        let line=null;
        st.walk({beginLine(_box,wmode,direction){line={text:'',chars:[],horizontal:wmode===0 && direction[0]>0 && Math.abs(direction[1])<0.01};},
          onChar(c,_origin,font,size,quad){if(!line)return; const b=[Math.min(quad[0],quad[2],quad[4],quad[6]),Math.min(quad[1],quad[3],quad[5],quad[7]),Math.max(quad[0],quad[2],quad[4],quad[6]),Math.max(quad[1],quad[3],quad[5],quad[7])]; line.text+=c; if(valid(b)&&c.trim())line.chars.push({bbox:b,size,font:font.getName()});},
          endLine(){if(line?.chars.length)lines.push({...line,bbox:union(line.chars.map(c=>c.bbox))});line=null;},
          onImageBlock(bbox,_transform,image){try{if(valid(bbox))images.push([...bbox]);}finally{image.destroy();}}});
        const collect=(text,ctm,resources,alpha)=>{try {if(alpha>0){const b=[...text.getBounds(null,ctm)];if(valid(b)){runs.push(b); const active=clips.filter(Boolean); if(active.length && !clips.includes(null)){const clip=active.reduce(intersection); if(!contains(clip,b) && area(intersection(clip,b)) < area(b)-1) add('text-clipped',p,b,10,{clipBounds:clip,source:'text-paint-and-rectangular-clip'});}}}} finally {text.destroy();resources.forEach(r=>r?.destroy());}};
        const path=(obj,stroke,ctm,cs,alpha)=>{try{if(alpha>0){const b=[...obj.getBounds(stroke,ctm)];if(valid(b))vectors.push(b);}}finally{obj.destroy();stroke?.destroy();cs?.destroy();}};
        dev=new mupdf.Device({clipPath(o,_eo,c){try{const points=[];let closed=false,complex=false;o.walk({moveTo(x,y){points.push([x,y]);},lineTo(x,y){points.push([x,y]);},curveTo(){complex=true;},closePath(){closed=true;}}); const axis=Math.abs(c[1])<1e-8 && Math.abs(c[2])<1e-8; const xs=[...new Set(points.map(q=>q[0]))],ys=[...new Set(points.map(q=>q[1]))]; const rectangle=!complex && closed && points.length===4 && xs.length===2 && ys.length===2 && points.every((q,i)=>{const n=points[(i+1)%4];return (q[0]===n[0]) !== (q[1]===n[1]);}); const b=[...o.getBounds(null,c)]; if(axis && rectangle && valid(b)) clips.push(b); else {clips.push(null);unsupportedClips++;}}finally{o.destroy();}},clipText(t){t.destroy();clips.push(null);unsupportedClips++;},clipStrokeText(t,stroke){t.destroy();stroke.destroy();clips.push(null);unsupportedClips++;},clipStrokePath(o,stroke){o.destroy();stroke.destroy();clips.push(null);unsupportedClips++;},clipImageMask(image){image.destroy();clips.push(null);unsupportedClips++;},popClip(){clips.pop();},fillText(t,c,cs,_color,a){collect(t,c,[cs],a);},strokeText(t,s,c,cs,_color,a){collect(t,c,[s,cs],a);},fillPath(o,_eo,c,cs,_color,a){path(o,null,c,cs,a);},strokePath(o,s,c,cs,_color,a){path(o,s,c,cs,a);}});
        page.run(dev,mupdf.Matrix.identity);dev.close();
        if(runs.length>2000 || lines.length>10000 || images.length>2000 || vectors.length>20000) throw Error('geometry limit exceeded');
        for(const b of runs) if(b[0]<-1 || b[1]<-1 || b[2]>bounds[2]+1 || b[3]>bounds[3]+1) add('ink-outside-page',p,b,10,{pageBounds:bounds,source:'text-paint-ink'});
        // Multiple text paint operations are compared; containment and near-touching ink are not collisions.
        for(let i=0;i<runs.length;i++) for(let j=i+1;j<runs.length;j++) {
          const a=runs[i],b=runs[j],over=intersection(a,b),n=area(over);
          if(n>4 && over[2]-over[0]>3 && over[3]-over[1]>2 && n/Math.min(area(a),area(b))>0.12 && !contains(a,b) && !contains(b,a)) add('text-overlap',p,over,8,{first:a,second:b,overlapArea:n,source:'text-paint-ink'});
        }
        for(const line of lines) if(line.horizontal) {
          for(const b of images) {const overlap=intersection(line.bbox,b), n=area(overlap); if(n>4 && n/area(line.bbox)>0.2 && !contains(b,line.bbox)) add('text-image-overlap',p,overlap,8,{text:line.text,image:b,overlapArea:n,source:'structured-text-and-image'});}
          const sizes=line.chars.map(c=>c.size).filter(Number.isFinite), size=sizes.length?sizes.sort((a,b)=>a-b)[Math.floor(sizes.length/2)]:null;
          if(Number.isFinite(profile.bodyFontSize) && norm(line.text).length>=20 && size && size<profile.bodyFontSize*0.8) add('small-body-text',p,line.bbox,5,{text:line.text,size,expectedSize:profile.bodyFontSize});
          if(Array.isArray(profile.bodyFontNames) && profile.bodyFontNames.length && norm(line.text).length>=40 && !line.chars.some(c=>profile.bodyFontNames.includes(c.font))) add('body-font-deviation',p,line.bbox,3,{text:line.text,fonts:[...new Set(line.chars.map(c=>c.font))],expectedFonts:profile.bodyFontNames});
        }
        pages.push({pageIndex:p,bounds,lines,images,vectorCount:vectors.length,unsupportedClips});
      } finally {dev?.destroy();st?.destroy();page.destroy();}
    }
    for(const caption of profile.captions || []) {
      const target=norm(caption.text || '');
      const matches=[];
      if(target) for(const page of pages) for(let i=0;i<page.lines.length;i++) {
        let text=''; const selected=[];
        for(let j=i;j<page.lines.length && j<i+20;j++) {
          const line=page.lines[j], previous=selected.at(-1); if(previous && (line.bbox[1]<previous.bbox[1]-1 || line.bbox[1]-previous.bbox[3]>Math.max(20,(previous.bbox[3]-previous.bbox[1])*1.5) || Math.abs(line.bbox[0]-previous.bbox[0])>30)) break; selected.push(line); text=norm(text+' '+line.text);
          if(text===target) {matches.push({page,line:{text,bbox:union(selected.map(l=>l.bbox))}});break;}
          if(!target.startsWith(text) || text.length>=target.length) break;
        }
      }
      const owner=pages[caption.assetPageIndex], assets=owner?.images.filter(b=>valid(caption.assetBbox) && area(intersection(b,caption.assetBbox))/area(b)>0.9 && area(intersection(b,caption.assetBbox))/area(caption.assetBbox)>0.9);
      if(matches.length!==1 || assets?.length!==1) {captionObservations.push({id:caption.id,status:'unavailable'});limitations.push('Caption or associated image could not be uniquely observed: '+String(caption.text || '').slice(0,80));continue;}
      const {page,line}=matches[0], asset=assets[0];
      const gap=page.pageIndex===owner.pageIndex ? Math.max(0,line.bbox[1]-asset[3],asset[1]-line.bbox[3]) : Infinity;
      const horizontalOverlap=Math.min(line.bbox[2],asset[2])-Math.max(line.bbox[0],asset[0]);
      const attached=page.pageIndex===owner.pageIndex && gap<=Math.max(36,(line.bbox[3]-line.bbox[1])*3) && horizontalOverlap>0;
      captionObservations.push({id:caption.id,status:attached?'observed':'separated',text:target,pageIndex:page.pageIndex,bbox:line.bbox,assetBbox:asset});
      if(!attached) add('caption-separated',page.pageIndex,line.bbox,6,{assetPageIndex:owner.pageIndex,assetBbox:asset,gap:Number.isFinite(gap)?gap:null,text:line.text});
    }
    // A source profile nominates the heading and column, but the output must contain it uniquely.
    for(const heading of profile.headings || []) {
      const matches=pages.flatMap(p=>p.lines.filter(l=>norm(l.text)===norm(heading.text || '')).map(line=>({page:p,line})));
      if(matches.length!==1) {limitations.push('Heading could not be uniquely observed: '+String(heading.text || '').slice(0,80));continue;}
      const {page,line}=matches[0], next=page.lines.filter(l=>l!==line && l.bbox[1]>=line.bbox[3]-1 && Math.min(l.bbox[2],line.bbox[2])-Math.max(l.bbox[0],line.bbox[0])>0).sort((a,b)=>a.bbox[1]-b.bbox[1])[0];
      if(!next || next.bbox[1]-line.bbox[3]>Math.max(36,(line.bbox[3]-line.bbox[1])*3)) add('heading-orphan',page.pageIndex,line.bbox,4,{text:line.text,nextGap:next?next.bbox[1]-line.bbox[3]:null});
    }
    for(const column of profile.columns || []) {
      const page=pages[column.pageIndex], box=column.bbox;
      if(!page || !valid(box) || !contains(page.bounds,box)) {limitations.push('Column geometry is invalid or unavailable.');continue;}
      const occupied=page.lines.some(l=>area(intersection(l.bbox,box))>4) || page.images.some(b=>area(intersection(b,box))>4);
      if(!occupied) add('blank-column',column.pageIndex,box,4,{source:'profile-column-with-no-observed-text-or-image',vectorInk:'unverified'});
    }
    const penaltyTerms={};for(const issue of issues) penaltyTerms[issue.type]=(penaltyTerms[issue.type]||0)+issue.penalty;
    return {schema:'falsify.layout-quality.v1',status:'partial',score:Math.max(0,100-Object.values(penaltyTerms).reduce((a,b)=>a+b,0)),penaltyTerms,issues,captionObservations,coverage:{pages:pages.length,textPaint:true,images:true,vectorPlacements:pages.reduce((n,p)=>n+p.vectorCount,0),captionOwnership:'only unique text and image matches',clipping:'partial: axis-aligned rectangular paths only',unsupportedClipOperations:pages.reduce((n,p)=>n+p.unsupportedClips,0)},limitations};
  } catch(error) {return {schema:'falsify.layout-quality.v1',status:'unavailable',score:null,penaltyTerms:{},issues:[],limitations:[...limitations,String(error?.message || error)]};}
  finally {doc?.destroy();}
}
