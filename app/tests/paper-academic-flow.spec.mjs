import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveLayoutProfile} from '../src/paper-style-profile.mjs';

test('profile uses body character and line geometry, keeping heading and caption evidence distinct',()=>{
 const block=(id,text,style,y)=>({id,text,source:{pageIndex:0,range:{start:0,end:text.length},characters:[{start:0,end:text.length,styleId:style}],lines:[{bbox:[10,y,180,y+9]},{bbox:[10,y+12,180,y+21]}]}});
 const document={pages:[{sourcePageIndex:0,width:400}],styles:[{id:'body',size:9,fontName:'Serif'},{id:'title',size:18,fontName:'Serif Bold'},{id:'caption',size:8,fontName:'Sans'}],blocks:[block('p','A long body paragraph','body',20),block('h','Title','title',0),block('c','Figure 1 caption','caption',80)]};
 const flow={items:[{kind:'heading',blockIds:['h']},{kind:'paragraph',columns:2,blockIds:['p'],source:{pageIndex:0,bbox:[10,20,180,41]}},{kind:'asset',captionIds:['c'],source:{pageIndex:0,bbox:[10,50,180,75]}},{kind:'caption',blockIds:['c']}]};
 const p=deriveLayoutProfile(document,flow);assert.equal(p.bodyFontSize,9);assert.equal(p.bodyLineHeight,12);assert.equal(p.headingFontSize,18);assert.equal(p.captionFontSize,8);assert.deepEqual(p.bodyFontNames,['Serif']);assert.equal(p.captions[0].text,'Figure 1 caption');assert.deepEqual(p.columns[0].bbox,[10,20,180,41]);
});
import {webcrypto,createHash} from 'node:crypto';
import {File} from 'node:buffer';
import {composeDocument} from '../src/paper-compose.mjs';
globalThis.crypto ||= webcrypto; globalThis.File ||= File;
test('continuous two-column flow uses native pages and passes source profile to checker',async()=>{
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex');
 const text='A body paragraph';const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{width:400,height:600}],styles:[{id:'s',size:9,fontName:'Serif'}],blocks:[{id:'p',text,source:{pageIndex:0,range:{start:0,end:text.length},characters:[{start:0,end:text.length,styleId:'s'}],lines:[]}}]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'paragraph',columns:2,span:'column',blockIds:['p']}]}; let source,checked;
 const out=await composeDocument({document,flow,sourceBytes:src},{compile:async p=>(source=p.source,new TextEncoder().encode('%PDF-1.4')),outputCheck:async p=>(checked=p,{checks:{content:{status:'pass'}},findings:[]})});
 assert.match(source,/#set page\([^\n]+columns: 2/);assert.doesNotMatch(source,/#columns\(2\)/);assert.match(source,/#set text\(size: 9pt\)/);assert.equal(checked.layoutProfile.bodyFontSize,9);assert.deepEqual(out.layoutProfile,checked.layoutProfile);
});
