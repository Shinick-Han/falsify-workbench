import test from 'node:test';
import assert from 'node:assert/strict';
import {hex} from '../src/paragraph-pdf-crypto.mjs';
import {bindSourceTables,sourceTableCells,inSourceTableCell} from '../src/paragraph-source-tables.mjs';
test('table cells bind only matching source bytes and supported page geometry',()=>{
 const bytes=new Uint8Array([1,2,3]), proof={sha:hex(bytes),pages:[{width:200,height:300,rotation:0}],cells:[{pageIndex:0,bbox:[10,20,30,40]}]};
 const e={page:1,pageIndex:0,pageWidth:200,pageHeight:300,pageT:[1,0,0,1,0,0],M:{_FPDFPage_GetRotation:()=>0}};
 bindSourceTables(e,bytes,proof);let cells=sourceTableCells(e);assert.deepEqual(cells,[{l:10,r:30,b:260,t:280}]);
 assert.equal(inSourceTableCell({l:11,r:29,b:261,t:279},cells),true);
 assert.equal(inSourceTableCell({l:11,r:31,b:261,t:279},cells),false);
 e.pageT=[1,.05,0,1,0,0];assert.deepEqual(sourceTableCells(e),[]);e.pageT=[1,0,0,1,0,0];
 e.pageWidth=201;assert.deepEqual(sourceTableCells(e),[]);e.pageWidth=200;
 e.M._FPDFPage_GetRotation=()=>1;assert.deepEqual(sourceTableCells(e),[]);e.M._FPDFPage_GetRotation=()=>0;
 bindSourceTables(e,new Uint8Array([1,2,4]),proof);assert.deepEqual(sourceTableCells(e),[]);
});
