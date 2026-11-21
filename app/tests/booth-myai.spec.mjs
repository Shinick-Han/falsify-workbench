'use strict';
// booth-myai.js: prompt contents and length cap, and parsing of realistic chatbot answers.
// Pure functions only; FalsifyBoothRecipe is absent, so the local copy of the contract rules is used.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
globalThis.FalsifyExternalExchange = require('../dist/external-exchange.js');
const M = require('../dist/booth-myai.js');

const PAGE = [
  'Table 1: Agreement with human annotators.',
  'Faithfulness Answer Relevance Context Relevance',
  'Ragas 0.95 0.78 0.70',
  'GPT Score 0.72 0.52 0.63',
  'Ragas agrees best with the human annota-',
  'tors on faithfulness.',
].join('\n');
const segments = [
  {id: 'page-4', pageIndex: 3, text: 'We use the WikiEval dataset with 50 questions.'},
  {id: 'page-5', pageIndex: 4, text: PAGE},
];
const ctx = {segments, fileHash: 'hash', paperId: '2309.15217'};
const info = {paperId: '2309.15217', title: 'Ragas: Automated Evaluation of Retrieval Augmented Generation',
  license: 'cc-by-4.0', hint: 'Table 1의 점수 하나를 바꿔 보세요', page: 5, pageText: PAGE};
const good = {schema: 'falsify.booth.recipe.v1', paperId: '2309.15217',
  edits: [{page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}],
  defectType: 'number', reason: 'Lowered Ragas faithfulness.', source: 'my-ai'};
const FENCE = String.fromCharCode(96).repeat(3);

test('Korean prompt carries the contract, exact PDF link, cannot_read clause and no tips or page text', () => {
  const p = M.buildPrompt(info);
  assert.match(p, /당신은 논문 검증 게임의 출제자입니다\. 아래 논문에 결함을 1~5개 심어 주세요\. 다른 AI가 이 수정본에서 결함을 찾을 수 있는지 겨룹니다\./);
  assert.ok(p.includes('PDF: https://arxiv.org/pdf/2309.15217'));
  assert.ok(p.includes('{"error":"cannot_read_paper"}'));
  assert.match(p, /이 대화에 PDF가 첨부돼 있으면/);
  assert.match(p, /find는 논문 원문에서 글자 그대로 복사/);
  assert.match(p, /실제 인물이나 저자 이름을 지어내지 마세요/);
  assert.match(p, /CC BY/);
  assert.match(p, /edits: 1~5개/);
  assert.match(p, /"schema": "falsify\.booth\.recipe\.v1"/);
  assert.match(p, /"source": "my-ai"/);
  assert.match(p, /paperId는 "2309\.15217"/);
  assert.match(p, /number, figure, citation, logic, method, other/);
  assert.match(p.trim().split('\n').at(-1), /JSON 하나만 답하세요/);
  assert.ok(!p.includes(PAGE), 'no page text in prompt');
  assert.ok(!p.includes('Table 1: Agreement'), 'no page snippet in prompt');
  assert.ok(!p.includes('Table 1의 점수 하나를 바꿔 보세요'), 'no mission hint in prompt');
  assert.doesNotMatch(p, /좋은 결함/);
  assert.doesNotMatch(p, /티 나지 않지만|꼼꼼한 검토자라면/);
  assert.doesNotMatch(p, /대상 쪽/);
  assert.doesNotMatch(p, /0\.95|0\.50/);
  assert.doesNotMatch(p, /1~3/);
  assert.doesNotMatch(p, /"source": "agent"/);
});

test('the neutral format example in both languages is a valid my-ai recipe with no real values', () => {
  for (const lang of ['ko', 'en']) {
    const p = M.buildPrompt(info, {lang});
    const start = p.indexOf('{\n  "schema"');
    const example = JSON.parse(p.slice(start, p.indexOf('\n}', start) + 2));
    assert.equal(example.source, 'my-ai');
    assert.equal(example.paperId, '2309.15217');
    assert.equal(example.defectType, 'other');
    assert.equal(M.validateLocal(example).ok, true, lang + ' example validates');
    assert.doesNotMatch(JSON.stringify(example), /0\.95|0\.50/);
  }
});

test('English variant on request; Korean by default', () => {
  const en = M.buildPrompt(info, {lang: 'en'});
  assert.match(en, /You are setting a puzzle for a paper-checking game\. Plant 1 to 5 defects in the paper below\. Another AI will try to find them in the edited copy\./);
  assert.ok(en.includes('PDF: https://arxiv.org/pdf/2309.15217'));
  assert.ok(en.includes('{"error":"cannot_read_paper"}'));
  assert.match(en, /edits: 1 to 5 items/);
  assert.match(en, /Answer with the JSON object only/);
  assert.ok(!en.includes(PAGE), 'no page text in EN prompt');
  assert.ok(!en.includes('Table 1의 점수 하나를 바꿔 보세요'), 'no mission hint in EN prompt');
  assert.doesNotMatch(en, /Good defects/i);
  assert.doesNotMatch(en, /subtle|careful reviewer/i);
  assert.doesNotMatch(en, /0\.95|0\.50/);
  assert.doesNotMatch(en, /1-3/);
  assert.doesNotMatch(en, /[\uac00-\ud7a3]/, 'no Hangul in EN prompt');
  assert.match(M.buildPrompt(info), /답 형식/);
});

test('pdfUrl builds safe arXiv PDF links and rejects invalid IDs', () => {
  assert.equal(M.pdfUrl('2309.15217'), 'https://arxiv.org/pdf/2309.15217');
  assert.equal(M.pdfUrl('2309.15217v2'), 'https://arxiv.org/pdf/2309.15217v2');
  assert.equal(M.pdfUrl('hep-th/9901001'), 'https://arxiv.org/pdf/hep-th/9901001');
  assert.equal(M.pdfUrl('math.GT/0309136'), 'https://arxiv.org/pdf/math.GT/0309136');
  for (const bad of ['', null, undefined, '../etc/passwd', '2309.15217?x=1', 'javascript:alert(1)', '2309.15217#a']) {
    assert.equal(M.pdfUrl(bad), '', 'rejects ' + String(bad));
  }
  assert.doesNotMatch(M.buildPrompt({paperId: 'javascript:alert(1)'}), /PDF: /);
  assert.equal(typeof M.buildPrompt(null), 'string');
});

test('cannot_read_paper is recognised alone, with whitespace/case, in prose or a code fence, unless edits exist', () => {
  const msg = 'AI가 논문을 열지 못했어요. 원문 PDF를 받아 AI에 첨부한 뒤 다시 물어봐 주세요.';
  const cases = [
    '{"error":"cannot_read_paper"}',
    '  {  "ERROR" : "Cannot_Read_Paper"  }  ',
    FENCE + 'json\n{\n  "error": "cannot_read_paper"\n}\n' + FENCE,
    '외부 링크를 열 수 없어요.\n\n{"error": "cannot_read_paper"}\n\nPDF를 첨부해 주세요.',
    '{"error": "cannot_read_paper", "edits": []}',
  ];
  for (const raw of cases) {
    const out = M.parseAnswer(raw, ctx);
    assert.equal(out.recipe, null, raw);
    assert.equal(out.diagnostics.length, 1, raw);
    assert.equal(out.diagnostics[0].level, 'error');
    assert.equal(out.diagnostics[0].code, 'cannot_read_paper');
    assert.equal(out.diagnostics[0].message, msg);
  }
  const withEdits = 'Note: would return {"error":"cannot_read_paper"} if unread, but I read it:\n' + JSON.stringify(good);
  assert.deepEqual(M.parseAnswer(withEdits, ctx).recipe, good);
});

test('bare JSON answer', () => {
  const {recipe, diagnostics} = M.parseAnswer(JSON.stringify(good), ctx);
  assert.deepEqual(recipe, good);
  assert.deepEqual(diagnostics, []);
});

test('fenced JSON with prose around it, source forced to my-ai', () => {
  const raw = 'Sure! Here is a subtle defect:\n\n' + FENCE + 'json\n' + JSON.stringify({...good, source: 'agent'}, null, 2) +
    '\n' + FENCE + '\n\nThis changes the faithfulness score {so the claim breaks}.';
  const {recipe} = M.parseAnswer(raw, ctx);
  assert.equal(recipe.source, 'my-ai');
  assert.deepEqual(recipe.edits, good.edits);
});

test('prose before and after a bare object', () => {
  const raw = '알겠습니다. 다음과 같이 바꿨어요.\n' + JSON.stringify(good) + '\n도움이 되었길 바라요!';
  assert.equal(M.parseAnswer(raw, ctx).recipe.edits[0].replace, '0.50');
});

test('before/after keys, string page and missing schema', () => {
  const raw = JSON.stringify({paperId: '2309.15217', edits: [
    {page: '5', before: '0.95', after: '0.50'},
    {page: '5쪽', original: 'GPT Score 0.72', modified: 'GPT Score 0.97'},
  ], defectType: 'Number', rationale: 'Swapped which metric wins.'});
  const {recipe, diagnostics} = M.parseAnswer(raw, ctx);
  assert.equal(recipe.schema, 'falsify.booth.recipe.v1');
  assert.deepEqual(recipe.edits, [{page: 5, find: '0.95', replace: '0.50'}, {page: 5, find: 'GPT Score 0.72', replace: 'GPT Score 0.97'}]);
  assert.equal(recipe.defectType, 'number');
  assert.equal(recipe.reason, 'Swapped which metric wins.');
  assert.equal(diagnostics.filter(d => d.level === 'error').length, 0);
});

test('a top-level array of edits', () => {
  const raw = '[{"page": 5, "find": "0.95", "replace": "0.59"}, {"find": "50 questions", "replace": "500 questions"}]';
  const {recipe} = M.parseAnswer(raw, ctx);
  assert.equal(recipe.paperId, '2309.15217');
  assert.equal(recipe.edits.length, 2);
  assert.equal(recipe.edits[1].page, undefined);
  assert.equal(recipe.source, 'my-ai');
});

test('numbers as values, a wrong paper id and extra keys are fixed with notes', () => {
  const raw = JSON.stringify({schema: 'falsify.booth.recipe.v1', paperId: 'arXiv:2401.00001', notes: 'x',
    edits: [{page: 5, find: 0.95, replace: 0.5}], source: 'my-ai'});
  const {recipe, diagnostics} = M.parseAnswer(raw, ctx);
  assert.deepEqual(recipe.edits[0], {page: 5, find: '0.95', replace: '0.5'});
  assert.equal(recipe.paperId, '2309.15217');
  assert.ok(diagnostics.some(d => d.code === 'paper_forced'));
  assert.ok(diagnostics.some(d => d.code === 'keys_dropped'));
});

test('smart quotes and a trailing comma are repaired', () => {
  const q = s => '' + String.fromCharCode(0x201c) + '' + s + '' + String.fromCharCode(0x201d) + '';
  const raw = '{' + q('edits') + ': [{' + q('find') + ': ' + q('0.95') + ', ' + q('replace') + ': ' + q('0.50') + ',}],}';
  assert.equal(M.parseAnswer(raw, ctx).recipe.edits[0].replace, '0.50');
});

test('invalid JSON gets a helpful Korean diagnostic', () => {
  const broken = M.parseAnswer('{"edits": [{"find": "0.95" "replace": "0.50"}]}', ctx);
  assert.equal(broken.recipe, null);
  assert.equal(broken.diagnostics[0].code, 'json_syntax');
  assert.match(broken.diagnostics[0].message, /JSON 모양이 깨져/);
  const cut = M.parseAnswer('{"edits": [{"find": "0.95",', ctx);
  assert.equal(cut.recipe, null);
  assert.equal(cut.diagnostics[0].code, 'json_syntax');
  assert.ok(cut.diagnostics.some(d => d.code === 'cut'));
  const none = M.parseAnswer('죄송하지만 그 요청은 도와드릴 수 없어요.', ctx);
  assert.equal(none.diagnostics[0].code, 'no_json');
  assert.equal(M.parseAnswer('   ', ctx).diagnostics[0].code, 'empty');
});

test('rule violations are reported in plain Korean', () => {
  const same = M.parseAnswer(JSON.stringify({edits: [{find: '0.95', replace: '0.95'}]}), ctx);
  assert.equal(same.recipe, null);
  assert.ok(same.diagnostics.some(d => /바꾸기 전과 후가 같아요/.test(d.message)));
  const many = M.parseAnswer(JSON.stringify({edits: Array.from({length: 6}, (_, i) => ({find: 'a' + i, replace: 'b'}))}), ctx);
  assert.ok(many.diagnostics.some(d => /5개까지/.test(d.message)));
  const long = M.parseAnswer(JSON.stringify({edits: [{find: 'x'.repeat(301), replace: 'y'}]}), ctx);
  assert.ok(long.diagnostics.some(d => /300자/.test(d.message)));
});

test('an invalid outer object is not replaced by one of its inner edits', () => {
  const raw = JSON.stringify({edits: [{find: '0.95', replace: '0.95'}]});
  assert.equal(M.parseAnswer(raw, ctx).recipe, null);
});

test('a later valid object is used when an earlier fragment is not a recipe', () => {
  const raw = 'Format reminder: {"note": "..."} then the answer.\n' + JSON.stringify(good);
  assert.deepEqual(M.parseAnswer(raw, ctx).recipe, good);
});

test('a find that is not on the page is accepted with a warning; hyphenation is normalised', () => {
  const {recipe, diagnostics} = M.parseAnswer(JSON.stringify({edits: [{page: 5, find: '0.99', replace: '0.11'}]}), ctx);
  assert.ok(recipe);
  assert.ok(diagnostics.some(d => d.code === 'find_missing' && d.level === 'warn'));
  const hyphen = M.parseAnswer(JSON.stringify({edits: [{find: 'human annotators on faithfulness', replace: 'human annotators on relevance'}]}), ctx);
  assert.ok(hyphen.recipe);
  assert.equal(hyphen.diagnostics.filter(d => d.code === 'find_missing').length, 0);
});

test('Before/After markdown falls back to FalsifyExternalExchange', () => {
  const raw = '아래처럼 바꿔 보세요.\n\nBefore: Ragas 0.95 0.78 0.70\nAfter: Ragas 0.59 0.78 0.70\nRationale: 표와 본문이 어긋나게\n';
  const {recipe, diagnostics} = M.parseAnswer(raw, ctx);
  assert.equal(recipe.source, 'my-ai');
  assert.deepEqual(recipe.edits, [{page: 5, find: 'Ragas 0.95 0.78 0.70', replace: 'Ragas 0.59 0.78 0.70'}]);
  assert.ok(diagnostics.some(d => d.code === 'before_after'));
  assert.equal(M.parseAnswer(raw, {...ctx, segments: []}).recipe, null);
});

test('FalsifyBoothRecipe.validate is preferred when present', () => {
  const seen = [];
  globalThis.FalsifyBoothRecipe = {validate(obj) { seen.push(obj); return {ok: false, errors: [{code: 'find_not_found', field: 'edits[0].find', message: 'S1 says no'}]}; }};
  try {
    const out = M.parseAnswer(JSON.stringify(good), ctx);
    assert.equal(out.recipe, null);
    assert.equal(seen.length, 1);
    assert.ok(out.diagnostics.some(d => d.message === 'S1 says no'));
  } finally {
    delete globalThis.FalsifyBoothRecipe;
  }
});

test('local contract rules', () => {
  assert.equal(M.validateLocal(good).ok, true);
  assert.equal(M.validateLocal({...good, extra: 1}).ok, false);
  assert.equal(M.validateLocal({...good, paperId: 'hep-th/9901001'}).ok, true);
  assert.equal(M.validateLocal({...good, paperId: 'nope'}).ok, false);
  assert.equal(M.validateLocal({...good, edits: [{find: 'a' + String.fromCharCode(1), replace: 'b'}]}).ok, false);
  assert.equal(M.validateLocal({...good, reason: 'line\nbreak'}).ok, true);
  assert.equal(M.validateLocal({...good, edits: [{find: 'a', replace: ''}]}).ok, true);
  assert.equal(M.validateLocal({...good, edits: [{page: 501, find: 'a', replace: 'b'}]}).ok, false);
  assert.equal(M.validateLocal({...good, reason: 'r'.repeat(501)}).ok, false);
  assert.equal(M.validateLocal({...good, reason: 'x'.repeat(500), edits: Array.from({length: 5}, () => ({find: 'f'.repeat(300), replace: '한'.repeat(300), context: 'c'.repeat(600)}))}).ok, false, 'over 8 KB');
});

test('pathological unbalanced pastes stay fast and explain themselves', () => {
  const cases = ['{'.repeat(200000), '['.repeat(200000), '{"a":'.repeat(40000), 'x{'.repeat(100000),
    'Before: Ragas 0.95\nAfter: Ragas 0.59\n' + '{'.repeat(199000)];
  for (const raw of cases) {
    const started = performance.now();
    const out = M.parseAnswer(raw.slice(0, 200000), ctx);
    const ms = performance.now() - started;
    assert.ok(ms < 1000, 'took ' + Math.round(ms) + ' ms');
    assert.equal(out.recipe, null);
    assert.equal(out.diagnostics[0].code, 'json_unclosed');
    assert.match(out.diagnostics[0].message, /답이 너무 길거나 JSON이 닫히지 않았어요/);
  }
});

test('a valid recipe after a run of closed brackets is still found', () => {
  assert.deepEqual(M.parseAnswer('{}'.repeat(30) + ' ' + JSON.stringify(good), ctx).recipe, good);
  assert.deepEqual(M.parseAnswer('{} [] ' + JSON.stringify(good), ctx).recipe, good);
});

test('result line: zero state and the rest to pick by hand', () => {
  assert.equal(M.resultLine({applied: [1], unresolved: []}).line, '1곳 적용했어요');
  assert.equal(M.resultLine({applied: [1, 2], unresolved: [{}]}).line, '2곳 적용 · 1곳은 직접 골라 주세요');
  assert.equal(M.resultLine({applied: [], unresolved: [{}, {}]}).line, '0곳 적용 · 2곳은 직접 골라 주세요');
  assert.equal(M.resultLine({applied: [], unresolved: []}).line, '바뀐 곳이 없어요');
  assert.equal(M.resultLine(null).line, '바뀐 곳이 없어요');
});

test('after a successful apply only interpretation notes stay in the grey box', () => {
  const answer = JSON.stringify({paperId: '2401.00001', edits: [{find: '0.95', replace: '0.50'}, {find: '9.99 nowhere', replace: '1.11'}], extra: 1});
  const {recipe, diagnostics} = M.parseAnswer(answer, ctx);
  assert.ok(recipe);
  assert.ok(diagnostics.some(d => d.code === 'find_missing'));
  const kept = M.keptAfterApply(diagnostics).map(d => d.code).sort();
  assert.deepEqual(kept, ['keys_dropped', 'paper_forced']);
  assert.deepEqual(M.keptAfterApply(undefined), []);
});

test('a bare single edit next to cannot_read_paper is still applied', () => {
  const out = M.parseAnswer('{"error":"cannot_read_paper","page":5,"find":"0.95","replace":"0.50"}', {paperId: '2309.15217'});
  assert.ok(out.recipe);
  assert.equal(out.recipe.edits[0].find, '0.95');
});
