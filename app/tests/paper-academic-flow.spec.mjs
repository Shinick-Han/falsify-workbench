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
 assert.match(source,/#set page\([^\n]+columns: 2/);assert.doesNotMatch(source,/#columns\(2\)/);assert.match(source,/#set text\(size: 9pt\)/);assert.equal(checked.layoutProfile.sourceProfile.bodyFontSize,9);assert.equal(checked.layoutProfile.sourceProfile.coordinateSpace,'source');assert.equal(checked.layoutProfile.bodyFontSize,undefined);assert.deepEqual(out.layoutProfile,checked.layoutProfile);
});

test('repagination and subset font names cannot become output geometry or font assertions',async()=>{
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex'), text='Figure 1. A caption';
 const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'s',size:9,fontName:'ABCDEF+SourceSerif'}],blocks:[{id:'p',text:'A body paragraph',source:{pageIndex:0,range:{start:0,end:16},characters:[{start:0,end:16,styleId:'s'}],lines:[]}},{id:'c',text,source:{pageIndex:0,range:{start:16,end:16+text.length},lines:[]}}]};
 const box=[20,200,300,300], flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'paragraph',columns:2,span:'column',blockIds:['p'],source:{pageIndex:0,bbox:[20,30,180,190]}},{kind:'asset',span:'page',assetIds:['pic'],blockIds:[],captionIds:['c'],source:{pageIndex:0,bbox:box}},{kind:'caption',blockIds:['c']}]};
 const svg=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="100"></svg>');let checked;
 await composeDocument({document,flow,sourceBytes:src,assets:[{id:'pic',source:{pageIndex:0,bbox:box},content:{representation:'svg',bytes:svg}}]},{fonts:{family:'Noto Serif'},compile:async()=>({bytes:new TextEncoder().encode('%PDF-1.4'),blockSpans:[{id:'pic',start:{page:3,x:36,y:36},end:{page:3,x:36,y:136}}]}),outputCheck:async p=>(checked=p,{checks:{content:{status:'pass'}},findings:[]})});
 assert.equal(checked.layoutProfile.coordinateSpace,'output');assert.equal(checked.layoutProfile.columns,undefined);assert.equal(checked.layoutProfile.captions,undefined);assert.equal(checked.layoutProfile.bodyFontNames,undefined);assert.equal(checked.layoutProfile.bodyFontSize,undefined);assert.deepEqual(checked.layoutProfile.sourceProfile.bodyFontNames,['ABCDEF+SourceSerif']);assert.equal(checked.layoutProfile.sourceProfile.captions[0].assetPageIndex,0);assert.equal(checked.blockSpans[0].start.page,3);
});

test('layout policy is bounded, source-relative and rejects missing evidence',async()=>{
 const src=new TextEncoder().encode('source'), sourceSha256=createHash('sha256').update(src).digest('hex'), text='Body paragraph';
 const document={schema:'falsify.paper-document.v1',sourceSha256,pages:[{sourcePageIndex:0,width:400,height:600}],styles:[{id:'s',size:10}],blocks:[{id:'p',text,source:{pageIndex:0,range:{start:0,end:text.length},characters:[{start:0,end:text.length,styleId:'s'}],lines:[{range:{start:0,end:7},bbox:[0,0,100,10]},{range:{start:7,end:text.length},bbox:[0,12,100,22]}]}}]};
 const flow={schema:'falsify.paper-flow.v1',sourceSha256,items:[{kind:'paragraph',columns:2,blockIds:['p']}]};let source;
 const compile=async p=>(source=p.source,new TextEncoder().encode('%PDF-1.4'));
 const result=await composeDocument({document,flow,sourceBytes:src,layoutPolicy:{lineHeightScale:1.05,paragraphSpacingEm:0.5,columnGutterEm:1.2}},{compile});
 assert.match(source,/leading: 2\.6[0-9]*pt/);assert.match(source,/spacing: 5pt/);assert.match(source,/gutter: 12pt/);assert.equal(result.layoutPolicy.lineHeightScale,1.05);
 for(const layoutPolicy of [{lineHeightScale:0.5},{fontScale:0.9},{columnGutterEm:3},{paragraphSpacingEm:NaN}]) await assert.rejects(composeDocument({document,flow,sourceBytes:src,layoutPolicy},{compile}),/Invalid layout policy/);
 const noEvidence=structuredClone(document);noEvidence.styles=[];await assert.rejects(composeDocument({document:noEvidence,flow,sourceBytes:src,layoutPolicy:{columnGutterEm:1}},{compile}),/requires source measurements/);
});
