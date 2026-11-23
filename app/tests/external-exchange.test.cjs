const {test}=require('node:test');const assert=require('node:assert/strict');const X=require('../dist/external-exchange.js');
const segments=[{id:'s0',pageIndex:0,text:'The inter-\nnational rate is 12% [4]. Again rate is 12% [4].'}];
test('mixed changes, source offsets, citations and deletion',()=>{const raw=JSON.stringify({changes:[{before:'international rate is 12% [4].',after:'',rationale:'reason',evidence:['e'],references:['r']},{before:7,after:'x'}]});const b=X.parse(raw,{role:'red',segments,fileHash:'hash'});assert.equal(b.raw,raw);assert.equal(b.items.length,1);assert.equal(b.items[0].matchStatus,'matched');assert.equal(b.items[0].before,'inter-\nnational rate is 12% [4].');assert.equal(b.items[0].after,'');assert.deepEqual(b.items[0].evidence,['e']);assert.equal(b.diagnostics[0].code,'malformed-item');});
test('ambiguous matches are never selected',()=>{const b=X.parse('{"changes":[{"before":"rate is 12% [4]","after":"13%"}]}',{role:'red',segments,fileHash:'hash'});assert.equal(b.items[0].matchStatus,'ambiguous');assert.equal(b.items[0].anchor,null);});
test('blue prose and metadata identity',()=>{const b=X.parse('A concern without a quotation.',{role:'blue',segments,fileHash:'hash'});assert.equal(b.items[0].rationale,'A concern without a quotation.');assert.equal(b.items[0].matchStatus,'missing');const mismatch=X.parse('{"fileHash":"other","findings":[{"rationale":"x"}]}',{role:'blue',segments,fileHash:'hash'});assert.equal(mismatch.items.length,1);assert.equal(mismatch.diagnostics[0].code,'file-hash-mismatch');});
test('legacy before after and unparsed raw',()=>{const b=X.parse('Before: rate is 12% [4]\nAfter: rate is 13%',{role:'red',segments,fileHash:'hash'});assert.equal(b.items.length,1);const u=X.parse('free response',{role:'red',segments,fileHash:'hash'});assert.equal(u.status,'unparsed');assert.equal(u.raw,'free response');});
test('structured evidence, independent hashes and role',()=>{const raw=JSON.stringify({role:'blue',sourceHash:'text',findings:[{rationale:'r',evidence:[{segmentId:'s0',quote:'q',relation:'supports'}],references:[{doi:'10.x'}]}]});const b=X.parse(raw,{role:'blue',segments,fileHash:'binary'});assert.deepEqual(b.items[0].evidence,[{segmentId:'s0',quote:'q',relation:'supports'}]);assert.deepEqual(b.items[0].references,[{doi:'10.x'}]);assert.equal(b.diagnostics.length,0);assert.equal(X.parse(raw,{role:'red',segments,fileHash:'binary',sourceHash:'other'}).diagnostics.filter(d=>d.code==='role-mismatch').length,1);assert.match(X.buildPrompt({role:'blue',harness:{name:'test'},segments:[]}),/"name": "test"/);});
test('bounded import retains original and prose pair rationale',()=>{const raw='Before: international rate is 12% [4].\nAfter: revised\nRationale: Why\nEvidence: Source';const b=X.parse(raw,{role:'red',segments,fileHash:'hash'});assert.equal(b.items[0].after,'revised');assert.equal(b.items[0].rationale,'Why');assert.deepEqual(b.items[0].evidence,['Source']);const big='x'.repeat(200001);const limited=X.parse(big,{role:'blue',segments,fileHash:'hash'});assert.equal(limited.raw,big);assert.equal(limited.diagnostics[0].code,'input-limit');});

test('BLUE parses a clipped JSON tail as individual findings and preserves their evidence',()=>{
  const findings=[
    {reportNumber:'F-06',page:1,quote:'international rate is 12% [4].',rationale:'Totals differ.',evidence:[{quote:'Table 1',relation:'contradicts'}]},
    {reportNumber:'F-07',page:3,rationale:'The quoted text includes a closing bracket ] and a brace }.'}
  ];
  const complete=JSON.stringify({findings},null,2);
  const clipped=complete.slice(complete.indexOf('{',1));
  const options={role:'blue',segments,fileHash:'hash'};
  const expected=X.parse(complete,options);
  assert.equal(expected.items.length,2);
  for(const raw of [clipped,'```json\n'+clipped+'\n```']){
    const batch=X.parse(raw,options);
    assert.equal(batch.raw,raw);
    assert.equal(batch.partial,true);
    assert.equal(batch.diagnostics[0].code,'partial-blue-json');
    assert.deepEqual(batch.items.map(({id,...finding})=>finding),expected.items.map(({id,...finding})=>finding));
  }
  const broken=X.parse('{"findings":[{"reportNumber":"F-06","rationale":',options);
  assert.equal(broken.items.length,0);
  assert.equal(broken.diagnostics[0].code,'invalid-blue-json');
});

test('Korean table keeps each finding and trailing report',()=>{const raw='| 번호 | 쪽 | 위치(절, 그림, 표) | 유형 | 심각도 | 인용한 원문 | 왜 결함인가 | 확신 |\n|---|---|---|---|---|---|---|---|\n| 1 | 1 | 표 2 | 새 유형 | 확인필요 | international rate is 12% [4]. | 이유 | 낮음 |\n| 2 | 2 | 절 3 | 다른 유형 | 중 | | 별도 이유 | low |\n\n## 보고서\n후속 설명';const b=X.parse(raw,{role:'blue',segments,fileHash:'hash'});assert.equal(b.raw,raw);assert.equal(b.items.length,2);assert.equal(b.items[0].findingType,'새 유형');assert.equal(b.items[0].severity,'확인필요');assert.equal(b.items[0].confidence,'낮음');assert.equal(b.items[0].pageIndex,0);assert.equal(b.items[1].pageIndex,1);assert.equal(b.items[1].rationale,'별도 이유');assert.equal(b.report,'## 보고서\n후속 설명');});
test('prompt includes source only when explicitly requested',()=>{assert.doesNotMatch(X.buildPrompt({segments}),/The inter-/);assert.match(X.buildPrompt({segments,includeSource:true}),/The inter-/);});
test('page hints fall back and suggested candidates never bind automatically',()=>{const b=X.parse('{"findings":[{"quote":"international rate is 12% [4].","page":8}]}',{role:'blue',segments,fileHash:'hash'});assert.equal(b.items[0].matchStatus,'matched');assert.equal(b.items[0].pageIndex,0);globalThis.FalsifyPaperAnchors={find:()=>({status:'suggested',matches:[{segmentId:'s0',pageIndex:0,start:4,end:8,before:'test',score:0.8}]})};try{const s=X.parse('{"findings":[{"quote":"test"}]}',{role:'blue',segments,fileHash:'hash'}).items[0];assert.equal(s.matchStatus,'suggested');assert.equal(s.anchor,null);}finally{delete globalThis.FalsifyPaperAnchors;}});

test('real matcher preserves reported quote and source span through proposal reload',()=>{
  globalThis.FalsifyPaperAnchors=require('../dist/paper-anchors.js');
  try {
    const raw='```markdown\n| 번호 | 쪽 | 위치(절, 그림, 표) | 유형 | 심각도 | 인용한 원문 | 왜 결함인가 | 확신 |\n|---|---|---|---|---|---|---|---|\n| 1 | 1 | 표 2 | 자유 유형 | 확인필요 | international rate is 12% [4]. | 이유 \\| 보충 | 낮음 |\n| malformed | row |\n| 2 | 1 | 절 1 | 다른 유형 | 중 | | 두 번째 | low |\n```\n\n## 보고서\n설명';
    const batch=X.parse(raw,{role:'blue',segments,fileHash:'hash'});
    assert.equal(batch.items.length,2);assert.equal(batch.items[0].quote,'international rate is 12% [4].');
    assert.equal(batch.items[0].sourceQuote,'inter-\nnational rate is 12% [4].');
    assert.equal(batch.items[0].rationale,'이유 | 보충');assert.equal(batch.items[0].matchStatus,'matched');
    assert.equal(batch.report,'## 보고서\n설명');assert.equal(batch.diagnostics[0].code,'malformed-item');
    const P=require('../dist/external-proposals.js');const c=P.create({fileHash:'hash',role:'blue',segments});c.append(batch);c.append({...batch,id:'second'});
    const snapshot=c.snapshot();assert.equal(snapshot.items.length,2);assert.equal(snapshot.items[0].sourceRefs.length,2);
    const reload=P.create({fileHash:'hash',role:'blue',segments});reload.restore(snapshot);assert.deepEqual(reload.snapshot(),snapshot);
    const suggested=X.parse(JSON.stringify({findings:[{quote:'international rate is 13% [4].'}]}),{role:'blue',segments,fileHash:'hash'}).items[0];
    assert.equal(suggested.matchStatus,'suggested');assert.equal(suggested.anchor,null);
  } finally { delete globalThis.FalsifyPaperAnchors; }
});

test('red exchange handles structured tableEdits/visualEdits and gates visual prompt schema',()=>{
  const defaultPrompt=X.buildPrompt({role:'red',segments});
  assert.doesNotMatch(defaultPrompt,/tableEdits/);
  const optInPrompt=X.buildPrompt({role:'red',segments,includeVisualSchema:true});
  assert.match(optInPrompt,/tableEdits/);
  assert.match(optInPrompt,/visualEdits/);
  const batch=X.parse(JSON.stringify({
    fileHash:'hash',
    tableEdits:[{pageIndex:0,tableId:'t1',row:0,column:0,before:'12%',after:'15%'}],
    visualEdits:[{pageIndex:0,figureId:'f1',series:'s',pointIndex:0,before:12,after:15}]
  }),{role:'red',segments,fileHash:'hash',tables:[{id:'t1',pageIndex:0,cells:[{row:0,column:0,text:'12%'}]}]});
  assert.equal(batch.items.length,2);
  assert.equal(batch.items[0].kind,'table-cell');
  assert.equal(batch.items[0].matchStatus,'matched');
  assert.equal(batch.items[1].kind,'chart-point');
  assert.equal(batch.items[1].visualTarget.afterValue,15);
});

test('FLS-18 official B표 Markdown preserves each row, 1-based physical page, and ignores A0/D-1/D-2 tables',()=>{
  const docSegments=[
    {id:'p1-b0',pageIndex:0,label:'PDF p. 1',text:'The synthetic cohort total was 420 units across three sites.'},
    {id:'p2-b0',pageIndex:1,label:'PDF p. 2',text:'Table 1 lists 160, 140, and 100 units (sum 400).'}
  ];
  const raw=[
    '## A0. 실행 정보',
    '| 참가자 | 조건(A 공통 / B 자유) | 사용 서비스·도구 | 모델명과 버전 |',
    '|---|---|---|---|',
    '| 테스터 | A | 웹 채팅 | synth-model-1 |',
    '',
    '## B. 결함 및 확인필요 후보',
    'ID | 물리 페이지 | 위치(절·그림·표) | 유형 | 판정(아님/확인필요) | 심각도 | 정확한 원문 인용 | 대응 근거·이유·검산(원문/그림판독/가정 구분) | 확신 | 추가로 필요한 정보',
    '---|---|---|---|---|---|---|---|---|---',
    'F-1 | 1 (인쇄 101) | Results · Table 1 | D1 | 아님 | 되돌리지 않으면 공개할 수 없음 | The synthetic cohort total was 420 units | 원문 표 1 합계는 400(160+140+100)으로 본문 420과 불일치 | 높음 | 없음',
    'F-2 | 2쪽 | Table 1 각주 | D2 | 확인필요 | 미정—필요 근거 | Table 1 lists 160, 140, and 100 units | 외부 등록부 확인 필요 | 보통 | 프로토콜 원문 필요',
    'F-3 | 해당 없음 | Discussion | D3 | 맞음 | 가벼움 | | 별도 점검으로 해소된 항목 | 낮음 | 해당 없음',
    '',
    '## D-1 페이지·표 확인표',
    '| 물리 페이지 | 표·그림·참고문헌 등의 대상 | 확인 수단 | 실제 수행한 대조 | 미확인 영역·제약 | 관련 후보 ID |',
    '|---|---|---|---|---|---|',
    '| 1 | Table 1 | 추출 텍스트 | 합계 검산 | 없음 | F-1 |'
  ].join('\n');
  const b=X.parse(raw,{role:'blue',segments:docSegments,fileHash:'hash'});
  assert.equal(b.status,'ok');
  assert.equal(b.items.length,3);
  assert.equal(b.items[0].reportNumber,'F-1');
  assert.equal(b.items[0].pageIndex,0);
  assert.equal(b.items[0].locationLabel,'Results · Table 1');
  assert.equal(b.items[0].findingType,'D1');
  assert.equal(b.items[0].verdictLabel,'아님');
  assert.equal(b.items[0].severity,'되돌리지 않으면 공개할 수 없음');
  assert.equal(b.items[0].quote,'The synthetic cohort total was 420 units');
  assert.equal(b.items[0].matchStatus,'matched');
  assert.equal(b.items[0].confidence,'높음');
  assert.equal(b.items[0].uncertainty,'없음');
  assert.equal(b.items[1].reportNumber,'F-2');
  assert.equal(b.items[1].pageIndex,1);
  assert.equal(b.items[1].verdictLabel,'확인필요');
  assert.equal(b.items[1].uncertainty,'프로토콜 원문 필요');
  assert.equal(b.items[2].reportNumber,'F-3');
  assert.equal(b.items[2].pageIndex,null);
  assert.equal(b.items[2].verdictLabel,'맞음');
  assert.match(b.report,/D-1 페이지·표 확인표/);
});

test('FLS-18 15-column RFC 4180 CSV handles BOM, quoted commas/newlines, structured evidence, and metadata',()=>{
  const docSegments=[
    {id:'p1-b0',pageIndex:0,label:'PDF p. 1',text:'Alpha, "beta"\nline two sample text.'},
    {id:'p3-b0',pageIndex:2,label:'PDF p. 3',text:'Table 2 shows 15.6% vs 21%.'}
  ];
  const header='참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보';
  const row1='테스터,B,내 AI,synth-model-2,1,F-1,1,"Section 2, ""Results""",D1,아님,가벼움,"Alpha, ""beta""\nline two","요약 이유, 검산 포함\n[근거 1] 표 1 비교 | 인용: Table 1, row 2\n[참고] PDF p.3 Table 2",높음,"원자료, 부록 필요"';
  const row2='테스터,B,내 AI,synth-model-2,1,F-2,3,Table 2,D1,확인필요,미정—필요 근거,Table 2 shows 15.6% vs 21%.,수치 재확인 필요,보통,없음';
  const raw='\uFEFF'+[header,row1,row2].join('\r\n')+'\r\n';
  const b=X.parse(raw,{role:'blue',segments:docSegments,fileHash:'hash'});
  assert.equal(b.status,'ok');
  assert.equal(b.model,'synth-model-2');
  assert.equal(b.condition,'B');
  assert.equal(b.items.length,2);
  assert.equal(b.items[0].reportNumber,'F-1');
  assert.equal(b.items[0].pageIndex,0);
  assert.equal(b.items[0].locationLabel,'Section 2, "Results"');
  assert.equal(b.items[0].quote,'Alpha, "beta"\nline two');
  assert.equal(b.items[0].matchStatus,'matched');
  assert.equal(b.items[0].rationale,'요약 이유, 검산 포함');
  assert.deepEqual(b.items[0].evidence,[{relation:'표 1 비교',quote:'Table 1, row 2'}]);
  assert.deepEqual(b.items[0].references,['PDF p.3 Table 2']);
  assert.equal(b.items[0].uncertainty,'원자료, 부록 필요');
  assert.equal(b.items[1].reportNumber,'F-2');
  assert.equal(b.items[1].pageIndex,2);
  assert.equal(b.items[1].matchStatus,'matched');
});

test('mixed report with B표 Markdown and repeated fenced/embedded CSV reconciles without double-counting',()=>{
  const docSegments=[
    {id:'p1-b0',pageIndex:0,label:'PDF p. 1',text:'Alpha, beta\nsecond line total 420.'},
    {id:'p2-b0',pageIndex:1,label:'PDF p. 2',text:'Control group n=50.'}
  ];
  const mixed=[
    '## B. 결함 및 확인필요 후보',
    '| ID | 물리 페이지 | 위치(절·그림·표) | 유형 | 판정(아님/확인필요) | 심각도 | 정확한 원문 인용 | 대응 근거·이유·검산(원문/그림판독/가정 구분) | 확신 | 추가로 필요한 정보 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| F-1 | 1 | Section 1 | D1 | 아님 | 가벼움 | Alpha, beta second line total 420. | 표 합계와 다름 | 높음 | 원자료 필요 |',
    '| F-2 | 2 | Methods | D3 | 확인필요 | 미정—필요 근거 | Control group n=50. | 표본 수 확인 필요 | 보통 | 프로토콜 |',
    '',
    '## CSV',
    '```csv',
    '참가자,조건,탐지기,모델,실행번호,ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보',
    '테스터,A,내 AI,synth-model-3,1,F-1,1,"Section 1, para 2",D1,아님,가벼움,"Alpha, beta\nsecond line total 420.","표 합계와 다름, 검산=400",높음,',
    '테스터,A,내 AI,synth-model-3,1,F-2,2,Methods,D3,확인필요,미정—필요 근거,Control group n=50.,표본 수 확인 필요,보통,프로토콜',
    '```'
  ].join('\n');
  const b=X.parse(mixed,{role:'blue',segments:docSegments,fileHash:'hash'});
  assert.equal(b.items.length,2,'repeated CSV must not double-count B표 rows');
  assert.equal(b.model,'synth-model-3');
  assert.equal(b.condition,'A');
  assert.equal(b.items[0].quote,'Alpha, beta\nsecond line total 420.','CSV multiline quote preserved');
  assert.equal(b.items[0].locationLabel,'Section 1, para 2');
  assert.equal(b.items[0].uncertainty,'원자료 필요','missing CSV field backfilled from Markdown row');
  assert.equal(b.items[1].reportNumber,'F-2');

  const jsonAliases=X.parse(JSON.stringify({
    findings:[{id:'J-1',page:1,location:'Results',defect_type:'D1',verdict:'아님',reason:'Alias reason',confidence:0.85,quote:'Control group n=50.'}]
  }),{role:'blue',segments:docSegments,fileHash:'hash'});
  assert.equal(jsonAliases.items.length,1);
  assert.equal(jsonAliases.items[0].locationLabel,'Results');
  assert.equal(jsonAliases.items[0].findingType,'D1');
  assert.equal(jsonAliases.items[0].verdictLabel,'아님');
  assert.equal(jsonAliases.items[0].rationale,'Alias reason');
  assert.equal(jsonAliases.items[0].confidence,'0.85');

  const unfencedMixed=[
    '## B. 결함 및 확인필요 후보',
    '| ID | 물리 페이지 | 위치(절·그림·표) | 유형 | 판정(아님/확인필요) | 심각도 | 정확한 원문 인용 | 대응 근거·이유·검산(원문/그림판독/가정 구분) | 확신 | 추가로 필요한 정보 |',
    '|---|---|---|---|---|---|---|---|---|---|',
    '| F-1 | 1 | Section 1 | D1 | 아님 | 가벼움 | Alpha, beta second line total 420. | 표 합계와 다름 | 높음 | 없음 |',
    '',
    'ID,물리 페이지,위치(절·그림·표),유형,판정(아님/확인필요),심각도,정확한 원문 인용,대응 근거·이유·검산,확신,추가로 필요한 정보',
    'F-1,1,Section 1,D1,아님,가벼움,"Alpha, beta\nsecond line total 420.","표 합계와 다름",높음,없음',
    'F-3,2,Methods,D2,확인필요,미정—필요 근거,Control group n=50.,추가 확인 항목,보통,등록부',
    '',
    '## C. 별도 점검 기록',
    '정상 항목 기록'
  ].join('\n');
  const u=X.parse(unfencedMixed,{role:'blue',segments:docSegments,fileHash:'hash'});
  assert.equal(u.items.length,2,'unfenced embedded CSV deduplicates F-1 and keeps unique F-3 without absorbing trailing heading');
  assert.equal(u.items[0].reportNumber,'F-1');
  assert.equal(u.items[1].reportNumber,'F-3');
});
