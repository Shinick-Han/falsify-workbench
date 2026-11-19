import { COMMON_COLUMNS, KEY_COLUMNS, SCORE_COLUMNS } from './constants.mjs';
import { findingPageIndex, physicalPage } from './findings.mjs';
import { mapVerdict, verdictRaw } from './labels.mjs';
import { toCsv } from './text.mjs';

function paperId(row) {
  const id = row.paper && typeof row.paper.id === 'string' ? row.paper.id : '';
  return id || row.receipt;
}

function pageLocation(pageIndex) {
  return Number.isInteger(pageIndex) ? `p${pageIndex + 1}` : '';
}

export function commonRows(row, wrappedFindings) {
  return wrappedFindings.map((wrapped, index) => {
    const finding = wrapped.finding;
    const verdict = mapVerdict(verdictRaw(finding));
    const page = physicalPage(finding);
    return {
      참가자: row.nickname || row.receipt,
      조건: row.course || '',
      탐지기: wrapped.profile || '',
      모델: wrapped.model || '',
      실행번호: String((wrapped.repeat ?? 0) + 1),
      ID: finding.reportNumber || finding.id || `${row.receipt}-${index + 1}`,
      '물리 페이지': page === '' ? '' : String(page),
      '위치(절·그림·표)': finding.locationLabel || pageLocation(findingPageIndex(finding)),
      유형: finding.findingType || '',
      '판정(아님/확인필요)': verdict.blue,
      심각도: finding.severity || '',
      '정확한 원문 인용': finding.quote || finding.sourceQuote || '',
      '대응 근거·이유·검산': finding.rationale || finding.summary || '',
      확신: finding.confidence || '',
      '추가로 필요한 정보': finding.uncertainty || '',
    };
  });
}

export function scoreRows(row, wrappedFindings) {
  return wrappedFindings.map(wrapped => {
    const finding = wrapped.finding;
    const verdict = mapVerdict(verdictRaw(finding));
    const pageIndex = findingPageIndex(finding);
    return {
      paper_id: paperId(row),
      team: 'booth',
      judge_type: 'model',
      model: wrapped.model || '',
      iteration: String((wrapped.repeat ?? 0) + 1),
      location: pageLocation(pageIndex) || (finding.locationLabel || ''),
      defect_type: finding.findingType || '',
      label: verdict.score,
      evidence: finding.quote || finding.sourceQuote || '',
      time_sec: durationSec(wrapped.job),
      tokens: tokenTotal(wrapped.job),
      is_holdout: 'false',
    };
  });
}

export function keyRows(row) {
  const declared = Array.isArray(row.declared) ? row.declared : [];
  return declared.map(edit => ({
    paper_id: paperId(row),
    team: 'booth',
    defect_type: edit.defectType || '',
    location: pageLocation(edit.pageIndex),
    before: edit.before || '',
    after: edit.after || '',
    iterations: '1',
    self_check_model: '',
    patch_v1: edit.after || '',
    patch_final: edit.after || '',
    why_hard: edit.reason || '',
  }));
}

export function jsonlRows(row, wrappedFindings) {
  return scoreRows(row, wrappedFindings).map(record => ({ ...record, receipt: row.receipt }));
}

function durationSec(job) {
  const start = Date.parse(job?.createdAt || '');
  const end = Date.parse(job?.completedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '';
  return String(Math.round((end - start) / 1000));
}

function tokenTotal(job) {
  const usage = job?.usage;
  if (!usage || typeof usage !== 'object') return '';
  let total = 0;
  let any = false;
  for (const key of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens']) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) {
      total += usage[key];
      any = true;
    }
  }
  return any ? String(total) : '';
}

export function renderExport(format, tables) {
  if (format === 'common') return toCsv(COMMON_COLUMNS, tables.common);
  if (format === 'score') return toCsv(SCORE_COLUMNS, tables.score);
  if (format === 'key') return toCsv(KEY_COLUMNS, tables.key);
  if (format === 'jsonl') return tables.jsonl.map(row => `${JSON.stringify(row)}\n`).join('');
  return '';
}

export { COMMON_COLUMNS, KEY_COLUMNS, SCORE_COLUMNS };
