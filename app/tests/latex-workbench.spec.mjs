import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=await mkdtemp(join(tmpdir(),'falsify-workbench-'));
const bundle=await build({entryPoints:[new URL('../src/latex-workbench.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')],bundle:true,format:'esm',platform:'node',write:false,external:['./vendor/pdf.mjs']});
const file=join(dir,'workbench.mjs');await writeFile(file,bundle.outputFiles[0].contents);
const workbench=await import(pathToFileURL(file));
const {proposalTransaction}=workbench;
process.on('exit',()=>{void rm(dir,{recursive:true,force:true});});
const anchor=(start,end)=>({projectId:'p',nodeId:'n',path:'main.tex',kind:'text',start,end});
const part=(start,end)=>({anchor:anchor(start,end),before:'old',after:'new',kind:'text'});
test('multi-part proposals are one transaction and disable entire competing groups',()=>{
  const old=[{...part(1,3),id:'old:0',proposalId:'old',enabled:true},{...part(8,10),id:'old:1',proposalId:'old',enabled:true}];
  const next=proposalTransaction(old,{id:'new',sourceChanges:[part(2,4),part(12,14)]},true,'p');
  assert.deepEqual(next.map(x=>x.enabled),[false,false,true,true]);
  assert.deepEqual(next.slice(2).map(x=>x.id),['new:0','new:1']);
  assert.equal(old[0].enabled,true);
  assert.deepEqual(proposalTransaction(next,{id:'new',sourceChanges:[part(2,4),part(12,14)]},false,'p').slice(2).map(x=>x.enabled),[false,false]);
});
test('invalid and overlapping primitives fail without modifying input',()=>{
  const previous=[{...part(1,3),id:'existing',enabled:true}];
  assert.throws(()=>proposalTransaction(previous,{id:'x',sourceChanges:[part(2,5),part(4,6)]},true,'p'));
  assert.throws(()=>proposalTransaction(previous,{id:'x',sourceChanges:[part(5,6),{...part(7,8),anchor:{...anchor(7,8),projectId:'other'}}]},true,'p'));
  assert.equal(previous[0].enabled,true);
});

test('source editor restores history without overwriting focused typing and labels citations',async()=>{
  const {createLatexSourceEditor}=await import('../dist/latex-source-ui.js');
  class Element {
    constructor(tag,doc){this.tagName=tag;this.ownerDocument=doc;this.children=[];this.dataset={};this.listeners={};this.attributes={};this.value='';this.textContent='';}
    setAttribute(k,v){this.attributes[k]=v;if(k==='value')this.value=v;}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=nodes;}
    addEventListener(k,f){(this.listeners[k]??=[]).push(f);}
    fire(k){for(const f of this.listeners[k]||[])f({target:this});}
    querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tagName===tag?[c]:[]),...c.querySelectorAll(tag)]);}
    remove(){}
  }
  const doc={activeElement:null,createElement(tag){return new Element(tag,this);}};
  const container=new Element('div',doc),editor=createLatexSourceEditor({container});
  const section=container.children[0], edit=section.querySelectorAll('textarea')[0];
  const n={id:'n',kind:'citation',text:'example',displayText:'',sourceText:'\\cite{example}'};
  editor.setState({model:{nodes:[n]},changes:[],selection:{nodeId:'n'}});
  assert.equal(edit.value,'example');
  assert.ok(section.querySelectorAll('button').some(b=>b.textContent.includes('\\cite{example}')));
  editor.setState({changes:[{anchor:{nodeId:'n'},after:'other',enabled:true}]});assert.equal(edit.value,'other');
  doc.activeElement=edit;edit.value='in progress';edit.fire('input');editor.setState({changes:[]});assert.equal(edit.value,'in progress');
  doc.activeElement=null;edit.fire('blur');editor.setState({changes:[]});assert.equal(edit.value,'example');
});

test('source line selection includes nodes on the mapped line only',()=>{
  const {sourceNodesAtLine}=workbench;
  const project={files:[{path:'body.tex',bytes:new TextEncoder().encode('first\nsecond\nthird')}]};
  const model={nodes:[{id:'first',path:'body.tex',start:0,end:5},{id:'second',path:'body.tex',start:6,end:12},{id:'third',path:'body.tex',start:13,end:18}]};
  assert.deepEqual(sourceNodesAtLine(project,model,'body.tex',2).map(n=>n.id),['second']);
});
