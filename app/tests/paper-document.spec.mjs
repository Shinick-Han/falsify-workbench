import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as mupdf from 'mupdf';
import {normalizeDocument,readDocument} from '../src/paper-document.mjs';
const hash='a'.repeat(64);
const block=(text,x,y)=>({bbox:[x,y,x+80,y+10],chars:[...text].map((text,i)=>({text,bbox:[x+i,y,x+i+1,y+10],fontName:'Helvetica',size:10,color:[0,0,0]}))});
const input=()=>({sourceSha256:hash,pages:[{width:400,height:600,blocks:[block('repeat −12',10,20),block('repeat −12',220,20),block('left 2',10,40),block('right 3',220,40)],images:[{bbox:[50,100,90,150]}]}]});
test('columns, exact source ranges, repeated quotes and stable source IDs',()=>{
 const m=normalizeDocument(input()); assert.equal(m.schema,'falsify.paper-document.v1'); assert.equal(m.pages[0].readingOrder,'geometry-columns');
 assert.deepEqual(m.blocks.map(b=>b.text),['repeat −12','left 2','repeat −12','right 3']);
 assert.notEqual(m.blocks[0].id,m.blocks[2].id); assert.equal(m.blocks[0].text,'repeat −12');
 for(const b of m.blocks) {const {start,end}=b.source.range;assert.equal(m.pages[0].text.slice(start,end),b.text);for(const c of b.source.characters)assert.ok(c.end>c.start);}
 assert.deepEqual(m,normalizeDocument(input())); assert.equal(m.assets.length,1); assert.deepEqual(m.relations,[]); assert.deepEqual(m.blocks[0].captionIds,[]);
 const changed=input();changed.sourceSha256='b'.repeat(64);assert.notEqual(normalizeDocument(changed).blocks[0].id,m.blocks[0].id);
});
test('ambiguous layout retains reader order and records uncertainty',()=>{const p=input();p.pages[0].blocks.push(block('wide title',5,0));p.pages[0].blocks.at(-1).bbox=[5,0,350,10];const m=normalizeDocument(p);assert.equal(m.pages[0].readingOrder,'reader');assert.equal(m.blocks[1].text,'repeat −12');assert.ok(m.diagnostics.some(d=>d.code==='reading-order-unresolved'));});
function fixture(){const d=new mupdf.PDFDocument();try{const font=d.addSimpleFont(new mupdf.Font('Helvetica'));d.insertPage(-1,d.addPage([0,0,300,400],0,{Font:{helv:font}},'BT /helv 12 Tf 30 300 Td (Value -12) Tj ET'));const b=d.saveToBuffer();try{return b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}}
test('pinned MuPDF reads real synthetic PDF and enforces source hash',async()=>{const bytes=fixture(),sha=createHash('sha256').update(bytes).digest('hex');const m=await readDocument({file:bytes,fileHash:sha});assert.equal(m.sourceSha256,sha);assert.equal(m.pages[0].width,300);assert.match(m.pages[0].text,/Value -12/);assert.ok(m.styles.some(s=>s.fontName));assert.ok(m.blocks[0].source.characters.every(c=>c.bbox));await assert.rejects(readDocument({file:bytes,fileHash:'0'.repeat(64)}),{code:'stale-source'});});
test('abort before and during asynchronous file read',async()=>{const c=new AbortController();c.abort();await assert.rejects(readDocument({file:fixture(),signal:c.signal}),{name:'AbortError'});const d=new AbortController();await assert.rejects(readDocument({file:{async arrayBuffer(){d.abort();return fixture().buffer;}},signal:d.signal}),{name:'AbortError'});assert.throws(()=>normalizeDocument({...input(),signal:c.signal}),{name:'AbortError'});});
test('abort between pages of a real PDF',async()=>{const d=new mupdf.PDFDocument();let bytes;try{for(let i=0;i<2;i++)d.insertPage(-1,d.addPage([0,0,300,400],0,{},''));const b=d.saveToBuffer();try{bytes=b.asUint8Array().slice();}finally{b.destroy();}}finally{d.destroy();}const c=new AbortController();setTimeout(()=>c.abort(),0);await assert.rejects(readDocument({file:bytes,signal:c.signal}),{name:'AbortError'});});
