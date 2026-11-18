/* Post-run human review only. No model, network, storage or execution access. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyReview=api;})(globalThis,function(){
  'use strict';
  const FINDING_VERDICTS=Object.freeze(['pending','supported','pre-existing','spin-boundary','gold-error','unsupported','mixed','uncertain']);
  const VERDICT_LABELS=Object.freeze({
    pending:'아직 판정하지 않음',
    supported:'타당함 · 주입 결함 적중',
    'pre-existing':'원본 기존 오류 · 출판본 자체 불일치 (순수 오탐 제외)',
    'spin-boundary':'수위·해석 지적 · 스핀 경계 (별도 집계)',
    'gold-error':'정답표 오류 · RED 정답지 v2 개정 후보',
    unsupported:'순수 오탐 · 근거 부족/잘못된 지적',
    mixed:'일부만 타당함',
    uncertain:'확인필요 · 외부 원문/등록부 대조 필요'
  });
  const DEFECT_FAMILY_MAP=Object.freeze({
    'numeric-drift':'D1',
    'citation-distortion':'D2',
    contradiction:'D3',
    'condition-omission':'D3',
    'unsupported-inference':'D3',
    'outcome-status-mislabeling':'D4-1',
    'semantic-inversion':'S1'
  });
  function difference(before,after){
    let start=0,end=0;
    while(start<before.length&&start<after.length&&before[start]===after[start])start++;
    while(end<before.length-start&&end<after.length-start&&before[before.length-1-end]===after[after.length-1-end])end++;
    return {prefix:before.slice(0,start),before:before.slice(start,before.length-end),after:after.slice(start,after.length-end),suffix:end?before.slice(-end):''};
  }
  function validateFindingItem(v,findings,ids){
    if(!v||typeof v!=='object'||Array.isArray(v))throw Error('BLUE 항목별 판정·근거 오류');
    if(Object.keys(v).some(k=>!['id','verdict','note'].includes(k)))throw Error('BLUE 항목별 판정·근거 오류');
    if(ids.has(v.id)||!findings.some(f=>f.id===v.id))throw Error('BLUE 항목별 판정·근거 오류');
    if(!FINDING_VERDICTS.includes(v.verdict)||typeof v.note!=='string'||v.note.length>2000)throw Error('BLUE 항목별 판정·근거 오류');
    if(v.verdict!=='pending'&&!v.note.trim())throw Error('BLUE 항목별 판정·근거 오류');
  }
  function validateFindingAssessments(review,run){
    if(review.findingAssessments===undefined)return;
    const a=review.findingAssessments,ids=new Set(),findings=run?.response?.findings;
    if(run?.role!=='blue'||!Array.isArray(a)||!Array.isArray(findings)||a.length!==findings.length)throw Error('BLUE 항목별 검수 형식 오류');
    for(const v of a){validateFindingItem(v,findings,ids);ids.add(v.id);}
  }
  function validateReviewContext(review){
    if(review.reviewContext===undefined)return;
    const c=review.reviewContext;
    if(!c||typeof c!=='object'||Array.isArray(c))throw Error('검수 방식 기록 오류');
    if(Object.keys(c).some(k=>k!=='mode')||!['red-assisted','blue-only'].includes(c.mode))throw Error('검수 방식 기록 오류');
    if(review.comparison&&c.mode!=='red-assisted')throw Error('검수 방식 기록 오류');
  }
  function validateExtras(review,run){
    validateReviewContext(review);
    validateFindingAssessments(review,run);
  }
  function readTaxonomyHint(patch,candidate){
    const classify=globalThis.FalsifyAdversarialTaxonomy?.classifyDefect;
    if(typeof classify!=='function')return {family:'',types:[]};
    try{
      const res=classify(candidate||patch);
      if(typeof res==='string')return {family:res,types:[]};
      if(!res||typeof res!=='object')return {family:'',types:[]};
      const family=res.family||res.code||res.defectFamily||'';
      const types=Array.isArray(res.attackTypes)?res.attackTypes:(typeof res.attackType==='string'&&res.attackType?[res.attackType]:[]);
      return {family,types};
    }catch{return {family:'',types:[]};}
  }
  function formatDefectBadge(patch,candidate){
    const hint=readTaxonomyHint(patch,candidate);
    const rawTypes=Array.isArray(candidate?.attackTypes)&&candidate.attackTypes.length?candidate.attackTypes:(Array.isArray(patch?.attackTypes)&&patch.attackTypes.length?patch.attackTypes:hint.types);
    if(!rawTypes.length)return hint.family?'결함 분류: '+hint.family:'';
    const grouped=new Map();
    for(const t of rawTypes){
      const fam=DEFECT_FAMILY_MAP[t]||hint.family||'D3';
      const list=grouped.get(fam)||[];
      if(!list.includes(t))list.push(t);
      grouped.set(fam,list);
    }
    const parts=[...grouped.entries()].map(([fam,list])=>fam+' ('+list.join(', ')+')');
    return '결함 분류: '+parts.join(' · ');
  }
  function createDomHelpers(d){
    const el=(tag,copy,cls)=>{const e=d.createElement(tag);if(copy!==undefined)e.textContent=copy;if(cls)e.className=cls;return e;};
    const field=(parent,title,id,choices,value,change)=>{
      const label=el('label',title),select=el('select');select.id=id;label.htmlFor=id;
      for(const [key,copy] of choices){const o=el('option',copy);o.value=key;select.append(o);}
      select.value=value;select.addEventListener('change',()=>change(select.value));parent.append(label,select);return select;
    };
    const note=(parent,title,id,value,change)=>{
      const label=el('label',title),input=el('textarea');input.id=id;input.rows=2;input.maxLength=2000;input.value=value||'';
      label.htmlFor=id;input.placeholder='원문에서 확인한 근거 또는 더 필요한 자료를 적으세요.';
      input.addEventListener('input',()=>change(input.value));parent.append(label,input);
    };
    const quote=(parent,title,copy)=>{parent.append(el('h5',title),el('blockquote',copy));};
    const changedQuote=(parent,title,diff,kind)=>{const q=el('blockquote');q.append(el('span',diff.prefix),el(kind==='before'?'del':'ins',diff[kind]),el('span',diff.suffix));parent.append(el('h5',title),q);};
    const evidence=(parent,item)=>{const detail=el('details');detail.append(el('summary','전체 설명 · 근거 · 한계'),el('p',item.rationale));for(const e of item.evidence||[])detail.append(el('p',e.relation),el('blockquote',e.quote));detail.append(el('p','한계: '+item.uncertainty));parent.append(detail);};
    return {el,field,note,quote,changedQuote,evidence};
  }
  function countPatchVerdicts(assessments){
    const counts={total:0,detected:0,missed:0,uncertain:0,pending:0};
    for(const a of assessments||[]){
      counts.total++;
      if(a?.verdict==='detected')counts.detected++;
      else if(a?.verdict==='missed')counts.missed++;
      else if(a?.verdict==='uncertain')counts.uncertain++;
      else counts.pending++;
    }
    return counts;
  }
  function tallyFindingVerdict(counts,verdict){
    if(verdict==='supported'||verdict==='mixed')counts.hit++;
    else if(verdict==='unsupported')counts.pureFp++;
    else if(verdict==='pre-existing'||verdict==='spin-boundary'||verdict==='gold-error')counts.boundary++;
    else if(verdict==='uncertain')counts.uncertain++;
    else counts.pending++;
  }
  function computeScoreboardCounts({comparison=null,findingAssessments=[]}={}){
    const patch=countPatchVerdicts(comparison?.assessments);
    const finding={total:0,hit:0,pureFp:0,boundary:0,uncertain:0,pending:0};
    for(const f of findingAssessments||[]){
      finding.total++;
      tallyFindingVerdict(finding,f?.verdict);
    }
    const totalItems=patch.total+finding.total;
    const pendingItems=patch.pending+finding.pending;
    return {patch,finding,totalItems,decidedItems:totalItems-pendingItems,pendingItems};
  }
  function createScoreTile(el,metric,label){
    const tile=el('div',undefined,'review-score-tile');
    tile.setAttribute('data-metric',metric);
    const cap=el('span',label,'review-score-label');
    const val=el('strong','0','review-score-value');
    const sub=el('span','','review-score-sub');
    tile.append(cap,val,sub);
    return {tile,val,sub};
  }
  function renderPatchCard(ui,p,i,redRun,comparison,onPatch,onVerdictChange){
    const {el,field,note,changedQuote}=ui;
    const card=el('article',undefined,'review-item');
    const candidate=redRun?.response?.candidates?.find(c=>c.id===p.id&&c.before===p.before);
    const a=comparison?.assessments[i],diff=difference(p.before,p.after);
    card.dataset.verdict=a?.verdict||'pending';
    card.append(el('h4',p.id+' · '+p.label));
    const badge=formatDefectBadge(p,candidate);
    if(badge)card.append(el('p',badge,'review-defect-badge muted'));
    changedQuote(card,'원래 문장',diff,'before');
    changedQuote(card,'바꾼 문장',diff,'after');
    card.append(el('p','바뀐 부분: '+(diff.before||'(추가)')+' → '+(diff.after||'(삭제)'),'review-change'));
    card.append(el('h5','이렇게 공격하려고 했어요'),el('p',candidate?.rationale||'공격 의도 미기록. 변경문만으로 의도를 확정하지 않습니다.'));
    if(candidate){
      const detail=el('details');
      detail.append(el('summary','RED가 제시한 근거와 한계'));
      for(const e of candidate.evidence||[])detail.append(el('p',e.relation),el('blockquote',e.quote));
      detail.append(el('p',candidate.uncertainty));
      card.append(detail);
      if(candidate.after!==p.after)card.append(el('p','사용자가 최종 수정한 문장입니다. 공격 의도는 원래 RED 제안의 설명입니다.','muted'));
    }
    card.append(el('p','같은 문구를 인용한 BLUE: '+(a?.quoteOverlapFindingIds?.join(', ')||'없음')+' · 인용 일치만으로 탐지 성공을 정하지 않습니다.','muted'));
    if(a){
      field(card,'BLUE가 이 공격을 설명했나요?','evaluation-patch-'+i,[['pending','아직 판정하지 않음'],['detected','찾았음 · 논리 충돌을 설명함'],['missed','놓쳤음 · 이 결함을 설명하지 못함'],['uncertain','확인필요']],a.verdict,v=>{card.dataset.verdict=v;onPatch(i,'verdict',v);onVerdictChange();});
      note(card,'공격별 판정 이유','evaluation-patch-note-'+i,a.note,v=>onPatch(i,'note',v));
    }
    return card;
  }
  function renderFindingCard(ui,run,f,i,findingAssessments,comparison,onFinding,onVerdictChange){
    const {el,field,note,quote,evidence}=ui;
    const card=el('article',undefined,'review-item');
    const a=findingAssessments.find(x=>x.id===f.id)||{id:f.id,verdict:'pending',note:''};
    card.dataset.verdict=a.verdict||'pending';
    const location=run.segments.find(s=>s.id===f.segmentId)?.label||f.segmentId;
    card.append(el('h4',f.id+' · '+location));
    quote(card,'BLUE가 지적한 문장',f.quote);
    const summary=f.rationale.length>260?f.rationale.slice(0,260)+'…':f.rationale;
    card.append(el('p',summary));
    evidence(card,f);
    const overlaps=comparison?.assessments.filter(x=>x.quoteOverlapFindingIds.includes(f.id)).map(x=>x.id)||[];
    if(overlaps.length)card.append(el('p','RED '+overlaps.join(', ')+'와 인용이 겹칩니다. 내용의 대응 여부를 직접 확인하세요.','muted'));
    const choices=FINDING_VERDICTS.map(k=>[k,VERDICT_LABELS[k]]);
    field(card,'이 지적은 타당한가요?','evaluation-finding-'+i,choices,a.verdict,v=>{card.dataset.verdict=v;onFinding(f.id,'verdict',v);onVerdictChange();});
    note(card,'지적별 판정 이유 · 필요한 자료','evaluation-finding-note-'+i,a.note,v=>onFinding(f.id,'note',v));
    return card;
  }
  function createScoreboard(d,el,getCounts,trackedCards){
    const wrap=el('div',undefined,'review-scoreboard');
    wrap.id='review-scoreboard';
    const grid=el('div',undefined,'review-score-grid');
    const recallTile=createScoreTile(el,'recall','주입 결함 탐지');
    const hitTile=createScoreTile(el,'hit','타당 지적 (적중)');
    const fpTile=createScoreTile(el,'fp','순수 오탐 (기각)');
    const boundTile=createScoreTile(el,'boundary','기존·경계·오류');
    grid.append(recallTile.tile,hitTile.tile,fpTile.tile,boundTile.tile);
    const triage=el('div',undefined,'review-triage-bar');
    const summary=el('span','','review-pending-summary');summary.id='review-pending-summary';
    const actions=el('div',undefined,'review-triage-actions');
    const filterBtn=el('button','미판정만 보기','button secondary');
    filterBtn.id='review-filter-pending';filterBtn.type='button';filterBtn.setAttribute('aria-pressed','false');
    const nextBtn=el('button','다음 미판정으로','button secondary');
    nextBtn.id='review-next-pending';nextBtn.type='button';
    actions.append(filterBtn,nextBtn);
    triage.append(summary,actions);
    wrap.append(grid,triage);
    let filterPending=false;
    function syncCards(){
      for(const card of trackedCards){
        card.hidden=Boolean(filterPending&&card.dataset.verdict!=='pending');
      }
    }
    function refresh(){
      const c=getCounts();
      recallTile.val.textContent=c.patch.total?c.patch.detected+' / '+c.patch.total:'대조 없음';
      recallTile.sub.textContent=c.patch.total?'미탐 '+c.patch.missed+' · 미판정 '+c.patch.pending:'블라인드 단독 검수';
      hitTile.val.textContent=c.finding.hit+'건';
      hitTile.sub.textContent='전체 BLUE 지적 '+c.finding.total+'건 중';
      fpTile.val.textContent=c.finding.pureFp+'건';
      fpTile.sub.textContent='근거 부족·기각';
      boundTile.val.textContent=c.finding.boundary+'건';
      boundTile.sub.textContent='원본오류·수위·정답오류';
      summary.textContent=c.totalItems&&c.pendingItems===0
        ?'전체 '+c.totalItems+'건 판정 완료! 아래 전체 검수 메모를 적고 저장하세요.'
        :'판정 진행 '+c.decidedItems+' / '+c.totalItems+'건 · 남은 미판정 '+c.pendingItems+'건';
      nextBtn.textContent=c.pendingItems===0?'검수 메모로 이동':'다음 미판정으로 ('+c.pendingItems+')';
      syncCards();
    }
    filterBtn.addEventListener('click',()=>{
      filterPending=!filterPending;
      filterBtn.setAttribute('aria-pressed',String(filterPending));
      filterBtn.textContent=filterPending?'전체 항목 보기':'미판정만 보기';
      syncCards();
    });
    nextBtn.addEventListener('click',()=>{
      const target=trackedCards.find(card=>card.dataset.verdict==='pending');
      if(target){
        target.hidden=false;
        target.scrollIntoView?.({block:'center'});
        const ctrl=target.querySelector?.('.visual-verdicts button, select');
        ctrl?.focus?.({preventScroll:true});
        return;
      }
      const noteEl=d.querySelector?.('#evaluation-note');
      noteEl?.scrollIntoView?.({block:'center'});
      noteEl?.focus?.({preventScroll:true});
    });
    return {wrap,refresh};
  }
  function render({document:d,run,patches=[],redRun=null,comparison=null,findingAssessments=[],onExpose=()=>{},onPatch=()=>{},onFinding=()=>{}}){
    const ui=createDomHelpers(d),{el}=ui;
    const trackedCards=[];
    const board=el('section',undefined,'review-workbench'),header=el('div',undefined,'review-toolbar');
    header.append(el('h3','RED는 무엇을 바꿨고, BLUE는 무엇을 찾았나요?'),el('p','양쪽 내용을 비교한 뒤 바로 아래에 판정을 남기세요. 연결은 참고 정보이며 정답 판정은 사람이 합니다.'));
    const exposure=el('p',patches.length?'RED 변경을 공개한 검수 · 블라인드 평가 아님':'BLUE만 검수 중 · 다른 곳에서의 정답 노출 여부는 미확인','review-exposure');
    const scoreboard=createScoreboard(d,el,()=>computeScoreboardCounts({comparison,findingAssessments}),trackedCards);
    header.append(exposure,scoreboard.wrap);board.append(header);
    const columns=el('div',undefined,'review-columns'),left=el('section',undefined,'review-column'),right=el('section',undefined,'review-column');
    left.setAttribute('aria-label','RED 공격 내용');right.setAttribute('aria-label','BLUE 탐지와 사람 판정');
    left.append(el('h3','RED · 심은 변경'),el('p',redRun?'출력 파일 해시가 일치하는 RED의 최종 선택입니다.':'RED 기록 또는 내보낸 변경 계획이 있으면 공격 내용을 함께 볼 수 있습니다.'));
    if(patches.length){onExpose();for(const [i,p] of patches.entries()){const card=renderPatchCard(ui,p,i,redRun,comparison,onPatch,scoreboard.refresh);trackedCards.push(card);left.append(card);}}
    else left.append(el('p','연결된 RED 변경 없음. BLUE만 검수해도 됩니다. 아래에서 변경 계획 JSON을 추가하면 같은 화면에서 대조할 수 있습니다.','review-empty'));
    right.append(el('h3','BLUE · 찾아낸 지적 '+run.response.findings.length+'건'),el('p','RED 공격 외의 지적도 각각 검토하세요. 지적 수가 탐지 성능을 뜻하지는 않습니다.'));
    if(!run.response.findings.length)right.append(el('p','최종 지적이 없습니다. 실행 결과와 검토 범위를 확인하고 누락 여부를 판단하세요.'));
    const linked=new Set(comparison?.assessments.flatMap(a=>a.quoteOverlapFindingIds)||[]);
    const ordered=run.response.findings.map((f,i)=>({f,i})).sort((a,b)=>Number(linked.has(b.f.id))-Number(linked.has(a.f.id)));
    if(linked.size)right.append(el('p','RED와 인용이 겹친 지적을 먼저 보여줍니다. 나머지 지적도 아래에 모두 있습니다.','muted'));
    for(const {f,i} of ordered){const card=renderFindingCard(ui,run,f,i,findingAssessments,comparison,onFinding,scoreboard.refresh);trackedCards.push(card);right.append(card);}
    scoreboard.refresh();
    columns.append(left,right);board.append(columns);return board;
  }
  return {render,validateExtras,difference,computeScoreboardCounts,FINDING_VERDICTS,VERDICT_LABELS};
});
