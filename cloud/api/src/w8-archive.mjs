// Sanitized BLUE-only W8 archive builder and validator.
// Excludes raw documents, PDF binaries, full extracted segments, RED runs/ledgers/answers, and credentials.
// Enforces real backend constraints (6 MiB UTF-8 payload cap matching Confluence/Worker bounds, stack depth,
// and safe upstream filename/control-character rules) without arbitrary run/finding count or text truncation caps.

export const W8_ARCHIVE_SCHEMA = 'falsify.w8-blue-archive.v1';
export const W8_ARCHIVE_KIND = 'w8-blue';
export const MAX_W8_ARCHIVE_BYTES = 6 * 1024 * 1024;
export const MAX_W8_CSV_BYTES = 6 * 1024 * 1024;

const MAX_CARRIER_DEPTH = 16;
const MAX_FILENAME_CHARS = 255;
const HEX64 = /^[a-f0-9]{64}$/;
const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,15}-[1-9][0-9]{0,7}$/;
const UNSAFE_CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const UNSAFE_SINGLELINE = /[\u0000-\u001f\u007f]/;
const UNSAFE_FILENAME_CHARS = /[\/\\";:*?<>|]/;

// Keys that must NEVER appear anywhere in a W8 BLUE-only team archive.
const BANNED_KEY_RE = /^(pdf|pdfBytes|sourcePdf|sourcePDF|binary|bytes|contentBase64|segments|rawDocument|documentText|fullText|extractedText|gold|answer|answers|answerKey|red|redRuns|redLedger|finalState|sourceRunId|snapshotOf|comparison|patches|candidates|edits|before|after|accessToken|refreshToken|authorization|bearer|clientSecret|session|token|apiKey|cookie|raw|batches)$/i;

const TOP_KEYS = [
  'schema',
  'participant',
  'condition',
  'issueKey',
  'csvFilename',
  'csvSha256',
  'runCount',
  'findingCount',
  'runs',
];

const RUN_KEYS = [
  'runNumber',
  'id',
  'createdAt',
  'sourceKind',
  'provenance',
  'detector',
  'model',
  'fileHash',
  'sourceHash',
  'promptCondition',
  'status',
  'findings',
];

const FINDING_KEYS = [
  'id',
  'page',
  'locationLabel',
  'findingType',
  'verdictLabel',
  'severity',
  'quote',
  'rationale',
  'evidence',
  'confidence',
  'uncertainty',
  'additionalInfo',
];

const EVIDENCE_KEYS = ['quote', 'relation', 'label'];

const encoder = new TextEncoder();

export class W8ArchiveError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'W8ArchiveError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new W8ArchiveError(code, message);
}

function isPlain(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (isPlain(value)) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export async function sha256HexBytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256HexText(text) {
  return sha256HexBytes(encoder.encode(String(text)));
}

export function normalizeParticipant(value) {
  if (typeof value !== 'string') fail('invalid_participant', 'Participant name is required.');
  const trimmed = value.normalize('NFC').trim();
  if (!trimmed || UNSAFE_SINGLELINE.test(trimmed)) {
    fail('invalid_participant', 'Participant name is invalid.');
  }
  return trimmed;
}

export function normalizeCondition(value) {
  if (typeof value !== 'string') fail('invalid_condition', 'Condition is required.');
  const trimmed = value.normalize('NFC').trim();
  if (!trimmed || UNSAFE_SINGLELINE.test(trimmed)) {
    fail('invalid_condition', 'Condition is invalid.');
  }
  return trimmed;
}

export function normalizeCsvFilename(value) {
  if (typeof value !== 'string') fail('invalid_filename', 'CSV filename is required.');
  const trimmed = value.normalize('NFC').trim();
  const invalid = !trimmed ||
    trimmed.length > MAX_FILENAME_CHARS ||
    UNSAFE_SINGLELINE.test(trimmed) ||
    !/\.csv$/i.test(trimmed) ||
    UNSAFE_FILENAME_CHARS.test(trimmed) ||
    trimmed.includes('..');
  if (invalid) fail('invalid_filename', 'CSV filename must be a safe .csv filename.');
  return trimmed;
}

export function normalizeIssueKey(value) {
  if (typeof value !== 'string') fail('invalid_issue', 'Jira issue key is required.');
  const key = value.trim().toUpperCase();
  if (!ISSUE_KEY_RE.test(key)) fail('invalid_issue', 'Jira issue key format is invalid.');
  return key;
}

export async function participantKeyHash(participant) {
  const norm = normalizeParticipant(participant).toLowerCase();
  return (await sha256HexText(`falsify-w8-participant:${norm}`)).slice(0, 16);
}

function assertCleanPrimitive(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    fail('invalid_archive', 'Non-finite number in archive.');
  }
  if (typeof value === 'string' && value.includes('%PDF-')) {
    fail('forbidden_content', 'Archive cannot contain PDF binary data.');
  }
}

function assertCleanObject(value, depth) {
  if (!isPlain(value)) fail('invalid_archive', 'Archive contains unsupported value type.');
  for (const key of Object.keys(value)) {
    if (BANNED_KEY_RE.test(key)) fail('forbidden_content', `Disallowed field in BLUE-only archive: ${key}`);
    if (key === 'role' && String(value[key]).toLowerCase() === 'red') {
      fail('forbidden_content', 'RED content is not allowed in a W8 BLUE-only archive.');
    }
    assertCleanCarrier(value[key], depth + 1);
  }
}

function assertCleanCarrier(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value !== 'object') {
    assertCleanPrimitive(value);
    return;
  }
  if (depth > MAX_CARRIER_DEPTH) fail('invalid_archive', 'Archive nesting is too deep.');
  if (Array.isArray(value)) {
    for (const item of value) assertCleanCarrier(item, depth + 1);
    return;
  }
  assertCleanObject(value, depth);
}

function assertAllowedKeys(obj, allowed, label) {
  if (!isPlain(obj)) fail('invalid_archive', `${label} must be an object.`);
  if (Object.keys(obj).some(k => !allowed.includes(k))) {
    fail('invalid_archive', `${label} has unexpected field.`);
  }
}

function cleanText(value, allowMultiline = true) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') fail('invalid_archive', 'Expected string field.');
  if (value.includes('%PDF-')) fail('forbidden_content', 'PDF content is not allowed.');
  const re = allowMultiline ? UNSAFE_CTRL : UNSAFE_SINGLELINE;
  if (re.test(value)) fail('invalid_archive', 'Control character in text field.');
  return value.trim();
}

function optionalPositiveInt(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_archive', `${label} must be a positive integer or null.`);
  }
  return value;
}

function optionalHex64(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !HEX64.test(value)) {
    fail('invalid_archive', `${label} must be a 64-hex SHA-256 or null.`);
  }
  return value;
}

function validateEvidenceItem(ev) {
  assertAllowedKeys(ev, EVIDENCE_KEYS, 'Evidence entry');
  return {
    quote: cleanText(ev.quote ?? '', true),
    relation: cleanText(ev.relation ?? '', true),
    label: cleanText(ev.label ?? '', false),
  };
}

function validateFinding(finding) {
  assertAllowedKeys(finding, FINDING_KEYS, 'Finding');
  const id = cleanText(finding.id, false);
  if (!id) fail('invalid_archive', 'Finding id is required.');
  const evidenceRaw = finding.evidence ?? [];
  if (!Array.isArray(evidenceRaw)) fail('invalid_archive', 'Finding evidence must be an array.');
  return {
    id,
    page: optionalPositiveInt(finding.page, 'Finding page'),
    locationLabel: cleanText(finding.locationLabel ?? '', false),
    findingType: cleanText(finding.findingType ?? '', false),
    verdictLabel: cleanText(finding.verdictLabel ?? '', false),
    severity: cleanText(finding.severity ?? '', false),
    quote: cleanText(finding.quote ?? '', true),
    rationale: cleanText(finding.rationale ?? '', true),
    evidence: evidenceRaw.map(validateEvidenceItem),
    confidence: cleanText(finding.confidence ?? '', false),
    uncertainty: cleanText(finding.uncertainty ?? '', true),
    additionalInfo: cleanText(finding.additionalInfo ?? '', true),
  };
}

function validateRunHeader(run, index) {
  const runNumber = run.runNumber;
  if (!Number.isSafeInteger(runNumber) || runNumber < 1) {
    fail('invalid_archive', 'Run number must be a positive integer.');
  }
  const id = cleanText(run.id, false);
  if (!id) fail('invalid_archive', 'Run id is required.');
  const createdAt = cleanText(run.createdAt ?? '', false);
  if (createdAt && !Number.isFinite(Date.parse(createdAt))) {
    fail('invalid_archive', 'Run createdAt must be an ISO timestamp.');
  }
  return { runNumber: runNumber || index + 1, id, createdAt };
}

function validateRunEnums(run) {
  const sourceKind = cleanText(run.sourceKind ?? 'builtin', false);
  if (!['builtin', 'external'].includes(sourceKind)) {
    fail('invalid_archive', 'Run sourceKind must be builtin or external.');
  }
  const status = cleanText(run.status ?? 'ok', false);
  if (!['ok', 'abstain', 'refusal'].includes(status)) {
    fail('invalid_archive', 'Run status is invalid.');
  }
  return { sourceKind, status };
}

function validateRun(run, index) {
  assertAllowedKeys(run, RUN_KEYS, 'Run');
  const { runNumber, id, createdAt } = validateRunHeader(run, index);
  const { sourceKind, status } = validateRunEnums(run);
  if (!Array.isArray(run.findings)) fail('invalid_archive', 'Run findings must be an array.');
  return {
    runNumber,
    id,
    createdAt,
    sourceKind,
    provenance: cleanText(run.provenance ?? '', false),
    detector: cleanText(run.detector ?? '', false),
    model: cleanText(run.model ?? '', false),
    fileHash: optionalHex64(run.fileHash, 'Run fileHash'),
    sourceHash: optionalHex64(run.sourceHash, 'Run sourceHash'),
    promptCondition: cleanText(run.promptCondition ?? '', false),
    status,
    findings: run.findings.map(validateFinding),
  };
}

function validateRunsList(rawRuns) {
  if (!Array.isArray(rawRuns) || rawRuns.length < 1) {
    fail('invalid_archive', 'Archive must include at least one BLUE run.');
  }
  const seenRunIds = new Set();
  return rawRuns.map((run, idx) => {
    const normalized = validateRun(run, idx);
    if (seenRunIds.has(normalized.id)) fail('invalid_archive', 'Duplicate run id in archive.');
    seenRunIds.add(normalized.id);
    return normalized;
  });
}

function checkArchiveCounts(input, runs, findingCount) {
  if (input.runCount !== undefined && input.runCount !== runs.length) {
    fail('invalid_archive', 'Archive runCount does not match runs length.');
  }
  if (input.findingCount !== undefined && input.findingCount !== findingCount) {
    fail('invalid_archive', 'Archive findingCount does not match total findings.');
  }
}

export async function validateW8BlueArchive(input) {
  assertCleanCarrier(input, 0);
  assertAllowedKeys(input, TOP_KEYS, 'Archive');
  if (input.schema !== W8_ARCHIVE_SCHEMA) {
    fail('invalid_archive', 'Archive schema must be falsify.w8-blue-archive.v1.');
  }
  if (typeof input.csvSha256 !== 'string' || !HEX64.test(input.csvSha256)) {
    fail('invalid_archive', 'Archive csvSha256 must be a 64-hex SHA-256.');
  }
  const runs = validateRunsList(input.runs);
  const findingCount = runs.reduce((sum, run) => sum + run.findings.length, 0);
  checkArchiveCounts(input, runs, findingCount);
  const normalized = {
    schema: W8_ARCHIVE_SCHEMA,
    participant: normalizeParticipant(input.participant),
    condition: normalizeCondition(input.condition),
    issueKey: normalizeIssueKey(input.issueKey),
    csvFilename: normalizeCsvFilename(input.csvFilename),
    csvSha256: input.csvSha256,
    runCount: runs.length,
    findingCount,
    runs,
  };
  const canonical = canonicalJson(normalized);
  const bytes = encoder.encode(canonical);
  if (bytes.byteLength > MAX_W8_ARCHIVE_BYTES) fail('payload_too_large', 'Archive exceeds 6 MiB.');
  return { normalized, canonical, bytes, archiveSha256: await sha256HexBytes(bytes) };
}

export async function archiveSha256(archive) {
  const { archiveSha256: hash } = await validateW8BlueArchive(archive);
  return hash;
}
