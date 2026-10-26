const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const C=require('../dist/controlled-comparison.js'),H=require('../dist/harness-core.js');
const BUNDLE='d0f2897e4b705bd794ded542c83fc5b55fbec5ddc584651a4523042f6fefe7ed';
const ARMS=['ORIGINAL','E1','H1'];
let passed=0;const checks=[];
function check(name,fn){return Promise.resolve().then(fn).then(()=>{checks.push(name);passed++;});}

function harnessFor(arm,patch={}){
  const slug=arm.toLowerCase();
  const executable=patch.executable||'/opt/synthetic/'+slug+'-python';
  const runner=patch.runner||'/opt/synthetic/'+slug+'-python-runner.py';
  return {schema:'falsify.harness.v1',id:'synthetic-blue-fixed',name:'Synthetic BLUE fixed',version:'0.3.3',role:'blue',instructions:'Review only the supplied synthetic text. Do not use an answer key.',maxCalls:patch.maxCalls||8,adapter:{type:'stdio',executable,args:patch.args||[runner,'--diagnostic','0.3.3']},settings:Object.assign({strategy:'fixed-synthetic',model:'claude-opus-5-5',bundleSha256:BUNDLE,internalMaxCalls:4,scope:'document-only-synthetic',note:'keep-me',auditDirectory:'/opt/synthetic/'+slug+'-audits'},patch.settings||{})};
}
function findingFor(text){const dot=text.indexOf('.');return {id:'f1',segmentId:'s1',quote:text.slice(0,dot+1),rationale:'Synthetic tension between the two sentences.',uncertainty:'Not a truth claim.',evidence:[{segmentId:'s1',quote:text.slice(dot+2),relation:'contrasts'}]};}
function baseMap(){return {'/opt/synthetic/original-python':'portable-python','/opt/synthetic/original-python-runner.py':'portable-runner.py','/opt/synthetic/e1-python':'portable-python','/opt/synthetic/e1-python-runner.py':'portable-runner.py','/opt/synthetic/h1-python':'portable-python','/opt/synthetic/h1-python-runner.py':'portable-runner.py'};}

async function makeRecord(arm,opts={}){
  const h=opts.harness||harnessFor(arm,opts.patch||{});
  const text=opts.text||('Synthetic '+arm+' alpha. Synthetic '+arm+' beta.');
  const segments=[{id:'s1',label:'Synthetic',text}];
  const sourceHash=await C.sourceTextHash(segments);
  const fileHash=opts.fileHash||await C.digestHex('synthetic-file-'+arm);
  const revision=opts.revision||('rev-'+arm.toLowerCase());
  const canonicalText=opts.harnessCanonical===undefined?C.canonical(h):opts.harnessCanonical;
  const machine=typeof canonicalText==='string'?await C.digestHex(canonicalText):await C.digestHex(C.canonical(h));
  const harnessHash=opts.harnessHash===undefined?machine:opts.harnessHash;
  const findings=opts.withFinding?[findingFor(text)]:opts.findings||[];
  const status=opts.status||'ok';
  const requestId=opts.requestId||('req-'+arm.toLowerCase()+(opts.suffix||''));
  const request={schema:'falsify.document-blue.v1',revision,requestId,sourceHash,segments,maxCalls:opts.requestMaxCalls||h.maxCalls,consent:true,harness:h,harnessCanonical:canonicalText,executionConsent:true};
  const response=opts.job==='failed'||opts.job==='cancelled'?null:{schema:'falsify.document-blue.v1',revision,sourceHash,status,findings,harness:h,harnessHash:machine,model:C.appModelLabel(h),coverage:opts.coverage===undefined?{complete:true,calls:1,chunks:1,completedChunks:1,reread:{status:'not-needed',selectedSegments:[],deliveredChars:0,truncated:false}}:opts.coverage,isolation:'synthetic application payload separation; custom harness isolation not verified; not a truth claim'};
  const provenance=opts.provenance||'local-codex';
  const run=opts.omitRun?null:{id:opts.id||('run-'+arm.toLowerCase()+(opts.suffix||'')),createdAt:'2026-01-01T00:00:00.000Z',role:'blue',revision,fileHash,sourceHash,segments,harness:h,harnessHash,maxCalls:opts.runMaxCalls||h.maxCalls,level:null,model:provenance==='local-codex'?(response?response.model:C.appModelLabel(h)):'manual-model-unverified',provenance,response,requestId};
  if(opts.corruptSource&&run)run.sourceHash='ab'.repeat(32);
  const pending=opts.job?{schema:'falsify.pending-job.v1',role:'blue',requestId,companionInstance:'ci1.'+'ab'.repeat(32),sourceHash,fileHash,revision,harnessHash,requestFingerprint:'cd'.repeat(32),requestBytesDigest:opts.requestBytesDigest||await C.digestHex('bytes-'+requestId),postReceipt:'accepted',disposition:opts.job,createdAt:1,finishedAt:2,expiresAt:null,request}:null;
  const entry={id:run?run.id:(opts.id||('job-'+requestId)),arm,run,pending:pending||undefined,jobState:opts.job,verifiedModel:opts.verifiedModel,requestBytesDigest:opts.requestBytesDigest,rawResponseSha256:opts.rawResponseSha256,cost:opts.cost};
  if(!opts.omitRequest)entry.request=request;
  if(opts.attachResult)entry.result={schema:'falsify.document-blue.v1',revision,sourceHash,status:'ok',findings:[],harness:h,harnessHash:machine,model:C.appModelLabel(h),isolation:'discarded synthetic result'};
  return {entry,sourceHash,fileHash,revision,harness:h,text};
}
async function build(specs,options={}){
  const made=[];for(const spec of specs)made.push(await makeRecord(spec.arm,spec));
  const pathMap=Object.assign(baseMap(),options.pathMap||{});
  for(const key of options.unmap||[])delete pathMap[key];
  const portable=options.portable===null?undefined:C.portableProjection(harnessFor('ORIGINAL'),pathMap);
  const arms={};for(const name of ARMS){const found=made.find(item=>item.entry.arm===name);arms[name]={sourceHash:found.sourceHash,fileHash:found.fileHash,revision:found.revision};}
  const goldVersion=options.goldVersion===undefined?'synthetic-fixture-1':options.goldVersion;
  const input={strategy:{id:'synthetic-blue-fixed',version:'0.3.3',bundleSha256:BUNDLE,pathMap,machineSettingKeys:['auditDirectory'],...(portable?{portable}:{})},fixed:{requestedModel:'claude-opus-5-5',maxCalls:8,internalMaxCalls:4,goldVersion,protocolVersion:'falsify.document-blue.v1',caseLabel:'synthetic-controlled-blue'},arms,gold:options.gold===undefined?{version:'synthetic-fixture-1',scientificGold:false,items:[{id:'g1',segmentId:'s1',quote:'Synthetic quote is not used.'}]}:options.gold,records:made.map(item=>item.entry),reviews:options.reviews||[]};
  if(goldVersion===null)input.gold=null;
  return input;
}
const row=(view,id)=>view.records.find(item=>item.id===id);
const codes=view=>view.warnings.map(item=>item.code);
const happySpecs=()=>[{arm:'ORIGINAL',withFinding:true,cost:0},{arm:'E1'},{arm:'H1',status:'abstain',coverage:{complete:false,chunks:1,completedChunks:0},omitRequest:true}];

(async()=>{
  const sample=harnessFor('ORIGINAL');
  await check('canonical matches harness-core',()=>assert.equal(C.canonical(sample),H.canonical(sample)));
  await check('projection keeps semantic args and drops only auditDirectory',()=>{
    const projected=C.portableProjection(sample,{...baseMap(),'--diagnostic':'stripped'});
    assert.deepEqual(projected.adapter.args,['portable-runner.py','--diagnostic','0.3.3']);
    assert.equal(projected.adapter.executable,'portable-python');
    assert.equal(projected.settings.note,'keep-me');
    assert.equal(projected.settings.internalMaxCalls,4);
    assert.equal(Object.hasOwn(projected.settings,'auditDirectory'),false);
    assert.deepEqual(C.unmappedAdapterPaths(sample,baseMap()),[]);
  });
  const source=fs.readFileSync(path.join(__dirname,'../dist/controlled-comparison.js'),'utf8');
  await check('module has no DOM, storage, network, or hard-coded local path',()=>{
    assert.equal(/\blocalStorage\b|\bdocument\.|\bfetch\(|XMLHttpRequest|\bindexedDB\b/.test(source),false);
    assert.equal(/\/home\/|\/Users\/|C:\\\\/.test(source),false);
  });

  const happy=await build(happySpecs());
  const snap=JSON.stringify(happy);
  const view=await C.compare(happy);
  await check('input is not mutated',()=>assert.equal(JSON.stringify(happy),snap));
  await check('realistic ledger result separates strategy, requested model, and verified model',()=>{
    assert.equal(view.ok,true);
    assert.equal(view.comparisonReady,true);
    assert.equal(view.detectionCorrectness,'not-inferred');
    assert.equal(view.ranking,'not-computed');
    assert.equal(view.scientificGold,false);
    assert.equal(view.machineConfigIsStrategyIdentity,false);
    assert.equal(view.grouping,'portable-strategy-version-bundle');
    assert.equal(view.fixed.requestedModel,'claude-opus-5-5');
    assert.equal(view.fixed.verifiedModel,'unknown');
    const original=row(view,'run-original');
    assert.equal(original.class,'human-unreviewed');
    assert.equal(original.requestedModel,'claude-opus-5-5');
    assert.equal(original.verifiedModel,'unknown');
    assert.equal(original.appModelLabel,'custom-stdio-model-unverified');
    assert.equal(original.findingCount,1);
    assert.equal(original.matchedJudgments,'unknown');
    assert.equal(original.responseImmutable,'unknown');
    assert.equal(original.machineConfigIsStrategyIdentity,false);
    assert.equal(view.arms.ORIGINAL.matchedFindingJudgments,'unknown');
    assert.equal(view.arms.ORIGINAL.calls.sum,1);
    assert.equal(view.arms.ORIGINAL.calls.verified,false);
    assert.equal(view.arms.ORIGINAL.cost,'unknown');
    assert.equal(view.gold.quotesUsed,false);
    assert.equal(JSON.stringify(view).includes('Synthetic ORIGINAL alpha'),false);
    assert.equal(JSON.stringify(view).includes('Synthetic tension'),false);
    assert.equal(JSON.stringify(view).includes('Synthetic quote is not used.'),false);
    assert.equal(JSON.stringify(view).includes('"mean"'),false);
    assert.equal(Object.hasOwn(view,'accuracy'),false);
    assert.equal(JSON.stringify(view).includes('"accuracy":'),false);
    assert.equal(codes(view).includes('cost_not_representable'),true);
    assert.equal(codes(view).some(code=>code==='incompatible_condition:source_hash'),false);
    assert.ok(view.integrationGaps.includes('does-not-render-ui'));
    assert.ok(view.integrationGaps.includes('does-not-sync-with-controlled-blue-preparer'));
  });
  await check('ok zero, abstain, and missing calls stay in their own classes',()=>{
    const zero=row(view,'run-e1'),abstain=row(view,'run-h1');
    assert.equal(zero.class,'completed-zero-findings');
    assert.equal(zero.findingCount,0);
    assert.equal(view.arms.E1.denominators.zeroFindings.numerator,1);
    assert.equal(view.arms.E1.denominators.zeroFindings.denominator,1);
    assert.equal(abstain.class,'abstain');
    assert.equal(abstain.included,true);
    assert.equal(view.arms.H1.counts.abstain,1);
    assert.equal(view.arms.H1.counts['completed-zero-findings'],0);
    assert.equal(view.arms.H1.denominators.zeroFindings.denominator,0);
    assert.equal(view.arms.H1.calls,'unknown');
    assert.equal(abstain.calls,'unknown');
    assert.equal(abstain.responseImmutable,'unknown');
  });

  const unverified=await build([{arm:'ORIGINAL',provenance:'manual-unverified',verifiedModel:'claude-opus-5-5',withFinding:true},{arm:'E1',withFinding:true},{arm:'H1',verifiedModel:'observed-fixture',withFinding:true}]);
  const unverifiedView=await C.compare(unverified);
  await check('unverified and placeholder claims stay unknown',()=>{
    assert.equal(row(unverifiedView,'run-original').verifiedModel,'unknown');
    assert.equal(row(unverifiedView,'run-original').requestedModel,'claude-opus-5-5');
    assert.equal(row(unverifiedView,'run-e1').verifiedModel,'unknown');
    assert.deepEqual(row(unverifiedView,'run-h1').verifiedModel,{observed:'observed-fixture',certified:false});
    assert.equal(unverifiedView.fixed.verifiedModel,'unknown');
    assert.equal(unverifiedView.arms.H1.verifiedModel.observed,'observed-fixture');
    assert.equal(unverifiedView.arms.H1.verifiedModel.certified,false);
    assert.equal(codes(unverifiedView).includes('unverified_model'),true);
    assert.equal(row(unverifiedView,'run-original').class,'human-unreviewed');
  });

  const missingGold=await build([{arm:'ORIGINAL',withFinding:true},{arm:'E1'},{arm:'H1',status:'refusal'}],{goldVersion:null,reviews:[{id:'rev-gold',runId:'run-original',caseLabel:'synthetic-controlled-blue',protocolVersion:'falsify.document-blue.v1',verdict:'supported',score:5,judgments:[{goldId:'g1',findingId:'f1',judgment:'matched'}]}]});
  const missingView=await C.compare(missingGold);
  await check('missing gold stays unknown and is not a zero match',()=>{
    assert.equal(row(missingView,'run-original').class,'gold-unknown');
    assert.equal(row(missingView,'run-original').matchedJudgments,'unknown');
    assert.equal(missingView.arms.ORIGINAL.matchedFindingJudgments,'unknown');
    assert.equal(missingView.gold.usableItems,'unknown');
    assert.equal(missingView.fixed.goldVersion,'unknown');
    assert.equal(missingView.comparisonReady,false);
    assert.equal(codes(missingView).includes('gold_missing'),true);
    assert.equal(row(missingView,'run-h1').class,'refusal');
    assert.equal(missingView.arms.H1.counts['completed-zero-findings'],0);
  });

  const adjudicated=await build([
    {arm:'ORIGINAL',withFinding:true},
    {arm:'E1',withFinding:true},
    {arm:'H1',withFinding:true}
  ],{reviews:[
    {id:'gold-match',runId:'run-original',caseLabel:'synthetic-controlled-blue',protocolVersion:'falsify.document-blue.v1',verdict:'supported',score:4,judgments:[{goldId:'g1',findingId:'f1',judgment:'matched'}]},
    {id:'gold-none',runId:'run-e1',caseLabel:'synthetic-controlled-blue',protocolVersion:'falsify.document-blue.v1',verdict:'unsupported',score:2,judgments:[{goldId:'g1',findingId:'f1',judgment:'unmatched'}]},
    {id:'subjective',runId:'run-h1',caseLabel:'synthetic-controlled-blue',verdict:'supported',score:5,comparison:{outputFileHash:'ignored',selected:[],assessments:[{id:'c1',verdict:'detected',note:'synthetic person',quoteOverlapFindingIds:['f1']}]}},
    {id:'no-protocol',runId:'run-h1',caseLabel:'synthetic-controlled-blue',verdict:'supported',score:3,judgments:[{goldId:'g1',findingId:'f1',judgment:'matched'}]}
  ]});
  const judged=await C.compare(adjudicated);
  await check('human gold judgments are separate from subjective verdicts and quote overlap',()=>{
    assert.equal(row(judged,'run-original').class,'matched-findings');
    assert.equal(row(judged,'run-original').humanAdjudication.goldJudgments.matched,1);
    assert.equal(row(judged,'run-e1').class,'human-reviewed-no-match');
    assert.equal(row(judged,'run-e1').matchedJudgments,0);
    assert.equal(judged.arms.E1.matchedFindingJudgments,0);
    assert.equal(row(judged,'run-h1').class,'human-unreviewed');
    assert.equal(row(judged,'run-h1').humanAdjudication.reviews[0].assessments[0].verdict,'detected');
    assert.equal(row(judged,'run-h1').humanAdjudication.quoteOverlapIgnored,true);
    assert.equal(row(judged,'run-h1').humanAdjudication.verdictIsNotAccuracy,true);
    assert.equal(JSON.stringify(judged).includes('quoteOverlapFindingIds'),false);
    assert.equal(JSON.stringify(judged).includes('synthetic person'),false);
    assert.equal(judged.detectionCorrectness,'not-inferred');
    assert.equal(codes(judged).includes('review_without_judgments'),true);
    assert.equal(codes(judged).includes('review_protocol_unknown'),true);
  });

  const replayInput=await build([
    {arm:'ORIGINAL',withFinding:true,requestId:'req-shared',suffix:'-a'},
    {arm:'ORIGINAL',withFinding:true,requestId:'req-shared',suffix:'-b',text:'Synthetic ORIGINAL alpha. Synthetic ORIGINAL beta.'},
    {arm:'E1',suffix:'-a',requestId:'req-e1-a',requestBytesDigest:'aa'.repeat(32)},
    {arm:'E1',suffix:'-b',requestId:'req-e1-b',requestBytesDigest:'aa'.repeat(32)},
    {arm:'H1'}
  ]);
  const replayView=await C.compare(replayInput);
  await check('duplicate request id or request bytes are replays',()=>{
    for(const id of ['run-original-a','run-original-b','run-e1-a','run-e1-b']){
      assert.equal(row(replayView,id).class,'excluded');
      assert.equal(row(replayView,id).independence,'replay');
      assert.ok(row(replayView,id).reasons.includes('repeat_replay'));
    }
    assert.equal(row(replayView,'run-original-a').requestRevisionIdentity,'req-shared@rev-original');
    assert.equal(replayView.arms.ORIGINAL.attempts,0);
    assert.equal(replayView.arms.ORIGINAL.independence,'replay');
    assert.equal(codes(replayView).includes('repeat_replay'),true);
    assert.equal(replayView.comparisonReady,false);
  });

  const distinct=await build([
    {arm:'ORIGINAL',suffix:'-a',requestId:'req-original-a'},
    {arm:'ORIGINAL',suffix:'-b',requestId:'req-original-b'},
    {arm:'E1'},
    {arm:'H1'}
  ]);
  const distinctView=await C.compare(distinct);
  await check('identical outputs from distinct requests stay separate',()=>{
    const left=row(distinctView,'run-original-a'),right=row(distinctView,'run-original-b');
    assert.equal(left.included,true);
    assert.equal(right.included,true);
    assert.equal(left.class,'completed-zero-findings');
    assert.equal(right.class,'completed-zero-findings');
    assert.equal(left.independence,'unknown');
    assert.equal(right.independence,'unknown');
    assert.equal(left.responseHash,right.responseHash);
    assert.notEqual(left.requestId,right.requestId);
    assert.equal(distinctView.arms.ORIGINAL.attempts,2);
    assert.equal(distinctView.arms.ORIGINAL.independence,'unknown');
    assert.equal(codes(distinctView).includes('independence_unknown'),true);
    assert.equal(codes(distinctView).includes('repeat_replay'),false);
  });

  const paths=await build([
    {arm:'ORIGINAL',suffix:'-a'},
    {arm:'ORIGINAL',suffix:'-b',patch:{executable:'/opt/synthetic/original-alt-python',runner:'/opt/synthetic/original-alt-python-runner.py',settings:{auditDirectory:'/opt/synthetic/original-alt-audits'}}},
    {arm:'E1'},
    {arm:'H1'}
  ],{pathMap:{'/opt/synthetic/original-alt-python':'portable-python','/opt/synthetic/original-alt-python-runner.py':'portable-runner.py'}});
  const pathView=await C.compare(paths);
  await check('path-only config differences share a strategy and keep distinct machine hashes',()=>{
    const left=row(pathView,'run-original-a'),right=row(pathView,'run-original-b');
    assert.equal(left.included,true);
    assert.equal(right.included,true);
    assert.equal(left.portableHash,right.portableHash);
    assert.notEqual(left.machineConfigHash,right.machineConfigHash);
    assert.equal(left.machineConfigHashVerified,true);
    assert.equal(right.machineConfigHashVerified,true);
    assert.equal(pathView.machineConfigIsStrategyIdentity,false);
    assert.equal(left.adapter.projectedArgs.includes('--diagnostic'),true);
    assert.equal(left.adapter.projectedArgs.includes('0.3.3'),true);
    assert.deepEqual(pathView.arms.ORIGINAL.machineConfigHashes.slice().sort(),[left.machineConfigHash,right.machineConfigHash].sort());
    assert.equal(codes(pathView).includes('machine_config_not_strategy_identity'),true);
    assert.equal(pathView.comparisonReady,true);
  });

  const semantic=await build([
    {arm:'ORIGINAL',patch:{args:['/opt/synthetic/original-python-runner.py','--rewrite','0.4.0']}},
    {arm:'E1'},
    {arm:'H1'}
  ]);
  const semanticView=await C.compare(semantic);
  await check('semantic adapter arguments are preserved and are a different strategy',()=>{
    const changed=row(semanticView,'run-original');
    assert.equal(changed.included,false);
    assert.ok(changed.reasons.includes('portable_strategy'));
    assert.deepEqual(changed.adapter.args,['/opt/synthetic/original-python-runner.py','--rewrite','0.4.0']);
    assert.equal(changed.adapter.projectedArgs.includes('--rewrite'),true);
    assert.equal(changed.adapter.projectedArgs.includes('0.4.0'),true);
    assert.equal(changed.adapter.projectedArgs.includes('--diagnostic'),false);
    assert.equal(codes(semanticView).includes('incompatible_condition:portable_strategy'),true);
  });
  const flagged=await C.compare({...semantic,strategy:{...semantic.strategy,pathMap:{...semantic.strategy.pathMap,'--diagnostic':'stripped'}}});
  await check('a path map cannot erase a flag',async()=>{
    assert.equal(flagged.ok,false);
    assert.ok(flagged.errors.includes('pathMap.flag'));
    assert.equal(flagged.records,undefined);
  });

  const unmapped=await build([{arm:'ORIGINAL'},{arm:'E1'},{arm:'H1'}],{unmap:['/opt/synthetic/h1-python']});
  const unmappedView=await C.compare(unmapped);
  await check('an unmapped adapter path is a condition, not a silent match',()=>{
    const h1=row(unmappedView,'run-h1');
    assert.equal(h1.included,false);
    assert.ok(h1.reasons.includes('unmapped_adapter_path'));
    assert.equal(h1.adapter.executable,'/opt/synthetic/h1-python');
    assert.equal(h1.adapter.projectedExecutable,'/opt/synthetic/h1-python');
    assert.equal(codes(unmappedView).includes('incompatible_condition:unmapped_adapter_path'),true);
  });

  const budget=await build([{arm:'ORIGINAL',runMaxCalls:3,requestMaxCalls:3},{arm:'E1'},{arm:'H1'}]);
  const budgetView=await C.compare(budget);
  await check('a different call budget is an incompatible condition',()=>{
    assert.ok(row(budgetView,'run-original').reasons.includes('budget'));
    assert.equal(row(budgetView,'run-original').included,false);
    assert.equal(row(budgetView,'run-original').adapter.args.includes('--diagnostic'),true);
    assert.equal(codes(budgetView).includes('incompatible_condition:budget'),true);
  });

  const sourceMismatch=await build([{arm:'ORIGINAL',corruptSource:true},{arm:'E1'},{arm:'H1'}]);
  const sourceView=await C.compare(sourceMismatch);
  await check('a source hash that disagrees with its arm is incompatible',()=>{
    assert.ok(row(sourceView,'run-original').reasons.includes('source_hash'));
    assert.equal(row(sourceView,'run-original').included,false);
    assert.equal(codes(sourceView).includes('incompatible_condition:source_hash'),true);
  });

  const compact=C.canonical(sample);
  const spaced=JSON.stringify(JSON.parse(compact),null,2);
  const spacedHash=await C.digestHex(spaced),compactHash=await C.digestHex(compact);
  const canonicalInput=await build([
    {arm:'ORIGINAL',harnessCanonical:spaced,harnessHash:compactHash},
    {arm:'E1'},
    {arm:'H1'}
  ]);
  const canonicalView=await C.compare(canonicalInput);
  await check('harnessCanonical is hashed as exact text and is not rewritten',()=>{
    const original=row(canonicalView,'run-original');
    assert.notEqual(spaced,compact);
    assert.equal(original.machineConfigHash,spacedHash);
    assert.notEqual(original.machineConfigHash,compactHash);
    assert.equal(original.machineConfigHashVerified,false);
    assert.ok(original.reasons.includes('harness_canonical'));
    assert.equal(original.included,false);
    assert.equal(codes(canonicalView).includes('incompatible_condition:harness_canonical'),true);
  });

  const failed=await build([
    {arm:'ORIGINAL',job:'failed',omitRun:true,id:'job-failed'},
    {arm:'E1',job:'cancelled',omitRun:true,id:'job-cancelled'},
    {arm:'H1'},
    {arm:'ORIGINAL',job:'failed',omitRun:true,id:'job-discarded',suffix:'-discarded',attachResult:true,requestId:'req-discarded'}
  ]);
  const failedView=await C.compare(failed);
  await check('failed and cancelled are not completed-zero-findings',()=>{
    const failure=row(failedView,'job-failed'),cancel=row(failedView,'job-cancelled'),discarded=row(failedView,'job-discarded');
    assert.equal(failure.class,'failed');
    assert.equal(failure.included,true);
    assert.equal(failure.findingCount,'unknown');
    assert.equal(failure.outcome,'failed');
    assert.equal(cancel.class,'cancelled');
    assert.equal(cancel.findingCount,'unknown');
    assert.equal(failedView.arms.ORIGINAL.counts.failed,1);
    assert.equal(failedView.arms.ORIGINAL.counts['completed-zero-findings'],0);
    assert.equal(failedView.arms.ORIGINAL.denominators.failedExcludedFromZeroFindings,1);
    assert.equal(failedView.arms.E1.counts.cancelled,1);
    assert.equal(failedView.arms.E1.denominators.zeroFindings.numerator,0);
    assert.equal(discarded.class,'excluded');
    assert.equal(discarded.outcome,'failed');
    assert.notEqual(discarded.outcome,'completed-zero-findings');
    assert.ok(discarded.reasons.includes('discarded_result'));
    assert.equal(discarded.findingCount,'unknown');
    assert.equal(failedView.comparisonReady,false);
  });

  const refused=await C.compare({...happy,gold:{version:'synthetic-fixture-1',scientificGold:true,items:[{id:'g1'}]}});
  await check('scientific gold is refused',()=>{
    assert.equal(refused.ok,false);
    assert.ok(refused.errors.includes('gold')||refused.errors.includes('gold.scientificGold'));
  });

  console.log(JSON.stringify({passed,checks},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
