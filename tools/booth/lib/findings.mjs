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
export function findingPageIndex(finding) {
  if (Number.isInteger(finding.pageIndex) && finding.pageIndex >= 0 && finding.pageIndex <= 9999) return finding.pageIndex;
  if (Number.isInteger(finding.page) && finding.page >= 1 && finding.page <= 10000) return finding.page - 1;
  return null;
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
