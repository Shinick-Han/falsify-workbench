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

test('Korean prompt carries the goal, rules, hint, page text, format and closing line', () => {
  const p = M.buildPrompt(info);
  assert.match(p, /1~3개/);
  assert.match(p, /확인 가능한 결함/);
  assert.match(p, /find는 아래 원문에서 글자 그대로 복사/);
  assert.match(p, /지어내지 마세요/);
  assert.match(p, /CC BY/);
  assert.match(p, /Table 1의 점수 하나를 바꿔 보세요/);
  assert.match(p, /대상 쪽: 5/);
  assert.ok(p.includes(PAGE), 'page text is included verbatim');
  assert.match(p, /"schema": "falsify\.booth\.recipe\.v1"/);
  assert.match(p, /"source": "my-ai"/);
  assert.match(p, /paperId는 "2309\.15217"/);
  assert.match(p, /number, figure, citation, logic, method, other/);
  assert.match(p.trim().split('\n').at(-1), /JSON 하나만 답하세요/);
  assert.doesNotMatch(p, /"source": "agent"/);
});

test('the example in the prompt is a valid my-ai recipe', () => {
  const p = M.buildPrompt(info);
  const start = p.indexOf('{\n  "schema"');
  const example = JSON.parse(p.slice(start, p.indexOf('\n}', start) + 2));
  assert.equal(example.source, 'my-ai');
  assert.equal(M.validateLocal(example).ok, true);
});

test('English variant on request; Korean by default', () => {
  const en = M.buildPrompt(info, {lang: 'en'});
  assert.match(en, /Plant 1-3 subtle but checkable defects/);
  assert.match(en, /Answer with the JSON object only/);
  assert.ok(en.includes(PAGE));
  assert.doesNotMatch(en, /답 형식/);
  assert.match(M.buildPrompt(info), /답 형식/);
});

test('long page text is trimmed with a note and the prompt stays near 12k characters', () => {
  const long = Array.from({length: 4000}, (_, i) => 'word' + i).join(' ');
  for (const lang of ['ko', 'en']) {
    const p = M.buildPrompt({...info, pageText: long}, {lang});
    assert.ok(p.length <= M.PROMPT_CAP, lang + ' length ' + p.length);
    assert.ok(p.length > M.PROMPT_CAP - 400, lang + ' wastes budget: ' + p.length);
    assert.match(p, lang === 'ko' ? /원문이 길어 뒷부분 \d+자를 생략/ : /characters were left out/);
    assert.ok(p.includes('word0 word1'));
    assert.ok(!p.includes('word3999'));
    assert.match(p.trim().split('\n').at(-1), /JSON/);
  }
  assert.doesNotMatch(M.buildPrompt(info), /생략했습니다/);
});

test('missing page text and odd input do not throw', () => {
  assert.match(M.buildPrompt({paperId: '2309.15217'}), /읽지 못했습니다/);
  assert.equal(typeof M.buildPrompt(null), 'string');
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
