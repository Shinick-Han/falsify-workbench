/* Portable comparison view-model for existing BLUE run records.

Pure: no DOM, no network, no storage. crypto.subtle is used only to hash
strings the caller already holds. Successful execution is not detection.
*/
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.FalsifyControlledComparison=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const SCHEMA='falsify.controlled-comparison-view.v1';
  const BLUE='falsify.document-blue.v1';
  const ARMS=Object.freeze(['ORIGINAL','E1','H1']);
  const PRIMARY=Object.freeze(['failed','cancelled','refusal','abstain','completed-zero-findings','human-unreviewed','matched-findings','human-reviewed-no-match','gold-unknown']);
  const OK_CLASSES=Object.freeze(['completed-zero-findings','human-unreviewed','matched-findings','human-reviewed-no-match','gold-unknown']);
  const MACHINE_SETTING='auditDirectory';
  const CLI_DEFAULT=Object.freeze({codex:'gpt-6.1-sol',claude:'claude-opus-5-5'});
  const HEX=/^[0-9a-f]{64}$/;
  const FORBIDDEN=new Set(['gold','plan','comparison','reviews','assessments','answer','answerkey','redplan','priorresponse','filename','sourcename','file','bytes','pdf','pdfbytes','token','authorization','secret','password','apikey','api_key','bearer','cookie','session','findings','candidates']);
  const EXCLUDE=new Set(['portable_strategy','unmapped_adapter_path','requested_model','budget','source_hash','file_hash','revision','harness_canonical','machine_hash_unverified','harness_not_frozen','request_id','consent','response_not_immutable','app_model_label','recorded_metadata','non_ok_findings','discarded_result','job_state_unknown','job_not_terminal','blind_violation','duplicate_record','arm','role','not_an_execution','record_shape','response_status','source_text_unseen']);
  const INTEGRATION_GAPS=Object.freeze([
    'does-not-render-ui','does-not-read-or-write-storage','does-not-sync-with-controlled-blue-preparer','does-not-assign-arms',
    'harnessCanonical-is-not-stored-on-ledger-runs','requestBytesDigest-is-not-stored-on-ledger-runs',
    'failed-and-cancelled-jobs-are-pending-records-not-ledger-runs','ledger-reviews-have-no-gold-judgments-or-protocolVersion',
    'evidence-quotes-are-not-revalidated','response-immutability-is-unknown-without-rawResponseSha256','file-hash-is-not-recomputed',
    'cost-is-unknown','verified-model-is-not-stored-on-ledger-runs','quote-overlap-is-not-a-match','no-network-and-no-model-call'
  ]);
  const NOTICE='View-model only. A successful result, output text, or count is not accuracy. Failed and cancelled jobs are not completed-zero-findings. Portable strategy id, version, and bundle hash are the strategy identity; machine config hashes are not. Requested model and verified model stay separate. Missing gold, calls, cost, and verification stay unknown. This module does not render a comparison or sync records.';

  const MESSAGES={
    duplicate_gold:'A gold id occurs more than once. Judgments on that id are not matches.',
    gold_missing:'Gold version or gold items are absent. Matched findings are unknown, not zero.',
    unmatched_gold:'A judgment names a gold id that is not in the usable gold list.',
    duplicate_judgment:'A repeated human judgment was counted once.',
    match_without_finding:'A matched judgment has no finding on that completed response.',
    review_condition_mismatch:'A review case label or protocol version differs from the fixed conditions and was left out.',
    review_protocol_unknown:'A review has no protocolVersion. The current ledger does not store one, so it was not applied as gold adjudication.',
    review_without_judgments:'A ledger review has a subjective verdict and no gold judgments. It is not a match and not a no-match.',
    multiple_reviews:'More than one condition-matched gold review exists. None was applied.',
    unverified_model:'A verified model was claimed without a local-codex observation and is unknown.',
    repeat_replay:'The same request id, request/revision identity, or request-byte digest was repeated. Those records are replays and are outside the denominators.',
    independence_unknown:'Final responses match across separate requests. Deterministic or zero-finding runs can match. The records stay separate and independence is unknown.',
    request_identity_unknown:'A request id is missing, so this record cannot be called a distinct request or a replay.',
    machine_config_not_strategy_identity:'Machine config hashes differ. They are not a second strategy. Portable id, version, and bundle hash are unchanged.',
    discarded_result:'A failed or cancelled record still carried a result. The result was ignored and the record is not completed-zero-findings.',
    cost_not_representable:'A cost value was present and ignored. Cost stays unknown.',
    arm_missing:'An arm has no included record. Side-by-side preparation is not ready.',
    portable_strategy_unfixed:'Records do not share one portable projection and no reference projection was supplied. No strategy was chosen for them.'
  };

  function sorted(value){
    if(Array.isArray(value))return value.map(sorted);
    if(value&&typeof value==='object'){const out={};for(const key of Object.keys(value).sort())out[key]=sorted(value[key]);return out;}
    return value;
  }
  function canonical(value){return JSON.stringify(sorted(value));}
  function same(a,b){return canonical(a)===canonical(b);}
  function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
  function finite(value,depth){
    if(depth>40)return false;
    if(typeof value==='number')return Number.isFinite(value);
    if(value===null||typeof value==='string'||typeof value==='boolean')return true;
    if(Array.isArray(value))return value.every(item=>finite(item,depth+1));
    if(plain(value))return Object.keys(value).every(key=>finite(value[key],depth+1));
    return false;
  }
  function unique(list){const out=[],seen=new Set();for(const item of list)if(!seen.has(item)){seen.add(item);out.push(item);}return out;}
  async function digestHex(text){
    if(typeof text!=='string'){const error=new Error('digest_unavailable');error.code='digest_unavailable';throw error;}
    const subtle=globalThis.crypto&&globalThis.crypto.subtle;
    if(!subtle||typeof subtle.digest!=='function'){const error=new Error('digest_unavailable');error.code='digest_unavailable';throw error;}
    const buf=await subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf),byte=>byte.toString(16).padStart(2,'0')).join('');
  }
  function sourceText(segments){return segments.map(segment=>segment.text).join('\n\n');}
  async function sourceTextHash(segments){return digestHex(sourceText(segments));}

  function usablePathMap(pathMap){
    const map=Object.create(null),rejected=[];
    if(pathMap==null)return {map,rejected};
    if(!plain(pathMap))return {map,rejected:['pathMap'],invalid:true};
    const keys=Object.keys(pathMap);
    if(keys.length>64)return {map,rejected:['pathMap.size'],invalid:true};
    for(const key of keys){
      const value=pathMap[key];
      if(typeof key!=='string'||!key||key.startsWith('-')||key.length>2000||typeof value!=='string'||!value.trim()||value.startsWith('-')||value.length>200)rejected.push(key);
      else map[key]=value;
    }
    return {map,rejected};
  }
  function portableProjection(harness,pathMap,machineSettingKeys){
    const projected=sorted(harness);
    const usable=usablePathMap(pathMap).map;
    const adapter=projected&&projected.adapter;
    if(plain(adapter)){
      if(typeof adapter.executable==='string'&&Object.prototype.hasOwnProperty.call(usable,adapter.executable))adapter.executable=usable[adapter.executable];
      if(Array.isArray(adapter.args))adapter.args=adapter.args.map(arg=>typeof arg==='string'&&Object.prototype.hasOwnProperty.call(usable,arg)?usable[arg]:arg);
    }
    const keys=machineSettingKeys==null?[MACHINE_SETTING]:machineSettingKeys;
    if(plain(projected&&projected.settings)&&Array.isArray(keys))for(const key of keys)if(key===MACHINE_SETTING)delete projected.settings[key];
    return projected;
  }
  function pathLike(token){return typeof token==='string'&&(token.includes('/')||token.includes('\\')||(token.length>2&&token[1]===':'));}
  function unmappedAdapterPaths(harness,pathMap){
    const usable=usablePathMap(pathMap).map;
    const adapter=plain(harness&&harness.adapter)?harness.adapter:{};
    const tokens=[];
    if(typeof adapter.executable==='string')tokens.push(adapter.executable);
    if(Array.isArray(adapter.args))for(const arg of adapter.args)if(typeof arg==='string')tokens.push(arg);
    const missing=[];
    for(const token of tokens){
      if(Object.prototype.hasOwnProperty.call(usable,token)||token.startsWith('-'))continue;
      if(pathLike(token))missing.push(token);
    }
    return missing;
  }
  function requestedModel(harness){
    const settings=plain(harness&&harness.settings)?harness.settings:null;
    if(settings&&typeof settings.model==='string'&&settings.model.trim())return settings.model;
    const adapter=plain(harness&&harness.adapter)?harness.adapter:null;
    if(adapter&&typeof adapter.model==='string'&&adapter.model.trim())return adapter.model;
    return null;
  }
  function cliSelectionOf(harness){
    const adapter=harness&&harness.adapter;
    if(!plain(adapter)||!Object.prototype.hasOwnProperty.call(CLI_DEFAULT,adapter.type))return null;
    const keys=Object.keys(adapter);
    if(adapter.type==='codex'&&keys.length===1&&keys[0]==='type')return null;
    return {provider:adapter.type,model:typeof adapter.model==='string'?adapter.model:CLI_DEFAULT[adapter.type],effort:typeof adapter.effort==='string'?adapter.effort:'medium'};
  }
  function appModelLabel(harness){
    const selected=cliSelectionOf(harness);
    if(selected)return selected.model;
    const kind=plain(harness&&harness.adapter)&&harness.adapter.type||'codex';
    return kind==='codex'?'gpt-6.1-sol':'custom-'+kind+'-model-unverified';
  }
  function outcomeClass(spec){
    const jobState=spec.jobState,status=spec.status,findingCount=spec.findingCount;
    if(jobState==='failed')return 'failed';
    if(jobState==='cancelled')return 'cancelled';
    if(jobState!=='completed')return 'unknown';
    if(status==='refusal')return 'refusal';
    if(status==='abstain')return 'abstain';
    if(status!=='ok')return 'unknown';
    if(findingCount===0)return 'completed-zero-findings';
    if(!spec.goldReviewApplied)return 'human-unreviewed';
    if(spec.goldKnown===false)return 'gold-unknown';
    if(spec.matchedPositive)return 'matched-findings';
    return 'human-reviewed-no-match';
  }
  function emptyCounts(){const counts={};for(const name of PRIMARY)counts[name]=0;return counts;}
  function text(value,limit){return typeof value==='string'&&!!value.trim()&&value.length<=limit&&!value.includes('\0');}
  function hex(value){return typeof value==='string'&&HEX.test(value);}

  function fail(errors){return {schema:SCHEMA,ok:false,errors,notice:NOTICE,integrationGaps:[...INTEGRATION_GAPS]};}

  function checkShape(input){
    const errors=[];
    if(!plain(input))return fail(['input']);
    const strategy=input.strategy,fixed=input.fixed,arms=input.arms;
    if(!plain(strategy)||!text(strategy.id,80)||!text(strategy.version,80)||!hex(strategy.bundleSha256))errors.push('strategy');
    if(plain(strategy)&&Object.prototype.hasOwnProperty.call(strategy,'machineSettingKeys')){
      const keys=strategy.machineSettingKeys;
      if(!Array.isArray(keys)||keys.some(key=>key!==MACHINE_SETTING))errors.push('strategy.machineSettingKeys');
    }
    const mapped=usablePathMap(strategy&&strategy.pathMap);
    if(mapped.invalid||mapped.rejected.length)errors.push('pathMap.flag');
    if(plain(strategy)&&Object.prototype.hasOwnProperty.call(strategy,'portable')){
      if(!plain(strategy.portable))errors.push('strategy.portable');
      else if(plain(strategy.portable.settings)&&Object.prototype.hasOwnProperty.call(strategy.portable.settings,MACHINE_SETTING))errors.push('strategy.portable.machine');
      else if(strategy.portable.id!==strategy.id||strategy.portable.version!==strategy.version||!plain(strategy.portable.settings)||strategy.portable.settings.bundleSha256!==strategy.bundleSha256)errors.push('strategy.portable.identity');
    }
    if(!plain(fixed)||!text(fixed.requestedModel,120)||!Number.isInteger(fixed.maxCalls)||fixed.maxCalls<1||fixed.maxCalls>32||!Number.isInteger(fixed.internalMaxCalls)||fixed.internalMaxCalls<1||fixed.internalMaxCalls>32||fixed.protocolVersion!==BLUE||!text(fixed.caseLabel,160)||!(fixed.goldVersion===null||text(fixed.goldVersion,80)))errors.push('fixed');
    if(!plain(arms)||ARMS.some(name=>!Object.prototype.hasOwnProperty.call(arms,name))||Object.keys(arms).some(name=>!ARMS.includes(name)))errors.push('arms');
    else for(const name of ARMS){const arm=arms[name];if(!plain(arm)||!hex(arm.sourceHash)||!hex(arm.fileHash)||!text(arm.revision,160))errors.push('arms.'+name);}
    if(!Array.isArray(input.records))errors.push('records');
    if(input.reviews!=null&&!Array.isArray(input.reviews))errors.push('reviews');
    if(fixed&&fixed.goldVersion===null&&input.gold!=null)errors.push('gold.unexpected');
    if(input.gold!=null&&fixed&&fixed.goldVersion!=null){
      const gold=input.gold;
      if(!plain(gold)||gold.scientificGold!==false||gold.version!==fixed.goldVersion||!Array.isArray(gold.items)||gold.items.length>64)errors.push('gold');
      else for(const item of gold.items)if(!plain(item)||!text(item.id,80))errors.push('gold.items');
    }
    if(input.gold&&input.gold.scientificGold===true)errors.push('gold.scientificGold');
    return errors.length?fail(unique(errors)):null;
  }

  function verifiedClaim(record,run){
    if(typeof record.verifiedModel==='string')return record.verifiedModel;
    if(run&&typeof run.verifiedModel==='string')return run.verifiedModel;
    if(plain(record.model)&&typeof record.model.verified==='string')return record.model.verified;
    return null;
  }
  function verifiedModel(claim,provenance,warn,id){
    if(claim==null||claim==='')return 'unknown';
    if(provenance==='local-codex'&&typeof claim==='string'&&claim.trim()&&!claim.endsWith('model-unverified'))return {observed:claim,certified:false};
    warn('unverified_model',id);
    return 'unknown';
  }
  function jobOf(record,pending,response){
    const explicit=record.jobState||(plain(record.job)&&record.job.state);
    if(explicit==='failed'||explicit==='cancelled'||explicit==='completed')return {state:explicit,reason:null};
    const disposition=pending&&pending.disposition;
    if(disposition==='failed'||disposition==='cancelled'||disposition==='completed')return {state:disposition,reason:null};
    if(disposition==='open'||disposition==='running'||disposition==='expired')return {state:'unknown',reason:'job_not_terminal'};
    if(response&&(response.status==='ok'||response.status==='refusal'||response.status==='abstain'))return {state:'completed',reason:null};
    return {state:'unknown',reason:'job_state_unknown'};
  }
  function blind(request){
    if(!plain(request))return false;
    const walk=(value,depth)=>{
      if(depth>12||!value||typeof value!=='object')return false;
      if(!Array.isArray(value))for(const key of Object.keys(value))if(FORBIDDEN.has(String(key).toLowerCase()))return true;
      for(const child of Array.isArray(value)?value:Object.values(value))if(walk(child,depth+1))return true;
      return false;
    };
    return walk(request,0);
  }
  function segmentsOf(value){return Array.isArray(value)?value.filter(segment=>plain(segment)&&typeof segment.text==='string'):null;}
  function adapterView(harness,projected){
    const adapter=plain(harness&&harness.adapter)?harness.adapter:{};
    const projectedAdapter=plain(projected&&projected.adapter)?projected.adapter:{};
    return {
      type:adapter.type||null,
      executable:typeof adapter.executable==='string'?adapter.executable:null,
      args:Array.isArray(adapter.args)?adapter.args.slice():[],
      projectedExecutable:typeof projectedAdapter.executable==='string'?projectedAdapter.executable:null,
      projectedArgs:Array.isArray(projectedAdapter.args)?projectedAdapter.args.slice():[]
    };
  }
  function subjectiveView(review){
    const assessments=plain(review.comparison)&&Array.isArray(review.comparison.assessments)?review.comparison.assessments:[];
    return {
      id:typeof review.id==='string'?review.id:null,
      verdict:typeof review.verdict==='string'?review.verdict:null,
      score:review.score==null?null:review.score,
      caseLabel:typeof review.caseLabel==='string'?review.caseLabel:null,
      protocolVersion:typeof review.protocolVersion==='string'?review.protocolVersion:'unknown',
      assessments:assessments.map(item=>({id:item&&item.id||null,verdict:item&&item.verdict||null})),
      quoteOverlapIgnored:true
    };
  }

  async function compare(input){
    const rejected=checkShape(input);
    if(rejected)return rejected;
    let warnMap;
    try{warnMap=new Map();
      const warn=(code,id)=>{if(!warnMap.has(code))warnMap.set(code,new Set());if(id!=null)warnMap.get(code).add(id);};
      const strategy=input.strategy,fixed=input.fixed,arms=input.arms;
      const machineKeys=Object.prototype.hasOwnProperty.call(strategy,'machineSettingKeys')?strategy.machineSettingKeys:[MACHINE_SETTING];
      const pathMap=strategy.pathMap||{};
      const goldKnown=fixed.goldVersion!=null;
      const gold=goldKnown?input.gold:null;
      if(!goldKnown)warn('gold_missing',null);
      if(goldKnown&&(!gold||!Array.isArray(gold.items)))warn('gold_missing',null);
      const usable=new Set(),duplicate=new Set();
      if(gold){
        const counts=new Map();
        for(const item of gold.items)counts.set(item.id,(counts.get(item.id)||0)+1);
        for(const [id,count] of counts){if(count>1)duplicate.add(id);else usable.add(id);}
        if(duplicate.size)warn('duplicate_gold',null);
      }
      const expectedProjection=plain(strategy.portable)?canonical(strategy.portable):null;
      const seenIds=new Set();
      const rows=[];
      for(let index=0;index<input.records.length;index++){
        const record=input.records[index];
        const reasons=[];
        if(!plain(record)){rows.push(excludedRow('record-'+index,null,['record_shape']));continue;}
        const run=plain(record.run)?record.run:null;
        const base=run||record;
        const pending=plain(record.pending)?record.pending:null;
        const request=plain(record.request)?record.request:plain(pending&&pending.request)?pending.request:null;
        const harness=plain(base.harness)?base.harness:plain(request&&request.harness)?request.harness:null;
        const id=typeof record.id==='string'&&record.id?record.id:typeof base.id==='string'&&base.id?base.id:typeof pending?.requestId==='string'?pending.requestId:'record-'+index;
        if(seenIds.has(id))reasons.push('duplicate_record');
        seenIds.add(id);
        const arm=record.arm;
        if(!ARMS.includes(arm))reasons.push('arm');
        const role=base.role||pending&&pending.role||record.role;
        if(role!=='blue')reasons.push('role');
        if(base.snapshotOf)reasons.push('not_an_execution');
        if(!plain(harness)||!finite(harness,0))reasons.push('record_shape');
        if(request&&blind(request))reasons.push('blind_violation');
        if(request&&Object.prototype.hasOwnProperty.call(request,'cost')||Object.prototype.hasOwnProperty.call(record,'cost')||Object.prototype.hasOwnProperty.call(base,'cost'))warn('cost_not_representable',id);
        const projected=plain(harness)?portableProjection(harness,pathMap,machineKeys):null;
        const projectionText=projected?canonical(projected):null;
        if(!projected)reasons.push('portable_strategy');
        else{
          if(harness.id!==strategy.id||harness.version!==strategy.version)reasons.push('portable_strategy');
          const settings=plain(harness.settings)?harness.settings:{};
          if(settings.bundleSha256!==strategy.bundleSha256)reasons.push('portable_strategy');
          if(expectedProjection&&projectionText!==expectedProjection)reasons.push('portable_strategy');
          if(unmappedAdapterPaths(harness,pathMap).length)reasons.push('unmapped_adapter_path');
          if(requestedModel(harness)!==fixed.requestedModel)reasons.push('requested_model');
          const budgets=[harness.maxCalls,request&&request.maxCalls,base.maxCalls].filter(value=>value!=null);
          if(!budgets.length||budgets.some(value=>value!==fixed.maxCalls)||settings.internalMaxCalls!==fixed.internalMaxCalls)reasons.push('budget');
        }
        const declared=ARMS.includes(arm)?arms[arm]:null;
        const requestId=base.requestId||(request&&request.requestId)||(pending&&pending.requestId)||null;
        if(request&&request.requestId&&requestId&&request.requestId!==requestId)reasons.push('request_id');
        if(pending&&pending.requestId&&requestId&&pending.requestId!==requestId)reasons.push('request_id');
        const revision=base.revision||(request&&request.revision)||(pending&&pending.revision)||null;
        const revisions=[base.revision,request&&request.revision,pending&&pending.revision].filter(value=>value!=null);
        if(!declared||revision==null||revisions.some(value=>value!==declared.revision))reasons.push('revision');
        const fileHashes=[base.fileHash,pending&&pending.fileHash,record.fileHash].filter(value=>value!=null);
        if(!declared||!fileHashes.length||fileHashes.some(value=>value!==declared.fileHash))reasons.push('file_hash');
        const recordedSources=[base.sourceHash,request&&request.sourceHash,pending&&pending.sourceHash].filter(value=>value!=null);
        let sourceCompared=false;
        if(!declared||!recordedSources.length||recordedSources.some(value=>value!==declared.sourceHash))reasons.push('source_hash');
        const segmentLists=[segmentsOf(request&&request.segments),segmentsOf(base.segments)].filter(Boolean);
        if(!segmentLists.length)reasons.push('source_text_unseen');
        else{
          sourceCompared=true;
          for(const segments of segmentLists){
            if(segments.some(segment=>typeof segment.text!=='string'))reasons.push('source_hash');
            else if(await sourceTextHash(segments)!==(declared&&declared.sourceHash))reasons.push('source_hash');
          }
        }
        let machine=null,canonicalFailed=false,sawCanonical=false;
        const canonicalText=request&&Object.prototype.hasOwnProperty.call(request,'harnessCanonical')?request.harnessCanonical:Object.prototype.hasOwnProperty.call(record,'harnessCanonical')?record.harnessCanonical:undefined;
        if(canonicalText!==undefined){
          sawCanonical=true;
          if(typeof canonicalText!=='string'||!canonicalText||canonicalText.length>60000||canonicalText.includes('\0'))canonicalFailed=true;
          else{
            machine=await digestHex(canonicalText);
            try{if(!plain(harness)||!same(JSON.parse(canonicalText),harness))canonicalFailed=true;}catch{canonicalFailed=true;}
          }
        }else if(plain(harness))machine=await digestHex(canonical(harness));
        const recordedHash=base.harnessHash||(pending&&pending.harnessHash)||null;
        if(canonicalFailed||(sawCanonical&&!!recordedHash&&recordedHash!==machine))reasons.push('harness_canonical');
        else if(!machine||!recordedHash||recordedHash!==machine)reasons.push('machine_hash_unverified');
        if(request&&plain(request.harness)&&plain(harness)&&!same(request.harness,harness))reasons.push('harness_not_frozen');
        const adapterType=plain(harness&&harness.adapter)&&harness.adapter.type;
        if(request&&(adapterType==='stdio'||adapterType==='http'||adapterType==='wrapper')&&request.executionConsent!==true)reasons.push('consent');
        const explicitResponse=Object.prototype.hasOwnProperty.call(record,'result')?record.result:base.response;
        const response=explicitResponse==null?null:explicitResponse;
        const job=jobOf(record,pending,response);
        if(job.reason)reasons.push(job.reason);
        if((job.state==='failed'||job.state==='cancelled')&&(response!=null||record.rawResponseSha256!=null))reasons.push('discarded_result');
        let status=null,findingCount='unknown',findingIds=[],responseHash=null,responseImmutable='unknown';
        if(job.state==='completed'&&!reasons.includes('discarded_result')){
          if(!plain(response)||!['ok','refusal','abstain'].includes(response.status)||!Array.isArray(response.findings))reasons.push('response_status');
          else{
            status=response.status;
            findingCount=response.findings.length;
            findingIds=response.findings.filter(item=>plain(item)&&typeof item.id==='string').map(item=>item.id);
            if(status!=='ok'&&response.findings.length)reasons.push('non_ok_findings');
            if(plain(harness)&&Object.prototype.hasOwnProperty.call(response,'model')&&response.model!==appModelLabel(harness))reasons.push('app_model_label');
            if(plain(harness)&&!Object.prototype.hasOwnProperty.call(response,'model')&&base.provenance==='local-codex')reasons.push('app_model_label');
            const expectedCli=plain(harness)?cliSelectionOf(harness):null;
            if(Object.prototype.hasOwnProperty.call(response,'cliSelection')||(base.provenance==='local-codex'&&expectedCli)){
              if(!same(response.cliSelection||null,expectedCli))reasons.push('recorded_metadata');
            }
            if(base.provenance==='local-codex'){
              if(!plain(response.harness)||!plain(harness)||!same(response.harness,harness)||response.harnessHash!==machine)reasons.push('harness_not_frozen');
            }else if(plain(response.harness)&&plain(harness)&&!same(response.harness,harness))reasons.push('harness_not_frozen');
            if(typeof record.rawResponseSha256==='string'){
              responseHash=await digestHex(canonical(response));
              responseImmutable=record.rawResponseSha256===responseHash;
              if(!responseImmutable)reasons.push('response_not_immutable');
            }
          }
        }
        if(response&&responseHash==null&&plain(response)&&job.state==='completed')responseHash=await digestHex(canonical(response));
        const provenance=base.provenance||record.provenance||'unknown';
        const verified=verifiedModel(verifiedClaim(record,run),provenance,warn,id);
        const includedPreview=reasons.filter(reason=>EXCLUDE.has(reason)).length===0;
        const calls=callsOf(provenance,response,job.state==='completed');
        rows.push({
          id,arm:ARMS.includes(arm)?arm:null,repeat:Number.isInteger(record.repeat)?record.repeat:null,
          reasons:unique(reasons),included:includedPreview,class:null,outcome:null,
          requestedModel:plain(harness)?requestedModel(harness):null,verifiedModel:includedPreview?verified:'unknown',
          appModelLabel:plain(harness)?appModelLabel(harness):null,
          strategyId:strategy.id,strategyVersion:strategy.version,bundleSha256:strategy.bundleSha256,
          portableHash:projectionText?await digestHex(projectionText):null,
          machineConfigHash:machine,machineConfigHashVerified:!!(machine&&recordedHash&&recordedHash===machine&&!canonicalFailed),
          machineConfigIsStrategyIdentity:false,
          adapter:adapterView(harness,projected),
          independence:requestId?'distinct-request':'unknown',
          requestId:requestId||null,revision,requestRevisionIdentity:requestId&&revision?requestId+'@'+revision:null,
          requestBytesDigest:record.requestBytesDigest||pending&&pending.requestBytesDigest||null,
          responseHash,responseImmutable,calls,cost:'unknown',findingCount,findingIds,
          matchedJudgments:'unknown',unmatchedJudgments:'unknown',duplicateJudgments:'unknown',
          goldReviewApplied:false,humanAdjudication:null,sourceComparedAsTextHash:sourceCompared,
          detectionCorrectness:'not-inferred',provenance,status,jobState:job.state,_verified:verified
        });
      }
      if(!expectedProjection){
        const hashes=unique(rows.map(row=>row.portableHash).filter(Boolean));
        if(hashes.length!==1){warn('portable_strategy_unfixed',null);for(const row of rows)row.reasons=unique([...row.reasons,'portable_strategy']);}
      }
      const reviews=Array.isArray(input.reviews)?input.reviews:[];
      for(const row of rows){
        row.reasons=unique(row.reasons);
        row.included=row.reasons.filter(reason=>EXCLUDE.has(reason)).length===0;
        if(!row.included)row.verifiedModel='unknown';
        const matchedReviews=reviews.filter(review=>plain(review)&&(review.runId===row.id||review.trialId===row.id));
        const goldReviews=[];
        for(const review of matchedReviews){
          if(Array.isArray(review.judgments)){
            const protocolKnown=typeof review.protocolVersion==='string';
            const condition=review.caseLabel===fixed.caseLabel&&review.protocolVersion===fixed.protocolVersion;
            if(!protocolKnown)warn('review_protocol_unknown',row.id);
            else if(!condition)warn('review_condition_mismatch',row.id);
            if(condition)goldReviews.push(review);
          }else warn('review_without_judgments',row.id);
        }
        let applied=null;
        if(goldReviews.length>1)warn('multiple_reviews',row.id);
        else if(goldReviews.length===1)applied=goldReviews[0];
        let matched=0,unmatched=0,duplicates=0;
        if(applied&&row.included&&goldKnown){
          const seen=new Set();
          for(const judgment of applied.judgments){
            if(!plain(judgment))continue;
            const key=JSON.stringify([judgment.goldId,judgment.findingId,judgment.judgment]);
            if(seen.has(key)){warn('duplicate_judgment',row.id);continue;}
            seen.add(key);
            if(duplicate.has(judgment.goldId)){warn('duplicate_gold',row.id);continue;}
            if(!usable.has(judgment.goldId)){warn('unmatched_gold',row.id);continue;}
            if(judgment.judgment==='matched'){
              if(!row.findingIds.includes(judgment.findingId)){warn('match_without_finding',row.id);continue;}
              matched++;
            }else if(judgment.judgment==='unmatched')unmatched++;
            else if(judgment.judgment==='duplicate')duplicates++;
          }
          row.matchedJudgments=matched;row.unmatchedJudgments=unmatched;row.duplicateJudgments=duplicates;
        }
        const goldReviewApplied=!!(applied&&row.included&&row.jobState==='completed'&&row.status==='ok');
        row.goldReviewApplied=goldReviewApplied;
        row.outcome=outcomeClass({jobState:row.jobState,status:row.status,findingCount:row.findingCount==='unknown'?null:row.findingCount,goldReviewApplied,matchedPositive:matched>0,goldKnown});
        if(goldReviewApplied&&!goldKnown&&row.status==='ok'&&row.findingCount>0)row.outcome='gold-unknown';
        row.class=row.included?row.outcome:'excluded';
        row.humanAdjudication={
          goldReviewApplied:goldReviewApplied&&goldKnown,
          goldKnown,
          reviews:matchedReviews.map(subjectiveView),
          goldJudgments:goldReviewApplied&&goldKnown?{matched,unmatched,duplicate:duplicates}:'unknown',
          quoteOverlapIgnored:true,
          verdictIsNotAccuracy:true
        };
      }
      markReplays(rows);
      for(const row of rows)if(row.reasons.some(reason=>EXCLUDE.has(reason))||row.reasons.includes('repeat_replay')){
        row.included=false;row.class='excluded';row.verifiedModel='unknown';row.goldReviewApplied=false;
        if(row.humanAdjudication){row.humanAdjudication.goldReviewApplied=false;row.humanAdjudication.goldJudgments='unknown';}
        if(row.reasons.includes('repeat_replay'))row.independence='replay';
      }
      for(const row of rows)if(row.included&&!row.requestId)warn('request_identity_unknown',row.id);
      markIndependence(rows,warn);
      for(const row of rows)for(const reason of row.reasons){
        if(reason==='repeat_replay')warn('repeat_replay',row.id);
        else if(EXCLUDE.has(reason))warn('incompatible_condition:'+reason,row.id);
      }
      const projections=unique(rows.filter(row=>row.included).map(row=>row.portableHash));
      const portableHash=!expectedProjection&&projections.length===1?projections[0]:expectedProjection?await digestHex(expectedProjection):'unknown';
      const byArm={};
      for(const name of ARMS)byArm[name]=rows.filter(row=>row.arm===name);
      const armReports={};
      for(const name of ARMS){
        const group=byArm[name],included=group.filter(row=>row.included),counts=emptyCounts();
        for(const row of included)if(PRIMARY.includes(row.outcome))counts[row.outcome]++;
        const hashes=unique(included.map(row=>row.machineConfigHash).filter(Boolean)).sort();
        if(hashes.length>1)for(const row of included)warn('machine_config_not_strategy_identity',row.id);
        const failed=counts.failed,cancelled=counts.cancelled;
        const okRows=included.filter(row=>OK_CLASSES.includes(row.outcome));
        if(!included.length)warn('arm_missing',null);
        armReports[name]={
          sourceHash:arms[name].sourceHash,fileHash:arms[name].fileHash,revision:arms[name].revision,
          attempts:included.length,excluded:group.length-included.length,counts,countsAreClassCounts:true,
          denominators:{
            attempts:included.length,
            completedResponses:included.length-failed-cancelled,
            failedExcludedFromZeroFindings:failed,
            cancelledExcludedFromZeroFindings:cancelled,
            zeroFindings:{numerator:counts['completed-zero-findings'],denominator:okRows.length}
          },
          matchedFindingJudgments:judgmentTotal(included,'matchedJudgments',goldKnown),
          unmatchedGoldJudgments:judgmentTotal(included,'unmatchedJudgments',goldKnown),
          duplicateGoldJudgments:judgmentTotal(included,'duplicateJudgments',goldKnown),
          verifiedModel:armVerified(included),
          requestedModel:fixed.requestedModel,
          calls:callsReport(included),cost:'unknown',machineConfigHashes:hashes,
          independence:!included.length?(group.some(row=>row.independence==='replay')?'replay':'unknown'):included.some(row=>row.independence==='unknown')?'unknown':'distinct-request'
        };
      }
      const warnings=warningRows(warnMap);
      const blocking=new Set(['repeat_replay','gold_missing','arm_missing','duplicate_gold','discarded_result','request_identity_unknown','portable_strategy_unfixed']);
      let ready=ARMS.every(name=>armReports[name].attempts>0)&&goldKnown&&!(gold&&duplicate.size);
      if(warnings.some(item=>item.code.startsWith('incompatible_condition:')||blocking.has(item.code)))ready=false;
      return {
        schema:SCHEMA,ok:true,notice:NOTICE,comparisonReady:ready,ranking:'not-computed',detectionCorrectness:'not-inferred',
        scientificGold:false,grouping:'portable-strategy-version-bundle',machineConfigIsStrategyIdentity:false,
        fixed:{
          strategyId:strategy.id,strategyVersion:strategy.version,bundleSha256:strategy.bundleSha256,portableHash,
          requestedModel:fixed.requestedModel,verifiedModel:armVerified(rows.filter(row=>row.included)),
          maxCalls:fixed.maxCalls,internalMaxCalls:fixed.internalMaxCalls,
          goldVersion:goldKnown?fixed.goldVersion:'unknown',protocolVersion:fixed.protocolVersion,caseLabel:fixed.caseLabel
        },
        arms:armReports,
        gold:{version:goldKnown?fixed.goldVersion:'unknown',scientificGold:false,usableItems:gold?usable.size:'unknown',duplicateIds:[...duplicate].sort(),quotesUsed:false},
        records:rows.map(publish),
        warnings,integrationGaps:[...INTEGRATION_GAPS]
      };
    }catch(error){
      if(error&&error.code==='digest_unavailable')return fail(['digest_unavailable']);
      throw error;
    }
  }

  function callsOf(provenance,response,completed){
    if(!completed||provenance!=='local-codex'||!plain(response)||!plain(response.coverage))return null;
    const calls=response.coverage.calls;
    return Number.isSafeInteger(calls)&&calls>=0?calls:null;
  }
  function callsReport(rows){
    if(!rows.length||rows.some(row=>row.calls==null))return 'unknown';
    return {sum:rows.reduce((total,row)=>total+row.calls,0),unknown:0,verified:false,clientReported:true};
  }
  function judgmentTotal(rows,key,goldKnown){
    if(!goldKnown||!rows.length||rows.some(row=>typeof row[key]!=='number'))return 'unknown';
    return rows.reduce((total,row)=>total+row[key],0);
  }
  function armVerified(rows){
    const observed=[];
    for(const row of rows){
      if(!row.included||row.verifiedModel==='unknown'||!plain(row.verifiedModel))return 'unknown';
      observed.push(row.verifiedModel.observed);
    }
    if(!rows.length||observed.length!==rows.length||new Set(observed).size!==1)return 'unknown';
    return {observed:observed[0],certified:false};
  }
  function markReplays(rows){
    const groups=new Map();
    const add=(key,row)=>{if(key==null)return;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);};
    for(const row of rows){
      add(row.requestId==null?null:'id:'+row.requestId,row);
      add(row.requestBytesDigest==null?null:'bytes:'+row.requestBytesDigest,row);
      add(row.requestRevisionIdentity==null?null:'revision:'+row.requestRevisionIdentity,row);
    }
    const replay=new Set();
    for(const group of groups.values())if(group.length>1)for(const row of group)replay.add(row);
    for(const row of replay){
      row.reasons=unique([...row.reasons,'repeat_replay']);
      row.independence='replay';
    }
  }
  function markIndependence(rows,warn){
    const included=rows.filter(row=>row.included&&!row.reasons.includes('repeat_replay')&&row.responseHash);
    for(let leftIndex=0;leftIndex<included.length;leftIndex++)for(let rightIndex=leftIndex+1;rightIndex<included.length;rightIndex++){
      const left=included[leftIndex],right=included[rightIndex];
      if(left.responseHash===right.responseHash){
        left.independence='unknown';right.independence='unknown';
        warn('independence_unknown',left.id);warn('independence_unknown',right.id);
      }
    }
  }
  function excludedRow(id,arm,reasons){
    return {id,arm,repeat:null,reasons,included:false,class:'excluded',outcome:'unknown',requestedModel:null,verifiedModel:'unknown',appModelLabel:null,strategyId:null,strategyVersion:null,bundleSha256:null,portableHash:null,machineConfigHash:null,machineConfigHashVerified:false,machineConfigIsStrategyIdentity:false,adapter:{type:null,executable:null,args:[],projectedExecutable:null,projectedArgs:[]},independence:'unknown',requestId:null,revision:null,requestRevisionIdentity:null,requestBytesDigest:null,responseHash:null,responseImmutable:'unknown',calls:null,cost:'unknown',findingCount:'unknown',findingIds:[],matchedJudgments:'unknown',unmatchedJudgments:'unknown',duplicateJudgments:'unknown',goldReviewApplied:false,humanAdjudication:{goldReviewApplied:false,goldKnown:false,subjective:[],goldJudgments:'unknown',quoteOverlapIgnored:true,verdictIsNotAccuracy:true},sourceComparedAsTextHash:false,detectionCorrectness:'not-inferred',provenance:'unknown',status:null,jobState:'unknown'};
  }
  function warningRows(warnMap){
    const rows=[];
    for(const code of [...warnMap.keys()].sort()){
      if(EXCLUDE.has(code))continue;
      const reason=code.startsWith('incompatible_condition:')?code.slice('incompatible_condition:'.length):null;
      const message=MESSAGES[code]||(reason&&MESSAGES[reason])||(reason?'A record differs from the fixed strategy, requested model, budget, source, or frozen harness and is outside the denominators.':code);
      rows.push({code,message,recordIds:[...warnMap.get(code)].filter(Boolean).sort()});
    }
    return rows;
  }
  function publish(row){
    const copy={...row};
    delete copy.findingIds;delete copy._verified;delete copy.provenance;delete copy.status;delete copy.jobState;
    copy.calls=copy.included&&typeof copy.calls==='number'?copy.calls:'unknown';
    if(!copy.included){copy.matchedJudgments='unknown';copy.unmatchedJudgments='unknown';copy.duplicateJudgments='unknown';copy.findingCount='unknown';}
    return copy;
  }

  return {SCHEMA,ARMS,PRIMARY,INTEGRATION_GAPS,NOTICE,canonical,digestHex,sourceTextHash,portableProjection,unmappedAdapterPaths,requestedModel,appModelLabel,outcomeClass,compare};
});
