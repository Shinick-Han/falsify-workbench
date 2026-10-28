/* External RED exchange panel; selection belongs to the workspace. */
(function(root){'use strict';
  function mount(doc){
    function attach(){const host=doc.getElementById('paper-workspace');if(!host||doc.getElementById('external-red'))return;
      const section=doc.createElement('section');section.id='external-red';section.className='external-red';
      function node(tag,text){const n=doc.createElement(tag);if(text!==undefined)n.textContent=text;return n;}
      function button(text,fn){const n=node('button',text);n.type='button';n.className='button secondary';n.addEventListener('click',fn);return n;}
      const title=node('h2','외부 RED 응답 가져오기'),instructions=node('p','응답을 붙여넣거나 파일을 선택하세요. 프롬프트는 필요할 때만 사용합니다.');
      const prompt=node('textarea');prompt.rows=5;prompt.setAttribute('aria-label','편집할 프롬프트');
      const answer=node('textarea');answer.rows=8;answer.id='external-red-paste';answer.setAttribute('aria-label','외부 응답');
      const file=node('input');file.type='file';file.accept='.json,.txt,.md,application/json,text/plain,text/markdown';file.setAttribute('aria-label','응답 파일');
      const status=node('p');status.setAttribute('role','status');const details=node('details'),summary=node('summary','프롬프트 만들기 및 편집');
      const source=()=>root.FalsifyPaperWorkspace?.getSource?.();
      details.append(summary,button('원문과 과제 만들기',()=>{const s=source();if(!s){status.textContent='먼저 원문을 선택하세요.';return;}prompt.value=root.FalsifyExternalExchange.buildPrompt({role:'red',...s});}),prompt,button('프롬프트 복사',async()=>{try{await root.navigator.clipboard.writeText(prompt.value);status.textContent='복사했습니다.';}catch{status.textContent='프롬프트를 선택해 복사하세요.';prompt.select();}}));
      file.addEventListener('change',async()=>{try{if(file.files[0])answer.value=await file.files[0].text();}catch(e){status.textContent='파일을 읽지 못했습니다: '+e.message;}});
      const before=node('textarea'),after=node('textarea'),completion=node('details');before.rows=2;after.rows=2;before.setAttribute('aria-label','원문 Before');after.setAttribute('aria-label','변경 After');completion.append(node('summary','직접 Before / After 완성'),node('p','원문과 변경을 입력하세요. 빈 After는 삭제입니다.'),before,after);
      const importButton=button('응답 가져오기',()=>{const s=source(),w=root.FalsifyPaperWorkspace;if(!s||!w?.acceptExternalResponse){status.textContent='원문 또는 작업 공간이 준비되지 않았습니다.';return;}try{let batch=root.FalsifyExternalExchange.parse(answer.value,{role:'red',segments:s.segments,fileHash:s.fileHash});if(before.value.trim()){const manual=root.FalsifyExternalExchange.parse(JSON.stringify({changes:[{before:before.value,after:after.value}]}),{role:'red',segments:s.segments,fileHash:s.fileHash});batch.items.push(...manual.items);batch.diagnostics.push(...manual.diagnostics);if(batch.items.length)batch.status='ok';}if(batch.diagnostics.some(d=>d.code==='role-mismatch'))throw Error('응답의 역할이 다릅니다.');if(batch.diagnostics.some(d=>d.code==='file-hash-mismatch')&&!root.confirm('응답의 원문 식별이 다릅니다. 현재 원문에 가져올까요?'))return;w.acceptExternalResponse(batch);status.textContent='응답 저장 · 변경 '+batch.items.length+'개. '+batch.diagnostics.map(d=>d.message).join(' ');}catch(e){status.textContent='가져오지 못했습니다: '+e.message;}});
      section.append(title,instructions,details,answer,file,completion,importButton,status);host.append(section);
    }
    doc.addEventListener('falsify:paper-workspace-ready',attach);attach();return api;
  }
  const api={mount};root.FalsifyExternalRedUI=api;if(root.document)mount(root.document);
})(typeof globalThis==='object'?globalThis:this);
