'use strict';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {javascriptFunctions} from '../../tools/quality/complexity.mjs';

const require=createRequire(import.meta.url);
const readDist=name=>readFile(fileURLToPath(new URL('../dist/'+name,import.meta.url)),'utf8');

test('Phase 2 modules stay free of innerHTML and keep CCN <= 15',async()=>{
  for(const name of ['blue-paper-reader.js','paper-visual-integration.js','review-workbench.js','hosted-ai.js']){
    const src=await readDist(name);
    assert.equal(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(src),false,name+' must not use innerHTML');
    for(const fn of javascriptFunctions(src)){
      assert.ok(fn.ccn<=15,`${name}:${fn.id} CCN ${fn.ccn} exceeds 15`);
    }
  }
});

test('BLUE PDF reader resolves page hints, finds quotes across pages, and highlights exact text spans',async()=>{
  const Reader=require('../dist/blue-paper-reader.js');
  assert.equal(Reader.parsePageHint({pageIndex:2}),3);
  assert.equal(Reader.parsePageHint({page:4}),4);
  assert.equal(Reader.parsePageHint({label:'Results · PDF p. 7'}),7);
  assert.equal(Reader.parsePageHint({label:'표 2 · 5쪽'}),5);

  const indexed=Reader.buildSpanIndex([
    {str:'Cohort size was N = 120',hasEOL:false},
    {str:'with primary p = 0.004 in Table 1.',hasEOL:true}
  ]);
  const hit=Reader.findQuoteRange(indexed,'primary   p = 0.004 in Table 1');
  assert.ok(hit,'normalized quote matches across span boundaries');
  assert.equal(hit.hits.length,1);
  assert.equal(hit.hits[0].i,1);

  // Mount synthetic DOM and verify openFile + locate jump from p.1 -> p.2 and paint highlight rects
  const nodes=new Map();
  const makeEl=tag=>{
    const e=new EventTarget();
    Object.assign(e,{
      tagName:String(tag).toUpperCase(),id:'',className:'',textContent:'',hidden:false,disabled:false,
      dataset:{},style:{setProperty(){}},children:[],
      setAttribute(k,v){this[k]=v;},
      append(...kids){for(const k of kids)if(k&&typeof k==='object')this.children.push(k);},
      replaceChildren(...kids){this.children=[];this.append(...kids);},
      getBoundingClientRect:()=>({left:10,top:20,width:200,height:300}),
      getContext:()=>({}),
      querySelector(sel){return this.find(n=>sel.startsWith('#')&&n.id===sel.slice(1));},
      querySelectorAll(){return [];},
      find(fn){if(fn(this))return this;for(const c of this.children)if(c?.find){const m=c.find(fn);if(m)return m;}return null;},
      remove(){},
      scrollIntoView(){e.scrolled=true;}
    });
    return e;
  };
  const doc=new EventTarget();
  const viewBlue=makeEl('section');viewBlue.id='view-blue';
  const docBlue=makeEl('section');docBlue.id='document-blue';
  docBlue.before=node=>{viewBlue.children.unshift(node);};
  viewBlue.append(docBlue);
  nodes.set('view-blue',viewBlue);nodes.set('document-blue',docBlue);
  Object.assign(doc,{
    readyState:'complete',baseURI:'http://127.0.0.1/',
    createElement:makeEl,
    getElementById:id=>nodes.get(id)||viewBlue.find(n=>n.id===id),
    querySelector:sel=>sel.startsWith('#')?doc.getElementById(sel.slice(1)):null,
    querySelectorAll:()=>[],
    createRange:()=>({
      setStart(){},setEnd(){},
      getClientRects:()=>[{left:35,top:60,width:90,height:14}]
    })
  });

  const pagesData=[
    [{str:'Abstract text on page one.',hasEOL:true}],
    [{str:' Subgroup mortality was 14.2% (p = 0.041).',hasEOL:true}]
  ];
  const fakePdfLib={
    GlobalWorkerOptions:{},
    TextLayer:class{
      constructor({textContentSource}){
        this.textDivs=textContentSource.items.map(it=>({firstChild:{nodeType:3,textContent:it.str}}));
      }
      async render(){}
    },
    getDocument:()=>({
      promise:Promise.resolve({
        numPages:2,
        getPage:async n=>({
          getViewport:({scale})=>({width:600*scale,height:800*scale,scale}),
          render:()=>({promise:Promise.resolve()}),
          getTextContent:async()=>({items:pagesData[n-1]})
        })
      }),
      destroy:async()=>{}
    })
  };
  const ctx={
    document:doc,CustomEvent,Event,EventTarget,URL,
    FalsifyPreview:{defaultImport:async()=>fakePdfLib,pdfParams:d=>({data:d}),fitScale:()=>1},
    FalsifyChangeMarks:require('../dist/paper-change-marks.js')
  };
  ctx.globalThis=ctx;
  vm.runInNewContext(await readDist('blue-paper-reader.js'),ctx);

  const pdfBytes=Uint8Array.from(Buffer.from('%PDF-1.7 synthetic\n%%EOF\n'));
  const file={name:'blind-target.pdf',type:'application/pdf',arrayBuffer:async()=>pdfBytes.buffer};
  doc.dispatchEvent(new CustomEvent('falsify:blue-file',{detail:{file}}));
  for(let i=0;i<40&&!ctx.FalsifyBlueReader.getState()?.hasPdf;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(ctx.FalsifyBlueReader.getState().page,1);
  assert.equal(viewBlue.dataset.blueLayout,'split');

  doc.dispatchEvent(new CustomEvent('falsify:blue-locate',{detail:{quote:'mortality was 14.2% (p = 0.041)'}}));
  for(let i=0;i<40&&ctx.FalsifyBlueReader.getState()?.page!==2;i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(ctx.FalsifyBlueReader.getState().page,2,'jumped automatically to page 2 containing quote');
  const stage=doc.getElementById('blue-reader-stage');
  const highlight=stage.find(n=>n.className==='blue-quote-highlight');
  assert.ok(highlight,'highlight overlay rect painted on target page');
  assert.equal(highlight.style.left,'25px');
  assert.equal(highlight.style.top,'40px');
});

test('RED visual integration shows 1-click text-to-visual chaining banner instead of vanishing when text edits are pending',async()=>{
  const nodes=Object.fromEntries(['red-visual-edit-host','red-visual-section','red-visual-analysis','red-visual-record-status','paper-generate'].map(id=>[id,Object.assign(new EventTarget(),{id,hidden:false,disabled:false,textContent:'',children:[],append(...k){this.children.push(...k);},click(){this.clicked=(this.clicked||0)+1;this.dispatchEvent(new Event('click'));}})]));
  const document=new EventTarget();document.readyState='complete';
  document.getElementById=id=>nodes[id]||null;
  document.createElement=()=>Object.assign(new EventTarget(),{hidden:false,disabled:false,textContent:'',children:[],append(...k){this.children.push(...k);},click(){},remove(){}});
  document.querySelectorAll=()=>[];
  const source={file:{name:'original.pdf',type:'application/pdf'},fileHash:'a'.repeat(64),segments:[]};
  let current=null,edits=[];
  let editorOpts=null;
  const ctx={
    document,CustomEvent,Event,EventTarget,crypto:globalThis.crypto,Uint8Array,ArrayBuffer,TextEncoder,File,Blob,btoa,console,structuredClone,
    FalsifyLocalBridge:{session:()=>null,capabilities:()=>({})},
    FalsifyPaperWorkspace:{getSource:()=>source,getCurrentOutput:()=>current,getEditSnapshot:()=>({revision:1,edits}),getPageIndex:()=>0},
    FalsifyVisualEditUI:{create:opts=>{editorOpts=opts;return {setBusy(){},clear(){},refresh(){}};}}
  };
  vm.runInNewContext(await readDist('paper-visual-integration.js'),ctx);
  assert.equal(nodes['red-visual-section'].hidden,false);

  // Add an ungenerated text edit: editor.getSource() stays null, but #red-visual-section stays visible with chaining banner!
  edits=[{id:'e1',enabled:true}];
  document.dispatchEvent(new CustomEvent('falsify:paper-workspace-source'));
  assert.equal(editorOpts.getSource(),null,'editor source remains null until text PDF is generated');
  assert.equal(nodes['red-visual-section'].hidden,false,'visual section no longer disappears silently');
  assert.equal(nodes['red-visual-edit-host'].hidden,true,'visual host waits cleanly behind chaining banner');
  const banner=nodes['red-visual-section'].children.find(n=>n.id==='red-visual-chain-banner');
  assert.ok(banner&&banner.hidden===false,'chaining banner is visible');
  const applyBtn=banner.children.find(n=>n.id==='red-visual-chain-apply');
  applyBtn.dispatchEvent(new Event('click'));
  assert.equal(nodes['paper-generate'].clicked,1,'clicking chaining button triggers #paper-generate');

  // Once generated PDF output arrives, banner hides and visual host opens on the generated PDF!
  current={file:{name:'edited.pdf'},sha256:'b'.repeat(64),originalSourceSha256:source.fileHash};
  document.dispatchEvent(new CustomEvent('falsify:paper-workspace-output'));
  assert.equal(banner.hidden,true);
  assert.equal(nodes['red-visual-edit-host'].hidden,false);
  assert.equal(editorOpts.getSource().fileHash,'b'.repeat(64));
});

test('H1 Review renders live Solari scoreboard, updates counts on verdict changes, and filters pending items',async()=>{
  const Review=require('../dist/review-workbench.js');
  const els=new Map();
  const makeEl=tag=>{
    const e=new EventTarget();
    let id='';
    Object.defineProperty(e,'id',{get:()=>id,set:v=>{id=v;if(v)els.set(v,e);}});
    Object.assign(e,{
      tagName:String(tag).toUpperCase(),className:'',textContent:'',value:'',hidden:false,disabled:false,
      dataset:{},attrs:{},children:[],
      setAttribute(k,v){this.attrs[k]=v;},
      append(...kids){for(const k of kids)if(k&&typeof k==='object')this.children.push(k);},
      replaceChildren(...kids){this.children=[];this.append(...kids);},
      find(fn){if(fn(this))return this;for(const c of this.children)if(c?.find){const m=c.find(fn);if(m)return m;}return null;},
      querySelector(sel){if(sel.startsWith('#'))return els.get(sel.slice(1))||null;return null;}
    });
    return e;
  };
  const doc={createElement:makeEl,querySelector:sel=>sel.startsWith('#')?els.get(sel.slice(1))||null:null};
  const run={
    id:'blue-1',role:'blue',
    segments:[{id:'s0',label:'p.1',text:'Alpha shows benefit.'}],
    response:{findings:[
      {id:'F1',segmentId:'s0',quote:'Alpha shows benefit.',rationale:'Contradicts Table 1.',evidence:[],uncertainty:'None'},
      {id:'F2',segmentId:'s0',quote:'Alpha shows',rationale:'Overstated claim.',evidence:[],uncertainty:'None'}
    ]}
  };
  const patches=[{id:'c1',label:'p.1',before:'no benefit',after:'benefit'}];
  const comparison={assessments:[{id:'c1',verdict:'pending',note:'',quoteOverlapFindingIds:['F1']}]};
  const findingAssessments=[{id:'F1',verdict:'pending',note:''},{id:'F2',verdict:'pending',note:''}];

  const board=Review.render({
    document:doc,run,patches,comparison,findingAssessments,
    onPatch:(i,k,v)=>{comparison.assessments[i][k]=v;},
    onFinding:(id,k,v)=>{findingAssessments.find(x=>x.id===id)[k]=v;}
  });
  const scoreboard=board.find(n=>n.id==='review-scoreboard');
  assert.ok(scoreboard,'scoreboard rendered');
  assert.match(els.get('review-pending-summary').textContent,/0 \/ 3건 · 남은 미판정 3건/);

  // Judge patch c1 -> detected, F1 -> supported, F2 -> pre-existing
  els.get('evaluation-patch-0').value='detected';
  els.get('evaluation-patch-0').dispatchEvent(new Event('change'));
  els.get('evaluation-finding-0').value='supported';
  els.get('evaluation-finding-0').dispatchEvent(new Event('change'));
  assert.match(els.get('review-pending-summary').textContent,/2 \/ 3건 · 남은 미판정 1건/);

  // Toggle pending-only filter: decided cards hide, pending card F2 stays visible!
  els.get('review-filter-pending').dispatchEvent(new Event('click'));
  const cards=[];
  const collect=n=>{if(n?.className==='review-item')cards.push(n);for(const c of n?.children||[])collect(c);};
  collect(board);
  assert.equal(cards.length,3);
  assert.equal(cards.filter(c=>!c.hidden).length,1,'only the 1 pending card remains visible');

  els.get('evaluation-finding-1').value='pre-existing';
  els.get('evaluation-finding-1').dispatchEvent(new Event('change'));
  assert.match(els.get('review-pending-summary').textContent,/전체 3건 판정 완료/);
  const counts=Review.computeScoreboardCounts({comparison,findingAssessments});
  assert.equal(counts.patch.detected,1);
  assert.equal(counts.finding.hit,1);
  assert.equal(counts.finding.boundary,1);
  assert.equal(counts.pendingItems,0);
});
