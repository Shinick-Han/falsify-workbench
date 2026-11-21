/* Event-page booth runtime (event.html only; loads before booth.js, which reads it when present).
   - Kiosk mode for the booth tablet: event.html?kiosk=1 sets a per-tab flag in sessionStorage
     (?kiosk=0 clears it). In kiosk mode booth.js keeps receipts in sessionStorage, pick and ticket get a
     「다음 분께 넘기기」 button, and 3 minutes without a touch, key or scroll (16 minutes while a result is
     pending, one minute past booth.js POLL_STOP_AT; a step change or the result arriving restarts the count) open a
     20-second 「계속하시겠어요?」 warning (WCAG 2.2.1). Handing over or letting the
     warning run out clears this visitor's receipts, saved progress, drafts, edits, assist state and
     guest session, then reloads event.html?kiosk=1, so the next visitor gets a fresh guest and 5 chances.
   - Offline: offerRetry puts a 「다시 시도」 button after a status line; the 'online' event presses it.
   - Wake lock: wake(navigator) keeps the screen on while booth.js waits for a result.
   - Progress: on hidden or pagehide the step, paper, recipe tab and FalsifyBoothEdits.serialize() go to
     sessionStorage. The next load of this tab offers 「고친 곳 N개를 이어서 할까요?」 and restores the
     edits directly through FalsifyBoothEdits.restore().
   DOM text is set with textContent only. */
(function(root){
  'use strict';
  const KIOSK_KEY='falsify.booth.kiosk.v1';
  const PROGRESS_KEY='falsify.booth.progress.v1';
  const RECEIPT_KEY='falsify.booth.receipts.v1';
  const LANG_KEY='falsify.booth.lang.v1';
  const HOSTED_KEYS=['falsify.hosted-ai.session.v1','falsify.hosted-ai.upload.v1','falsify.hosted-ai.runs.v1'];
  const GUEST_PREFIX='falsify.open-access.guest.v1:';
  const DRAFT_PREFIX='falsify.paper-draft';
  const OFFLINE_TEXT='인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.';
  const IDLE_MS=180000;
  /* One minute past booth.js POLL_STOP_AT, so a late result never lands during the warning. */
  const WAIT_IDLE_MS=960000;
  const WARN_MS=20000;
  const PROGRESS_TTL=6*3600000;
  const MAX_EDITS=5;
  const ACTIVITY=['pointerdown','touchstart','keydown','wheel','scroll','input'];
  const PAPER_ID=/^(?:\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/;
  const CONTROL=/[\u0000-\u001f\u007f]/;
  const LICENSE_RE=/^(?:cc-by(?:-\d+\.\d+)?|cc-by-sa(?:-\d+\.\d+)?|cc0(?:-1\.0)?|public-domain)$/;
  const TABS=['find','myai'];
  let resetting=false;

  function bag(name){
    try{return root[name]||null;}catch{return null;}
  }
  function getItem(store, key){
    try{return store?store.getItem(key):null;}catch{return null;}
  }
  function setItem(store, key, value){
    try{if(store){store.setItem(key,value);return true;}}catch{}
    return false;
  }
  function removeItem(store, key){
    try{if(store) store.removeItem(key);}catch{}
  }
  function keysOf(store){
    const out=[];
    try{
      for(let i=0;i<store.length;i+=1){
        const key=store.key(i);
        if(typeof key==='string') out.push(key);
      }
    }catch{}
    return out;
  }
  function boothEdits(){
    try{return root.FalsifyBoothEdits||null;}catch{return null;}
  }

  /* ---------- kiosk flag and storage ---------- */
  /* ?kiosk=1 turns kiosk mode on for this tab, ?kiosk=0 turns it off; otherwise the tab's flag decides. */
  function kioskFlag(search, store){
    let value=null;
    try{value=new URLSearchParams(search||'').get('kiosk');}catch{value=null;}
    if(value==='1'){setItem(store,KIOSK_KEY,'1');return true;}
    if(value==='0'){removeItem(store,KIOSK_KEY);return false;}
    return getItem(store,KIOSK_KEY)==='1';
  }
  let kioskState=null;
  function kiosk(){
    if(kioskState===null){
      const loc=root.location;
      kioskState=kioskFlag(loc&&loc.search,bag('sessionStorage'));
    }
    return kioskState;
  }
  /* booth.js receipts: sessionStorage on a kiosk, localStorage otherwise. */
  function storage(){
    return kiosk()?bag('sessionStorage'):bag('localStorage');
  }
  function offline(nav){
    try{
      const n=nav||root.navigator;
      return !!(n&&n.onLine===false);
    }catch{return false;}
  }

  /* ---------- 다시 시도 ---------- */
  const retries=new Map();
  let onlineBound=false;
  function retryButton(doc, node){
    const id=node.id+'-retry';
    let button=doc.getElementById(id);
    if(button) return button;
    button=doc.createElement('button');
    button.type='button';
    button.id=id;
    button.className='booth-btn line slim booth-retry';
    button.textContent='다시 시도';
    button.addEventListener('click',()=>{pressRetry(id);});
    node.after(button);
    return button;
  }
  function runSafely(run){
    try{
      const out=run();
      if(out&&typeof out.catch==='function') out.catch(()=>{});
    }catch{}
  }
  function pressRetry(id){
    const entry=retries.get(id);
    retries.delete(id);
    if(!entry) return;
    const button=entry.doc.getElementById(id);
    if(button) button.hidden=true;
    runSafely(entry.run);
  }
  /* Only a retry whose button still shows runs; booth.js hides it when the status line changes. */
  function retryOnline(){
    for(const [id,entry] of [...retries]){
      const button=entry.doc.getElementById(id);
      if(button&&!button.hidden) pressRetry(id);
      else retries.delete(id);
    }
  }
  function offerRetry(doc, node, run){
    if(!doc||!node||!node.id||typeof node.after!=='function'||typeof run!=='function') return null;
    const button=retryButton(doc,node);
    retries.set(button.id,{doc,run});
    button.hidden=false;
    if(!onlineBound&&typeof root.addEventListener==='function'){
      root.addEventListener('online',retryOnline);
      onlineBound=true;
    }
    return button;
  }

  /* ---------- screen wake lock ---------- */
  function lockApi(nav){
    const api=nav&&nav.wakeLock;
    return api&&typeof api.request==='function'?api:null;
  }
  function wake(nav){
    const api=lockApi(nav);
    let wanted=false;
    let sentinel=null;
    let asking=false;
    function drop(){
      const held=sentinel;
      sentinel=null;
      if(held&&typeof held.release==='function') runSafely(()=>held.release());
    }
    function granted(lock){
      asking=false;
      sentinel=lock||null;
      if(!wanted){drop();return;}
      if(lock&&typeof lock.addEventListener==='function') lock.addEventListener('release',()=>{if(sentinel===lock) sentinel=null;});
    }
    function ask(){
      if(!api||asking||sentinel) return;
      asking=true;
      try{Promise.resolve(api.request('screen')).then(granted,()=>{asking=false;});}
      catch{asking=false;}
    }
    return {
      want(on){
        wanted=!!on;
        if(wanted) ask();
        else drop();
      },
      held(){return !!sentinel;}
    };
  }

  /* ---------- idle timer (kiosk) ---------- */
  /* opts: later, cancel, limit() ms, warn ms, onWarn(), onExpire(). Activity during the warning is
     ignored: only resume() (the 계속 button) extends. Nothing runs until the first activity. */
  function idleTimer(opts){
    let timer=null;
    let warnTimer=null;
    let warning=false;
    function clear(){
      if(timer!=null) opts.cancel(timer);
      if(warnTimer!=null) opts.cancel(warnTimer);
      timer=null;
      warnTimer=null;
    }
    function expire(){
      clear();
      warning=false;
      opts.onExpire();
    }
    function warn(){
      timer=null;
      warning=true;
      warnTimer=opts.later(expire,opts.warn);
      opts.onWarn();
    }
    function restart(){
      clear();
      warning=false;
      timer=opts.later(warn,Math.max(0,opts.limit()-opts.warn));
    }
    return {
      activity(){if(!warning) restart();},
      resume:restart,
      refresh(){if(timer!=null) restart();},
      stop(){clear();warning=false;},
      warning(){return warning;}
    };
  }

  /* ---------- visitor reset (kiosk) ---------- */
  function dropGuest(session){
    const hosted=root.FalsifyHostedSession;
    if(hosted&&typeof hosted.invalidate==='function'){
      try{hosted.invalidate();return;}catch{}
    }
    for(const key of keysOf(session)) if(key.startsWith(GUEST_PREFIX)) removeItem(session,key);
  }
  function resetAssist(){
    const recipe=root.FalsifyBoothRecipe;
    if(recipe&&typeof recipe.setAssist==='function'){
      try{recipe.setAssist('manual');}catch{}
    }
  }
  function clearEdits(){
    const store=boothEdits();
    if(store&&typeof store.clear==='function'){
      try{store.clear();}catch{}
    }
  }
  /* Blurring the focused field closes a tablet's soft keyboard. */
  function blurInput(doc){
    const active=doc&&doc.activeElement;
    if(active&&active!==doc.body&&typeof active.blur==='function'){
      try{active.blur();}catch{}
    }
  }
  /* Receipts, saved progress, workspace drafts, booth edits, the hosted-AI session, recipe assist
     and the guest token. The kiosk flag and the open-access key stay. */
  function clearVisitor(){
    const session=bag('sessionStorage');
    const local=bag('localStorage');
    for(const key of [RECEIPT_KEY,PROGRESS_KEY,LANG_KEY,...HOSTED_KEYS]) removeItem(session,key);
    for(const store of [session,local]){
      for(const key of keysOf(store)) if(key.startsWith(DRAFT_PREFIX)) removeItem(store,key);
    }
    dropGuest(session);
    clearEdits();
    resetAssist();
    const html=root.document&&root.document.documentElement;
    if(html&&html.dataset) delete html.dataset.boothStep;
    blurInput(root.document);
  }
  function kioskUrl(loc){
    const path=loc&&typeof loc.pathname==='string'&&loc.pathname?loc.pathname:'event.html';
    return path+'?kiosk=1';
  }
  /* The reload drops the open paper, the booth edits and every in-memory booth state. */
  function handoff(){
    resetting=true;
    clearVisitor();
    const loc=root.location;
    try{loc.replace(kioskUrl(loc));}catch{}
  }

  /* ---------- kiosk UI ---------- */
  function button(doc, text, className, onClick){
    const node=doc.createElement('button');
    node.type='button';
    node.className=className;
    node.textContent=text;
    node.addEventListener('click',onClick);
    return node;
  }
  function textNode(doc, tag, id, className, text){
    const node=doc.createElement(tag);
    if(id) node.id=id;
    node.className=className;
    node.textContent=text;
    return node;
  }
  function makeDialog(doc, spec){
    const box=doc.createElement('dialog');
    box.id=spec.id;
    box.className='booth-kiosk-dialog';
    box.setAttribute('role',spec.role||'dialog');
    box.setAttribute('aria-labelledby',spec.id+'-title');
    box.setAttribute('aria-describedby',spec.id+'-text');
    const row=doc.createElement('div');
    row.className='booth-kiosk-actions';
    for(const action of spec.actions){
      const node=button(doc,action.text,'booth-kiosk-btn '+action.kind,action.run);
      node.id=spec.id+'-'+action.name;
      row.append(node);
    }
    box.append(textNode(doc,'h2',spec.id+'-title','booth-kiosk-title',spec.title),
      textNode(doc,'p',spec.id+'-text','booth-kiosk-text',spec.text),row);
    box.addEventListener('cancel',event=>{event.preventDefault();spec.onCancel();});
    doc.body.append(box);
    return box;
  }
  function openDialog(box){
    if(box.open) return;
    try{if(typeof box.showModal==='function'){box.showModal();return;}}catch{}
    box.setAttribute('open','');
  }
  function closeDialog(box){
    if(!box.open) return;
    try{if(typeof box.close==='function'){box.close();return;}}catch{}
    box.removeAttribute('open');
  }
  const HANDOFF_SPOTS=[['pick','booth-step-pick','.booth-top'],['ticket','booth-receipt','.booth-top'],['desk','booth-deskbar','']];
  function placeHandoff(doc, open){
    for(const [name,hostId,selector] of HANDOFF_SPOTS){
      const host=doc.getElementById(hostId);
      const target=host&&selector?host.querySelector(selector):host;
      if(!target||doc.getElementById('booth-handoff-'+name)) continue;
      const node=button(doc,'다음 분께 넘기기','booth-handoff',open);
      node.id='booth-handoff-'+name;
      target.append(node);
    }
  }
  function waitingResult(doc){
    const html=doc.documentElement;
    const wait=doc.getElementById('booth-ticket-wait');
    return !!(html&&html.dataset&&html.dataset.boothStep==='ticket'&&wait&&!wait.hidden);
  }
  /* step plus ':wait' while a pending result shows */
  function boothPhase(doc){
    return stepOf(doc)+(waitingResult(doc)?':wait':'');
  }
  /* A step change or a result arriving re-arms a running idle timer with the new limit. */
  function watchPhase(doc, idle){
    const Observer=root.MutationObserver;
    const html=doc.documentElement;
    if(typeof Observer!=='function'||!html) return null;
    let last=boothPhase(doc);
    const observer=new Observer(()=>{
      const next=boothPhase(doc);
      if(next===last) return;
      last=next;
      idle.refresh();
    });
    observer.observe(html,{attributes:true,attributeFilter:['data-booth-step']});
    const wait=doc.getElementById('booth-ticket-wait');
    if(wait) observer.observe(wait,{attributes:true,attributeFilter:['hidden']});
    return observer;
  }
  function kioskDialogs(doc, idle){
    const confirm=makeDialog(doc,{
      id:'booth-handoff-dialog',title:'다음 분께 넘길까요?',
      text:'이 기기에 남은 접수번호와 고친 곳을 지우고 처음 화면으로 돌아가요.',
      onCancel:()=>{closeDialog(confirm);},
      actions:[
        {name:'go',text:'넘기기',kind:'ink',run:handoff},
        {name:'stay',text:'계속하기',kind:'line',run:()=>{closeDialog(confirm);}}
      ]
    });
    const keep=()=>{closeDialog(warning);idle.resume();};
    const warning=makeDialog(doc,{
      id:'booth-idle-dialog',role:'alertdialog',title:'계속하시겠어요?',
      text:'20초 뒤에 처음 화면으로 돌아가요.',
      onCancel:keep,
      actions:[
        {name:'stay',text:'계속',kind:'ink',run:keep},
        {name:'reset',text:'처음부터',kind:'line',run:handoff}
      ]
    });
    return {confirm,warning};
  }
  function installKiosk(doc){
    const html=doc.documentElement;
    if(html&&html.dataset) html.dataset.kiosk='1';
    let dialogs=null;
    const idle=idleTimer({
      later:(fn,ms)=>root.setTimeout(fn,ms),cancel:id=>root.clearTimeout(id),warn:WARN_MS,
      limit:()=>waitingResult(doc)?WAIT_IDLE_MS:IDLE_MS,
      onWarn:()=>{blurInput(doc);openDialog(dialogs.warning);},
      onExpire:handoff
    });
    dialogs=kioskDialogs(doc,idle);
    watchPhase(doc,idle);
    placeHandoff(doc,()=>{openDialog(dialogs.confirm);});
    const onActivity=()=>{idle.activity();};
    for(const type of ACTIVITY) doc.addEventListener(type,onActivity,{capture:true,passive:true});
    if(typeof root.addEventListener==='function') root.addEventListener('scroll',onActivity,{passive:true});
    return idle;
  }

  /* ---------- saved progress (FalsifyBoothEdits.serialize / restore) ---------- */
  function validRect(r){
    return !!r&&typeof r==='object'&&Number.isFinite(r.x)&&Number.isFinite(r.y)&&Number.isFinite(r.w)&&Number.isFinite(r.h)&&r.w>0&&r.h>0;
  }
  function validEdit(edit){
    if(!edit||typeof edit!=='object') return false;
    if(!Number.isInteger(edit.pageIndex)||edit.pageIndex<0||edit.pageIndex>9999) return false;
    if(!Array.isArray(edit.rects)||!edit.rects.length||!edit.rects.every(validRect)) return false;
    if(typeof edit.originalText!=='string'||typeof edit.newText!=='string') return false;
    return edit.originalText!==edit.newText;
  }
  function parseSerializedEdits(raw){
    if(typeof raw!=='string') return [];
    let list=null;
    try{list=JSON.parse(raw);}catch{return [];}
    return Array.isArray(list)?list.filter(validEdit).slice(0,MAX_EDITS):[];
  }
  function serializedEdits(){
    const store=boothEdits();
    if(!store||typeof store.serialize!=='function') return '[]';
    try{return JSON.stringify(parseSerializedEdits(store.serialize()));}
    catch{return '[]';}
  }
  function stepOf(doc){
    const html=doc.documentElement;
    return html&&html.dataset?html.dataset.boothStep||'':'';
  }
  function currentPaper(){
    const api=root.FalsifyBoothPaper;
    try{return api&&typeof api.current==='function'?api.current():null;}catch{return null;}
  }
  function assistNow(){
    const recipe=root.FalsifyBoothRecipe;
    let value=null;
    try{value=recipe&&typeof recipe.assist==='function'?recipe.assist():null;}catch{value=null;}
    return value&&value.assist==='my-ai'?'my-ai':'manual';
  }
  function tabNow(doc){
    const on=doc.querySelector('.booth-tab[aria-selected="true"]');
    const match=on&&/^booth-tab-(find|myai)$/.exec(on.id||'');
    return match?match[1]:'find';
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
  function cleanTitle(value){
    if(typeof value!=='string') return '';
    const text=value.replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim();
    return text?trimCodePoints(text,300).trim():'';
  }
  function cleanLicense(value){
    if(typeof value!=='string') return '';
    const text=value.trim().toLowerCase();
    return LICENSE_RE.test(text)?text:'';
  }
  /* What a reload of this tab can pick up: only edit and send with an open paper. */
  function progressNow(doc, now){
    const step=stepOf(doc);
    const paper=currentPaper();
    if((step!=='edit'&&step!=='send')||!paper||!PAPER_ID.test(paper.id||'')) return null;
    return {
      v:2,at:now,step,paperId:paper.id,
      title:cleanTitle(paper.title),
      license:cleanLicense(paper.license),
      tab:tabNow(doc),assist:assistNow(),edits:serializedEdits()
    };
  }
  function saveProgress(doc){
    if(resetting) return null;
    const store=bag('sessionStorage');
    const record=progressNow(doc,Date.now());
    if(!record){removeItem(store,PROGRESS_KEY);return null;}
    setItem(store,PROGRESS_KEY,JSON.stringify(record));
    return record;
  }
  function progressShape(data){
    if(!data||typeof data!=='object'||data.v!==2) return false;
    if(typeof data.paperId!=='string'||!PAPER_ID.test(data.paperId)) return false;
    if(!Number.isFinite(data.at)) return false;
    return (data.step==='edit'||data.step==='send')&&typeof data.edits==='string';
  }
  function readProgress(raw, now){
    let data=null;
    try{data=JSON.parse(raw||'');}catch{return null;}
    if(!progressShape(data)||now-data.at>PROGRESS_TTL||data.at-now>60000) return null;
    const valid=parseSerializedEdits(data.edits);
    return {
      step:data.step,paperId:data.paperId,
      title:cleanTitle(data.title),
      license:cleanLicense(data.license),
      tab:TABS.includes(data.tab)?data.tab:'find',
      assist:data.assist==='my-ai'?'my-ai':'manual',
      edits:JSON.stringify(valid),
      count:valid.length
    };
  }
  function resumeQuestion(count){
    return count?'고친 곳 '+count+'개를 이어서 할까요?':'보던 논문을 이어서 볼까요?';
  }
  function reopenMeta(record){
    const meta={};
    if(record.title) meta.title=record.title;
    if(record.license) meta.license=record.license;
    return meta;
  }
  async function reopen(record){
    const paper=root.FalsifyBoothPaper;
    const pending=paper&&typeof paper.open==='function'?paper.open(record.paperId,reopenMeta(record)):null;
    if(!pending||!(await pending)) return false;
    const store=boothEdits();
    if(store&&typeof store.restore==='function') store.restore(record.edits);
    const recipe=root.FalsifyBoothRecipe;
    if(recipe&&typeof recipe.setAssist==='function'&&record.assist&&record.assist!=='manual'){
      try{recipe.setAssist(record.assist);}catch{}
    }
    return true;
  }
  function showTab(doc, tab){
    if(tab==='find') return;
    const node=doc.getElementById('booth-tab-'+tab);
    if(node&&typeof node.click==='function') node.click();
  }
  function resumePanel(doc, record, done){
    const status=textNode(doc,'p','booth-resume-status','booth-feedback','');
    status.setAttribute('role','status');
    const panel=doc.createElement('section');
    panel.id='booth-resume';
    panel.className='booth-panel booth-resume';
    panel.setAttribute('aria-labelledby','booth-resume-text');
    const row=doc.createElement('div');
    row.className='booth-resume-actions';
    const go=button(doc,'이어서','booth-btn ink',()=>{void done(true,panel,status,[go,fresh]);});
    const fresh=button(doc,'처음부터','booth-btn line',()=>{void done(false,panel,status,[go,fresh]);});
    go.id='booth-resume-go';
    fresh.id='booth-resume-fresh';
    row.append(go,fresh);
    panel.append(textNode(doc,'p','booth-resume-text','booth-resume-text',resumeQuestion(record.count)),row,status);
    return panel;
  }
  function boothReady(doc){
    const host=doc.getElementById('booth');
    return !!(host&&!host.hidden&&root.FalsifyBoothPaper&&stepOf(doc)==='pick');
  }
  function skipResume(loc){
    const hash=loc&&typeof loc.hash==='string'?loc.hash:'';
    return hash==='#booth-result';
  }
  function resumeAction(doc, record, store){
    return async(yes, panel, status, buttons)=>{
      removeItem(store,PROGRESS_KEY);
      if(!yes){panel.remove();return;}
      for(const node of buttons) node.disabled=true;
      status.textContent='이어서 여는 중…';
      let ok=false;
      try{ok=await reopen(record);}catch{ok=false;}
      if(ok){showTab(doc,record.tab);panel.remove();return;}
      status.textContent='이어서 열지 못했어요. 논문을 다시 골라 주세요.';
      for(const node of buttons) node.disabled=false;
    };
  }
  /* The question waits (up to 20 s) for the booth config, which unhides #booth. */
  function offerResume(doc){
    const store=bag('sessionStorage');
    const record=readProgress(getItem(store,PROGRESS_KEY),Date.now());
    if(!record||skipResume(root.location)) return;
    const done=resumeAction(doc,record,store);
    let left=100;
    const tick=()=>{
      const anchor=doc.getElementById('booth-status');
      if(boothReady(doc)&&anchor){anchor.after(resumePanel(doc,record,done));return;}
      left-=1;
      if(left>0) root.setTimeout(tick,200);
    };
    tick();
  }
  function installProgress(doc){
    doc.addEventListener('visibilitychange',()=>{if(doc.visibilityState==='hidden') saveProgress(doc);});
    if(typeof root.addEventListener==='function') root.addEventListener('pagehide',()=>{saveProgress(doc);});
    offerResume(doc);
  }

  function install(){
    const doc=root.document;
    if(!doc||typeof doc.getElementById!=='function'||!doc.getElementById('booth')) return;
    installProgress(doc);
    if(kiosk()) installKiosk(doc);
  }
  /* Defer scripts run before DOMContentLoaded, so booth.js has built #booth by then. */
  function boot(){
    const doc=root.document;
    if(!doc||typeof doc.addEventListener!=='function') return;
    if(doc.readyState==='complete') install();
    else doc.addEventListener('DOMContentLoaded',install,{once:true});
  }

  root.FalsifyBoothRuntime=Object.freeze({
    kiosk,kioskFlag,storage,offline,offerRetry,wake,idleTimer,clearVisitor,handoff,kioskUrl,
    readProgress,progressNow,saveProgress,resumeQuestion,reopen,
    OFFLINE_TEXT,KIOSK_KEY,PROGRESS_KEY,RECEIPT_KEY,LANG_KEY,IDLE_MS,WAIT_IDLE_MS,WARN_MS
  });
  boot();
})(typeof window==='object'?window:globalThis);
