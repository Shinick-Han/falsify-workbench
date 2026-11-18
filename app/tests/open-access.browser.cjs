// Loopback browser regression for the event page. The API is mocked; no remote call or real key.
const {chromium}=require('playwright'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const dist=path.resolve(__dirname,'../dist');
const api='https://falsify-cloud-api.ai-gongbu.workers.dev';
const key='booth-test-key';
const guestToken='fsg_'+'a'.repeat(43);
const eventConfig='globalThis.FalsifyCloudConfig=Object.freeze({apiBase:'+JSON.stringify(api)+',provider:"confluence",hostedAi:Object.freeze({enabled:true,apiBase:'+JSON.stringify(api)+'}),openAccess:Object.freeze({enabled:true})});';
const caps={enabled:true,provider:'synthetic',execution:'server',models:['synthetic-model'],efforts:['high'],limits:{maxUploadBytes:33554432,maxPromptChars:8000},openAccess:{enabled:true,accessKeyRequired:true}};
let serveEvent=true;
function job(state){return {id:'job-1',role:'red',state,progress:{completedCalls:state==='completed'?1:0,requiredCalls:1,phase:state},model:'synthetic-model',effort:'high',provider:'synthetic',usage:null,result:null,artifacts:[],createdAt:'2026-11-18T00:00:00.000Z',updatedAt:'2026-11-18T00:00:00.000Z'};}
function send(res,status,type,body){res.writeHead(status,{'Content-Type':type});res.end(body);}
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/cloud-config.js'&&serveEvent) return send(res,200,'text/javascript',eventConfig);
  const name=url.pathname==='/'?'/index.html':url.pathname;
  const filename=path.resolve(dist,'.'+name);
  if(!filename.startsWith(dist+path.sep)) return send(res,403,'text/plain','');
  try{
    const body=fs.readFileSync(filename);
    const ext=path.extname(filename);
    send(res,200,({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm'}[ext]||'application/octet-stream'),body);
  }catch{send(res,404,'text/plain','');}
});
async function mockApi(page,guests){
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.hostname==='127.0.0.1'||url.hostname==='localhost') return route.continue();
    if(url.pathname==='/v1/ai/guest'&&req.method()==='POST'){
      guests.push({url:req.url(),body:req.postData()||''});
      return route.fulfill({status:201,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify({guest:{token:guestToken,expiresAt:new Date(Date.now()+3600_000).toISOString()}})});
    }
    if(url.pathname==='/v1/ai/capabilities') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(caps)});
    if(url.pathname==='/v1/ai/uploads'&&req.method()==='POST'){
      const raw=req.postDataBuffer()||Buffer.alloc(0),sha=createHash('sha256').update(raw).digest('hex');
      return route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({upload:{id:'up-1',sha256:sha,name:'synthetic.pdf',mime:'application/pdf',bytes:raw.length,deduplicated:false}})});
    }
    if(url.pathname==='/v1/ai/jobs'&&req.method()==='POST') return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({job:job('queued'),replayed:false})});
    if(/^\/v1\/ai\/jobs\/[^/]+$/.test(url.pathname)) return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({job:job('completed')})});
    return route.fulfill({status:404,contentType:'application/json',body:'{}'});
  });
}
async function untilCount(list,count,label){
  const deadline=Date.now()+15000;
  while(list.length<count&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(list.length,count,label);
}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  let browser;
  try{
    browser=await chromium.launch({channel:process.platform==='win32'?'msedge':undefined,headless:true});
    const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[],requests=[],guests=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>requests.push(request.url()));
    await mockApi(page,guests);
    await page.goto(origin+'/index.html#k='+encodeURIComponent(key));
    await page.waitForFunction(()=>(document.querySelector('#hosted-ai-status')?.textContent||'').includes('웹 실행 준비됨'));
    assert.equal(guests.length,0,'load does not mint a guest');
    assert.equal(page.url().includes('k='),false,'address bar drops the access key');
    assert.equal(page.url().includes(key),false);
    assert.equal(await page.locator('#hosted-ai-login-form').isVisible(),false);
    assert.equal(await page.locator('#hosted-ai-register-panel').isVisible(),false);
    assert.equal(await page.locator('#hosted-ai-logout').isVisible(),false);
    assert.equal(await page.locator('#local-bridge').isVisible(),false);
    assert.equal(requests.some(url=>url.includes(':7816')),false);
    await page.setViewportSize({width:390,height:900});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow at 390');
    await page.locator('#hosted-ai-file').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7 synthetic open-access fixture\n%%EOF\n')});
    await page.waitForFunction(()=>(document.querySelector('#hosted-ai-file-status')?.textContent||'').includes('sha256'));
    assert.equal(guests.length,0,'choosing a file does not mint a guest');
    await page.locator('#hosted-ai-prompt').fill('Check the methods section only.');
    await page.locator('#hosted-ai-run').click();
    await untilCount(guests,1,'the first run mints one guest');
    assert.deepEqual(JSON.parse(guests[0].body),{accessKey:key});
    assert.equal(guests[0].url.includes(key),false);
    assert.equal(guests[0].url.includes('k='),false);
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(guests.length,1,'a later upload does not mint again');
    assert.equal(page.url().includes('k='),false);
    assert.deepEqual(errors,[]);
    serveEvent=false;
    const plain=await context.newPage(),plainErrors=[],plainGuests=[];
    plain.on('pageerror',error=>plainErrors.push(error.message));
    await mockApi(plain,plainGuests);
    await plain.goto(origin+'/index.html');
    await plain.waitForFunction(()=>{const node=document.querySelector('#hosted-ai-status');return !!node&&!!node.textContent&&!node.textContent.includes('확인하는 중');});
    const flags=await plain.evaluate(()=>({open:document.documentElement.getAttribute('data-open-access'),session:typeof FalsifyHostedSession}));
    assert.equal(flags.open,null);
    assert.equal(flags.session,'undefined');
    assert.equal(plainGuests.length,0);
    assert.deepEqual(plainErrors,[]);
    console.log('PASS open-access browser: key captured before routing, guest minted on first run, ordinary page stays closed');
    await context.close();
  }finally{await browser?.close();server.close();}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
