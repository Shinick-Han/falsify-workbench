// booth-runtime.js: kiosk flag and storage, offline detection, wake lock, idle timer, visitor reset,
// and the saved-progress records that replay edits as a booth recipe. Plus booth.js's offline code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const source = await readFile(fileURLToPath(new URL('../dist/booth-runtime.js', import.meta.url)), 'utf8');
const boothSource = await readFile(fileURLToPath(new URL('../dist/booth.js', import.meta.url)), 'utf8');

function memoryStore(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
  };
}

function load(extra = {}) {
  const context = vm.createContext({console, URL, URLSearchParams, setTimeout, clearTimeout, Promise, ...extra});
  vm.runInContext(source, context, {filename: 'booth-runtime.js'});
  return context;
}

test('kioskFlag: ?kiosk=1 sets the tab flag, ?kiosk=0 clears it, otherwise the flag decides', () => {
  const R = load().FalsifyBoothRuntime;
  const bag = memoryStore();
  assert.equal(R.kioskFlag('', bag), false);
  assert.equal(R.kioskFlag('?kiosk=1', bag), true);
  assert.equal(bag.getItem(R.KIOSK_KEY), '1');
  assert.equal(R.kioskFlag('?x=2', bag), true, 'the flag stays for the session');
  assert.equal(R.kioskFlag('?kiosk=0', bag), false);
  assert.equal(bag.getItem(R.KIOSK_KEY), null);
  assert.equal(R.kioskFlag('?kiosk=yes', bag), false);
});

test('storage: receipts go to sessionStorage in kiosk mode and localStorage otherwise', () => {
  const session = memoryStore();
  const local = memoryStore();
  const kioskR = load({sessionStorage: session, localStorage: local, location: {search: '?kiosk=1', pathname: '/event.html'}}).FalsifyBoothRuntime;
  assert.equal(kioskR.kiosk(), true);
  assert.equal(kioskR.storage(), session);
  const normalR = load({sessionStorage: memoryStore(), localStorage: local, location: {search: '', pathname: '/event.html'}}).FalsifyBoothRuntime;
  assert.equal(normalR.kiosk(), false);
  assert.equal(normalR.storage(), local);
  assert.equal(normalR.kioskUrl({pathname: '/falsify/event.html'}), '/falsify/event.html?kiosk=1');
});

test('offline reads navigator.onLine === false only', () => {
  const R = load().FalsifyBoothRuntime;
  assert.equal(R.offline({onLine: false}), true);
  assert.equal(R.offline({onLine: true}), false);
  assert.equal(R.offline({}), false);
  assert.equal(R.OFFLINE_TEXT, '인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.');
});

test('wake: requests the screen lock while wanted, releases it after, and asks again after a release', async () => {
  const R = load().FalsifyBoothRuntime;
  const calls = [];
  const sentinels = [];
  const nav = {wakeLock: {request(kind) {
    calls.push(kind);
    const listeners = [];
    const s = {released: 0, release() { this.released += 1; for (const fn of listeners) fn(); }, addEventListener(type, fn) { if (type === 'release') listeners.push(fn); }};
    sentinels.push(s);
    return Promise.resolve(s);
  }}};
  const lock = R.wake(nav);
  lock.want(true);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(calls, ['screen']);
  assert.equal(lock.held(), true);
  lock.want(true);
  assert.equal(calls.length, 1, 'no second request while held');
  sentinels[0].release();
  assert.equal(lock.held(), false, 'the browser released it on hide');
  lock.want(true);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(calls.length, 2, 'asked again on return');
  lock.want(false);
  assert.equal(sentinels[1].released, 1);
  assert.equal(lock.held(), false);
  const none = R.wake({});
  none.want(true);
  assert.equal(none.held(), false, 'no wakeLock support is a no-op');
  const failing = R.wake({wakeLock: {request() { return Promise.reject(new Error('NotAllowedError')); }}});
  failing.want(true);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(failing.held(), false);
});

function fakeClock() {
  let now = 0; let seq = 0;
  const timers = new Map();
  return {
    later(fn, ms) { seq += 1; timers.set(seq, {fn, at: now + ms}); return seq; },
    cancel(id) { timers.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at; due[1].fn();
      }
      now = until;
    },
    get size() { return timers.size; },
  };
}

test('idleTimer: nothing before activity, warning at limit-20 s, reset 20 s later, 계속 restarts', () => {
  const R = load().FalsifyBoothRuntime;
  const clock = fakeClock();
  const log = [];
  let limit = R.IDLE_MS;
  const idle = R.idleTimer({later: clock.later, cancel: clock.cancel, warn: R.WARN_MS, limit: () => limit,
    onWarn: () => log.push('warn'), onExpire: () => log.push('expire')});
  clock.advance(10 * R.IDLE_MS);
  assert.deepEqual(log, [], 'an untouched kiosk never resets');
  idle.activity();
  clock.advance(R.IDLE_MS - R.WARN_MS - 1);
  assert.deepEqual(log, []);
  idle.activity();
  clock.advance(R.IDLE_MS - R.WARN_MS);
  assert.deepEqual(log, ['warn']);
  assert.equal(idle.warning(), true);
  idle.activity();
  clock.advance(R.WARN_MS - 1);
  assert.deepEqual(log, ['warn'], 'a stray touch does not dismiss the warning');
  idle.resume();
  assert.equal(idle.warning(), false);
  clock.advance(R.IDLE_MS - R.WARN_MS);
  assert.deepEqual(log, ['warn', 'warn']);
  clock.advance(R.WARN_MS);
  assert.deepEqual(log, ['warn', 'warn', 'expire']);
  assert.equal(clock.size, 0);
  limit = R.WAIT_IDLE_MS;
  idle.activity();
  clock.advance(R.IDLE_MS);
  assert.equal(log.length, 3, 'a pending result waits 5 minutes');
  idle.stop();
  assert.equal(clock.size, 0);
});

test('clearVisitor and handoff: receipts, progress, drafts, hosted session and guest go; the kiosk flag and access key stay', () => {
  const session = memoryStore({
    'falsify.booth.kiosk.v1': '1', 'falsify.open-access.key.v1': 'k', 'falsify.booth.receipts.v1': '[]',
    'falsify.booth.progress.v1': '{}', 'falsify.hosted-ai.session.v1': '{}', 'falsify.paper-draft.v1.abc': '{}',
    'falsify.open-access.guest.v1:https://api': '{}',
  });
  const local = memoryStore({'falsify.booth.receipts.v1': '[{"keep":1}]', 'falsify.paper-draft-index.v1': '[]', other: 'x'});
  let invalidated = 0; let assist = ''; let replaced = ''; let blurred = 0;
  const context = load({
    sessionStorage: session, localStorage: local,
    location: {search: '?kiosk=1', pathname: '/event.html', replace(url) { replaced = url; }},
    FalsifyHostedSession: {token() {}, invalidate() { invalidated += 1; session.removeItem('falsify.open-access.guest.v1:https://api'); }},
    FalsifyBoothRecipe: {setAssist(kind) { assist = kind; }},
    document: {body: {}, activeElement: {blur() { blurred += 1; }}},
  });
  context.FalsifyBoothRuntime.handoff();
  assert.deepEqual([...session.map.keys()].sort(), ['falsify.booth.kiosk.v1', 'falsify.open-access.key.v1']);
  assert.deepEqual([...local.map.keys()].sort(), ['falsify.booth.receipts.v1', 'other'], 'normal-mode receipts are not touched');
  assert.equal(invalidated, 1, 'the guest session resets through FalsifyHostedSession.invalidate');
  assert.equal(assist, 'manual');
  assert.equal(blurred, 1, 'the focused input is blurred so the soft keyboard closes');
  assert.equal(replaced, '/event.html?kiosk=1');
});

test('clearVisitor without the open-access hook drops the guest storage key itself', () => {
  const session = memoryStore({'falsify.open-access.guest.v1:https://api': '{}', 'falsify.booth.kiosk.v1': '1'});
  load({sessionStorage: session, localStorage: memoryStore()}).FalsifyBoothRuntime.clearVisitor();
  assert.deepEqual([...session.map.keys()], ['falsify.booth.kiosk.v1']);
});

test('recipeEdit: the changed words of a workspace edit, with paragraph context', () => {
  const R = load().FalsifyBoothRuntime;
  const before = 'Faithfulness reached 0.95 on WikiEval while relevance stayed at 0.78 overall.';
  const edit = R.recipeEdit({pageIndex: 4, before, after: before.replace('0.95', '0.50'), enabled: true});
  assert.equal(edit.page, 5);
  assert.equal(edit.find, '0.95');
  assert.equal(edit.replace, '0.50');
  assert.equal(edit.context, before);
  const word = R.recipeEdit({pageIndex: 0, before: 'the model improves results', after: 'the model worsens results'});
  assert.deepEqual([word.find, word.replace], ['improves', 'worsens'], 'grown to whole words');
  const insert = R.recipeEdit({pageIndex: 0, before: 'scores are high', after: 'scores are not high'});
  assert.equal(insert.find.trim().length > 0, true);
  assert.notEqual(insert.find, insert.replace);
  assert.equal(R.recipeEdit({pageIndex: 0, before: 'a', after: 'a'}), null);
  assert.equal(R.recipeEdit({pageIndex: 0, before: 'x 1', after: 'x 2', enabled: false}), null);
  assert.equal(R.recipeEdit({pageIndex: -1, before: 'x 1', after: 'x 2'}), null);
  assert.equal(R.recipeEdit({pageIndex: 0, before: 'a'.repeat(400), after: 'b'.repeat(400)}), null, 'over 300 characters');
  assert.equal(R.recipeEdit({pageIndex: 0, before: 'line one\nline two', after: 'line one\nline 2'}).find, 'two');
  assert.equal(R.recipeEdit({pageIndex: 0, before: 'one\ntwo', after: 'uno\ndos'}), null, 'a newline inside the span');
  const many = Array.from({length: 7}, (_, i) => ({pageIndex: i, before: 'v ' + i, after: 'v x' + i}));
  assert.equal(R.recipeEdits(many).length, 5);
});

test('readProgress: checks shape, age and every edit again', () => {
  const R = load().FalsifyBoothRuntime;
  const now = 1_800_000_000_000;
  const good = {v: 1, at: now - 1000, step: 'edit', paperId: '2309.15217', tab: 'myai', assist: 'my-ai', code: '',
    edits: [{page: 5, find: '0.95', replace: '0.50', context: 'reached 0.95 on'}, {page: 0, find: 'x', replace: 'y'}, {page: 2, find: 'a\x01', replace: 'b'}]};
  const read = R.readProgress(JSON.stringify(good), now);
  assert.deepEqual(JSON.parse(JSON.stringify(read)), {step: 'edit', paperId: '2309.15217', tab: 'myai', assist: 'my-ai', code: '',
    edits: [{page: 5, find: '0.95', replace: '0.50', context: 'reached 0.95 on'}]});
  assert.equal(R.readProgress(JSON.stringify({...good, at: now - 7 * 3600000}), now), null, 'older than 6 h');
  assert.equal(R.readProgress(JSON.stringify({...good, step: 'ticket'}), now), null);
  assert.equal(R.readProgress(JSON.stringify({...good, paperId: '../x'}), now), null);
  assert.equal(R.readProgress('nope', now), null);
  const odd = R.readProgress(JSON.stringify({...good, tab: 'evil', assist: 'robot', code: 'R-IIIIII'}), now);
  assert.deepEqual([odd.tab, odd.assist, odd.code], ['find', 'manual', '']);
  assert.equal(R.readProgress(JSON.stringify({...good, assist: 'agent', code: 'R-7K3QXM'}), now).code, 'R-7K3QXM');
  assert.equal(R.resumeQuestion(2), '고친 곳 2개를 이어서 할까요?');
  assert.equal(R.resumeQuestion(0), '보던 논문을 이어서 볼까요?');
});

test('progressNow: edit or send with an open paper only; edits from the workspace snapshot', () => {
  const html = {dataset: {boothStep: 'edit'}};
  const tab = {id: 'booth-tab-myai'};
  const doc = {documentElement: html, querySelector: sel => sel.includes('aria-selected') ? tab : null};
  const context = load({
    FalsifyBoothPaper: {current: () => ({source: 'mission', id: '2309.15217'})},
    FalsifyPaperWorkspace: {getEditSnapshot: () => ({edits: [{pageIndex: 4, before: 'at 0.95 here', after: 'at 0.50 here', enabled: true}]})},
    FalsifyBoothRecipe: {assist: () => ({assist: 'agent', recipeCode: 'R-7K3QXM'})},
  });
  const R = context.FalsifyBoothRuntime;
  const record = R.progressNow(doc, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {v: 1, at: 5, step: 'edit', paperId: '2309.15217', tab: 'myai', assist: 'agent', code: 'R-7K3QXM',
    edits: [{page: 5, find: '0.95', replace: '0.50', context: 'at 0.95 here'}]});
  html.dataset.boothStep = 'ticket';
  assert.equal(R.progressNow(doc, 5), null);
});

test('booth.js: the offline error line, and receipts stay on localStorage without the runtime', () => {
  const context = vm.createContext({console, URL, URLSearchParams});
  vm.runInContext(boothSource, context, {filename: 'booth.js'});
  assert.equal(context.FalsifyBooth.errorMessage('offline'), '인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.');
  assert.match(boothSource, /return rt&&typeof rt\.storage==='function'\?rt\.storage\(\):root\.localStorage;/);
});
