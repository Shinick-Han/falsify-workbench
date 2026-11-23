import matcher from '../../../app/dist/w8-matcher.js';

export const {
  isUsableFinding,
  segmentPageIndex,
  findingPageIndex,
  findingPageIndexes,
  physicalPage,
} = matcher;

// A hosted BLUE snapshot stores falsify.document-blue.v1 findings on job.result.
export function findingsFromJob(job) {
  const result = job?.result;
  if (!result) return [];
  const list = Array.isArray(result) ? result : (result.findings || result.items);
  if (!Array.isArray(list)) return [];
  return list.filter(isUsableFinding);
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
