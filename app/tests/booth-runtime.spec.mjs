// booth-runtime.js: kiosk flag and storage, offline detection, wake lock, idle timer, visitor reset,
// and saved progress using FalsifyBoothEdits.serialize / restore. Plus booth.js's offline code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const editsSource = await readFile(fileURLToPath(new URL('../dist/booth-edits.js', import.meta.url)), 'utf8');
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
  vm.runInContext(editsSource, context, {filename: 'booth-edits.js'});
  vm.runInContext(source, context, {filename: 'booth-runtime.js'});
  return context;
}

const SAMPLE_EDIT = {
  id: 'e-1',
  pageIndex: 4,
  rects: [{x: 0.25, y: 0.15, w: 0.08, h: 0.02}],
  originalText: '0.95',
  newText: '0.50',
  source: 'find',
};

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
  assert.equal(log.length, 3, 'a pending result waits 15 minutes');
  idle.stop();
  assert.equal(clock.size, 0);
});

/* plan97s-5 */
test('idleTimer.refresh re-arms only a running timer with the current limit', () => {
  const R = load().FalsifyBoothRuntime;
  const clock = fakeClock(); const log = [];
  let limit = R.IDLE_MS;
  const idle = R.idleTimer({later: clock.later, cancel: clock.cancel, warn: R.WARN_MS, limit: () => limit,
    onWarn: () => log.push('warn'), onExpire: () => log.push('expire')});
  idle.refresh();
  assert.equal(clock.size, 0, 'refresh before any activity arms nothing');
  idle.activity();                       // tap on 「AI에게 제출하기」 at the send step
  clock.advance(60000);
  limit = R.WAIT_IDLE_MS; idle.refresh(); // the ticket appears, pending
  clock.advance(R.WAIT_IDLE_MS - R.WARN_MS - 1);
  assert.deepEqual(log, [], 'no warning before 15 min on a pending ticket');
  clock.advance(1);
  assert.deepEqual(log, ['warn']);
  limit = R.IDLE_MS; idle.refresh();     // result arrives during the warning
  assert.equal(idle.warning(), true, 'a state change does not dismiss the warning');
  clock.advance(R.WARN_MS);
  assert.deepEqual(log, ['warn', 'expire']);
  idle.activity(); clock.advance(60000);
  limit = R.IDLE_MS; idle.refresh();     // result arrives: a fresh 3 minutes
  clock.advance(R.IDLE_MS - R.WARN_MS - 1);
  assert.deepEqual(log, ['warn', 'expire']);
  clock.advance(1);
  assert.deepEqual(log, ['warn', 'expire', 'warn']);
  idle.stop();
});

test('WAIT_IDLE_MS is one minute past booth.js POLL_STOP_AT', () => {
  const R = load().FalsifyBoothRuntime;
  const match = /const POLL_STOP_AT=(\d+);/.exec(boothSource);
  assert.ok(match);
  assert.equal(R.WAIT_IDLE_MS, Number(match[1]) + 60000);
  assert.equal(R.WAIT_IDLE_MS - R.WARN_MS > Number(match[1]), true, 'the warning opens after polling stops');
  assert.equal(R.WAIT_IDLE_MS, 960000);
});

test('clearVisitor and handoff: receipts, progress, drafts, edits, hosted session and guest go; the kiosk flag and access key stay', () => {
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
  context.FalsifyBoothEdits.add(SAMPLE_EDIT);
  assert.equal(context.FalsifyBoothEdits.list().length, 1);
  context.FalsifyBoothRuntime.handoff();
  assert.equal(context.FalsifyBoothEdits.list().length, 0, 'handoff clears BoothEdits');
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

test('readProgress checks shape, age and validates serialized BoothEdits', () => {
  const R = load().FalsifyBoothRuntime;
  const now = 1_800_000_000_000;
  const badEdit = {pageIndex: -1, rects: [], originalText: 'a', newText: 'b'};
  const sameEdit = {pageIndex: 0, rects: [{x: 0.1, y: 0.1, w: 0.1, h: 0.02}], originalText: 'a', newText: 'a'};
  const good = {
    v: 2, at: now - 1000, step: 'edit', paperId: '2309.15217', title: 'Ragas: Automated Evaluation', license: 'cc-by-4.0',
    tab: 'myai', assist: 'my-ai',
    edits: JSON.stringify([SAMPLE_EDIT, badEdit, sameEdit]),
  };
  const read = R.readProgress(JSON.stringify(good), now);
  assert.equal(read.step, 'edit');
  assert.equal(read.paperId, '2309.15217');
  assert.equal(read.title, 'Ragas: Automated Evaluation');
  assert.equal(read.license, 'cc-by-4.0');
  assert.equal(read.tab, 'myai');
  assert.equal(read.assist, 'my-ai');
  assert.equal(read.count, 1);
  assert.deepEqual(JSON.parse(read.edits), [SAMPLE_EDIT]);
  assert.equal(R.readProgress(JSON.stringify({...good, v: 1}), now), null, 'legacy v1 shape is ignored');
  assert.equal(R.readProgress(JSON.stringify({...good, at: now - 7 * 3600000}), now), null, 'older than 6 h');
  assert.equal(R.readProgress(JSON.stringify({...good, step: 'ticket'}), now), null);
  assert.equal(R.readProgress(JSON.stringify({...good, paperId: '../x'}), now), null);
  assert.equal(R.readProgress('nope', now), null);
  const odd = R.readProgress(JSON.stringify({...good, tab: 'evil', assist: 'robot'}), now);
  assert.deepEqual([odd.tab, odd.assist], ['find', 'manual']);
  const legacyAgent = R.readProgress(JSON.stringify({...good, tab: 'agent', assist: 'agent', code: 'R-7K3QXM'}), now);
  assert.deepEqual([legacyAgent.tab, legacyAgent.assist], ['find', 'manual'], 'saved tab/assist agent restores to find/manual');
  assert.equal(R.resumeQuestion(2), '고친 곳 2개를 이어서 할까요?');
  assert.equal(R.resumeQuestion(0), '보던 논문을 이어서 볼까요?');
});

test('progressNow and reopen round-trip through FalsifyBoothEdits.serialize / restore', async () => {
  const html = {dataset: {boothStep: 'edit'}};
  const tab = {id: 'booth-tab-myai'};
  const doc = {documentElement: html, querySelector: sel => sel.includes('aria-selected') ? tab : null};
  const opened = [];
  const assists = [];
  const context = load({
    FalsifyBoothPaper: {
      current: () => ({source: 'arxiv', id: '2309.15217', title: 'Ragas: Automated Evaluation', license: 'cc-by-4.0'}),
      open: (id, meta) => { opened.push([id, JSON.parse(JSON.stringify(meta))]); return Promise.resolve(true); },
    },
    FalsifyBoothRecipe: {
      assist: () => ({assist: 'my-ai'}),
      setAssist: kind => assists.push(kind),
    },
  });
  context.FalsifyBoothEdits.add(SAMPLE_EDIT);
  const R = context.FalsifyBoothRuntime;
  const record = R.progressNow(doc, 5);
  assert.equal(record.v, 2);
  assert.equal(record.paperId, '2309.15217');
  assert.equal(record.title, 'Ragas: Automated Evaluation');
  assert.equal(record.license, 'cc-by-4.0');
  assert.equal(record.tab, 'myai');
  assert.equal(record.assist, 'my-ai');
  assert.deepEqual(JSON.parse(record.edits), [SAMPLE_EDIT]);

  context.FalsifyBoothEdits.clear();
  assert.equal(context.FalsifyBoothEdits.list().length, 0);
  const parsed = R.readProgress(JSON.stringify(record), 10);
  const ok = await R.reopen(parsed);
  assert.equal(ok, true);
  assert.deepEqual(opened, [['2309.15217', {title: 'Ragas: Automated Evaluation', license: 'cc-by-4.0'}]]);
  assert.deepEqual(assists, ['my-ai']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.FalsifyBoothEdits.list())), [SAMPLE_EDIT]);

  html.dataset.boothStep = 'ticket';
  assert.equal(R.progressNow(doc, 5), null);
});

test('handoff clears boothStep and blocks pagehide saveProgress from re-writing progress (P1-3)', () => {
  const session = memoryStore({'falsify.booth.kiosk.v1': '1'});
  const html = {dataset: {boothStep: 'edit'}};
  const doc = {documentElement: html, body: {}, querySelector: () => null};
  let replaced = '';
  const context = load({
    sessionStorage: session,
    localStorage: memoryStore(),
    document: doc,
    location: {search: '?kiosk=1', pathname: '/event.html', replace(url) { replaced = url; }},
    FalsifyBoothPaper: {
      current: () => ({source: 'mission', id: '2309.15217', title: 'Ragas', license: 'cc-by-4.0'}),
    },
  });
  const R = context.FalsifyBoothRuntime;
  assert.ok(R.saveProgress(doc));
  assert.ok(session.getItem(R.PROGRESS_KEY));
  R.handoff();
  assert.equal(replaced, '/event.html?kiosk=1');
  assert.equal(html.dataset.boothStep, undefined, 'clearVisitor clears dataset.boothStep');
  assert.equal(session.getItem(R.PROGRESS_KEY), null);
  // Even if something restored boothStep before pagehide fires, resetting prevents re-saving.
  html.dataset.boothStep = 'edit';
  assert.equal(R.saveProgress(doc), null, 'pagehide saveProgress is suppressed during handoff');
  assert.equal(session.getItem(R.PROGRESS_KEY), null);
});

test('booth.js: the offline error line, and receipts stay on localStorage without the runtime', () => {
  const context = vm.createContext({console, URL, URLSearchParams});
  vm.runInContext(boothSource, context, {filename: 'booth.js'});
  assert.equal(context.FalsifyBooth.errorMessage('offline'), '인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.');
  assert.match(boothSource, /return rt&&typeof rt\.storage==='function'\?rt\.storage\(\):root\.localStorage;/);
});

test('saved progress truncates >300-char titles instead of dropping them and keeps edits past page 500', () => {
  const R = load().FalsifyBoothRuntime;
  const now = 1_800_000_000_000;
  const longTitle = 'Long\nTitle\t' + 'A'.repeat(350);
  const deepPageEdit = {...SAMPLE_EDIT, pageIndex: 520};
  const saved = {
    v: 2, at: now - 1000, step: 'edit', paperId: '2309.15217',
    title: longTitle, license: 'cc-by-4.0', tab: 'find', assist: 'manual',
    edits: JSON.stringify([deepPageEdit]),
  };
  const read = R.readProgress(JSON.stringify(saved), now);
  assert.ok(read);
  assert.equal(read.title.length, 300);
  assert.equal(read.title.startsWith('Long Title AAAA'), true);
  assert.equal(read.count, 1);
  assert.equal(JSON.parse(read.edits)[0].pageIndex, 520);
});
