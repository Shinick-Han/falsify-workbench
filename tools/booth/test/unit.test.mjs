import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assembleJobBody, buildBlueRequest, configHash, idempotencyKey } from '../lib/blue.mjs';
import { COMMON_COLUMNS, KEY_COLUMNS, SCORE_COLUMNS } from '../lib/constants.mjs';
import { drawWinners } from '../lib/draw.mjs';
import { renderExport } from '../lib/export.mjs';
import { mapVerdict } from '../lib/labels.mjs';
import { matchEdit, suggestOutcome } from '../lib/score.mjs';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

function withPdf(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-unit-'));
  const pdfPath = path.join(dir, 'edited.pdf');
  fs.writeFileSync(pdfPath, PDF);
  try {
    return fn(pdfPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('BLUE builder keeps only profile settings', () => {
  withPdf(pdfPath => {
    const profile = {
      name: 'quick-blind',
      prompt: 'Review the PDF only.',
      model: 'claude-sonnet-5-5',
      effort: 'high',
      maxCalls: 8,
      useEvidence: false,
      declared: [{ after: 'SENTINEL_AFTER', reason: 'SENTINEL_REASON' }],
      nickname: 'SENTINEL_NICK',
      paper: { title: 'SENTINEL_TITLE' },
      reason: 'SENTINEL_REASON',
      before: 'before',
      after: 'after',
    };
    const settings = buildBlueRequest({ pdfPath, profile });
    const body = assembleJobBody(settings, {
      uploadId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'a'.repeat(64),
    });
    assert.deepEqual(Object.keys(body).sort(), [
      'budget', 'effort', 'idempotencyKey', 'model', 'prompt', 'role', 'uploadId', 'useEvidence',
    ]);
    assert.equal(body.role, 'blue');
    assert.equal(body.useEvidence, false);
    assert.equal(body.budget.maxCalls, 8);
    const packed = JSON.stringify(body);
    for (const needle of ['SENTINEL_AFTER', 'SENTINEL_REASON', 'SENTINEL_NICK', 'SENTINEL_TITLE', 'declared']) {
      assert.equal(packed.includes(needle), false, needle);
    }
  });
});

test('harness is copied field by field and unknown keys fail', () => {
  withPdf(pdfPath => {
    const settings = buildBlueRequest({
      pdfPath,
      profile: {
        prompt: 'Review the PDF only.',
        harness: {
          schema: 'falsify.harness.v1',
          role: 'blue',
          instructions: 'operator harness text',
          adapter: { type: 'hosted', model: 'claude-sonnet-5-5', effort: 'high' },
        },
      },
    });
    assert.equal(settings.harness.instructions, 'operator harness text');
    assert.equal(settings.harness.adapter.type, 'hosted');
    assert.throws(() => buildBlueRequest({
      pdfPath,
      profile: { prompt: 'Review the PDF only.', harness: { endpoint: 'http://bad' } },
    }), /unknown keys/);
  });
});

test('PDF bytes stay out of the BLUE JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-unit-'));
  const pdfPath = path.join(dir, 'edited.pdf');
  fs.writeFileSync(pdfPath, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('SENTINEL_PDF_BYTES')]));
  const settings = buildBlueRequest({ pdfPath, profile: { prompt: 'Review the PDF only.' } });
  assert.equal(JSON.stringify(settings).includes('SENTINEL_PDF_BYTES'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('idempotency key repeats and changes with the prompt', () => {
  const base = { name: 'quick-blind', prompt: 'Review the PDF only.', model: 'm', effort: 'high', maxCalls: 4, useEvidence: true };
  const hash = configHash(base);
  const first = idempotencyKey({ receipt: 'F-0001', profileName: 'quick-blind', repeatIndex: 0, configHash: hash });
  const second = idempotencyKey({ receipt: 'F-0001', profileName: 'quick-blind', repeatIndex: 0, configHash: hash });
  const other = idempotencyKey({ receipt: 'F-0001', profileName: 'quick-blind', repeatIndex: 0, configHash: configHash({ ...base, prompt: 'Other.' }) });
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.notEqual(first, other);
});

test('score matches same-page after text, changed numbers, and misses another page', () => {
  const caught = matchEdit(
    { pageIndex: 1, before: 'p < 0.05', after: 'p < 0.50', defectType: 'number' },
    [{ finding: { pageIndex: 1, quote: 'reported p < 0.50 in the table' }, profile: 'quick-blind', repeat: 0 }],
  );
  assert.equal(caught.verdict, 'caught');
  const partial = matchEdit(
    { pageIndex: 2, before: 'n = 40', after: 'n = 400', defectType: 'number' },
    [{ finding: { page: 3, quote: 'the arm enrolled 400 people' }, profile: 'quick-blind', repeat: 1 }],
  );
  assert.equal(partial.verdict, 'partial');
  const missed = matchEdit(
    { pageIndex: 0, before: 'p < 0.05', after: 'p < 0.50', defectType: 'number' },
    [{ finding: { pageIndex: 4, quote: 'p < 0.50' }, profile: 'quick-blind', repeat: 0 }],
  );
  assert.equal(missed.verdict, 'missed');
  assert.equal(suggestOutcome(['caught', 'missed']), 'partial');
  assert.equal(suggestOutcome(['missed', 'missed']), 'missed');
  assert.equal(suggestOutcome(['caught']), 'caught');
});

test('verdict words follow BLUE on the common sheet and score.py on the score sheet', () => {
  assert.deepEqual(mapVerdict('아님'), { blue: '아님', score: '맞음', known: true });
  assert.deepEqual(mapVerdict('맞음'), { blue: '맞음', score: '아님', known: true });
  assert.deepEqual(mapVerdict('확인필요'), { blue: '확인필요', score: '확인필요', known: true });
  assert.equal(mapVerdict('defect').score, '맞음');
  assert.equal(mapVerdict('clean').blue, '맞음');
  assert.equal(mapVerdict('mystery').score, '확인필요');
  assert.equal(COMMON_COLUMNS.length, 15);
  assert.equal(SCORE_COLUMNS.length, 12);
  assert.equal(KEY_COLUMNS.length, 11);
});

test('common CSV is UTF-8 with BOM and quotes embedded commas', () => {
  const csv = renderExport('common', {
    common: [{
      참가자: 'F-0001',
      조건: 'quick',
      탐지기: 'quick-blind',
      모델: 'm',
      실행번호: '1',
      ID: 'B-1',
      '물리 페이지': '2',
      '위치(절·그림·표)': 'Results',
      유형: 'D1',
      '판정(아님/확인필요)': '아님',
      심각도: '불일치',
      '정확한 원문 인용': 'say "p < 0.50", please',
      '대응 근거·이유·검산': 'threshold',
      확신: '높음',
      '추가로 필요한 정보': '',
    }],
    score: [],
    key: [],
    jsonl: [],
  });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.includes('참가자,조건,탐지기'), true);
  assert.equal(csv.includes('"say ""p < 0.50"", please"'), true);
});

test('draw uses the injected integer generator without replacement', () => {
  const seen = [];
  const winners = drawWinners(['F-0001', 'F-0002', 'F-0003'], 2, (min, max) => {
    seen.push([min, max]);
    return 0;
  });
  assert.deepEqual(winners, ['F-0001', 'F-0002']);
  assert.deepEqual(seen, [[0, 3], [0, 2]]);
});
