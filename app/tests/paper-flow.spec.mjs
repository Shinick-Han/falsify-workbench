import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPaperFlow} from '../src/paper-flow.mjs';
const block=(id,text,box,pos,extra={})=>({id,kind:'paragraph',text,source:{pageIndex:0,bbox:box,range:{start:pos*100,end:pos*100+text.length},readerPosition:pos,lines:[{bbox:box}]},assetIds:[],...extra});
const model=blocks=>({schema:'falsify.paper-document.v1',sourceSha256:'a'.repeat(64),pages:[{sourcePageIndex:0,width:400,height:600}],blocks,assets:[],styles:[]});
const ids=f=>f.items.flatMap(x=>x.blockIds);
test('local bands retain repeated text, full width caption and later columns',()=>{const d=model([block('title','Title',[20,5,380,20],0,{kind:'heading'}),block('abstract','Abstract',[20,25,380,55],1),block('l1','repeat',[20,70,180,80],2),block('r1','repeat',[220,70,380,80],3),block('l2','left',[20,90,180,100],4),block('r2','right',[220,90,380,100],5),block('cap','Figure 1. caption',[20,120,380,130],6),block('l3','left',[20,150,180,160],7),block('r3','right',[220,150,380,160],8),block('l4','left',[20,170,180,180],9),block('r4','right',[220,170,380,180],10),block('footer','footer',[20,580,380,590],11)]);const before=structuredClone(d),f=buildPaperFlow(d);assert.deepEqual(d,before);assert.deepEqual(ids(f),['title','abstract','l1','l2','r1','r2','cap','l3','l4','r3','r4','footer']);assert.equal(f.items.find(x=>x.blockIds.includes('cap')).kind,'caption');assert.deepEqual(buildPaperFlow(d),f);});
test('image retains unverified panel label and adjacent body; caption remains independent',()=>{const d=model([block('label','a',[60,60,70,70],0),block('body','body',[15,160,180,175],1),block('caption','Fig. 1 Caption',[20,130,180,145],2),block('fig','',[20,40,180,120],3,{kind:'figure',assetIds:['a']})]);d.assets=[{id:'a',source:{pageIndex:0,bbox:[20,40,180,120],readerPosition:3}}];const f=buildPaperFlow(d),a=f.items.find(x=>x.kind==='asset');assert.deepEqual(a.blockIds,['fig']);assert.equal(f.items.find(x=>x.blockIds.includes('label')).kind,'paragraph');assert.deepEqual(a.assetIds,['a']);assert.deepEqual(a.captionIds,['caption']);assert.equal(ids(f).filter(x=>x==='body').length,1);});
test('fallback preserves missing geometry and orphan assets',()=>{const d=model([block('text','X',null,0)]);d.assets=[{id:'orphan',source:{pageIndex:0,bbox:null,readerPosition:1}}];const f=buildPaperFlow(d);assert.deepEqual(ids(f),['text']);assert.deepEqual(f.items.flatMap(x=>x.assetIds),['orphan']);assert.ok(f.diagnostics.some(x=>x.code==='reading-order-fallback'));});
test('table caption and cells retain separate source occurrences',()=>{const d=model([block('table','Table 1. Outcomes',[20,50,380,65],0),block('cell1','Control',[30,80,120,90],1),block('cell2','Intervention',[220,80,340,90],2),block('cell3','20',[30,100,120,110],3),block('cell4','30',[220,100,340,110],4),block('after','Body after table',[20,140,380,155],5)]);const f=buildPaperFlow(d);assert.equal(f.items.find(x=>x.blockIds.includes('table')).kind,'caption');assert.deepEqual([...ids(f)].sort(),d.blocks.map(x=>x.id).sort());assert.ok(f.diagnostics.some(x=>x.code==='caption-association-unresolved'));});
test('repeated page-edge text classified without merging source blocks',()=>{const d=model([block('h0','Journal',[20,5,100,15],0),block('f0','Footer',[20,580,100,590],1)]);d.pages.push({sourcePageIndex:1,width:400,height:600});d.blocks.push({...block('h1','Journal',[20,5,100,15],0),source:{...block('h1','Journal',[20,5,100,15],0).source,pageIndex:1}},{...block('f1','Footer',[20,580,100,590],1),source:{...block('f1','Footer',[20,580,100,590],1).source,pageIndex:1}});const f=buildPaperFlow(d);assert.deepEqual(f.items.map(x=>x.kind),['header','footer','header','footer']);assert.equal(new Set(ids(f)).size,4);});
test('raster background does not absorb a sentence',()=>{const d=model([block('sentence','Published online: xx xx xxxx',[20,50,160,60],0),block('fig','',[15,45,170,65],1,{kind:'figure',assetIds:['a']})]);d.assets=[{id:'a',source:{pageIndex:0,bbox:[15,45,170,65],readerPosition:1}}];const f=buildPaperFlow(d);assert.equal(f.items.find(x=>x.blockIds.includes('sentence')).kind,'paragraph');});
test('mixed source block splits into exact line ranges and caption band follows both body columns',()=>{
  const lines=[['Left one',[20,50,180,60]],['Left two',[20,61,180,71]],['Right one',[220,50,380,60]],['Right two',[220,61,380,71]],['Fig. 1 caption',[20,100,180,110]],['caption continued',[220,100,380,110]]];
  let offset=0;const characters=[],observed=[];for(const [text,bbox] of lines){const start=offset;for(const ch of text){characters.push({start:offset,end:++offset,bbox,styleId:'body'});}observed.push({range:{start,end:offset},bbox});}
  const raw={id:'raw',kind:'paragraph',text:lines.map(x=>x[0]).join(''),source:{pageIndex:0,bbox:[20,50,380,110],range:{start:0,end:offset},characters,lines:observed,readerPosition:0},assetIds:[]};
  const d=model([raw]);d.styles=[{id:'body',size:10}];const f=buildPaperFlow(d),byId=new Map(f.fragments.map(x=>[x.id,x]));
  assert.deepEqual(f.items.map(i=>byId.get(i.blockIds[0]).text),['Left oneLeft two','Right oneRight two','Fig. 1 caption','caption continued']);
  assert.equal(f.items[2].kind,'caption');assert.deepEqual(f.fragments.map(x=>x.source.range),[{start:0,end:16},{start:16,end:34},{start:34,end:48},{start:48,end:65}]);
  assert.equal(f.fragments.map(x=>x.text).join(''),raw.text);assert.ok(f.fragments.every(x=>x.parentBlockId==='raw'));assert.equal(f.fragments.flatMap(x=>x.source.characters).length,characters.length);
});
test('inserts an overlapping observed run at its character boundary without losing source',()=>{
 const text='ABCD', chars=[...text].map((_,i)=>({start:i,end:i+1,bbox:[20+i*10,50,30+i*10,60],styleId:'body'}));
 const host={id:'host',kind:'paragraph',text,assetIds:[],source:{pageIndex:0,bbox:[20,50,60,60],range:{start:0,end:4},readerPosition:0,characters:chars,lines:[{bbox:[20,50,60,60],range:{start:0,end:4}}]}};
 const guest={id:'guest',kind:'paragraph',text:'2',assetIds:[],source:{pageIndex:0,bbox:[39,50,41,58],range:{start:4,end:5},readerPosition:1,characters:[{start:4,end:5,bbox:[39,50,41,58],styleId:'sup'}],lines:[{bbox:[39,50,41,58],range:{start:4,end:5}}]}};
 const d=model([host,guest]), f=buildPaperFlow(d), item=f.items.find(x=>x.inline), byId=new Map([...d.blocks,...f.fragments].map(x=>[x.id,x]));
 assert.ok(item); assert.equal(item.blockIds.map(id=>byId.get(id).text).join(''),'AB2CD'); assert.deepEqual(item.joiners,['','']);
 assert.deepEqual(f.fragments.map(x=>x.source.range),[{start:0,end:2},{start:2,end:4}]);
});
test('repeated DOI header precedes both caption columns',()=>{
 const d=model([block('left','Fig. 2 caption',[20,48,180,80],0),block('right','continuation',[220,48,380,80],1),block('h','https://doi.org/example',[220,20,380,30],2)]);
 d.pages.push({sourcePageIndex:1,width:400,height:600});
 const h=block('h2','https://doi.org/example',[220,20,380,30],0);h.source.pageIndex=1;d.blocks.push(h);
 const f=buildPaperFlow(d);assert.deepEqual(f.items.filter(i=>i.source.pageIndex===0).map(i=>i.blockIds[0]),['h','left','right']);
});
test('connected vector grid owns cells while caption and body remain separate',()=>{
 const d=model([block('cap','Table 1. Results',[20,30,140,40],0),block('a','A',[25,55,35,60],1),block('b','B',[65,55,75,60],2),block('c','C',[25,75,35,80],3),block('d','D',[65,75,75,80],4),block('note','Notes',[20,110,90,120],5),block('body','Body',[20,150,180,160],6)]);
 const drawings=[];for(const y of [50,70,90]) drawings.push({pageIndex:0,bbox:[20,y,100,y+0.5]});for(const x of [20,40,60,80,100]) drawings.push({pageIndex:0,bbox:[x,50,x+0.5,90.5]});
 // Additional grid lines share endpoints, demonstrating observed connected paths.
 for(const x of [30,50,70,90]) drawings.push({pageIndex:0,bbox:[x,50,x+0.5,90.5]});
 const f=buildPaperFlow(d,{drawings}),region=f.regions[0],asset=f.items.find(i=>i.renderAssetId===region?.id);
 assert.ok(region);assert.deepEqual(asset.blockIds,['a','b','c','d']);assert.deepEqual(f.items.map(i=>i.kind),['caption','asset','paragraph','paragraph']);assert.deepEqual(f.items.flatMap(i=>i.blockIds).sort(),d.blocks.map(b=>b.id).sort());
});
test('dense plot owns its labels and image while leaving caption and body outside',()=>{
 const labels=Array.from({length:20},(_,i)=>block(`label${i}`,`p${i}`,[30+i*5,60+i*4,34+i*5,64+i*4],i));
 const d=model([...labels,block('fig','',[40,60,80,100],20,{kind:'figure',assetIds:['img']}),block('caption','Figure 1. Plot',[20,300,180,315],21),block('body','Body below caption',[20,340,180,355],22)]);
 d.assets=[{id:'img',source:{pageIndex:0,bbox:[40,60,80,100],readerPosition:20}}];
 const drawings=Array.from({length:1000},(_,i)=>({pageIndex:0,bbox:[25+(i%200),50+2*Math.floor(i/10),26+(i%200),51+2*Math.floor(i/10)]}));
 const f=buildPaperFlow(d,{drawings}),r=f.regions[0],asset=f.items.find(i=>i.renderAssetId===r?.id);
 assert.ok(r);assert.equal(asset.blockIds.length,21);assert.deepEqual(asset.assetIds,['img']);assert.deepEqual(f.items.map(i=>i.kind),['asset','caption','paragraph']);assert.equal(new Set(f.items.flatMap(i=>i.blockIds)).size,d.blocks.length);
});
test('outline artwork is captured only when central editable text is absent',()=>{
 const drawings=Array.from({length:2200},(_,i)=>({pageIndex:0,bbox:[20+(i%350),10+(i%570),21+(i%350),11+(i%570)]}));
 const d=model([block('footer','edge marker',[30,570,180,580],0),block('fig','',[20,40,100,70],1,{kind:'figure',assetIds:['img']})]);d.assets=[{id:'img',source:{pageIndex:0,bbox:[20,40,100,70]}}];
 const f=buildPaperFlow(d,{drawings}), r=f.regions[0];assert.equal(r.classification,'outline-artwork'); assert.deepEqual(r.blockIds,['footer','fig']);assert.deepEqual(r.assetIds,['img']);assert.equal(f.items.length,1);assert.equal(f.items[0].renderAssetId,r.id);
 d.blocks.push(block('body','ordinary editable body text',[30,100,300,120],2));const g=buildPaperFlow(d,{drawings});assert.equal(g.regions.some(x=>x.classification==='outline-artwork'),false);assert.equal(g.items.find(x=>x.blockIds.includes('body')).kind,'paragraph');
});
test('verified partial range fragments an original block without losing adjacent metadata',()=>{
 const text='ABCDEF', chars=[...text].map((_,i)=>({start:i,end:i+1,bbox:[20+i*5,50,25+i*5,60],styleId:'body'}));
 const raw={id:'raw',kind:'paragraph',text,assetIds:[],source:{pageIndex:0,bbox:[20,50,50,60],range:{start:0,end:6},readerPosition:0,characters:chars,lines:[{bbox:[20,50,50,60],range:{start:0,end:6}}]}};
 const fig=block('fig','',[30,49,40,61],1,{kind:'figure',assetIds:['a']}),d=model([raw,fig]);d.assets=[{id:'a',source:{pageIndex:0,bbox:[30,49,40,61],readerPosition:1}}];d.occlusions=[{sourceSha256:d.sourceSha256,pageIndex:0,assetId:'a',ranges:[{start:2,end:4}],proof:{changedChannels:0,removedCharacters:2}}];
 const f=buildPaperFlow(d), map=new Map([...d.blocks,...f.fragments].map(b=>[b.id,b])),owned=f.items.flatMap(i=>i.blockIds.map(id=>({kind:i.kind,b:map.get(id)}))).filter(x=>x.b.text).sort((a,b)=>a.b.source.range.start-b.b.source.range.start);assert.deepEqual(owned.map(x=>[x.kind,x.b.text]),[['paragraph','AB'],['asset','CD'],['paragraph','EF']]);assert.equal(d.blocks[0].text,text);assert.deepEqual(owned.map(x=>x.b.source.range),[{start:0,end:2},{start:2,end:4},{start:4,end:6}]);
});
