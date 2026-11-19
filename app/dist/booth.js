/* Event-page booth panel. Renders only when FalsifyCloudConfig.booth.enabled and
   GET /v1/booth/config reports enabled. Declared reasons leave the browser only in
   the meta part of POST /v1/booth/submissions. The pdf part is the workspace file.
   Claim keys are stored on this device, capped at 10. */
(function(root){
  'use strict';
  const RECEIPT_KEY='falsify.booth.receipts.v1';
  const RECEIPT_CAP=10;
  const CONSENT_COPY='제출한 수정본 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디가 저장하고 운영자가 읽습니다. 마감 후 AI 검증에는 수정본 PDF만 모델 제공자(Anthropic 또는 OpenAI)에 보내며, 결함 설명은 AI에 보내지 않습니다. 이름·연락처는 받지 않으니 이유란에도 적지 마세요. 원 논문은 CC BY·CC BY-SA·CC0 공개 논문이며, 수정본을 스터디 밖에 공개할 때는 저자·arXiv 번호·라이선스와 수정 사실을 밝힙니다. 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있고, 철회하면 설명·결과·수정본 PDF가 서버에서 즉시 삭제되며 운영자 보관본도 지웁니다. 보관 자료는 스터디 종료 후 삭제합니다.';
  const PICK_PAPER='미션이나 검색에서 논문을 골라 시작해 주세요';
  const CONSENT_VERSION='2026-11-22.v1';
  const CROCKFORD='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CONTROL=/[\u0000-\u001f\u007f]/;
  const SHA256=/^[0-9a-f]{64}$/;
  const ARXIV_ID=/^(?:\d{4}\.\d{4,5}(?:v\d{1,3})?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d{1,3})?)$/;
  const LICENSE_RE=/^(?:cc-by(?:-\d+\.\d+)?|cc-by-sa(?:-\d+\.\d+)?|cc0(?:-1\.0)?|public-domain)$/;
  const DEFECT_TYPES=[
    {id:'number',label:'수치·통계'},{id:'figure',label:'그림·표'},{id:'citation',label:'인용·출처'},
    {id:'logic',label:'논리·결론'},{id:'method',label:'방법·실험 설계'},{id:'other',label:'기타'}
  ];
  const COURSES=[{id:'quick',label:'빠른 코스'},{id:'deep',label:'정밀 코스'}];
  const STATUS_LABEL={received:'접수됨',reviewing:'검토 중',judged:'판정됨',invalid:'무효',withdrawn:'철회됨'};
  const OUTCOME_LABEL={missed:'놓침',caught:'잡힘',partial:'일부 확인',invalid:'무효'};
  const ERROR_TEXT={
    booth_closed:'지금은 접수를 받지 않습니다. 운영 안내를 확인해 주세요.',
    consent_outdated:'동의 문구가 갱신되었습니다. 페이지를 새로 고친 뒤 다시 동의해 주세요.',
    job_not_ready:'수정본이 아직 준비되지 않았습니다. 적용이 끝난 뒤 다시 제출해 주세요.',
    already_submitted:'이미 제출된 수정본입니다. 이전에 받은 접수번호로 결과를 확인하세요.',
    pii_not_allowed:'별명에 이메일이나 전화번호처럼 보이는 내용은 넣을 수 없습니다.',
    rate_limited:'요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.',
    license_not_allowed:'이 논문은 부스가 허용하는 라이선스(CC BY, CC BY-SA, CC0)가 아닙니다.',
    payload_too_large:'논문 파일이 너무 커서 열 수 없습니다.',
    not_found:'접수번호 또는 확인키가 맞지 않습니다.',
    paper_not_allowed:'이 논문의 라이선스는 부스 제출에 쓸 수 없습니다. CC BY, CC BY-SA, CC0 논문만 제출할 수 있습니다.',
    invalid_pdf:'수정본 PDF를 확인하지 못했습니다. PDF 파일을 다시 만들어 주세요.',
    pdf_mismatch:'수정본 PDF와 해시가 일치하지 않습니다. 다시 만들어 제출해 주세요.',
    pdf_unchanged:'수정본이 원본과 같습니다. 편집을 적용한 PDF를 만들어 주세요.',
    session_missing:'게스트 세션이 없어 요청을 보내지 못했습니다. 페이지를 새로 고친 뒤 다시 시도해 주세요.',
    invalid_request:'입력 내용을 확인해 주세요.',
    forbidden:'이 작업은 할 수 없습니다.',
    network:'서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.'
  };

  function errorMessage(code, extra){
    const known=typeof code==='string'&&Object.prototype.hasOwnProperty.call(ERROR_TEXT,code)?code:'';
    if(known==='already_submitted'&&extra&&typeof extra.receipt==='string'&&/^F-\d{4,}$/.test(extra.receipt)){
      return '이미 제출된 수정본입니다. 접수번호 '+extra.receipt+'로 결과를 확인하세요.';
    }
    return known?ERROR_TEXT[known]:'요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  }
  function normalizeClaimKey(value){
    if(typeof value!=='string') return '';
    const text=value.toUpperCase().replace(/[- ]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1');
    if(text.length!==8||[...text].some(ch=>!CROCKFORD.includes(ch))) return '';
    return text.slice(0,4)+'-'+text.slice(4);
  }
  function normalizeReceipt(value){
    if(typeof value!=='string') return '';
    const text=value.trim().toUpperCase();
    return /^F-\d{4,}$/.test(text)?text:'';
  }
  function boundedInt(value, fallback, min, max){
    const n=Number(value);
    if(!Number.isSafeInteger(n)) return fallback;
    if(n<min) return min;
    if(n>max) return max;
    return n;
  }
  function limitsOf(input){
    const limits=input&&input.limits&&typeof input.limits==='object'?input.limits:{};
    return {
      maxDeclared:boundedInt(limits.maxDeclared,5,1,5),
      maxReason:boundedInt(limits.maxReason,500,1,500),
      maxNickname:boundedInt(limits.maxNickname,24,1,24)
    };
  }
  function nicknameProblem(nickname, max){
    if(nickname==='') return '';
    if(CONTROL.test(nickname)||nickname.length>max) return 'invalid_request';
    if(nickname.includes('@')||/\d{7,}/.test(nickname)) return 'pii_not_allowed';
    return '';
  }
  function cleanText(value, max){
    if(typeof value!=='string') return null;
    if(CONTROL.test(value)||value.length>max) return null;
    return value;
  }
  /* Paper is required. source is arxiv or mission, and the license is one the booth allows. */
  function paperBody(paper){
    if(!paper||typeof paper!=='object') return null;
    if(paper.source!=='arxiv'&&paper.source!=='mission') return null;
    const id=cleanText(typeof paper.id==='string'?paper.id.trim():'',64);
    if(!id) return null;
    const raw=typeof paper.license==='object'&&paper.license?paper.license.id:paper.license;
    const license=cleanText(typeof raw==='string'?raw.trim().toLowerCase():'',40);
    if(!license||!LICENSE_RE.test(license)) return null;
    let title='';
    if(paper.title!=null&&paper.title!==''){
      title=cleanText(paper.title,300);
      if(title===null) return null;
    }
    const body={source:paper.source,id};
    if(title) body.title=title;
    body.license=license;
    const sourceSha256=typeof paper.sourceSha256==='string'&&SHA256.test(paper.sourceSha256)?paper.sourceSha256:'';
    if(sourceSha256) body.sourceSha256=sourceSha256;
    return body;
  }
  function declaredItem(row, limits, types){
    if(!row||typeof row!=='object') return null;
    const pageIndex=row.pageIndex;
    if(!Number.isSafeInteger(pageIndex)||pageIndex<0||pageIndex>9999) return null;
    const before=cleanText(row.before,2000);
    const after=cleanText(row.after,2000);
    const reason=cleanText(typeof row.reason==='string'?row.reason.trim():'',limits.maxReason);
    if(before===null||after===null||reason===null||!before||!reason) return null;
    if(typeof row.defectType!=='string'||!types.includes(row.defectType)) return null;
    const item={pageIndex,before,after,defectType:row.defectType,reason};
    if(row.segmentId!=null&&row.segmentId!==''){
      const segmentId=cleanText(row.segmentId,120);
      if(segmentId===null||!segmentId) return null;
      item.segmentId=segmentId;
    }
    const ordered={pageIndex:item.pageIndex};
    if(item.segmentId) ordered.segmentId=item.segmentId;
    ordered.before=item.before;
    ordered.after=item.after;
    ordered.defectType=item.defectType;
    ordered.reason=item.reason;
    return ordered;
  }
  /* Meta has no job id. editedSha256 is the lowercase SHA-256 of the PDF part. */
  function buildSubmission(input){
    const source=input&&typeof input==='object'?input:{};
    const limits=limitsOf(source);
    const nickname=typeof source.nickname==='string'?source.nickname.trim():'';
    const nick=nicknameProblem(nickname,limits.maxNickname);
    if(nick) return {ok:false,code:nick};
    if(source.consent!==true) return {ok:false,code:'invalid_request'};
    if(source.course!=='quick'&&source.course!=='deep') return {ok:false,code:'invalid_request'};
    const consentVersion=typeof source.consentVersion==='string'&&source.consentVersion?source.consentVersion:CONSENT_VERSION;
    if(consentVersion.length>80||CONTROL.test(consentVersion)) return {ok:false,code:'invalid_request'};
    const types=Array.isArray(source.defectTypes)&&source.defectTypes.length
      ?source.defectTypes.filter(id=>typeof id==='string'):DEFECT_TYPES.map(item=>item.id);
    const rows=Array.isArray(source.rows)?source.rows:[];
    if(rows.length<1||rows.length>limits.maxDeclared) return {ok:false,code:'invalid_request'};
    const declared=[];
    for(const row of rows){
      const item=declaredItem(row,limits,types);
      if(!item) return {ok:false,code:'invalid_request'};
      declared.push(item);
    }
    const paper=paperBody(source.paper);
    if(!paper) return {ok:false,code:'paper_not_allowed'};
    const editedSha256=typeof source.editedSha256==='string'&&SHA256.test(source.editedSha256)?source.editedSha256:'';
    if(!editedSha256) return {ok:false,code:'invalid_request'};
    if(paper.sourceSha256&&paper.sourceSha256===editedSha256) return {ok:false,code:'pdf_unchanged'};
    const body={course:source.course,declared,paper};
    if(nickname) body.nickname=nickname;
    body.consentVersion=consentVersion;
    body.editedSha256=editedSha256;
    return {ok:true,body};
  }
  /* Exactly two parts: meta JSON text, then the edited PDF. */
  function submissionForm(body, file){
    if(!body||typeof body!=='object'||typeof FormData!=='function') return null;
    if(!file||typeof file.arrayBuffer!=='function') return null;
    const form=new FormData();
    form.append('meta', JSON.stringify(body));
    const name=typeof file.name==='string'&&file.name?file.name.slice(0,180):'edited.pdf';
    form.append('pdf', file, name);
    return form;
  }
  function isReceiptRecord(item){
    return !!item&&typeof item==='object'
      &&normalizeReceipt(item.receipt)===item.receipt
      &&normalizeClaimKey(item.claimKey)===item.claimKey
      &&typeof item.createdAt==='string'&&item.createdAt.length<=40;
  }
  function readReceipts(storage){
    if(!storage||typeof storage.getItem!=='function') return [];
    let data=null;
    try{data=JSON.parse(storage.getItem(RECEIPT_KEY)||'');}catch{return [];}
    if(!Array.isArray(data)) return [];
    return data.filter(isReceiptRecord).slice(0,RECEIPT_CAP);
  }
  function rememberReceipt(storage, record){
    const next=isReceiptRecord(record)?record:null;
    if(!next||!storage||typeof storage.setItem!=='function') return readReceipts(storage);
    const kept=readReceipts(storage).filter(item=>item.receipt!==next.receipt);
    const capped=[next,...kept].slice(0,RECEIPT_CAP);
    try{storage.setItem(RECEIPT_KEY,JSON.stringify(capped));}catch{return readReceipts(storage);}
    return capped;
  }
  function paperSearchPath(query, page){
    const q=typeof query==='string'?query.trim():'';
    const n=Number(page);
    if(!q||q.length>200||!Number.isSafeInteger(n)||n<1||n>5) return '';
    const params=new URLSearchParams();
    params.set('q',q);
    params.set('page',String(n));
    return '/v1/papers/search?'+params.toString();
  }
  function paperPdfPath(id){
    if(typeof id!=='string'||!ARXIV_ID.test(id)) return '';
    return '/v1/papers/pdf?id='+encodeURIComponent(id);
  }
  function errorCodeFrom(data){
    if(!data||typeof data!=='object') return '';
    if(typeof data.error==='string'&&/^[a-z0-9_]{1,64}$/.test(data.error)) return data.error;
    const nested=data.error&&typeof data.error==='object'?data.error:null;
    const code=nested&&typeof nested.code==='string'?nested.code:'';
    return /^[a-z0-9_]{1,64}$/.test(code)?code:'';
  }
  function readConfig(){
    try{return root.FalsifyCloudConfig||null;}catch{return null;}
  }
  function boothConfigured(config){
    return !!(config&&config.booth&&config.booth.enabled===true);
  }
  function parseBase(value){
    if(typeof value!=='string'||!value) return '';
    try{
      const url=new URL(value,root.location&&root.location.href);
      const loop=url.hostname==='127.0.0.1'||url.hostname==='localhost';
      if(url.protocol!=='https:'&&!(loop&&url.protocol==='http:')) return '';
      if(url.username||url.password||url.search||url.hash) return '';
      return url.origin+url.pathname.replace(/\/+$/,'');
    }catch{return '';}
  }
  function apiBaseOf(config){
    if(!config) return '';
    const hosted=config.hostedAi&&typeof config.hostedAi==='object'?config.hostedAi:null;
    return parseBase(hosted&&hosted.apiBase)||parseBase(config.apiBase);
  }

  function mount(options){
    const opts=options&&typeof options==='object'?options:{};
    const doc=opts.document||root.document;
    if(!doc||typeof doc.createElement!=='function'||typeof doc.getElementById!=='function') return {destroy(){}};
    if(doc.getElementById('booth')) return {destroy(){}};
    const configFn=opts.config||readConfig;
    const config=typeof configFn==='function'?configFn():configFn;
    if(!boothConfigured(config)) return {destroy(){}};
    const fetchImpl=opts.fetch||(typeof root.fetch==='function'?root.fetch.bind(root):null);
    const cryptoApi=opts.crypto||root.crypto||null;
    const storage=opts.storage||root.localStorage;
    const sessionFn=opts.session||(()=>root.FalsifyHostedSession);
    const location=opts.location||root.location||{hash:''};
    const listeners=[];
    let closed=false;
    let liveConfig=null;
    let course='quick';
    let paper=null;
    let boothFile=null;
    let generatedFile=null;
    let generatedHash='';
    let sourceSha='';
    let adoptedCount=0;
    let adoptedSignature='';
    let rows=[];
    let searchPage=1;
    let searchQuery='';

    function on(target,type,handler){
      if(!target||typeof target.addEventListener!=='function') return;
      target.addEventListener(type,handler);
      listeners.push([target,type,handler]);
    }
    function el(tag,props,...kids){
      const node=doc.createElement(tag);
      for(const [key,value] of Object.entries(props||{})){
        if(value==null||value===false) continue;
        if(key==='className'||key==='textContent'||key==='id'||key==='type'||key==='value'||key==='checked'||key==='hidden'||key==='disabled') node[key]=value;
        else node.setAttribute(key,String(value));
      }
      for(const kid of kids) if(kid!=null&&kid!==false) node.append(kid);
      return node;
    }
    function byId(id){return doc.getElementById(id);}
    function setText(id,text){const node=byId(id);if(node) node.textContent=text||'';}
    function setHidden(id,hidden){const node=byId(id);if(node) node.hidden=!!hidden;}
    function say(id,text){setText(id,text||'');}

    const host=el('section',{id:'booth',className:'booth',hidden:true,'aria-label':'부스 제출'});
    const resultLink=el('a',{id:'booth-result-link',href:'#booth-result',className:'button secondary',textContent:'결과 확인'});
    const head=el('div',{className:'booth-head'},
      el('span',{className:'step-code','aria-hidden':'true',textContent:'B'}),
      el('div',{},
        el('h2',{id:'booth-title',textContent:'부스 제출'}),
        el('p',{id:'booth-announce',className:'booth-announce',hidden:true}),
        el('p',{id:'booth-status',className:'form-feedback',role:'status','aria-live':'polite'})));
    head.append(resultLink);
    host.append(
      head,
      el('section',{id:'booth-missions','aria-label':'미션 논문'}),
      el('form',{id:'booth-search',className:'booth-search',hidden:true},
        el('label',{for:'booth-search-q'},'논문 검색',
          el('input',{id:'booth-search-q',type:'search',maxlength:'200',placeholder:'제목 또는 주제',autocomplete:'off'})),
        el('div',{className:'button-row'},
          el('button',{id:'booth-search-go',type:'submit',className:'button primary',textContent:'검색'})),
        el('p',{id:'booth-search-status',className:'form-feedback',role:'status','aria-live':'polite'}),
        el('div',{id:'booth-search-results'}),
        el('div',{id:'booth-search-pages',className:'button-row',hidden:true})),
      el('form',{id:'booth-submit',hidden:true},
        el('h3',{textContent:'수정본 제출'}),
        el('p',{className:'muted',textContent:'작업대에서 고친 뒤 수정본을 만들고, 변경마다 결함 유형과 이유를 적습니다. 이유 없이 제출할 수 없습니다.'}),
        el('div',{className:'button-row'},
          el('button',{id:'booth-make',type:'button',className:'button primary',textContent:'제출할 수정본 만들기'})),
        el('div',{id:'booth-rows'}),
        el('fieldset',{id:'booth-courses'},el('legend',{textContent:'코스'})),
        el('label',{for:'booth-nickname'},'별명 (선택, 이름·연락처는 적지 마세요)',
          el('input',{id:'booth-nickname',type:'text',maxlength:'24',autocomplete:'off',spellcheck:'false'})),
        el('label',{className:'check-row',for:'booth-consent'},
          el('input',{id:'booth-consent',type:'checkbox'}),
          el('span',{id:'booth-consent-copy',textContent:CONSENT_COPY})),
        el('div',{className:'button-row'},
          el('button',{id:'booth-submit-button',type:'submit',className:'button primary',textContent:'제출',disabled:true})),
        el('p',{id:'booth-submit-status',className:'form-feedback',role:'alert','aria-live':'polite'})),
      el('section',{id:'booth-receipt',className:'booth-receipt',hidden:true,'aria-label':'접수 확인'},
        el('p',{className:'booth-kicker',textContent:'접수번호'}),
        el('p',{id:'booth-receipt-code',className:'booth-key'}),
        el('p',{className:'booth-kicker',textContent:'확인키'}),
        el('p',{id:'booth-claim-code',className:'booth-key'}),
        el('div',{className:'button-row'},
          el('button',{id:'booth-copy',type:'button',className:'button primary',textContent:'접수번호와 확인키 복사'}),
          el('a',{id:'booth-receipt-result',href:'#booth-result',className:'button secondary',textContent:'결과 확인'})),
        el('p',{className:'muted',textContent:'확인키는 제출한 이 화면에서만 크게 보입니다. 이 브라우저에 최대 10건을 저장합니다.'})),
      el('section',{id:'booth-result',hidden:true,'aria-label':'제출 결과'},
        el('h2',{textContent:'제출 결과'}),
        el('form',{id:'booth-claim-form'},
          el('label',{for:'booth-claim-receipt'},'접수번호',
            el('input',{id:'booth-claim-receipt',type:'text',autocomplete:'off',spellcheck:'false',placeholder:'F-0042'})),
          el('label',{for:'booth-claim-key'},'확인키',
            el('input',{id:'booth-claim-key',type:'text',autocomplete:'off',spellcheck:'false',placeholder:'7Q3K-M9XD'})),
          el('div',{className:'button-row'},
            el('button',{type:'submit',className:'button primary',textContent:'결과 보기'}))),
        el('div',{id:'booth-result-body',hidden:true},
          el('p',{id:'booth-result-status',className:'booth-status-line'}),
          el('p',{id:'booth-result-outcome',className:'booth-status-line'}),
          el('p',{id:'booth-result-note'}),
          el('p',{id:'booth-result-prize',className:'booth-key',hidden:true}),
          el('div',{className:'button-row'},
            el('button',{id:'booth-withdraw',type:'button',className:'button secondary',textContent:'제출 철회'}),
            el('button',{id:'booth-withdraw-confirm',type:'button',className:'button primary',hidden:true,textContent:'철회를 확인합니다'}))),
        el('p',{id:'booth-result-error',className:'form-feedback error',role:'alert','aria-live':'polite'})));
    const main=doc.getElementById('main');
    const content=main&&typeof main.querySelector==='function'?main.querySelector('.content'):null;
    if(content&&typeof content.insertBefore==='function') content.insertBefore(host,content.firstChild||null);
    else if(doc.body&&typeof doc.body.append==='function') doc.body.append(host);

    function coded(code, data, status){
      const error=Error(code||'invalid_request');
      error.code=code||'invalid_request';
      error.status=status||0;
      error.receipt=data&&typeof data.receipt==='string'?data.receipt:'';
      return error;
    }
    async function responseBytes(res){
      if(res&&typeof res.arrayBuffer==='function') return new Uint8Array(await res.arrayBuffer());
      if(res&&typeof res.blob==='function'){
        const blob=await res.blob();
        if(blob&&typeof blob.arrayBuffer==='function') return new Uint8Array(await blob.arrayBuffer());
      }
      return new Uint8Array();
    }
    async function bearer(){
      const session=typeof sessionFn==='function'?sessionFn():sessionFn;
      if(!session||typeof session.token!=='function') return '';
      try{
        const value=await session.token();
        return typeof value==='string'&&/^[\x21-\x7e]{8,4096}$/.test(value)?value:'';
      }catch{return '';}
    }
    async function request(path, spec){
      const base=apiBaseOf(typeof configFn==='function'?configFn():config);
      if(!base||typeof fetchImpl!=='function') throw coded('network');
      const headers={Accept:'application/json'};
      let payload;
      if(spec.form) payload=spec.form;
      else if(spec.body!==undefined){
        headers['Content-Type']='application/json';
        payload=JSON.stringify(spec.body);
      }
      if(spec.auth){
        const token=await bearer();
        if(!token) throw coded('session_missing');
        headers.Authorization='Bearer '+token;
      }
      let res=null;
      try{
        res=await fetchImpl(base+path,{
          method:spec.method||'GET',headers,
          body:payload,
          credentials:'omit',cache:'no-store',redirect:'error'
        });
      }catch{throw coded('network');}
      if(spec.pdf){
        if(!res||!res.ok){
          let data=null;
          try{data=await res.json();}catch{data=null;}
          const status=res&&res.status||0;
          const fallback=status===413?'payload_too_large':status===403?'license_not_allowed':status===429?'rate_limited':'not_found';
          throw coded(errorCodeFrom(data)||fallback,data,status);
        }
        return {bytes:await responseBytes(res),headers:res.headers||{get(){return null;}}};
      }
      let data=null;
      try{data=await res.json();}catch{data=null;}
      if(!res||!res.ok){
        const status=res&&res.status||0;
        throw coded(errorCodeFrom(data)||(status===429?'rate_limited':'invalid_request'),data,status);
      }
      return data;
    }
    function showResult(force){
      const on=force===true||location.hash==='#booth-result';
      setHidden('booth-result',!on);
      if(!on) return;
      const node=byId('booth-result');
      if(node&&typeof node.scrollIntoView==='function') node.scrollIntoView({block:'start'});
    }
    function openResult(event){
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      try{location.hash='#booth-result';}catch{}
      prefillClaim();
      showResult(true);
    }
    function prefillClaim(){
      const latest=readReceipts(storage)[0];
      const receipt=byId('booth-claim-receipt');
      const key=byId('booth-claim-key');
      if(!latest||!receipt||!key) return;
      if(!receipt.value) receipt.value=latest.receipt;
      if(!key.value) key.value=latest.claimKey;
    }
    function typesOf(data){
      const list=data&&Array.isArray(data.defectTypes)?data.defectTypes:[];
      const clean=list.filter(item=>item&&typeof item.id==='string'&&typeof item.label==='string');
      return clean.length?clean:DEFECT_TYPES;
    }
    function coursesOf(data){
      const list=data&&Array.isArray(data.courses)?data.courses:[];
      const clean=list.filter(item=>item&&(item.id==='quick'||item.id==='deep')&&typeof item.label==='string');
      return clean.length?clean:COURSES;
    }
    function renderCourses(){
      const box=byId('booth-courses');
      if(!box) return;
      box.textContent='';
      box.append(el('legend',{textContent:'코스'}));
      const courses=coursesOf(liveConfig);
      if(!courses.some(item=>item.id===course)) course=courses[0].id;
      for(const item of courses){
        const input=el('input',{type:'radio',name:'booth-course',value:item.id,checked:item.id===course});
        input.addEventListener('change',()=>{if(input.checked) course=item.id;});
        box.append(el('label',{className:'booth-choice'},input,el('span',{textContent:item.label})));
      }
    }
    function submissionsOpen(){
      return !liveConfig||liveConfig.submissionsOpen!==false;
    }
    function refreshSubmitButton(){
      const button=byId('booth-submit-button');
      if(!button) return;
      const consent=byId('booth-consent');
      const ready=submissionsOpen()&&consent&&consent.checked&&rows.length>0&&!!generatedFile&&SHA256.test(generatedHash);
      button.disabled=!ready;
    }
    function renderRows(){
      const box=byId('booth-rows');
      if(!box) return;
      box.textContent='';
      const types=typesOf(liveConfig);
      for(const row of rows){
        const select=el('select',{'aria-label':'결함 유형'});
        select.append(el('option',{value:'',textContent:'유형 선택'}));
        for(const type of types) select.append(el('option',{value:type.id,textContent:type.label}));
        if(row.defectType) select.value=row.defectType;
        select.addEventListener('change',()=>{row.defectType=select.value;});
        row.defectType=select.value||'';
        const reason=el('textarea',{rows:'3',maxlength:String(limitsOf(liveConfig).maxReason),placeholder:'이 변경이 어떤 결함인지 적어 주세요'});
        reason.value=row.reason||'';
        reason.addEventListener('input',()=>{row.reason=reason.value;});
        const page=el('p',{className:'booth-page',textContent:(row.pageIndex+1)+'쪽'});
        const diff=el('div',{className:'booth-diff'},
          el('p',{},el('span',{className:'booth-diff-label',textContent:'변경 전'}),el('code',{textContent:row.before})),
          el('p',{},el('span',{className:'booth-diff-label',textContent:'변경 후'}),el('code',{textContent:row.after||'(삭제)'})));
        box.append(el('article',{className:'booth-card'},page,diff,
          el('label',{},'결함 유형',select),
          el('label',{},'이유',reason)));
        row.select=select;
        row.reasonInput=reason;
      }
      setHidden('booth-submit',!paper);
      refreshSubmitButton();
    }
    function pdfMagic(bytes){
      return !!bytes&&bytes.length>=5&&bytes[0]===0x25&&bytes[1]===0x50&&bytes[2]===0x44&&bytes[3]===0x46&&bytes[4]===0x2d;
    }
    async function digestHex(bytes){
      const subtle=cryptoApi&&cryptoApi.subtle;
      if(!subtle||typeof subtle.digest!=='function') return '';
      const view=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
      const digest=await subtle.digest('SHA-256', view);
      let hex='';
      for(const byte of new Uint8Array(digest)) hex+=byte.toString(16).padStart(2,'0');
      return SHA256.test(hex)?hex:'';
    }
    function workspace(){
      try{return root.FalsifyPaperWorkspace||null;}catch{return null;}
    }
    function enabledEdits(list){
      const edits=[];
      const source=Array.isArray(list)?list:[];
      for(const edit of source){
        if(!edit||typeof edit!=='object'||edit.enabled===false) continue;
        if(!Number.isSafeInteger(edit.pageIndex)||typeof edit.before!=='string'||typeof edit.after!=='string') continue;
        edits.push({
          pageIndex:edit.pageIndex,
          segmentId:typeof edit.segmentId==='string'?edit.segmentId:'',
          before:edit.before,after:edit.after,defectType:'',reason:''
        });
      }
      return edits;
    }
    /* Snapshot wins when the workspace is open. Otherwise the generation event's edits. */
    function editsFor(detail){
      const ws=workspace();
      if(ws&&typeof ws.getEditSnapshot==='function'){
        let snap=null;
        try{snap=ws.getEditSnapshot();}catch{snap=null;}
        if(snap&&Array.isArray(snap.edits)) return enabledEdits(snap.edits);
      }
      return enabledEdits(detail&&detail.edits);
    }
    function sourceHashOf(detail){
      const ws=workspace();
      let hash='';
      if(ws&&typeof ws.getSource==='function'){
        try{
          const source=ws.getSource();
          hash=source&&typeof source.fileHash==='string'?source.fileHash:'';
        }catch{hash='';}
      }
      if(!SHA256.test(hash)&&detail&&typeof detail.sourceFileHash==='string') hash=detail.sourceFileHash;
      return SHA256.test(hash)?hash:'';
    }
    function editSignature(edits){
      return edits.map(edit=>[edit.pageIndex,edit.segmentId,edit.before,edit.after].join('\u0000')).join('\u0001');
    }
    function showSubmitForm(){
      const form=byId('booth-submit');
      if(form&&typeof form.scrollIntoView==='function') form.scrollIntoView({block:'start'});
    }
    /* More than the declared cap is a visitor choice, not a silent slice. */
    function adoptRows(edits){
      const limits=limitsOf(liveConfig);
      adoptedCount=edits.length;
      adoptedSignature=editSignature(edits);
      if(edits.length>limits.maxDeclared){
        rows=[];
        say('booth-submit-status','켠 편집이 '+edits.length+'건입니다. 제출하려면 켠 편집을 '+limits.maxDeclared+'건 이하로 남겨 주세요.');
        renderRows();
        return;
      }
      if(!edits.length){
        rows=[];
        say('booth-submit-status','켠 편집이 없습니다. 바꿀 곳을 켠 뒤 다시 만들어 주세요.');
        renderRows();
        return;
      }
      rows=edits;
      say('booth-submit-status','');
      renderRows();
      showSubmitForm();
    }
    function clearGenerated(){
      generatedFile=null;
      generatedHash='';
      sourceSha='';
      adoptedCount=0;
      adoptedSignature='';
      rows=[];
    }
    async function adoptGenerated(detail){
      const file=detail&&detail.file;
      if(!file||typeof file.arrayBuffer!=='function'){
        say('booth-submit-status',errorMessage('invalid_pdf'));
        return;
      }
      let bytes=null;
      try{bytes=new Uint8Array(await file.arrayBuffer());}catch{bytes=null;}
      if(!pdfMagic(bytes)){
        clearGenerated();
        renderRows();
        say('booth-submit-status',errorMessage('invalid_pdf'));
        return;
      }
      const hash=await digestHex(bytes);
      if(!hash){
        clearGenerated();
        renderRows();
        say('booth-submit-status','수정본 PDF의 해시를 계산하지 못했습니다.');
        return;
      }
      sourceSha=sourceHashOf(detail);
      if(sourceSha&&sourceSha===hash){
        clearGenerated();
        renderRows();
        say('booth-submit-status',errorMessage('pdf_unchanged'));
        return;
      }
      generatedFile=file;
      generatedHash=hash;
      adoptRows(editsFor(detail));
    }
    async function makeSubmissionPdf(){
      if(!paper){say('booth-submit-status',PICK_PAPER);return;}
      const ws=workspace();
      let current=null;
      try{
        if(ws&&typeof ws.getCurrentOutput==='function') current=ws.getCurrentOutput();
        else if(ws&&typeof ws.getOutput==='function') current=ws.getOutput();
      }catch{current=null;}
      if(current&&current.file){
        await adoptGenerated({
          file:current.file,
          sourceFileHash:typeof current.originalSourceSha256==='string'?current.originalSourceSha256:'',
          revision:current.revision
        });
        return;
      }
      const button=doc.getElementById('paper-generate');
      if(!button){say('booth-submit-status','논문 작업대를 찾지 못했습니다.');return;}
      if(button.disabled){say('booth-submit-status','지금은 수정본을 만들 수 없습니다. 작업대에서 편집을 확인한 뒤 다시 눌러 주세요.');return;}
      say('booth-submit-status','수정본 PDF를 만들고 있습니다.');
      button.click();
    }
    function licenseId(paperLike){
      if(!paperLike||paperLike.license==null) return '';
      if(typeof paperLike.license==='string') return paperLike.license;
      return typeof paperLike.license.id==='string'?paperLike.license.id:'';
    }
    function bindPaper(next, file){
      const previous=boothFile;
      paper=next&&(next.source==='arxiv'||next.source==='mission')?{
        source:next.source,
        id:typeof next.id==='string'?next.id:'',
        title:typeof next.title==='string'?next.title:'',
        license:typeof next.license==='string'?next.license:''
      }:null;
      boothFile=file||null;
      if(previous!==boothFile) clearGenerated();
      setHidden('booth-submit',!paper);
      renderRows();
    }
    function clearPaper(){
      paper=null;
      boothFile=null;
      clearGenerated();
      renderRows();
    }
    async function openPdf(id, next, nameHint){
      const path=paperPdfPath(id);
      if(!path){say('booth-search-status',errorMessage('invalid_request'));return;}
      say('booth-search-status','논문을 불러오는 중…');
      let payload=null;
      try{payload=await request(path,{method:'GET',auth:true,pdf:true});}
      catch(error){say('booth-search-status',errorMessage(error.code,error));return;}
      const bytes=payload.bytes;
      if(!pdfMagic(bytes)){
        say('booth-search-status',errorMessage('invalid_request'));
        return;
      }
      const headerName=payload.headers&&typeof payload.headers.get==='function'?payload.headers.get('Content-Disposition'):'';
      const named=/filename="([^"]+)"/.exec(headerName||'');
      const name=named&&named[1]?named[1].slice(0,180):nameHint;
      const headerLicense=payload.headers&&typeof payload.headers.get==='function'?payload.headers.get('X-Falsify-Paper-License'):'';
      let file=null;
      try{file=new File([bytes],name||'arxiv.pdf',{type:'application/pdf'});}
      catch{say('booth-search-status','이 브라우저에서 논문 파일을 만들지 못했습니다.');return;}
      const input=doc.getElementById('paper-file');
      if(!input){say('booth-search-status','논문 입력을 찾지 못했습니다.');return;}
      try{
        const transfer=new DataTransfer();
        transfer.items.add(file);
        input.files=transfer.files;
      }catch{say('booth-search-status','논문 파일을 작업대에 넣지 못했습니다.');return;}
      const picked=next&&typeof next==='object'?Object.assign({},next):null;
      if(picked&&headerLicense) picked.license=headerLicense;
      bindPaper(picked,file);
      input.dispatchEvent(new Event('change',{bubbles:true}));
      if(typeof input.scrollIntoView==='function') input.scrollIntoView({block:'center'});
      say('booth-search-status','논문을 열었습니다. 작업대에서 고친 뒤 「제출할 수정본 만들기」를 누르세요.');
    }
    function startPaper(next, id){
      if(next.course==='quick'||next.course==='deep') course=next.course;
      renderCourses();
      void openPdf(id,next,'arxiv-'+String(id).replace(/[^\w.-]+/g,'_')+'.pdf');
    }
    function renderMissions(){
      const box=byId('booth-missions');
      if(!box||!liveConfig) return;
      box.textContent='';
      const missions=Array.isArray(liveConfig.missions)?liveConfig.missions:[];
      if(!missions.length){box.hidden=true;return;}
      box.hidden=false;
      box.append(el('h3',{textContent:'미션 논문'}));
      for(const mission of missions){
        if(!mission||typeof mission!=='object'||typeof mission.paperId!=='string') continue;
        const button=el('button',{type:'button',className:'button primary',textContent:'이 논문으로 시작'});
        button.addEventListener('click',()=>{
          startPaper({
            source:'mission',id:mission.paperId,title:typeof mission.title==='string'?mission.title:'',
            license:typeof mission.license==='string'?mission.license:'',course:mission.course
          },mission.paperId);
        });
        const meta=[mission.license,mission.course==='any'?'코스 선택':mission.course].filter(Boolean).join(' · ');
        box.append(el('article',{className:'booth-card'},
          el('h3',{textContent:mission.title||mission.paperId}),
          mission.hint?el('p',{textContent:mission.hint}):null,
          meta?el('p',{className:'muted',textContent:meta}):null,
          button));
      }
    }
    function renderSearch(payload){
      const box=byId('booth-search-results');
      const pages=byId('booth-search-pages');
      if(!box||!pages) return;
      box.textContent='';
      pages.textContent='';
      const list=payload&&Array.isArray(payload.results)?payload.results:[];
      if(!list.length){say('booth-search-status','검색 결과가 없습니다.');pages.hidden=true;return;}
      say('booth-search-status','');
      for(const item of list){
        if(!item||typeof item.id!=='string') continue;
        const button=el('button',{type:'button',className:'button primary',textContent:'이 논문으로 시작'});
        button.addEventListener('click',()=>{
          startPaper({source:'arxiv',id:item.id,title:typeof item.title==='string'?item.title:'',license:licenseId(item),course:'any'},item.id);
        });
        const authors=Array.isArray(item.authors)?item.authors.slice(0,6).join(', '):'';
        const meta=[authors,item.year,licenseId(item)].filter(value=>value!=null&&value!=='').join(' · ');
        box.append(el('article',{className:'booth-card'},
          el('h3',{textContent:item.title||item.id}),
          meta?el('p',{className:'muted',textContent:String(meta)}):null,
          button));
      }
      pages.hidden=searchPage<=1&&!(payload&&payload.hasMore);
      if(searchPage>1){
        const prev=el('button',{type:'button',className:'button secondary',textContent:'이전'});
        prev.addEventListener('click',()=>{searchPage-=1;void runSearch();});
        pages.append(prev);
      }
      if(payload&&payload.hasMore&&searchPage<5){
        const next=el('button',{type:'button',className:'button secondary',textContent:'다음'});
        next.addEventListener('click',()=>{searchPage+=1;void runSearch();});
        pages.append(next);
      }
    }
    async function runSearch(){
      const path=paperSearchPath(searchQuery,searchPage);
      if(!path){say('booth-search-status',errorMessage('invalid_request'));return;}
      say('booth-search-status','검색 중…');
      try{renderSearch(await request(path,{method:'GET',auth:true}));}
      catch(error){say('booth-search-status',errorMessage(error.code,error));}
    }
    function showReceipt(data, claimKey){
      setText('booth-receipt-code',data.receipt||'');
      setText('booth-claim-code',claimKey||'');
      setHidden('booth-claim-code',!claimKey);
      setHidden('booth-receipt',false);
      const node=byId('booth-receipt');
      if(node&&typeof node.scrollIntoView==='function') node.scrollIntoView({block:'center'});
    }
    async function submitBooth(event){
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      if(!submissionsOpen()){say('booth-submit-status',errorMessage('booth_closed'));return;}
      if(!paper){say('booth-submit-status',PICK_PAPER);refreshSubmitButton();return;}
      if(!generatedFile||!SHA256.test(generatedHash)){
        say('booth-submit-status','제출할 수정본이 없습니다. 「제출할 수정본 만들기」를 눌러 주세요.');
        refreshSubmitButton();
        return;
      }
      const live=editsFor(null);
      if(workspace()&&editSignature(live)!==adoptedSignature){
        say('booth-submit-status','편집이 바뀌었습니다. 「제출할 수정본 만들기」를 다시 눌러 주세요.');
        return;
      }
      const limits=limitsOf(liveConfig);
      if(live.length>limits.maxDeclared){
        adoptRows(live);
        return;
      }
      const paperPayload=Object.assign({},paper);
      if(sourceSha) paperPayload.sourceSha256=sourceSha;
      const built=buildSubmission({
        course,consent:!!(byId('booth-consent')&&byId('booth-consent').checked),
        consentVersion:liveConfig&&liveConfig.consentVersion||CONSENT_VERSION,
        rows:rows.map(row=>({
          pageIndex:row.pageIndex,segmentId:row.segmentId,before:row.before,after:row.after,
          defectType:row.select?row.select.value:row.defectType,
          reason:row.reasonInput?row.reasonInput.value:row.reason
        })),
        paper:paperPayload,nickname:byId('booth-nickname')?byId('booth-nickname').value:'',
        editedSha256:generatedHash,
        limits:liveConfig&&liveConfig.limits,defectTypes:typesOf(liveConfig).map(item=>item.id)
      });
      if(!built.ok){say('booth-submit-status',errorMessage(built.code));return;}
      const form=submissionForm(built.body,generatedFile);
      if(!form){say('booth-submit-status',errorMessage('invalid_request'));return;}
      const button=byId('booth-submit-button');
      if(button) button.disabled=true;
      say('booth-submit-status','제출하는 중…');
      try{
        const data=await request('/v1/booth/submissions',{method:'POST',auth:true,form});
        const claimKey=typeof data.claimKey==='string'?data.claimKey:'';
        if(data&&data.receipt&&claimKey){
          rememberReceipt(storage,{receipt:data.receipt,claimKey,createdAt:typeof data.createdAt==='string'?data.createdAt:new Date().toISOString()});
        }
        showReceipt(data,claimKey);
        say('booth-submit-status','제출했습니다. 확인키를 이 화면에서 확인해 두세요.');
      }catch(error){
        say('booth-submit-status',errorMessage(error.code,{receipt:error.receipt}));
        if(error.code==='already_submitted'&&error.receipt){
          const known=readReceipts(storage).find(item=>item.receipt===error.receipt);
          showReceipt({receipt:error.receipt},known?known.claimKey:'');
        }
        refreshSubmitButton();
      }
    }
    function renderClaim(data){
      setHidden('booth-result-body',false);
      setHidden('booth-withdraw-confirm',true);
      const status=STATUS_LABEL[data.status]||data.status||'';
      const courseLabel=data.course==='deep'?'정밀 코스':data.course==='quick'?'빠른 코스':'';
      setText('booth-result-status',[data.receipt,status,courseLabel,data.declaredCount!=null?data.declaredCount+'건':''].filter(Boolean).join(' · '));
      const outcome=data.published&&data.outcome?OUTCOME_LABEL[data.outcome]||data.outcome:'';
      setText('booth-result-outcome',outcome?('판정 '+outcome):'');
      setHidden('booth-result-outcome',!outcome);
      setText('booth-result-note',data.published&&typeof data.publicNote==='string'?data.publicNote:'');
      const prize=data.published&&typeof data.prizeMessage==='string'?data.prizeMessage:'';
      setText('booth-result-prize',prize);
      setHidden('booth-result-prize',!prize);
      const withdrawn=data.status==='withdrawn';
      setHidden('booth-withdraw',withdrawn);
      say('booth-result-error','');
    }
    async function lookup(event){
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      const receipt=normalizeReceipt(byId('booth-claim-receipt')?byId('booth-claim-receipt').value:'');
      const claimKey=normalizeClaimKey(byId('booth-claim-key')?byId('booth-claim-key').value:'');
      if(!receipt||!claimKey){say('booth-result-error',errorMessage('not_found'));return;}
      say('booth-result-error','');
      try{renderClaim(await request('/v1/booth/claim',{method:'POST',auth:false,body:{receipt,claimKey}}));}
      catch(error){say('booth-result-error',errorMessage(error.code,error));}
    }
    async function withdraw(){
      const receipt=normalizeReceipt(byId('booth-claim-receipt')?byId('booth-claim-receipt').value:'');
      const claimKey=normalizeClaimKey(byId('booth-claim-key')?byId('booth-claim-key').value:'');
      if(!receipt||!claimKey){say('booth-result-error',errorMessage('not_found'));return;}
      try{renderClaim(await request('/v1/booth/withdraw',{method:'POST',auth:false,body:{receipt,claimKey}}));}
      catch(error){say('booth-result-error',errorMessage(error.code,error));}
    }
    async function copyReceipt(){
      const text=[byId('booth-receipt-code')&&byId('booth-receipt-code').textContent,byId('booth-claim-code')&&byId('booth-claim-code').textContent].filter(Boolean).join('\n');
      try{
        if(root.navigator&&root.navigator.clipboard&&typeof root.navigator.clipboard.writeText==='function'){
          await root.navigator.clipboard.writeText(text);
          say('booth-status','접수번호와 확인키를 복사했습니다.');
          return;
        }
      }catch{}
      say('booth-status','복사하지 못했습니다. 접수번호와 확인키를 직접 적어 두세요.');
    }
    function applyConfig(data){
      liveConfig=data;
      host.hidden=false;
      setHidden('booth-search',false);
      const announcement=typeof data.announcement==='string'?data.announcement.trim():'';
      setText('booth-announce',announcement);
      setHidden('booth-announce',!announcement);
      if(!submissionsOpen()) say('booth-status',errorMessage('booth_closed'));
      renderMissions();
      renderCourses();
      refreshSubmitButton();
      prefillClaim();
      showResult(false);
    }
    async function loadConfig(){
      try{
        const data=await request('/v1/booth/config',{method:'GET',auth:false});
        if(closed) return;
        if(!data||data.enabled!==true){host.remove();return;}
        applyConfig(data);
      }catch{
        if(closed) return;
        host.hidden=false;
        say('booth-status','부스 접수를 확인하지 못했습니다.');
      }
    }
    on(byId('booth-search'),'submit',event=>{
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      const input=byId('booth-search-q');
      searchQuery=input?input.value:'';
      searchPage=1;
      void runSearch();
    });
    on(byId('booth-make'),'click',()=>{void makeSubmissionPdf();});
    on(byId('booth-submit'),'submit',event=>{void submitBooth(event);});
    on(byId('booth-consent'),'change',refreshSubmitButton);
    on(byId('booth-copy'),'click',()=>{void copyReceipt();});
    on(byId('booth-claim-form'),'submit',event=>{void lookup(event);});
    on(byId('booth-withdraw'),'click',()=>{setHidden('booth-withdraw-confirm',false);});
    on(byId('booth-withdraw-confirm'),'click',()=>{void withdraw();});
    on(resultLink,'click',openResult);
    on(byId('booth-receipt-result'),'click',openResult);
    on(doc,'falsify:paper-generated',event=>{void adoptGenerated(event&&event.detail);});
    on(doc,'falsify:document',event=>{
      const file=event&&event.detail&&event.detail.file;
      if(boothFile&&file===boothFile) return;
      clearPaper();
    });
    on(doc,'falsify:document-clear',clearPaper);
    on(root,'hashchange',()=>{showResult(false);});
    void loadConfig();
    return {destroy(){
      closed=true;
      for(const [target,type,handler] of listeners){
        if(target&&typeof target.removeEventListener==='function') target.removeEventListener(type,handler);
      }
      if(host.parentNode&&typeof host.remove==='function') host.remove();
    }};
  }

  if(boothConfigured(readConfig())) mount();
  root.FalsifyBooth={
    normalizeClaimKey,normalizeReceipt,buildSubmission,submissionForm,errorMessage,
    readReceipts,rememberReceipt,paperSearchPath,paperPdfPath,
    CONSENT_COPY,RECEIPT_KEY,RECEIPT_CAP,mount
  };
})(typeof window==='object'?window:globalThis);
