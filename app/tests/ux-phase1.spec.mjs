'use strict';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {javascriptFunctions} from '../../tools/quality/complexity.mjs';

const readDist=name=>readFile(fileURLToPath(new URL('../dist/'+name,import.meta.url)),'utf8');
const PDF_BYTES=Buffer.from('%PDF-1.7 synthetic ux phase1 fixture\n%%EOF\n');
const PDF_SHA=createHash('sha256').update(PDF_BYTES).digest('hex');

class SyntheticNode extends EventTarget{
  constructor(tag,doc){
    super();
    Object.assign(this,{
      tagName:String(tag).toUpperCase(),ownerDocument:doc,children:[],parent:null,attrs:{},dataset:{},
      _text:'',id:'',className:'',value:'',checked:false,disabled:false,hidden:false,type:'',files:[],
      options:[],selectedOptions:[]
    });
    this.classList={
      _set:new Set(),
      add:(...xs)=>{for(const x of xs)this.classList._set.add(x);this.className=[...this.classList._set].join(' ');},
      remove:(...xs)=>{for(const x of xs)this.classList._set.delete(x);this.className=[...this.classList._set].join(' ');},
      toggle:(x,on)=>{const v=on===undefined?!this.classList._set.has(x):!!on;if(v)this.classList._set.add(x);else this.classList._set.delete(x);this.className=[...this.classList._set].join(' ');return v;},
      contains:x=>this.classList._set.has(x)
    };
  }
  get textContent(){return this._text+this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
  set textContent(v){this.children=[];this._text=String(v);}
  append(...kids){for(const k of kids){if(k&&typeof k==='object')k.parent=this;this.children.push(k);}}
  prepend(...kids){for(const k of [...kids].reverse()){if(k&&typeof k==='object')k.parent=this;this.children.unshift(k);}}
  replaceChildren(...kids){this.textContent='';this.append(...kids);}
  setAttribute(k,v){this.attrs[k]=String(v);if(k==='id')this.id=String(v);}
  getAttribute(k){return Object.prototype.hasOwnProperty.call(this.attrs,k)?this.attrs[k]:null;}
  focus(){}
  scrollIntoView(){}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  *walk(){yield this;for(const c of this.children)if(c&&typeof c==='object'&&c.walk)yield* c.walk();}
  find(fn){for(const n of this.walk())if(fn(n))return n;return null;}
  querySelector(sel){return typeof sel==='string'&&sel.startsWith('#')?this.find(n=>n.id===sel.slice(1)):null;}
}

test('Phase 1 modified UI modules stay free of innerHTML and keep CCN <= 15',async()=>{
  for(const name of ['app.js','hosted-ai.js','visual-workflow.js','document-blue.js']){
    const src=await readDist(name);
    assert.equal(/\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/.test(src),false,name+' must not use innerHTML');
    for(const fn of javascriptFunctions(src)){
      assert.ok(fn.ccn<=15,`${name}:${fn.id} CCN ${fn.ccn} exceeds 15`);
    }
  }
});

test('Shared source bus, prompt presets, BLUE finding cards and ledger bridge work without extra uploads',async()=>{
  const hostedSrc=await readDist('hosted-ai.js');
  const doc=new EventTarget();
  doc.body=new SyntheticNode('body',doc);
  doc.readyState='complete';
  doc.createElement=tag=>new SyntheticNode(tag,doc);
  doc.getElementById=id=>doc.body.find(n=>n.id===id);
  const host=new SyntheticNode('section',doc);
  host.id='hosted-ai';
  doc.body.append(host);

  const calls=[];
  const recorded=[];
  const store=new Map();
  const storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
  const caps={enabled:true,provider:'anthropic',execution:'server',models:['claude-sonnet-5-5'],efforts:['high'],limits:{maxUploadBytes:33554432,maxPromptChars:8000}};
  const blueResult={
    schema:'falsify.document-blue.v1',status:'ok',
    coverage:{complete:true,resultCoverage:{accepted:1,rejected:0,unresolved:0}},
    findings:[{
      id:'f1',locationLabel:'Results / Table 1',findingType:'D1',
      quote:'The reported p-value was 0.040.',
      rationale:'Degrees of freedom imply p = 0.004, contradicting Table 1.',
      uncertainty:'Raw patient-level table not attached.'
    }]
  };
  const fetchStub=async(url,init={})=>{
    const path=new URL(url).pathname,method=String(init.method||'GET').toUpperCase();
    calls.push({path,method,body:init.body});
    if(path==='/v1/ai/capabilities') return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(caps)};
    if(path==='/v1/ai/uploads') return {ok:true,status:201,headers:{get:()=>null},text:async()=>JSON.stringify({upload:{id:'up-shared',sha256:PDF_SHA,name:'shared.pdf',mime:'application/pdf',bytes:PDF_BYTES.length,deduplicated:false}})};
    if(path==='/v1/ai/jobs'&&method==='POST') return {ok:true,status:202,headers:{get:()=>null},text:async()=>JSON.stringify({job:{id:'job-blue-1',role:'blue',state:'completed',progress:{completedCalls:1,requiredCalls:1,phase:'completed'},model:'claude-sonnet-5-5',effort:'high',provider:'anthropic',usage:{inputTokens:10,outputTokens:20},result:blueResult,artifacts:[]},replayed:false})};
    return {ok:false,status:404,headers:{get:()=>null},text:async()=>'{}'};
  };

  const ctx=vm.createContext({
    console,URL,Event,CustomEvent,setTimeout,clearTimeout,TextEncoder,AbortController,
    FalsifyHarness:{builtin:role=>({schema:'falsify.harness.v1',id:'builtin-'+role,name:'기본 '+role.toUpperCase(),version:'1',role,instructions:'check',maxCalls:8})},
    FalsifyLab:{
      async record(role,docRec,req,res,prov){recorded.push({role,docRec,req,res,prov});return 'ledger-blue-1';},
      async review(){return true;}
    }
  });
  ctx.globalThis=ctx;
  vm.runInContext(hostedSrc,ctx,{filename:'hosted-ai.js'});

  let guestsMinted=0;
  const app=ctx.FalsifyHostedAi.create({
    document:doc,host,fetch:fetchStub,storage,crypto:globalThis.crypto,URL,TextEncoder,AbortController,
    config:()=>Object.freeze({apiBase:'https://worker.test',provider:'confluence',hostedAi:Object.freeze({enabled:true,apiBase:'https://worker.test'}),openAccess:Object.freeze({enabled:true})}),
    sessionProvider:()=>({token:()=>{guestsMinted++;return 'fsg_'+'z'.repeat(43);},invalidate(){}})
  });
  await app.ready;

  const $=id=>host.find(n=>n.id===id);
  assert.equal($('hosted-ai-prompt').value,'','initial prompt stays empty for contract compatibility');
  assert.equal($('hosted-ai-run').disabled,true);

  // Shared source bus adopts #paper-file / #doc-blue-file PDF with zero network or guest token calls.
  const sharedFile={name:'shared.pdf',size:PDF_BYTES.length,type:'application/pdf',arrayBuffer:async()=>PDF_BYTES.buffer.slice(PDF_BYTES.byteOffset,PDF_BYTES.byteOffset+PDF_BYTES.byteLength)};
  doc.dispatchEvent(new CustomEvent('falsify:blue-file',{detail:{file:sharedFile,sourceRunId:null}}));
  for(let i=0;i<60&&!$('hosted-ai-file-status').textContent.includes(PDF_SHA);i++) await new Promise(r=>setTimeout(r,10));
  assert.match($('hosted-ai-file-status').textContent,new RegExp(PDF_SHA));
  assert.equal($('hosted-ai-role').value,'blue');
  assert.equal(guestsMinted,0,'shared file bus never mints a guest token');
  assert.equal(calls.filter(c=>c.path==='/v1/ai/uploads').length,0,'shared file bus never uploads before Run');

  // One-click preset fills BLUE blind instruction and unlocks Run immediately.
  assert.equal($('hosted-ai-preset-p2').hidden,false);
  $('hosted-ai-preset-default').click();
  assert.ok($('hosted-ai-prompt').value.length>20,'preset fills non-empty instruction');
  assert.equal($('hosted-ai-run').disabled,false,'preset immediately unlocks Run');

  $('hosted-ai-run').click();
  for(let i=0;i<80&&recorded.length===0;i++) await new Promise(r=>setTimeout(r,10));
  assert.equal(guestsMinted,1);
  assert.equal($('hosted-ai-findings').hidden,false,'accepted BLUE findings card section is visible');
  assert.match($('hosted-ai-findings').textContent,/The reported p-value was 0\.040\./);
  assert.match($('hosted-ai-findings').textContent,/Degrees of freedom imply p = 0\.004/);
  assert.equal(recorded.length,1,'completed hosted BLUE run is recorded to FalsifyLab');
  assert.equal(recorded[0].role,'blue');
  assert.equal($('hosted-ai-ledger-actions').hidden,false,'button to jump to H1 review is revealed');
  app.destroy();
});

test('Wayfinding sign reflects hosted AI state across RED and BLUE without breaking legacy events',async()=>{
  const appSrc=await readDist('app.js');
  const nodes=new Map(),listeners={};
  const node=sel=>{
    if(!nodes.has(sel)) nodes.set(sel,{
      textContent:'',dataset:{},classList:{remove(){},add(){}},listeners:{},
      addEventListener(type,fn){(this.listeners[type]||(this.listeners[type]=[])).push(fn);},
      querySelectorAll:()=>[],focus(){this.focused=true;},scrollIntoView(){},closest(){return this;},
      click(){for(const fn of this.listeners.click||[]) fn({type:'click',target:this});}
    });
    return nodes.get(sel);
  };
  const document={querySelector:node,querySelectorAll:()=>[],addEventListener:(t,fn)=>{listeners[t]=fn;},dispatchEvent(){}};
  const ctx={document,location:{hash:'#red'},history:{replaceState(){},pushState(){}},matchMedia:()=>({matches:true}),clearTimeout(){},addEventListener(){},scrollTo(){},CustomEvent};
  vm.runInNewContext(appSrc,ctx);

  listeners['falsify:hosted-ai-state']({detail:{operate:true,role:'red',hasFile:true,fileName:'trial.pdf',busy:false,candidateCount:3,selectedCount:2,hasEditedPdf:false}});
  assert.equal(node('#sign-title').textContent,'후보를 선택하고 PDF에 적용하세요');
  assert.equal(node('#sign-detail').textContent,'trial.pdf · 3개 후보 · 2개 선택');
  assert.equal(node('#paper-name').textContent,'trial.pdf');

  listeners['falsify:hosted-ai-state']({detail:{operate:true,role:'red',hasFile:true,fileName:'trial.pdf',busy:false,candidateCount:3,selectedCount:2,hasEditedPdf:true}});
  assert.equal(node('#sign-title').textContent,'수정본 PDF가 준비됐습니다');
  assert.equal(node('#sign-action-label').textContent,'BLUE로 검증하기');

  ctx.FalsifyHostedAi={capabilities:()=>({blueJobs:false,modelJobs:false})};
  listeners['falsify:hosted-ai-state']({detail:{operate:true,role:'red',hasFile:true,fileName:'trial.pdf',busy:false,candidateCount:0,selectedCount:0,hasEditedPdf:true}});
  assert.equal(node('#sign-action-label').textContent,'부스에 제출하기');
  node('#sign-action').click();
  assert.equal(node('#booth').focused,true);

  ctx.FalsifyHostedAi={capabilities:()=>({blueJobs:true,modelJobs:true})};
  listeners['falsify:hosted-ai-state']({detail:{operate:true,role:'red',hasFile:true,fileName:'trial.pdf',busy:false,candidateCount:0,selectedCount:0,hasEditedPdf:true}});
  assert.equal(node('#sign-action-label').textContent,'BLUE로 검증하기');
  node('#sign-action').click();
  assert.equal(node('#hosted-ai-blue-handoff').focused,true);
});

test('visual-workflow defines all 8 Arena finding verdicts without dropping pre-existing, spin-boundary, or gold-error',async()=>{
  const vwSrc=await readDist('visual-workflow.js');
  const reviewSrc=await readDist('review-workbench.js');
  const reviewCtx={globalThis:{}};
  vm.runInNewContext(reviewSrc,reviewCtx);
  const verdicts=reviewCtx.globalThis.FalsifyReview.FINDING_VERDICTS;
  assert.equal(verdicts.length,8);
  for(const code of verdicts){
    const re=new RegExp(`['"]?${code.replace('-','\\-')}['"]?\\s*:\\s*\\[`);
    assert.match(vwSrc,re,`visual-workflow ITEM_VERDICT_NAMES must map ${code}`);
  }
  assert.doesNotMatch(vwSrc,/supported:\['check','맞음'\]/,'ambiguous 맞음/아님 polarity label is replaced');
});
