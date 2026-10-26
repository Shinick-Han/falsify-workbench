/* External RED import panel. Mounts into the paper workspace when that host exists.
   Copies a prompt locally, parses a paste, and sends only explicitly checked unique matches.
   Origin is external-ai-import. This is not a verified run and does not call a model. */
(function(root){
  'use strict';
  const READY='falsify:paper-workspace-ready',SOURCE='falsify:paper-workspace-source',HOST_ID='paper-workspace',ORIGIN='external-ai-import';
  const FILE_NAME='falsify-external-red-prompt.txt';
  const booted=new WeakSet(),clears=new WeakMap();
  function parser(){return root.FalsifyExternalRed||null;}
  function workspace(){return root.FalsifyPaperWorkspace||null;}
  function el(doc,tag,className,text){
    const node=doc.createElement(tag);
    if(className)node.className=className;
    if(text!==undefined)node.textContent=text;
    return node;
  }
  function mount(doc){
    if(!doc||typeof doc.addEventListener!=='function')return null;
    if(!booted.has(doc)){
      booted.add(doc);
      doc.addEventListener(READY,()=>attach(doc));
      doc.addEventListener(SOURCE,()=>{const clear=clears.get(doc);if(clear)clear();});
    }
    attach(doc);
    return api;
  }
  function attach(doc){
    const host=typeof doc.getElementById==='function'?doc.getElementById(HOST_ID):null;
    if(!host||host.querySelector&&host.querySelector('#external-red'))return;
    const red=parser();
    const section=el(doc,'section','external-red');
    section.id='external-red';
    section.setAttribute('aria-label','외부 모델 응답 가져오기');
    section.append(el(doc,'h2',null,'외부 모델 응답 가져오기'));
    section.append(el(doc,'p','muted','이 가져오기는 검증된 RED 실행이 아닙니다. Falsify가 모델을 호출하지 않으며, 응답을 자동으로 적용하지 않습니다. 프롬프트를 외부 모델에 직접 붙여넣고, 응답은 여기서 검토한 뒤 고른 유일한 대응만 워크스페이스에 올립니다.'));
    const modelLabel=el(doc,'label',null,'모델 이름 (선택, 검증되지 않은 표시)');
    const modelInput=el(doc,'input');
    modelInput.id='external-red-model';
    modelInput.type='text';
    modelInput.maxLength=red?red.LIMITS.modelLabel:120;
    modelInput.setAttribute('autocomplete','off');
    modelLabel.append(modelInput);
    const copyButton=el(doc,'button','button secondary','원문과 과제 프롬프트 복사');
    copyButton.id='external-red-copy';
    copyButton.type='button';
    const downloadButton=el(doc,'button','button secondary','프롬프트 TXT 내려받기');
    downloadButton.id='external-red-download';
    downloadButton.type='button';
    const actions=el(doc,'div','button-row');
    actions.append(copyButton,downloadButton);
    const copyStatus=el(doc,'p','external-red-status');
    copyStatus.id='external-red-copy-status';
    const pasteLabel=el(doc,'label',null,'붙여넣은 응답');
    const paste=el(doc,'textarea');
    paste.id='external-red-paste';
    paste.rows=8;
    pasteLabel.append(paste);
    const reviewButton=el(doc,'button','button secondary','대응 검토');
    reviewButton.id='external-red-review';
    reviewButton.type='button';
    const diagnostics=el(doc,'div','external-red-diagnostics');
    diagnostics.id='external-red-diagnostics';
    const proposals=el(doc,'div','external-red-proposals');
    proposals.id='external-red-proposals';
    const acceptButton=el(doc,'button','button primary','선택한 대응만 워크스페이스에 제안');
    acceptButton.id='external-red-accept';
    acceptButton.type='button';
    acceptButton.disabled=true;
    const acceptStatus=el(doc,'p','external-red-status');
    acceptStatus.id='external-red-accept-status';
    section.append(modelLabel,actions,copyStatus,pasteLabel,reviewButton,diagnostics,proposals,acceptButton,acceptStatus);
    host.append(section);
    let state=[],notes=[],mapped=null;
    function say(node,message,error){node.textContent=message||'';node.className='external-red-status'+(error?' error':'');}
    function sync(){acceptButton.disabled=!state.some(item=>item.status==='matched'&&item.checked);}
    function render(){
      diagnostics.replaceChildren();
      for(const note of notes){
        const row=el(doc,'p','external-red-diagnostic',note.message);
        diagnostics.append(row);
        if(note.model)diagnostics.append(el(doc,'p','external-red-diagnostic','모델 표시: '+note.model));
      }
      proposals.replaceChildren();
      state.forEach((item,index)=>{
        const card=el(doc,'article','external-red-proposal');
        card.setAttribute('data-status',item.status);
        const page=item.pageIndex===null||item.pageIndex===undefined?'미정':String(item.pageIndex);
        const label=item.status==='matched'?'유일한 대응':item.status==='ambiguous'?'위치가 여러 곳이거나 확정이 필요함':'원문에 없음';
        card.append(el(doc,'h3',null,label+' · '+(item.segmentId||'문단 미정')+' · pageIndex '+page));
        card.append(el(doc,'p','external-red-before','Before: '+item.before));
        card.append(el(doc,'p','external-red-after','After: '+item.after));
        if(item.status==='matched'){
          const choice=el(doc,'label','check-row');
          const box=el(doc,'input');
          box.type='checkbox';
          box.checked=!!item.checked;
          box.addEventListener('change',()=>{item.checked=!!box.checked;sync();});
          choice.append(box,el(doc,'span',null,'이 대응을 워크스페이스 제안 목록에 넣기'));
          card.append(choice);
        }else if(item.status==='ambiguous'&&item.listComplete&&item.matches.length){
          card.append(el(doc,'p',null,'위치가 한 곳으로 확정되기 전에는 보내지 않습니다.'));
          let selected=0;
          item.matches.forEach((match,matchIndex)=>{
            const choice=el(doc,'label','check-row');
            const radio=el(doc,'input');
            radio.type='radio';
            radio.name='external-red-match-'+index;
            radio.checked=matchIndex===0;
            radio.addEventListener('change',()=>{if(radio.checked)selected=matchIndex;});
            choice.append(radio,el(doc,'span',null,'위치 '+(matchIndex+1)+' · '+match.segmentId+' · pageIndex '+match.pageIndex+' · '+match.start+'-'+match.end));
            card.append(choice);
          });
          const pick=el(doc,'button','button secondary','고른 위치로 확정');
          pick.type='button';
          pick.addEventListener('click',()=>{
            const match=item.matches[selected];
            if(!match)return;
            item.status='matched';
            item.segmentId=match.segmentId;
            item.pageIndex=match.pageIndex;
            item.anchor={start:match.start,end:match.end,occurrence:0};
            item.matches=[{segmentId:match.segmentId,pageIndex:match.pageIndex,start:match.start,end:match.end}];
            item.checked=false;
            item.listComplete=true;
            render();
          });
          card.append(pick);
        }else if(item.status==='ambiguous')card.append(el(doc,'p',null,'위치를 모두 표시할 수 없어 고르지 않았습니다. 더 긴 고유 인용을 사용하세요.'));
        else card.append(el(doc,'p',null,'원문에서 유일한 위치를 찾지 못해 보낼 수 없습니다.'));
        proposals.append(card);
      });
      sync();
    }
    function clearMapping(message){
      if(mapped===null&&!state.length)return;
      state=[];notes=[];mapped=null;render();
      say(acceptStatus,message||'원문이 바뀌어 이전 대응을 지웠습니다. 다시 검토하세요.',true);
    }
    clears.set(doc,()=>clearMapping());
    function currentSource(){
      const apiWorkspace=workspace();
      if(!apiWorkspace||typeof apiWorkspace.getSource!=='function')return null;
      return apiWorkspace.getSource()||null;
    }
    function promptText(){
      const source=currentSource();
      if(!source)throw new Error('원문이 없습니다.');
      const engine=parser();
      if(!engine)throw new Error('외부 응답 파서가 없습니다.');
      return engine.buildPrompt({segments:source.segments,fileHash:source.fileHash});
    }
    function download(text){
      const blob=new root.Blob([text],{type:'text/plain;charset=utf-8'});
      const url=root.URL.createObjectURL(blob);
      const link=el(doc,'a');
      link.href=url;
      link.download=FILE_NAME;
      link.rel='noopener';
      doc.body.append(link);
      link.click();
      link.remove();
      root.setTimeout(()=>root.URL.revokeObjectURL(url),1000);
    }
    async function copyPrompt(){
      let text;
      try{text=promptText();}catch(error){say(copyStatus,error&&error.message?error.message:'프롬프트를 만들지 못했습니다.',true);return;}
      try{
        const clipboard=root.navigator&&root.navigator.clipboard;
        if(!clipboard||typeof clipboard.writeText!=='function')throw new Error('no-clipboard');
        await clipboard.writeText(text);
        say(copyStatus,'프롬프트를 클립보드에 복사했습니다. 모델을 호출하지 않았습니다.');
      }catch{download(text);say(copyStatus,'클립보드 권한이 없어 프롬프트를 TXT로 내려받았습니다. 모델을 호출하지 않았습니다.');}
    }
    function downloadPrompt(){
      let text;
      try{text=promptText();}catch(error){say(copyStatus,error&&error.message?error.message:'프롬프트를 만들지 못했습니다.',true);return;}
      download(text);
      say(copyStatus,'프롬프트를 TXT로 내려받았습니다. 모델을 호출하지 않았습니다.');
    }
    function review(){
      const source=currentSource();
      if(!source){state=[];notes=[];mapped=null;render();say(acceptStatus,'원문이 없습니다.',true);return;}
      const engine=parser();
      if(!engine){say(acceptStatus,'외부 응답 파서가 없습니다.',true);return;}
      const parsed=engine.parse(paste.value,{segments:source.segments,fileHash:source.fileHash});
      mapped=source.fileHash;
      notes=parsed.diagnostics.map(note=>Object.assign({},note));
      state=parsed.proposals.map(item=>({
        segmentId:item.segmentId,pageIndex:item.pageIndex,before:item.before,after:item.after,
        anchor:item.anchor?{start:item.anchor.start,end:item.anchor.end,occurrence:item.anchor.occurrence}:null,
        origin:ORIGIN,status:item.status,listComplete:item.listComplete!==false,checked:false,
        matches:item.matches.map(match=>({segmentId:match.segmentId,pageIndex:match.pageIndex,start:match.start,end:match.end}))
      }));
      render();
      say(acceptStatus,'대응을 계산했습니다. 검증된 실행이 아니며 아직 보내지 않았습니다.');
    }
    async function accept(){
      if(acceptButton.disabled)return;
      const chosen=state.filter(item=>item.status==='matched'&&item.checked);
      if(!chosen.length)return;
      const overlap=(left,right)=>left.matches.some(match=>right.matches.some(other=>match.segmentId===other.segmentId&&match.start<other.end&&other.start<match.end));
      if(chosen.some((item,index)=>chosen.slice(index+1).some(other=>overlap(item,other)))){say(acceptStatus,'겹치는 대응은 함께 보내지 않습니다. 하나만 체크하세요.',true);return;}
      const apiWorkspace=workspace();
      if(!apiWorkspace||typeof apiWorkspace.acceptProposals!=='function'){say(acceptStatus,'워크스페이스 API가 없어 제안을 보내지 않았습니다.',true);return;}
      const source=currentSource();
      if(!source||source.fileHash!==mapped){clearMapping();return;}
      const payload=chosen.map(item=>({
        segmentId:item.segmentId,pageIndex:item.pageIndex,before:item.before,after:item.after,
        anchor:item.anchor?{start:item.anchor.start,end:item.anchor.end,occurrence:item.anchor.occurrence}:null,
        origin:ORIGIN,status:'matched',
        matches:item.matches.map(match=>({segmentId:match.segmentId,pageIndex:match.pageIndex,start:match.start,end:match.end}))
      }));
      const model=modelInput.value.trim().slice(0,modelInput.maxLength||120);
      const options={origin:ORIGIN};
      if(model)options.model=model;
      const token=mapped;
      try{
        await Promise.resolve().then(()=>apiWorkspace.acceptProposals(payload,options));
        if(mapped!==token){clearMapping();return;}
        say(acceptStatus,'워크스페이스에 제안을 올렸습니다. 모호한 위치는 보내지 않았고, 검증된 실행으로 기록하지 않았습니다.');
      }catch{say(acceptStatus,'워크스페이스가 제안을 받지 못해 보내지 못했습니다. 적용하지 않았습니다.',true);}
    }
    copyButton.addEventListener('click',()=>{if(!copyButton.disabled)void copyPrompt();});
    downloadButton.addEventListener('click',()=>{if(!downloadButton.disabled)downloadPrompt();});
    reviewButton.addEventListener('click',()=>{if(!reviewButton.disabled)review();});
    acceptButton.addEventListener('click',()=>{if(!acceptButton.disabled)void accept();});
    render();
  }
  const api={mount,ORIGIN};
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.FalsifyExternalRedUI=api;
  if(root.document&&typeof root.document.getElementById==='function')api.mount(root.document);
})(typeof globalThis==='object'?globalThis:this);
