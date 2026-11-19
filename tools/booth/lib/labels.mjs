// Two vocabularies share the same three words.
// Hosted BLUE verdictLabel: 아님 = confirmed defect, 맞음 = resolved clean, 확인필요 = abstain.
// tools/score.py label: 맞음 = defect flag (yes), 아님 = not a flag (no), 확인필요 = abstain.
// common export keeps the BLUE word. score export translates so score.py recall counts defects.

const PAIRS = {
  아님: ['아님', '맞음'],
  defect: ['아님', '맞음'],
  unsupported: ['아님', '맞음'],
  yes: ['아님', '맞음'],
  true: ['아님', '맞음'],
  y: ['아님', '맞음'],
  결함: ['아님', '맞음'],
  맞음: ['맞음', '아님'],
  supported: ['맞음', '아님'],
  clean: ['맞음', '아님'],
  verified_clean: ['맞음', '아님'],
  no_defect: ['맞음', '아님'],
  'no-defect': ['맞음', '아님'],
  ok: ['맞음', '아님'],
  정상: ['맞음', '아님'],
  no: ['맞음', '아님'],
  false: ['맞음', '아님'],
  n: ['맞음', '아님'],
  확인필요: ['확인필요', '확인필요'],
  '확인 필요': ['확인필요', '확인필요'],
  unsure: ['확인필요', '확인필요'],
  review: ['확인필요', '확인필요'],
  needs_verification: ['확인필요', '확인필요'],
  'needs-verification': ['확인필요', '확인필요'],
  uncertain: ['확인필요', '확인필요'],
  abstain: ['확인필요', '확인필요'],
  '?': ['확인필요', '확인필요'],
};

export function verdictRaw(finding) {
  for (const key of ['verdictLabel', 'label', 'verdict']) {
    if (typeof finding?.[key] === 'string' && finding[key].trim()) return finding[key];
  }
  return '';
}

// Unknown words become 확인필요 in the score file so score.py can load the CSV.
export function mapVerdict(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { blue: '확인필요', score: '확인필요', known: false };
  const hit = PAIRS[text] || PAIRS[text.toLowerCase()];
  if (!hit) return { blue: text, score: '확인필요', known: false };
  return { blue: hit[0], score: hit[1], known: true };
}
