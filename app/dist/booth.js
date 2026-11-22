/* Event-page booth flow. Renders only when FalsifyCloudConfig.booth.enabled and
   GET /v1/booth/config reports enabled. Four steps, mirrored on
   document.documentElement.dataset.boothStep: pick (missions, search, my records),
   edit (the paper workspace), send (declare, consent, submit) and ticket (waiting,
   result or lookup). Declared reasons leave the browser only in the meta part of
   POST /v1/booth/submissions. The pdf part is the workspace file. Claim keys, the paper
   title and the changed pages are stored on this device, capped at 10; the ticket lists
   the newest 5. After submit the claim view is polled until the operator publishes. */
(function(root){
  'use strict';
  /* blind-pdf.js hands its one-time trust capability to the first caller. booth.js loads after it and
     claims it here, so no later page script can mark bytes as trusted. */
  const blindTrust=claimBlindTrust();
  function claimBlindTrust(){
    try{
      const blind=root.FalsifyBlindPdf;
      const claimed=blind&&typeof blind.claimTrust==='function'?blind.claimTrust():null;
      return typeof claimed==='function'?claimed:null;
    }catch{return null;}
  }
  const RECEIPT_KEY='falsify.booth.receipts.v1';
  const RECEIPT_CAP=10;
  const PICK_PAPER='미션이나 검색에서 논문을 골라 시작해 주세요';
  /* Sent when the visitor leaves 「왜 결함인가요」 empty; the server needs a non-empty reason. */
  const NO_REASON='설명 없음';
  const RECENT_CAP=5;
  const POLL_FAST_MS=15000;
  const POLL_SLOW_MS=30000;
  const POLL_FAST_UNTIL=180000;
  const POLL_STOP_AT=900000;
  const POLL_429_MS=60000;
  const PENDING_COPY='AI가 결함을 찾는 중이에요. 이 화면을 닫아도 접수번호와 확인키로 나중에 볼 수 있어요.';
  const POLL_STOP_COPY='자동 확인을 멈췄어요. 「결과 다시 보기」를 눌러 주세요.';
  const STEP_QUEUED='차례가 오면 AI가 앞뒤 문장과 표를 대조해요';
  const STEP_CHECKING='AI가 앞뒤 문장과 표를 대조하는 중';
  /* Headline as [plain lead, 600-weight phrase]. partial counts as found. */
  const HEADLINE={
    caught:['AI가 ','찾아냈어요'],partial:['AI가 ','근처를 짚었어요'],missed:['AI가 ','못 찾았어요'],
    invalid:['이번 도전은 ','무효로 끝났어요'],judged:['','결과가 나왔어요'],withdrawn:['제출을 ','철회했어요']
  };
  const STAMP={
    missed:{kind:'pass',word:'통과',latin:'PASSED'},
    caught:{kind:'fail',word:'적발',latin:'DETECTED'},
    partial:{kind:'fail',word:'적발',latin:'DETECTED'},
    invalid:{kind:'void',word:'무효',latin:'VOID'},
    excluded:{kind:'void',word:'판정 제외',latin:'EXCLUDED'},
    withdrawn:{kind:'void',word:'철회',latin:'WITHDRAWN'}
  };
  const PRE_EDIT_NOTICE='단순 오타나 문맥상 뜻이 같은 단어 교체는 통과로 인정되지 않을 수 있어요.';
  const HERO_COPY='공개 논문을 몰래 고쳐 보세요. AI가 결함을 찾아내는지 겨뤄요. 심은 결함 중 하나라도 AI가 놓치면 먼저 승리한 선착순 30분(1인 1회)께 부스에서 선물을 드려요.';
  const RULE_COPY='심은 결함 중 하나라도 AI가 놓치면 성공이에요. 현장 선물은 먼저 승리한 선착순 30분(1인 1회)께 드려요.';
  const GIFT_SUB_COPY='먼저 승리한 선착순 30분께 부스에서 드려요. 이 화면을 보여 주세요.';
  const GALLERY_CONSENT_LABEL='내가 바꾼 문장과 AI 판정을 행사 갤러리에 공개할게요 (선택)';
  const GALLERY_CONSENT_HINT='선택하지 않아도 도전·선물·래더보드 조건은 같아요. 본인 티켓에서 언제든 바꿀 수 있어요.';
  const ASSIST_LABELS={manual:'직접 수정','my-ai':'내 AI',agent:'에이전트'};
  const SOURCE_LABELS={mission:'추천 미션',arxiv:'외부 arXiv'};
  const ROUND_LABELS={live:'LIVE 판정',final:'FINAL 판정'};
  const STAFF_EXAMPLE_ENTRY=Object.freeze({
    example:true,
    paperKey:'2309.15217',
    paper:Object.freeze({
      id:'2309.15217v1',
      title:'Ragas: Automated Evaluation of Retrieval Augmented Generation',
      source:'mission',
      license:'cc-by-4.0'
    }),
    round:'live',
    outcome:'missed',
    assist:'manual',
    edits:Object.freeze([
      Object.freeze({
        index:0,
        pageIndex:4,
        defectType:'number',
        before:'Faithfulness achieves 0.95 agreement with human annotators in Table 1.',
        after:'Faithfulness achieves 0.50 agreement with human annotators in Table 1.',
        verdict:'caught',
        evidence:Object.freeze({
          quote:'Faithfulness achieves 0.50 agreement with human annotators in Table 1.',
          rationale:'본문의 결론 서술과 Table 1의 충실도 수치가 서로 맞지 않아요.',
          rationaleEn:'The modified Table 1 faithfulness figure (0.50) contradicts the surrounding conclusion.'
        })
      }),
      Object.freeze({
        index:1,
        pageIndex:5,
        defectType:'logic',
        before:'Our framework evaluates RAG pipelines without requiring ground-truth reference answers.',
        after:'Our framework evaluates RAG pipelines only when gold-standard reference answers are supplied.',
        verdict:'missed'
      })
    ])
  });
  const EDIT_VERDICTS={
    caught:{text:'AI가 찾음',kind:'caught'},
    partial:{text:'근처를 짚음',kind:'partial'},
    missed:{text:'AI가 놓침',kind:'missed'},
    excluded:{text:'판정 제외',kind:'excluded'}
  };
  const MISSION_CREDIT='미션 논문은 모두 arXiv에 CC BY 4.0으로 공개된 논문이에요. 부스에서 보는 결함은 방문자가 게임을 위해 심은 거예요.';
  const PARTIAL_SUB='결함 근처까지 짚으면 적발로 봐요.';
  const WITHDRAW_WARN='철회하면 되돌릴 수 없고, 선물과 추첨 기회도 함께 사라져요.';
  const CAPTURE_COPY='이 티켓을 캡처해 두세요. 화면을 닫아도 「내 기록」에서 접수번호와 확인키로 다시 볼 수 있어요.';
  const KIOSK_CAPTURE_COPY='접수번호와 확인키가 보이게 휴대폰으로 이 티켓을 찍어 두세요. 내 휴대폰의 「내 기록」에서 두 코드로 결과를 볼 수 있어요.';
  const PROJECT_URL='https://github.com/Pseudo-Lab/Falsify';
  const PROJECT_QR_SRC='falsify-project-qr.svg';
  const PROJECT_WAIT_COPY='기다리는 동안 가짜연구소 Falsify 프로젝트를 둘러보세요. 마음에 들면 GitHub에서 ★를 눌러 주세요.';
  const PROJECT_LINK_LABEL='GitHub에서 보기 ★';
  const PROJECT_QR_CAPTION='휴대폰 카메라로 찍으면 Falsify 프로젝트가 열려요.';
  const PROJECT_QR_ALT='가짜연구소 Falsify 프로젝트 GitHub QR 코드';
  const GENERIC_HINT='숫자, 결론 문장, 표 값 중 한 곳을 골라 티 나지 않게 바꿔 보세요.';
  const FINAL_COPY='현장 선착순 30명 선물과 별도로, 마감 후 더 정밀한 AI가 한 번 더 검증해요. 그때도 못 찾으면 최종 추첨 대상이에요.';
  /* Desktop layout (booth.css, min-width 1024px): the top bar's step indicator and the dock's edit chips. */
  const DESK_QUERY='(min-width:1024px)';
  const DESK_STEP={pick:1,edit:2,send:3,ticket:3};
  const DESK_STEPS=['논문 고르기','몰래 고치기','AI 검증'];
  const HOWTO=[['01','논문 고르기','미션 논문이나 공개 논문 하나'],['02','몰래 고치기','숫자, 문장, 결론 어디든 한 곳 이상'],['03','AI 검증','접수번호로 결과 확인']];
  const DOCK_CHIPS=3;
  const TIMED=['caught','partial','missed'];
  const CHIP_TEXT=14;
  const CAUGHT_TIP='숫자 하나만 바꾸면 AI가 앞뒤 문장과 대조해서 찾아내요. 결론 문장이나 실험 설계를 노려 보세요.';
  /* The only build failure allowed under R1: the browser PDF engine did not load (offline). */
  const ENGINE_UNAVAILABLE='수정본을 만드는 도구를 불러오지 못했어요. 인터넷 연결을 확인하고 「다시 시도」를 눌러 주세요.';
  const DIFF_CONTEXT=24;
  const TOKEN_GROW=40;
  const NOTE_PAGE=/\(AI가 짚은 곳:\s*(\d{1,5}|\?)쪽\)/;
  const NOTE_QUOTE=/^AI가 짚은 문장:\s*"(.*)"$/;
  const NOTE_OPINION=/^AI 설명:\s*(.*)$/;
  const NOTE_OPINION_EN=/^AI note:\s*(.*)$/;
  const CROCKFORD='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CONTROL=/[\u0000-\u001f\u007f]/;
  const SHA256=/^[0-9a-f]{64}$/;
  const ARXIV_ID=/^(?:\d{4}\.\d{4,5}(?:v\d{1,3})?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d{1,3})?)$/;
  const LICENSE_RE=/^(?:cc-by(?:-\d+\.\d+)?|cc-by-sa(?:-\d+\.\d+)?|cc0(?:-1\.0)?|public-domain)$/;
  const DEFECT_TYPES=[
    {id:'number',label:'수치·통계'},{id:'figure',label:'그림·표'},{id:'citation',label:'인용·출처'},
    {id:'logic',label:'논리·결론'},{id:'method',label:'방법·실험 설계'},{id:'other',label:'기타'}
  ];
  /* Session errors a new guest session can fix: retried once, then offered as 「다시 시도」. */
  const SESSION_CODES=new Set(['session_missing','unauthorized','length_required','forbidden']);
  const ERROR_TEXT={
    booth_closed:'지금은 접수 시간이 아니에요. 부스에서 운영 시간을 확인해 주세요.',
    consent_outdated:'부스 설정이 바뀌었어요. 「제출하기」를 다시 눌러 주세요.',
    job_not_ready:'수정본을 아직 만드는 중이에요. 끝나면 다시 제출해 주세요.',
    already_submitted:'이미 제출한 수정본이에요. 「내 기록」에서 결과를 볼 수 있어요.',
    rate_limited:'지금 요청이 몰려 있어요. 잠시 뒤 다시 시도해 주세요.',
    license_not_allowed:'이 논문은 라이선스 때문에 쓸 수 없어요. CC BY, CC BY-SA, CC0 논문을 골라 주세요.',
    payload_too_large:'논문 파일이 너무 커서 열지 못했어요. 다른 논문을 골라 주세요.',
    length_required:'파일 크기를 확인하지 못했어요. 「다시 시도」를 눌러 주세요.',
    storage_full:'오늘 접수 공간이 가득 찼어요. 부스 스태프에게 알려 주세요.',
    model_jobs_operator_only:'이 화면에서는 AI 검증을 바로 돌리지 않아요. 「AI에게 제출하기」로 보내 주세요.',
    not_found:'접수번호와 확인키를 다시 확인해 볼까요?',
    paper_not_allowed:'이 논문은 라이선스 때문에 제출할 수 없어요. CC BY, CC BY-SA, CC0 논문을 골라 주세요.',
    invalid_pdf:'수정본 PDF를 읽지 못했어요. 「다시 시도」를 눌러 주세요.',
    pdf_encrypted:'암호가 걸린 PDF라 열지 못했어요. 다른 논문을 골라 주세요.',
    pdf_corrupt:'PDF를 읽지 못했어요. 다른 논문을 골라 주세요.',
    pdf_empty_text:'편집할 텍스트가 없는 스캔 PDF예요. 다른 논문을 골라 주세요.',
    pdf_timeout:'논문을 여는 시간이 길어졌어요. 같은 논문을 눌러 다시 열어 보세요.',
    pdf_unreadable:'PDF를 열지 못했어요. 같은 논문을 눌러 다시 열어 보세요.',
    pdf_mismatch:'수정본이 중간에 바뀌었어요. 「다시 시도」를 눌러 주세요.',
    pdf_unchanged:'아직 원본과 같아요. 한 곳 이상 고친 뒤 「다음」을 눌러 주세요.',
    session_missing:'연결이 잠시 끊겼어요. 「다시 시도」를 누르면 새로 연결해요.',
    unauthorized:'연결이 잠시 끊겼어요. 「다시 시도」를 누르면 새로 연결해요.',
    invalid_request:'입력 내용을 확인해 주세요.',
    forbidden:'지금 연결로는 이 작업을 할 수 없어요. 「다시 시도」를 누르면 새로 연결해요.',
    leaderboard_forfeited:'래더보드를 먼저 열어 새 도전이 종료됐어요. 「내 기록」에서 이전 결과를 볼 수 있어요.',
    leaderboard_locked:'도전 기회를 모두 쓰거나 남은 기회를 포기하면 다른 사람의 결함을 볼 수 있어요.',
    paper_conquered:'다른 참가자가 이미 정복한 논문이에요. 다른 추천 논문에 도전해 보세요.',
    network:'서버에 연결하지 못했어요. 네트워크를 확인한 뒤 다시 시도해 주세요.',
    offline:'인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.'
  };

  /* 411/413 name the cap only when the booth config exposes it. Otherwise the generic size line stays. */
  let exposedPdfBytes=0;
  function sizeMb(code, extra){
    if(code!=='payload_too_large'&&code!=='length_required') return 0;
    const raw=extra&&extra.maxPdfBytes!=null?extra.maxPdfBytes:exposedPdfBytes;
    const n=Number(raw);
    if(!Number.isSafeInteger(n)||n<1048576||n>33554432) return 0;
    return Math.round(n/1048576);
  }
  function errorMessage(code, extra){
    const known=typeof code==='string'&&Object.prototype.hasOwnProperty.call(ERROR_TEXT,code)?code:'';
    if(known==='already_submitted'&&extra&&typeof extra.receipt==='string'&&/^F-\d{4,}$/.test(extra.receipt)){
      return '이미 제출한 수정본이에요. 접수번호 '+extra.receipt+'로 결과를 볼 수 있어요.';
    }
    const mb=sizeMb(known, extra);
    if(mb) return '수정본 PDF는 '+mb+'MB까지 제출할 수 있어요.';
    return known?ERROR_TEXT[known]:'처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.';
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
  /* A missing cap stays 5. A present safe integer from config replaces that 5. */
  function declaredCap(value){
    const n=Number(value);
    if(!Number.isSafeInteger(n)||n<1) return 5;
    return n;
  }
  function limitsOf(input){
    const limits=input&&input.limits&&typeof input.limits==='object'?input.limits:{};
    return {
      maxDeclared:declaredCap(limits.maxDeclared),
      maxReason:boundedInt(limits.maxReason,500,1,500),
      maxNickname:boundedInt(limits.maxNickname,24,1,24)
    };
  }
  function cleanText(value, max){
    if(typeof value!=='string') return null;
    if(CONTROL.test(value)||value.length>max) return null;
    return value;
  }
  /* Extracted PDF lines keep tab and newline. Other controls still cannot be declared. */
  function paperText(value){
    if(typeof value!=='string') return null;
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)||value.length>2000) return null;
    return value;
  }
  function trimCodePoints(text, max){
    const chars=[...text];
    if(chars.length<=max&&text.length<=max) return text;
    let out='';
    let count=0;
    for(const ch of chars){
      if(count>=max||out.length+ch.length>max) break;
      out+=ch;
      count+=1;
    }
    return out;
  }
  const PAPER_TITLE_MAX=300;
  function sanitizePaperTitle(value){
    if(typeof value!=='string') return '';
    const clean=value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
    return clean?trimCodePoints(clean,PAPER_TITLE_MAX).trim():'';
  }
  function sanitizeDeclaredText(value){
    const clean=String(value==null?'':value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
    return trimCodePoints(clean,2000);
  }
  function paperIdOf(paper){
    return cleanText(typeof paper.id==='string'?paper.id.trim():'',64);
  }
  function paperLicenseOf(paper){
    const raw=typeof paper.license==='object'&&paper.license?paper.license.id:paper.license;
    return cleanText(typeof raw==='string'?raw.trim().toLowerCase():'',40);
  }
  function paperTitleOf(paper){
    if(paper.title==null||paper.title==='') return '';
    if(typeof paper.title!=='string') return null;
    return sanitizePaperTitle(paper.title);
  }
  function paperShaOf(paper){
    return typeof paper.sourceSha256==='string'&&SHA256.test(paper.sourceSha256)?paper.sourceSha256:'';
  }
  /* Paper is required. source is arxiv or mission, and the license is one the booth allows. */
  function paperBody(paper){
    if(!paper||typeof paper!=='object') return null;
    if(paper.source!=='arxiv'&&paper.source!=='mission') return null;
    const id=paperIdOf(paper);
    if(!id) return null;
    const license=paperLicenseOf(paper);
    if(!license||!LICENSE_RE.test(license)) return null;
    const title=paperTitleOf(paper);
    if(title===null) return null;
    const body={source:paper.source,id};
    if(title) body.title=title;
    body.license=license;
    const sourceSha256=paperShaOf(paper);
    if(sourceSha256) body.sourceSha256=sourceSha256;
    return body;
  }
  function pageIndexOk(pageIndex){
    return Number.isSafeInteger(pageIndex)&&pageIndex>=0&&pageIndex<=9999;
  }
  /* The reason box is a textarea: Enter, tabs and other control characters become one space, so a typed
     line break or a multi-line 「내 AI에게」 reason never blocks submit. Empty means NO_REASON. */
  function declaredReason(value, max){
    const text=typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim():'';
    return trimCodePoints(text||NO_REASON,max);
  }
  function declaredTexts(row, limits){
    const before=paperText(row.before);
    const after=paperText(row.after);
    const reason=declaredReason(row.reason,limits.maxReason);
    if(before===null||after===null||!before) return null;
    return {before,after,reason};
  }
  function declaredSegment(row){
    if(row.segmentId==null||row.segmentId==='') return '';
    const segmentId=cleanText(row.segmentId,120);
    if(segmentId===null||!segmentId) return null;
    return segmentId;
  }
  function orderDeclared(item){
    const ordered={pageIndex:item.pageIndex};
    if(item.segmentId) ordered.segmentId=item.segmentId;
    ordered.before=item.before;
    ordered.after=item.after;
    ordered.defectType=item.defectType;
    ordered.reason=item.reason;
    return ordered;
  }
  function declaredItem(row, limits, types){
    if(!row||typeof row!=='object') return null;
    if(!pageIndexOk(row.pageIndex)) return null;
    const texts=declaredTexts(row, limits);
    if(!texts) return null;
    const defectType=types.includes(row.defectType)?row.defectType:(types.includes('other')?'other':types[0]);
    if(typeof defectType!=='string') return null;
    const segmentId=declaredSegment(row);
    if(segmentId===null) return null;
    return orderDeclared({
      pageIndex:row.pageIndex,before:texts.before,after:texts.after,
      defectType,reason:texts.reason,segmentId:segmentId||undefined
    });
  }
  function submissionSource(input){
    return input&&typeof input==='object'?input:{};
  }
  function rejectSubmission(code){
    return {ok:false,code};
  }
  function consentVersionOf(source){
    const consentVersion=typeof source.consentVersion==='string'?source.consentVersion:'';
    if(!consentVersion||consentVersion.length>80||CONTROL.test(consentVersion)) return '';
    return consentVersion;
  }
  function defectTypeIds(source){
    if(!Array.isArray(source.defectTypes)||!source.defectTypes.length) return DEFECT_TYPES.map(item=>item.id);
    return source.defectTypes.filter(id=>typeof id==='string');
  }
  function editedHashOf(source){
    return typeof source.editedSha256==='string'&&SHA256.test(source.editedSha256)?source.editedSha256:'';
  }
  function submissionRows(source, limits, types){
    const rows=Array.isArray(source.rows)?source.rows:[];
    if(rows.length<1||rows.length>limits.maxDeclared) return null;
    const declared=[];
    for(const row of rows){
      const item=declaredItem(row,limits,types);
      if(!item) return null;
      declared.push(item);
    }
    return declared;
  }
  /* Meta has no job id. editedSha256 is the lowercase SHA-256 of the PDF part. */
  function buildSubmission(input){
    const source=submissionSource(input);
    const limits=limitsOf(source);
    if(source.course!=='quick'&&source.course!=='deep') return rejectSubmission('invalid_request');
    const consentVersion=consentVersionOf(source);
    if(!consentVersion) return rejectSubmission('invalid_request');
    const declared=submissionRows(source,limits,defectTypeIds(source));
    if(!declared) return rejectSubmission('invalid_request');
    const paper=paperBody(source.paper);
    if(!paper) return rejectSubmission('paper_not_allowed');
    const editedSha256=editedHashOf(source);
    if(!editedSha256) return rejectSubmission('invalid_request');
    if(paper.sourceSha256&&paper.sourceSha256===editedSha256) return rejectSubmission('pdf_unchanged');
    const body={course:source.course,declared,paper};
    body.consentVersion=consentVersion;
    body.editedSha256=editedSha256;
    if(typeof source.galleryConsent==='boolean') body.galleryConsent=source.galleryConsent;
    return {ok:true,body};
  }
  function featuresOf(data){
    const raw=data&&data.features&&typeof data.features==='object'?data.features:{};
    return {gallery:raw.gallery===true,forfeit:raw.forfeit===true,paperBlock:raw.paperBlock===true};
  }
  function passRateText(missed, judged){
    const m=Number(missed);
    const j=Number(judged);
    if(!Number.isFinite(m)||!Number.isFinite(j)||j<=0) return '—';
    return Math.round(Math.max(0,Math.min(1,m/j))*100)+'%';
  }
  function defectLabel(id, types){
    const list=Array.isArray(types)&&types.length?types:DEFECT_TYPES;
    const hit=list.find(item=>item&&item.id===id);
    return hit&&hit.label?hit.label:(typeof id==='string'&&id?id:'기타');
  }
  /* The pdf part is always a File named edited.pdf. The visitor's download name stays local. */
  function editedPdfFile(file){
    if(!file||typeof file.arrayBuffer!=='function'||typeof File!=='function') return null;
    try{return new File([file],'edited.pdf',{type:'application/pdf'});}
    catch{return null;}
  }
  function submissionForm(body, file){
    if(!body||typeof body!=='object'||typeof FormData!=='function') return null;
    const pdf=editedPdfFile(file);
    if(!pdf) return null;
    const form=new FormData();
    form.append('meta', JSON.stringify(body));
    form.append('pdf', pdf);
    return form;
  }
  function isReceiptRecord(item){
    return !!item&&typeof item==='object'
      &&normalizeReceipt(item.receipt)===item.receipt
      &&normalizeClaimKey(item.claimKey)===item.claimKey
      &&typeof item.createdAt==='string'&&item.createdAt.length<=40;
  }
  const RECEIPT_EDITS_CAP=5;
  const RECEIPT_EDIT_MAX=2000;
  /* 1-based changed pages, unique and sorted, at most 20. */
  function receiptPages(value){
    if(!Array.isArray(value)) return [];
    const pages=value.filter(n=>Number.isSafeInteger(n)&&n>=1&&n<=10000);
    return [...new Set(pages)].sort((a,b)=>a-b).slice(0,20);
  }
  function receiptEdit(item){
    if(!item||typeof item!=='object') return null;
    if(!Number.isSafeInteger(item.page)||item.page<1||item.page>2000) return null;
    if(typeof item.before!=='string'||typeof item.after!=='string') return null;
    return {page:item.page,before:trimCodePoints(item.before,RECEIPT_EDIT_MAX),after:trimCodePoints(item.after,RECEIPT_EDIT_MAX)};
  }
  function receiptEdits(value){
    if(!Array.isArray(value)) return [];
    return value.map(receiptEdit).filter(Boolean).slice(0,RECEIPT_EDITS_CAP);
  }
  /* Required receipt, claimKey and createdAt. Paper title, pages, count, edits and last outcome are optional. */
  function receiptRecord(item){
    const out={receipt:item.receipt,claimKey:item.claimKey,createdAt:item.createdAt};
    const title=sanitizePaperTitle(item.title);
    if(title) out.title=title;
    const pages=receiptPages(item.pages);
    if(pages.length) out.pages=pages;
    if(Number.isSafeInteger(item.count)&&item.count>=1&&item.count<=100) out.count=item.count;
    const edits=receiptEdits(item.edits);
    if(edits.length) out.edits=edits;
    if(typeof item.outcome==='string'&&Object.prototype.hasOwnProperty.call(STAMP,item.outcome)) out.outcome=item.outcome;
    return out;
  }
  function readReceipts(storage){
    if(!storage||typeof storage.getItem!=='function') return [];
    let data=null;
    try{data=JSON.parse(storage.getItem(RECEIPT_KEY)||'');}catch{return [];}
    if(!Array.isArray(data)) return [];
    return data.filter(isReceiptRecord).slice(0,RECEIPT_CAP).map(receiptRecord);
  }
  function writeReceipts(storage, list){
    try{storage.setItem(RECEIPT_KEY,JSON.stringify(list));return true;}catch{return false;}
  }
  /* Remembers the last published outcome of a stored receipt without moving it. */
  function noteReceiptOutcome(storage, receipt, outcome){
    if(!storage||typeof storage.setItem!=='function') return false;
    if(!Object.prototype.hasOwnProperty.call(STAMP,outcome)) return false;
    const list=readReceipts(storage);
    const hit=list.find(item=>item.receipt===receipt);
    if(!hit||hit.outcome===outcome) return false;
    hit.outcome=outcome;
    return writeReceipts(storage,list);
  }
  function rememberReceipt(storage, record){
    const next=isReceiptRecord(record)?receiptRecord(record):null;
    if(!next||!storage||typeof storage.setItem!=='function') return readReceipts(storage);
    const kept=readReceipts(storage).filter(item=>item.receipt!==next.receipt);
    const capped=[next,...kept].slice(0,RECEIPT_CAP);
    if(!writeReceipts(storage,capped)) return readReceipts(storage);
    return capped;
  }
  function recentReceipts(storage){
    return readReceipts(storage).slice(0,RECENT_CAP);
  }
  /* 15 s for the first 3 min, then 30 s up to 15 min. A Retry-After wait only lengthens a step. -1 stops. */
  function nextPollDelay(elapsedMs, retryMs){
    const elapsed=Number(elapsedMs)>0?Number(elapsedMs):0;
    const base=elapsed<POLL_FAST_UNTIL?POLL_FAST_MS:POLL_SLOW_MS;
    const wait=Math.max(base,Number(retryMs)>0?Number(retryMs):0);
    return elapsed+wait<=POLL_STOP_AT?wait:-1;
  }
  /* Claim view queue {ahead, slots, etaSec} (cloud/api/src/booth.mjs queueView). Position only, no ETA. '' when nobody is ahead. */
  function queueLabel(queue){
    const q=queue&&typeof queue==='object'?queue:{};
    const ahead=Number.isSafeInteger(q.ahead)&&q.ahead>0&&q.ahead<=9999?q.ahead:0;
    return ahead?'AI 검증 차례를 기다리는 중 · 앞에 '+ahead+'건':'';
  }
  /* Delta seconds or an HTTP date. Anything else is 0, meaning no hint. */
  function retryAfterMs(value, nowMs){
    const text=typeof value==='string'?value.trim():'';
    if(!text) return 0;
    if(/^\d{1,7}$/.test(text)) return Math.min(Number(text)*1000,POLL_STOP_AT);
    const at=Date.parse(text);
    if(!Number.isFinite(at)) return 0;
    return Math.min(Math.max(at-Number(nowMs||0),0),POLL_STOP_AT);
  }
  function plainNote(value){
    return typeof value==='string'?value.slice(0,1000):'';
  }
  function publishedState(data){
    if(['caught','partial','missed','invalid'].includes(data.outcome)) return data.outcome;
    return data.status==='invalid'?'invalid':'judged';
  }
  function stampFor(state){
    return Object.prototype.hasOwnProperty.call(STAMP,state)?STAMP[state]:null;
  }
  function headlineView(state){
    const parts=HEADLINE[state];
    return {title:parts[0]+parts[1],lead:parts[0],strong:parts[1],stamp:stampFor(state)};
  }
  function cleanEvidenceText(value, max){
    if(typeof value!=='string') return '';
    return value.trim().slice(0,max);
  }
  /* Missed edits never carry evidence; caught/partial keep quote and KO/EN rationale; excluded keeps KO/EN rationale only. */
  function cleanEvidence(value, verdict){
    if((verdict!=='caught'&&verdict!=='partial'&&verdict!=='excluded')||!value||typeof value!=='object') return null;
    const quote=verdict==='excluded'?'':cleanEvidenceText(value.quote,500);
    const rationale=cleanEvidenceText(value.rationale,1000);
    const rationaleEn=cleanEvidenceText(value.rationaleEn,1000);
    if(!quote&&!rationale&&!rationaleEn) return null;
    if(verdict==='excluded'){
      const out={};
      if(rationale) out.rationale=rationale;
      if(rationaleEn) out.rationaleEn=rationaleEn;
      return out;
    }
    const out={quote,rationale};
    if(rationaleEn) out.rationaleEn=rationaleEn;
    return out;
  }
  function cleanEditResult(item){
    if(!item||typeof item!=='object') return null;
    if(!Number.isSafeInteger(item.index)||item.index<0) return null;
    const verdict=item.verdict===''?'missed':item.verdict;
    if(typeof verdict!=='string'||!Object.prototype.hasOwnProperty.call(EDIT_VERDICTS,verdict)) return null;
    const pageIndex=Number.isSafeInteger(item.pageIndex)&&item.pageIndex>=0&&item.pageIndex<=9999?item.pageIndex:null;
    const out={index:item.index,pageIndex,verdict};
    const evidence=cleanEvidence(item.evidence,verdict);
    if(evidence) out.evidence=evidence;
    return out;
  }
  /* One result per declared edit, or none: a short or duplicated list must not drive the count headline. */
  function cleanEditResults(value, declaredCount){
    if(!Array.isArray(value)) return [];
    const seen=new Set();
    const limit=Number.isSafeInteger(declaredCount)&&declaredCount>0?declaredCount:0;
    const out=value.map(cleanEditResult).filter(item=>item&&(!limit||item.index<limit)&&!seen.has(item.index)&&seen.add(item.index));
    if(limit&&out.length!==limit) return [];
    out.sort((a,b)=>a.index-b.index);
    return out;
  }
  function hasEditEvidence(results){
    return Array.isArray(results)&&results.some(item=>item&&(item.verdict==='caught'||item.verdict==='partial'||item.verdict==='excluded')&&!!item.evidence);
  }
  function excludedCountOf(results){
    return Array.isArray(results)?results.filter(item=>item&&item.verdict==='excluded').length:0;
  }
  function isAllExcluded(results){
    return Array.isArray(results)&&results.length>0&&excludedCountOf(results)===results.length;
  }
  const REDUNDANT_NOTES=new Set([
    '내가 심어 둔 결함을 AI가 찾았어요.',
    '내가 심어 둔 결함 근처를 AI가 짚었어요.'
  ]);
  function headlineParts(lead, strong, state){
    return {title:lead+strong,lead,strong,stamp:stampFor(state)};
  }
  function headlineFor(state, results){
    const list=Array.isArray(results)?results:[];
    const excluded=excludedCountOf(list);
    if(state==='invalid'&&excluded>0&&excluded===list.length){
      const lead=excluded===1?'이번 도전은 ':excluded+'개 모두 ';
      const strong='판정 제외예요';
      return {title:lead+strong,lead,strong,stamp:STAMP.excluded};
    }
    const eligible=list.filter(item=>item&&item.verdict!=='excluded');
    const n=eligible.length;
    if(n<=1) return headlineView(state);
    if(state==='caught'&&eligible.every(item=>item.verdict==='caught')){
      return headlineParts('AI가 ',n+'개를 모두 찾아냈어요',state);
    }
    if(state==='missed'){
      const missed=eligible.filter(item=>item.verdict==='missed').length;
      if(missed===n) return headlineParts('AI가 ',n+'개 모두 놓쳤어요',state);
      if(missed>0) return headlineParts(n+'개 중 '+missed+'개가 ','AI 눈을 피했어요',state);
    }
    return headlineView(state);
  }
  /* Visitor ticket for a claim view. Unpublished rows stay pending, so polling goes on.
     Any published prizeMessage becomes the gift ticket. */
  function resultView(input){
    const data=input&&typeof input==='object'?input:{};
    if(data.status==='withdrawn') return Object.assign({state:'withdrawn',note:'',prize:'',final:true},headlineView('withdrawn'));
    if(data.published!==true) return {state:'pending',title:PENDING_COPY,lead:'',strong:'',stamp:null,note:'',prize:'',final:false};
    const state=publishedState(data);
    const prize=typeof data.prizeMessage==='string'?data.prizeMessage.trim().slice(0,500):'';
    const rawResults=(TIMED.includes(state)||state==='invalid')?cleanEditResults(data.editResults,data.declaredCount):[];
    const editResults=state==='invalid'?(isAllExcluded(rawResults)?rawResults:[]):rawResults;
    const view=Object.assign({state,note:plainNote(data.publicNote),prize,final:true},headlineFor(state,editResults));
    if(editResults.length){
      view.editResults=editResults;
      const excluded=excludedCountOf(editResults);
      if(excluded>0){
        view.excludedCount=excluded;
        view.judgedCount=editResults.length-excluded;
      }
    }
    return view;
  }
  function noteLine(raw, out, rest){
    const line=raw.trim();
    const quote=NOTE_QUOTE.exec(line);
    if(quote){if(!out.quote) out.quote=quote[1].trim();return;}
    const opinion=NOTE_OPINION.exec(line);
    if(opinion){if(!out.opinion) out.opinion=opinion[1].trim();return;}
    const opinionEn=NOTE_OPINION_EN.exec(line);
    if(opinionEn){const text=opinionEn[1].trim();if(text&&!out.opinionEn) out.opinionEn=text;return;}
    const page=NOTE_PAGE.exec(line);
    if(page){
      if(!out.page&&page[1]!=='?') out.page=page[1];
      const left=(line.slice(0,page.index)+' '+line.slice(page.index+page[0].length)).replace(/\s+/g,' ').trim();
      if(left) rest.push(left);
      return;
    }
    if(line) rest.push(line);
  }
  /* Known CLI lines of tools/booth publicNote templates: "(AI가 짚은 곳: N쪽)",
     'AI가 짚은 문장: "…"' and "AI 설명: …". Everything else stays plain text. */
  function parsePublicNote(value){
    const out={page:'',quote:'',opinion:'',text:''};
    const rest=[];
    for(const line of plainNote(value).split('\n')) noteLine(line,out,rest);
    out.text=rest.join('\n');
    return out;
  }
  function commonPrefix(a, b){
    const max=Math.min(a.length,b.length);
    let n=0;
    while(n<max&&a[n]===b[n]) n+=1;
    return n;
  }
  function commonSuffix(a, b, prefix){
    const max=Math.min(a.length,b.length)-prefix;
    let n=0;
    while(n<max&&a[a.length-1-n]===b[b.length-1-n]) n+=1;
    return n;
  }
  function wordChar(ch){
    return typeof ch==='string'&&ch!==''&&!/\s/.test(ch);
  }
  /* Grows the changed region to whole words, so 0.95 → 0.50 reads as one token. */
  function widenPrefix(a, b, prefix){
    let n=prefix;
    let left=TOKEN_GROW;
    while(n>0&&left>0&&wordChar(a[n-1])&&(wordChar(a[n])||wordChar(b[n]))){n-=1;left-=1;}
    return n;
  }
  function widenSuffix(a, b, suffix){
    let n=suffix;
    let left=TOKEN_GROW;
    while(n>0&&left>0&&wordChar(a[a.length-n])&&(wordChar(a[a.length-n-1])||wordChar(b[b.length-n-1]))){n-=1;left-=1;}
    return n;
  }
  /* Only the changed region with a little context on each side. */
  function diffParts(before, after, context){
    const a=typeof before==='string'?before:'';
    const b=typeof after==='string'?after:'';
    const around=Number.isSafeInteger(context)&&context>=0?context:DIFF_CONTEXT;
    const prefix=widenPrefix(a,b,commonPrefix(a,b));
    const suffix=widenSuffix(a,b,Math.min(commonSuffix(a,b,prefix),a.length-prefix,b.length-prefix));
    const start=Math.max(0,prefix-around);
    const end=Math.min(a.length,a.length-suffix+around);
    return {
      lead:(start>0?'…':'')+a.slice(start,prefix),
      removed:a.slice(prefix,a.length-suffix),
      added:b.slice(prefix,b.length-suffix),
      tail:a.slice(a.length-suffix,end)+(end<a.length?'…':'')
    };
  }
  /* Chances left on this browser: the per-guest cap minus stored receipts, never below 0. */
  function chancesLeft(cap, used){
    const total=Number.isSafeInteger(cap)&&cap>0?cap:5;
    const count=Number.isSafeInteger(used)&&used>0?used:0;
    return Math.max(0,total-count);
  }
  function formatClock(ms){
    const total=Math.max(0,Math.floor((Number(ms)||0)/1000));
    return Math.floor(total/60)+':'+String(total%60).padStart(2,'0');
  }
  function formatDuration(ms){
    const n=Number(ms);
    if(!Number.isFinite(n)||n<0) return '';
    const total=Math.round(n/1000);
    const minutes=Math.floor(total/60);
    return minutes?minutes+'분'+(total%60?' '+(total%60)+'초':''):total+'초';
  }
  const LICENSE_NAMES={'cc-by-sa':'CC BY-SA','cc-by':'CC BY','cc0':'CC0','public-domain':'Public domain'};
  const LICENSE_PARSE=/^(cc-by-sa|cc-by|cc0|public-domain)(?:-(\d+\.\d+))?$/;
  function parseLicense(id){
    const raw=id&&typeof id==='object'?id.id:id;
    const text=typeof raw==='string'?raw.trim().toLowerCase():'';
    const match=LICENSE_PARSE.exec(text);
    if(!match) return null;
    if(match[1]==='public-domain'&&match[2]) return null;
    if(match[1]==='cc0'&&match[2]&&match[2]!=='1.0') return null;
    return {kind:match[1],version:match[2]||''};
  }
  function licenseLabel(id){
    const parsed=parseLicense(id);
    if(!parsed) return '';
    if(parsed.kind==='cc0') return 'CC0';
    const name=LICENSE_NAMES[parsed.kind];
    return parsed.version?name+' '+parsed.version:name;
  }
  function licenseUrl(id){
    const parsed=parseLicense(id);
    if(!parsed) return '';
    if(parsed.kind==='cc-by') return 'https://creativecommons.org/licenses/by/'+(parsed.version||'4.0')+'/';
    if(parsed.kind==='cc-by-sa') return 'https://creativecommons.org/licenses/by-sa/'+(parsed.version||'4.0')+'/';
    return 'https://creativecommons.org/publicdomain/zero/1.0/';
  }
  function arxivUrl(id){
    const text=typeof id==='string'?id.trim():'';
    return ARXIV_ID.test(text)?'https://arxiv.org/abs/'+text:'';
  }
  /* "Ragas: Automated…" reads as "Ragas" on the ticket. */
  function shortTitle(title){
    const text=typeof title==='string'?title.trim():'';
    const head=text.split(/:\s/)[0];
    return head.length>28?head.slice(0,27).trimEnd()+'…':head;
  }
  function capMessage(cap){
    return '기회 '+cap+'번을 모두 썼어요. 「내 기록」에서 결과를 볼 수 있어요.';
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
  function mountDocument(opts){
    const doc=opts.document||root.document;
    if(!doc||typeof doc.createElement!=='function'||typeof doc.getElementById!=='function') return null;
    if(doc.getElementById('booth')) return null;
    return doc;
  }
  function mountConfig(opts){
    const configFn=opts.config||readConfig;
    const config=typeof configFn==='function'?configFn():configFn;
    if(!boothConfigured(config)) return null;
    return {configFn,config};
  }
  function mountServices(opts){
    return {
      fetchImpl:opts.fetch||(typeof root.fetch==='function'?root.fetch.bind(root):null),
      cryptoApi:opts.crypto||root.crypto||null,
      storage:opts.storage||boothStorage(),
      sessionFn:opts.session||(()=>root.FalsifyHostedSession),
      location:opts.location||root.location||{hash:''},
      matchMedia:typeof opts.matchMedia==='function'?opts.matchMedia:(typeof root.matchMedia==='function'?root.matchMedia.bind(root):null),
      trustFetched:typeof opts.blindTrust==='function'?opts.blindTrust:blindTrust,
      browserPdf:opts.browserPdf||null,
      blindPdf:opts.blindPdf||null,
      editsStore:opts.edits||null,
      ...timerServices(opts)
    };
  }
  /* booth-runtime.js: the kiosk keeps receipts in sessionStorage. Without it, localStorage as before. */
  function runtime(){
    try{return root.FalsifyBoothRuntime||null;}catch{return null;}
  }
  function boothStorage(){
    const rt=runtime();
    return rt&&typeof rt.storage==='function'?rt.storage():root.localStorage;
  }
  /* A failed request while the browser reports no connection is 'offline', not network or session_missing. */
  function offlineCode(fallback){
    try{return root.navigator&&root.navigator.onLine===false?'offline':fallback;}catch{return fallback;}
  }
  function rootTimer(opts, name){
    if(typeof opts[name]==='function') return opts[name];
    return typeof root[name]==='function'?root[name].bind(root):null;
  }
  /* Poll timers and the ticket clock can be injected for tests. */
  function timerServices(opts){
    return {
      later:rootTimer(opts,'setTimeout'),
      cancel:rootTimer(opts,'clearTimeout'),
      now:typeof opts.now==='function'?opts.now:()=>Date.now(),
      every:rootTimer(opts,'setInterval'),
      stopEvery:rootTimer(opts,'clearInterval')
    };
  }
  function deskMedia(matchMedia){
    if(typeof matchMedia!=='function') return null;
    try{return matchMedia(DESK_QUERY)||null;}catch{return null;}
  }
  function mountContext(options){
    const opts=options&&typeof options==='object'?options:{};
    const doc=mountDocument(opts);
    if(!doc) return null;
    const configured=mountConfig(opts);
    if(!configured) return null;
    return {doc,...configured,...mountServices(opts)};
  }
  function placeBooth(doc, host){
    const main=doc.getElementById('main');
    const content=main&&typeof main.querySelector==='function'?main.querySelector('.content'):null;
    if(content&&typeof content.insertBefore==='function') content.insertBefore(host,content.firstChild||null);
    else if(doc.body&&typeof doc.body.append==='function') doc.body.append(host);
  }
  /* Event visitors cannot run BLUE. index.html has no booth.enabled, so this stays a no-op there. */
  function railBlue(doc){
    if(!doc||typeof doc.querySelector!=='function') return null;
    return doc.querySelector('.rail [data-view="blue"]');
  }
  function blueItem(button){
    if(!button||typeof button.closest!=='function') return null;
    return button.closest('li');
  }
  function setRailBlue(doc, hidden){
    const button=railBlue(doc);
    if(!button) return;
    button.hidden=!!hidden;
    const item=blueItem(button);
    if(item) item.hidden=!!hidden;
  }

  function mount(options){
    const ctx=mountContext(options);
    if(!ctx) return {destroy(){}};
    const doc=ctx.doc;
    const configFn=ctx.configFn;
    const config=ctx.config;
    const fetchImpl=ctx.fetchImpl;
    const cryptoApi=ctx.cryptoApi;
    const storage=ctx.storage;
    const sessionFn=ctx.sessionFn;
    const location=ctx.location;
    const later=ctx.later;
    const cancel=ctx.cancel;
    const now=ctx.now;
    const every=ctx.every;
    const stopEvery=ctx.stopEvery;
    const trustFetched=ctx.trustFetched;
    const deskQuery=deskMedia(ctx.matchMedia);
    let searchOpenedForDesk=false;
    let dockPopOpen=false;
    const listeners=[];
    const course='quick';
    let poll={token:0,timer:null,startedAt:0,receipt:'',claimKey:'',stopped:false,last:null};
    let waiting=false;
    const rt=runtime();
    const wake=rt&&typeof rt.wake==='function'?rt.wake(root.navigator):null;
    let closed=false;
    let liveConfig=null;
    let step='pick';
    let paper=null;
    let hint='';
    let boothFile=null;
    let openedPaper=null;
    let openedFile=null;
    let openedHash='';
    let ownOpen=false;
    let opening=false;
    let openFailure=null;
    let prefetched=null;
    let generatedFile=null;
    let generatedHash='';
    let sourceSha='';
    let adoptedSignature='';
    let rows=[];
    let searchPage=1;
    let searchQuery='';
    let making=null;
    let makeSeq=0;
    let ticket=null;
    let clock=null;
    let unsubEdits=null;
    let ownerState=null;
    let lbSummary=null;
    let lbEntries=[];
    let lbNextCursor=null;
    let lbFilter='all';
    let lbReturnStep='pick';
    let lbRoute=null;
    let lbLoading=false;
    let lbUnlocking=false;
    let consentSaving=false;

    function on(target,type,handler){
      if(!target||typeof target.addEventListener!=='function') return;
      target.addEventListener(type,handler);
      listeners.push([target,type,handler]);
    }
    const directProps=new Set(['className','textContent','id','type','value','checked','hidden','disabled']);
    function assignProp(node, key, value){
      if(value==null||value===false) return;
      if(directProps.has(key)) node[key]=value;
      else node.setAttribute(key,String(value));
    }
    function el(tag,props,...kids){
      const node=doc.createElement(tag);
      for(const [key,value] of Object.entries(props||{})) assignProp(node,key,value);
      for(const kid of kids) if(kid!=null&&kid!==false) node.append(kid);
      return node;
    }
    function svg(tag, attrs, ...kids){
      if(typeof doc.createElementNS!=='function') return null;
      const node=doc.createElementNS('http://www.w3.org/2000/svg',tag);
      for(const [key,value] of Object.entries(attrs||{})) node.setAttribute(key,String(value));
      for(const kid of kids) if(kid) node.append(kid);
      return node;
    }
    function byId(id){return doc.getElementById(id);}
    function setText(id,text){const node=byId(id);if(node) node.textContent=text||'';hideRetry(id);}
    function hideRetry(id){const retry=byId(id+'-retry');if(retry) retry.hidden=true;}
    /* booth-runtime.js adds 「다시 시도」 after the status line; the 'online' event presses it. */
    function offerRetry(id, error, run){
      if(!error||!rt||typeof rt.offerRetry!=='function') return;
      if(error.code==='offline') rt.offerRetry(doc,byId(id),run);
      else if(SESSION_CODES.has(error.code)) rt.offerRetry(doc,byId(id),()=>{dropSession();return run();});
    }
    /* A lost or refused guest session is minted again; the edits on the page stay as they are. */
    function dropSession(){
      try{
        const session=typeof sessionFn==='function'?sessionFn():sessionFn;
        if(session&&typeof session.invalidate==='function') session.invalidate();
      }catch{}
    }
    /* Submitting retries once by itself with a new session before it shows anything. */
    async function requestFresh(path, spec){
      try{return await request(path,spec);}
      catch(error){
        if(!error||!SESSION_CODES.has(error.code)) throw error;
        dropSession();
        return request(path,spec);
      }
    }
    function setHidden(id,hidden){const node=byId(id);if(node) node.hidden=!!hidden;}
    function setAttr(id,key,value){const node=byId(id);if(node&&typeof node.setAttribute==='function') node.setAttribute(key,value);}
    function say(id,text){setText(id,text||'');}
    function kidsOf(node, ...kids){
      if(!node) return;
      node.textContent='';
      for(const kid of kids) if(kid!=null&&kid!==false) node.append(kid);
    }

    /* Stamp ink texture. Hidden zero-size SVG, referenced from booth.css as url(#booth-ink). */
    function inkFilter(){
      return svg('svg',{width:'0',height:'0',class:'booth-defs','aria-hidden':'true',focusable:'false'},
        svg('filter',{id:'booth-ink'},
          svg('feTurbulence',{type:'fractalNoise',baseFrequency:'1.1',numOctaves:'2',seed:'7',result:'n'}),
          svg('feColorMatrix',{in:'n',type:'matrix',values:'0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.4 1.3',result:'m'}),
          svg('feComposite',{in:'SourceGraphic',in2:'m',operator:'in'})));
    }
    function mark(){
      return el('span',{className:'booth-mk','aria-hidden':'true',textContent:'F'});
    }
    function stepBar(backId, backText, label, done){
      const prog=el('div',{className:'booth-prog','aria-hidden':'true'});
      for(let i=1;i<=3;i+=1) prog.append(el('i',{className:i<=done?'on':''}));
      return el('div',{className:'booth-stepbar'},
        el('div',{className:'booth-stepbar-row'},
          el('button',{id:backId,type:'button',className:'booth-back',textContent:backText}),
          el('b',{textContent:label})),
        prog);
    }
    function field(id, label, props){
      return el('label',{for:id,className:'booth-field'},el('span',{className:'booth-klab',textContent:label}),
        el('input',Object.assign({id,type:'text',autocomplete:'off',spellcheck:'false'},props||{})));
    }
    function buildRecords(){
      return el('section',{id:'booth-result',className:'booth-records',hidden:true,'aria-label':'내 기록'},
        el('button',{id:'booth-records-back',type:'button',className:'booth-back',textContent:'← 처음으로'}),
        el('h2',{className:'booth-headline small'},'내 ',el('b',{textContent:'기록'})),
        el('p',{className:'booth-small',textContent:'접수번호와 확인키를 넣으면 도전 티켓을 다시 볼 수 있어요.'}),
        el('form',{id:'booth-claim-form',className:'booth-panel'},
          field('booth-claim-receipt','접수번호',{placeholder:'F-0042'}),
          field('booth-claim-key','확인키',{placeholder:'7Q3K-M9XD'}),
          el('button',{type:'submit',className:'booth-btn ink',textContent:'결과 보기'})),
        el('p',{id:'booth-result-error',className:'booth-feedback',role:'alert','aria-live':'polite'}),
        el('section',{id:'booth-receipts',className:'booth-receipts',hidden:true,'aria-label':'이 브라우저의 접수'},
          el('p',{className:'booth-klab',textContent:'이 브라우저의 접수'}),
          el('div',{id:'booth-receipts-list',className:'booth-hist'})));
    }
    function buildSearch(){
      return el('details',{id:'booth-search-box',className:'booth-more'},
        el('summary',{textContent:'다른 공개 논문 직접 찾기'}),
        el('form',{id:'booth-search',className:'booth-search',hidden:true},
          el('label',{for:'booth-search-q',className:'booth-field'},el('span',{className:'booth-klab',textContent:'논문 검색 · CC BY, CC BY-SA, CC0만'}),
            el('input',{id:'booth-search-q',type:'search',maxlength:'200',placeholder:'영어 제목 또는 주제',autocomplete:'off'})),
          el('button',{id:'booth-search-go',type:'submit',className:'booth-btn line',textContent:'검색'}),
          el('p',{id:'booth-search-status',className:'booth-feedback',role:'status','aria-live':'polite'}),
          el('div',{id:'booth-search-results',className:'booth-search-results'}),
          el('div',{id:'booth-search-pages',className:'booth-row',hidden:true})));
    }
    function buildLeaderboard(){
      return el('section',{id:'booth-leaderboard',className:'booth-lb',hidden:true,'aria-label':'래더보드'},
        el('div',{className:'booth-lb-head'},
          el('button',{id:'booth-lb-back',type:'button',className:'booth-back',textContent:'← 처음으로'}),
          el('h2',{id:'booth-lb-heading',className:'booth-headline small',tabindex:'-1'},'오늘의 ',el('b',{textContent:'래더보드'}))),
        el('p',{id:'booth-lb-status',className:'booth-feedback',role:'status','aria-live':'polite'}),
        el('section',{id:'booth-lb-summary',className:'booth-lb-summary',hidden:true,'aria-label':'오늘의 집계'}),
        el('section',{id:'booth-lb-mine',className:'booth-panel booth-lb-mine',hidden:true,'aria-label':'내가 만든 결함'}),
        el('section',{id:'booth-lb-gate',className:'booth-panel booth-lb-gate',hidden:true,'aria-label':'다른 사람 결함 열람 확인'},
          el('p',{className:'booth-lab',textContent:'GALLERY ACCESS'}),
          el('h3',{id:'booth-lb-gate-title',className:'booth-lb-gate-title'}),
          el('p',{id:'booth-lb-gate-copy',className:'booth-copy'}),
          el('p',{id:'booth-lb-gate-error',className:'booth-feedback',role:'alert','aria-live':'polite'}),
          el('div',{className:'booth-row booth-lb-gate-actions'},
            el('button',{id:'booth-lb-unlock-cancel',type:'button',className:'booth-btn line',textContent:'취소'}),
            el('button',{id:'booth-lb-unlock-go',type:'button',className:'booth-btn ink',hidden:true,textContent:'결함 갤러리 열기'}))),
        el('section',{id:'booth-lb-feed',className:'booth-lb-feed',hidden:true,'aria-label':'다른 사람 결함 갤러리'},
          el('div',{className:'booth-lb-feed-head'},
            el('p',{id:'booth-lb-feed-label',className:'booth-klab',textContent:'다른 사람들의 결함'}),
            el('p',{id:'booth-lb-example-note',className:'booth-small',hidden:true,textContent:'아직 공개 선택된 참가자 사례가 없어 운영진 예시를 먼저 보여 드려요. 통계에는 포함되지 않아요.'})),
          el('div',{id:'booth-lb-filters',className:'booth-chips',role:'group','aria-label':'결함 필터'}),
          el('div',{id:'booth-lb-list',className:'booth-lb-list'}),
          el('button',{id:'booth-lb-more',type:'button',className:'booth-btn line wide',hidden:true,textContent:'더 보기'})));
    }
    /* Desktop top bar: mark, name, the three-step indicator and 내 기록. Phones keep the per-step bars. */
    function buildDeskBar(){
      const steps=el('ol',{id:'booth-desk-steps',className:'booth-desk-steps','aria-label':'도전 단계'});
      DESK_STEPS.forEach((text,index)=>{
        steps.append(el('li',{id:'booth-desk-step-'+(index+1)},el('em',{textContent:String(index+1)}),text));
      });
      return el('header',{id:'booth-deskbar',className:'booth-deskbar booth-desk'},mark(),
        el('span',{className:'booth-nm'},'Falsify',el('small',{textContent:'AI REVIEW CHALLENGE'})),
        steps,
        el('a',{id:'booth-desk-leaderboard',href:'#booth-leaderboard',className:'booth-desk-rec',hidden:true}),
        el('a',{id:'booth-desk-records',href:'#booth-result',className:'booth-desk-rec',textContent:'내 기록'}));
    }
    function howtoItem(item){
      return el('li',{},el('em',{textContent:item[0]}),el('span',{},el('b',{textContent:item[1]}),el('span',{textContent:item[2]})));
    }
    /* Two wrappers (display:contents on phones) give the desktop its 440px intro and the mission column. */
    function buildPick(){
      const top=el('header',{className:'booth-top'},mark(),
        el('span',{className:'booth-nm',textContent:'Falsify'}),
        el('a',{id:'booth-result-link',href:'#booth-result',className:'booth-toplink',textContent:'내 기록'}));
      const landing=el('div',{id:'booth-landing',className:'booth-landing'},
        el('div',{className:'booth-landing-intro'},
          el('div',{className:'booth-hero'},
            el('p',{className:'booth-lab'},el('span',{className:'booth-phone',textContent:'AI REVIEW CHALLENGE'}),el('span',{className:'booth-desk',textContent:'AWS Community Day · Booth'})),
            el('h2',{id:'booth-title',className:'booth-headline hero'},'AI를 ',el('b',{textContent:'속일 수'}),el('br'),'있을까요?'),
            el('p',{className:'booth-copy',textContent:HERO_COPY})),
          el('p',{id:'booth-pick-limit',className:'booth-small'}),
          el('ol',{id:'booth-howto',className:'booth-howto','aria-label':'도전 순서'},...HOWTO.map(howtoItem)),
          el('div',{id:'booth-lb-teaser',className:'booth-lb-teaser',hidden:true},
            el('p',{id:'booth-lb-teaser-stats',className:'booth-small',hidden:true}),
            el('button',{id:'booth-pick-leaderboard',type:'button',className:'booth-btn line wide',textContent:'래더보드 · 다른 사람 결함 보기'}))),
        el('div',{className:'booth-landing-list'},
          el('p',{id:'booth-announce',className:'booth-announce',hidden:true}),
          el('p',{id:'booth-status',className:'booth-feedback',role:'status','aria-live':'polite'}),
          el('div',{id:'booth-mission-head',className:'booth-mhead booth-desk',hidden:true},
            el('span',{id:'booth-mission-count',className:'booth-klab'}),
            el('span',{className:'booth-small',textContent:'티켓을 누르면 힌트 쪽이 열려요'})),
          el('section',{id:'booth-missions',className:'booth-missions','aria-label':'미션 논문'}),
          el('p',{id:'booth-mission-status',className:'booth-feedback',role:'status','aria-live':'polite'}),
          el('p',{id:'booth-mission-credit',className:'booth-small',textContent:MISSION_CREDIT}),
          buildSearch()));
      return el('div',{id:'booth-step-pick',className:'booth-step'},top,landing,buildRecords(),buildLeaderboard());
    }
    function buildEdit(){
      return el('div',{id:'booth-step-edit',className:'booth-step',hidden:true},
        stepBar('booth-edit-back','← 논문 고르기','2 / 3 몰래 고치기',2),
        el('p',{id:'booth-paper-credit',className:'booth-credit',hidden:true}),
        el('p',{id:'booth-hint',className:'booth-hint'}),
        el('p',{id:'booth-edit-notice',className:'booth-small booth-edit-notice',textContent:PRE_EDIT_NOTICE}),
        el('div',{id:'booth-dock',className:'booth-dock'},
          el('p',{id:'booth-dock-status',className:'booth-dock-status',role:'status','aria-live':'polite'}),
          el('div',{id:'booth-dock-fix',className:'booth-dock-fix',hidden:true}),
          el('div',{className:'booth-dock-count'},
            el('button',{id:'booth-dock-count',type:'button',className:'booth-dock-count-btn',textContent:'고친 곳 0개','aria-expanded':'false','aria-controls':'booth-dock-pop'}),
            el('small',{id:'booth-dock-sub',textContent:'여러 곳을 고쳐도 돼요'})),
          el('div',{id:'booth-dock-chips',className:'booth-dock-chips booth-desk','aria-label':'고친 곳 목록'}),
          el('ul',{id:'booth-dock-pop',className:'booth-dock-pop',hidden:true,'aria-label':'고친 곳 전체'}),
          el('button',{id:'booth-dock-back',type:'button',className:'booth-back booth-dock-back booth-desk',textContent:'← 논문 고르기'}),
          el('button',{id:'booth-next',type:'button',className:'booth-btn ink',textContent:'다음',disabled:true})));
    }
    function sendFact(label, id){
      return el('div',{},el('p',{className:'booth-klab',textContent:label}),el('p',{id,className:'booth-val'}));
    }
    /* Phones read one column. On desktop the left column declares and the right one is a sticky
       SUBMISSION ticket that holds the submit button itself (ids stay unique). */
    function buildSend(){
      return el('form',{id:'booth-submit',className:'booth-step booth-send',hidden:true,novalidate:'novalidate'},
        el('div',{className:'booth-send-main'},
          stepBar('booth-send-back','← 고치기','3 / 3 AI에게 제출',3),
          el('div',{className:'booth-send-head booth-desk'},
            el('h2',{className:'booth-headline'},'숨긴 결함을 ',el('b',{textContent:'확인해요'}))),
          el('div',{id:'booth-rows',className:'booth-rows'})),
        el('div',{id:'booth-send-ticket',className:'booth-send-side'},
          el('div',{className:'booth-sec booth-desk'},
            el('p',{className:'booth-lab',textContent:'Submission'}),
            sendFact('논문','booth-send-paper'),
            el('div',{className:'booth-send-facts'},sendFact('고친 곳','booth-send-count'),sendFact('남은 기회','booth-send-chances'))),
          el('div',{className:'booth-cut booth-desk','aria-hidden':'true'}),
          el('div',{className:'booth-sec booth-send-confirm'},
            el('p',{id:'booth-send-rule',className:'booth-small booth-rule',textContent:RULE_COPY}),
            el('div',{id:'booth-gallery-consent-wrap',className:'booth-consent-opt-box',hidden:true},
              el('label',{for:'booth-gallery-consent',className:'booth-consent-opt'},
                el('input',{id:'booth-gallery-consent',type:'checkbox'}),
                el('span',{textContent:GALLERY_CONSENT_LABEL})),
              el('p',{className:'booth-small',textContent:GALLERY_CONSENT_HINT})),
            el('button',{id:'booth-submit-button',type:'submit',className:'booth-btn ink wide',textContent:'AI에게 제출하기',disabled:true}),
            el('p',{id:'booth-submit-status',className:'booth-feedback',role:'alert','aria-live':'polite'}),
            el('button',{id:'booth-submit-records',type:'button',className:'booth-btn line wide',hidden:true,textContent:'내 기록 보기'}))));
    }
    function cell(label, id, className, noTranslate){
      const ddProps=noTranslate?{id,className,translate:'no'}:{id,className};
      return el('div',{id:id+'-cell',className:'booth-cell'},
        el('dt',{className:'booth-klab',textContent:label}),
        el('dd',ddProps));
    }
    function buildReviewTicket(){
      return el('article',{id:'booth-ticket',className:'booth-tk booth-tk-v','data-state':'pending','aria-label':'AI 검증 티켓'},
        el('div',{className:'booth-sec'},
          el('p',{className:'booth-lab',textContent:'FALSIFY · AI REVIEW TICKET'}),
          el('dl',{className:'booth-grid2'},
            cell('접수번호','booth-receipt-code','booth-code',true),
            cell('확인키','booth-claim-code','booth-code',true),
            cell('논문','booth-ticket-paper','booth-val'),
            cell('고친 곳','booth-ticket-pages','booth-val'),
            cell('검증 시간','booth-ticket-duration','booth-val')),
          el('button',{id:'booth-copy',type:'button',className:'booth-btn line slim',textContent:'접수번호와 확인키 복사'}),
          el('p',{id:'booth-copy-status',className:'booth-small',role:'status','aria-live':'polite'})),
        el('div',{className:'booth-cut','aria-hidden':'true'}),
        el('div',{id:'booth-ticket-wait',className:'booth-sec'},
          el('div',{className:'booth-status-row'},
            el('b',{id:'booth-ticket-state',textContent:'AI가 논문을 읽는 중'}),
            el('span',{id:'booth-ticket-elapsed',className:'booth-elapsed',textContent:'0:00'})),
          el('div',{className:'booth-track','aria-hidden':'true'},el('i')),
          el('div',{id:'booth-ticket-stub',className:'booth-bp-stub'},
            el('div',{className:'booth-desk'},
              el('p',{className:'booth-klab',textContent:'AWS Community Day'}),
              el('p',{id:'booth-stub-date',className:'booth-val'})),
            el('canvas',{id:'booth-barcode',className:'booth-barcode','aria-hidden':'true',translate:'no',height:'34'}),
            el('p',{id:'booth-stub-receipt',className:'booth-code booth-desk',translate:'no'}))),
        el('div',{id:'booth-ticket-result',className:'booth-sec booth-res',hidden:true},
          el('div',{},
            el('p',{className:'booth-klab',textContent:'AI 검증 결과'}),
            el('p',{id:'booth-ticket-date',className:'booth-small'})),
          el('div',{id:'booth-stamp',className:'booth-stamp','aria-hidden':'true'},
            el('b',{id:'booth-stamp-word'}),
            el('span',{id:'booth-stamp-latin'}))));
    }
    function buildProgress(){
      return el('ol',{id:'booth-ticket-steps',className:'booth-list'},
        el('li',{className:'done'},el('i'),'수정본 받음'),
        el('li',{className:'now'},el('i'),el('span',{id:'booth-step-check',textContent:STEP_CHECKING})),
        el('li',{className:'wait'},el('i'),'결과'));
    }
    function isKiosk(){
      try{if(rt&&typeof rt.kiosk==='function'&&rt.kiosk()) return true;}catch{}
      return !!(doc.documentElement&&doc.documentElement.dataset&&doc.documentElement.dataset.kiosk==='1');
    }
    function buildProjectWait(){
      const copy=el('p',{id:'booth-project-copy',className:'booth-small',textContent:PROJECT_WAIT_COPY});
      if(isKiosk()){
        return el('aside',{id:'booth-project-wait',className:'booth-panel booth-project-wait is-kiosk','aria-label':'Falsify 프로젝트'},
          el('div',{className:'booth-project-text'},
            copy,
            el('p',{id:'booth-project-qr-caption',className:'booth-small',textContent:PROJECT_QR_CAPTION})),
          el('img',{id:'booth-project-qr',className:'booth-project-qr',src:PROJECT_QR_SRC,width:'120',height:'120',alt:PROJECT_QR_ALT}));
      }
      return el('aside',{id:'booth-project-wait',className:'booth-panel booth-project-wait','aria-label':'Falsify 프로젝트'},
        copy,
        el('a',{id:'booth-project-link',className:'booth-btn line slim booth-project-link',href:PROJECT_URL,target:'_blank',rel:'noopener noreferrer',textContent:PROJECT_LINK_LABEL}));
    }
    function buildGift(){
      return el('article',{id:'booth-gift',className:'booth-tk booth-tk-v booth-gift',hidden:true,'aria-label':'교환권'},
        el('div',{className:'booth-sec booth-gift-sec'},
          el('div',{},
            el('p',{className:'booth-klab',textContent:'교환권 · 1인 1회'}),
            el('p',{id:'booth-live-prize',className:'booth-gift-text'}),
            el('p',{className:'booth-small',textContent:GIFT_SUB_COPY})),
          el('span',{className:'booth-code booth-gift-code','aria-hidden':'true',translate:'no',textContent:'GIFT'})));
    }
    function buildFinal(){
      return el('section',{id:'booth-final',className:'booth-panel booth-final',hidden:true,'aria-label':'최종 추첨'},
        el('p',{className:'booth-klab',textContent:'최종 추첨'}),
        el('p',{className:'booth-txt',textContent:FINAL_COPY}));
    }
    function buildWithdraw(){
      return el('details',{id:'booth-withdraw-box',className:'booth-more booth-quiet'},
        el('summary',{textContent:'제출 철회'}),
        el('div',{className:'booth-withdraw-body'},
          el('p',{className:'booth-small',textContent:'철회하면 서버의 수정본 PDF·설명·결과를 바로 지워요. 이미 AI 검증에 보낸 사본은 모델 제공자에게서 회수할 수 없어요.'}),
          el('button',{id:'booth-withdraw',type:'button',className:'booth-btn line',textContent:'이 제출 철회하기'}),
          el('div',{id:'booth-withdraw-ask',className:'booth-withdraw-ask',hidden:true},
            el('p',{className:'booth-withdraw-warn',textContent:WITHDRAW_WARN}),
            el('div',{className:'booth-row'},
              el('button',{id:'booth-withdraw-cancel',type:'button',className:'booth-btn line',textContent:'취소'}),
              el('button',{id:'booth-withdraw-confirm',type:'button',className:'booth-btn line danger',textContent:'철회하기'})))));
    }
    function buildTicket(){
      return el('section',{id:'booth-receipt',className:'booth-step booth-ticket-step',hidden:true,'aria-label':'도전 티켓'},
        el('header',{className:'booth-top'},mark(),
          el('span',{className:'booth-nm',textContent:'도전 티켓'}),
          el('span',{id:'booth-chances-top',className:'booth-toplabel'})),
        buildReviewTicket(),
        el('div',{id:'booth-live',className:'booth-live','data-state':'pending'},
          buildProgress(),
          el('p',{id:'booth-live-capture',className:'booth-small',textContent:isKiosk()?KIOSK_CAPTURE_COPY:CAPTURE_COPY}),
          buildProjectWait(),
          el('div',{id:'booth-verdict',className:'booth-verdict',hidden:true},
            el('h2',{id:'booth-live-title',className:'booth-headline',role:'status','aria-live':'polite'}),
            el('p',{id:'booth-live-sub',className:'booth-copy',hidden:true}),
            el('p',{id:'booth-live-excluded',className:'booth-small',hidden:true}),
            el('p',{id:'booth-live-rule',className:'booth-small booth-rule',hidden:true,textContent:RULE_COPY}),
            el('p',{id:'booth-live-page',className:'booth-mono-meta',hidden:true})),
          el('div',{className:'booth-live-side'},buildGift(),buildFinal()),
          el('div',{className:'booth-live-main'},
            el('div',{id:'booth-live-note',className:'booth-panel booth-note',hidden:true}),
            el('section',{id:'booth-live-findings',className:'booth-panel booth-findings',hidden:true,'aria-label':'항목별 AI 검증 결과'}),
            el('section',{id:'booth-live-declared',className:'booth-panel booth-declared',hidden:true,'aria-label':'내가 고친 곳'}),
            el('section',{id:'booth-ticket-consent',className:'booth-panel booth-ticket-consent',hidden:true,'aria-label':'행사 갤러리 공개'},
              el('p',{className:'booth-klab',textContent:'행사 갤러리 공개'}),
              el('label',{for:'booth-ticket-consent-input',className:'booth-consent-opt'},
                el('input',{id:'booth-ticket-consent-input',type:'checkbox'}),
                el('span',{textContent:GALLERY_CONSENT_LABEL})),
              el('p',{className:'booth-small',textContent:GALLERY_CONSENT_HINT}),
              el('p',{id:'booth-ticket-consent-status',className:'booth-feedback',role:'status','aria-live':'polite'})),
            el('p',{id:'booth-live-tip',className:'booth-small',hidden:true,textContent:CAUGHT_TIP}),
            el('p',{id:'booth-live-error',className:'booth-feedback',role:'alert',hidden:true}),
            el('button',{id:'booth-live-recheck',type:'button',className:'booth-btn line wide',hidden:true,textContent:'결과 다시 보기'}),
            el('div',{className:'booth-live-actions'},
              el('button',{id:'booth-live-again',type:'button',className:'booth-btn ink wide',hidden:true,textContent:'다시 도전하기'}),
              el('button',{id:'booth-live-leaderboard',type:'button',className:'booth-btn line wide',hidden:true,textContent:'래더보드 · 다른 사람 결함 보기'}),
              el('button',{id:'booth-live-records',type:'button',className:'booth-btn line booth-desk',hidden:true,textContent:'내 기록'})),
            el('div',{id:'booth-history',className:'booth-hist',hidden:true,'aria-label':'이 브라우저의 도전 기록'}),
            buildWithdraw())));
    }

    const host=el('section',{id:'booth',className:'booth',hidden:true,'aria-label':'부스 도전'});
    host.append(...[inkFilter(),buildDeskBar(),buildPick(),buildEdit(),buildSend(),buildTicket()].filter(Boolean));
    placeBooth(doc, host);
    setRailBlue(doc, true);

    function coded(code, data, status, retryMs){
      const error=Error(code||'invalid_request');
      error.code=code||'invalid_request';
      error.status=status||0;
      error.retryAfter=retryMs||0;
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
    function requestBase(){
      return apiBaseOf(typeof configFn==='function'?configFn():config);
    }
    function requestPayload(spec, headers){
      if(spec.form) return spec.form;
      if(spec.body===undefined) return undefined;
      headers['Content-Type']='application/json';
      return JSON.stringify(spec.body);
    }
    async function requestAuth(spec, headers){
      if(!spec.auth) return;
      const token=await bearer();
      if(!token) throw coded(offlineCode('session_missing'));
      headers.Authorization='Bearer '+token;
    }
    function pdfFallback(status){
      if(status===413) return 'payload_too_large';
      if(status===403) return 'license_not_allowed';
      if(status===429) return 'rate_limited';
      return 'not_found';
    }
    function statusOf(res){
      return res&&res.status||0;
    }
    async function readJson(res){
      try{return await res.json();}catch{return null;}
    }
    async function pdfResult(res){
      if(res&&res.ok) return {bytes:await responseBytes(res),headers:res.headers||{get(){return null;}}};
      const data=await readJson(res);
      const status=statusOf(res);
      throw coded(errorCodeFrom(data)||pdfFallback(status),data,status);
    }
    async function jsonResult(res){
      const data=await readJson(res);
      if(res&&res.ok) return data;
      const status=statusOf(res);
      const fallback=status===429?'rate_limited':'invalid_request';
      const retry=status===429?retryAfterMs(headerValue(res.headers,'Retry-After'),now()):0;
      throw coded(errorCodeFrom(data)||fallback,data,status,retry);
    }
    async function request(path, spec){
      const base=requestBase();
      if(!base||typeof fetchImpl!=='function') throw coded('network');
      const headers={Accept:'application/json'};
      const payload=requestPayload(spec, headers);
      await requestAuth(spec, headers);
      let res=null;
      try{
        res=await fetchImpl(base+path,{
          method:spec.method||'GET',headers,
          body:payload,signal:spec.signal,
          credentials:'omit',cache:'no-store',redirect:'error'
        });
      }catch{throw coded(offlineCode('network'));}
      if(spec.pdf) return pdfResult(res);
      return jsonResult(res);
    }
    function galleryEnabled(){
      return featuresOf(liveConfig).gallery;
    }
    function forfeitEnabled(){
      return featuresOf(liveConfig).forfeit;
    }
    function isGalleryConsentChecked(){
      const box=byId('booth-gallery-consent');
      return !!(box&&box.checked===true);
    }
    function resetGalleryConsentBox(){
      const box=byId('booth-gallery-consent');
      if(box) box.checked=false;
    }
    function leaderboardHash(){
      return /^#booth-leaderboard(?:\/|$)/.test(location.hash);
    }
    function linkedPaper(){
      const raw=location.hash.slice('#booth-leaderboard/'.length);
      try{return decodeURIComponent(raw);}catch{return raw;}
    }
    function leaveResultHash(){
      try{if(location.hash==='#booth-result'||leaderboardHash()) location.hash='#booth';}catch{}
    }
    function showRecords(visible){
      setHidden('booth-result',!visible);
      if(visible) setHidden('booth-leaderboard',true);
      setHidden('booth-landing',!!visible);
      if(!visible) return;
      prefillClaim();
      renderReceipts();
    }
    /* #booth-result is "내 기록" inside the pick step. */
    function showResult(force){
      const visible=force===true||location.hash==='#booth-result';
      if(visible&&step!=='pick') setStep('pick');
      if(step==='pick') showRecords(visible);
    }
    function openResult(event){
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      try{location.hash='#booth-result';}catch{}
      showResult(true);
    }
    function closeRecords(){
      leaveResultHash();
      showRecords(false);
      say('booth-result-error','');
    }
    function syncHashView(){
      if(leaderboardHash()&&galleryEnabled()){
        showLeaderboardView(true);
        return;
      }
      lbRoute=null;
      if(location.hash==='#booth-result'){
        showResult(true);
        return;
      }
      if(step==='pick'){
        setHidden('booth-result',true);
        setHidden('booth-leaderboard',true);
        setHidden('booth-landing',false);
      }
    }
    function cleanCountPair(pair){
      const j=summaryCount(pair?.judged);
      const m=summaryCount(pair?.missed);
      return {judged:j,missed:Math.min(m,j)};
    }
    function statTile(label, value, sub){
      return el('div',{className:'booth-lb-kpi'},
        el('p',{className:'booth-klab',textContent:label}),
        el('p',{className:'booth-lb-kpi-val',textContent:value}),
        sub?el('p',{className:'booth-small',textContent:sub}):null);
    }
    function rateBarRow(label, pair){
      const p=cleanCountPair(pair);
      const pct=p.judged>0?Math.round((p.missed/p.judged)*100):0;
      const fill=el('i',{className:'booth-lb-bar-fill'});
      if(fill&&fill.style) fill.style.width=pct+'%';
      return el('div',{className:'booth-lb-bar-row'},
        el('div',{className:'booth-lb-bar-head'},
          el('span',{className:'booth-lb-bar-name',textContent:label}),
          el('span',{className:'booth-mono-meta',textContent:passRateText(p.missed,p.judged)+' ('+p.missed+'/'+p.judged+')'})),
        el('div',{className:'booth-lb-bar-track','aria-hidden':'true'},fill));
    }
    function rateGroup(title, map, labelFor){
      if(!map||typeof map!=='object') return null;
      const entries=Object.entries(map).filter(([,val])=>val&&typeof val==='object'&&Number(val.judged)>0);
      if(!entries.length) return null;
      return el('div',{className:'booth-panel booth-lb-group'},
        el('p',{className:'booth-klab',textContent:title}),
        ...entries.map(([key,val])=>rateBarRow(labelFor(key),val)));
    }
    function conqueredSection(papers){
      const list=Array.isArray(papers)?papers.filter(item=>item&&typeof item==='object'&&typeof item.paperKey==='string'):[];
      const items=list.length
        ? list.map(item=>{
            const link=item.hasPublicDefect===true;
            const props={className:'booth-lb-conq-chip'};
            if(link) props.href='#booth-leaderboard/'+encodeURIComponent(item.paperKey);
            return el(link?'a':'span',props,
              el('b',{translate:'no',textContent:shortTitle(item.title||item.paperKey)}),
              el('small',{translate:'no',textContent:'arXiv '+item.paperKey}),
              el('span',{textContent:link?'정복 결함 보기 →':'공개된 정복 결함 없음'}));
          })
        : [el('p',{className:'booth-small',textContent:'아직 정복된 논문이 없어요. 첫 정복자가 되어 보세요.'})];
      return el('div',{className:'booth-panel booth-lb-conq'},
        el('p',{className:'booth-klab',textContent:'정복된 논문'}),
        el('div',{className:'booth-lb-conq-list'},...items));
    }
    function summaryCount(value){
      return Number.isSafeInteger(value)&&value>=0?value:0;
    }
    function renderLeaderboardSummary(){
      const teaser=byId('booth-lb-teaser-stats');
      const box=byId('booth-lb-summary');
      if(!lbSummary||typeof lbSummary!=='object'){
        if(teaser){teaser.textContent='';teaser.hidden=true;}
        if(box){kidsOf(box);box.hidden=true;}
        return;
      }
      const judged=summaryCount(lbSummary.judged);
      const missed=summaryCount(lbSummary.missed);
      const pending=summaryCount(lbSummary.pending);
      const conquered=summaryCount(lbSummary.conqueredCount);
      if(teaser){
        teaser.textContent='정복 '+conquered+'편 · 판정 '+judged+'건 · LIVE 통과율 '+passRateText(missed,judged);
        teaser.hidden=false;
      }
      if(!box||lbRoute?.paper) return;
      const types=typesOf(liveConfig);
      const groups=[
        rateGroup('논문 출처별 LIVE 통과율',lbSummary.bySource,k=>SOURCE_LABELS[k]||k),
        rateGroup('결함 유형별 LIVE 통과율',lbSummary.byDefectType,k=>defectLabel(k,types)),
        rateGroup('수정 방식별 LIVE 통과율',lbSummary.byAssist,k=>ASSIST_LABELS[k]||k)
      ].filter(Boolean);
      const kpis=el('div',{className:'booth-lb-kpis'},
        statTile('LIVE 통과율',passRateText(missed,judged),missed+' / '+judged+'건'),
        statTile('정복된 논문',conquered+'편',''),
        statTile('판정 완료',judged+'건',''),
        statTile('검증 대기',pending+'건',''));
      kidsOf(box,kpis,groups.length?el('div',{className:'booth-lb-groups'},...groups):null,conqueredSection(lbSummary.conqueredPapers));
      box.hidden=false;
    }
    async function loadLeaderboardSummary(){
      if(!galleryEnabled()||closed) return;
      try{
        const data=await request('/v1/booth/leaderboard/summary',{method:'GET',auth:false});
        if(closed||!data||typeof data!=='object') return;
        lbSummary=data;
        renderLeaderboardSummary();
        return data;
      }catch{/* summary is independent and never blocks pick or submit */}
    }
    function myReceiptTitles(){
      const set=new Set();
      for(const item of readReceipts(storage)){
        if(item.outcome==='withdrawn') continue;
        if(item.title) set.add(item.title);
        if(item.title) set.add(shortTitle(item.title));
      }
      return set;
    }
    function renderLeaderboardMine(){
      const box=byId('booth-lb-mine');
      if(!box) return;
      const list=readReceipts(storage);
      if(!list.length){kidsOf(box);box.hidden=true;return;}
      const cards=list.map(item=>{
        const stamp=stampFor(item.outcome);
        const head=el('div',{className:'booth-lb-mine-head'},
          el('span',{className:'booth-mono-meta',translate:'no',textContent:[item.receipt,shortTitle(item.title)].filter(Boolean).join(' · ')}),
          el('span',{className:'booth-lb-pill '+(stamp?stamp.kind:'wait'),textContent:stamp?stamp.word:'판정 대기'}));
        const edits=Array.isArray(item.edits)&&item.edits.length
          ? item.edits.slice(0,RECEIPT_EDITS_CAP).map((ed,idx)=>el('div',{className:'booth-lb-mine-edit'},
              el('p',{className:'booth-klab',textContent:editLabel(idx,ed.page,item.edits.length)}),
              diffNode(ed)))
          : [];
        const openBtn=el('button',{type:'button',className:'booth-btn line slim',textContent:'티켓 보기'});
        openBtn.addEventListener('click',()=>{fillClaim(item);void lookupRecord(item.receipt,item.claimKey);});
        return el('article',{className:'booth-lb-mine-item'},head,...edits,openBtn);
      });
      kidsOf(box,el('p',{className:'booth-klab',textContent:'내가 만든 결함'}),...cards);
      box.hidden=false;
    }
    function ownerStateFrom(data){
      const raw=data&&data.ownerState&&typeof data.ownerState==='object'?data.ownerState:null;
      if(!raw) return {used:usedTries(),perOwner:perOwnerCap(),unlocked:false};
      const perOwner=declaredCap(raw.perOwner!=null?raw.perOwner:(data&&data.limits&&data.limits.perOwner));
      const used=Number.isSafeInteger(raw.used)&&raw.used>=0?raw.used:usedTries();
      return {used,perOwner,unlocked:raw.unlocked===true};
    }
    function renderLeaderboardGate(){
      const gate=byId('booth-lb-gate');
      const go=byId('booth-lb-unlock-go');
      const cancelBtn=byId('booth-lb-unlock-cancel');
      if(!gate||!go) return;
      say('booth-lb-gate-error','');
      const st=ownerState||{used:usedTries(),perOwner:perOwnerCap(),unlocked:false};
      const left=chancesLeft(st.perOwner,st.used);
      if(left>0&&forfeitEnabled()){
        setText('booth-lb-gate-title','다른 사람의 결함을 지금 볼까요?');
        setText('booth-lb-gate-copy','지금 열면 남은 도전 기회 '+left+'번과 철회 후 재도전 기회를 포함해 새 도전이 종료돼요. 이미 제출해 검증 중인 건과 선물 수령은 그대로 유지돼요.');
        go.textContent='기회 '+left+'번 포기하고 보기';
        go.hidden=false;
        go.disabled=lbUnlocking;
        if(cancelBtn) cancelBtn.textContent='취소';
      }else if(left>0){
        setText('booth-lb-gate-title','도전을 마친 뒤 열 수 있어요');
        setText('booth-lb-gate-copy','도전 기회 '+st.perOwner+'번을 모두 쓰면 다른 사람의 결함을 볼 수 있어요. 지금은 기회 '+left+'번이 남아 있어요.');
        go.hidden=true;
        if(cancelBtn) cancelBtn.textContent='돌아가기';
      }else{
        setText('booth-lb-gate-title','도전 기회를 모두 썼어요');
        setText('booth-lb-gate-copy','다른 사람의 결함을 열람하면, 이후 기존 제출을 철회하더라도 새 도전은 할 수 없어요. 이미 제출한 티켓과 선물은 그대로 유지돼요.');
        go.textContent='결함 갤러리 열기';
        go.hidden=false;
        go.disabled=lbUnlocking;
        if(cancelBtn) cancelBtn.textContent='취소';
      }
      gate.hidden=false;
      setHidden('booth-lb-feed',true);
    }
    function entryMatchesMine(entry, titles){
      if(!titles.size||!entry||!entry.paper) return false;
      const t=sanitizePaperTitle(entry.paper.title||'');
      return !!(t&&(titles.has(t)||titles.has(shortTitle(t))));
    }
    function galleryEditNode(edit, idx, total, types){
      const page=Number.isSafeInteger(edit.pageIndex)&&edit.pageIndex>=0?edit.pageIndex+1:null;
      const label=editLabel(Number.isSafeInteger(edit.index)?edit.index:idx,page,lbRoute?.paper?Math.max(total,edit.index+1):total);
      const dtype=edit.defectType?el('span',{className:'booth-lb-dtype',textContent:defectLabel(edit.defectType,types)}):null;
      const verdict=typeof edit.verdict==='string'?edit.verdict:'';
      const badge=verdictBadge(verdict);
      const head=el('div',{className:'booth-declared-head'},
        el('span',{className:'booth-lb-edit-meta'},el('span',{className:'booth-klab',textContent:label}),dtype),
        badge);
      const ev=cleanEvidence(edit.evidence,verdict);
      const evNode=ev?evidenceBlock({verdict,evidence:ev}):null;
      return el('div',{className:'booth-declared-item'},head,diffNode({before:edit.before||'',after:edit.after||''}),evNode);
    }
    function galleryPaperCredit(entry,p){
      const id=typeof p.id==='string'&&p.id?p.id:(typeof entry.paperKey==='string'?entry.paperKey:'');
      const url=arxivUrl(id);
      const lic=licenseId(p);
      const label=licenseLabel(lic);
      const lUrl=licenseUrl(lic);
      const parts=[];
      if(url) parts.push(extLink(url,'arXiv '+id));
      else if(id) parts.push(el('span',{translate:'no',textContent:'arXiv '+id}));
      if(label) parts.push(' · ',lUrl?extLink(lUrl,label):label);
      return parts.length?el('p',{className:'booth-credit',translate:'no'},...parts):null;
    }
    function galleryBadges(entry,isMine,edits){
      const list=Array.isArray(edits)?edits:[];
      const excluded=excludedCountOf(list);
      const judged=list.length-excluded;
      const stamp=entry.outcome==='invalid'&&isAllExcluded(list)?STAMP.excluded:stampFor(entry.outcome);
      const roundText=entry.round==='final'?ROUND_LABELS.final:ROUND_LABELS.live;
      const assistText=ASSIST_LABELS[entry.assist]||'';
      return el('div',{className:'booth-lb-badges'},
        entry.example===true?el('span',{className:'booth-lb-pill example',textContent:'운영진 예시'}):null,
        isMine?el('span',{className:'booth-lb-pill mine',textContent:'내가 도전한 논문'}):null,
        stamp?el('span',{className:'booth-lb-pill '+stamp.kind,textContent:stamp.word}):null,
        el('span',{className:'booth-lb-pill round',textContent:roundText}),
        assistText?el('span',{className:'booth-lb-pill assist',textContent:assistText}):null,
        judged>0&&excluded>0?el('span',{className:'booth-lb-pill wait',textContent:'판정 대상 '+judged+'곳 · 판정 제외 '+excluded+'곳'}):null);
    }
    function galleryCard(entry,types,isMine){
      const p=entry.paper&&typeof entry.paper==='object'?entry.paper:{};
      const title=sanitizePaperTitle(p.title||'')||p.id||entry.paperKey||'';
      const edits=(Array.isArray(entry.edits)?entry.edits:[]).slice(0,5);
      return el('article',{className:'booth-panel booth-lb-card'+(entry.example===true?' is-example':'')},
        galleryBadges(entry,isMine,edits),
        title?el('h3',{className:'booth-lb-card-title',translate:'no',textContent:title}):null,
        galleryPaperCredit(entry,p),
        ...edits.map((edit,idx)=>galleryEditNode(edit,idx,edits.length,types)));
    }
    function renderConquestFeed(){
      const types=typesOf(liveConfig);
      const cards=lbEntries.map(entry=>galleryCard(entry,types,false));
      const empty=el('p',{className:'booth-small',textContent:'공개된 정복 결함이 없어요.'});
      kidsOf(byId('booth-lb-list'),...(cards.length?cards:[empty]));
      setHidden('booth-lb-example-note',true);
      setHidden('booth-lb-filters',true);
      setHidden('booth-lb-more',!lbNextCursor);
      setHidden('booth-lb-gate',true);
      setHidden('booth-lb-feed',false);
    }
    function renderLeaderboardFeed(){
      if(lbRoute?.paper) return renderConquestFeed();
      setHidden('booth-lb-filters',false);
      const feed=byId('booth-lb-feed');
      const filters=byId('booth-lb-filters');
      const listBox=byId('booth-lb-list');
      const more=byId('booth-lb-more');
      if(!feed||!listBox) return;
      const isExample=!lbEntries.length;
      const source=isExample?[STAFF_EXAMPLE_ENTRY]:lbEntries;
      setHidden('booth-lb-example-note',!isExample);
      const titles=myReceiptTitles();
      const hasMine=!isExample&&source.some(entry=>entryMatchesMine(entry,titles));
      if(lbFilter==='mine'&&!hasMine) lbFilter='all';
      if(filters){
        const defs=[['all','전체'],['missed','통과'],['caught','적발']];
        if(hasMine) defs.push(['mine','내가 도전한 논문']);
        kidsOf(filters,...defs.map(([id,label])=>{
          const btn=el('button',{type:'button',className:lbFilter===id?'booth-chip on':'booth-chip',textContent:label,'aria-pressed':String(lbFilter===id)});
          btn.addEventListener('click',()=>{lbFilter=id;renderLeaderboardFeed();});
          return btn;
        }));
      }
      const filtered=source.filter(entry=>{
        if(lbFilter==='missed') return entry.outcome==='missed';
        if(lbFilter==='caught') return entry.outcome==='caught'||entry.outcome==='partial';
        if(lbFilter==='mine') return entryMatchesMine(entry,titles);
        return true;
      });
      const types=typesOf(liveConfig);
      if(filtered.length){
        kidsOf(listBox,...filtered.map(entry=>galleryCard(entry,types,!isExample&&entryMatchesMine(entry,titles))));
      }else{
        kidsOf(listBox,el('p',{className:'booth-small',textContent:'조건에 맞는 공개 결함이 아직 없어요.'}));
      }
      if(more) more.hidden=isExample||!lbNextCursor||lbLoading;
      feed.hidden=false;
      setHidden('booth-lb-gate',true);
    }
    function setLeaderboardUnlocked(unlocked){
      ownerState=Object.assign({},ownerState||{used:usedTries(),perOwner:perOwnerCap()},{unlocked});
    }
    function showLeaderboardFeedError(error,append){
      if(closed) return;
      if(error&&error.code==='leaderboard_locked'){
        setLeaderboardUnlocked(false);
        say('booth-lb-status','');
        renderLeaderboardGate();
        say('booth-lb-gate-error',errorMessage('leaderboard_locked'));
        return;
      }
      say('booth-lb-status',errorMessage(error&&error.code,error));
      offerRetry('booth-lb-status',error,()=>loadLeaderboardFeed(append));
    }
    function leaderboardFeedUrl(route,append){
      const params=new URLSearchParams();
      if(route?.paper) params.set('paper',route.paper);
      if(append&&lbNextCursor) params.set('cursor',lbNextCursor);
      const query=params.toString();
      return '/v1/booth/leaderboard'+(query?'?'+query:'');
    }
    async function loadLeaderboardFeed(append){
      if(lbLoading||closed) return;
      const route=lbRoute;
      lbLoading=true;
      const more=byId('booth-lb-more');
      if(more) more.disabled=true;
      if(!append) say('booth-lb-status','결함 갤러리를 불러오는 중…');
      try{
        const data=await requestFresh(leaderboardFeedUrl(route,append),{method:'GET',auth:true});
        if(closed||route!==lbRoute) return;
        const incoming=Array.isArray(data?.entries)?data.entries:[];
        lbEntries=append?lbEntries.concat(incoming):incoming;
        lbNextCursor=typeof data?.nextCursor==='string'?data.nextCursor||null:null;
        lbLoading=false;
        say('booth-lb-status','');
        renderLeaderboardFeed();
      }catch(error){
        if(route===lbRoute) showLeaderboardFeedError(error,append);
      }finally{
        if(route===lbRoute){
          lbLoading=false;
          if(more) more.disabled=false;
        }
      }
    }
    async function unlockLeaderboard(){
      if(lbUnlocking||closed) return;
      const route=lbRoute;
      lbUnlocking=true;
      const go=byId('booth-lb-unlock-go');
      if(go) go.disabled=true;
      say('booth-lb-gate-error','');
      try{
        const data=await requestFresh('/v1/booth/leaderboard/unlock',{method:'POST',auth:true,body:{}});
        if(closed) return;
        if(data&&data.unlocked===true){
          setLeaderboardUnlocked(true);
          renderChances();
          renderSendTicket();
          if(route===lbRoute) await loadLeaderboardFeed(false);
        }
      }catch(error){
        if(closed) return;
        say('booth-lb-gate-error',errorMessage(error&&error.code,error));
        offerRetry('booth-lb-gate-error',error,unlockLeaderboard);
      }finally{
        lbUnlocking=false;
        if(go) go.disabled=false;
      }
    }
    /* Explicit user journey only: checks ownerState with visitor bearer without delaying initial pick boot. */
    async function loadConquestHeading(route){
      const summary=await request('/v1/booth/leaderboard/summary',{method:'GET',auth:false});
      if(closed||route!==lbRoute) return false;
      const paper=summary.conqueredPapers.find(item=>item.paperKey===route.paper);
      byId('booth-lb-heading').textContent=paper?.title||route.paper;
      if(paper?.hasPublicDefect) return true;
      say('booth-lb-status','공개된 정복 결함이 없어요.');
      return false;
    }
    async function refreshLeaderboardState(){
      const route=lbRoute;
      say('booth-lb-status','래더보드 상태를 확인하는 중…');
      setHidden('booth-lb-gate',true);
      setHidden('booth-lb-feed',true);
      try{
        if(route?.paper){
          if(!await loadConquestHeading(route)) return;
        }else void loadLeaderboardSummary();
        const data=await requestFresh('/v1/booth/config',{method:'GET',auth:true});
        if(closed||route!==lbRoute) return;
        if(data&&typeof data==='object'){
          if(data.features) liveConfig=Object.assign({},liveConfig,data);
          ownerState=ownerStateFrom(data);
          renderChances();
        }
        say('booth-lb-status','');
        if(ownerState&&ownerState.unlocked) await loadLeaderboardFeed(false);
        else renderLeaderboardGate();
      }catch(error){
        if(closed||route!==lbRoute) return;
        say('booth-lb-status',errorMessage(error&&error.code,error));
        offerRetry('booth-lb-status',error,refreshLeaderboardState);
      }
    }
    function showLeaderboardView(visible){
      if(visible&&!galleryEnabled()) return;
      if(visible&&step!=='pick') setStep('pick');
      setHidden('booth-leaderboard',!visible);
      if(!visible) return;
      setHidden('booth-landing',true);
      setHidden('booth-result',true);
      if(lbRoute?.hash===location.hash) return;
      const paper=linkedPaper();
      lbRoute={hash:location.hash,paper};
      lbEntries=[];
      lbNextCursor=null;
      lbLoading=false;
      setText('booth-lb-back',paper?'← 래더보드':'← 처음으로');
      setText('booth-lb-feed-label',paper?'AI가 놓친 결함':'다른 사람들의 결함');
      const heading=byId('booth-lb-heading');
      heading.setAttribute('translate',paper?'no':'yes');
      if(paper){
        heading.textContent=paper;
        setHidden('booth-lb-summary',true);
        setHidden('booth-lb-mine',true);
        heading.focus?.();
      }else{
        kidsOf(heading,'오늘의 ',el('b',{textContent:'래더보드'}));
        renderLeaderboardSummary();
        renderLeaderboardMine();
      }
      void refreshLeaderboardState();
    }
    function openLeaderboard(event){
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      if(!galleryEnabled()) return;
      lbReturnStep=step==='ticket'&&ticket?'ticket':'pick';
      try{location.hash='#booth-leaderboard';}catch{}
      showLeaderboardView(true);
    }
    function closeLeaderboard(){
      if(lbRoute?.paper){
        location.hash='#booth-leaderboard';
        showLeaderboardView(true);
        return;
      }
      lbRoute=null;
      leaveResultHash();
      setHidden('booth-leaderboard',true);
      say('booth-lb-status','');
      say('booth-lb-gate-error','');
      if(lbReturnStep==='ticket'&&ticket){
        lbReturnStep='pick';
        setStep('ticket');
        return;
      }
      setHidden('booth-result',true);
      setHidden('booth-landing',false);
    }
    async function saveTicketConsent(){
      const input=byId('booth-ticket-consent-input');
      if(!input||!ticket||!ticket.receipt||!ticket.claimKey||consentSaving) return;
      const nextVal=input.checked===true;
      consentSaving=true;
      input.disabled=true;
      say('booth-ticket-consent-status','저장하는 중…');
      try{
        const data=await request('/v1/booth/gallery-consent',{
          method:'POST',auth:false,
          body:{receipt:ticket.receipt,claimKey:ticket.claimKey,galleryConsent:nextVal}
        });
        if(closed) return;
        const confirmed=data&&typeof data.galleryConsent==='boolean'?data.galleryConsent:nextVal;
        input.checked=confirmed;
        say('booth-ticket-consent-status',confirmed?'행사 갤러리에 공개하도록 바꿨어요.':'행사 갤러리에서 비공개로 바꿨어요.');
      }catch(error){
        if(closed) return;
        input.checked=!nextVal;
        say('booth-ticket-consent-status',errorMessage(error&&error.code,error));
      }finally{
        consentSaving=false;
        input.disabled=false;
      }
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
    function submissionsOpen(){
      return !liveConfig||liveConfig.submissionsOpen!==false;
    }
    function refreshSubmitButton(){
      const button=byId('booth-submit-button');
      if(!button) return;
      const ready=submissionsOpen()&&!!liveConsentVersion()&&rows.length>0&&!!generatedFile&&SHA256.test(generatedHash);
      button.disabled=!ready;
    }
    function flat(text){
      return String(text).replace(/\s+/g,' ');
    }
    /* Mono diff of the changed region only: removed struck through, added on --ev-mark. */
    function diffNode(row){
      const parts=diffParts(row.before,row.after);
      return el('p',{className:'booth-diff'},
        parts.lead?el('span',{className:'ctx',translate:'no',textContent:flat(parts.lead)}):null,
        parts.removed?el('del',{className:'del',translate:'no',textContent:flat(parts.removed)}):null,
        parts.added?el('ins',{className:'ins',translate:'no',textContent:flat(parts.added)}):el('ins',{className:'ins gone',textContent:'(지움)'}),
        parts.tail?el('span',{className:'ctx',translate:'no',textContent:flat(parts.tail)}):null);
    }
    function chipRow(row, types){
      const box=el('div',{className:'booth-chips',role:'group','aria-label':'결함 유형'});
      const chips=[];
      function paint(){
        for(const [id,chip] of chips){
          const pressed=id===row.defectType;
          chip.className=pressed?'booth-chip on':'booth-chip';
          chip.setAttribute('aria-pressed',String(pressed));
        }
      }
      if(!types.some(type=>type.id===row.defectType)) row.defectType='';
      for(const type of types){
        const chip=el('button',{type:'button',className:'booth-chip',textContent:type.label,'data-defect-type':type.id,'aria-pressed':'false'});
        chip.addEventListener('click',()=>{row.defectType=row.defectType===type.id?'':type.id;paint();});
        chips.push([type.id,chip]);
        box.append(chip);
      }
      paint();
      return box;
    }
    /* Each send card names its own edit's source: only a 내 AI edit gets the AI title and chip. */
    function rowTitle(row){
      const page=(row.pageIndex+1)+'쪽';
      if(row.source!=='myai') return el('p',{className:'booth-klab',textContent:'내가 숨긴 결함 · '+page});
      return el('div',{className:'booth-card-head'},
        el('p',{className:'booth-klab',textContent:'AI와 숨긴 결함 · '+page}),
        el('span',{className:'booth-ai-chip',textContent:'AI 제안'}));
    }
    function rowPanel(row, types){
      const reason=el('textarea',{rows:'3',maxlength:String(limitsOf(liveConfig).maxReason)});
      reason.value=row.reason||'';
      reason.addEventListener('input',()=>{row.reason=reason.value;});
      row.reasonInput=reason;
      return el('article',{className:'booth-panel booth-card'},
        rowTitle(row),
        diffNode(row),
        el('p',{className:'booth-klab gap',textContent:'어떤 결함인가요 (선택)'}),
        chipRow(row,types),
        el('label',{className:'booth-field'},el('span',{className:'booth-klab',textContent:'왜 결함인가요 (선택)'}),reason));
    }
    function renderRows(){
      for(const row of rows) if(row&&row.reasonInput) row.reason=row.reasonInput.value;
      const box=byId('booth-rows');
      if(!box) return;
      box.textContent='';
      const types=typesOf(liveConfig);
      for(const row of rows) box.append(rowPanel(row,types));
      renderSendTicket();
      refreshSubmitButton();
    }
    /* The desktop SUBMISSION ticket: paper, changed places and pages, chances left. */
    function renderSendTicket(){
      setText('booth-send-paper',paper?(paper.title||paper.id):'');
      const pages=receiptPages(rows.map(row=>row.pageIndex+1));
      setText('booth-send-count',rows.length?[rows.length+'곳',pages.length?pages.join(', ')+'쪽':''].filter(Boolean).join(' · '):'');
      setText('booth-send-chances',liveConfig?chances()+'번':'');
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
    function boothEdits(){
      if(ctx.editsStore) return ctx.editsStore;
      try{return root.FalsifyBoothEdits||null;}catch{return null;}
    }
    function browserPdfApi(){
      if(ctx.browserPdf) return ctx.browserPdf;
      try{return root.FalsifyBrowserPdf||null;}catch{return null;}
    }
    function blindPdfApi(){
      if(ctx.blindPdf) return ctx.blindPdf;
      try{return root.FalsifyBlindPdf||null;}catch{return null;}
    }
    function liveEdits(){
      const store=boothEdits();
      if(!store||typeof store.list!=='function') return [];
      try{
        return store.list().filter(edit=>edit&&typeof edit==='object'&&Number.isSafeInteger(edit.pageIndex)&&typeof edit.originalText==='string'&&typeof edit.newText==='string');
      }catch{return [];}
    }
    function editToRow(edit){
      return {
        id:typeof edit.id==='string'?edit.id:'',
        pageIndex:edit.pageIndex,
        before:edit.originalText,
        after:edit.newText,
        rects:Array.isArray(edit.rects)?edit.rects:[],
        source:typeof edit.source==='string'?edit.source:'',
        defectType:'',
        reason:''
      };
    }
    function sourceFile(){
      if(boothFile) return boothFile;
      if(openedFile) return openedFile;
      const ws=workspace();
      try{const src=ws&&typeof ws.getSource==='function'?ws.getSource():null;return src&&src.file||null;}
      catch{return null;}
    }
    function editSignature(edits){
      return edits.map(edit=>[edit.pageIndex,edit.originalText!=null?edit.originalText:edit.before,edit.newText!=null?edit.newText:edit.after,JSON.stringify(edit.rects||[])].join('\u0000')).join('\u0001');
    }
    /* Same edits as last time keep their chips and reasons: by id, else once by the same page and original text.
       A deleted edit's chip and reason never move to a different edit. */
    function takeSamePlace(spare, row){
      const at=spare.findIndex(item=>item.pageIndex===row.pageIndex&&item.before===row.before);
      return at<0?null:spare.splice(at,1)[0];
    }
    function keepDeclared(nextRows, previous){
      const ids=new Set(nextRows.map(row=>row.id).filter(Boolean));
      const spare=previous.filter(item=>item&&!ids.has(item.id));
      return nextRows.map(row=>{
        const old=(row.id&&previous.find(item=>item&&item.id===row.id))||takeSamePlace(spare,row);
        if(!old) return row;
        const reason=old.reasonInput?old.reasonInput.value:old.reason;
        return Object.assign(row,{defectType:old.defectType||'',reason:reason||''});
      });
    }
    function clearGenerated(){
      generatedFile=null;
      generatedHash='';
      sourceSha='';
      adoptedSignature='';
      rows=[];
    }
    function clip(text){
      const value=flat(text).trim();
      return value.length>CHIP_TEXT?value.slice(0,CHIP_TEXT-1).trimEnd()+'…':value;
    }
    function removeBoothEdit(id){
      const store=boothEdits();
      if(store&&typeof store.remove==='function') store.remove(id);
      renderDock();
    }
    function jumpToEdit(edit){
      dockPopOpen=false;
      const ws=workspace();
      if(ws&&typeof ws.showPage==='function'){try{ws.showPage(Number(edit.pageIndex)+1);}catch{}}
      renderDock();
    }
    function chipParts(edit){
      const parts=diffParts(edit.originalText,edit.newText,0);
      return [
        el('span',{className:'pg',textContent:(edit.pageIndex+1)+'쪽'}),
        parts.removed?el('del',{translate:'no',textContent:clip(parts.removed)}):null,
        parts.added?el('span',{translate:'no',textContent:'→'+clip(parts.added)}):el('span',{textContent:'→(지움)'})];
    }
    function deleteButton(edit){
      const button=el('button',{type:'button',className:'booth-dock-x',textContent:'×','aria-label':(edit.pageIndex+1)+'쪽 고친 곳 지우기'});
      button.addEventListener('click',()=>{removeBoothEdit(edit.id);});
      return button;
    }
    /* "5쪽 0.95→0.50 ×": the page, the removed text struck through, the new text, then delete. */
    function dockChip(edit){
      return el('span',{className:'booth-dock-chip'},...chipParts(edit),deleteButton(edit));
    }
    function popRow(edit){
      const open=el('button',{type:'button',className:'booth-dock-pop-text','aria-label':(edit.pageIndex+1)+'쪽 고친 곳으로 이동'},...chipParts(edit));
      open.addEventListener('click',()=>{jumpToEdit(edit);});
      return el('li',{},open,deleteButton(edit));
    }
    function moreButton(hidden){
      const button=el('button',{type:'button',className:'booth-dock-chip more',textContent:'+'+hidden,
        'aria-expanded':String(dockPopOpen),'aria-controls':'booth-dock-pop','aria-label':'고친 곳 '+hidden+'개 더 보기'});
      button.addEventListener('click',()=>{dockPopOpen=!dockPopOpen;renderDock();});
      return button;
    }
    function toggleDockPop(){
      if(!liveEdits().length){dockPopOpen=false;renderDock();return;}
      dockPopOpen=!dockPopOpen;
      renderDock();
    }
    function renderDockChips(edits){
      const box=byId('booth-dock-chips');
      const extra=edits.length>DOCK_CHIPS;
      if(!edits.length) dockPopOpen=false;
      if(box){
        const chips=edits.slice(0,DOCK_CHIPS).map(dockChip);
        if(extra) chips.push(moreButton(edits.length-DOCK_CHIPS));
        kidsOf(box,...chips);
      }
      setAttr('booth-dock-count','aria-expanded',String(dockPopOpen));
      setAttr('booth-dock-count','data-openable',String(edits.length>0));
      const pop=byId('booth-dock-pop');
      if(!pop) return;
      kidsOf(pop,...(dockPopOpen?edits.map(popRow):[]));
      pop.hidden=!dockPopOpen;
    }
    function renderDock(){
      const edits=liveEdits();
      const count=edits.length;
      const cap=limitsOf(liveConfig).maxDeclared;
      setText('booth-dock-count','고친 곳 '+count+'개');
      setText('booth-dock-sub',count>cap?'한 번에 '+cap+'곳까지 제출할 수 있어요':(count===cap?cap+'곳까지 고칠 수 있어요':'여러 곳을 고쳐도 돼요'));
      setAttr('booth-dock','data-at-cap',String(count>=cap));
      if(!making&&count>cap){
        say('booth-dock-status','한 번에 '+cap+'곳까지 제출할 수 있어요. 지금은 '+count+'곳이에요.');
      }
      renderDockChips(edits);
      const next=byId('booth-next');
      if(next) next.disabled=count===0||count>cap||!!making;
    }
    function clearEngineRetry(){
      const box=byId('booth-dock-fix');
      if(box){kidsOf(box);box.hidden=true;}
    }
    function showEngineRetry(){
      const box=byId('booth-dock-fix');
      if(!box) return;
      const button=el('button',{type:'button',className:'booth-dock-act',textContent:'다시 시도'});
      button.addEventListener('click',()=>{clearEngineRetry();say('booth-dock-status','');void beginMake();});
      kidsOf(box,button);
      box.hidden=false;
    }
    function cancelMake(){
      making=null;
      setAttr('booth-dock','data-busy','false');
    }
    function settleMake(ok){
      if(!making) return;
      cancelMake();
      if(ok){
        clearEngineRetry();
        say('booth-dock-status','');
        setStep('send');
        return;
      }
      renderDock();
    }
    function makeLive(token){
      return !closed&&!!making&&making.token===token;
    }
    function engineError(){
      const err=new Error('engine_unavailable');
      err.code='engine_unavailable';
      return err;
    }
    function checkMakeReady(edits){
      if(!edits.length){renderDock();return null;}
      if(!paper){say('booth-dock-status',PICK_PAPER);return null;}
      const cap=limitsOf(liveConfig).maxDeclared;
      if(edits.length>cap){
        say('booth-dock-status','한 번에 '+cap+'곳까지 제출할 수 있어요. 지금은 '+edits.length+'곳이에요.');
        renderDock();
        return null;
      }
      const sig=editSignature(edits);
      if(sig===adoptedSignature&&generatedFile&&SHA256.test(generatedHash)){
        setStep('send');
        return null;
      }
      const file=sourceFile();
      if(!file||typeof file.arrayBuffer!=='function'){
        say('booth-dock-status',PICK_PAPER);
        return null;
      }
      return {edits,sig,file};
    }
    async function prepareSourceBytes(file, rawBytes, token){
      const blind=blindPdfApi();
      if(!blind||typeof blind.prepare!=='function') return rawBytes;
      const clean=await blind.prepare({file});
      if(!makeLive(token)) return null;
      const cleanFile=clean&&clean.changed?clean.file:null;
      if(!cleanFile||typeof cleanFile.arrayBuffer!=='function') return rawBytes;
      return new Uint8Array(await cleanFile.arrayBuffer());
    }
    async function rewriteBytes(sourceBytes, edits){
      const pdfApi=browserPdfApi();
      if(!pdfApi||typeof pdfApi.rewrite!=='function') throw engineError();
      const rewritten=await pdfApi.rewrite(sourceBytes,edits);
      const outBytes=rewritten instanceof Uint8Array?rewritten:new Uint8Array(rewritten||[]);
      if(!pdfMagic(outBytes)) throw engineError();
      return outBytes;
    }
    function adoptGenerated(outBytes, hash, originalSha, edits, sig){
      if(originalSha&&originalSha===hash){
        clearGenerated();
        say('booth-dock-status',errorMessage('pdf_unchanged'));
        settleMake(false);
        return;
      }
      const outFile=pdfFile(outBytes,'edited.pdf');
      if(!outFile) throw engineError();
      const nextRows=edits.map(editToRow);
      sourceSha=originalSha;
      generatedFile=outFile;
      generatedHash=hash;
      adoptedSignature=sig;
      rows=rows.length?keepDeclared(nextRows,rows):nextRows;
      say('booth-submit-status','');
      renderRows();
      settleMake(true);
    }
    async function runMake(ready, token){
      const rawBytes=new Uint8Array(await ready.file.arrayBuffer());
      if(!makeLive(token)) return;
      const originalSha=await digestHex(rawBytes);
      if(!makeLive(token)) return;
      const sourceBytes=await prepareSourceBytes(ready.file,rawBytes,token);
      if(!sourceBytes||!makeLive(token)) return;
      const outBytes=await rewriteBytes(sourceBytes,ready.edits);
      if(!makeLive(token)) return;
      if(exposedPdfBytes&&outBytes.byteLength>exposedPdfBytes){
        generatedFile=null;
        generatedHash='';
        adoptedSignature='';
        settleMake(false);
        setStep('edit');
        say('booth-dock-status',errorMessage('payload_too_large'));
        return;
      }
      const hash=await digestHex(outBytes);
      if(!makeLive(token)) return;
      if(!hash) throw engineError();
      adoptGenerated(outBytes,hash,originalSha,ready.edits,ready.sig);
    }
    /* 「다음」 builds the revised PDF directly: source blind-pdf check (skipped when trusted), then
       FalsifyBrowserPdf.rewrite(sourceBytes, FalsifyBoothEdits.list()), hash and go to send. */
    async function beginMake(){
      if(making||closed) return;
      const ready=checkMakeReady(liveEdits());
      if(!ready) return;
      makeSeq+=1;
      const token=makeSeq;
      making={token};
      clearEngineRetry();
      say('booth-dock-status','수정본을 만드는 중…');
      setAttr('booth-dock','data-busy','true');
      renderDock();
      try{
        await runMake(ready,token);
      }catch(_error){
        if(!makeLive(token)) return;
        say('booth-dock-status',ENGINE_UNAVAILABLE);
        showEngineRetry();
        settleMake(false);
      }
    }
    function licenseId(paperLike){
      if(!paperLike||paperLike.license==null) return '';
      if(typeof paperLike.license==='string') return paperLike.license;
      return typeof paperLike.license.id==='string'?paperLike.license.id:'';
    }
    /* 다음 runs the MuPDF training-marker check (blind-pdf.js) on the source first. A paper the booth
       fetched from arXiv through GET /v1/papers/pdf skips it: blind-pdf.js keeps the SHA-256 of exactly
       these response bytes and skips MuPDF only when the PDF handed to generation has that hash. Recipe
       ids, URL hashes, resumed sessions and visitor files never reach this call. */
    function trustFetchedBytes(bytes){
      if(typeof trustFetched!=='function') return;
      try{void Promise.resolve(trustFetched(bytes)).catch(()=>{});}catch{/* the check then runs */}
    }
    function bindPaper(next, file){
      const previous=boothFile;
      paper=next&&(next.source==='arxiv'||next.source==='mission')?{
        source:next.source,
        id:typeof next.id==='string'?next.id:'',
        title:sanitizePaperTitle(next.title),
        license:typeof next.license==='string'?next.license:'',
        pageHint:Number.isInteger(next.pageHint)?next.pageHint:0
      }:null;
      boothFile=file||null;
      if(previous!==boothFile){
        clearGenerated();
        const store=boothEdits();
        if(previous&&store&&typeof store.clear==='function') store.clear();
      }
      renderCredit();
      renderRows();
    }
    /* Losing the paper in edit or send returns to pick. */
    function clearPaper(){
      paper=null;
      boothFile=null;
      clearGenerated();
      resetGalleryConsentBox();
      const store=boothEdits();
      if(store&&typeof store.clear==='function') store.clear();
      renderCredit();
      renderRows();
      if(step!=='edit'&&step!=='send') return;
      cancelMake();
      setStep('pick');
    }
    /* openPdf's own change handler clears the workspace, then loads this same PDF. */
    function rememberOpened(file){
      openedPaper=paper?{source:paper.source,id:paper.id,title:paper.title,license:paper.license}:null;
      openedFile=file||null;
      openedHash='';
    }
    function detailFile(event){
      const detail=event&&event.detail;
      return detail&&detail.file||null;
    }
    function detailHash(event){
      const detail=event&&event.detail;
      if(!detail) return '';
      const hash=typeof detail.fileHash==='string'?detail.fileHash:(typeof detail.sha256==='string'?detail.sha256:'');
      return SHA256.test(hash)?hash:'';
    }
    function sameOpenedDocument(event){
      const file=detailFile(event);
      if(openedFile&&file===openedFile) return true;
      if(boothFile&&file===boothFile) return true;
      const hash=detailHash(event);
      return !!(openedHash&&hash&&openedHash===hash);
    }
    function openedBindFile(event){
      return openedFile||detailFile(event);
    }
    function onBoothDocument(event){
      if(!sameOpenedDocument(event)){
        openedFile=null;
        openedHash='';
        openedPaper=null;
        clearPaper();
        return;
      }
      if(!paper&&openedPaper) bindPaper(openedPaper, openedBindFile(event));
    }
    function onBoothClear(){
      if(ownOpen) return;
      openedFile=null;
      openedHash='';
      openedPaper=null;
      clearPaper();
    }
    function headerValue(headers, name){
      if(!headers||typeof headers.get!=='function') return '';
      return headers.get(name)||'';
    }
    function pdfFileName(headerName, nameHint){
      const named=/filename="([^"]+)"/.exec(headerName||'');
      return named&&named[1]?named[1].slice(0,180):nameHint;
    }
    function pdfFile(bytes, name){
      try{return new File([bytes],name||'arxiv.pdf',{type:'application/pdf'});}
      catch{return null;}
    }
    function assignInputFile(input, file){
      const transfer=new DataTransfer();
      transfer.items.add(file);
      input.files=transfer.files;
    }
    const EMPTY_TEXT_SCAN_PAGES=10;
    const ARXIV_STAMP_RE=/arXiv:\s*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?(?:\s+\[[^\]]+\])?(?:\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})?/gi;
    let cancelPendingOpen=null;
    let pendingTailCheck=null;
    let lastOpenStatusId='booth-mission-status';
    function pageHasEditableText(items){
      if(!Array.isArray(items)||!items.length) return false;
      let text='';
      for(const item of items){
        if(item&&typeof item.str==='string') text+=' '+item.str;
      }
      return text.replace(ARXIV_STAMP_RE,' ').replace(/\s+/g,'').length>0;
    }
    function activeWorkspacePageIndex(){
      const ws=workspace();
      try{return ws&&typeof ws.getPageIndex==='function'?ws.getPageIndex():-1;}
      catch{return -1;}
    }
    function cleanupProbePage(page, p){
      if(p<=1||!page||typeof page.cleanup!=='function'||p-1===activeWorkspacePageIndex()) return;
      try{page.cleanup();}catch{}
    }
    async function inspectPageForText(pdf, p){
      let page=null;
      try{
        page=await pdf.getPage(p);
        if(!page||typeof page.getTextContent!=='function') return 'unknown';
        const content=await page.getTextContent();
        return pageHasEditableText(content&&content.items)?'text':'empty';
      }catch{return 'unknown';}
      finally{cleanupProbePage(page,p);}
    }
    async function scanEditableRange(pdf, start, end, stillLive){
      for(let p=start;p<=end;p+=1){
        if(stillLive&&!stillLive()) return 'cancelled';
        const state=await inspectPageForText(pdf,p);
        if(state!=='empty') return state;
      }
      return 'empty';
    }
    async function checkPrefixEditableText(pdf){
      if(!pdf||typeof pdf.getPage!=='function') return {status:'text'};
      const total=Number(pdf.numPages)||0;
      if(total<1) return {status:'empty'};
      const limit=Math.min(total,EMPTY_TEXT_SCAN_PAGES);
      const state=await scanEditableRange(pdf,1,limit,null);
      if(state!=='empty') return {status:'text'};
      if(limit<total) return {status:'inconclusive',nextPage:limit+1,total};
      return {status:'empty'};
    }
    function startBackgroundTextCheck(pdf, file, statusId, nextPage, total){
      const live=()=>!closed&&boothFile===file&&!liveEdits().length;
      void scanEditableRange(pdf,nextPage,total,live).then(state=>{
        if(state!=='empty'||!live()) return;
        discardFailedOpen();
        setStep('pick');
        say(statusId,errorMessage('pdf_empty_text'));
      });
    }
    function matchesOpenFile(event, file){
      const detail=event&&event.detail;
      if(!detail||!file) return false;
      if(detail.file) return detail.file===file;
      if(openedHash&&typeof detail.fileHash==='string'&&detail.fileHash===openedHash) return true;
      return openedFile===file;
    }
    function discardFailedOpen(){
      openedFile=null;
      openedHash='';
      openedPaper=null;
      ownOpen=true;
      try{resetWorkspace();}
      finally{ownOpen=false;}
      clearPaper();
    }
    function onLatePdfError(event){
      if(opening||!boothFile||!matchesOpenFile(event,boothFile)) return;
      const detail=event&&event.detail;
      const code=detail&&typeof detail.code==='string'?detail.code:'pdf_unreadable';
      discardFailedOpen();
      setStep('pick');
      say(lastOpenStatusId,errorMessage(code));
    }
    function dispatchWorkspaceOpen(input, file){
      let started=false;
      let done=null;
      const outcome=new Promise(resolve=>{done=resolve;});
      const finish=value=>{
        if(!done) return;
        const resolve=done;
        done=null;
        if(cancelPendingOpen===abortPending) cancelPendingOpen=null;
        if(typeof doc.removeEventListener==='function'){
          doc.removeEventListener('falsify:paper-workspace-loading',onLoad);
          doc.removeEventListener('falsify:paper-workspace-pdf',onPdf);
          doc.removeEventListener('falsify:paper-workspace-pdf-error',onErr);
          doc.removeEventListener('falsify:document-clear',onClear);
        }
        resolve(value);
      };
      const abortPending=()=>{finish({ok:false,code:'cancelled'});};
      const onLoad=event=>{if(matchesOpenFile(event,file)) started=true;};
      const onPdf=event=>{if(matchesOpenFile(event,file)) finish({ok:true});};
      const onErr=event=>{
        if(!matchesOpenFile(event,file)) return;
        const detail=event&&event.detail;
        finish({ok:false,code:detail&&typeof detail.code==='string'?detail.code:'pdf_unreadable'});
      };
      const onClear=()=>{if(!ownOpen) abortPending();};
      if(typeof doc.addEventListener==='function'){
        doc.addEventListener('falsify:paper-workspace-loading',onLoad);
        doc.addEventListener('falsify:paper-workspace-pdf',onPdf);
        doc.addEventListener('falsify:paper-workspace-pdf-error',onErr);
        doc.addEventListener('falsify:document-clear',onClear);
      }
      cancelPendingOpen=abortPending;
      ownOpen=true;
      try{input.dispatchEvent(new Event('change',{bubbles:true}));}
      finally{ownOpen=false;}
      if(!started){finish({ok:true});return Promise.resolve({ok:true});}
      return outcome;
    }
    async function loadIntoWorkspace(input, file, payload, next, bytes){
      const headerLicense=headerValue(payload.headers,'X-Falsify-Paper-License');
      const picked=next&&typeof next==='object'?Object.assign({},next):null;
      if(picked&&headerLicense) picked.license=headerLicense;
      bindPaper(picked,file);
      rememberOpened(file);
      void digestHex(bytes).then(hash=>{if(openedFile===file&&SHA256.test(hash)) openedHash=hash;});
      const loaded=await dispatchWorkspaceOpen(input,file);
      if(!loaded.ok) return loaded;
      const ws=workspace();
      const pdf=ws&&typeof ws.getPdfDoc==='function'?ws.getPdfDoc():null;
      const probe=pdf?await checkPrefixEditableText(pdf):{status:'text'};
      if(closed||openedFile!==file) return {ok:false,code:'cancelled'};
      if(probe.status==='empty') return {ok:false,code:'pdf_empty_text'};
      if(probe.status==='inconclusive') return {ok:true,tail:{pdf,file,nextPage:probe.nextPage,total:probe.total}};
      return {ok:true};
    }
    async function openPdf(id, next, nameHint, statusId){
      lastOpenStatusId=statusId;
      pendingTailCheck=null;
      const path=paperPdfPath(id);
      if(!path){say(statusId,errorMessage('invalid_request'));return false;}
      say(statusId,'논문을 불러오는 중…');
      let payload=null;
      try{payload=await (takePrefetched(id)||request(path,{method:'GET',auth:true,pdf:true}));}
      catch(error){
        say(statusId,error.code==='payload_too_large'?ERROR_TEXT.payload_too_large:errorMessage(error.code,error));
        openFailure=error;
        return false;
      }
      const bytes=payload.bytes;
      if(!pdfMagic(bytes)){say(statusId,errorMessage('pdf_corrupt'));return false;}
      trustFetchedBytes(bytes);
      const file=pdfFile(bytes, pdfFileName(headerValue(payload.headers,'Content-Disposition'), nameHint));
      if(!file){say(statusId,'논문을 열지 못했어요. 다시 눌러 주세요.');return false;}
      const input=doc.getElementById('paper-file');
      if(!input){say(statusId,'논문을 열지 못했어요. 페이지를 새로 고쳐 주세요.');return false;}
      try{assignInputFile(input, file);}
      catch{say(statusId,'논문을 열지 못했어요. 다시 눌러 주세요.');return false;}
      const loaded=await loadIntoWorkspace(input,file,payload,next,bytes);
      if(closed) return false;
      if(!loaded.ok){
        if(loaded.code==='cancelled') return false;
        discardFailedOpen();
        say(statusId,errorMessage(loaded.code));
        return false;
      }
      pendingTailCheck=loaded.tail?Object.assign({statusId},loaded.tail):null;
      say(statusId,'');
      return true;
    }
    function extLink(href, text){
      return el('a',{href,target:'_blank',rel:'noopener noreferrer',textContent:text});
    }
    function creditParts(current){
      const id=current&&typeof current.id==='string'?current.id.trim():'';
      const url=arxivUrl(id);
      if(!url) return [];
      const lic=licenseId(current);
      const label=licenseLabel(lic);
      const lUrl=licenseUrl(lic);
      const parts=['원문 ',extLink(url,'arXiv '+id)];
      if(label) parts.push(' · ',lUrl?extLink(lUrl,label):label);
      parts.push(' · 게임용으로 고친 사본');
      return parts;
    }
    function renderCredit(){
      const node=byId('booth-paper-credit');
      if(!node) return;
      const parts=creditParts(paper);
      kidsOf(node,...parts);
      node.hidden=!parts.length;
    }
    function renderHint(){
      const node=byId('booth-hint');
      kidsOf(node,el('span',{className:'booth-klab',textContent:'힌트'}),' · '+(hint||GENERIC_HINT));
    }
    function enterEdit(pageHint){
      setStep('edit');
      if(pageHint) followPageHint(pageHint);
    }
    async function startPaper(next, id, statusId, pageHint, nextHint){
      if(opening) return false;
      opening=true;
      openFailure=null;
      let ok=false;
      try{ok=await openPdf(id,next,'arxiv-'+String(id).replace(/[^\w.-]+/g,'_')+'.pdf',statusId);}
      finally{opening=false;}
      if(!ok) offerRetry(statusId,openFailure,()=>startPaper(next,id,statusId,pageHint,nextHint));
      if(!ok||closed) return false;
      hint=nextHint||'';
      const tail=pendingTailCheck;
      pendingTailCheck=null;
      enterEdit(pageHint);
      if(tail) startBackgroundTextCheck(tail.pdf,tail.file,tail.statusId,tail.nextPage,tail.total);
      return true;
    }
    function missionPage(mission){
      const n=mission&&mission.pageHint;
      return Number.isInteger(n)&&n>=1&&n<=9999?n:0;
    }
    function showMissionPage(n){
      const ws=workspace();
      /* No window scroll: the PDF can open well after the edit step showed (scrolled to the top), and a
         late jump would move the page under a visitor already reading or scrolling. */
      if(ws&&typeof ws.showPage==='function'&&ws.showPage(n,{scroll:false})===true) return true;
      const jump=byId('paper-page-jump');
      if(!jump||jump.disabled) return false;
      jump.value=String(n);
      if(typeof jump.dispatchEvent==='function') jump.dispatchEvent(new Event('change',{bubbles:true}));
      return true;
    }
    /* The workspace reads the PDF after the change event, so the hint page retries until the PDF opens.
       A slow phone on Slow 4G opens it after 15-20 s, so the retry runs for up to 60 s (240 x 250 ms). */
    function followPageHint(n){
      if(showMissionPage(n)) return;
      if(typeof later!=='function') return;
      let left=240;
      const tick=()=>{
        if(closed||step!=='edit'||showMissionPage(n)) return;
        left-=1;
        if(left>0) later(tick,250);
      };
      later(tick,250);
    }
    function missionPaper(mission){
      return {source:'mission',id:mission.paperId,title:sanitizePaperTitle(mission.title),
        license:typeof mission.license==='string'?mission.license:'',pageHint:missionPage(mission)};
    }
    /* One tap: load the paper (unless it is already open), jump to the hint page, then edit. */
    function chooseMission(mission){
      if(opening) return Promise.resolve(false);
      const missionHint=typeof mission.hint==='string'?mission.hint.trim():'';
      const n=missionPage(mission);
      if(paper&&paper.source==='mission'&&paper.id===mission.paperId){hint=missionHint;enterEdit(n);return Promise.resolve(true);}
      return startPaper(missionPaper(mission),mission.paperId,'booth-mission-status',n,missionHint);
    }
    function ticketStub(n){
      const parts=n?[el('span',{className:'n',textContent:String(n)}),el('span',{className:'u',textContent:'쪽'})]:[];
      return el('span',{className:'stub'},...parts,el('span',{className:'go',textContent:'도전 →'}));
    }
    function paperTicket(label, title, line, n){
      return el('button',{type:'button',className:'booth-tk booth-tk-h booth-mission'},
        el('span',{className:'main'},
          label?el('span',{className:'booth-lab',textContent:label}):null,
          el('span',{className:'title',textContent:title}),
          line?el('span',{className:'hint',textContent:line}):null),
        ticketStub(n));
    }
    function missionTicket(mission){
      const n=missionPage(mission);
      const title=typeof mission.title==='string'&&mission.title?mission.title:mission.paperId;
      const label=[ARXIV_ID.test(mission.paperId)?'arXiv '+mission.paperId:'',licenseLabel(mission.license)].filter(Boolean).join(' · ');
      const button=paperTicket(label,title,typeof mission.hint==='string'?mission.hint:'',n);
      button.setAttribute('aria-label',title+(n?' · '+n+'쪽에서 도전':' · 도전'));
      button.addEventListener('click',()=>{chooseMission(mission);});
      button.addEventListener('pointerdown',()=>{prefetchPaper(mission.paperId);});
      button.addEventListener('pointercancel',()=>{dropPrefetch(mission.paperId);});
      return button;
    }
    /* A mission tap starts the PDF request on pointerdown; the click that follows picks it up in openPdf.
       A touch that turns into a scroll fires pointercancel, which aborts the request. One slot only. */
    function prefetchPaper(id){
      if(closed||opening||(paper&&paper.id===id)||(prefetched&&prefetched.id===id)) return;
      const path=paperPdfPath(id);
      if(!path||typeof AbortController!=='function') return;
      dropPrefetch('');
      const abort=new AbortController();
      const task=request(path,{method:'GET',auth:true,pdf:true,signal:abort.signal});
      task.catch(()=>{});
      prefetched={id,task,abort};
    }
    function dropPrefetch(id){
      if(!prefetched||(id&&prefetched.id!==id)) return;
      prefetched.abort.abort();
      prefetched=null;
    }
    function takePrefetched(id){
      const hit=prefetched&&prefetched.id===id?prefetched.task:null;
      prefetched=null;
      return hit;
    }
    function renderMissions(){
      const box=byId('booth-missions');
      if(!box||!liveConfig) return;
      box.textContent='';
      const missions=Array.isArray(liveConfig.missions)?liveConfig.missions:[];
      const valid=missions.filter(mission=>mission&&typeof mission==='object'&&typeof mission.paperId==='string');
      box.hidden=!valid.length;
      setHidden('booth-mission-head',!valid.length);
      setHidden('booth-mission-credit',!valid.length);
      setText('booth-mission-count','오늘의 미션 · '+valid.length);
      for(const mission of valid) box.append(missionTicket(mission));
    }
    function searchMeta(item){
      const authors=Array.isArray(item.authors)?item.authors.slice(0,3).join(', '):'';
      return [authors,item.year].filter(value=>value!=null&&value!=='').join(' · ');
    }
    function searchSourceLink(item){
      const id=typeof item.id==='string'?item.id.trim():'';
      const url=arxivUrl(id);
      if(!url) return null;
      const lic=licenseId(item);
      const label=licenseLabel(lic);
      const lUrl=licenseUrl(lic);
      const parts=['원문 ',extLink(url,'arXiv '+id)];
      if(label&&lUrl) parts.push(' · ',extLink(lUrl,label));
      return el('p',{className:'booth-credit booth-search-source'},...parts);
    }
    /* A tap on the paper that is already open goes back to edit with its edits, as missions do. */
    function chooseSearchResult(item){
      if(opening) return Promise.resolve(false);
      if(paper&&paper.id===item.id){enterEdit(0);return Promise.resolve(true);}
      return startPaper({source:'arxiv',id:item.id,title:sanitizePaperTitle(item.title),license:licenseId(item)},item.id,'booth-search-status',0,'');
    }
    function searchResultCard(item){
      const title=sanitizePaperTitle(item.title)||item.id;
      const label=['arXiv '+item.id,licenseLabel(licenseId(item))].filter(Boolean).join(' · ');
      const button=paperTicket(label,title,String(searchMeta(item)),0);
      button.setAttribute('aria-label',title+' · 이 논문으로 도전');
      button.addEventListener('click',()=>{void chooseSearchResult(item);});
      const source=searchSourceLink(item);
      return source?el('div',{className:'booth-search-item'},button,source):button;
    }
    function searchPager(pages, payload){
      pages.hidden=searchPage<=1&&!(payload&&payload.hasMore);
      if(searchPage>1){
        const prev=el('button',{type:'button',className:'booth-btn line',textContent:'이전'});
        prev.addEventListener('click',()=>{searchPage-=1;void runSearch();});
        pages.append(prev);
      }
      if(payload&&payload.hasMore&&searchPage<5){
        const next=el('button',{type:'button',className:'booth-btn line',textContent:'다음'});
        next.addEventListener('click',()=>{searchPage+=1;void runSearch();});
        pages.append(next);
      }
    }
    /* OpenAlex and arXiv index English text, so a Hangul query that finds nothing points to English. */
    function emptySearchLine(){
      return /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(searchQuery)
        ?'검색 결과가 없어요. 영어로 찾아볼까요? 예: medical imaging'
        :'검색 결과가 없어요. 다른 단어로 찾아볼까요?';
    }
    function renderSearch(payload){
      const box=byId('booth-search-results');
      const pages=byId('booth-search-pages');
      if(!box||!pages) return;
      box.textContent='';
      pages.textContent='';
      const results=payload&&Array.isArray(payload.results)?payload.results:[];
      const eligible=results.filter(item=>item&&ARXIV_ID.test(item.id)&&item.licenseVerified===true&&LICENSE_RE.test(licenseId(item)));
      say('booth-search-status',eligible.length?'':emptySearchLine());
      for(const item of eligible) box.append(searchResultCard(item));
      searchPager(pages, payload);
    }
    async function runSearch(){
      const path=paperSearchPath(searchQuery,searchPage);
      if(!path){say('booth-search-status',errorMessage('invalid_request'));return;}
      say('booth-search-status','검색 중…');
      try{renderSearch(await request(path,{method:'GET',auth:true}));}
      catch(error){say('booth-search-status',errorMessage(error.code,error));offerRetry('booth-search-status',error,runSearch);}
    }
    function stopEvent(event){
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
    }
    function submissionBlock(){
      if(!submissionsOpen()) return 'closed';
      if(!liveConfig) return 'loading';
      if(!liveConsentVersion()) return 'loading';
      if(!paper) return 'pick';
      if(!generatedFile||!SHA256.test(generatedHash)) return 'missing';
      return '';
    }
    function rowReason(row){
      return row.reasonInput?row.reasonInput.value:row.reason;
    }
    function rowPayload(row){
      return {
        pageIndex:row.pageIndex,before:sanitizeDeclaredText(row.before),after:sanitizeDeclaredText(row.after),
        defectType:row.defectType,reason:rowReason(row)
      };
    }
    /* The course choice is hidden at the booth: every submission is the quick course. */
    function submissionInput(paperPayload){
      const input={
        course,
        consentVersion:liveConsentVersion(),
        rows:rows.map(rowPayload),
        paper:paperPayload,
        editedSha256:generatedHash,
        limits:liveConfig&&liveConfig.limits,
        defectTypes:typesOf(liveConfig).map(item=>item.id)
      };
      if(galleryEnabled()) input.galleryConsent=isGalleryConsentChecked();
      return input;
    }
    function declaredToReceiptEdits(list){
      if(!Array.isArray(list)) return [];
      return list.slice(0,RECEIPT_EDITS_CAP).map(item=>({
        page:item.pageIndex+1,
        before:trimCodePoints(item.before,RECEIPT_EDIT_MAX),
        after:trimCodePoints(item.after,RECEIPT_EDIT_MAX)
      }));
    }
    /* Title, changed pages and submitted edits are kept with the receipt on this device only. */
    function ticketMeta(data, claimKey, declared){
      return {
        receipt:typeof data.receipt==='string'?data.receipt:'',claimKey,
        createdAt:typeof data.createdAt==='string'?data.createdAt:new Date(now()).toISOString(),
        title:paper&&paper.title?paper.title:'',
        pages:receiptPages(rows.map(row=>row.pageIndex+1)),
        count:rows.length,
        edits:declaredToReceiptEdits(declared)
      };
    }
    function rememberClaim(meta){
      if(!(meta.receipt&&meta.claimKey)) return;
      rememberReceipt(storage,meta);
    }
    function showKnownReceipt(error){
      if(error.code!=='already_submitted'||!error.receipt) return;
      const known=readReceipts(storage).find(item=>item.receipt===error.receipt);
      if(known) void lookupRecord(known.receipt,known.claimKey);
    }
    function preflight(){
      const block=submissionBlock();
      if(block){
        say('booth-submit-status',blockMessage(block));
        if(block!=='closed') refreshSubmitButton();
        return false;
      }
      const live=liveEdits();
      const cap=limitsOf(liveConfig).maxDeclared;
      if(live.length>cap){
        say('booth-submit-status','한 번에 '+cap+'곳까지 제출할 수 있어요. 지금은 '+live.length+'곳이에요.');
        return false;
      }
      return true;
    }
    function optionalAssist(){
      const recipe=root.FalsifyBoothRecipe;
      if(!recipe||typeof recipe.assist!=='function') return null;
      let extra=null;
      try{extra=recipe.assist();}catch{return null;}
      if(!extra||typeof extra!=='object') return null;
      return extra.assist==='manual'||extra.assist==='my-ai'?{assist:extra.assist}:null;
    }
    function submissionFormFor(){
      const paperPayload=Object.assign({},paper);
      if(sourceSha) paperPayload.sourceSha256=sourceSha;
      const built=buildSubmission(submissionInput(paperPayload));
      if(!built.ok){say('booth-submit-status',errorMessage(built.code));return null;}
      const extra=optionalAssist();
      if(extra) Object.assign(built.body,extra);
      const form=submissionForm(built.body,generatedFile);
      if(!form){say('booth-submit-status',errorMessage('invalid_request'));return null;}
      return {form,declared:built.body.declared};
    }
    async function ensureSubmissionPdf(){
      const live=liveEdits();
      if(!live.length) return true;
      if(generatedFile&&SHA256.test(generatedHash)&&editSignature(live)===adoptedSignature) return true;
      adoptedSignature='';
      await beginMake();
      if(step==='send'&&generatedFile&&SHA256.test(generatedHash)) return true;
      if(step==='send') say('booth-submit-status',ENGINE_UNAVAILABLE);
      return false;
    }
    /* The server names the current consentVersion; a 409 consent_outdated takes it and sends once more. */
    async function refreshConsentVersion(){
      try{
        const data=await request('/v1/booth/config',{method:'GET',auth:false});
        if(liveConfig&&data&&typeof data.consentVersion==='string'&&data.consentVersion&&data.consentVersion!==liveConfig.consentVersion){
          liveConfig.consentVersion=data.consentVersion;
          return true;
        }
      }catch{/* keep the first error */}
      return false;
    }
    async function submitBooth(event, again){
      stopEvent(event);
      setHidden('booth-submit-records',true);
      if(!(await ensureSubmissionPdf())) return;
      if(!preflight()) return;
      const payload=submissionFormFor();
      if(!payload) return;
      const button=byId('booth-submit-button');
      if(button) button.disabled=true;
      say('booth-submit-status','제출하는 중…');
      try{
        const consented=galleryEnabled()&&isGalleryConsentChecked();
        const data=await requestFresh('/v1/booth/submissions',{method:'POST',auth:true,form:payload.form});
        const meta=ticketMeta(data,typeof data.claimKey==='string'?data.claimKey:'',payload.declared);
        rememberClaim(meta);
        if(ownerState) ownerState.used+=1;
        resetGalleryConsentBox();
        say('booth-submit-status','');
        followSubmission(Object.assign({},data,galleryEnabled()?{galleryConsent:consented}:{}),meta);
      }catch(error){
        if(error.code==='consent_outdated'&&!again&&await refreshConsentVersion()){submitBooth(null,true);return;}
        if(error.code==='leaderboard_forfeited'){
          setLeaderboardUnlocked(true);
          renderChances();
        }
        say('booth-submit-status',submitFailureText(error));
        setHidden('booth-submit-records',!(capHit(error)||error.code==='leaderboard_forfeited'));
        offerRetry('booth-submit-status',error,()=>submitBooth());
        showKnownReceipt(error);
        refreshSubmitButton();
      }
    }
    function claimFields(){
      const receipt=byId('booth-claim-receipt');
      const key=byId('booth-claim-key');
      return {receipt:normalizeReceipt(receipt?receipt.value:''),claimKey:normalizeClaimKey(key?key.value:'')};
    }
    function fillClaim(item){
      const receipt=byId('booth-claim-receipt');
      const key=byId('booth-claim-key');
      if(receipt) receipt.value=item.receipt;
      if(key) key.value=item.claimKey;
    }
    /* GET with the key in the query is a CORS simple request: no preflight and no rate-limit write on the
       Worker, so a venue NAT full of pollers cannot run the per-IP claim bucket dry. A Worker without the
       GET route answers 405 once; the page then keeps the older POST. */
    let claimByGet=true;
    async function claimRequest(receipt, claimKey){
      if(claimByGet){
        try{return await request('/v1/booth/claim?receipt='+encodeURIComponent(receipt)+'&key='+encodeURIComponent(claimKey),{method:'GET',auth:false});}
        catch(error){if(error.status!==405) throw error;claimByGet=false;}
      }
      return request('/v1/booth/claim',{method:'POST',auth:false,body:{receipt,claimKey}});
    }
    async function lookup(event){
      stopEvent(event);
      const fields=claimFields();
      if(!fields.receipt||!fields.claimKey){say('booth-result-error',errorMessage('not_found'));return;}
      await lookupRecord(fields.receipt,fields.claimKey);
    }
    function metaFor(receipt, claimKey){
      const known=readReceipts(storage).find(item=>item.receipt===receipt);
      return Object.assign({},known||{},{receipt,claimKey});
    }
    /* A lookup opens the ticket only once the claim view answers. */
    async function lookupRecord(receipt, claimKey){
      const inTicket=step==='ticket';
      say('booth-result-error','');
      liveError('');
      let data=null;
      try{data=await claimRequest(receipt,claimKey);}
      catch(error){
        const text=errorMessage(error.code,error);
        if(inTicket) liveError(text);
        else say('booth-result-error',text);
        return;
      }
      if(closed) return;
      stopPolling();
      openTicket(metaFor(receipt,claimKey));
      if(!applyClaim(data).final) beginPolling(receipt,claimKey,false);
    }
    async function withdraw(){
      if(!ticket||!ticket.receipt||!ticket.claimKey){liveError(errorMessage('not_found'));return;}
      const body={receipt:ticket.receipt,claimKey:ticket.claimKey};
      stopPolling();
      try{
        const data=await request('/v1/booth/withdraw',{method:'POST',auth:false,body});
        if(ownerState&&ownerState.used>0) ownerState.used-=1;
        withdrawAsk(false);
        applyClaim(data);
      }catch(error){
        liveError(errorMessage(error.code,error));
        if(!closed&&ticket) beginPolling(body.receipt,body.claimKey,false);
      }
    }
    function blockMessage(block){
      if(block==='closed') return errorMessage('booth_closed');
      if(block==='loading') return '부스 정보를 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.';
      if(block==='pick') return PICK_PAPER;
      return ENGINE_UNAVAILABLE;
    }
    /* Only the version the server names. Before /v1/booth/config answers there is none. */
    function liveConsentVersion(){
      const version=liveConfig&&liveConfig.consentVersion;
      return typeof version==='string'&&version?version:'';
    }
    function perOwnerCap(){
      return declaredCap(liveConfig&&liveConfig.limits&&liveConfig.limits.perOwner);
    }
    /* A withdrawn try is free again on the Worker (status <> 'withdrawn'), so it is free here too. */
    function usedTries(){
      return readReceipts(storage).filter(item=>item.outcome!=='withdrawn').length;
    }
    function chances(){
      if(ownerState&&ownerState.unlocked===true) return 0;
      const used=ownerState&&Number.isSafeInteger(ownerState.used)?Math.max(ownerState.used,usedTries()):usedTries();
      return chancesLeft(perOwnerCap(),used);
    }
    function capHit(error){
      return error.code==='rate_limited'&&!(error.retryAfter>0);
    }
    /* The per-guest cap is a 429 with no Retry-After. Booth CORS hides that header today,
       so a visible wait means a short rate limit and local receipts decide the cap copy. */
    function submitFailureText(error){
      if(!capHit(error)) return errorMessage(error.code,{receipt:error.receipt});
      renderReceipts();
      const cap=perOwnerCap();
      if(usedTries()>=cap) return capMessage(cap);
      return '지금 제출이 몰려 있어요. 잠시 뒤 다시 눌러 주세요. 기회 '+cap+'번을 다 썼다면 「내 기록」에서 결과를 볼 수 있어요.';
    }
    /* Withdraw asks once: the first button gives way to 취소 and 철회하기 under the warning. */
    function withdrawAsk(asking){
      setHidden('booth-withdraw',asking);
      setHidden('booth-withdraw-ask',!asking);
    }
    function liveError(text){
      setText('booth-live-error',text);
      setHidden('booth-live-error',!text);
    }
    function openTicket(meta){
      ticket=meta;
      withdrawAsk(false);
      const box=byId('booth-withdraw-box');
      if(box) box.open=false;
      say('booth-copy-status','');
      say('booth-ticket-consent-status','');
      const consentInput=byId('booth-ticket-consent-input');
      if(consentInput) consentInput.checked=false;
      setHidden('booth-leaderboard',true);
      leaveResultHash();
      setStep('ticket');
    }
    function createdAtOf(data){
      if(typeof data.createdAt==='string'&&Number.isFinite(Date.parse(data.createdAt))) return data.createdAt;
      return ticket&&ticket.createdAt||'';
    }
    function countOf(data, meta){
      if(Number.isSafeInteger(data.declaredCount)&&data.declaredCount>0) return data.declaredCount;
      return Number.isSafeInteger(meta.count)?meta.count:0;
    }
    function pagesLabel(pages, count){
      const list=Array.isArray(pages)&&pages.length?pages.join(', ')+'쪽':'';
      return [list,count?count+'곳':''].filter(Boolean).join(' · ');
    }
    function renderTicketTop(data){
      const meta=ticket||{};
      setText('booth-receipt-code',meta.receipt||(typeof data.receipt==='string'?data.receipt:''));
      setText('booth-stub-receipt',meta.receipt||(typeof data.receipt==='string'?data.receipt:''));
      setText('booth-claim-code',meta.claimKey||'');
      setHidden('booth-claim-code-cell',!meta.claimKey);
      setText('booth-ticket-paper',shortTitle(meta.title));
      setHidden('booth-ticket-paper-cell',!meta.title);
      const pages=pagesLabel(meta.pages,countOf(data,meta));
      setText('booth-ticket-pages',pages);
      setHidden('booth-ticket-pages-cell',!pages);
    }
    function tickClock(){
      if(clock) setText('booth-ticket-elapsed',formatClock(now()-clock.at));
    }
    function stopClock(){
      if(clock&&clock.id!=null&&stopEvery) stopEvery(clock.id);
      clock=null;
    }
    function startClock(at){
      stopClock();
      const started=Date.parse(at||'');
      if(!Number.isFinite(started)){setText('booth-ticket-elapsed','');return;}
      clock={at:started,id:null};
      tickClock();
      if(every) clock.id=every(tickClock,1000);
    }
    function paintBars(pen, code, width, height){
      let hash=2166136261;
      let x=0;
      while(x<width){
        for(let i=0;i<code.length&&x<width;i+=1){
          hash=Math.imul(hash^code.charCodeAt(i),16777619)>>>0;
          const bar=1+(hash%3);
          pen.fillRect(x,0,bar,height);
          x+=bar+1+((hash>>3)%3);
        }
      }
    }
    /* Slim barcode drawn from receipt and claim key. Decorative only. */
    function drawBarcode(){
      const canvas=byId('booth-barcode');
      if(!canvas||typeof canvas.getContext!=='function'||!ticket) return;
      const width=Math.max(1,Math.round(canvas.clientWidth||300));
      const height=Math.max(1,Math.round(canvas.clientHeight||34));
      const ratio=Math.min(3,Number(root.devicePixelRatio)||1);
      canvas.width=Math.round(width*ratio);
      canvas.height=Math.round(height*ratio);
      const pen=canvas.getContext('2d');
      if(!pen) return;
      pen.setTransform(ratio,0,0,ratio,0,0);
      pen.clearRect(0,0,width,height);
      pen.fillStyle='#16191e';
      paintBars(pen,[ticket.receipt,ticket.claimKey].filter(Boolean).join('-')||'FALSIFY',width,height);
    }
    function renderPending(data){
      poll.last=data;
      setAttr('booth-ticket-wait','data-poll','live');
      const queued=data.status==='received'?queueLabel(data.queue):'';
      setText('booth-ticket-state',data.status==='reviewing'?'AI가 논문을 읽는 중':queued||'AI 검증 차례를 기다리는 중');
      setText('booth-step-check',data.status==='received'?STEP_QUEUED:STEP_CHECKING);
      if(data.reviewDelayed===true){
        setText('booth-ticket-state',data.passReviewPending===true?'운영진이 수정 내용을 확인하고 있어요':'검증이 지연되고 있어요');
        setText('booth-step-check','저장된 수정본으로 검증을 이어가요');
      }
      setText('booth-live-title','');
      setHidden('booth-ticket-duration-cell',true);
      setHidden('booth-live-tip',true);
      const created=Date.parse(createdAtOf(data));
      setText('booth-stub-date',Number.isFinite(created)?dateLabel(created):'');
      startClock(createdAtOf(data));
      drawBarcode();
    }
    function dateLabel(ms){
      const at=new Date(ms);
      return [at.getFullYear(),String(at.getMonth()+1).padStart(2,'0'),String(at.getDate()).padStart(2,'0')].join('.');
    }
    function renderStamp(stamp){
      const node=byId('booth-stamp');
      if(!node) return;
      node.hidden=!stamp;
      if(!stamp) return;
      node.className='booth-stamp '+stamp.kind+(stamp===STAMP.excluded?' wide':'');
      setText('booth-stamp-word',stamp.word);
      setText('booth-stamp-latin',stamp.latin);
    }
    function renderDuration(data, state){
      const published=Date.parse(typeof data.publishedAt==='string'?data.publishedAt:'');
      const created=Date.parse(createdAtOf(data));
      /* Only AI verdicts show a wait; invalid and withdrawn rows were decided by the operators. */
      const known=TIMED.includes(state)&&Number.isFinite(published)&&Number.isFinite(created)&&published>=created;
      setText('booth-ticket-duration',known?formatDuration(published-created):'');
      setHidden('booth-ticket-duration-cell',!known);
      setText('booth-ticket-date',Number.isFinite(published)?dateLabel(published):'');
    }
    function renderVerdict(view, data){
      stopClock();
      kidsOf(byId('booth-live-title'),view.lead||null,el('b',{textContent:view.strong}));
      setText('booth-live-sub',view.state==='partial'?PARTIAL_SUB:'');
      setHidden('booth-live-sub',view.state!=='partial');
      const mixedExcluded=view.judgedCount>0&&view.excludedCount>0;
      setText('booth-live-excluded',mixedExcluded?'판정 대상 '+view.judgedCount+'곳 · 판정 제외 '+view.excludedCount+'곳':'');
      setHidden('booth-live-excluded',!mixedExcluded);
      setHidden('booth-live-rule',!TIMED.includes(view.state));
      renderStamp(view.stamp);
      renderDuration(data,view.state);
      setHidden('booth-live-tip',!(view.state==='caught'||view.state==='partial'));
    }
    function opinionNodes(opinion, opinionEn, gap, label){
      if(!opinion&&!opinionEn) return [];
      const both=!!(opinion&&opinionEn);
      const out=[el('p',{className:gap?'booth-klab gap':'booth-klab',textContent:label||'AI 의견'})];
      if(opinion) out.push(el('p',{className:both?'booth-txt booth-opinion-ko':'booth-txt',translate:'no',textContent:opinion}));
      if(opinionEn) out.push(el('p',{className:both?'booth-txt booth-opinion-en':'booth-txt',translate:'no',textContent:opinionEn}));
      return out;
    }
    function opinionParts(parsed){
      return opinionNodes(parsed.opinion,parsed.opinionEn,true);
    }
    function remainingNoteText(text, state){
      if(!text) return '';
      const lines=text.split('\n').map(line=>line.trim()).filter(Boolean);
      const kept=state==='caught'||state==='partial'?lines.filter(line=>!REDUNDANT_NOTES.has(line)):lines;
      return kept.join('\n');
    }
    function noteParts(parsed, state, perEditEvidence, allExcluded){
      const parts=[];
      if(perEditEvidence){
        const text=remainingNoteText(parsed.text,state);
        if(!text) return parts;
        parts.push(el('p',{className:'booth-klab',textContent:state==='invalid'&&!allExcluded?'운영진 안내':'AI 메모'}));
        parts.push(el('p',{className:'booth-txt',textContent:text}));
        return parts;
      }
      const structured=!!(parsed.quote||parsed.opinion||parsed.opinionEn);
      if(parsed.text&&!structured) parts.push(el('p',{className:'booth-klab',textContent:state==='missed'&&(parsed.page||parsed.quote)?'AI가 의심한 곳':state==='invalid'&&!allExcluded?'운영진 안내':'AI 메모'}));
      if(parsed.text) parts.push(el('p',{className:'booth-txt',textContent:parsed.text}));
      if(parsed.quote) parts.push(el('blockquote',{className:'booth-quote',translate:'no',textContent:parsed.quote}));
      parts.push(...opinionParts(parsed));
      return parts;
    }
    function renderNote(view){
      const parsed=parsePublicNote(view.note);
      const perEditEvidence=hasEditEvidence(view.editResults);
      const allExcluded=view.state==='invalid'&&isAllExcluded(view.editResults);
      const page=!perEditEvidence?parsed.page:'';
      setText('booth-live-page',page?'AI가 짚은 곳 · '+page+'쪽':'');
      setHidden('booth-live-page',!page);
      const parts=noteParts(parsed,view.state,perEditEvidence,allExcluded);
      kidsOf(byId('booth-live-note'),...parts);
      setHidden('booth-live-note',!parts.length);
    }
    function storedEditsFor(receipt){
      const code=normalizeReceipt(receipt);
      if(!code) return [];
      const hit=readReceipts(storage).find(item=>item.receipt===code);
      return hit&&Array.isArray(hit.edits)?hit.edits:[];
    }
    function verdictBadge(verdict){
      const info=verdict&&Object.prototype.hasOwnProperty.call(EDIT_VERDICTS,verdict)?EDIT_VERDICTS[verdict]:null;
      if(!info) return null;
      return el('span',{className:'booth-edit-verdict '+info.kind,'aria-label':info.text,textContent:info.text});
    }
    function editLabel(index, page, total){
      const pageText=Number.isSafeInteger(page)&&page>=1?page+'쪽':'';
      if(total>1) return pageText?'결함 '+(index+1)+' · '+pageText:'결함 '+(index+1);
      return pageText||'결함 '+(index+1);
    }
    function evidenceBlock(result){
      if(!result||(result.verdict!=='caught'&&result.verdict!=='partial'&&result.verdict!=='excluded')||!result.evidence) return null;
      const ev=result.evidence;
      const isExcluded=result.verdict==='excluded';
      const parts=[];
      if(ev.quote&&!isExcluded){
        parts.push(el('p',{className:'booth-klab',textContent:'AI가 짚은 문장'}));
        parts.push(el('blockquote',{className:'booth-quote',translate:'no',textContent:ev.quote}));
      }
      parts.push(...opinionNodes(ev.rationale,ev.rationaleEn,!!(ev.quote&&!isExcluded),isExcluded?'제외 사유':'AI 의견'));
      if(!parts.length) return null;
      return el('div',{className:'booth-edit-evidence'},...parts);
    }
    function resultMapFor(items, editResults){
      if(!Array.isArray(editResults)||editResults.length!==items.length) return null;
      const map=new Map();
      for(const item of editResults){
        if(item.index<0||item.index>=items.length||map.has(item.index)) return null;
        map.set(item.index,item);
      }
      return map.size===items.length?map:null;
    }
    function declaredRow(item, index, total, result){
      const label=editLabel(index,item.page,total);
      const badge=verdictBadge(result?result.verdict:'');
      const head=badge
        ? el('div',{className:'booth-declared-head'},el('p',{className:'booth-klab',textContent:label}),badge)
        : el('p',{className:'booth-klab',textContent:label});
      return el('div',{className:'booth-declared-item','data-edit-index':String(index)},head,diffNode(item),evidenceBlock(result));
    }
    function findingRow(result, total){
      const page=Number.isSafeInteger(result.pageIndex)?result.pageIndex+1:null;
      const label=editLabel(result.index,page,total);
      const badge=verdictBadge(result.verdict);
      const head=badge
        ? el('div',{className:'booth-declared-head'},el('p',{className:'booth-klab',textContent:label}),badge)
        : el('p',{className:'booth-klab',textContent:label});
      return el('div',{className:'booth-declared-item','data-edit-index':String(result.index)},head,evidenceBlock(result));
    }
    function renderDeclared(view, data){
      const box=byId('booth-live-declared');
      if(!box) return false;
      const items=view.final&&view.state!=='withdrawn'?storedEditsFor(data.receipt):[];
      if(!items.length){kidsOf(box);box.hidden=true;return false;}
      const results=resultMapFor(items,view.editResults);
      kidsOf(box,el('p',{className:'booth-klab',textContent:'내가 고친 곳'}),...items.map((item,index)=>declaredRow(item,index,items.length,results?results.get(index):null)));
      box.hidden=false;
      return !!results;
    }
    function renderFindings(view, attached){
      const box=byId('booth-live-findings');
      if(!box) return;
      const results=view.final&&view.state!=='withdrawn'&&Array.isArray(view.editResults)?view.editResults:[];
      if(!results.length||attached||(results.length<=1&&!hasEditEvidence(results)&&!isAllExcluded(results))){
        kidsOf(box);
        box.hidden=true;
        return;
      }
      kidsOf(box,el('p',{className:'booth-klab',textContent:'항목별 AI 검증 결과'}),...results.map(result=>findingRow(result,results.length)));
      box.hidden=false;
    }
    function renderGift(prize){
      setText('booth-live-prize',prize);
      setHidden('booth-gift',!prize);
    }
    function renderChances(){
      const left=chances();
      setText('booth-chances-top','기회 '+left+'번 남음');
      setText('booth-live-again',left?'다시 도전하기 · 기회 '+left+'번 남음':'내 기록 보기');
      if(!left) setHidden('booth-live-records',true);
      setText('booth-pick-limit','1인 '+perOwnerCap()+'번까지 · 이름·연락처는 받지 않아요');
    }
    function renderLive(data){
      const view=resultView(data);
      setAttr('booth-live','data-state',view.state);
      setAttr('booth-ticket','data-state',view.state);
      renderTicketTop(data);
      for(const id of ['booth-ticket-wait','booth-ticket-steps','booth-live-capture','booth-project-wait']) setHidden(id,view.final);
      for(const id of ['booth-ticket-result','booth-verdict']) setHidden(id,!view.final);
      if(view.final) renderVerdict(view,data);
      else renderPending(data);
      renderGift(view.prize);
      renderNote(view);
      const attached=renderDeclared(view,data);
      renderFindings(view,attached);
      const showConsent=galleryEnabled()&&view.state!=='withdrawn'&&!!(ticket&&ticket.receipt&&ticket.claimKey);
      setHidden('booth-ticket-consent',!showConsent);
      if(showConsent&&!consentSaving){
        const box=byId('booth-ticket-consent-input');
        if(box) box.checked=data.galleryConsent===true;
      }
      setHidden('booth-live-again',!view.final);
      setHidden('booth-live-leaderboard',!(view.final&&galleryEnabled()));
      setHidden('booth-live-records',!view.final);
      setHidden('booth-final',view.state!=='missed');
      setHidden('booth-withdraw-box',view.state==='withdrawn');
      setHidden('booth-live-recheck',true);
      liveError('');
      return view;
    }
    function applyClaim(data){
      const view=renderLive(data&&typeof data==='object'?data:{});
      waiting=!view.final;
      syncWake();
      if(view.final){
        stopPolling();
        if(ticket) noteReceiptOutcome(storage,ticket.receipt,view.state==='invalid'&&isAllExcluded(view.editResults)?'excluded':view.state);
      }
      renderReceipts();
      renderChances();
      return view;
    }
    function stopPolling(){
      poll.token+=1;
      if(poll.timer!=null&&cancel) cancel(poll.timer);
      poll.timer=null;
    }
    function beginPolling(receipt, claimKey, immediate){
      const resume=poll.stopped&&waiting?poll.last:null;
      stopPolling();
      poll.startedAt=now();
      poll.receipt=receipt;
      poll.claimKey=claimKey;
      poll.stopped=false;
      if(resume) renderPending(resume);
      setHidden('booth-live-recheck',true);
      if(immediate) void pollOnce(poll.token);
      else schedulePoll(poll.token,0);
    }
    function pollStopped(){
      poll.timer=null;
      poll.stopped=true;
      stopClock();
      setAttr('booth-ticket-wait','data-poll','stopped');
      setHidden('booth-live-recheck',false);
    }
    function schedulePoll(token, retryMs){
      const delay=nextPollDelay(now()-poll.startedAt,retryMs);
      if(delay<0){pollStopped();setText('booth-ticket-state',POLL_STOP_COPY);return;}
      if(!later) return;
      poll.timer=later(()=>{void pollOnce(token);},delay);
    }
    function pollFailed(token, error){
      if(error.code==='not_found'){liveError(errorMessage('not_found'));pollStopped();return;}
      if(error.code==='offline'){liveError(errorMessage('offline'));offerRetry('booth-live-error',error,recheck);}
      schedulePoll(token,error.status===429?(error.retryAfter||POLL_429_MS):0);
    }
    /* A hidden tab does not poll. onReturn asks again as soon as the tab is visible. */
    async function pollOnce(token){
      if(closed||token!==poll.token) return;
      poll.timer=null;
      if(!visibleNow()) return;
      let data=null;
      try{data=await claimRequest(poll.receipt,poll.claimKey);}
      catch(error){
        if(!closed&&token===poll.token) pollFailed(token,error);
        return;
      }
      if(closed||token!==poll.token) return;
      if(!applyClaim(data).final) schedulePoll(token,0);
    }
    function recheck(){
      if(!poll.receipt||!poll.claimKey) return;
      beginPolling(poll.receipt,poll.claimKey,true);
    }
    /* Back on the tab (visibilitychange or pageshow): a pending result is asked for at once, and polling
       that stopped after 15 min starts again. The screen stays on while the result is pending. */
    function visibleNow(){
      return !doc.visibilityState||doc.visibilityState==='visible';
    }
    function syncWake(){
      if(wake) wake.want(!closed&&step==='ticket'&&waiting&&visibleNow());
    }
    function onReturn(){
      syncWake();
      if(closed||!visibleNow()||step!=='ticket'||!waiting||!poll.receipt||!poll.claimKey) return;
      /* Back after 15 min in the background: start a fresh 15 min instead of stopping right after one check. */
      if(poll.stopped||now()-poll.startedAt>=POLL_STOP_AT){beginPolling(poll.receipt,poll.claimKey,true);return;}
      stopPolling();
      void pollOnce(poll.token);
    }
    function followSubmission(data, meta){
      renderReceipts();
      if(!meta.receipt||!meta.claimKey) return;
      fillClaim(meta);
      openTicket(meta);
      applyClaim({receipt:meta.receipt,status:data.status||'received',published:false,createdAt:meta.createdAt,declaredCount:data.declaredCount,galleryConsent:data.galleryConsent===true});
      beginPolling(meta.receipt,meta.claimKey,false);
    }
    /* Receipt, short paper title and the stamp word once a result is known. */
    function historyRow(item){
      const stamp=stampFor(item.outcome);
      const left=[item.receipt,shortTitle(item.title)].filter(Boolean).join(' · ');
      const button=el('button',{type:'button',className:'booth-hist-row'+(stamp?' '+stamp.kind:'')},
        el('span',{className:'l',translate:'no',textContent:left}),
        el('span',{className:'r',textContent:stamp?stamp.word:'결과 보기'}));
      button.addEventListener('click',()=>{fillClaim(item);void lookupRecord(item.receipt,item.claimKey);});
      return button;
    }
    function renderReceipts(){
      const list=recentReceipts(storage);
      for(const [boxId,sectionId] of [['booth-receipts-list','booth-receipts'],['booth-history','booth-history']]){
        const box=byId(boxId);
        if(!box) continue;
        box.textContent='';
        for(const item of list) box.append(historyRow(item));
        setHidden(sectionId,!list.length);
      }
    }
    /* booth-runtime.js saved progress from this tab (try #2's edits) that the reload can offer to resume. */
    function draftWaiting(){
      if(!rt||typeof rt.readProgress!=='function') return false;
      let raw=null;
      try{raw=root.sessionStorage?root.sessionStorage.getItem(rt.PROGRESS_KEY):null;}catch{return false;}
      return !!rt.readProgress(raw,now());
    }
    /* A reload within 15 min of the newest receipt, or a #booth-result visit, picks the ticket up again.
       A receipt that already has its result gives way to saved progress, so 「이어서」 can show on pick. */
    function resumeLatest(){
      if(leaderboardHash()&&galleryEnabled()) return;
      const latest=readReceipts(storage)[0];
      if(!latest) return;
      const created=Date.parse(latest.createdAt);
      const fresh=Number.isFinite(created)&&now()-created<POLL_STOP_AT;
      if(location.hash!=='#booth-result'&&!fresh) return;
      if(location.hash!=='#booth-result'&&latest.outcome&&draftWaiting()) return;
      fillClaim(latest);
      void lookupRecord(latest.receipt,latest.claimKey);
    }
    function resetWorkspace(){
      const clear=byId('import-clear');
      if(clear&&typeof clear.click==='function'){clear.click();return;}
      if(typeof Event==='function'&&typeof doc.dispatchEvent==='function') doc.dispatchEvent(new Event('falsify:document-clear'));
    }
    /* Back to pick with no paper and no rows, as the old retry did. */
    function startAgain(){
      stopPolling();
      stopClock();
      cancelMake();
      ticket=null;
      waiting=false;
      leaveResultHash();
      showRecords(false);
      setHidden('booth-leaderboard',true);
      resetWorkspace();
      clearPaper();
      hint='';
      for(const id of ['booth-submit-status','booth-search-status','booth-mission-status','booth-dock-status','booth-copy-status','booth-ticket-consent-status','booth-lb-status','booth-lb-gate-error']) say(id,'');
      liveError('');
      setHidden('booth-submit-records',true);
      setStep('pick');
      refreshSubmitButton();
    }
    /* With no tries left the ticket's main button opens 내 기록 after the same reset. */
    function againOrRecords(event){
      startAgain();
      if(!chances()) openResult(event);
    }
    async function copyReceipt(){
      const text=ticket?[ticket.receipt,ticket.claimKey].filter(Boolean).join('\n'):'';
      try{
        if(text&&root.navigator&&root.navigator.clipboard&&typeof root.navigator.clipboard.writeText==='function'){
          await root.navigator.clipboard.writeText(text);
          say('booth-copy-status','접수번호와 확인키를 복사했어요.');
          return;
        }
      }catch{}
      say('booth-copy-status','복사하지 못했어요. 접수번호와 확인키를 직접 적어 두세요.');
    }
    function scrollTop(){
      try{if(typeof root.scrollTo==='function') root.scrollTo(0,0);}catch{}
    }
    const STEP_NODES={pick:'booth-step-pick',edit:'booth-step-edit',send:'booth-submit',ticket:'booth-receipt'};
    /* The one place the step changes. event-theme.css reads html[data-booth-step]. */
    function setStep(next){
      step=next;
      if(next!=='edit') dockPopOpen=false;
      for(const [name,id] of Object.entries(STEP_NODES)) setHidden(id,name!==next);
      const html=doc.documentElement;
      if(html&&html.dataset) html.dataset.boothStep=next;
      renderDeskSteps(next);
      if(next!=='ticket') stopClock();
      syncWake();
      if(next==='edit'){renderHint();renderCredit();renderDock();}
      if(next==='send'){renderRows();if(!generatedFile&&liveEdits().length) void beginMake();}
      scrollTop();
    }
    /* Current step bold (aria-current), earlier steps done. */
    function renderDeskSteps(next){
      const current=DESK_STEP[next]||1;
      for(let n=1;n<=DESK_STEPS.length;n+=1){
        const item=byId('booth-desk-step-'+n);
        if(!item) continue;
        item.className=n===current?'on':(n<current?'done':'');
        item.setAttribute('aria-current',n===current?'step':'false');
      }
    }
    /* On desktop the paper search is always open as one row; phones keep the disclosure. */
    function applyDesk(){
      const desk=!!(deskQuery&&deskQuery.matches);
      const box=byId('booth-search-box');
      if(box&&desk&&!box.open){box.open=true;searchOpenedForDesk=true;}
      else if(box&&!desk&&searchOpenedForDesk){box.open=false;searchOpenedForDesk=false;}
      setText('booth-search-go',desk?'찾기':'검색');
      setAttr('booth-search-q','placeholder',desk?'다른 공개 논문 찾기 · 영어 제목 또는 주제':'영어 제목 또는 주제');
    }
    function backToPick(){
      cancelMake();
      setStep('pick');
    }
    function clearStep(){
      const html=doc.documentElement;
      if(html&&html.dataset) delete html.dataset.boothStep;
    }
    function onEditsChanged(){
      clearEngineRetry();
      if(!making) say('booth-dock-status','');
      renderDock();
    }
    function watchEdits(){
      const store=boothEdits();
      if(store&&typeof store.subscribe==='function') unsubEdits=store.subscribe(onEditsChanged);
    }
    function rememberPdfLimit(data){
      const limits=data&&data.limits&&typeof data.limits==='object'?data.limits:null;
      const raw=limits&&(Object.prototype.hasOwnProperty.call(limits,'maxPdfBytes')?limits.maxPdfBytes:limits.maxUploadBytes);
      const n=Number(raw);
      if(!Number.isSafeInteger(n)||n<1048576||n>33554432){exposedPdfBytes=0;return;}
      exposedPdfBytes=n;
    }
    function applyConfig(data){
      liveConfig=data;
      rememberPdfLimit(data);
      host.hidden=false;
      setHidden('booth-search',false);
      const hasGallery=galleryEnabled();
      setText('booth-desk-leaderboard',hasGallery?'래더보드':'');
      setHidden('booth-desk-leaderboard',!hasGallery);
      setHidden('booth-lb-teaser',!hasGallery);
      setHidden('booth-gallery-consent-wrap',!hasGallery);
      if(!hasGallery){
        resetGalleryConsentBox();
        setHidden('booth-leaderboard',true);
      }
      const announcement=typeof data.announcement==='string'?data.announcement.trim():'';
      setText('booth-announce',announcement);
      setHidden('booth-announce',!announcement);
      if(!submissionsOpen()) say('booth-status',errorMessage('booth_closed'));
      renderMissions();
      refreshSubmitButton();
      prefillClaim();
      renderReceipts();
      renderChances();
      if(hasGallery&&!leaderboardHash()) void loadLeaderboardSummary();
      syncHashView();
      resumeLatest();
    }
    async function loadConfig(){
      try{
        const data=await request('/v1/booth/config',{method:'GET',auth:false});
        if(closed) return;
        if(!data||data.enabled!==true){setRailBlue(doc,false);clearStep();host.remove();return;}
        applyConfig(data);
      }catch(error){
        if(closed) return;
        host.hidden=false;
        if(error&&error.code==='offline'){
          say('booth-status',errorMessage('offline'));
          offerRetry('booth-status',error,()=>{say('booth-status','');return loadConfig();});
          return;
        }
        say('booth-status','부스 정보를 불러오지 못했어요. 페이지를 새로 고쳐 주세요.');
      }
    }
    on(byId('booth-search'),'submit',event=>{
      if(event&&typeof event.preventDefault==='function') event.preventDefault();
      const input=byId('booth-search-q');
      searchQuery=input?input.value:'';
      searchPage=1;
      void runSearch();
    });
    on(byId('booth-next'),'click',()=>{void beginMake();});
    on(byId('booth-dock-count'),'click',toggleDockPop);
    on(byId('booth-edit-back'),'click',backToPick);
    on(byId('booth-dock-back'),'click',backToPick);
    on(byId('booth-dock'),'keydown',event=>{if(event&&event.key==='Escape'&&dockPopOpen){dockPopOpen=false;renderDock();}});
    on(byId('booth-desk-leaderboard'),'click',openLeaderboard);
    on(byId('booth-pick-leaderboard'),'click',openLeaderboard);
    on(byId('booth-live-leaderboard'),'click',openLeaderboard);
    on(byId('booth-lb-back'),'click',closeLeaderboard);
    on(byId('booth-lb-unlock-cancel'),'click',closeLeaderboard);
    on(byId('booth-lb-unlock-go'),'click',()=>{void unlockLeaderboard();});
    on(byId('booth-lb-more'),'click',()=>{void loadLeaderboardFeed(true);});
    on(byId('booth-ticket-consent-input'),'change',()=>{void saveTicketConsent();});
    on(byId('booth-desk-records'),'click',openResult);
    on(byId('booth-live-records'),'click',openResult);
    on(deskQuery,'change',applyDesk);
    on(byId('booth-send-back'),'click',()=>{setStep('edit');});
    on(byId('booth-submit'),'submit',event=>{void submitBooth(event);});
    on(byId('booth-copy'),'click',()=>{void copyReceipt();});
    on(byId('booth-claim-form'),'submit',event=>{void lookup(event);});
    on(byId('booth-records-back'),'click',closeRecords);
    on(byId('booth-withdraw'),'click',()=>{withdrawAsk(true);});
    on(byId('booth-withdraw-cancel'),'click',()=>{withdrawAsk(false);});
    on(byId('booth-withdraw-confirm'),'click',()=>{void withdraw();});
    on(byId('booth-live-again'),'click',againOrRecords);
    on(byId('booth-submit-records'),'click',openResult);
    on(byId('booth-live-recheck'),'click',recheck);
    on(byId('booth-result-link'),'click',openResult);
    on(doc,'falsify:document',onBoothDocument);
    on(doc,'falsify:document-clear',onBoothClear);
    on(doc,'falsify:paper-workspace-pdf-error',onLatePdfError);
    on(root,'hashchange',()=>{syncHashView();});
    on(root,'resize',()=>{if(step==='ticket') drawBarcode();});
    on(doc,'visibilitychange',onReturn);
    on(root,'pageshow',event=>{if(!event||event.persisted!==false) onReturn();});
    /* Recipe hook for booth-recipe.js: the mission or search load path by arXiv id. null until config loads. */
    function openPaperById(id, meta){
      if(!liveConfig) return null;
      if(opening) return Promise.resolve(false);
      const mission=(Array.isArray(liveConfig.missions)?liveConfig.missions:[]).find(item=>item&&item.paperId===id);
      if(mission) return chooseMission(mission);
      if(paper&&paper.id===id){hint='';enterEdit(0);return Promise.resolve(true);}
      return startPaper(Object.assign({title:'',license:''},meta,{source:'arxiv',id}),id,'booth-mission-status',0,'');
    }
    root.FalsifyBoothPaper={
      open:openPaperById,
      current:()=>paper&&Object.assign({},paper),
      output:()=>generatedFile?{file:generatedFile,sha256:generatedHash}:null
    };
    watchEdits();
    applyDesk();
    setStep('pick');
    showResult(false);
    void loadConfig();
    return {destroy(){
      closed=true;
      if(cancelPendingOpen) cancelPendingOpen();
      if(wake) wake.want(false);
      delete root.FalsifyBoothPaper;
      stopPolling();
      stopClock();
      cancelMake();
      if(unsubEdits){unsubEdits();unsubEdits=null;}
      setRailBlue(doc,false);
      clearStep();
      for(const [target,type,handler] of listeners){
        if(target&&typeof target.removeEventListener==='function') target.removeEventListener(type,handler);
      }
      if(host.parentNode&&typeof host.remove==='function') host.remove();
    }};
  }

  if(boothConfigured(readConfig())) mount();
  root.FalsifyBooth={
    normalizeClaimKey,normalizeReceipt,buildSubmission,submissionForm,errorMessage,
    readReceipts,rememberReceipt,recentReceipts,receiptRecord,paperSearchPath,paperPdfPath,
    nextPollDelay,retryAfterMs,resultView,capMessage,
    parsePublicNote,diffParts,ENGINE_UNAVAILABLE,chancesLeft,formatClock,formatDuration,noteReceiptOutcome,licenseLabel,licenseUrl,arxivUrl,shortTitle,
    queueLabel,featuresOf,passRateText,defectLabel,STAFF_EXAMPLE_ENTRY,
    NO_REASON,RECEIPT_KEY,RECEIPT_CAP,RECENT_CAP,mount
  };
})(typeof window==='object'?window:globalThis);
