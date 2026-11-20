// FalsifyBoothRecipe core: recipe validation (contract §1), whitespace and hyphenation folding with
// original offsets, page-first matching with context tie-breaks, ambiguous/not_found, assist bookkeeping
// and apply() through a stub workspace. Synthetic segments only; no DOM, network or paper.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const source = await readFile(fileURLToPath(new URL('../dist/booth-recipe.js', import.meta.url)), 'utf8');

function load(extra = {}) {
  const context = vm.createContext({console, URL, TextEncoder, setTimeout, clearTimeout, ...extra});
  vm.runInContext(source, context, {filename: 'booth-recipe.js'});
  return {context, recipe: context.FalsifyBoothRecipe};
}

const plain = value => JSON.parse(JSON.stringify(value));

function good(overrides = {}) {
  return {
    schema: 'falsify.booth.recipe.v1', paperId: '2309.15217',
    edits: [{page: 5, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}],
    defectType: 'number', reason: 'Ragas faithfulness lowered.\nSecond line.', source: 'agent',
    agent: {name: 'Claude Code', model: 'claude-opus-5-5'},
    ...overrides,
  };
}

function codes(result) {
  return plain(result.errors).map(error => error.field + ':' + error.code);
}

/* Page 1 and page 3 both say "agrees best"; page 3 also hyphenates "evalu-\nation" across a line. */
const SEGMENTS = [
  {id: 's0', label: 'PDF p. 1', pageIndex: 0, text: 'Ragas agrees best with humans.\nIntro text.'},
  {id: 'layout:p1:column1', label: 'PDF p. 1 · column 1', pageIndex: 0, text: 'Ragas agrees best with humans.\nIntro text.'},
  {id: 'paragraph:0:a', label: 'PDF p. 1', pageIndex: 0, text: 'Ragas agrees best with humans.'},
  {id: 's2', label: 'PDF p. 3', pageIndex: 2, text: 'Faith.  Ans. Rel.\nRagas   0.95   0.78   0.70\nGPT Score   0.72\nautomatic evalu-\nation agrees best here, and agrees best there.'},
  {id: 'layout:p3:column1', label: 'PDF p. 3 · column 1', pageIndex: 2, text: 'Faith. Ans. Rel.\nRagas 0.95 0.78 0.70\nGPT Score 0.72\nautomatic evalu-\nation agrees best here, and agrees best there.'},
  {id: 'paragraph:2:t', label: 'PDF p. 3', pageIndex: 2, text: '                0.95\t 0.78\t 0.70 GPT Score\t 0.72'},
  {id: 'paragraph:2:b', label: 'PDF p. 3', pageIndex: 2, text: 'automatic evalu-\nation agrees best here, and agrees best there.'},
];

test('validate accepts the contract example and both arXiv id styles', () => {
  const {recipe} = load();
  assert.deepEqual(plain(recipe.validate(good())), {ok: true, errors: []});
  assert.equal(recipe.validate(good({paperId: 'hep-th/9901001v2'})).ok, true);
  assert.equal(recipe.validate(good({paperId: 'math.AG/0601001'})).ok, true);
  assert.equal(recipe.validate(good({schema: undefined, defectType: undefined, reason: undefined, agent: undefined})).ok, true);
  assert.equal(recipe.validate(good({edits: [{find: 'x', replace: ''}]})).ok, true, 'an empty replace deletes');
  assert.equal(recipe.validate(good({source: 'my-ai'})).ok, true);
});

test('validate rejects every rule break with a field and code', () => {
  const {recipe} = load();
  const cases = [
    [good({extra: 1}), 'extra:unknown'],
    [good({schema: 'v2'}), 'schema:schema'],
    [good({paperId: '2309.152'}), 'paperId:paper'],
    [good({source: 'robot'}), 'source:source'],
    [good({defectType: 'typo'}), 'defectType:defect_type'],
    [good({reason: 'x'.repeat(501)}), 'reason:too_long'],
    [good({edits: []}), 'edits:count'],
    [good({edits: Array.from({length: 6}, () => ({find: 'a', replace: 'b'}))}), 'edits:count'],
    [good({edits: [{find: '   ', replace: 'b'}]}), 'edits[0].find:empty'],
    [good({edits: [{find: 'x'.repeat(301), replace: 'b'}]}), 'edits[0].find:too_long'],
    [good({edits: [{find: 'a\nb', replace: 'b'}]}), 'edits[0].find:control'],
    [good({edits: [{find: 'same', replace: 'same'}]}), 'edits[0].replace:unchanged'],
    [good({edits: [{find: 'a', replace: 'x'.repeat(301)}]}), 'edits[0].replace:too_long'],
    [good({edits: [{find: 'a', replace: 'b', page: 0}]}), 'edits[0].page:page'],
    [good({edits: [{find: 'a', replace: 'b', page: 501}]}), 'edits[0].page:page'],
    [good({edits: [{find: 'a', replace: 'b', page: 2.5}]}), 'edits[0].page:page'],
    [good({edits: [{find: 'a', replace: 'b', context: 'x'.repeat(601)}]}), 'edits[0].context:too_long'],
    [good({agent: {name: 'A', model: 'm', extra: 'x'}}), 'agent.extra:unknown'],
    [good({agent: {name: 'x'.repeat(61)}}), 'agent.name:too_long'],
    [good({agent: {name: 'tab\there'}}), 'agent.name:control'],
  ];
  for (const [input, expected] of cases) {
    const result = recipe.validate(input);
    assert.equal(result.ok, false, expected);
    assert.ok(codes(result).includes(expected), expected + ' in ' + codes(result).join(','));
  }
  const big = good({edits: Array.from({length: 5}, () => ({find: '가', replace: '나', context: '가'.repeat(600)}))});
  assert.deepEqual(codes(recipe.validate(big)), [':too_large'], 'the JSON is at most 8 KB of UTF-8');
  assert.deepEqual(codes(recipe.validate(null)), [':type']);
  assert.deepEqual(codes(recipe.validate([])), [':type']);
});

test('lengths count code points and C1/bidi controls and unknown edit keys are rejected', () => {
  const {recipe} = load();
  const astral = '\u{1D400}';
  assert.equal(recipe.validate(good({edits: [{find: astral.repeat(300), replace: '\u{1D401}'.repeat(300)}]})).ok, true, '300 astral code points fit');
  assert.ok(codes(recipe.validate(good({edits: [{find: astral.repeat(301), replace: 'x'}]}))).includes('edits[0].find:too_long'));
  assert.equal(recipe.validate(good({reason: astral.repeat(500), agent: {name: astral.repeat(60), model: 'm'}})).ok, true);
  assert.ok(codes(recipe.validate(good({edits: [{find: 'a', replace: 'b', context: astral.repeat(601)}]}))).includes('edits[0].context:too_long'));
  const bad = ['\u0085', '\u009f', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069'];
  for (const ch of bad) {
    const label = 'U+' + ch.codePointAt(0).toString(16);
    assert.ok(codes(recipe.validate(good({agent: {name: 'Claude' + ch, model: 'm'}}))).includes('agent.name:control'), label);
    assert.ok(codes(recipe.validate(good({edits: [{find: 'a' + ch, replace: 'b'}]}))).includes('edits[0].find:control'), label);
    assert.ok(codes(recipe.validate(good({reason: 'line\nmore' + ch}))).includes('reason:control'), label);
    assert.ok(codes(recipe.validate(good({edits: [{find: 'a', replace: 'b', context: 'x\n' + ch}]}))).includes('edits[0].context:control'), label);
  }
  assert.equal(recipe.validate(good({reason: 'a\nb', edits: [{find: 'a', replace: 'b', context: 'c\nd'}]})).ok, true, 'newline stays allowed in reason/context');
  assert.equal(recipe.validate(good({edits: [{find: 'a', replace: 'b\u200b'}]})).ok, true, 'zero-width space is not a control');
  assert.deepEqual(codes(recipe.validate(good({edits: [{find: 'a', replace: 'b', hint: {segmentId: 's0', at: 0}, note: 'x'}]}))), ['edits[0].hint:unknown', 'edits[0].note:unknown']);
});

test('the mission check is an exact id match, so a prefix id still gets search metadata', async () => {
  const label = {textContent: 'arXiv 2309.15217 · CC BY 4.0'};
  const missions = {querySelectorAll: selector => (selector === '.booth-mission .booth-lab' ? [label] : []), textContent: label.textContent};
  const document = {getElementById: id => (id === 'booth-missions' ? missions : null)};
  const searches = [];
  const fetch = async url => { searches.push(url); return {ok: true, status: 200, json: async () => ({results: [{id: '2309.1521', title: 'Other', license: 'cc-by-4.0'}]})}; };
  for (const [paperId, expected] of [['2309.15217', 0], ['2309.1521', 1]]) {
    searches.length = 0;
    const metas = [];
    const ws = stubWorkspace(SEGMENTS);
    let opened = false;
    const getSource = ws.getSource;
    ws.getSource = () => (opened ? getSource() : null);
    const {recipe} = load({
      document, fetch, FalsifyPaperWorkspace: ws,
      FalsifyCloudConfig: {apiBase: 'https://api.example'},
      FalsifyHostedSession: {token: async () => 'fsg_' + 'c'.repeat(43)},
      FalsifyBoothPaper: {open: (id, meta) => { metas.push(plain(meta)); opened = true; return Promise.resolve(true); }, current: () => null},
    });
    await recipe.apply(good({paperId, edits: [{page: 3, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}]}));
    assert.equal(searches.length, expected, paperId);
    assert.deepEqual(metas[0], expected ? {title: 'Other', license: 'cc-by-4.0'} : {}, paperId);
  }
});

test('codes normalise to R- plus 6 Crockford characters', () => {
  const {recipe} = load();
  assert.equal(recipe.normalizeCode('r-abc123'), 'R-ABC123');
  assert.equal(recipe.normalizeCode(' abc123 '), 'R-ABC123');
  assert.equal(recipe.normalizeCode('R-7K3QXO'), 'R-7K3QX0');
  assert.equal(recipe.normalizeCode('R-ILABCD'), 'R-11ABCD');
  for (const bad of ['', 'R-ABC12', 'R-ABC1234', 'R-ABCU12', 'R_ABC123', 42]) assert.equal(recipe.normalizeCode(bad), '', String(bad));
});

test('normalise folds whitespace and line-end hyphenation and keeps original offsets', () => {
  const {recipe} = load();
  const text = '  automatic evalu-\n  ation\t\tagrees  ';
  const joined = recipe.normalizeText(text, false);
  assert.equal(joined.text, 'automatic evaluation agrees');
  const at = joined.text.indexOf('evaluation');
  const start = joined.start[at];
  const end = joined.end[at + 'evaluation'.length - 1];
  assert.equal(text.slice(start, end), 'evalu-\n  ation');
  assert.equal(recipe.normalizeText(text, true).text, 'automatic evalu-ation agrees');
  assert.equal(recipe.normalizeText('self-contained', false).text, 'self-contained', 'a mid-line hyphen stays');
  assert.equal(recipe.normalizeText('ﬁne', false).text, 'fine', 'NFKC folds ligatures');
});

test('locate: page first, original offsets, a paragraph segment preferred', () => {
  const {recipe} = load();
  const table = plain(recipe.locate({page: 3, find: 'Ragas 0.95 0.78', replace: 'x'}, SEGMENTS));
  assert.equal(table.status, 'resolved');
  assert.equal(table.segmentId, 'layout:p3:column1', 'Ragas is not in the table paragraph');
  const num = plain(recipe.locate({page: 3, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'}, SEGMENTS));
  assert.equal(num.status, 'resolved');
  assert.equal(num.segmentId, 'paragraph:2:t');
  assert.equal(num.pageIndex, 2);
  assert.equal(SEGMENTS[5].text.slice(num.start, num.end), '0.95');
  const hyphen = plain(recipe.locate({find: 'evaluation agrees', replace: 'x'}, SEGMENTS));
  assert.equal(hyphen.status, 'resolved');
  assert.equal(hyphen.segmentId, 'paragraph:2:b');
  assert.equal(hyphen.before, 'evalu-\nation agrees');
  const kept = plain(recipe.locate({find: 'evalu-ation', replace: 'x'}, SEGMENTS));
  assert.equal(kept.before, 'evalu-\nation', 'a hyphen kept in the find text still matches');
  const spaced = plain(recipe.locate({page: 3, find: 'GPT  Score 0.72', replace: 'x'}, SEGMENTS));
  assert.equal(spaced.status, 'resolved');
  assert.equal(spaced.before, 'GPT Score\t 0.72');
});

test('locate: page scope beats the whole paper; context breaks ties; otherwise ambiguous', () => {
  const {recipe} = load();
  const first = plain(recipe.locate({page: 1, find: 'agrees best', replace: 'x'}, SEGMENTS));
  assert.equal(first.status, 'resolved');
  assert.equal(first.pageIndex, 0);
  assert.equal(plain(recipe.locate({find: 'agrees best', replace: 'x'}, SEGMENTS)).status, 'ambiguous');
  assert.equal(plain(recipe.locate({page: 3, find: 'agrees best', replace: 'x'}, SEGMENTS)).status, 'ambiguous');
  const there = plain(recipe.locate({page: 3, find: 'agrees best', replace: 'x', context: 'and agrees best there'}, SEGMENTS));
  assert.equal(there.status, 'resolved');
  assert.equal(SEGMENTS[6].text.slice(there.start), 'agrees best there.');
  const here = plain(recipe.locate({find: 'agrees best', replace: 'x', context: 'evaluation agrees best here'}, SEGMENTS));
  assert.equal(here.status, 'resolved');
  assert.equal(here.pageIndex, 2);
  const missing = plain(recipe.locate({page: 2, find: 'agrees best', replace: 'x'}, SEGMENTS));
  assert.equal(missing.status, 'ambiguous', 'nothing on page 2, so the whole paper decides');
});

test('locate: not_found for text that is nowhere in the paper', () => {
  const {recipe} = load();
  assert.equal(recipe.locate({find: 'never written', replace: 'x'}, SEGMENTS).status, 'not_found');
  assert.equal(recipe.locate({page: 3, find: 'never written', replace: 'x'}, SEGMENTS).status, 'not_found');
  assert.equal(recipe.locate({find: 'agrees', replace: 'x'}, []).status, 'not_found');
});

test('searchHits lists the current page first and caps the list', () => {
  const {recipe} = load();
  const list = plain(recipe.searchHits(SEGMENTS, 'agrees best', 2, 2));
  assert.equal(list.total, 3);
  assert.equal(list.more, 1);
  assert.deepEqual(list.items.map(item => item.pageIndex), [2, 2]);
  assert.equal(list.items[0].snippet.hit, 'agrees best');
  assert.match(list.items[0].context, /agrees best/);
});

test('assist defaults to manual; setAssist keeps a recipe code only for agent', () => {
  const {recipe} = load();
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'});
  recipe.setAssist('agent', 'r-abc123');
  assert.deepEqual(plain(recipe.assist()), {assist: 'agent', recipeCode: 'R-ABC123'});
  recipe.setAssist('my-ai', 'R-ABC123');
  assert.deepEqual(plain(recipe.assist()), {assist: 'my-ai'});
  recipe.setAssist('agent', 'bad');
  assert.deepEqual(plain(recipe.assist()), {assist: 'agent'});
  recipe.setAssist('robot');
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'});
});

function stubWorkspace(segments) {
  const edits = [];
  let next = 1;
  const calls = [];
  return {
    edits, calls,
    getSource: () => ({file: {}, fileHash: 'a'.repeat(64), segments}),
    getEditSnapshot: () => ({edits: edits.map(edit => ({...edit}))}),
    showPage: () => true,
    acceptProposals(proposals, options) {
      calls.push({proposals: plain(proposals), options: plain(options || {})});
      if (!options || options.confirmed !== true) return undefined;
      let applied = 0;
      for (const p of proposals) {
        const seg = segments.find(item => item.id === p.segmentId);
        if (!seg || seg.text.slice(p.anchor.start, p.anchor.end) !== p.before) continue;
        if (edits.some(edit => edit.segmentId === p.segmentId && edit.anchor.start < p.anchor.end && p.anchor.start < edit.anchor.end)) continue;
        edits.push({id: 'e' + next++, enabled: true, ...p, origin: options.origin});
        applied += 1;
      }
      return {applied};
    },
  };
}

test('apply: the booth hook opens the paper, edits go through confirmed acceptProposals', async () => {
  const ws = stubWorkspace(SEGMENTS);
  const opened = [];
  const hook = {open: (id, meta) => { opened.push(id); return Promise.resolve(true); }, current: () => ({id: '2309.15217', title: 'Ragas', license: 'cc-by-4.0'})};
  const {recipe} = load({FalsifyPaperWorkspace: ws, FalsifyBoothPaper: hook});
  const progress = [];
  const result = await recipe.apply(good({
    code: 'R-ABC123', createdAt: 'x', expiresAt: 'y',
    edits: [
      {page: 3, find: '0.95', replace: '0.50', context: 'Ragas 0.95 0.78 0.70'},
      {find: 'agrees best', replace: 'agrees least'},
      {find: 'not in this paper', replace: 'x'},
    ],
  }), {onProgress: info => progress.push(info.phase)});
  assert.deepEqual(opened, ['2309.15217']);
  assert.equal(result.applied.length, 1);
  assert.deepEqual(plain(result.unresolved.map(item => item.reason)), ['ambiguous', 'not_found']);
  assert.equal(result.unresolved[0].edit.find, 'agrees best');
  assert.deepEqual(plain(ws.edits.map(edit => [edit.segmentId, edit.before, edit.after, edit.origin])), [['paragraph:2:t', '0.95', '0.50', 'external-ai-import']]);
  assert.equal(ws.calls.at(-1).proposals.length, 0, 'the proposal queue is cleared after each edit');
  assert.deepEqual(progress, ['paper', 'edit', 'edit', 'edit', 'done']);
  assert.deepEqual(plain(recipe.assist()), {assist: 'agent', recipeCode: 'R-ABC123'});
  ws.edits[0].enabled = false;
  assert.deepEqual(plain(recipe.assist()), {assist: 'manual'}, 'no recipe edit left, so the entry is manual');
  assert.deepEqual(plain(recipe.paperInfo()), {paperId: '2309.15217', title: 'Ragas', license: 'cc-by-4.0', pages: 3});
  assert.match(recipe.pageText(3), /^Faith\. Ans\. Rel\./);
  assert.equal(recipe.pageText(2), '');
});

test('apply: a repeated Before grows to a unique span, as a paragraph hand edit would', async () => {
  const segments = [
    {id: 's0', label: 'PDF p. 1', pageIndex: 0, text: 'the proposed WikiEval dataset. Each WikiEval instance'},
    {id: 'paragraph:0:w', label: 'PDF p. 1', pageIndex: 0, text: 'the proposed WikiEval dataset. Each WikiEval instance'},
  ];
  const ws = stubWorkspace(segments);
  const hook = {open: () => Promise.resolve(true), current: () => ({id: '2309.15217'})};
  const {recipe} = load({FalsifyPaperWorkspace: ws, FalsifyBoothPaper: hook});
  const result = await recipe.apply(good({source: 'my-ai', edits: [{find: 'WikiEval', replace: 'WikiQA', context: 'Each WikiEval instance'}]}));
  assert.equal(result.applied.length, 1);
  assert.deepEqual(plain([ws.edits[0].before, ws.edits[0].after]), ['Each WikiEval instance', 'Each WikiQA instance']);
  assert.deepEqual(plain(recipe.assist()), {assist: 'my-ai'});
});

test('applyFound: a word tap located in one paragraph commits the same widened edit as apply', async () => {
  const segments = [
    {id: 's0', label: 'PDF p. 1', pageIndex: 0, text: 'the proposed WikiEval dataset. Each WikiEval instance'},
    {id: 'paragraph:0:w', label: 'PDF p. 1', pageIndex: 0, text: 'the proposed WikiEval dataset. Each WikiEval instance'},
  ];
  const tapped = stubWorkspace(segments);
  const {recipe} = load({FalsifyPaperWorkspace: tapped});
  const found = recipe.locate({find: 'WikiEval', context: 'dataset. Each WikiEval instance'}, [segments[1]]);
  assert.equal(found.status, 'resolved');
  assert.equal(found.kind, 'paragraph');
  const result = plain(recipe.applyFound(found, 'WikiQA'));
  assert.equal(result.ok, true);
  assert.deepEqual([result.before, result.after], ['Each WikiEval instance', 'Each WikiQA instance']);
  assert.deepEqual(plain(tapped.calls[0].options), {origin: 'external-ai-import', confirmed: true});
  const byRecipe = stubWorkspace(segments);
  const hook = {open: () => Promise.resolve(true), current: () => ({id: '2309.15217'})};
  const second = load({FalsifyPaperWorkspace: byRecipe, FalsifyBoothPaper: hook}).recipe;
  await second.apply(good({source: 'manual', edits: [{find: 'WikiEval', replace: 'WikiQA', context: 'Each WikiEval instance'}]}));
  assert.deepEqual(plain(tapped.calls[0].proposals), plain(byRecipe.calls[0].proposals), 'word tap and recipe produce identical proposals');
  assert.deepEqual(plain(recipe.applyFound(found, 'Other')), {ok: false, reason: 'not_found', detail: 'overlap'});
  assert.deepEqual(plain(recipe.applyFound({status: 'ambiguous'}, 'x')), {ok: false, reason: 'not_found'});
  assert.deepEqual(plain(load().recipe.applyFound(found, 'x')), {ok: false, reason: 'no_paper'});
});

test('apply: no booth hook means every edit is no_paper; invalid recipes throw', async () => {
  const {recipe} = load({FalsifyPaperWorkspace: stubWorkspace(SEGMENTS)});
  const result = await recipe.apply(good());
  assert.deepEqual(plain(result.unresolved.map(item => item.reason)), ['no_paper']);
  await assert.rejects(recipe.apply(good({source: 'robot'})), error => error.code === 'invalid_recipe' && error.errors.length === 1);
});

test('fromCode fetches GET /v1/booth/recipes/:code without credentials and strips server keys', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({url, init});
    if (url.endsWith('/R-ABC123')) return {ok: true, status: 200, json: async () => ({...good(), code: 'R-ABC123', createdAt: 'c', expiresAt: 'e'})};
    return {ok: false, status: 404, json: async () => ({error: {code: 'not_found'}})};
  };
  const config = {apiBase: 'https://api.example', hostedAi: {apiBase: 'https://hosted.example/'}};
  const {recipe} = load({fetch, FalsifyCloudConfig: config});
  const got = plain(await recipe.fromCode('r-abc123'));
  assert.equal(got.code, 'R-ABC123');
  assert.equal('createdAt' in got || 'expiresAt' in got, false);
  assert.equal(requests[0].url, 'https://hosted.example/v1/booth/recipes/R-ABC123');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.method, 'GET');
  await assert.rejects(recipe.fromCode('R-ZZZZZZ'), error => error.code === 'not_found');
  await assert.rejects(recipe.fromCode('nope'), error => error.code === 'invalid_code');
  assert.equal(requests.length, 2);
});

test('codeFromText takes the code out of a pasted #recipe= link; expiryText reads local time', () => {
  const {recipe} = load();
  assert.equal(recipe.codeFromText('https://x.test/event.html#recipe=R-7K3QXM'), 'R-7K3QXM');
  assert.equal(recipe.codeFromText('R-7K3QXM'), '');
  assert.equal(recipe.codeFromText('#recipe=R-7K3QXM-TOO-LONG'), '');
  const at = new Date(2026, 10, 22, 9, 5);
  assert.equal(recipe.expiryText(at.toISOString(), new Date(2026, 10, 22, 1, 0)), '오늘 09:05까지 유효');
  assert.equal(recipe.expiryText(at.toISOString(), new Date(2026, 10, 21, 1, 0)), '11월 22일 09:05까지 유효');
  assert.equal(recipe.expiryText('nope'), '');
  assert.equal(recipe.expiryText(undefined), '');
});
