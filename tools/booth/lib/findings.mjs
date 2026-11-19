// A hosted BLUE snapshot stores falsify.document-blue.v1 findings on job.result.
export function findingsFromJob(job) {
  const result = job?.result;
  if (!result) return [];
  const list = Array.isArray(result) ? result : (result.findings || result.items);
  if (!Array.isArray(list)) return [];
  return list.filter(isUsableFinding);
}

export function isUsableFinding(finding) {
  if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return false;
  const state = String(finding.status || finding.state || '').toLowerCase();
  return state !== 'rejected' && state !== 'unresolved';
}

// pageIndex is 0-based. The hosted prompt's `page` field is 1-based.
// Hosted BLUE findings carry neither; their segmentId "p<N>-..." names the 1-based physical page.
function declaredPageIndex(item) {
  if (Number.isInteger(item.pageIndex) && item.pageIndex >= 0 && item.pageIndex <= 9999) return item.pageIndex;
  if (Number.isInteger(item.page) && item.page >= 1 && item.page <= 10000) return item.page - 1;
  return null;
}

export function segmentPageIndex(segmentId) {
  const match = /^p(\d{1,5})-/.exec(typeof segmentId === 'string' ? segmentId : '');
  if (!match) return null;
  const page = Number(match[1]);
  return page >= 1 && page <= 10000 ? page - 1 : null;
}

function itemPageIndex(item) {
  if (!item || typeof item !== 'object') return null;
  const declared = declaredPageIndex(item);
  return declared != null ? declared : segmentPageIndex(item.segmentId);
}

// The finding's primary page: the page of its own quote.
export function findingPageIndex(finding) {
  return itemPageIndex(finding);
}

// Every page a finding points at: its own quote plus each cited evidence segment.
export function findingPageIndexes(finding) {
  const pages = new Set();
  const evidence = Array.isArray(finding?.evidence) ? finding.evidence : [];
  for (const item of [finding, ...evidence]) {
    const index = itemPageIndex(item);
    if (index != null) pages.add(index);
  }
  return pages;
}

export function physicalPage(finding) {
  const index = findingPageIndex(finding);
  if (index != null) return index + 1;
  return '';
}

export function runsForReceipt(records) {
  const runs = [];
  for (const record of records) {
    if (record?.job?.state !== 'completed') continue;
    const findings = findingsFromJob(record.job).map(finding => ({
      finding,
      profile: record.profile,
      repeat: record.repeat,
      model: record.job.model || record.request?.model || '',
      job: record.job,
    }));
    runs.push(...findings);
  }
  return runs;
}
