export const RECEIPT = /^F-\d{4,}$/;
export const TOKEN = /^fso_[A-Za-z0-9_-]{43}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROFILE_NAME = /^[A-Za-z0-9._:-]{1,64}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
export const BLUE_MAX_PDF_BYTES = 16777216;
export const BLUE_MAX_PDF_BYTES_CAP = 33554432;

export const OUTCOMES = Object.freeze(['missed', 'caught', 'partial', 'invalid']);
export const STATUSES = Object.freeze(['received', 'reviewing', 'judged', 'invalid', 'withdrawn']);
export const TERMINAL_JOB = new Set(['cancelled', 'completed', 'failed', 'interrupted']);

// Keys the hosted job contract accepts. BLUE sends a subset and never edits.
export const JOB_KEYS = Object.freeze([
  'role', 'prompt', 'uploadId', 'idempotencyKey', 'model', 'effort', 'budget', 'useEvidence', 'harness',
]);
export const HARNESS_KEYS = Object.freeze([
  'schema', 'id', 'name', 'version', 'role', 'instructions', 'maxCalls', 'adapter',
]);
export const ADAPTER_KEYS = Object.freeze(['type', 'model', 'effort']);

export const COMMON_COLUMNS = Object.freeze([
  '참가자', '조건', '탐지기', '모델', '실행번호', 'ID',
  '물리 페이지', '위치(절·그림·표)', '유형', '판정(아님/확인필요)',
  '심각도', '정확한 원문 인용', '대응 근거·이유·검산', '확신',
  '추가로 필요한 정보',
]);

export const SCORE_COLUMNS = Object.freeze([
  'paper_id', 'team', 'judge_type', 'model', 'iteration', 'location',
  'defect_type', 'label', 'evidence', 'time_sec', 'tokens', 'is_holdout',
]);

export const KEY_COLUMNS = Object.freeze([
  'paper_id', 'team', 'defect_type', 'location', 'before', 'after',
  'iterations', 'self_check_model', 'patch_v1', 'patch_final', 'why_hard',
]);

export const USAGE = `falsify booth operator CLI

Usage:
  node tools/booth/booth.mjs <command> [options]

Token (environment only, never a flag, never logged):
  FALSIFY_BOOTH_TOKEN    operator bearer matching fso_ + 43 base64url chars

Options:
  --config <file>        JSON config (booth.config.example.json)
  --api <url>            API origin, overrides config apiBase
  --data-dir <dir>       local archive (default: $HOME/falsify-booth-data)
  --help                 print this usage

Commands:
  status
  list [--status a,b] [--after <seq>] [--limit <1-200>]
  pull [--status a,b] [--only F-0001,F-0002]
  blue [--profile <name>] [--model <id>] [--effort <id>] [--max-calls <n>]
       [--use-evidence true|false] [--prompt-file <file>] [--harness-file <file>]
       [--concurrency <n>] [--repeat <n>] [--only <receipts>] [--status a,b]
       [--dry-run] [--allow-open] [--max-bytes <n>]
  score [--only <receipts>] [--status a,b]
  judge [--only <receipts>] [--outcome missed|caught|partial|invalid] [--dry-run]
  publish [--only <receipts>] [--status a,b] [--public-note <text>] [--prize <text>] [--dry-run]
  unpublish [--only <receipts>] [--dry-run]
  draw [--count <n>] [--status a,b] [--outcome a,b] [--only <receipts>] [--prize <text>] [--dry-run]
  export --format common|score|key|jsonl [--out <file>] [--only <receipts>] [--status a,b]
  missions get [--out <file>]
  missions set <file>
  missions warm [--write]
  open
  close [--dry-run]
  announce (--text <text> | --file <file> | --clear)

BLUE uploads the edited PDF and posts the operator profile only.
Declared edits, reasons, types, nickname and paper metadata are not part of that request.
blue refuses to start while submissions are open unless --allow-open is set.
BLUE shares the production runtime, not the visitor path.
blue refuses a local PDF over --max-bytes (default 16777216) or not starting with %PDF-.
draw defaults to outcome missed.
CSV cells that start with =, +, -, @, tab or CR are prefixed with '.
score writes score.json and does not publish.
Progress goes to stderr. Command results go to stdout as JSON.
`;
