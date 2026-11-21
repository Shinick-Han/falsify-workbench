'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../dist/app.js'),'utf8');
function shell(hash){
  const nodes=new Map(), listeners={};
  function node(selector){
    if(!nodes.has(selector)) nodes.set(selector,{textContent:'',dataset:{},classList:{remove(){},add(){}},addEventListener(){},querySelectorAll(){return [];},focus(){},scrollIntoView(){},closest(){return this;}});
    return nodes.get(selector);
  }
  const document={querySelector:node,querySelectorAll(){return [];},addEventListener(type,fn){listeners[type]=fn;}};
  const context={document,location:{hash},history:{replaceState(){},pushState(){}},matchMedia:()=>({matches:true}),clearTimeout(){},addEventListener(){},scrollTo(){}};
  vm.runInNewContext(source,context);
  return {node,emit:(name,detail)=>listeners[name]({detail}),context};
}
test('RED sign reflects source and document progress states',()=>{
  const s=shell('#red');
  assert.equal(s.node('#sign-title').textContent,'논문 파일을 입력하세요');
  s.emit('falsify:document-state',{name:'paper.pdf',count:2,selected:1});
  assert.equal(s.node('#sign-title').textContent,'후보를 선택하고 편집하세요');
  assert.equal(s.node('#sign-detail').textContent,'paper.pdf · 2개 후보 · 1개 선택');
  s.context.FalsifyLatexWorkbench={active:true,getSource:()=>({file:{name:'source.tex'}}),getSession:()=>({snapshot:()=>({artifact:true})})};
  s.emit('falsify:latex-state');
  assert.equal(s.node('#sign-title').textContent,'원본을 눌러 수정하세요');
  assert.equal(s.node('#sign-detail').textContent,'source.tex');
});
test('BLUE sign reflects busy, result and ready states',()=>{
  const s=shell('#blue');
  assert.equal(s.node('#sign-title').textContent,'BLUE 검토 파일을 입력하세요');
  for(const [detail,title] of [[{busy:true,phase:'import',name:'p'},'변경본을 읽고 있습니다'],[{hasResult:true,name:'p'},'BLUE 결과를 확인하세요'],[{name:'p'},'논문을 검토할 준비가 됐습니다']]){
    s.emit('falsify:blue-state',detail);
    assert.equal(s.node('#sign-title').textContent,title);
  }
});
test('event booth mode skips shared FalsifyImport 200p extraction while Workbench keeps it',async()=>{
  function mountApp(boothMode){
    const nodes=new Map(), docEvents=[];
    function node(selector){
      if(!nodes.has(selector)){
        const listeners=new Map();
        nodes.set(selector,{
          value:'',hidden:false,textContent:'',dataset:{},files:[],
          classList:{remove(){},add(){}},
          replaceChildren(){},
          addEventListener(type,fn){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn);},
          fire(type,ev){return Promise.all((listeners.get(type)||[]).map(fn=>fn(ev)));},
          querySelectorAll(){return [];},focus(){},scrollIntoView(){},closest(){return this;}
        });
      }
      return nodes.get(selector);
    }
    let extractCalls=0;
    const document={
      querySelector:node,
      querySelectorAll(){return [];},
      getElementById:id=>(boothMode&&id==='booth'?{id:'booth'}:null),
      addEventListener(){},
      dispatchEvent(ev){docEvents.push(ev.type);}
    };
    const context={
      document,Event,CustomEvent,AbortController,
      location:{hash:'#workbench'},history:{replaceState(){},pushState(){}},
      matchMedia:()=>({matches:true}),clearTimeout(){},addEventListener(){},scrollTo(){},
      FalsifyImport:{extract:async()=>{extractCalls+=1;throw new Error('200쪽을 넘는 PDF는 지원하지 않습니다.');}}
    };
    if(boothMode) context.FalsifyCloudConfig={booth:{enabled:true}};
    context.globalThis=context;
    vm.runInNewContext(source,context);
    return {node,docEvents,extractCalls:()=>extractCalls};
  }
  const fakeFile={name:'205-pages.pdf',type:'application/pdf'};
  const boothApp=mountApp(true);
  const boothInput=boothApp.node('#paper-file');
  boothInput.value='C:\\fakepath\\205-pages.pdf';
  await boothInput.fire('change',{target:{files:[fakeFile]}});
  assert.equal(boothApp.extractCalls(),0,'booth event page skips shared 200p import');
  assert.equal(boothInput.value,'C:\\fakepath\\205-pages.pdf','#paper-file is not cleared by shared import');
  assert.ok(boothApp.docEvents.includes('falsify:document-clear'));
  await boothApp.node('#import-clear').fire('click',{});
  assert.equal(boothInput.value,'','#import-clear still clears #paper-file on reset');

  const workbenchApp=mountApp(false);
  const wbInput=workbenchApp.node('#paper-file');
  wbInput.value='C:\\fakepath\\205-pages.pdf';
  await wbInput.fire('change',{target:{files:[fakeFile]}});
  assert.equal(workbenchApp.extractCalls(),1,'Workbench still runs FalsifyImport.extract');
  assert.equal(wbInput.value,'','Workbench still clears #paper-file when import fails');
});
