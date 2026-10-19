"""Flexible wrapper adapter: config validation, real-process transport modes, deterministic mapping."""
import hashlib
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
import harness
import harness_adapter
import red_service
import blue_service
from harness_wrapper import WrapperBackend, validate_adapter, transform_output, parse_output, resolve_pointer, stage_of

PROGRAM = str(Path(__file__).parent/'fixtures'/'wrapper_runtime_program.py')
STRING = {'type':'string'}
ANY = {}

def obj(**props): return {'type':'object','properties':props,'required':list(props),'additionalProperties':False}

def wrapper(mode='invocation', args=None, output=None, **given):
    return {'type':'wrapper','target':{'type':'stdio','executable':sys.executable,'args':[PROGRAM,*(args or [mode])]},
            'input':{'mode':mode,**given},'output':output or {'source':'stdout','format':'json'}}

def harness_with(adapter, role='red'): return {**harness.default(role),'adapter':adapter}

def request(role, text='Synthetic paper.', adapter=None):
    d={'schema':'falsify.document-'+role+'.v1','revision':'r1','requestId':'t1','sourceHash':hashlib.sha256(text.encode()).hexdigest(),
       'segments':[{'id':'s0','label':'p1','text':text}],'maxCalls':8,'consent':True,
       'harness':harness_with(adapter,role) if adapter else harness.default(role)}
    if role=='red':d['level']=1
    return d

def deep(n):
    node='leaf'
    for _ in range(n): node={'a':node}
    return node

def infer(adapter, schema, prompt='Synthetic prompt', role='red'):
    return WrapperBackend(harness_with(adapter,role),1).infer(prompt,schema)

class ValidationTests(unittest.TestCase):
    def test_contract_example_and_harness(self):
        a=wrapper()
        self.assertIs(validate_adapter(a),a)
        h=harness_with(a)
        self.assertEqual(harness.validate(h,'red'),h)
        self.assertFalse(harness.builtin(h))
        self.assertEqual(harness.model_label(h),'custom-wrapper-model-unverified')
        changed=harness_with({**a,'output':{'source':'stdout','format':'json','path':'/x'}})
        self.assertNotEqual(harness.digest(h),harness.digest(changed))
        for ok in [wrapper(args=['x','{output}']),wrapper(output={'source':'stdout','format':'json','map':deep(19)}),
                   wrapper('template',template={'p':{'$from':'/prompt'}}),
                   wrapper(output={'source':'stdout','format':'json-fence','path':'','stageMaps':{'scan':{},'selection':[],'red':1,'blue':None}})]:
            validate_adapter(ok)
    def test_rejections(self):
        base=wrapper();http={'type':'http','url':'https://example.org/review'}
        def out(**extra): return {**base,'output':{'source':'stdout','format':'json',**extra}}
        bad=[{**base,'extra':1},{**base,'target':{'type':'wrapper','target':base['target']}},
             {**base,'target':{**base['target'],'executable':'python'}},{**base,'target':{**base['target'],'shell':True}},
             {**base,'target':{'type':'http','url':'http://example.org/'}},{**base,'target':{'type':'http','url':'https://u:p@example.org/'}},
             {**base,'input':{'mode':'shell'}},{**base,'input':{'mode':'invocation','template':{}}},{**base,'input':{'mode':'template'}},
             {**base,'input':{'mode':'files'},'target':http},{**base,'output':{'source':'file','format':'json'},'target':http},
             wrapper(args=['{input}']),wrapper('prompt',args=['{schema}']),
             {**base,'output':{'source':'stdout'}},out(format='yaml'),out(source='stderr'),out(script='x'),
             out(path='a/b'),out(path='/a~2'),out(map={'$from':'/a','x':1}),out(map={'$eval':'1+1'}),out(map={'$from':'a'}),
             out(map={'$each':'/a'}),out(map={'__proto__':{}}),out(map={'k':{'constructor':1}}),out(stageMaps={'final':{}}),
             out(stageMaps=[]),out(map=deep(21)),out(map=list(range(1000))),out(map='x'*32001),out(map=float('nan'))]
        for a in bad:
            with self.subTest(a=repr(a)[-160:]),self.assertRaises(ValueError):harness.validate(harness_with(a),'red')
    def test_execution_consent_gates_wrapper(self):
        d=request('red',adapter=wrapper(args=['review']))
        with self.assertRaises(ValueError):red_service.validate_request(d)
        with self.assertRaises(ValueError):harness.backend(d,'red',1,None)
        d['executionConsent']=True
        self.assertIsInstance(harness.backend(d,'red',1,None),WrapperBackend)
        d['harness']['adapter']=d['harness']['adapter']['target']
        self.assertIsInstance(harness.backend(d,'red',1,None),harness_adapter.AdapterBackend)

class MappingTests(unittest.TestCase):
    def test_pointer(self):
        doc={'a/b':{'m~n':[10,20]},'':{'x':1}}
        self.assertIs(resolve_pointer(doc,''),doc)
        self.assertEqual(resolve_pointer(doc,'/a~1b/m~0n/1'),20)
        self.assertEqual(resolve_pointer(doc,'/'),{'x':1})
        for p in ['/a~1b/m~0n/2','/a~1b/m~0n/01','/a~1b/m~0n/-','/missing','/a~1b/m~0n/0/x','x']:
            with self.subTest(p=p),self.assertRaises(ValueError):resolve_pointer(doc,p)
    def test_fence_parsing(self):
        for text in ['```json\n{"a":1}\n```','\n```\n{"a":1}\n```\n','```json\r\n{"a":1}\r\n```\r\n']:
            self.assertEqual(parse_output(text.encode(),'json-fence'),{'a':1})
        for text in ['Here: ```json\n{"a":1}\n```','```json\n{"a":1}\n```\n```json\n{"b":2}\n```','{"a":1}',
                     '```json\n{"a":1}\n``` trailing prose','```python\n{"a":1}\n```']:
            with self.subTest(text=text),self.assertRaises(ValueError):parse_output(text.encode(),'json-fence')
        self.assertEqual(parse_output('﻿{"a":[1]}'.encode(),'json'),{'a':[1]})
        for raw in [b'```json\n{"a":1}\n```',b'{"a": NaN}',b'\xff',b'{"a":1} {"b":2}',b'x'*150001]:
            with self.subTest(raw=raw[:30]),self.assertRaises(ValueError):parse_output(raw,'json')
    def test_stage_detection(self):
        self.assertEqual([stage_of(s) for s in [red_service.SCAN,blue_service.SELECTION,red_service.RESULT,blue_service.RESULT,obj(x=STRING),None]],
                         ['scan','selection','red','blue',None,None])
    def test_stage_maps_override_then_map_then_identity(self):
        output={'source':'stdout','format':'json','path':'/r','map':{'v':{'$from':'/a'}},'stageMaps':{'red':{'v':{'$from':'/b'}}}}
        value={'r':{'a':1,'b':2}}
        self.assertEqual(transform_output(value,output,'red'),{'v':2})
        self.assertEqual(transform_output(value,output,'blue'),{'v':1})
        self.assertEqual(transform_output(value,output,None),{'v':1})
        self.assertEqual(transform_output(value,{'source':'stdout','format':'json','stageMaps':{'scan':{}}},'red'),value)
        each={'source':'stdout','format':'json','map':{'rows':{'$each':'/items','template':{'id':{'$from':'/k'},'tag':'lit','pair':[{'$from':''},0]}}}}
        self.assertEqual(transform_output({'items':[{'k':'a'},{'k':'b'}]},each),
                         {'rows':[{'id':'a','tag':'lit','pair':[{'k':'a'},0]},{'id':'b','tag':'lit','pair':[{'k':'b'},0]}]})
    def test_map_never_invents_defaults(self):
        def run(value, template): return transform_output(value,{'source':'stdout','format':'json','map':template})
        for value,template in [({},{'status':{'$from':'/status'}}),({'items':{}},{'$each':'/items','template':{}}),
                               ({'items':list(range(1001))},{'$each':'/items','template':0}),
                               ({'items':[{}]},{'$each':'/items','template':{'id':{'$from':'/id'}}}),
                               ({'rows':list(range(900))},[{'$from':'/rows'}]*200)]:
            with self.subTest(template=repr(template)[:80]),self.assertRaises(ValueError):run(value,template)

class RuntimeTests(unittest.TestCase):
    def test_invocation_mode_path_and_map(self):
        output={'source':'stdout','format':'json','path':'/result','map':{'role':{'$from':'/role'},'tag':{'$from':'/tag'},'call':{'$from':'/call'},
                'prompt':{'$from':'/prompt'},'texts':{'$each':'/items','template':{'t':{'$from':'/text'}}},'fixed':'literal'}}
        schema=obj(role=STRING,tag=STRING,call={'type':'integer'},prompt=STRING,texts={'type':'array','items':obj(t=STRING)},fixed=STRING)
        self.assertEqual(infer(wrapper(output=output),schema,'한글 prompt'),{'status':'ok','response':{'role':'red','tag':'falsify.harness-invocation.v1',
                         'call':1,'prompt':'한글 prompt','texts':[{'t':'a'},{'t':'b'}],'fixed':'literal'}})
    def test_prompt_mode_json_fence(self):
        prompt='line one\nline "two" 한글 ```not a fence'
        self.assertEqual(infer(wrapper('prompt',output={'source':'stdout','format':'json-fence'}),obj(echo=STRING),prompt)['response'],{'echo':prompt})
    def test_template_mode(self):
        template={'r':{'$from':'/role'},'p':{'$from':'/prompt'},'schemaType':{'$from':'/outputSchema/type'},'fixed':[1,'x',None,True]}
        r=infer(wrapper('template',template=template,output={'source':'stdout','format':'json','path':'/got'}),
                obj(r=STRING,p=STRING,schemaType=STRING,fixed={'type':'array','items':ANY}),'P',role='blue')
        self.assertEqual(r['response'],{'r':'blue','p':'P','schemaType':'object','fixed':[1,'x',None,True]})
    def test_files_mode_and_file_output(self):
        a=wrapper('files',args=['files','{input}','{prompt}','{schema}','{output}'],output={'source':'file','format':'json'})
        schema=obj(stdin=STRING,cwd=STRING,paths={'type':'array','items':STRING},role=STRING,promptMatches=ANY,schemaType=STRING)
        r=infer(a,schema,'Prompt with\nnewline',role='blue')['response']
        self.assertEqual((r['stdin'],r['role'],r['promptMatches'],r['schemaType']),('','blue',True,'object'))
        self.assertEqual([Path(p).name for p in r['paths']],['invocation.json','prompt.txt','schema.json','output.json'])
        for p in r['paths']:
            self.assertTrue(Path(p).is_absolute())
            self.assertEqual(os.path.normcase(str(Path(p).parent)),os.path.normcase(r['cwd']))
        self.assertFalse(Path(r['cwd']).exists())
    def test_placeholders_whole_tokens_only_no_shell(self):
        seen={}
        def fake(argv, stdin, cwd, stdout_path):
            seen.update(argv=argv,stdin=stdin,cwd=cwd);return b'{"x":"y"}'
        with mock.patch.object(harness_adapter,'run_stdio',fake):
            infer(wrapper(args=['x{output}','{output}','$(whoami)']),obj(x=STRING),'p')
        self.assertEqual(seen['argv'][:2],[sys.executable,PROGRAM])
        self.assertEqual(seen['argv'][2],'x{output}');self.assertEqual(seen['argv'][4],'$(whoami)')
        self.assertEqual(seen['argv'][3],os.path.join(seen['cwd'],'output.json'))
        self.assertEqual(json.loads(seen['stdin'])['schema'],'falsify.harness-invocation.v1');self.assertTrue(seen['stdin'].endswith(b'\n'))
    def test_red_and_blue_services_real_process(self):
        stage_maps={'scan':{'status':{'$from':'/state'},'summary':{'$from':'/notes'},'evidence':[]},
                    'red':{'status':{'$from':'/state'},'candidates':{'$each':'/items','template':{}}},
                    'blue':{'status':{'$from':'/state'},'findings':{'$each':'/items','template':{}}}}
        a=wrapper(args=['review'],output={'source':'stdout','format':'json','path':'/result','stageMaps':stage_maps})
        for role,service,key,text in [('red',red_service,'candidates','x'*72001),('blue',blue_service,'findings','Synthetic paper.')]:
            d=request(role,text,a);d['executionConsent']=True
            with mock.patch.object(harness_adapter,'run_stdio',wraps=harness_adapter.run_stdio) as spy:
                r=service.run_review(d,lambda _:None,threading.Event())
            self.assertEqual((r['status'],r[key]),('ok',[]))
            self.assertEqual(spy.call_count,4 if role=='red' else 1)
            self.assertEqual(r['model'],'custom-wrapper-model-unverified');self.assertEqual(r['harnessHash'],harness.digest(d['harness']))
    def test_shape_remains_authoritative(self):
        with mock.patch.object(harness_adapter,'run_stdio',return_value=b'{"status":"ok","findings":[],"hidden":true}'):
            with self.assertRaises(ValueError):infer(wrapper(),blue_service.RESULT,role='blue')
    def test_call_budget(self):
        backend=WrapperBackend(harness_with(wrapper('prompt',output={'source':'stdout','format':'json-fence'})),1)
        backend.infer('one',obj(echo=STRING))
        with self.assertRaises(ValueError):backend.infer('two',obj(echo=STRING))
    def test_timeout(self):
        with mock.patch.object(harness_adapter,'TIMEOUT_SECONDS',1):
            start=time.monotonic()
            with self.assertRaises(ValueError):infer(wrapper(args=['sleep']),obj(x=STRING))
            self.assertLess(time.monotonic()-start,30)
    def test_nonzero_exit_hides_output(self):
        with self.assertRaises(ValueError) as caught:infer(wrapper(args=['fail']),obj(x=STRING))
        self.assertNotIn('secret-token',str(caught.exception))
    def test_output_bounds_and_missing_file(self):
        file_output={'source':'file','format':'json'}
        for a in [wrapper(args=['big']),wrapper(args=['bigfile'],output=file_output),wrapper(args=['nofile'],output=file_output),
                  wrapper(args=['dirfile'],output=file_output)]:
            with self.subTest(mode=a['target']['args'][1]),self.assertRaises(ValueError):infer(a,obj(status=STRING))
    def test_symlink_output_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            try: os.symlink(os.path.join(d,'a'),os.path.join(d,'b'))
            except (OSError,NotImplementedError): self.skipTest('symlink creation is not permitted on this host')
        with self.assertRaises(ValueError):infer(wrapper(args=['symlink'],output={'source':'file','format':'json'}),obj(status=STRING))
    def test_link_output_rejected_by_lstat(self):
        import stat
        import harness_wrapper
        with tempfile.TemporaryDirectory() as d:
            path=os.path.join(d,'output.json')
            with open(path,'w') as f:f.write('{}')
            for mode in [stat.S_IFLNK|0o777,stat.S_IFDIR|0o777]:
                with self.subTest(mode=mode),mock.patch.object(harness_wrapper.os,'lstat',return_value=os.stat_result((mode,0,0,1,0,0,2,0,0,0))):
                    with self.assertRaises(ValueError):harness_wrapper.read_output_file(path)
            self.assertEqual(harness_wrapper.read_output_file(path),b'{}')
    def test_http_transport_bodies(self):
        sent=[]
        def fake(url, body, content_type='application/json'): sent.append((url,body,content_type));return b'{"x":"y"}'
        http={'type':'http','url':'https://example.org/review'}
        with mock.patch.object(harness_adapter,'post_https',fake):
            infer({**wrapper('prompt'),'target':http},obj(x=STRING),'raw 한글')
            infer({**wrapper(),'target':http},obj(x=STRING),'p')
        self.assertEqual(sent[0],('https://example.org/review','raw 한글'.encode(),'text/plain; charset=utf-8'))
        self.assertEqual(sent[1][2],'application/json');self.assertEqual(json.loads(sent[1][1])['prompt'],'p');self.assertFalse(sent[1][1].endswith(b'\n'))
    def test_http_private_target_denied_before_connect(self):
        a={**wrapper('prompt'),'target':{'type':'http','url':'https://127.0.0.1/review'}}
        with mock.patch.object(harness_adapter.socket,'create_connection') as connect:
            with self.assertRaises(ValueError):infer(a,obj(x=STRING))
        self.assertFalse(connect.called)

if __name__=='__main__':unittest.main()
