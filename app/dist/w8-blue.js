/* W8 Stage 1 BLUE adapter and unified results panel.
   Connects built-in hosted BLUE (direct /v1/ai/* route + pending resume) and external My AI BLUE
   (copy prompt, paste or file import) to a durable per-document run store and standard CSV projection.
   Strictly separates RED edit/gold metadata from BLUE inputs. DOM built via textContent only. */
(function(root, factory){
  const api = factory(root);
  if(typeof module === 'object' && module.exports) module.exports = api;
  if(root) root.FalsifyW8Blue = api;
})(typeof globalThis === 'object' ? globalThis : this, function(root){
  'use strict';

  const VERSION = '1';
  const RUNS_STORE_KEY = 'falsify.w8-blue.runs.v1';
  const PENDING_STORE_KEY = 'falsify.w8-blue.pending.v1';
  const LEDGER_KEY = 'falsify.experiment-ledger.v1';
  const PROMPT_VERSIONS_KEY = 'falsify.prompt-versions.v1.blue';
  const HOSTED_SESSION_KEY = 'falsify.hosted-ai.session.v1';
  const HOSTED_UPLOAD_KEY = 'falsify.hosted-ai.upload.v1';
  const HOSTED_RUNS_KEY = 'falsify.hosted-ai.runs.v1';

  const HEX_64 = /^[0-9a-f]{64}$/;
  const TOKEN_RE = /^fss_[A-Za-z0-9_-]{43}$/;
  const HEADER_TOKEN_RE = /^[\x21-\x7e]{8,4096}$/;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const TERMINAL_STATES = ['cancelled', 'completed', 'failed', 'interrupted'];
  const POLL_DELAYS = [1200, 2000, 3000, 5000, 8000, 12000];
  const MAX_POLL_FAILURES = 6;
  const MAX_PROMPT_FALLBACK = 32000;
  const MAX_UPLOAD_FALLBACK = 33554432;
  const MAX_RUNS_STORED = 200;
  const MAX_PENDING_STORED = 32;
  const MAX_STORE_CHARS = 3800000;
  const MAX_TEAM_PROMPT_BYTES = 200000;
  const TIMEOUTS = { auth: 20000, upload: 60000, job: 20000, cancel: 20000 };

  const DETECTOR_HOSTED = '내장 BLUE';
  const DETECTOR_EXTERNAL = '내 AI';
  const DETECTOR_LOCAL = '로컬 BLUE';
  const DETECTOR_MANUAL = '수동 BLUE';
  const W8_TEAM_PROMPT_URL = 'https://falsify.atlassian.net/rest/api/3/attachment/content/10077';
  const W8_TEAM_PROMPT_LINK_TEXT = '공통 프롬프트 v6 받기';
  const W8_TEAM_PROMPT_V6_CONDITION = '공통 프롬프트 v6';

  const DEFAULT_BLUE_P0_PROMPT = '첨부한 PDF만 사용해 독립·맹검 2단계 검증을 수행하세요. 웹 검색이나 외부 기억 없이 D1(수치·표·통계 불일치), D2(참고문헌·링크 오류), D3/D4-1/S1(논리 모순·지위 오표기·기전 역전) 의심 지점을 원문 인용과 근거로 빠짐없이 보고하세요.';
  const DEFAULT_BLUE_P2_PROMPT = '첨부한 PDF와 구조화 표·그림 근거를 교차 대조해 독립 검증을 수행하세요. 본문-표-그림 수치 불일치, 참고문헌·등록부 왜곡, 논리 비약을 원문 인용과 근거로 구분해 보고하세요.';
  const DEFAULT_BLUE_FORMAT = JSON.stringify({
    findings: [{
      id: 'F-1',
      page: 1,
      locationLabel: 'Results / Table 1',
      findingType: 'D1',
      verdictLabel: '아님',
      severity: '불일치',
      quote: '원문 인용',
      rationale: '근거와 이유',
      evidence: [{ quote: '대응 원문 인용', relation: '모순 또는 불일치 관계' }],
      confidence: '높음',
      uncertainty: ''
    }]
  }, null, 2);

  const STATE_LABELS = {
    submitting: '접수 확인 필요',
    queued: '대기 중',
    running: '검수 중',
    cancelling: '취소 중',
    cancelled: '취소됨',
    completed: '완료',
    failed: '실패',
    interrupted: '중단됨(부분 결과)'
  };
  const GEMINI_BLUE_MODEL = 'gemini-4-neon-high';
  const GEMINI_BLUE_EFFORT = 'high';
  const ALLOWED_PROVIDERS = new Set(['agy-cli', 'anthropic', 'openai']);
  const PROVIDER_LABELS = { 'agy-cli': '로컬 Gemini', anthropic: 'Claude', openai: 'OpenAI' };
  const PROVIDER_GROUP_ORDER = ['agy-cli', 'anthropic', 'openai'];
  const FAILURE_LABELS = {
    auth_required: '서버 인증이 필요합니다',
    permission_denied: '이 계정에는 실행 권한이 없습니다',
    invalid_request: '요청 형식을 확인하세요',
    not_found: '작업 또는 파일을 찾지 못했습니다',
    request_too_large: '입력이 서버 한도를 넘습니다',
    payload_too_large: '입력이 서버 한도를 넘습니다',
    unsupported_media_type: 'PDF 파일만 지원합니다',
    rate_limited: '요청 한도에 도달했습니다',
    provider_error: '제공자 오류가 발생했습니다',
    overloaded: '제공자가 혼잡합니다',
    timeout: '시간 제한을 넘겼습니다',
    budget_exhausted: '실행 예산을 모두 사용했습니다',
    ai_unavailable: '내장 BLUE 서비스를 사용할 수 없습니다',
    internal_error: '서버 내부 오류입니다',
    model_jobs_operator_only: '이 화면에서는 내장 BLUE를 실행할 수 없습니다.'
  };
  const KIND_ERRORS = {
    timeout: '서버 응답 시간이 초과되었습니다.',
    network: '서버에 연결하지 못했습니다.',
    protocol: '서버 응답을 해석하지 못했습니다.'
  };
  const HTTP_ERRORS = {
    401: '로그인이 필요합니다.',
    403: '이 작업 권한이 없습니다.',
    404: '작업을 찾지 못했습니다.',
    409: '같은 요청 키로 다른 작업이 접수되어 있습니다.',
    413: 'PDF가 서버 크기 한도를 넘습니다.',
    415: 'PDF 파일만 지원합니다.',
    429: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'
  };
  const DIRECT_PROPS = new Set([
    'hidden', 'disabled', 'checked', 'value', 'id', 'type', 'readOnly', 'rows',
    'placeholder', 'accept', 'min', 'max', 'step', 'name', 'autocomplete', 'spellcheck', 'maxLength'
  ]);
  const UNKNOWN_MODELS = new Set(['manual-model-unverified', 'unknown', '미확인', '모델 미상']);

  /* ---------- pure utilities ---------- */
  function isObj(v){ return !!v && typeof v === 'object' && !Array.isArray(v); }
  function clone(v){ return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function cleanStr(v, max){
    if(v === null || v === undefined) return '';
    const s = String(v).trim();
    return max && s.length > max ? s.slice(0, max) : s;
  }
  function safeName(v, max = 200){
    const s = typeof v === 'string' ? v : '';
    return s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  }
  function allowlistedCode(v){ return typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : ''; }
  function allowlistedId(v){ return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(v) ? v : ''; }
  function positiveInt(v){
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER ? Math.floor(n) : 0;
  }
  function codePoints(text){ return [...String(text ?? '')].length; }
  function isPdfBytes(bytes){
    if(!bytes || bytes.byteLength < 5) return false;
    return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  }
  function sizeLabel(bytes){
    const n = Number(bytes);
    if(!Number.isFinite(n) || n < 0) return '';
    if(n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MiB';
    if(n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
    return n + ' B';
  }
  function isLoopbackHost(host){
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }
  function isSafeHttpUrl(value){
    if(typeof value !== 'string' || !value) return false;
    try{
      const url = new URL(value);
      return url.protocol === 'https:' || (isLoopbackHost(url.hostname) && url.protocol === 'http:');
    }catch{ return false; }
  }
  function parseBase(value, loopbackOk){
    if(typeof value !== 'string' || !value) return '';
    try{
      const url = new URL(value);
      const allowedProto = url.protocol === 'https:' || (loopbackOk && isLoopbackHost(url.hostname) && url.protocol === 'http:');
      if(!allowedProto || url.username || url.password || url.search || url.hash) return '';
      return url.origin + url.pathname.replace(/\/+$/, '');
    }catch{ return ''; }
  }
  function makeId(prefix, cryptoApi){
    const c = cryptoApi || root?.crypto;
    if(c && typeof c.randomUUID === 'function') return prefix + '-' + c.randomUUID();
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  async function sha256Hex(bytes, cryptoApi){
    const c = cryptoApi || root?.crypto;
    if(!c?.subtle?.digest) throw new Error('SHA-256을 계산할 수 없습니다.');
    const buf = await c.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function digestText(text, cryptoApi, Encoder){
    const Enc = Encoder || root?.TextEncoder || TextEncoder;
    return sha256Hex(new Enc().encode(String(text || '')), cryptoApi);
  }
  function formatTime(iso){
    if(!iso) return '';
    const d = new Date(iso);
    if(!Number.isFinite(d.getTime())) return '';
    try{ return d.toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch{ return iso.slice(0, 16).replace('T', ' '); }
  }
  function formatDateDot(ms){
    const at = new Date(ms);
    if(!Number.isFinite(at.getTime())) return '';
    return [at.getFullYear(), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0')].join('.');
  }
  function formatClock(ms){
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
  }
  function shortPaperTitle(name){
    const stem = fileStem(name) || cleanStr(name, 80);
    const head = stem.split(/:\s/)[0];
    return head.length > 28 ? head.slice(0, 27).trimEnd() + '…' : head;
  }
  function paintBars(pen, code, width, height){
    let hash = 2166136261;
    let x = 0;
    const text = String(code || 'FALSIFY');
    while(x < width){
      for(let i = 0; i < text.length && x < width; i++){
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
        const bar = 1 + (hash % 3);
        pen.fillRect(x, 0, bar, height);
        x += bar + 1 + ((hash >> 3) % 3);
      }
    }
  }
  function findingVerdictInfo(f){
    if(f.status === 'rejected') return { text: '제외됨', kind: 'excluded' };
    if(f.zeroDropRecovered || f.verdictLabel === '확인필요' || f.status === 'unresolved'){
      return { text: f.verdictLabel || '확인필요', kind: 'partial' };
    }
    if(f.verdictLabel) return { text: f.verdictLabel, kind: 'caught' };
    return { text: '지적', kind: 'excluded' };
  }
  function formatGradingSub(g, metaParts){
    const parts = [];
    if(g.detected) parts.push('적발 ' + g.detected + '곳');
    if(g.partial) parts.push('부분 적발 ' + g.partial + '곳');
    if(g.missed) parts.push('미검출 ' + g.missed + '곳');
    if(g.pending) parts.push('미채점 ' + g.pending + '곳');
    return parts.concat(metaParts).join(' · ');
  }
  function summarizeGradedTicket(g, metaParts){
    const n = g.total;
    const sub = formatGradingSub(g, metaParts);
    if(g.pending > 0){
      return { state: 'review', stamp: { kind: 'void', word: '채점 중', latin: 'GRADING', wide: true }, lead: '채점 ', strong: (n - g.pending) + '/' + n + '곳 진행 중', sub };
    }
    if(g.missed === n){
      return { state: 'missed', stamp: { kind: 'void', word: '미검출', latin: 'MISSED' }, lead: 'AI가 ', strong: n > 1 ? n + '개 모두 놓쳤어요' : '못 찾았어요', sub };
    }
    if(g.missed > 0){
      return { state: 'missed', stamp: { kind: 'void', word: '미검출', latin: 'MISSED' }, lead: n + '개 중 ' + g.missed + '개가 ', strong: 'AI 눈을 피했어요', sub };
    }
    if(g.detected === n){
      return { state: 'caught', stamp: { kind: 'fail', word: '적발', latin: 'DETECTED' }, lead: 'AI가 ', strong: n > 1 ? n + '개를 모두 찾아냈어요' : '찾아냈어요', sub };
    }
    if(g.partial === n){
      return { state: 'partial', stamp: { kind: 'fail', word: '부분 적발', latin: 'PARTIAL', wide: true }, lead: 'AI가 ', strong: n > 1 ? n + '개 모두 근처를 짚었어요' : '근처를 짚었어요', sub };
    }
    return { state: 'partial', stamp: { kind: 'fail', word: '부분 적발', latin: 'PARTIAL', wide: true }, lead: '적발 ' + g.detected + '곳 · ', strong: '부분 적발 ' + g.partial + '곳', sub };
  }
  function formatFindingCounts(findings){
    let definite = 0, checkNeeded = 0, excluded = 0;
    for(const f of findings){
      const kind = findingVerdictInfo(f).kind;
      if(kind === 'caught') definite++;
      else if(kind === 'partial') checkNeeded++;
      else if(f.status === 'rejected') excluded++;
    }
    const counts = [];
    if(definite) counts.push('아님 ' + definite + '건');
    if(checkNeeded) counts.push('확인필요 ' + checkNeeded + '건');
    if(excluded) counts.push('제외 ' + excluded + '건');
    return counts.length ? counts : ['지적 ' + findings.length + '건'];
  }
  function summarizeUngradedTicket(run, metaParts){
    const partial = Boolean(run.partial || run.status === 'interrupted');
    const stamp = partial
      ? { kind: 'void', word: '부분 완료', latin: 'PARTIAL', wide: true }
      : { kind: 'void', word: '검수 완료', latin: 'DONE', wide: true };
    const findings = Array.isArray(run.findings) ? run.findings : [];
    const leadParts = findings.length ? formatFindingCounts(findings) : [];
    return {
      state: 'completed',
      stamp,
      lead: '검수 완료 · ',
      strong: '지적 ' + findings.length + '건',
      sub: leadParts.concat(metaParts).join(' · ')
    };
  }
  function summarizeRunTicket(run, runNumber, grading){
    const metaParts = ['#' + runNumber, run.detector || 'BLUE', cleanModel(run.model), cleanStr(run.condition)].filter(Boolean);
    if(run.partial || run.status === 'interrupted') metaParts.push('부분 결과');
    if (!grading) return summarizeUngradedTicket(run, metaParts);
    if (grading.pending === grading.total) return {
      state: 'review', stamp: { kind: 'void', word: '판정 보류', latin: 'REVIEW', wide: true },
      lead: '심은 결함 ', strong: grading.total + '곳 판정 보류', sub: metaParts.join(' · ')
    };
    return summarizeGradedTicket(grading, metaParts);
  }
  function cleanModel(value){
    const s = cleanStr(value, 120);
    if(!s || UNKNOWN_MODELS.has(s.toLowerCase()) || UNKNOWN_MODELS.has(s)) return '';
    return s;
  }
  function fileStem(name){
    return safeName(name, 120).replace(/^.*[\\/]/, '').replace(/\.[^.]{1,12}$/, '').trim();
  }
  function parsePageFromOneBased(match){
    if(!match) return null;
    const p = Number(match[1] || match[2]);
    return Number.isSafeInteger(p) && p >= 1 ? p - 1 : null;
  }
  function parsePageIndexFromSegmentId(segmentId){
    if(typeof segmentId !== 'string' || !segmentId) return null;
    const s = segmentId.trim();
    const pb = /^p([0-9]{1,6})-b([0-9]{1,6})$/i.exec(s);
    if(pb) return parsePageFromOneBased(pb);
    const ocr = /^ocr-page-([0-9]{1,6})$/i.exec(s);
    if(ocr){ const p = Number(ocr[1]); return Number.isSafeInteger(p) && p >= 0 ? p : null; }
    return parsePageFromOneBased(/^page-([0-9]{1,6})$/i.exec(s));
  }
  function parsePageIndexFromLabel(label){
    if(typeof label !== 'string' || !label) return null;
    return parsePageFromOneBased(/(?:PDF\s*p\.?|page|p\.)\s*([0-9]{1,6})\b|\b([0-9]{1,6})\s*쪽/i.exec(label));
  }
  function parseExplicitPage(item){
    if(Number.isInteger(item.pageIndex) && item.pageIndex >= 0) return item.pageIndex;
    if(Number.isInteger(item.page) && item.page >= 1) return item.page - 1;
    if(typeof item.page !== 'string') return null;
    return parsePageFromOneBased(/^\s*([0-9]{1,6})\s*(?:쪽|p(?:age)?\.?)?\s*$/i.exec(item.page));
  }
  function pageIndexFromSegments(segmentId, segments){
    if(!segmentId || !Array.isArray(segments)) return null;
    const seg = segments.find(s => s && s.id === segmentId);
    if(!seg) return null;
    if(Number.isInteger(seg.pageIndex) && seg.pageIndex >= 0) return seg.pageIndex;
    return parsePageIndexFromLabel(seg.label);
  }
  function resolvePageIndex(item, segments){
    if(!isObj(item)) return null;
    const explicit = parseExplicitPage(item);
    if(explicit !== null) return explicit;
    const fromId = parsePageIndexFromSegmentId(item.segmentId);
    if(fromId !== null) return fromId;
    const fromSeg = pageIndexFromSegments(item.segmentId, segments);
    if(fromSeg !== null) return fromSeg;
    return parsePageIndexFromLabel(item.locationLabel || item.label);
  }
  function usableLabel(value){
    const text = cleanStr(value, 240);
    return text && !/^구간 \d+$/.test(text) ? text : '';
  }
  function resolveLocationLabel(item, segments){
    const direct = cleanStr(item.locationLabel || item.location, 240) || usableLabel(item.label);
    if(direct) return direct;
    if(!Array.isArray(segments) || !item.segmentId) return '';
    const seg = segments.find(s => s && s.id === item.segmentId);
    return usableLabel(seg?.label);
  }
  function normalizeEvidenceEntry(entry, segments){
    if(typeof entry === 'string'){
      const q = entry.trim();
      return q ? { quote: q, relation: '' } : null;
    }
    if(!isObj(entry)) return null;
    const quote = cleanStr(entry.quote ?? entry.text);
    const baseRel = cleanStr(entry.relation ?? entry.reason ?? entry.detail);
    const metaRel = baseRel || [entry.label, entry.title, entry.doi, entry.url].map(x => cleanStr(x)).filter(Boolean).join(' · ');
    if(!quote && !metaRel) return null;
    const item = { quote, relation: metaRel };
    const pageIndex = resolvePageIndex(entry, segments);
    if(pageIndex !== null) item.pageIndex = pageIndex;
    return item;
  }
  function normalizeEvidence(raw, segments){
    if(!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for(const entry of list){
      const item = normalizeEvidenceEntry(entry, segments);
      if(item) out.push(item);
    }
    return out;
  }
  function stripLegacyHbPrefix(text){
    const s = cleanStr(text);
    const m = /^\[hb-\d+\]\s+([\s\S]+)$/.exec(s);
    return m ? m[1] : s;
  }
  function isInternalFindingId(rawId){
    return !rawId || UUID_RE.test(rawId) || /^external-/.test(rawId) || /^p\d+$/.test(rawId);
  }
  function cleanFindingId(item, index){
    const rn = cleanStr(item?.reportNumber, 80);
    if(rn) return rn;
    const rawId = cleanStr(item?.id, 80);
    return isInternalFindingId(rawId) ? 'F-' + (index + 1) : rawId;
  }

  /* Strict RED/BLUE boundary: only extract { file, sha256, revision } from artifact(). */
  async function extractArtifactInfo(raw, cryptoApi){
    if(!isObj(raw)) return null;
    const file = raw.file || null;
    let sha256 = typeof raw.sha256 === 'string' && HEX_64.test(raw.sha256) ? raw.sha256.toLowerCase() : '';
    if(!sha256 && file && typeof file.arrayBuffer === 'function'){
      const bytes = new Uint8Array(await file.arrayBuffer());
      if(bytes.byteLength > 0) sha256 = await sha256Hex(bytes, cryptoApi);
    }
    if(!sha256) return null;
    const revision = cleanStr(raw.revision, 160) || ('rev-' + sha256.slice(0, 12));
    const name = safeName(file?.name || raw.name || '', 200) || ('paper-' + sha256.slice(0, 8) + '.pdf');
    return { file, sha256, revision, name };
  }

  /* ---------- standard CSV projection ---------- */
  function projectFinding(f, idx){
    const item = isObj(f) ? f : {};
    const pageIndex = Number.isInteger(item.pageIndex) && item.pageIndex >= 0 ? item.pageIndex : null;
    const projected = {
      id: cleanStr(item.id, 80) || ('F-' + (idx + 1)),
      pageIndex,
      locationLabel: cleanStr(item.locationLabel, 240),
      findingType: cleanStr(item.findingType, 120),
      verdictLabel: cleanStr(item.verdictLabel, 80),
      severity: cleanStr(item.severity, 80),
      quote: cleanStr(item.quote),
      rationale: cleanStr(item.rationale),
      evidence: normalizeEvidence(item.evidence),
      confidence: cleanStr(item.confidence, 80),
      uncertainty: cleanStr(item.uncertainty)
    };
    const st = cleanStr(item.status, 40);
    if(st) projected.status = st;
    return projected;
  }
  function projectRun(record, runNumber){
    const r = isObj(record) ? record : {};
    const list = Array.isArray(r.findings) ? r.findings : [];
    return {
      id: cleanStr(r.id, 160),
      fileHash: cleanStr(r.fileHash, 64),
      detector: cleanStr(r.detector, 80),
      model: cleanModel(r.model),
      condition: cleanStr(r.condition, 160),
      runNumber: Number.isInteger(runNumber) && runNumber >= 1 ? runNumber : 1,
      findings: list.map((f, i) => projectFinding(f, i))
    };
  }
  function sortRunsChronologically(records){
    return records.slice().sort((a, b) => {
      const ta = Date.parse(a?.createdAt || '') || 0;
      const tb = Date.parse(b?.createdAt || '') || 0;
      return ta !== tb ? ta - tb : String(a?.id || '').localeCompare(String(b?.id || ''));
    });
  }
  function projectRuns(records, fileHash){
    const list = Array.isArray(records) ? records : [];
    const filtered = list.filter(r => r && (!fileHash || r.fileHash === fileHash));
    return sortRunsChronologically(filtered).map((r, i) => projectRun(r, i + 1));
  }

  /* ---------- storage helpers (never silently truncate prior runs) ---------- */
  function getLocalStorage(override){
    if(override) return override;
    try{ return root.localStorage || null; }catch{ return null; }
  }
  function getSessionStorage(override){
    if(override) return override;
    try{ return root.sessionStorage || null; }catch{ return null; }
  }
  function readJson(storage, key){
    if(!storage) return null;
    try{
      const raw = storage.getItem(key);
      if(!raw) return null;
      const parsed = JSON.parse(raw);
      return isObj(parsed) ? parsed : null;
    }catch{ return null; }
  }
  function writeJson(storage, key, value, maxChars){
    if(!storage) return { ok: false, error: '브라우저 저장소를 사용할 수 없습니다.' };
    let raw = '';
    try{ raw = JSON.stringify(value); }catch{ return { ok: false, error: '저장 데이터를 직렬화하지 못했습니다.' }; }
    if(maxChars && raw.length > maxChars){
      return { ok: false, error: '브라우저 저장 용량 한도에 도달해 기존 기록을 유지하고 새 기록을 저장하지 않았습니다.' };
    }
    try{ storage.setItem(key, raw); return { ok: true }; }
    catch(e){ return { ok: false, error: '저장 공간 부족으로 기존 기록만 유지했습니다 (' + (e?.name || '저장 오류') + ').' }; }
  }
  function removeJson(storage, key){
    if(!storage) return;
    try{ storage.removeItem(key); }catch{}
  }
  function readW8Runs(ls){
    const data = readJson(ls, RUNS_STORE_KEY);
    if(!data || data.schema !== RUNS_STORE_KEY || !Array.isArray(data.runs)) return [];
    return data.runs.filter(r => isObj(r) && typeof r.id === 'string' && HEX_64.test(r.fileHash || ''));
  }
  function writeW8Runs(ls, runs){
    if(runs.length > MAX_RUNS_STORED){
      return { ok: false, error: '저장 가능한 최대 실행 수(' + MAX_RUNS_STORED + '건)에 도달해 기존 기록을 유지하고 새 기록을 저장하지 않았습니다.' };
    }
    return writeJson(ls, RUNS_STORE_KEY, { schema: RUNS_STORE_KEY, runs }, MAX_STORE_CHARS);
  }
  function readPendingJobs(ls){
    const data = readJson(ls, PENDING_STORE_KEY);
    if(!data || data.schema !== PENDING_STORE_KEY || !Array.isArray(data.jobs)) return [];
    return data.jobs.filter(j => isObj(j) && typeof j.id === 'string' && HEX_64.test(j.fileHash || ''));
  }
  function writePendingJobs(ls, jobs){
    if(jobs.length > MAX_PENDING_STORED){
      return { ok: false, error: '대기 작업 한도에 도달해 기존 대기 기록을 유지했습니다.' };
    }
    return writeJson(ls, PENDING_STORE_KEY, { schema: PENDING_STORE_KEY, jobs }, 250000);
  }

  /* ---------- legacy experiment-ledger read bridge ---------- */
  function convertLedgerFinding(f, idx, segments, hosted){
    const rawQuote = cleanStr(f?.quote);
    const quote = hosted ? stripLegacyHbPrefix(rawQuote) : rawQuote;
    const ev = normalizeEvidence(f?.evidence, segments).map(e => ({
      ...e,
      quote: hosted ? stripLegacyHbPrefix(e.quote) : e.quote,
      relation: e.relation
    }));
    const pageIndex = resolvePageIndex(f, segments);
    return {
      id: cleanFindingId(f, idx),
      pageIndex,
      locationLabel: resolveLocationLabel(f, segments),
      findingType: cleanStr(f?.findingType || f?.defectFamily, 120),
      verdictLabel: cleanStr(f?.verdictLabel, 80),
      severity: cleanStr(f?.severity, 80),
      quote,
      rationale: cleanStr(f?.rationale),
      evidence: ev,
      confidence: cleanStr(f?.confidence, 80),
      uncertainty: cleanStr(f?.uncertainty),
      status: cleanStr(f?.status || f?.state, 40),
      matchStatus: pageIndex !== null ? 'matched' : 'missing',
      segmentId: cleanStr(f?.segmentId) || null,
      matches: []
    };
  }
  function ledgerDetector(r, hosted){
    if(hosted) return DETECTOR_HOSTED;
    return r.provenance === 'local-codex' ? DETECTOR_LOCAL : DETECTOR_MANUAL;
  }
  function convertLedgerRun(r){
    const segments = Array.isArray(r.segments) ? r.segments : [];
    const hosted = typeof r.requestId === 'string' && r.requestId.startsWith('hosted:');
    const rawFindings = Array.isArray(r.response?.findings) ? r.response.findings : [];
    const customHarness = r.harness?.id !== 'builtin-blue' ? r.harness?.name : '';
    return {
      id: r.id,
      fileHash: r.fileHash,
      revision: cleanStr(r.revision, 160),
      fileName: safeName(r.sourceName || ''),
      detector: ledgerDetector(r, hosted),
      sourceKind: hosted ? 'hosted' : 'ledger',
      jobId: hosted ? r.requestId.slice('hosted:'.length) : '',
      requestId: cleanStr(r.requestId, 200),
      ledgerRunId: r.id,
      model: cleanModel(r.model),
      condition: cleanStr(customHarness, 160),
      status: cleanStr(r.response?.status, 32) || 'ok',
      createdAt: r.createdAt || new Date(0).toISOString(),
      updatedAt: r.createdAt || new Date(0).toISOString(),
      findings: rawFindings.map((f, idx) => convertLedgerFinding(f, idx, segments, hosted)),
      readOnlyLegacy: true
    };
  }
  function convertExternalLedgerRecord(r){
    const snap = r.snapshot;
    if(!isObj(snap) || snap.role !== 'blue') return null;
    const segments = Array.isArray(r.segments) ? r.segments : [];
    const batches = Array.isArray(snap.batches) ? snap.batches : [];
    const first = batches[0] || {};
    const items = Array.isArray(snap.items) ? snap.items : [];
    return {
      id: r.id,
      fileHash: r.fileHash,
      revision: cleanStr(r.revision, 160),
      fileName: safeName(r.sourceName || ''),
      detector: DETECTOR_EXTERNAL,
      sourceKind: 'external',
      externalRecordId: r.id,
      model: cleanModel(first.model),
      condition: cleanStr(first.condition, 160),
      status: cleanStr(first.status, 32) || 'ok',
      report: batches.map(b => cleanStr(b.report)).filter(Boolean).join('\n\n'),
      zeroDropSummary: batches.find(b => b.zeroDropSummary)?.zeroDropSummary || null,
      createdAt: r.createdAt || new Date(0).toISOString(),
      updatedAt: r.createdAt || new Date(0).toISOString(),
      findings: items.map((item, idx) => normalizeExternalFinding(item, idx, segments)),
      readOnlyLegacy: true
    };
  }
  function buildKnownSets(w8){
    return {
      ids: new Set(w8.map(r => r.id)),
      jobs: new Set(w8.map(r => r.jobId).filter(Boolean)),
      ledger: new Set(w8.map(r => r.ledgerRunId).filter(Boolean)),
      external: new Set(w8.map(r => r.externalRecordId).filter(Boolean))
    };
  }
  function appendLegacyRuns(out, ledger, fileHash, known){
    if(!Array.isArray(ledger?.runs)) return;
    for(const r of ledger.runs){
      if(!isObj(r) || r.role !== 'blue') continue;
      if(fileHash && r.fileHash !== fileHash) continue;
      const jobId = typeof r.requestId === 'string' && r.requestId.startsWith('hosted:') ? r.requestId.slice(7) : '';
      if(known.ids.has(r.id) || known.ledger.has(r.id) || (jobId && known.jobs.has(jobId))) continue;
      out.push(convertLedgerRun(r));
    }
  }
  function appendLegacyExternal(out, ledger, fileHash, known){
    if(!Array.isArray(ledger?.externalResponses)) return;
    for(const r of ledger.externalResponses){
      if(!isObj(r) || r.snapshot?.role !== 'blue') continue;
      if(fileHash && r.fileHash !== fileHash) continue;
      if(known.ids.has(r.id) || known.external.has(r.id)) continue;
      const converted = convertExternalLedgerRecord(r);
      if(converted) out.push(converted);
    }
  }
  function readMergedRuns(ls, fileHash){
    const w8 = readW8Runs(ls).filter(r => !fileHash || r.fileHash === fileHash);
    const out = w8.slice();
    const ledger = readJson(ls, LEDGER_KEY);
    if(ledger){
      const known = buildKnownSets(w8);
      appendLegacyRuns(out, ledger, fileHash, known);
      appendLegacyExternal(out, ledger, fileHash, known);
    }
    return sortRunsChronologically(out);
  }

  /* ---------- normalizing hosted & external findings (zero silent dropping) ---------- */
  function normalizeHostedFinding(item, idx, segments){
    const src = isObj(item) ? item : { rationale: cleanStr(item) };
    const pageIndex = resolvePageIndex(src, segments);
    return {
      id: cleanFindingId(src, idx),
      pageIndex,
      locationLabel: resolveLocationLabel(src, segments),
      findingType: cleanStr(src.findingType || src.defectFamily || src.type, 120),
      verdictLabel: cleanStr(src.verdictLabel || src.verdict, 80),
      severity: cleanStr(src.severity, 80),
      quote: cleanStr(src.quote || src.sourceQuote),
      rationale: cleanStr(src.rationale || src.summary || src.message),
      evidence: normalizeEvidence(src.evidence, segments),
      confidence: cleanStr(src.confidence, 80),
      uncertainty: cleanStr(src.uncertainty || src.additionalInfo || src.neededInfo),
      status: cleanStr(src.status || src.state, 40),
      matchStatus: pageIndex !== null ? 'matched' : 'missing',
      segmentId: cleanStr(src.segmentId) || null,
      matches: [],
      zeroDropRecovered: src.zeroDropRecovered === true
    };
  }
  function normalizeExternalFinding(item, idx, segments){
    const src = isObj(item) ? item : { rationale: cleanStr(item) };
    const pageIndex = resolvePageIndex(src, segments);
    return {
      id: cleanFindingId(src, idx),
      pageIndex,
      locationLabel: resolveLocationLabel(src, segments),
      findingType: cleanStr(src.findingType || src.defectFamily, 120),
      verdictLabel: cleanStr(src.verdictLabel, 80),
      severity: cleanStr(src.severity, 80),
      quote: cleanStr(src.quote || src.sourceQuote),
      rationale: cleanStr(src.rationale),
      evidence: normalizeEvidence(src.evidence, segments),
      confidence: cleanStr(src.confidence, 80),
      uncertainty: cleanStr(src.uncertainty || src.additionalInfo || src.neededInfo),
      status: cleanStr(src.status || src.state, 40),
      matchStatus: cleanStr(src.matchStatus) || (pageIndex !== null ? 'matched' : 'missing'),
      segmentId: cleanStr(src.segmentId) || null,
      matches: Array.isArray(src.matches) ? src.matches.slice(0, 10) : [],
      zeroDropRecovered: src.zeroDropRecovered === true
    };
  }
  function parseJsonBlock(raw){
    const text = String(raw || '').trim().replace(/^\uFEFF/, '');
    if(!text) return null;
    try{ return JSON.parse(text); }catch{}
    const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
    if(fence){ try{ return JSON.parse(fence[1]); }catch{} }
    return null;
  }
  function isExplicitZeroFindingResponse(raw){
    const obj = parseJsonBlock(raw);
    if(!isObj(obj)) return false;
    if(obj.error || (obj.status && obj.status !== 'ok')) return false;
    const list = obj.findings ?? obj.verdicts ?? obj.items;
    if(Array.isArray(list) && list.length === 0) return true;
    return obj.status === 'ok' && list === undefined;
  }
  function hasValidHostedFindings(job){
    if(!isObj(job) || !isObj(job.result)) return false;
    return Array.isArray(job.result.findings);
  }
  function describeHostedError(error, context){
    if(!error) return '요청을 처리하지 못했습니다.';
    if(error.kind === 'local' && error.message) return String(error.message);
    if(error.code && FAILURE_LABELS[error.code]) return FAILURE_LABELS[error.code];
    if(error.kind && KIND_ERRORS[error.kind]) return KIND_ERRORS[error.kind];
    if(context === 'login' && error.status === 401) return '아이디 또는 비밀번호가 올바르지 않습니다.';
    if(HTTP_ERRORS[error.status]) return HTTP_ERRORS[error.status];
    return error.status >= 500 ? '서버 오류가 발생했습니다.' : '요청을 처리하지 못했습니다.';
  }
  function readModelProviders(raw){
    if(!isObj(raw)) return null;
    const map = {};
    for(const k of Object.keys(raw)){
      if(/^[A-Za-z0-9._-]{1,64}$/.test(k) && ALLOWED_PROVIDERS.has(raw[k])) map[k] = raw[k];
    }
    return map;
  }
  function isLocalGeminiModel(model, caps){
    if(!model) return false;
    return model === GEMINI_BLUE_MODEL || caps?.modelProviders?.[model] === 'agy-cli';
  }
  function defaultBlueModel(caps){
    if(!caps) return '';
    if(caps.blueDefaultModel && caps.models.includes(caps.blueDefaultModel)) return caps.blueDefaultModel;
    return caps.models[0] || '';
  }
  function defaultBlueEffort(caps, model){
    if(isLocalGeminiModel(model, caps)) return GEMINI_BLUE_EFFORT;
    if(caps?.blueDefaultEffort && caps.efforts.includes(caps.blueDefaultEffort)) return caps.blueDefaultEffort;
    if(caps?.efforts?.includes('high')) return 'high';
    return caps?.efforts?.[0] || '';
  }
  function normalizeCapabilities(data){
    if(!isObj(data)) return null;
    const models = Array.isArray(data.models) ? data.models.filter(m => typeof m === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(m)).slice(0, 20) : [];
    const efforts = Array.isArray(data.efforts) ? data.efforts.filter(e => typeof e === 'string' && /^[a-z]{1,16}$/.test(e)).slice(0, 12) : [];
    const limits = isObj(data.limits) ? data.limits : {};
    const blueDefaultModel = typeof data.blueDefaultModel === 'string' && models.includes(data.blueDefaultModel) ? data.blueDefaultModel : '';
    const blueDefaultEffort = typeof data.blueDefaultEffort === 'string' && /^[a-z]{1,16}$/.test(data.blueDefaultEffort) ? data.blueDefaultEffort : '';
    return {
      enabled: data.enabled === true,
      models,
      efforts,
      modelProviders: readModelProviders(data.modelProviders),
      blueDefaultModel,
      blueDefaultEffort,
      maxUploadBytes: positiveInt(limits.maxUploadBytes) || MAX_UPLOAD_FALLBACK,
      maxPromptChars: positiveInt(limits.maxPromptChars) || MAX_PROMPT_FALLBACK,
      blueJobs: data.blueJobs !== false,
      modelJobs: data.modelJobs !== false
    };
  }
  function tryParseTeamPromptJson(trimmed, def){
    try{
      const parsed = JSON.parse(trimmed);
      if(!isObj(parsed)) return def;
      const body = cleanStr(parsed.prompt || parsed.instructions || parsed.text);
      if(!body) return def;
      return {
        name: def.name,
        text: body,
        format: typeof parsed.format === 'string' ? parsed.format : '',
        condition: cleanStr(parsed.condition || parsed.name, 120) || def.condition
      };
    }catch{ return def; }
  }
  function teamConditionForFile(fileName){
    const stem = fileStem(fileName).replace(/\s*\(\d+\)$/, '').trim();
    if(/^(?:blue[_\s-]*)?공통[_\s-]*프롬프트[_\s-]*v6$/i.test(stem)) return W8_TEAM_PROMPT_V6_CONDITION;
    return stem || 'W8-team';
  }
  function parseTeamPromptText(raw, fileName){
    const trimmed = String(raw || '').replace(/^\uFEFF/, '').trim();
    if(!trimmed) throw new Error('팀 프롬프트 파일이 비어 있습니다.');
    const def = { name: safeName(fileName, 120) || 'team-prompt.txt', text: trimmed, format: '', condition: teamConditionForFile(fileName) };
    const isJsonLike = /\.json$/i.test(fileName || '') || trimmed.startsWith('{');
    return isJsonLike ? tryParseTeamPromptJson(trimmed, def) : def;
  }
  function formatJobProgress(job){
    const p = isObj(job.progress) ? job.progress : {};
    const done = Number.isFinite(Number(p.completedCalls)) ? Math.floor(Number(p.completedCalls)) : null;
    const req = Number.isFinite(Number(p.requiredCalls)) && Number(p.requiredCalls) > 0 ? Math.floor(Number(p.requiredCalls)) : null;
    const phase = cleanStr(p.phase, 32);
    const parts = [STATE_LABELS[job.state] || job.state];
    if(done !== null) parts.push('호출 ' + done + (req !== null ? '/' + req : ''));
    if(phase) parts.push(phase);
    return '내장 BLUE ' + parts.join(' · ');
  }

  /* ---------- DOM helpers (textContent only) ---------- */
  function applyElProp(node, k, v){
    if(v === undefined || v === null || v === false) return;
    if(k === 'textContent') node.textContent = String(v);
    else if(k === 'className') node.className = String(v);
    else if(DIRECT_PROPS.has(k)) node[k] = v;
    else node.setAttribute(k, String(v));
  }
  function appendKids(node, kids){
    for(const kid of kids){
      if(kid === null || kid === undefined || kid === false) continue;
      if(Array.isArray(kid)) appendKids(node, kid);
      else node.append(kid);
    }
  }
  function createEl(doc, tag, props, ...kids){
    const node = doc.createElement(tag);
    if(props) for(const [k, v] of Object.entries(props)) applyElProp(node, k, v);
    appendKids(node, kids);
    return node;
  }
  function clearNode(node){
    if(!node) return;
    if(typeof node.replaceChildren === 'function') node.replaceChildren();
    else node.textContent = '';
  }

  function resolveCoreDeps(host, options){
    return {
      doc: options.document || host.ownerDocument || root.document,
      ls: getLocalStorage(options.localStorage || options.storage),
      ss: getSessionStorage(options.sessionStorage),
      fetchImpl: options.fetch || ((u, i) => root.fetch(u, i)),
      cryptoApi: options.crypto || root.crypto || null,
      UrlApi: options.URL || root.URL || URL,
      Encoder: options.TextEncoder || root.TextEncoder || TextEncoder,
      Abort: options.AbortController || root.AbortController || null
    };
  }
  function resolveBridgeDeps(options){
    const pick = (a, b) => a !== undefined ? a : b;
    return {
      nowFn: options.now || (() => Date.now()),
      setT: options.setTimeout || ((fn, ms) => root.setTimeout(fn, ms)),
      clearT: options.clearTimeout || (id => root.clearTimeout(id)),
      configFn: options.config || (() => root.FalsifyCloudConfig),
      providerFn: options.sessionProvider || (() => root.FalsifyHostedSession),
      exchangeFn: () => pick(options.exchange, root.FalsifyExternalExchange) || null,
      promptApiFn: () => pick(options.promptInstructions, root.FalsifyPromptInstructions) || null,
      importApiFn: () => pick(options.importModule, root.FalsifyImport) || null,
      labFn: () => pick(options.lab, root.FalsifyLab) || null,
      pendingJobsFn: () => pick(options.pendingJobs, root.FalsifyPendingJobs) || null,
      paperLinksFn: () => pick(options.paperLinks, root.FalsifyW8PaperLinks) || null,
      archiveFn: () => pick(options.archive, root.FalsifyW8Archive) || null
    };
  }
  function resolveDeps(host, options){
    return Object.assign(resolveCoreDeps(host, options), resolveBridgeDeps(options));
  }
  function createInitialState(){
    return {
      mode: 'hosted',
      artifact: null,
      artifactEpoch: 0,
      artifactStale: false,
      copyEpoch: 0,
      copyingLink: false,
      segmentsByHash: new Map(),
      apiBase: '',
      hostedGate: 'checking',
      hostedDisabledMsg: '',
      capabilities: null,
      session: null,
      hookError: null,
      uploadByHash: new Map(),
      busy: '',
      hostedStatus: '',
      hostedError: '',
      activeJob: null,
      activePending: null,
      pollTimer: null,
      pollAttempt: 0,
      pollFailures: 0,
      clockTimer: null,
      jobStartedAt: 0,
      lastTerminalState: '',
      model: '',
      effort: '',
      useEvidence: true,
      maxCalls: '',
      promptSource: 'preset:p0',
      promptText: '',
      promptFormat: DEFAULT_BLUE_FORMAT,
      promptLabel: '기본 BLUE (P0)',
      condition: 'P0',
      privatePrompt: false,
      teamPromptFile: null,
      sharedPrompts: [],
      savedPrompts: [],
      externalModel: '',
      externalStatus: '',
      externalError: '',
      duplicateDraft: null,
      copyStatus: '',
      filterRunId: 'all',
      filterUnmatchedOnly: false,
      lastEmittedSig: null,
      destroyed: false,
      timers: new Set(),
      docListeners: []
    };
  }

  /* ---------- active mount registry ---------- */
  const mountedByHost = new WeakMap();
  let activeInstance = null;

  /* ---------- controller ---------- */
  function createController(host, options){
    const d = resolveDeps(host, options);
    const st = createInitialState();
    const nodes = {};

    function later(fn, ms){
      const id = d.setT(() => { st.timers.delete(id); if(!st.destroyed) fn(); }, ms);
      st.timers.add(id);
      return id;
    }
    function cancelLater(id){
      if(id === null || id === undefined) return;
      st.timers.delete(id);
      d.clearT(id);
    }
    function stopPoll(){
      if(st.pollTimer !== null){ cancelLater(st.pollTimer); st.pollTimer = null; }
      st.pollAttempt = 0;
    }
    function stopClock(){
      if(st.clockTimer !== null){ cancelLater(st.clockTimer); st.clockTimer = null; }
    }
    function syncTicketElapsed(){
      if(!nodes.ticketElapsed) return;
      const p = isObj(st.activeJob?.progress) ? st.activeJob.progress : null;
      const done = p && Number.isFinite(Number(p.completedCalls)) ? Math.floor(Number(p.completedCalls)) : null;
      const req = p && Number.isFinite(Number(p.requiredCalls)) && Number(p.requiredCalls) > 0 ? Math.floor(Number(p.requiredCalls)) : null;
      const clock = st.jobStartedAt > 0 ? formatClock(d.nowFn() - st.jobStartedAt) : '';
      const calls = done !== null ? '호출 ' + done + (req !== null ? '/' + req : '') : '';
      nodes.ticketElapsed.textContent = [calls, clock].filter(Boolean).join(' · ') || '0:00';
    }
    function startClock(startedMs){
      const base = Number.isFinite(startedMs) && startedMs > 0 ? startedMs : d.nowFn();
      if(!st.jobStartedAt) st.jobStartedAt = base;
      syncTicketElapsed();
      if(st.clockTimer !== null || st.destroyed || typeof root.requestAnimationFrame !== 'function') return;
      const tick = () => {
        st.clockTimer = null;
        if(st.destroyed || !st.jobStartedAt) return;
        syncTicketElapsed();
        st.clockTimer = later(tick, 1000);
      };
      st.clockTimer = later(tick, 1000);
    }
    function onDoc(type, fn){
      if(!d.doc || typeof d.doc.addEventListener !== 'function') return;
      d.doc.addEventListener(type, fn);
      st.docListeners.push([type, fn]);
    }
    function emitEvent(name, detail){
      if(!d.doc || typeof d.doc.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
      try{ d.doc.dispatchEvent(new CustomEvent(name, { detail })); }catch{}
    }

    /* ---------- artifact & segment extraction ---------- */
    async function resolveArtifact(){
      if(typeof options.artifact !== 'function') return null;
      try{
        const raw = await Promise.resolve(options.artifact());
        return await extractArtifactInfo(raw, d.cryptoApi);
      }catch{
        return null;
      }
    }
    async function segmentsFromBridge(sha256){
      const src = root.FalsifyDocumentBlueExternal?.getSource?.();
      if(!src || src.fileHash !== sha256 || !Array.isArray(src.segments) || !src.segments.length) return null;
      const sourceHash = src.sourceHash || await digestText(src.segments.map(s => s.text).join('\n\n'), d.cryptoApi, d.Encoder);
      return { sourceHash, segments: clone(src.segments) };
    }
    async function segmentsFromImport(file){
      const imp = d.importApiFn();
      if(!imp || typeof imp.extract !== 'function' || !file) return null;
      try{
        const imported = await imp.extract(file, {});
        const rawSegs = Array.isArray(imported?.segments) ? imported.segments : [];
        const segments = rawSegs.map((s, i) => ({
          id: s.id || ('s' + i),
          label: cleanStr(s.label) || ('PDF p. ' + (i + 1)),
          pageIndex: Number.isInteger(s.pageIndex) ? s.pageIndex : (parsePageIndexFromLabel(s.label) ?? i),
          text: String(s.text || '')
        }));
        const sourceHash = segments.length ? await digestText(segments.map(s => s.text).join('\n\n'), d.cryptoApi, d.Encoder) : '';
        return { sourceHash, segments };
      }catch{ return null; }
    }
    async function ensureSegments(art){
      if(!art?.sha256) return { sourceHash: '', segments: [] };
      if(st.segmentsByHash.has(art.sha256)) return st.segmentsByHash.get(art.sha256);
      const entry = (await segmentsFromBridge(art.sha256)) || (await segmentsFromImport(art.file));
      if(entry){ st.segmentsByHash.set(art.sha256, entry); return entry; }
      return { sourceHash: '', segments: [] };
    }

    /* ---------- prompt catalog & presets ---------- */
    function presetEntry(kind){
      const list = Array.isArray(d.promptApiFn()?.PRESETS?.blue) ? d.promptApiFn().PRESETS.blue : [];
      const wantP2 = kind === 'p2';
      const entry = list.find(p => p.tier === (wantP2 ? 'P2' : 'P0')) || list[wantP2 ? 1 : 0];
      return {
        prompt: entry?.prompt || (wantP2 ? DEFAULT_BLUE_P2_PROMPT : DEFAULT_BLUE_P0_PROMPT),
        format: entry?.format || DEFAULT_BLUE_FORMAT,
        label: entry?.label || (wantP2 ? '교차 검증 BLUE (P2)' : '기본 BLUE (P0)'),
        condition: wantP2 ? 'P2' : 'P0'
      };
    }
    function loadSavedPrompts(){
      try{
        const str = d.ls?.getItem(PROMPT_VERSIONS_KEY);
        const parsed = str ? JSON.parse(str) : [];
        return Array.isArray(parsed) ? parsed.filter(v => isObj(v) && typeof v.id === 'string' && typeof v.text === 'string') : [];
      }catch{ return []; }
    }
    async function refreshPromptCatalog(){
      st.savedPrompts = loadSavedPrompts();
      const lab = d.labFn();
      if(lab && typeof lab.promptInstructions === 'function'){
        try{
          const rows = await lab.promptInstructions('blue');
          st.sharedPrompts = Array.isArray(rows) ? rows.filter(h => isObj(h) && typeof h.instructions === 'string') : [];
        }catch{ st.sharedPrompts = []; }
      }
      renderPromptOptions();
    }
    function resolvePromptChoice(sourceId){
      if(sourceId === 'preset:p0') return Object.assign(presetEntry('p0'), { privatePrompt: false });
      if(sourceId === 'preset:p2') return Object.assign(presetEntry('p2'), { privatePrompt: false });
      if(sourceId === 'team-file' && st.teamPromptFile){
        return {
          prompt: st.teamPromptFile.text, format: st.teamPromptFile.format || '',
          label: 'W8 팀 프롬프트 · ' + st.teamPromptFile.name, condition: st.teamPromptFile.condition, privatePrompt: true
        };
      }
      if(sourceId.startsWith('saved:')){
        const v = st.savedPrompts.find(x => x.id === sourceId.slice(6));
        return v ? { prompt: v.text, format: v.format || '', label: v.name || '저장 지시문', condition: cleanStr(v.name, 120), privatePrompt: false } : null;
      }
      if(sourceId.startsWith('shared:')){
        const h = st.sharedPrompts.find(x => x.hash === sourceId.slice(7));
        const label = h ? h.name + (h.version ? ' v' + h.version : '') : '';
        return h ? { prompt: h.instructions, format: DEFAULT_BLUE_FORMAT, label, condition: cleanStr(label, 120), privatePrompt: false } : null;
      }
      return null;
    }
    function applyPromptSelection(sourceId){
      st.promptSource = sourceId;
      const choice = resolvePromptChoice(sourceId);
      if(choice){
        st.promptText = choice.prompt;
        st.promptFormat = choice.format;
        st.promptLabel = choice.label;
        st.condition = choice.condition;
        st.privatePrompt = choice.privatePrompt;
      }
      if(nodes.promptText) nodes.promptText.value = st.promptText;
      if(nodes.conditionInput) nodes.conditionInput.value = st.condition;
      render();
    }
    async function readFileText(file){
      if(typeof file.text === 'function') return file.text();
      return new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    }
    async function loadTeamPromptFile(file){
      if(!file) return;
      if(Number(file.size) > MAX_TEAM_PROMPT_BYTES){
        st.hostedError = st.externalError = '팀 프롬프트 파일은 200KB 이하여야 합니다.';
        render();
        return;
      }
      try{
        const raw = await readFileText(file);
        st.teamPromptFile = parseTeamPromptText(raw, file.name);
        renderPromptOptions();
        applyPromptSelection('team-file');
        st.hostedError = st.externalError = '';
        st.copyStatus = '비공개 팀 프롬프트를 불러왔습니다(메모리에만 유지).';
      }catch(e){
        st.hostedError = st.externalError = '팀 프롬프트 파일을 읽지 못했습니다: ' + (e?.message || '오류');
      }
      render();
    }
    function archiveSharingAllowed(){
      const archive = d.archiveFn();
      if(archive && typeof archive.enabled === 'function'){
        try{ return archive.enabled() === true; }catch{ return true; }
      }
      return true;
    }
    function currentArtifactLink(art){
      const target = art || st.artifact;
      if(!target?.sha256 || (!art && st.artifactStale) || !archiveSharingAllowed()) return '';
      const links = d.paperLinksFn();
      if(!links || typeof links.url !== 'function') return '';
      try{
        const value = cleanStr(links.url(target.sha256), 2048);
        return isSafeHttpUrl(value) ? value : '';
      }catch{
        return '';
      }
    }
    function buildExternalCopyPrompt(art, linkUrl){
      const target = art || st.artifact;
      const safeLink = isSafeHttpUrl(linkUrl) ? linkUrl : '';
      const attach = safeLink
        ? 'PDF: ' + safeLink + '\n위 링크의 PDF를 처음부터 끝까지 읽고 그 파일만 기준으로 작업하세요. 링크를 열 수 없으면 PDF 파일을 이 대화에 첨부해 작업하세요.'
        : (target?.name
          ? '원본 파일 ' + target.name + '을 이 대화에 첨부하고 그 파일을 기준으로 작업하세요.'
          : '검수 대상 PDF 파일을 이 대화에 첨부하고 그 파일을 기준으로 작업하세요.');
      const base = cleanStr(st.promptText) || presetEntry('p0').prompt;
      const fmt = st.privatePrompt ? cleanStr(st.promptFormat) : (cleanStr(st.promptFormat) || DEFAULT_BLUE_FORMAT);
      const api = d.promptApiFn();
      return api && typeof api.compose === 'function' ? api.compose(base, fmt, attach) : [base, attach, fmt].filter(Boolean).join('\n\n');
    }

    /* ---------- hosted API & auth (direct /v1/ai/* route) ---------- */
    function readConfig(){ try{ return d.configFn() || null; }catch{ return null; } }
    function openMode(){ const cfg = readConfig(); return !!(cfg?.openAccess?.enabled === true); }
    function hookPresent(){ const p = d.providerFn(); return !!p && typeof p.token === 'function'; }
    async function hookToken(){
      const p = d.providerFn();
      if(!p || typeof p.token !== 'function') return '';
      try{
        const value = await p.token();
        const token = typeof value === 'string' && HEADER_TOKEN_RE.test(value) ? value : '';
        if(token) st.hookError = null;
        return token;
      }catch(e){
        st.hookError = { status: Number(e?.status) || 0, code: allowlistedCode(e?.code) };
        return '';
      }
    }
    async function refreshHookSession(){
      const p = d.providerFn();
      if(p && typeof p.invalidate === 'function'){ try{ p.invalidate(); }catch{} }
      const token = await hookToken();
      st.session = token ? { source: 'hook', token, apiBase: st.apiBase, author: null, expiresAt: '' } : null;
      return token;
    }
    function storedPasswordSession(){
      const data = readJson(d.ss, HOSTED_SESSION_KEY);
      if(!data || data.apiBase !== st.apiBase || !TOKEN_RE.test(data.token || '')) return null;
      if(data.expiresAt && Number.isFinite(Date.parse(data.expiresAt)) && Date.parse(data.expiresAt) <= d.nowFn()) return null;
      return { source: 'password', token: data.token, apiBase: data.apiBase, author: isObj(data.author) ? data.author : null, expiresAt: cleanStr(data.expiresAt) };
    }
    function currentToken(){ return st.session ? st.session.token : ''; }
    async function resolveSession(){
      if(openMode()) return null;
      if(!hookPresent()) return storedPasswordSession();
      const token = await hookToken();
      return token ? { source: 'hook', token, apiBase: st.apiBase, author: null, expiresAt: '' } : null;
    }
    async function mintGuestToken(){
      try{
        const data = await jsonCallOnce('/v1/ai/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: TIMEOUTS.auth });
        const token = typeof data?.guest?.token === 'string' ? data.guest.token : '';
        if(!HEADER_TOKEN_RE.test(token)) return '';
        st.session = { source: 'hook', token, apiBase: st.apiBase, author: null, expiresAt: cleanStr(data.guest.expiresAt) };
        return token;
      }catch(e){ st.hookError = e; return ''; }
    }
    async function ensureAuthToken(){
      if(st.session?.token) return st.session.token;
      if(!openMode() && !hookPresent()) return '';
      const token = await hookToken();
      if(token){ st.session = { source: 'hook', token, apiBase: st.apiBase, author: null, expiresAt: '' }; return token; }
      return openMode() && !hookPresent() && st.apiBase ? mintGuestToken() : '';
    }
    async function httpCall(path, opts = {}){
      if(!st.apiBase) throw Object.assign(new Error('missing base'), { kind: 'config' });
      const headers = Object.assign({}, opts.headers || {});
      if(opts.token) headers.Authorization = 'Bearer ' + opts.token;
      const controller = d.Abort ? new d.Abort() : null;
      const timer = controller && opts.timeout ? d.setT(() => { try{ controller.abort(); }catch{} }, opts.timeout) : null;
      try{
        return await d.fetchImpl(st.apiBase + path, {
          method: opts.method || 'GET', headers, body: opts.body,
          signal: controller ? controller.signal : undefined,
          credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'cors'
        });
      }catch(e){
        throw Object.assign(new Error('request failed'), { kind: e?.name === 'AbortError' ? 'timeout' : 'network' });
      }finally{
        if(timer !== null) d.clearT(timer);
      }
    }
    async function readJsonBody(res){
      try{ const txt = await res.text(); return txt ? JSON.parse(txt) : null; }catch{ return null; }
    }
    function errorFromResponse(res, data){
      const detail = isObj(data?.error) ? data.error : null;
      return Object.assign(new Error('http ' + res.status), {
        status: Number(res.status) || 0,
        code: detail ? allowlistedCode(detail.code) : '',
        requestId: detail ? allowlistedId(detail.requestId) : '',
        retryable: detail?.retryable === true
      });
    }
    async function jsonCallOnce(path, opts = {}){
      const res = await httpCall(path, opts);
      const data = await readJsonBody(res);
      if(!res.ok) throw errorFromResponse(res, data);
      if(!isObj(data)) throw Object.assign(new Error('unexpected response'), { kind: 'protocol' });
      return data;
    }
    async function jsonCall(path, opts = {}){
      try{ return await jsonCallOnce(path, opts); }
      catch(error){
        const retryHook = error?.status === 401 && !opts.refreshed && st.session?.source === 'hook';
        if(!retryHook) throw error;
        const token = await refreshHookSession();
        if(!token) throw error;
        return jsonCallOnce(path, Object.assign({}, opts, { token, refreshed: true }));
      }
    }
    function handleSessionEnded(error){
      if(!error || error.status !== 401) return false;
      stopPoll();
      if(st.session?.source !== 'hook') removeJson(d.ss, HOSTED_SESSION_KEY);
      st.session = null;
      st.busy = '';
      st.hostedError = openMode() ? '세션을 다시 받지 못했습니다.' : '세션이 끝났습니다. 다시 로그인하세요.';
      render();
      return true;
    }

    function applyCapabilitiesSuccess(caps){
      st.capabilities = caps;
      st.hostedGate = 'ready';
      st.model = caps.models.includes(st.model) ? st.model : defaultBlueModel(caps);
      st.effort = isLocalGeminiModel(st.model, caps)
        ? GEMINI_BLUE_EFFORT
        : (caps.efforts.includes(st.effort) ? st.effort : defaultBlueEffort(caps, st.model));
      fillHostedSelects();
      if(!caps.modelJobs || !caps.blueJobs) st.hostedStatus = '내장 BLUE 실행이 제한되어 있습니다.';
      else st.hostedStatus = (openMode() || st.session) ? '내장 BLUE 준비됨' : '로그인하면 내장 BLUE를 실행할 수 있습니다.';
    }
    function handleCapabilitiesError(error){
      if(error?.status === 401 || error?.status === 403){
        if(st.session?.source !== 'hook') removeJson(d.ss, HOSTED_SESSION_KEY);
        st.session = null;
        st.hostedGate = 'ready';
        st.hostedStatus = openMode() ? '세션을 확인하지 못했습니다.' : '로그인하면 내장 BLUE를 실행할 수 있습니다.';
        return;
      }
      st.hostedGate = 'disabled';
      st.hostedDisabledMsg = '내장 BLUE 연결 실패 · ' + describeHostedError(error, 'capabilities');
    }
    async function probeCapabilities(){
      const cfg = readConfig();
      const hosted = isObj(cfg?.hostedAi) ? cfg.hostedAi : null;
      const base = hosted?.enabled === true ? (parseBase(hosted.apiBase, true) || parseBase(cfg?.apiBase, true)) : '';
      if(!base){
        st.hostedGate = 'disabled';
        st.hostedDisabledMsg = '내장 BLUE 서비스가 설정되지 않았습니다. 내 AI를 사용하세요.';
        render();
        return;
      }
      st.apiBase = base;
      st.session = await resolveSession();
      st.hostedGate = 'checking';
      st.hostedStatus = '연결 확인 중…';
      render();
      try{
        const caps = normalizeCapabilities(await jsonCall('/v1/ai/capabilities', { token: currentToken(), timeout: TIMEOUTS.auth }));
        if(!caps?.enabled){
          st.hostedGate = 'disabled';
          st.hostedDisabledMsg = '이 배포에서는 내장 BLUE가 비활성화되어 있습니다.';
          st.capabilities = null;
        }else{
          applyCapabilitiesSuccess(caps);
        }
      }catch(error){
        handleCapabilitiesError(error);
      }
      render();
    }

    async function hostedLogin(){
      if(st.busy || st.hostedGate === 'disabled' || !st.apiBase) return;
      const username = cleanStr(nodes.loginUser?.value);
      const password = String(nodes.loginPass?.value || '');
      if(nodes.loginPass) nodes.loginPass.value = '';
      if(!username || !password){ st.hostedError = '아이디와 비밀번호를 입력하세요.'; render(); return; }
      st.busy = 'login';
      st.hostedError = '';
      st.hostedStatus = '로그인하는 중…';
      render();
      try{
        const data = await jsonCallOnce('/v1/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }), timeout: TIMEOUTS.auth
        });
        if(!TOKEN_RE.test(data.token || '')) throw Object.assign(new Error('bad token'), { kind: 'protocol' });
        st.session = { source: 'password', token: data.token, apiBase: st.apiBase, author: isObj(data.author) ? data.author : null, expiresAt: cleanStr(data.expiresAt) };
        writeJson(d.ss, HOSTED_SESSION_KEY, { apiBase: st.apiBase, token: st.session.token, author: st.session.author, expiresAt: st.session.expiresAt });
        if(nodes.loginUser) nodes.loginUser.value = '';
        st.busy = '';
        await probeCapabilities();
        await restorePendingHosted();
      }catch(error){
        st.hostedError = describeHostedError(error, 'login');
      }finally{
        if(nodes.loginPass) nodes.loginPass.value = '';
        st.busy = '';
        render();
      }
    }
    async function hostedLogout(){
      if(st.busy) return;
      const sess = st.session;
      stopPoll();
      st.busy = 'logout';
      render();
      try{ if(sess?.source !== 'hook') await httpCall('/v1/logout', { method: 'POST', token: sess.token, timeout: TIMEOUTS.auth }); }catch{}
      finally{
        if(sess?.source !== 'hook') removeJson(d.ss, HOSTED_SESSION_KEY);
        st.session = null;
        st.activeJob = null;
        st.busy = '';
        st.hostedStatus = '로그아웃했습니다.';
        render();
      }
    }

    /* ---------- durable auto-record (no fabricated provenance or silent truncation) ---------- */
    function currentRunsRaw(fileHash){
      const hash = fileHash ?? st.artifact?.sha256;
      return hash ? readMergedRuns(d.ls, hash) : [];
    }
    function currentProjectedRuns(fileHash){
      const hash = fileHash ?? st.artifact?.sha256;
      return hash ? projectRuns(readMergedRuns(d.ls, hash), hash) : [];
    }
    function notifyRunsChange(force){
      const hash = st.artifact?.sha256 || '';
      const revision = st.artifact?.revision || '';
      const runs = hash ? currentProjectedRuns(hash) : [];
      const sig = hash + '|' + revision + '|' + JSON.stringify(runs);
      if(!force && sig === st.lastEmittedSig) return;
      st.lastEmittedSig = sig;
      emitEvent('falsify:w8-runs-change', { fileHash: hash, revision, runs });
    }
    function upsertW8Run(record){
      const all = readW8Runs(d.ls);
      let idx = all.findIndex(r => r.id === record.id);
      if(idx < 0 && record.jobId) idx = all.findIndex(r => r.jobId === record.jobId && r.fileHash === record.fileHash);
      const next = all.slice();
      if(idx >= 0){
        next[idx] = Object.assign({}, next[idx], record, { id: next[idx].id, createdAt: next[idx].createdAt, updatedAt: new Date(d.nowFn()).toISOString() });
      }else{
        next.push(record);
      }
      const saved = writeW8Runs(d.ls, next);
      if(!saved.ok) throw new Error(saved.error);
      return idx >= 0 ? next[idx] : record;
    }
    async function mirrorExternalToLedger(record, art, segInfo, batch){
      const lab = d.labFn();
      const P = root.FalsifyExternalProposals;
      if(!lab || typeof lab.recordExternal !== 'function' || !P || typeof P.create !== 'function') return;
      if(!segInfo?.segments?.length || !segInfo.sourceHash) return;
      try{
        const store = P.create({ fileHash: art.sha256, role: 'blue', segments: segInfo.segments });
        store.append(batch);
        for(const item of store.snapshot().items){ try{ store.setEnabled(item.id, true); }catch{} }
        const extId = await lab.recordExternal(
          { fileHash: art.sha256, sourceHash: segInfo.sourceHash, revision: art.revision, name: art.name, segments: segInfo.segments },
          store.snapshot(), () => true
        );
        if(typeof extId === 'string' && extId) upsertW8Run(Object.assign({}, record, { externalRecordId: extId }));
      }catch{}
    }
    function buildHostedRecord(job, meta, art, findings){
      const ts = job.updatedAt || job.createdAt || new Date(d.nowFn()).toISOString();
      const isPartial = job.state === 'interrupted' || job.result?.partial === true || job.result?.coverage?.complete === false;
      return {
        id: 'hosted-' + job.id,
        fileHash: art.sha256,
        revision: art.revision,
        fileName: art.name,
        detector: DETECTOR_HOSTED,
        sourceKind: 'hosted',
        jobId: job.id,
        requestId: 'hosted:' + job.id,
        model: cleanModel(job.model || meta.model),
        effort: cleanStr(job.effort || meta.effort, 16),
        condition: cleanStr(meta.condition, 160),
        promptLabel: cleanStr(meta.promptLabel, 160),
        privatePrompt: meta.privatePrompt === true,
        status: job.state === 'interrupted' ? 'interrupted' : (cleanStr(job.result?.status, 32) || 'ok'),
        partial: isPartial,
        coverage: isObj(job.result?.coverage) ? clone(job.result.coverage) : null,
        createdAt: job.createdAt || ts,
        updatedAt: ts,
        findings
      };
    }
    async function persistHostedBlueResult(job, meta){
      const fileHash = meta.fileHash;
      if(!HEX_64.test(fileHash || '') || !hasValidHostedFindings(job)) return null;
      const art = st.artifact?.sha256 === fileHash
        ? st.artifact
        : { file: null, sha256: fileHash, revision: meta.revision || ('rev-' + fileHash.slice(0, 12)), name: meta.fileName || 'hosted.pdf' };
      const segInfo = await ensureSegments(art);
      const findings = job.result.findings.map((f, i) => normalizeHostedFinding(f, i, segInfo.segments));
      const saved = upsertW8Run(buildHostedRecord(job, meta, art, findings));
      if(st.artifact?.sha256 === fileHash) notifyRunsChange(true);
      return saved;
    }

    /* ---------- hosted upload, submit, poll, cancel, pending resume ---------- */
    function readCachedUpload(fileHash){
      if(st.uploadByHash.has(fileHash)) return st.uploadByHash.get(fileHash);
      const stored = readJson(d.ss, HOSTED_UPLOAD_KEY);
      if(stored?.apiBase === st.apiBase && stored.sha256 === fileHash && stored.id){
        st.uploadByHash.set(fileHash, stored);
        return stored;
      }
      return null;
    }
    async function readVerifiedPdfBytes(art){
      if(!art.file || typeof art.file.arrayBuffer !== 'function'){
        throw Object.assign(new Error('검수할 PDF 파일이 준비되지 않았습니다.'), { kind: 'local' });
      }
      const limit = st.capabilities?.maxUploadBytes || MAX_UPLOAD_FALLBACK;
      if(Number(art.file.size) > limit) throw Object.assign(new Error('PDF가 서버 한도(' + sizeLabel(limit) + ')를 넘습니다.'), { kind: 'local' });
      const bytes = new Uint8Array(await art.file.arrayBuffer());
      if(!bytes.byteLength || bytes.byteLength > limit) throw Object.assign(new Error('PDF 크기를 확인하세요.'), { kind: 'local' });
      if(!isPdfBytes(bytes)) throw Object.assign(new Error('내장 BLUE는 PDF 파일만 지원합니다.'), { kind: 'local' });
      if(await sha256Hex(bytes, d.cryptoApi) !== art.sha256){
        throw Object.assign(new Error('PDF 해시가 현재 버전과 다릅니다.'), { kind: 'local' });
      }
      return bytes;
    }
    async function ensureHostedUpload(art){
      const cached = readCachedUpload(art.sha256);
      if(cached) return cached;
      const bytes = await readVerifiedPdfBytes(art);
      const data = await jsonCall('/v1/ai/uploads', {
        method: 'POST', token: currentToken(), body: bytes, timeout: TIMEOUTS.upload,
        headers: { 'Content-Type': 'application/pdf', 'X-Falsify-File-Name': encodeURIComponent(art.name) }
      });
      const upload = isObj(data.upload) && typeof data.upload.id === 'string' ? data.upload : null;
      if(!upload || upload.sha256 !== art.sha256) throw Object.assign(new Error('업로드 해시 불일치'), { kind: 'protocol' });
      const desc = {
        id: upload.id, sha256: upload.sha256, apiBase: st.apiBase,
        name: safeName(upload.name) || art.name, mime: 'application/pdf',
        bytes: positiveInt(upload.bytes) || bytes.byteLength, deduplicated: upload.deduplicated === true
      };
      st.uploadByHash.set(art.sha256, desc);
      writeJson(d.ss, HOSTED_UPLOAD_KEY, desc);
      return desc;
    }

    function upsertPending(entry){
      const list = readPendingJobs(d.ls);
      const idx = list.findIndex(x => x.id === entry.id || (entry.jobId && x.jobId === entry.jobId));
      const next = list.slice();
      if(idx >= 0) next[idx] = Object.assign({}, next[idx], entry, { updatedAt: new Date(d.nowFn()).toISOString() });
      else next.push(entry);
      writePendingJobs(d.ls, next);
      return idx >= 0 ? next[idx] : entry;
    }
    function dropPending(entryId, jobId){
      const list = readPendingJobs(d.ls).filter(x => x.id !== entryId && (!jobId || x.jobId !== jobId));
      writePendingJobs(d.ls, list);
      if(st.activePending && (st.activePending.id === entryId || (jobId && st.activePending.jobId === jobId))){
        st.activePending = null;
      }
    }
    function pendingForCurrent(){
      const hash = st.artifact?.sha256;
      if(!hash) return null;
      return readPendingJobs(d.ls).filter(j => j.fileHash === hash && (!st.apiBase || j.apiBase === st.apiBase)).at(-1) || null;
    }
    function fallbackJobMeta(job){
      return {
        id: 'pend-' + job.id,
        fileHash: st.artifact?.sha256 || '',
        revision: st.artifact?.revision || '',
        fileName: st.artifact?.name || 'hosted.pdf',
        model: job.model || st.model,
        effort: job.effort || st.effort,
        condition: st.condition,
        promptLabel: st.promptLabel,
        privatePrompt: st.privatePrompt
      };
    }
    async function settleTerminalHostedJob(job, meta){
      stopPoll();
      stopClock();
      st.jobStartedAt = 0;
      if(job.state === 'failed'){
        st.lastTerminalState = 'failed';
        st.hostedStatus = '';
        const code = allowlistedCode(job.failure?.code);
        st.hostedError = '내장 BLUE 실패' + (code && FAILURE_LABELS[code] ? ': ' + FAILURE_LABELS[code] : '');
      }else if(job.state === 'cancelled'){
        st.lastTerminalState = 'cancelled';
        st.hostedStatus = '내장 BLUE 실행이 취소되었습니다.';
      }else if(!hasValidHostedFindings(job)){
        st.lastTerminalState = 'failed';
        st.hostedStatus = '';
        st.hostedError = '결과 형식이 올바르지 않아 기록하지 않았습니다.';
      }else{
        st.lastTerminalState = '';
        try{
          const saved = await persistHostedBlueResult(job, meta);
          const count = saved ? saved.findings.length : 0;
          if(saved && st.artifact?.sha256 === saved.fileHash && st.filterRunId !== 'all') st.filterRunId = saved.id;
          st.hostedStatus = job.state === 'interrupted'
            ? '중단된 부분 결과를 기록했습니다 · 지적 ' + count + '건'
            : '내장 BLUE 완료 · 지적 ' + count + '건 자동 기록됨';
        }catch(e){
          st.hostedError = e?.message || '결과를 저장하지 못했습니다.';
        }
      }
      dropPending(meta.id, job.id);
    }
    function handlePollError(error, jobId, pendingMeta){
      if(handleSessionEnded(error)) return;
      st.pollFailures++;
      if(error?.status === 404){
        stopPoll();
        st.activeJob = null;
        if(pendingMeta) dropPending(pendingMeta.id, jobId);
        st.hostedError = '서버에서 해당 작업을 찾지 못했습니다.';
      }else if(st.pollFailures >= MAX_POLL_FAILURES){
        stopPoll();
        st.hostedError = '상태를 확인하지 못했습니다. 「상태 새로고침」을 누르세요.';
      }else if(st.activeJob && !TERMINAL_STATES.includes(st.activeJob.state)){
        schedulePoll(jobId, pendingMeta || st.activePending);
        st.hostedStatus = '연결을 다시 확인하는 중…';
      }
    }
    async function refreshHostedJob(jobId, pendingMeta, opts = {}){
      if(!jobId || !(await ensureAuthToken())) return;
      const poll = opts.poll === true;
      if(!poll){ st.busy = 'refresh'; st.hostedError = ''; render(); }
      try{
        const data = await jsonCall('/v1/ai/jobs/' + encodeURIComponent(jobId), { token: currentToken(), timeout: TIMEOUTS.job });
        const job = isObj(data.job) && typeof data.job.id === 'string' ? data.job : null;
        if(!job) throw Object.assign(new Error('bad job'), { kind: 'protocol' });
        st.pollFailures = 0;
        st.activeJob = job;
        const meta = pendingMeta || st.activePending || fallbackJobMeta(job);
        if(TERMINAL_STATES.includes(job.state)){
          await settleTerminalHostedJob(job, meta);
        }else{
          st.activePending = upsertPending(Object.assign({}, meta, { apiBase: st.apiBase, jobId: job.id, state: job.state, model: job.model || meta.model, effort: job.effort || meta.effort }));
          st.hostedStatus = formatJobProgress(job);
          schedulePoll(job.id, st.activePending);
        }
      }catch(error){
        handlePollError(error, jobId, pendingMeta);
      }finally{
        if(!poll) st.busy = '';
        render();
      }
    }
    function schedulePoll(jobId, meta){
      if(st.pollTimer !== null || st.destroyed) return;
      const delay = POLL_DELAYS[Math.min(st.pollAttempt, POLL_DELAYS.length - 1)];
      st.pollAttempt++;
      st.pollTimer = later(() => {
        st.pollTimer = null;
        if(jobId && !st.destroyed) void refreshHostedJob(jobId, meta, { poll: true });
      }, delay);
    }

    function validateHostedLaunch(art){
      if(!st.capabilities?.modelJobs || !st.capabilities?.blueJobs) return '이 화면에서는 내장 BLUE를 실행할 수 없습니다.';
      if(st.activeJob && !TERMINAL_STATES.includes(st.activeJob.state)) return '이미 실행 중인 내장 BLUE 작업이 있습니다.';
      if(!art) return '검수할 PDF를 먼저 열어 주세요.';
      const prompt = String(st.promptText || '').normalize('NFC').trim();
      const maxPrompt = st.capabilities.maxPromptChars || MAX_PROMPT_FALLBACK;
      if(!prompt) return '검수 지시문이 비어 있습니다.';
      if(codePoints(prompt) > maxPrompt) return '검수 지시문이 서버 한도(' + maxPrompt + '자)를 넘습니다.';
      if(st.maxCalls !== ''){
        const n = Number(st.maxCalls);
        if(!Number.isInteger(n) || n < 1 || n > 32) return '최대 호출 수는 1–32 사이 정수여야 합니다.';
      }
      return '';
    }
    function effectiveHostedEffort(){
      return isLocalGeminiModel(st.model, st.capabilities) ? GEMINI_BLUE_EFFORT : st.effort;
    }
    function buildHostedJobBody(prompt, uploadId, idempotencyKey){
      // Strict RED/BLUE separation: only allowlisted BLUE fields enter /v1/ai/jobs.
      const body = { role: 'blue', prompt, uploadId, idempotencyKey, useEvidence: st.useEvidence === true };
      if(st.model) body.model = st.model;
      const effort = effectiveHostedEffort();
      if(effort) body.effort = effort;
      if(st.maxCalls !== '') body.budget = { maxCalls: Number(st.maxCalls) };
      return body;
    }
    async function prepareHostedPending(art, reusePending){
      const upload = reusePending?.uploadId && reusePending.fileHash === art.sha256
        ? { id: reusePending.uploadId, sha256: art.sha256 }
        : await ensureHostedUpload(art);
      const key = reusePending?.idempotencyKey
        || ('w8blue-' + (await digestText(art.sha256 + '\n' + makeId('run', d.cryptoApi) + '\n' + d.nowFn(), d.cryptoApi, d.Encoder)).slice(0, 40));
      const nowIso = new Date(d.nowFn()).toISOString();
      const pending = upsertPending({
        id: reusePending?.id || makeId('pend', d.cryptoApi),
        apiBase: st.apiBase, fileHash: art.sha256, revision: art.revision, fileName: art.name,
        uploadId: upload.id, idempotencyKey: key, jobId: reusePending?.jobId || '', state: 'submitting',
        model: st.model, effort: effectiveHostedEffort(), condition: cleanStr(st.condition, 160),
        promptLabel: st.promptLabel, privatePrompt: st.privatePrompt, useEvidence: st.useEvidence === true,
        createdAt: reusePending?.createdAt || nowIso, updatedAt: nowIso
      });
      st.activePending = pending;
      return { upload, key, pending };
    }
    async function handleHostedSubmitResponse(data, pending){
      const job = isObj(data.job) && typeof data.job.id === 'string' ? data.job : null;
      if(!job) throw Object.assign(new Error('bad job'), { kind: 'protocol' });
      st.activeJob = job;
      st.busy = '';
      if(TERMINAL_STATES.includes(job.state)){
        await settleTerminalHostedJob(job, pending);
        return;
      }
      st.activePending = upsertPending(Object.assign({}, pending, { jobId: job.id, state: job.state, model: job.model || pending.model, effort: job.effort || pending.effort }));
      st.hostedStatus = data.replayed ? '기존 내장 BLUE 작업을 이어서 확인합니다.' : '내장 BLUE 검수를 시작했습니다.';
      schedulePoll(job.id, st.activePending);
    }
    async function startHostedBlue(reusePending){
      if(st.busy || st.hostedGate !== 'ready') return;
      if(!(await ensureAuthToken())){
        st.hostedError = openMode() ? '게스트 세션을 얻지 못했습니다.' : '먼저 로그인하세요.';
        render();
        return;
      }
      const art = await resolveArtifact();
      if(art){ st.artifact = art; st.artifactStale = false; }
      const problem = validateHostedLaunch(art);
      if(problem){ st.hostedError = problem; render(); return; }
      st.busy = 'submit'; st.hostedError = ''; st.lastTerminalState = ''; st.jobStartedAt = d.nowFn(); st.hostedStatus = 'PDF 업로드 확인 중…'; render();
      let pending = reusePending || null;
      try{
        const prep = await prepareHostedPending(art, reusePending);
        pending = prep.pending;
        const prompt = String(st.promptText || '').normalize('NFC').trim();
        st.hostedStatus = '내장 BLUE 작업 접수 중…'; render();
        const data = await jsonCall('/v1/ai/jobs', {
          method: 'POST', token: currentToken(), headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildHostedJobBody(prompt, prep.upload.id, prep.key)), timeout: TIMEOUTS.job
        });
        await handleHostedSubmitResponse(data, pending);
      }catch(error){
        stopClock();
        st.jobStartedAt = 0;
        if(handleSessionEnded(error)) return;
        if(error?.kind === 'network' || error?.kind === 'timeout'){
          st.hostedStatus = '';
          st.hostedError = '접수 응답을 확인하지 못했습니다. 같은 요청 키로 다시 확인할 수 있습니다.';
        }else{
          st.lastTerminalState = 'failed';
          st.hostedStatus = '';
          if(pending && !pending.jobId) dropPending(pending.id);
          st.hostedError = describeHostedError(error, 'submit');
        }
      }finally{
        st.busy = ''; render();
      }
    }

    async function cancelHostedBlue(){
      if(st.busy || !st.activeJob || TERMINAL_STATES.includes(st.activeJob.state)) return;
      if(!(await ensureAuthToken())) return;
      st.busy = 'cancel'; st.hostedError = ''; render();
      try{
        const data = await jsonCall('/v1/ai/jobs/' + encodeURIComponent(st.activeJob.id) + '/cancel', { method: 'POST', token: currentToken(), timeout: TIMEOUTS.cancel });
        if(isObj(data.job) && data.job.id){
          st.activeJob = data.job;
          if(TERMINAL_STATES.includes(data.job.state)){
            stopPoll();
            stopClock();
            st.jobStartedAt = 0;
            st.lastTerminalState = data.job.state === 'failed' ? 'failed' : 'cancelled';
            if(st.activePending) dropPending(st.activePending.id, data.job.id);
            st.hostedStatus = '내장 BLUE 실행을 취소했습니다.';
          }else{
            st.hostedStatus = '취소를 요청했습니다.';
            schedulePoll(data.job.id, st.activePending);
          }
        }
      }catch(error){
        if(!handleSessionEnded(error)) st.hostedError = describeHostedError(error, 'cancel');
      }finally{
        st.busy = ''; render();
      }
    }

    function legacyHostedPending(hash){
      if(!hash) return null;
      const hostedRuns = readJson(d.ss, HOSTED_RUNS_KEY);
      const entries = isObj(hostedRuns?.runs) ? Object.values(hostedRuns.runs) : [];
      const m = entries.find(e => e?.role === 'blue' && e.sha256 === hash && e.apiBase === st.apiBase && e.jobId);
      if(!m || readW8Runs(d.ls).some(r => r.jobId === m.jobId && r.fileHash === hash)) return null;
      return {
        id: 'hosted-legacy-' + m.jobId, apiBase: st.apiBase, fileHash: hash,
        revision: st.artifact?.revision || '', fileName: st.artifact?.name || 'hosted.pdf',
        uploadId: m.uploadId || '', idempotencyKey: m.key || '', jobId: m.jobId, state: 'running',
        model: m.model || '', effort: m.effort || '', condition: '', promptLabel: '내장 BLUE', privatePrompt: false,
        createdAt: m.updatedAt || new Date(d.nowFn()).toISOString()
      };
    }
    async function restorePendingHosted(){
      if(st.hostedGate !== 'ready' || !st.apiBase) return;
      const pending = pendingForCurrent() || legacyHostedPending(st.artifact?.sha256 || '');
      st.activePending = pending;
      if(!pending) return;
      if(!pending.jobId){
        st.hostedStatus = '이전 접수 상태가 확인되지 않았습니다. 같은 요청 키로 확인할 수 있습니다.';
        render();
        return;
      }
      if(!st.session && !openMode()){
        st.hostedStatus = '진행 중이던 내장 BLUE 작업이 있습니다. 로그인하면 이어서 확인합니다.';
        render();
        return;
      }
      st.hostedStatus = '진행 중이던 내장 BLUE 작업을 이어서 확인합니다…';
      render();
      await refreshHostedJob(pending.jobId, pending, { poll: true });
    }

    /* ---------- external AI import & durable dedupe across reload ---------- */
    function parseExternalBatch(raw, art, segInfo, modelInput, conditionInput){
      const X = d.exchangeFn();
      if(X && typeof X.parse === 'function'){
        return X.parse(raw, {
          role: 'blue', fileHash: art.sha256, sourceHash: segInfo.sourceHash || undefined,
          segments: segInfo.segments, model: modelInput || undefined, condition: conditionInput || undefined,
          prompt: st.privatePrompt ? undefined : cleanStr(st.promptText) || undefined
        });
      }
      const parsed = parseJsonBlock(raw);
      const items = Array.isArray(parsed?.findings) ? parsed.findings : (Array.isArray(parsed) ? parsed : (parsed ? [] : [{ rationale: raw.trim(), matchStatus: 'missing' }]));
      return {
        schema: 'falsify.external-batch.v1', id: makeId('ext', d.cryptoApi), role: 'blue',
        fileHash: art.sha256, raw, model: modelInput || parsed?.model, condition: conditionInput || parsed?.condition,
        importedAt: new Date(d.nowFn()).toISOString(), status: items.length || isExplicitZeroFindingResponse(raw) ? 'ok' : 'unparsed',
        items, diagnostics: []
      };
    }
    function validateExternalBatch(batch, raw){
      if(batch.diagnostics?.some(diag => diag.code === 'role-mismatch')) return 'RED 역할 응답입니다. BLUE 검수 응답을 넣어 주세요.';
      if(batch.diagnostics?.some(diag => diag.code === 'input-limit')) return '응답 길이가 한도를 넘어 가져오지 않았습니다.';
      if(!batch.items?.length && !isExplicitZeroFindingResponse(raw)){
        return '지적 항목이나 정상 무결함 응답을 찾지 못해 기록하지 않았습니다.';
      }
      return '';
    }
    function buildExternalRecord(art, batch, segInfo, meta){
      const nowIso = new Date(d.nowFn()).toISOString();
      const zero = !batch.items.length && isExplicitZeroFindingResponse(meta.raw);
      const parsed = parseJsonBlock(meta.raw);
      return {
        id: makeId('ext', d.cryptoApi),
        fileHash: art.sha256,
        revision: art.revision,
        fileName: art.name,
        detector: DETECTOR_EXTERNAL,
        sourceKind: 'external',
        importFingerprint: meta.fingerprint,
        model: cleanModel(meta.modelInput || batch.model),
        condition: cleanStr(meta.conditionInput || batch.condition, 160),
        promptLabel: st.promptLabel,
        privatePrompt: st.privatePrompt,
        partial: parsed?.partial === true || parsed?.coverage?.complete === false,
        status: cleanStr(parsed?.status, 32) || (zero ? 'ok' : (cleanStr(batch.status, 32) || 'ok')),
        report: cleanStr(batch.report),
        zeroDropSummary: batch.zeroDropSummary ? clone(batch.zeroDropSummary) : null,
        diagnostics: Array.isArray(batch.diagnostics) ? clone(batch.diagnostics) : [],
        createdAt: nowIso,
        updatedAt: nowIso,
        findings: (batch.items || []).map((item, idx) => normalizeExternalFinding(item, idx, segInfo.segments))
      };
    }
    function externalSummaryLine(saved, batch){
      const unmatched = saved.findings.filter(f => f.pageIndex === null).length;
      const diag = (batch.diagnostics || []).map(x => x.message).filter(Boolean).join(' ');
      const base = saved.findings.length === 0
        ? '기록됨 · 지적 0건'
        : '기록됨 · 지적 ' + saved.findings.length + '건' + (unmatched ? ' (위치 미지정 ' + unmatched + '건)' : '');
      return diag ? base + ' · ' + diag : base;
    }
    function focusImportedResult(){
      const scrollEl = nodes.ticketSection && !nodes.ticketSection.hidden ? nodes.ticket : nodes.resultsSummary;
      const focusEl = nodes.verdictTitle && !nodes.verdictBox?.hidden ? nodes.verdictTitle : (nodes.ticket && !nodes.ticketSection?.hidden ? nodes.ticket : null);
      if(scrollEl && typeof scrollEl.scrollIntoView === 'function'){
        try{ scrollEl.scrollIntoView({ block: 'start' }); }catch{}
      }
      if(focusEl && typeof focusEl.focus === 'function'){
        try{ focusEl.focus({ preventScroll: true }); }catch{ try{ focusEl.focus(); }catch{} }
      }
    }
    async function importExternalText(rawText, opts = {}){
      const raw = typeof rawText === 'string' ? rawText : '';
      if(!raw.trim()){ st.externalError = 'AI 응답을 붙여넣거나 파일을 선택하세요.'; render(); return null; }
      const art = await resolveArtifact();
      if(!art){ st.externalError = '검수할 PDF를 먼저 열어 주세요.'; render(); return null; }
      st.artifact = art;
      st.artifactStale = false;
      const modelInput = cleanModel(opts.model !== undefined ? opts.model : st.externalModel);
      const conditionInput = cleanStr(opts.condition !== undefined ? opts.condition : st.condition, 160);
      const fingerprint = await digestText(art.sha256 + '\n' + modelInput + '\n' + conditionInput + '\n' + raw, d.cryptoApi, d.Encoder);
      const existingList = currentRunsRaw(art.sha256);
      const dupIdx = existingList.findIndex(r => r.importFingerprint && r.importFingerprint === fingerprint);
      if(dupIdx >= 0 && opts.forceNewRun !== true){
        st.duplicateDraft = { raw, model: modelInput, condition: conditionInput };
        st.filterRunId = existingList[dupIdx].id;
        st.externalError = '';
        st.externalStatus = '이미 기록된 동일한 응답(#' + (dupIdx + 1) + ')을 열었습니다.';
        render();
        focusImportedResult();
        return existingList[dupIdx];
      }
      st.duplicateDraft = null;
      const segInfo = await ensureSegments(art);
      const batch = parseExternalBatch(raw, art, segInfo, modelInput, conditionInput);
      const invalid = validateExternalBatch(batch, raw);
      if(invalid){ st.externalError = invalid; render(); return null; }
      try{
        const saved = upsertW8Run(buildExternalRecord(art, batch, segInfo, { raw, fingerprint, modelInput, conditionInput }));
        st.lastTerminalState = '';
        st.externalError = '';
        st.externalStatus = externalSummaryLine(saved, batch);
        if(st.filterRunId !== 'all') st.filterRunId = saved.id;
        if(nodes.externalAnswer) nodes.externalAnswer.value = '';
        if(nodes.externalFile) nodes.externalFile.value = '';
        notifyRunsChange(true);
        render();
        focusImportedResult();
        void mirrorExternalToLedger(saved, art, segInfo, batch);
        return saved;
      }catch(e){
        st.externalError = e?.message || '저장하지 못했습니다.';
        render();
        return null;
      }
    }

    /* ---------- post-record edits ---------- */
    function ensureMutableRun(runId){
      const all = readW8Runs(d.ls);
      const idx = all.findIndex(r => r.id === runId);
      if(idx >= 0) return { all, idx };
      const legacy = currentRunsRaw().find(r => r.id === runId);
      if(!legacy) return null;
      all.push(Object.assign({}, clone(legacy), { readOnlyLegacy: false, updatedAt: new Date(d.nowFn()).toISOString() }));
      return { all, idx: all.length - 1 };
    }
    function updateRunMeta(runId, patch){
      const found = ensureMutableRun(runId);
      if(!found) return false;
      const rec = Object.assign({}, found.all[found.idx]);
      if(Object.hasOwn(patch, 'model')) rec.model = cleanModel(patch.model);
      if(Object.hasOwn(patch, 'condition')) rec.condition = cleanStr(patch.condition, 160);
      rec.updatedAt = new Date(d.nowFn()).toISOString();
      found.all[found.idx] = rec;
      const saved = writeW8Runs(d.ls, found.all);
      if(!saved.ok){ st.externalError = saved.error; render(); return false; }
      notifyRunsChange(true);
      render();
      return true;
    }
    function updateFindingLocation(runId, findingIndex, patch){
      const found = ensureMutableRun(runId);
      if(!found) return false;
      const rec = clone(found.all[found.idx]);
      const f = Array.isArray(rec.findings) ? rec.findings[findingIndex] : null;
      if(!f) return false;
      if(Object.hasOwn(patch, 'pageIndex')) f.pageIndex = Number.isInteger(patch.pageIndex) && patch.pageIndex >= 0 ? patch.pageIndex : null;
      if(Object.hasOwn(patch, 'locationLabel')) f.locationLabel = cleanStr(patch.locationLabel, 240);
      if(Object.hasOwn(patch, 'segmentId')) f.segmentId = cleanStr(patch.segmentId) || null;
      f.matchStatus = f.pageIndex !== null ? 'manual' : 'missing';
      rec.updatedAt = new Date(d.nowFn()).toISOString();
      found.all[found.idx] = rec;
      const saved = writeW8Runs(d.ls, found.all);
      if(!saved.ok){ st.externalError = saved.error; render(); return false; }
      notifyRunsChange(true);
      render();
      return true;
    }
    function deleteRun(runId){
      const all = readW8Runs(d.ls);
      const next = all.filter(r => r.id !== runId);
      if(next.length === all.length) return false;
      writeW8Runs(d.ls, next);
      if(st.filterRunId === runId) st.filterRunId = 'all';
      notifyRunsChange(true);
      render();
      return true;
    }

    /* ---------- clipboard & PDF download ---------- */
    function isCopyStale(myCopyEpoch, myArtEpoch){
      return st.destroyed || myCopyEpoch !== st.copyEpoch || myArtEpoch !== st.artifactEpoch;
    }
    function applyFreshArtifact(nextArt){
      const changed = nextArt?.sha256 !== st.artifact?.sha256;
      st.artifact = nextArt;
      st.artifactStale = false;
      if(changed){
        resetForNewArtifact(nextArt, true);
        notifyRunsChange(true);
      }
      return changed;
    }
    function ensureArtifactLink(links, art){
      const archive = d.archiveFn();
      return archive?.revision ? archive.revision(art) : links.ensure(art.file, art.sha256);
    }
    function availableLink(url){ return archiveSharingAllowed() ? url : ''; }
    async function resolveExternalLink(art, myCopyEpoch, myArtEpoch){
      const links = d.paperLinksFn();
      if(!art?.sha256 || !archiveSharingAllowed()) return { url: '', failed: false, stale: false };
      const existing = currentArtifactLink(art);
      if(existing) return { url: existing, failed: false, stale: false };
      if(!art.file || typeof links?.ensure !== 'function') return { url: '', failed: false, stale: false };
      st.copyingLink = true;
      st.copyStatus = 'PDF 링크를 준비하는 중…';
      renderExternalControls();
      let linkUrl = '';
      let failed = false;
      try{
        const ensured = cleanStr(await ensureArtifactLink(links, art), 2048);
        linkUrl = isSafeHttpUrl(ensured) ? ensured : '';
        if(!linkUrl) failed = true;
      }catch{
        failed = true;
        linkUrl = '';
      }finally{
        if(myCopyEpoch === st.copyEpoch) st.copyingLink = false;
      }
      if(isCopyStale(myCopyEpoch, myArtEpoch)) return { url: '', failed, stale: true };
      const latest = await resolveArtifact();
      if(isCopyStale(myCopyEpoch, myArtEpoch)) return { url: '', failed, stale: true };
      if(!latest || latest.sha256 !== art.sha256){
        applyFreshArtifact(latest);
        render();
        return { url: '', failed, stale: true };
      }
      return { url: availableLink(linkUrl), failed, stale: false };
    }
    function copyFeedback(copied, linkUrl, linkFailed){
      if(linkUrl){
        return copied
          ? '지시문과 PDF 링크를 복사했습니다. 내 AI에 붙여 넣으세요.'
          : 'PDF 링크가 포함된 지시문을 아래 상자에서 직접 복사하세요.';
      }
      if(linkFailed){
        return copied
          ? 'PDF 링크를 만들지 못해 파일 첨부 안내로 지시문을 복사했습니다. PDF를 첨부하고 붙여 넣으세요.'
          : 'PDF 링크를 만들지 못했습니다. 아래 상자에서 지시문을 직접 복사하고 PDF를 첨부하세요.';
      }
      return copied
        ? '지시문을 복사했습니다. PDF를 첨부하고 붙여 넣으세요.'
        : '아래 상자에서 지시문을 직접 복사하세요.';
    }
    async function copyInstructions(){
      const myCopyEpoch = ++st.copyEpoch;
      const myArtEpoch = st.artifactEpoch;
      const art = await resolveArtifact();
      if(isCopyStale(myCopyEpoch, myArtEpoch)) return;
      if(!art){
        st.artifact = null;
        st.artifactStale = false;
        st.copyStatus = '검수할 PDF를 먼저 열어 주세요.';
        render();
        return;
      }
      applyFreshArtifact(art);
      const linkResult = await resolveExternalLink(art, myCopyEpoch, myArtEpoch);
      if(linkResult.stale || isCopyStale(myCopyEpoch, myArtEpoch)) return;
      const text = buildExternalCopyPrompt(art, linkResult.url);
      const clip = root.navigator?.clipboard;
      if(clip && typeof clip.writeText === 'function'){
        try{
          await clip.writeText(text);
          if(isCopyStale(myCopyEpoch, myArtEpoch)) return;
          if(nodes.copyFallback){ nodes.copyFallback.value = ''; nodes.copyFallback.hidden = true; }
          st.copyStatus = copyFeedback(true, linkResult.url, linkResult.failed);
          render();
          return;
        }catch{}
      }
      if(isCopyStale(myCopyEpoch, myArtEpoch)) return;
      if(nodes.copyFallback){
        nodes.copyFallback.value = text;
        nodes.copyFallback.hidden = false;
        nodes.copyFallback.focus?.();
        nodes.copyFallback.select?.();
      }
      st.copyStatus = copyFeedback(false, linkResult.url, linkResult.failed);
      render();
    }
    async function downloadCurrentPdf(){
      const art = st.artifact;
      if(!art?.file || typeof art.file.arrayBuffer !== 'function') return;
      try{
        const bytes = await art.file.arrayBuffer();
        const href = d.UrlApi.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        createEl(d.doc, 'a', { href, download: art.name || 'paper.pdf', rel: 'noopener', hidden: true }).click();
        later(() => { try{ d.UrlApi.revokeObjectURL(href); }catch{} }, 15000);
      }catch{}
    }
    function locateFinding(f){
      const detail = {
        quote: f.quote || '',
        page: Number.isInteger(f.pageIndex) ? f.pageIndex + 1 : undefined,
        pageIndex: f.pageIndex,
        label: f.locationLabel || ''
      };
      emitEvent('falsify:blue-locate', detail);
      if(typeof options.onLocate === 'function'){ try{ options.onLocate(detail); }catch{} }
    }

    /* ---------- UI rendering ---------- */
    function modelOptionLabel(model, caps){
      return caps?.blueDefaultModel && model === caps.blueDefaultModel ? model + ' (기본)' : model;
    }
    function fillGroupedModels(select, caps){
      const placed = new Set();
      for(const prov of PROVIDER_GROUP_ORDER){
        const members = caps.models.filter(m => caps.modelProviders[m] === prov);
        if(!members.length) continue;
        const group = createEl(d.doc, 'optgroup', { label: PROVIDER_LABELS[prov] || prov });
        for(const m of members){ group.append(createEl(d.doc, 'option', { value: m, textContent: modelOptionLabel(m, caps) })); placed.add(m); }
        select.append(group);
      }
      for(const m of caps.models.filter(x => !placed.has(x))) select.append(createEl(d.doc, 'option', { value: m, textContent: modelOptionLabel(m, caps) }));
    }
    function fillFlatOptions(select, values, emptyLabel, labelFn){
      if(!values.length){ select.append(createEl(d.doc, 'option', { value: '', textContent: emptyLabel })); return; }
      for(const v of values) select.append(createEl(d.doc, 'option', { value: v, textContent: labelFn ? labelFn(v) : v }));
    }
    function syncHostedEffortSelect(){
      if(!nodes.hostedEffort || !st.capabilities) return;
      clearNode(nodes.hostedEffort);
      if(isLocalGeminiModel(st.model, st.capabilities)){
        st.effort = GEMINI_BLUE_EFFORT;
        nodes.hostedEffort.append(createEl(d.doc, 'option', { value: GEMINI_BLUE_EFFORT, textContent: GEMINI_BLUE_EFFORT + ' (고정)' }));
        nodes.hostedEffort.value = GEMINI_BLUE_EFFORT;
        nodes.hostedEffort.disabled = true;
        return;
      }
      fillFlatOptions(nodes.hostedEffort, st.capabilities.efforts, '서버 기본 강도');
      if(!st.capabilities.efforts.includes(st.effort)) st.effort = defaultBlueEffort(st.capabilities, st.model);
      nodes.hostedEffort.value = st.effort || '';
      nodes.hostedEffort.disabled = !st.capabilities.efforts.length;
    }
    function fillHostedSelects(){
      if(!nodes.hostedModel || !nodes.hostedEffort || !st.capabilities) return;
      clearNode(nodes.hostedModel);
      if(st.capabilities.models.length && st.capabilities.modelProviders) fillGroupedModels(nodes.hostedModel, st.capabilities);
      else fillFlatOptions(nodes.hostedModel, st.capabilities.models, '서버 기본 모델', m => modelOptionLabel(m, st.capabilities));
      nodes.hostedModel.value = st.model || '';
      syncHostedEffortSelect();
    }
    function appendOptionGroup(select, label, items, mapItem){
      if(!items.length) return;
      const g = createEl(d.doc, 'optgroup', { label });
      for(const item of items){
        const opt = mapItem(item);
        g.append(createEl(d.doc, 'option', { value: opt.value, textContent: opt.text }));
      }
      select.append(g);
    }
    function renderPromptOptions(){
      if(!nodes.promptSelect) return;
      clearNode(nodes.promptSelect);
      nodes.promptSelect.append(
        createEl(d.doc, 'option', { value: 'preset:p0', textContent: '기본 BLUE (P0 · 맹검 2단계)' }),
        createEl(d.doc, 'option', { value: 'preset:p2', textContent: '교차 검증 BLUE (P2 · 표·그림 근거)' })
      );
      if(st.teamPromptFile){
        nodes.promptSelect.append(createEl(d.doc, 'option', { value: 'team-file', textContent: 'W8 팀 프롬프트 · ' + st.teamPromptFile.name }));
      }
      appendOptionGroup(nodes.promptSelect, '저장한 BLUE 지시문', st.savedPrompts, v => ({ value: 'saved:' + v.id, text: v.name || '저장 지시문' }));
      appendOptionGroup(nodes.promptSelect, '공유 BLUE 지시문', st.sharedPrompts, h => ({ value: 'shared:' + h.hash, text: h.name + (h.version ? ' · v' + h.version : '') }));
      nodes.promptSelect.value = st.promptSource;
    }

    function buildPromptDetails(){
      nodes.promptSelect = createEl(d.doc, 'select', { id: 'w8-blue-prompt-select', 'aria-label': '검수 지시문 선택' });
      nodes.promptSelect.addEventListener('change', () => applyPromptSelection(nodes.promptSelect.value));
      nodes.conditionInput = createEl(d.doc, 'input', { id: 'w8-blue-condition', type: 'text', maxLength: 160, placeholder: '예: P0, W8-v6', 'aria-label': '실행 조건' });
      nodes.conditionInput.addEventListener('input', () => { st.condition = nodes.conditionInput.value; });
      nodes.teamPromptLink = createEl(d.doc, 'a', {
        id: 'w8-blue-team-prompt-link',
        className: 'text-link',
        href: W8_TEAM_PROMPT_URL,
        target: '_blank',
        rel: 'noopener noreferrer',
        textContent: W8_TEAM_PROMPT_LINK_TEXT
      });
      nodes.teamPromptFile = createEl(d.doc, 'input', { id: 'w8-blue-team-prompt-file', type: 'file', accept: '.txt,.md,.json,text/plain,text/markdown,application/json', 'aria-label': 'W8 팀 프롬프트 파일 불러오기' });
      nodes.teamPromptFile.addEventListener('change', () => { if(nodes.teamPromptFile.files?.[0]) void loadTeamPromptFile(nodes.teamPromptFile.files[0]); });
      nodes.promptText = createEl(d.doc, 'textarea', { id: 'w8-blue-prompt-text', rows: 4, spellcheck: false, 'aria-label': 'BLUE 검수 지시문' });
      nodes.promptText.addEventListener('input', () => { st.promptText = nodes.promptText.value; renderHostedControls(); renderExternalControls(); });

      return createEl(d.doc, 'details', { className: 'red-help', id: 'w8-blue-prompt-details' },
        createEl(d.doc, 'summary', { textContent: '프롬프트 · 실행 조건 설정 (선택)' }), nodes.docMeta,
        createEl(d.doc, 'div', { className: 'hosted-ai-grid' },
          createEl(d.doc, 'label', { for: 'w8-blue-prompt-select' }, '검수 프롬프트', nodes.promptSelect),
          createEl(d.doc, 'label', { for: 'w8-blue-condition' }, '실행 조건 (CSV 기록)', nodes.conditionInput)),
        createEl(d.doc, 'div', { className: 'button-row' }, nodes.teamPromptLink),
        createEl(d.doc, 'label', { for: 'w8-blue-team-prompt-file' }, 'W8 팀 프롬프트 파일 (비공개 로컬 파일)', nodes.teamPromptFile),
        createEl(d.doc, 'label', { for: 'w8-blue-prompt-text' }, '검수 지시문 내용', nodes.promptText));
    }
    function buildHostedPanel(){
      nodes.hostedStatus = createEl(d.doc, 'p', { id: 'w8-blue-hosted-status', className: 'form-feedback', role: 'status', 'aria-live': 'polite' });
      nodes.hostedError = createEl(d.doc, 'p', { id: 'w8-blue-hosted-error', className: 'form-feedback error', role: 'alert', hidden: true });
      nodes.hostedDisabled = createEl(d.doc, 'p', { id: 'w8-blue-hosted-disabled', className: 'muted', hidden: true });

      nodes.loginUser = createEl(d.doc, 'input', { id: 'w8-blue-login-user', type: 'text', autocomplete: 'username', maxLength: 200, spellcheck: false });
      nodes.loginPass = createEl(d.doc, 'input', { id: 'w8-blue-login-pass', type: 'password', autocomplete: 'current-password', maxLength: 256 });
      nodes.loginBtn = createEl(d.doc, 'button', { id: 'w8-blue-login-btn', type: 'button', className: 'button primary', textContent: '로그인' });
      nodes.loginBtn.addEventListener('click', () => { void hostedLogin(); });
      nodes.loginForm = createEl(d.doc, 'form', { id: 'w8-blue-login-form', className: 'hosted-ai-login', hidden: true },
        createEl(d.doc, 'h3', { textContent: '내장 BLUE 로그인' }),
        createEl(d.doc, 'label', { for: 'w8-blue-login-user' }, '아이디', nodes.loginUser),
        createEl(d.doc, 'label', { for: 'w8-blue-login-pass' }, '비밀번호', nodes.loginPass),
        createEl(d.doc, 'div', { className: 'button-row' }, nodes.loginBtn));
      nodes.loginForm.addEventListener('submit', e => { e.preventDefault?.(); void hostedLogin(); });

      nodes.sessionText = createEl(d.doc, 'span', { id: 'w8-blue-session-text' });
      nodes.logoutBtn = createEl(d.doc, 'button', { id: 'w8-blue-logout-btn', type: 'button', className: 'text-button', textContent: '로그아웃' });
      nodes.logoutBtn.addEventListener('click', () => { void hostedLogout(); });
      nodes.sessionRow = createEl(d.doc, 'div', { id: 'w8-blue-session-row', className: 'hosted-ai-session', hidden: true }, nodes.sessionText, nodes.logoutBtn);

      nodes.hostedRunBtn = createEl(d.doc, 'button', { id: 'w8-blue-hosted-run', type: 'button', className: 'button primary booth-btn ink wide', textContent: '내장 BLUE 실행', disabled: true });
      nodes.hostedRunBtn.addEventListener('click', () => { void startHostedBlue(null); });
      nodes.hostedCancelBtn = createEl(d.doc, 'button', { id: 'w8-blue-hosted-cancel', type: 'button', className: 'button secondary booth-btn line slim', textContent: '실행 취소', hidden: true });
      nodes.hostedCancelBtn.addEventListener('click', () => { void cancelHostedBlue(); });
      nodes.hostedRefreshBtn = createEl(d.doc, 'button', { id: 'w8-blue-hosted-refresh', type: 'button', className: 'text-button booth-btn line slim', textContent: '상태 새로고침', hidden: true });
      nodes.hostedRefreshBtn.addEventListener('click', () => { const id = st.activeJob?.id || st.activePending?.jobId; if(id) void refreshHostedJob(id, st.activePending); });
      nodes.hostedResumeBtn = createEl(d.doc, 'button', { id: 'w8-blue-hosted-resume', type: 'button', className: 'button secondary booth-btn line slim', textContent: '접수 확인 / 같은 키로 재전송', hidden: true });
      nodes.hostedResumeBtn.addEventListener('click', () => { if(st.activePending) void startHostedBlue(st.activePending); });
      nodes.hostedDiscardPendingBtn = createEl(d.doc, 'button', { id: 'w8-blue-hosted-discard-pending', type: 'button', className: 'text-button booth-btn line slim', textContent: '대기 기록 정리', hidden: true });
      nodes.hostedDiscardPendingBtn.addEventListener('click', () => { if(st.activePending){ dropPending(st.activePending.id, st.activePending.jobId); st.lastTerminalState = ''; st.hostedStatus = '대기 기록을 정리했습니다.'; st.hostedError = ''; render(); } });
      nodes.hostedSendNote = createEl(d.doc, 'span', { id: 'w8-blue-hosted-send-note', className: 'muted booth-small', textContent: '실행 시 현재 PDF를 검수 서비스에 전송합니다.' });
      nodes.localPendingNote = createEl(d.doc, 'p', { id: 'w8-blue-local-pending', className: 'muted', hidden: true });

      nodes.hostedModel = createEl(d.doc, 'select', { id: 'w8-blue-hosted-model', 'aria-label': '내장 BLUE 모델' });
      nodes.hostedModel.addEventListener('change', () => { st.model = nodes.hostedModel.value; syncHostedEffortSelect(); });
      nodes.hostedEffort = createEl(d.doc, 'select', { id: 'w8-blue-hosted-effort', 'aria-label': '추론 강도' });
      nodes.hostedEffort.addEventListener('change', () => { st.effort = isLocalGeminiModel(st.model, st.capabilities) ? GEMINI_BLUE_EFFORT : nodes.hostedEffort.value; });
      nodes.hostedMaxCalls = createEl(d.doc, 'input', { id: 'w8-blue-hosted-budget', type: 'number', min: 1, max: 32, step: 1, placeholder: '서버 기본값', 'aria-label': '최대 모델 호출 수' });
      nodes.hostedMaxCalls.addEventListener('input', () => { st.maxCalls = nodes.hostedMaxCalls.value.trim(); });
      nodes.hostedUseEvidence = createEl(d.doc, 'input', { id: 'w8-blue-hosted-evidence', type: 'checkbox', checked: true });
      nodes.hostedUseEvidence.addEventListener('change', () => { st.useEvidence = nodes.hostedUseEvidence.checked === true; });

      nodes.hostedAdvanced = createEl(d.doc, 'details', { className: 'red-help hosted-ai-advanced', id: 'w8-blue-hosted-advanced' },
        createEl(d.doc, 'summary', { textContent: '모델 · 예산 설정 (선택)' }),
        createEl(d.doc, 'div', { className: 'hosted-ai-grid' },
          createEl(d.doc, 'label', { for: 'w8-blue-hosted-model' }, '모델', nodes.hostedModel),
          createEl(d.doc, 'label', { for: 'w8-blue-hosted-effort' }, '추론 강도', nodes.hostedEffort),
          createEl(d.doc, 'label', { for: 'w8-blue-hosted-budget' }, '최대 호출 수 (1–32)', nodes.hostedMaxCalls)),
        createEl(d.doc, 'label', { className: 'check-row', for: 'w8-blue-hosted-evidence' },
          nodes.hostedUseEvidence, createEl(d.doc, 'span', { textContent: '표·그림 구조화 근거 사용' })));

      nodes.hostedPanel = createEl(d.doc, 'div', { id: 'w8-blue-hosted-panel', className: 'hosted-ai' },
        createEl(d.doc, 'div', { className: 'button-row' },
          nodes.hostedRunBtn, nodes.hostedSendNote, nodes.hostedCancelBtn, nodes.hostedRefreshBtn, nodes.hostedResumeBtn, nodes.hostedDiscardPendingBtn),
        nodes.hostedStatus, nodes.hostedError, nodes.hostedDisabled, nodes.sessionRow, nodes.loginForm, nodes.hostedAdvanced, nodes.localPendingNote);
      return nodes.hostedPanel;
    }
    function buildExternalPanel(){
      nodes.copyBtn = createEl(d.doc, 'button', { id: 'w8-blue-copy-prompt', type: 'button', className: 'button primary', textContent: '검수 지시문 복사' });
      nodes.copyBtn.addEventListener('click', () => { void copyInstructions(); });
      nodes.downloadPdfBtn = createEl(d.doc, 'button', { id: 'w8-blue-download-pdf', type: 'button', className: 'button secondary', textContent: '현재 PDF 내려받기' });
      nodes.downloadPdfBtn.addEventListener('click', () => { void downloadCurrentPdf(); });
      nodes.externalLinkAnchor = createEl(d.doc, 'a', {
        id: 'w8-blue-pdf-link',
        className: 'text-link',
        target: '_blank',
        rel: 'noopener noreferrer'
      });
      nodes.externalLinkPreview = createEl(d.doc, 'p', {
        id: 'w8-blue-pdf-link-preview',
        className: 'muted',
        hidden: true
      }, 'PDF 링크: ', nodes.externalLinkAnchor);
      nodes.copyStatus = createEl(d.doc, 'p', { id: 'w8-blue-copy-status', className: 'form-feedback', role: 'status', 'aria-live': 'polite' });
      nodes.copyFallback = createEl(d.doc, 'textarea', { id: 'w8-blue-copy-fallback', rows: 6, readOnly: true, hidden: true, 'aria-label': '수동 복사할 검수 지시문' });

      nodes.externalModel = createEl(d.doc, 'input', { id: 'w8-blue-external-model', type: 'text', maxLength: 120, placeholder: '예: ChatGPT, Claude, Gemini (선택)', 'aria-label': '외부 AI 모델명' });
      nodes.externalModel.addEventListener('input', () => { st.externalModel = nodes.externalModel.value; });
      nodes.externalFile = createEl(d.doc, 'input', { id: 'w8-blue-external-file', type: 'file', accept: '.json,.txt,.md,application/json,text/plain,text/markdown', 'aria-label': '외부 AI 응답 파일 가져오기' });
      nodes.externalFile.addEventListener('change', () => { void onExternalFileChange(); });
      nodes.externalAnswer = createEl(d.doc, 'textarea', { id: 'w8-blue-external-answer', rows: 6, spellcheck: false, placeholder: '내 AI 응답(JSON · Markdown 표 · 텍스트)을 붙여넣으세요.', 'aria-label': '외부 AI 응답 텍스트' });
      nodes.externalImportBtn = createEl(d.doc, 'button', { id: 'w8-blue-external-import', type: 'button', className: 'button primary', textContent: '응답 가져오기' });
      nodes.externalImportBtn.addEventListener('click', () => { void importExternalText(nodes.externalAnswer.value); });
      nodes.externalForceBtn = createEl(d.doc, 'button', { id: 'w8-blue-external-force-new', type: 'button', className: 'button secondary', textContent: '별도 실행으로 추가', hidden: true });
      nodes.externalForceBtn.addEventListener('click', () => {
        if(!st.duplicateDraft) return;
        const draft = st.duplicateDraft;
        void importExternalText(draft.raw, { model: draft.model, condition: draft.condition, forceNewRun: true });
      });
      nodes.externalStatus = createEl(d.doc, 'p', { id: 'w8-blue-external-status', className: 'form-feedback', role: 'status', 'aria-live': 'polite' });
      nodes.externalError = createEl(d.doc, 'p', { id: 'w8-blue-external-error', className: 'form-feedback error', role: 'alert', hidden: true });

      nodes.externalPanel = createEl(d.doc, 'div', { id: 'w8-blue-external-panel', className: 'external-blue', hidden: true },
        createEl(d.doc, 'div', { className: 'button-row' }, nodes.copyBtn, nodes.downloadPdfBtn),
        nodes.externalLinkPreview, nodes.copyStatus, nodes.copyFallback,
        createEl(d.doc, 'label', { for: 'w8-blue-external-answer' }, 'AI 응답 붙여넣기', nodes.externalAnswer),
        createEl(d.doc, 'div', { className: 'button-row' }, nodes.externalImportBtn, nodes.externalForceBtn),
        createEl(d.doc, 'div', { className: 'hosted-ai-grid' },
          createEl(d.doc, 'label', { for: 'w8-blue-external-file' }, '응답 파일 불러오기', nodes.externalFile),
          createEl(d.doc, 'label', { for: 'w8-blue-external-model' }, '사용한 모델명 (선택)', nodes.externalModel)),
        nodes.externalStatus, nodes.externalError);
      return nodes.externalPanel;
    }
    async function onExternalFileChange(){
      const f = nodes.externalFile.files?.[0];
      if(!f) return;
      const expectedHash = st.artifact?.sha256;
      try{
        const text = await readFileText(f);
        if(expectedHash && st.artifact?.sha256 !== expectedHash){
          st.externalError = '파일을 읽는 동안 PDF가 바뀌어 가져오지 않았습니다.';
          render();
          return;
        }
        await importExternalText(text);
      }catch(e){
        st.externalError = '응답 파일을 읽지 못했습니다: ' + (e?.message || '오류');
        render();
      }
    }
    function buildTicketCell(label, id, className){
      const labelNode = createEl(d.doc, 'dt', { className: 'booth-klab', textContent: label });
      const valNode = createEl(d.doc, 'dd', { id, className });
      const cell = createEl(d.doc, 'div', { id: id + '-cell', className: 'booth-cell' }, labelNode, valNode);
      return { cell, labelNode, valNode };
    }
    function buildTicketSection(){
      const c1 = buildTicketCell('실행', 'w8-blue-ticket-code', 'booth-code');
      const c2 = buildTicketCell('탐지기', 'w8-blue-ticket-detector', 'booth-val');
      const c3 = buildTicketCell('논문', 'w8-blue-ticket-paper', 'booth-val');
      const c4 = buildTicketCell('결과', 'w8-blue-ticket-metric', 'booth-val');
      nodes.ticketCode = c1.valNode;
      nodes.ticketDetector = c2.valNode;
      nodes.ticketPaper = c3.valNode;
      nodes.ticketMetricLabel = c4.labelNode;
      nodes.ticketMetric = c4.valNode;

      nodes.ticketState = createEl(d.doc, 'b', { id: 'w8-blue-ticket-state', textContent: 'AI가 논문을 읽는 중' });
      nodes.ticketElapsed = createEl(d.doc, 'span', { id: 'w8-blue-ticket-elapsed', className: 'booth-elapsed', textContent: '0:00' });
      nodes.ticketStubDate = createEl(d.doc, 'p', { id: 'w8-blue-stub-date', className: 'booth-val' });
      nodes.ticketBarcode = createEl(d.doc, 'canvas', { id: 'w8-blue-barcode', className: 'booth-barcode', 'aria-hidden': 'true', height: '34' });
      nodes.ticketStubCode = createEl(d.doc, 'p', { id: 'w8-blue-stub-code', className: 'booth-code booth-desk' });
      nodes.ticketWait = createEl(d.doc, 'div', { id: 'w8-blue-ticket-wait', className: 'booth-sec', hidden: true },
        createEl(d.doc, 'div', { className: 'booth-status-row' }, nodes.ticketState, nodes.ticketElapsed),
        createEl(d.doc, 'div', { className: 'booth-track', 'aria-hidden': 'true' }, createEl(d.doc, 'i')),
        createEl(d.doc, 'div', { id: 'w8-blue-ticket-stub', className: 'booth-bp-stub' },
          createEl(d.doc, 'div', { className: 'booth-desk' },
            createEl(d.doc, 'p', { className: 'booth-klab', textContent: 'Paper Workbench' }),
            nodes.ticketStubDate),
          nodes.ticketBarcode,
          nodes.ticketStubCode));

      nodes.ticketDate = createEl(d.doc, 'p', { id: 'w8-blue-ticket-date', className: 'booth-small' });
      nodes.stampWord = createEl(d.doc, 'b', { id: 'w8-blue-stamp-word' });
      nodes.stampLatin = createEl(d.doc, 'span', { id: 'w8-blue-stamp-latin' });
      nodes.ticketStamp = createEl(d.doc, 'div', { id: 'w8-blue-stamp', className: 'booth-stamp', 'aria-hidden': 'true' },
        nodes.stampWord, nodes.stampLatin);
      nodes.ticketResult = createEl(d.doc, 'div', { id: 'w8-blue-ticket-result', className: 'booth-sec booth-res', hidden: true },
        createEl(d.doc, 'div', {},
          createEl(d.doc, 'p', { className: 'booth-klab', textContent: 'AI 검증 결과' }),
          nodes.ticketDate),
        nodes.ticketStamp);

      nodes.ticket = createEl(d.doc, 'article', { id: 'w8-blue-ticket', className: 'booth-tk booth-tk-v', tabindex: '-1', 'data-state': 'pending', 'aria-label': 'AI 검증 티켓' },
        createEl(d.doc, 'div', { className: 'booth-sec' },
          createEl(d.doc, 'p', { className: 'booth-lab', textContent: 'FALSIFY · AI REVIEW TICKET' }),
          createEl(d.doc, 'dl', { className: 'booth-grid2' }, c1.cell, c2.cell, c3.cell, c4.cell)),
        createEl(d.doc, 'div', { className: 'booth-cut', 'aria-hidden': 'true' }),
        nodes.ticketWait,
        nodes.ticketResult);

      nodes.ticketStepCheck = createEl(d.doc, 'span', { id: 'w8-blue-step-check', textContent: 'AI가 앞뒤 문장과 표를 대조하는 중' });
      nodes.ticketSteps = createEl(d.doc, 'ol', { id: 'w8-blue-ticket-steps', className: 'booth-list', hidden: true },
        createEl(d.doc, 'li', { className: 'done' }, createEl(d.doc, 'i'), '수정본 준비'),
        createEl(d.doc, 'li', { className: 'now' }, createEl(d.doc, 'i'), nodes.ticketStepCheck),
        createEl(d.doc, 'li', { className: 'wait' }, createEl(d.doc, 'i'), '결과'));

      nodes.verdictTitle = createEl(d.doc, 'h2', { id: 'w8-blue-verdict-title', className: 'booth-headline', tabindex: '-1', role: 'status', 'aria-live': 'polite' });
      nodes.verdictSub = createEl(d.doc, 'p', { id: 'w8-blue-verdict-sub', className: 'booth-copy', hidden: true });
      nodes.verdictMeta = createEl(d.doc, 'p', { id: 'w8-blue-verdict-meta', className: 'booth-small', hidden: true });
      nodes.verdictBox = createEl(d.doc, 'div', { id: 'w8-blue-verdict', className: 'booth-verdict', hidden: true },
        nodes.verdictTitle, nodes.verdictSub, nodes.verdictMeta);

      nodes.ticketLive = createEl(d.doc, 'div', { id: 'w8-blue-live', className: 'booth-live', 'data-state': 'pending' },
        nodes.ticketSteps, nodes.verdictBox);
      nodes.editResults = createEl(d.doc, 'section', {
        id: 'w8-blue-edit-results',
        className: 'booth-panel booth-declared w8-blue-edit-results',
        hidden: true,
        'aria-label': '내가 심은 결함'
      });
      nodes.ticketSection = createEl(d.doc, 'section', { id: 'w8-blue-ticket-section', className: 'w8-blue-ticket-section', hidden: true, 'aria-label': 'AI 검증 티켓 요약' },
        nodes.ticket, nodes.ticketLive, nodes.editResults);
      return nodes.ticketSection;
    }
    const layout = { hash: null, completedRuns: 0, state: '', attention: '' };
    function buildDom(){
      clearNode(host);
      nodes.docMeta = createEl(d.doc, 'p', { id: 'w8-blue-doc-meta', className: 'muted', textContent: '검수할 PDF를 먼저 열어 주세요.' });
      nodes.tabHosted = createEl(d.doc, 'button', { id: 'w8-blue-tab-hosted', type: 'button', className: 'booth-tab is-active', 'aria-pressed': 'true', textContent: '내장 BLUE' });
      nodes.tabExternal = createEl(d.doc, 'button', { id: 'w8-blue-tab-external', type: 'button', className: 'booth-tab', 'aria-pressed': 'false', textContent: '내 AI' });
      nodes.tabHosted.addEventListener('click', () => { st.mode = 'hosted'; if(nodes.launcherDetails) nodes.launcherDetails.open = true; render(); });
      nodes.tabExternal.addEventListener('click', () => { st.mode = 'external'; if(nodes.launcherDetails) nodes.launcherDetails.open = true; render(); });

      nodes.launcherTitle = createEl(d.doc, 'h2', { id: 'w8-blue-title', className: 'booth-myai-title', tabindex: '-1', textContent: 'BLUE 검수' });
      nodes.launcherSummary = createEl(d.doc, 'summary', { id: 'w8-blue-launcher-summary', className: 'w8-blue-launcher-summary' },
        createEl(d.doc, 'span', { className: 'step-head w8-blue-runner-head' },
          createEl(d.doc, 'span', { className: 'booth-lab', textContent: 'BLUE REVIEW' }),
          nodes.launcherTitle));
      nodes.launcherBody = createEl(d.doc, 'div', { id: 'w8-blue-launcher-body', className: 'w8-blue-launcher-body' },
        createEl(d.doc, 'div', { className: 'booth-tabs w8-review-tabs', role: 'group', 'aria-label': 'BLUE 검수 경로' }, nodes.tabHosted, nodes.tabExternal),
        buildHostedPanel(),
        buildExternalPanel(),
        buildPromptDetails());
      nodes.launcherDetails = createEl(d.doc, 'details', { id: 'w8-blue-launcher-details', className: 'w8-blue-launcher-details' },
        nodes.launcherSummary,
        nodes.launcherBody);
      nodes.launcherDetails.open = true;

      const header = createEl(d.doc, 'section', { className: 'role-step document-red booth-panel w8-blue-runner', id: 'w8-blue-adapter', 'aria-labelledby': 'w8-blue-title' },
        nodes.launcherDetails);

      nodes.resultsSummary = createEl(d.doc, 'p', { id: 'w8-blue-results-summary', className: 'booth-small muted', role: 'status', 'aria-live': 'polite' });
      nodes.runFilterBar = createEl(d.doc, 'div', { id: 'w8-blue-run-filters', className: 'booth-chips w8-blue-filters', role: 'group', 'aria-label': '실행 필터' });
      nodes.compareWrap = createEl(d.doc, 'div', { id: 'w8-blue-compare-wrap', className: 'ledger-table-wrap', hidden: true });
      nodes.runsList = createEl(d.doc, 'div', { id: 'w8-blue-runs-list', className: 'w8-blue-runs-list' });
      nodes.findingsList = createEl(d.doc, 'div', { id: 'w8-blue-findings-list', className: 'hosted-ai-candidates booth-findings' });
      nodes.resultsTitle = createEl(d.doc, 'h2', { id: 'w8-blue-results-title', className: 'w8-blue-results-title', textContent: '항목별 AI 검증 결과' });
      nodes.resultsHead = createEl(d.doc, 'div', { className: 'step-head w8-blue-results-head' },
        createEl(d.doc, 'div', {}, nodes.resultsTitle, nodes.resultsSummary));

      nodes.findingsSummary = createEl(d.doc, 'summary', { id: 'w8-blue-findings-summary', className: 'w8-blue-fold-summary', textContent: 'AI 전체 지적 보기' });
      nodes.findingsDetails = createEl(d.doc, 'details', { id: 'w8-blue-findings-details', className: 'booth-more w8-blue-fold' },
        nodes.findingsSummary, nodes.findingsList);
      nodes.findingsDetails.open = false;

      nodes.runsSummary = createEl(d.doc, 'summary', { id: 'w8-blue-runs-summary', className: 'w8-blue-fold-summary', textContent: '실행 상세' });
      nodes.runsDetails = createEl(d.doc, 'details', { id: 'w8-blue-runs-details', className: 'booth-more w8-blue-fold' },
        nodes.runsSummary,
        createEl(d.doc, 'div', { className: 'w8-blue-runs-body' }, nodes.compareWrap, nodes.runsList));
      nodes.runsDetails.open = false;

      const results = createEl(d.doc, 'section', { className: 'role-step document-red booth-panel w8-blue-results-panel', id: 'w8-blue-results', 'aria-labelledby': 'w8-blue-results-title' },
        nodes.resultsHead,
        nodes.runFilterBar,
        nodes.findingsDetails,
        nodes.runsDetails);

      nodes.bodyGrid = createEl(d.doc, 'div', { id: 'w8-blue-body', className: 'w8-blue-body' }, results, header);
      host.append(buildTicketSection(), nodes.bodyGrid);
    }

    function hostedViewFlags(){
      const disabled = st.hostedGate === 'disabled';
      const signed = !!st.session;
      const open = openMode();
      const caps = st.capabilities;
      const allowed = !!caps && caps.blueJobs && caps.modelJobs;
      const activeJob = !!st.activeJob && !TERMINAL_STATES.includes(st.activeJob.state);
      const hasFile = !!(st.artifact?.file || (st.artifact && readCachedUpload(st.artifact.sha256)));
      return {
        disabled, signed, open, allowed, activeJob,
        unconfirmedPending: !activeJob && !!st.activePending && !st.activePending.jobId,
        canRun: !disabled && (open || signed) && allowed && hasFile && cleanStr(st.promptText).length > 0 && !st.busy && !activeJob
      };
    }
    function renderHostedSessionUI(f){
      nodes.loginForm.hidden = f.disabled || f.open || hookPresent() || f.signed;
      nodes.loginBtn.disabled = !!st.busy;
      const showSession = !f.disabled && f.signed && !f.open;
      nodes.sessionRow.hidden = !showSession;
      if(!showSession) return;
      const who = safeName(st.session.author?.displayName || st.session.author?.username) || '로그인됨';
      nodes.sessionText.textContent = '계정: ' + who;
      nodes.logoutBtn.hidden = st.session.source === 'hook';
      nodes.logoutBtn.disabled = !!st.busy;
    }
    function renderHostedButtonsUI(f){
      nodes.hostedAdvanced.hidden = f.disabled || !f.allowed;
      nodes.hostedRunBtn.disabled = !f.canRun;
      nodes.hostedRunBtn.textContent = st.busy === 'submit' ? '접수 중…' : (f.activeJob ? '검수 중…' : '내장 BLUE 실행');
      nodes.hostedCancelBtn.hidden = !f.activeJob;
      nodes.hostedCancelBtn.disabled = !!st.busy;
      nodes.hostedRefreshBtn.hidden = !(f.activeJob || st.activePending?.jobId);
      nodes.hostedRefreshBtn.disabled = !!st.busy;
      nodes.hostedResumeBtn.hidden = !f.unconfirmedPending;
      nodes.hostedResumeBtn.disabled = !!st.busy;
      nodes.hostedDiscardPendingBtn.hidden = !f.unconfirmedPending;
      nodes.hostedDiscardPendingBtn.disabled = !!st.busy;
    }
    function renderLocalPendingNote(){
      const localP = d.pendingJobsFn()?.read?.('blue');
      const rec = localP?.status === 'record' ? localP.record : null;
      const active = !!rec && rec.fileHash === st.artifact?.sha256 && ['open', 'running'].includes(rec.disposition);
      nodes.localPendingNote.hidden = !active;
      if(active) nodes.localPendingNote.textContent = '로컬 실행기에서 진행 중인 BLUE 작업(' + rec.requestId.slice(0, 16) + ')이 있습니다.';
    }
    function renderHostedControls(){
      if(!nodes.hostedPanel) return;
      const isHosted = st.mode === 'hosted';
      nodes.hostedPanel.hidden = !isHosted;
      nodes.externalPanel.hidden = isHosted;
      nodes.tabHosted.className = isHosted ? 'booth-tab is-active' : 'booth-tab';
      nodes.tabHosted.setAttribute('aria-pressed', String(isHosted));
      nodes.tabExternal.className = isHosted ? 'booth-tab' : 'booth-tab is-active';
      nodes.tabExternal.setAttribute('aria-pressed', String(!isHosted));
      const f = hostedViewFlags();
      nodes.hostedStatus.textContent = st.hostedStatus || '';
      nodes.hostedError.textContent = st.hostedError || '';
      nodes.hostedError.hidden = !st.hostedError;
      nodes.hostedDisabled.textContent = st.hostedDisabledMsg || '';
      nodes.hostedDisabled.hidden = !f.disabled;
      renderHostedSessionUI(f);
      renderHostedButtonsUI(f);
      renderLocalPendingNote();
    }
    function renderPdfLink(linkUrl){
      if(nodes.externalLinkPreview && nodes.externalLinkAnchor){
        nodes.externalLinkPreview.hidden = !linkUrl;
        if(linkUrl){
          nodes.externalLinkAnchor.setAttribute('href', linkUrl);
          nodes.externalLinkAnchor.textContent = linkUrl;
        }else{
          nodes.externalLinkAnchor.textContent = '';
          if(typeof nodes.externalLinkAnchor.removeAttribute === 'function') nodes.externalLinkAnchor.removeAttribute('href');
          else nodes.externalLinkAnchor.setAttribute('href', '');
        }
      }
    }
    function renderExternalControls(){
      if(!nodes.externalPanel) return;
      const hasArt = !!st.artifact;
      const linkUrl = currentArtifactLink();
      nodes.copyBtn.disabled = !hasArt || st.copyingLink;
      nodes.copyBtn.textContent = st.copyingLink ? 'PDF 링크 준비 중…' : '검수 지시문 복사';
      nodes.downloadPdfBtn.hidden = !st.artifact?.file;
      renderPdfLink(linkUrl);
      if(nodes.copyFallback && !nodes.copyFallback.hidden){
        if(hasArt && !st.artifactStale) nodes.copyFallback.value = buildExternalCopyPrompt(st.artifact, linkUrl);
        else{ nodes.copyFallback.value = ''; nodes.copyFallback.hidden = true; }
      }
      nodes.externalImportBtn.disabled = !hasArt;
      nodes.externalFile.disabled = !hasArt;
      nodes.externalForceBtn.hidden = !st.duplicateDraft;
      nodes.copyStatus.textContent = st.copyStatus || '';
      nodes.externalStatus.textContent = st.externalStatus || '';
      nodes.externalError.textContent = st.externalError || '';
      nodes.externalError.hidden = !st.externalError;
    }

    function renderComparisonTable(runs){
      clearNode(nodes.compareWrap);
      if(runs.length < 2){ nodes.compareWrap.hidden = true; return; }
      nodes.compareWrap.hidden = false;
      const tbody = createEl(d.doc, 'tbody');
      runs.forEach((r, i) => {
        const pages = [...new Set(r.findings.map(f => Number.isInteger(f.pageIndex) ? f.pageIndex + 1 : null).filter(p => p !== null))].sort((a, b) => a - b);
        const unmatched = r.findings.filter(f => f.pageIndex === null).length;
        tbody.append(createEl(d.doc, 'tr', {},
          createEl(d.doc, 'td', { textContent: '#' + (i + 1) + ' · ' + (r.detector || 'BLUE') }),
          createEl(d.doc, 'td', { textContent: cleanModel(r.model) || '—' }),
          createEl(d.doc, 'td', { textContent: cleanStr(r.condition) || '—' }),
          createEl(d.doc, 'td', { textContent: r.findings.length + '건' + (unmatched ? ' (미지정 ' + unmatched + ')' : '') }),
          createEl(d.doc, 'td', { textContent: pages.length ? pages.map(p => p + '쪽').join(', ') : '—' })));
      });
      nodes.compareWrap.append(createEl(d.doc, 'table', { className: 'ledger-table' },
        createEl(d.doc, 'caption', { textContent: '현재 문서 실행별 비교' }),
        createEl(d.doc, 'thead', {}, createEl(d.doc, 'tr', {},
          createEl(d.doc, 'th', { textContent: '실행 · 탐지기' }), createEl(d.doc, 'th', { textContent: '모델' }),
          createEl(d.doc, 'th', { textContent: '조건' }), createEl(d.doc, 'th', { textContent: '지적 수' }),
          createEl(d.doc, 'th', { textContent: '지적 쪽' }))), tbody));
    }

    function buildRunCard(run, runNumber){
      const unmatched = run.findings.filter(f => f.pageIndex === null).length;
      const parts = ['#' + runNumber, run.detector || 'BLUE', cleanModel(run.model) || '모델 미입력', cleanStr(run.condition) || '조건 미입력', '지적 ' + run.findings.length + '건'];
      if(unmatched) parts.push('위치 미지정 ' + unmatched + '건');
      if(run.partial) parts.push('부분 결과');
      const when = formatTime(run.createdAt);
      if(when) parts.push(when);

      const card = createEl(d.doc, 'article', { className: 'hosted-ai-candidate', 'data-run-id': run.id },
        createEl(d.doc, 'p', { className: 'hosted-ai-candidate-head' }, createEl(d.doc, 'strong', { textContent: parts.join(' · ') })));
      if(run.zeroDropSummary){
        const z = run.zeroDropSummary;
        card.append(createEl(d.doc, 'p', { className: 'blue-zerodrop-audit muted', textContent: 'Zero-Drop: 1단계 ' + z.stage1Count + ' · 해소 ' + z.resolvedOkCount + ' · 보고 ' + z.reportedDefectCount + ' · 복원 ' + z.recoveredCount }));
      }
      if(run.report) card.append(createEl(d.doc, 'p', { className: 'muted', textContent: '검토 메모: ' + run.report.slice(0, 280) }));

      const modelInput = createEl(d.doc, 'input', { type: 'text', value: cleanModel(run.model), maxLength: 120, placeholder: '모델명', 'aria-label': '실행 #' + runNumber + ' 모델명' });
      const condInput = createEl(d.doc, 'input', { type: 'text', value: cleanStr(run.condition), maxLength: 160, placeholder: '실행 조건', 'aria-label': '실행 #' + runNumber + ' 조건' });
      const saveBtn = createEl(d.doc, 'button', { type: 'button', className: 'button secondary', textContent: '메타 저장' });
      saveBtn.addEventListener('click', () => updateRunMeta(run.id, { model: modelInput.value, condition: condInput.value }));
      const row = createEl(d.doc, 'div', { className: 'button-row' }, saveBtn);
      if(!run.readOnlyLegacy){
        const delBtn = createEl(d.doc, 'button', { type: 'button', className: 'text-button', textContent: '이 실행 삭제' });
        delBtn.addEventListener('click', () => deleteRun(run.id));
        row.append(delBtn);
      }
      card.append(createEl(d.doc, 'details', { className: 'red-help' },
        createEl(d.doc, 'summary', { textContent: '모델·조건 보완' }),
        createEl(d.doc, 'div', { className: 'hosted-ai-grid' },
          createEl(d.doc, 'label', {}, '모델명', modelInput), createEl(d.doc, 'label', {}, '실행 조건', condInput)),
        row));
      return card;
    }

    function findingTitle(run, runNumber, f, findingIndex){
      const pageLabel = Number.isInteger(f.pageIndex) ? (f.pageIndex + 1) + '쪽' : '위치 미지정';
      const parts = ['#' + runNumber + ' ' + (run.detector || 'BLUE'), cleanStr(f.id) || ('F-' + (findingIndex + 1)), pageLabel];
      for(const val of [f.locationLabel, f.findingType, f.verdictLabel, f.severity, f.status]) if(val) parts.push(val);
      if(f.confidence) parts.push('확신 ' + f.confidence);
      return parts.join(' · ');
    }
    function appendFindingBody(card, f){
      if(f.zeroDropRecovered) card.append(createEl(d.doc, 'p', { className: 'blue-verdict-label is-recovered booth-small', textContent: 'Zero-Drop 복원 · 확인필요' }));
      if(f.quote){
        card.append(
          createEl(d.doc, 'p', { className: 'booth-klab', textContent: 'AI가 짚은 문장' }),
          createEl(d.doc, 'blockquote', { className: 'booth-quote', translate: 'no', textContent: f.quote }));
      }
      if(f.rationale){
        card.append(
          createEl(d.doc, 'p', { className: f.quote ? 'booth-klab gap' : 'booth-klab', textContent: 'AI 의견' }),
          createEl(d.doc, 'p', { className: 'booth-txt', textContent: f.rationale }));
      }
      const ev = normalizeEvidence(f.evidence);
      if(ev.length){
        const wrap = createEl(d.doc, 'div', { className: 'booth-edit-evidence' });
        wrap.append(createEl(d.doc, 'p', { className: 'booth-klab gap', textContent: '대응 근거' }));
        for(const e of ev){
          if(e.relation) wrap.append(createEl(d.doc, 'p', { className: 'booth-small', textContent: e.relation }));
          if(e.quote) wrap.append(createEl(d.doc, 'blockquote', { className: 'booth-quote', translate: 'no', textContent: e.quote }));
        }
        card.append(wrap);
      }
      if(f.uncertainty) card.append(createEl(d.doc, 'p', { className: 'booth-small muted', textContent: '추가로 필요한 정보: ' + f.uncertainty }));
    }
    function appendCandidateButtons(card, runId, findingIndex, f, segments){
      if(f.pageIndex !== null || !Array.isArray(f.matches) || !f.matches.length) return;
      const row = createEl(d.doc, 'div', { className: 'button-row' });
      f.matches.slice(0, 3).forEach((m, mi) => {
        const label = Number.isInteger(m.pageIndex) ? (m.pageIndex + 1) + '쪽' : '후보 ' + (mi + 1);
        const btn = createEl(d.doc, 'button', { type: 'button', className: 'button secondary', textContent: label + ' 후보에 연결' });
        btn.addEventListener('click', () => {
          const seg = segments.find(s => s.id === m.segmentId);
          updateFindingLocation(runId, findingIndex, { pageIndex: Number.isInteger(m.pageIndex) ? m.pageIndex : null, locationLabel: f.locationLabel || cleanStr(seg?.label, 240), segmentId: m.segmentId || null });
        });
        row.append(btn);
      });
      card.append(row);
    }
    function buildLocationDetails(runId, findingIndex, f, segments){
      const pageInput = createEl(d.doc, 'input', { type: 'number', min: 1, max: 9999, step: 1, value: Number.isInteger(f.pageIndex) ? String(f.pageIndex + 1) : '', placeholder: '물리 페이지 (1부터)', 'aria-label': '물리 페이지 번호' });
      const locInput = createEl(d.doc, 'input', { type: 'text', maxLength: 240, value: cleanStr(f.locationLabel), placeholder: '예: Results / Table 1', 'aria-label': '위치(절·그림·표)' });
      let segSelect = null;
      if(segments.length){
        segSelect = createEl(d.doc, 'select', { 'aria-label': '원문 구간 선택' }, createEl(d.doc, 'option', { value: '', textContent: '원문 구간 선택 (선택)' }));
        segments.slice(0, 200).forEach((s, si) => {
          const pIdx = Number.isInteger(s.pageIndex) ? s.pageIndex : si;
          segSelect.append(createEl(d.doc, 'option', { value: s.id, textContent: (pIdx + 1) + '쪽 · ' + (s.label || s.id) }));
        });
        segSelect.addEventListener('change', () => {
          const seg = segments.find(s => s.id === segSelect.value);
          if(!seg) return;
          pageInput.value = String((Number.isInteger(seg.pageIndex) ? seg.pageIndex : segments.indexOf(seg)) + 1);
          if(!locInput.value.trim()) locInput.value = cleanStr(seg.label, 240);
        });
      }
      const saveBtn = createEl(d.doc, 'button', { type: 'button', className: 'button secondary', textContent: '위치 저장' });
      saveBtn.addEventListener('click', () => {
        const pageNum = pageInput.value.trim() ? Number(pageInput.value.trim()) : null;
        const pageIndex = pageNum !== null && Number.isInteger(pageNum) && pageNum >= 1 ? pageNum - 1 : null;
        updateFindingLocation(runId, findingIndex, { pageIndex, locationLabel: locInput.value, segmentId: segSelect?.value || f.segmentId || null });
      });
      return createEl(d.doc, 'details', { className: 'red-help' },
        createEl(d.doc, 'summary', { textContent: f.pageIndex === null ? '위치 연결·보완 (미지정)' : '위치 보완' }),
        createEl(d.doc, 'div', { className: 'hosted-ai-grid' },
          createEl(d.doc, 'label', {}, '물리 페이지 (1부터)', pageInput), createEl(d.doc, 'label', {}, '위치 (절·그림·표)', locInput)),
        segSelect ? createEl(d.doc, 'label', {}, '원문 구간 연결', segSelect) : null,
        createEl(d.doc, 'div', { className: 'button-row' }, saveBtn));
    }
    function buildFindingCard(run, runNumber, f, findingIndex, segments){
      const fid = cleanStr(f.id) || ('F-' + (findingIndex + 1));
      const modelSub = cleanModel(run.model);
      const badgeInfo = findingVerdictInfo(f);
      const head = createEl(d.doc, 'div', { className: 'booth-declared-head hosted-ai-candidate-head' },
        createEl(d.doc, 'div', { className: 'w8-finding-head-main' },
          createEl(d.doc, 'strong', { className: 'booth-klab w8-finding-head', textContent: findingTitle(run, runNumber, f, findingIndex) }),
          modelSub ? createEl(d.doc, 'small', { className: 'booth-mono-meta', textContent: modelSub + (run.condition ? ' · ' + run.condition : '') }) : null),
        createEl(d.doc, 'span', { className: 'booth-edit-verdict ' + badgeInfo.kind, textContent: badgeInfo.text }));
      const card = createEl(d.doc, 'article', { className: 'hosted-ai-candidate booth-declared-item w8-finding-card', 'data-run-id': run.id, 'data-finding-id': fid }, head);
      appendFindingBody(card, f);
      if(f.quote || Number.isInteger(f.pageIndex) || f.locationLabel){
        const locBtn = createEl(d.doc, 'button', { type: 'button', className: 'button secondary booth-btn line slim', textContent: '원문에서 보기' });
        locBtn.addEventListener('click', () => locateFinding(f));
        card.append(createEl(d.doc, 'div', { className: 'button-row w8-finding-actions' }, locBtn));
      }
      appendCandidateButtons(card, run.id, findingIndex, f, segments);
      card.append(buildLocationDetails(run.id, findingIndex, f, segments));
      return card;
    }

    function appendRunChoices(allRuns){
      const allBtn = createEl(d.doc, 'button', { type: 'button', className: st.filterRunId === 'all' ? 'booth-chip on' : 'booth-chip', 'aria-pressed': String(st.filterRunId === 'all'), textContent: '전체 실행 (' + allRuns.length + ')' });
      allBtn.addEventListener('click', () => { st.lastTerminalState = ''; st.filterRunId = 'all'; renderResults(); });
      nodes.runFilterBar.append(allBtn);
      allRuns.forEach((r, i) => {
        const label = '#' + (i + 1) + ' ' + (r.detector || 'BLUE') + (cleanModel(r.model) ? ' · ' + cleanModel(r.model) : '') + ' (' + r.findings.length + ')';
        const btn = createEl(d.doc, 'button', { type: 'button', className: st.filterRunId === r.id ? 'booth-chip on' : 'booth-chip', 'aria-pressed': String(st.filterRunId === r.id), textContent: label });
        btn.addEventListener('click', () => { st.lastTerminalState = ''; st.filterRunId = r.id; renderResults(); });
        nodes.runFilterBar.append(btn);
      });
    }
    function renderFilterButtons(allRuns, totalUnmatched){
      const compare = allRuns.length > 1;
      nodes.resultsTitle.textContent = compare ? '검수 결과 · 전체 실행 비교' : '항목별 AI 검증 결과';
      nodes.resultsSummary.hidden = !compare;
      nodes.runFilterBar.hidden = !compare && !totalUnmatched;
      if(compare) appendRunChoices(allRuns);
      if(totalUnmatched > 0){
        const umBtn = createEl(d.doc, 'button', { type: 'button', className: st.filterUnmatchedOnly ? 'booth-chip on' : 'booth-chip', 'aria-pressed': String(st.filterUnmatchedOnly), textContent: '위치 미지정만 (' + totalUnmatched + ')' });
        umBtn.addEventListener('click', () => { st.filterUnmatchedOnly = !st.filterUnmatchedOnly; renderResults(); });
        nodes.runFilterBar.append(umBtn);
      }else{
        st.filterUnmatchedOnly = false;
      }
    }
    function collectOpenDetails(container, keyFn){
      const openKeys = new Set();
      if(!container || !container.children) return openKeys;
      for(const child of container.children){
        if(!child || typeof child.querySelector !== 'function') continue;
        if(child.querySelector('details')?.open){
          const key = keyFn(child);
          if(key) openKeys.add(key);
        }
      }
      return openKeys;
    }
    function renderVisibleFindings(visiblePairs, segments, openKeys){
      let count = 0;
      for(const { run, runNumber } of visiblePairs){
        if(!run.findings.length){
          if(!st.filterUnmatchedOnly){
            nodes.findingsList.append(createEl(d.doc, 'article', { className: 'hosted-ai-candidate booth-declared-item w8-finding-card', 'data-run-id': run.id },
              createEl(d.doc, 'div', { className: 'booth-declared-head hosted-ai-candidate-head' },
                createEl(d.doc, 'strong', { className: 'booth-klab w8-finding-head', textContent: '#' + runNumber + ' ' + (run.detector || 'BLUE') + ' · 지적 0건' }),
                createEl(d.doc, 'span', { className: 'booth-edit-verdict excluded', textContent: '지적 0건' })),
              createEl(d.doc, 'p', { className: 'booth-txt', textContent: '지적 없이 완료된 실행입니다.' })));
          }
          continue;
        }
        run.findings.forEach((f, idx) => {
          if(st.filterUnmatchedOnly && f.pageIndex !== null) return;
          count++;
          const card = buildFindingCard(run, runNumber, f, idx, segments);
          const fid = card.getAttribute('data-finding-id');
          if(openKeys && openKeys.has(run.id + '|' + fid)){
            const det = card.querySelector('details');
            if(det) det.open = true;
          }
          nodes.findingsList.append(card);
        });
      }
      if(st.filterUnmatchedOnly && count === 0){
        nodes.findingsList.append(createEl(d.doc, 'p', { className: 'muted', textContent: '선택한 실행에는 위치 미지정 지적이 없습니다.' }));
      }
      return count;
    }
    function drawTicketBarcode(code){
      const canvas = nodes.ticketBarcode;
      if(!canvas || typeof canvas.getContext !== 'function') return;
      const width = Math.max(1, Math.round(canvas.clientWidth || 200));
      const height = Math.max(1, Math.round(canvas.clientHeight || 34));
      const ratio = Math.min(3, Number(root.devicePixelRatio) || 1);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      const pen = canvas.getContext('2d');
      if(!pen) return;
      pen.setTransform(ratio, 0, 0, ratio, 0, 0);
      pen.clearRect(0, 0, width, height);
      pen.fillStyle = '#16191e';
      paintBars(pen, code, width, height);
    }
    function paintTicketStamp(stamp){
      if(!nodes.ticketStamp) return;
      nodes.ticketStamp.hidden = !stamp;
      if(!stamp) return;
      nodes.ticketStamp.className = 'booth-stamp ' + stamp.kind + (stamp.wide ? ' wide' : '');
      nodes.stampWord.textContent = stamp.word;
      nodes.stampLatin.textContent = stamp.latin;
    }
    function paintVerdictHeading(lead, strong){
      clearNode(nodes.verdictTitle);
      if(lead) nodes.verdictTitle.append(lead);
      nodes.verdictTitle.append(createEl(d.doc, 'b', { textContent: strong }));
    }
    function checkingTicketCopy(activeJob, queued, unconfirmed){
      if(st.busy === 'submit') return { state: st.hostedStatus || 'PDF 업로드 확인 중…', step: 'AI가 앞뒤 문장과 표를 대조하는 중' };
      if(unconfirmed) return { state: '접수 응답을 확인하지 못했어요', step: '「접수 확인 / 같은 키로 재전송」으로 이어갈 수 있어요' };
      if(queued) return { state: 'AI 검증 차례를 기다리는 중', step: '차례가 오면 AI가 앞뒤 문장과 표를 대조해요' };
      return { state: activeJob ? 'AI가 논문을 읽는 중' : (st.hostedStatus || 'AI 검증을 준비하는 중'), step: 'AI가 앞뒤 문장과 표를 대조하는 중' };
    }
    function checkingModelName(activeJob, pending){
      const raw = (activeJob && activeJob.model) || (pending && pending.model) || st.model;
      return cleanModel(raw) || '기본 모델';
    }
    function checkingStartMs(activeJob, pending){
      const raw = (activeJob && activeJob.createdAt) || (pending && pending.createdAt) || '';
      return Date.parse(raw) || st.jobStartedAt || d.nowFn();
    }
    function checkingTicketMeta(allRuns, activeJob, pending){
      const nextNum = allRuns.length + 1;
      const stubCode = activeJob && activeJob.id ? activeJob.id.slice(0, 8).toUpperCase() : ('RUN-' + nextNum);
      const art = st.artifact;
      return {
        runCode: '#' + nextNum,
        stubCode,
        paper: shortPaperTitle(art ? art.name : '현재 논문'),
        model: checkingModelName(activeJob, pending),
        barcode: stubCode + '-' + (art ? art.sha256 : '').slice(0, 8)
      };
    }
    function renderCheckingTicket(allRuns){
      const activeJob = st.activeJob && !TERMINAL_STATES.includes(st.activeJob.state) ? st.activeJob : null;
      const pending = st.activePending;
      const unconfirmed = !activeJob && !st.busy && Boolean(pending && !pending.jobId);
      const queued = Boolean(activeJob && activeJob.state === 'queued');
      const meta = checkingTicketMeta(allRuns, activeJob, pending);
      const copy = checkingTicketCopy(activeJob, queued, unconfirmed);
      nodes.ticketSection.hidden = false;
      nodes.ticket.setAttribute('data-state', 'pending');
      nodes.ticketLive.setAttribute('data-state', 'pending');
      nodes.ticketCode.textContent = meta.runCode;
      nodes.ticketDetector.textContent = DETECTOR_HOSTED;
      nodes.ticketPaper.textContent = meta.paper;
      nodes.ticketMetricLabel.textContent = '모델';
      nodes.ticketMetric.textContent = meta.model;
      nodes.ticketStubCode.textContent = meta.stubCode;
      nodes.ticketStubDate.textContent = formatDateDot(d.nowFn());
      nodes.ticketWait.hidden = false;
      nodes.ticketWait.setAttribute('data-poll', unconfirmed || st.pollFailures >= MAX_POLL_FAILURES ? 'stopped' : 'live');
      nodes.ticketResult.hidden = true;
      nodes.ticketSteps.hidden = false;
      nodes.verdictBox.hidden = true;
      nodes.ticketState.textContent = copy.state;
      nodes.ticketStepCheck.textContent = copy.step;
      if(unconfirmed){ stopClock(); nodes.ticketElapsed.textContent = '확인 필요'; }
      else startClock(checkingStartMs(activeJob, pending));
      drawTicketBarcode(meta.barcode);
    }
    function failureTicketCopy(cancelled){
      if(cancelled){
        return {
          state: 'cancelled', metric: '취소됨',
          stamp: { kind: 'void', word: '취소', latin: 'CANCELLED' },
          lead: '내장 BLUE 실행을 ', strong: '취소했어요',
          sub: st.hostedStatus || '다시 실행해 검수할 수 있어요.'
        };
      }
      return {
        state: 'failed', metric: '실패',
        stamp: { kind: 'fail', word: '실패', latin: 'FAILED' },
        lead: '내장 BLUE 검수가 ', strong: '실패했어요',
        sub: st.hostedError || '오류가 발생해 결과를 기록하지 못했어요.'
      };
    }
    function renderFailureTicket(allRuns){
      stopClock();
      const copy = failureTicketCopy(st.lastTerminalState === 'cancelled');
      nodes.ticketSection.hidden = false;
      nodes.ticket.setAttribute('data-state', copy.state);
      nodes.ticketLive.setAttribute('data-state', copy.state);
      nodes.ticketCode.textContent = '#' + (allRuns.length + 1);
      nodes.ticketDetector.textContent = DETECTOR_HOSTED;
      nodes.ticketPaper.textContent = shortPaperTitle(st.artifact ? st.artifact.name : '현재 논문');
      nodes.ticketMetricLabel.textContent = '상태';
      nodes.ticketMetric.textContent = copy.metric;
      nodes.ticketDate.textContent = formatDateDot(d.nowFn());
      nodes.ticketWait.hidden = true;
      nodes.ticketResult.hidden = false;
      nodes.ticketSteps.hidden = true;
      nodes.verdictBox.hidden = false;
      paintTicketStamp(copy.stamp);
      paintVerdictHeading(copy.lead, copy.strong);
      nodes.verdictSub.textContent = copy.sub;
      nodes.verdictSub.hidden = false;
      nodes.verdictMeta.textContent = allRuns.length ? '이전 완료 실행 ' + allRuns.length + '건의 결과는 아래에 그대로 유지됩니다.' : '';
      nodes.verdictMeta.hidden = !allRuns.length;
    }
    function renderResultTicket(allRuns){
      stopClock();
      const focusIdx = st.filterRunId !== 'all'
        ? Math.max(0, allRuns.findIndex(r => r.id === st.filterRunId))
        : allRuns.length - 1;
      const run = allRuns[focusIdx];
      const runNumber = focusIdx + 1;
      const grading = root.FalsifyW8Grading?.summary(run, d.ls);
      const view = summarizeRunTicket(run, runNumber, grading);
      const unmatched = run.findings.filter(f => f.pageIndex === null).length;
      nodes.ticketSection.hidden = false;
      nodes.ticket.setAttribute('data-state', view.state);
      nodes.ticketLive.setAttribute('data-state', view.state);
      nodes.ticketCode.textContent = '#' + runNumber;
      nodes.ticketDetector.textContent = [run.detector || 'BLUE', cleanModel(run.model)].filter(Boolean).join(' · ');
      nodes.ticketPaper.textContent = shortPaperTitle(st.artifact?.name || run.fileName || '현재 논문');
      nodes.ticketMetricLabel.textContent = grading ? '심은 결함' : '지적';
      nodes.ticketMetric.textContent = grading ? grading.total + '곳' : run.findings.length + '건' + (unmatched ? ' (미지정 ' + unmatched + ')' : '');
      nodes.ticketDate.textContent = formatDateDot(Date.parse(run.updatedAt || run.createdAt || '') || d.nowFn());
      nodes.ticketWait.hidden = true;
      nodes.ticketResult.hidden = false;
      nodes.ticketSteps.hidden = true;
      nodes.verdictBox.hidden = false;
      paintTicketStamp(view.stamp);
      paintVerdictHeading(view.lead, view.strong);
      nodes.verdictSub.textContent = view.sub;
      nodes.verdictSub.hidden = !view.sub;
      const totalFindings = allRuns.reduce((sum, r) => sum + r.findings.length, 0);
      const multiMeta = allRuns.length > 1
        ? '전체 실행 ' + allRuns.length + '건 · 누적 지적 ' + totalFindings + '건'
        : '';
      nodes.verdictMeta.textContent = multiMeta;
      nodes.verdictMeta.hidden = !multiMeta;
    }
    function renderTicket(allRuns){
      if(!nodes.ticketSection) return;
      const f = hostedViewFlags();
      const checking = st.busy === 'submit' || f.activeJob || f.unconfirmedPending;
      if(checking){
        renderCheckingTicket(allRuns);
        return;
      }
      if(st.lastTerminalState === 'failed' || st.lastTerminalState === 'cancelled' || (st.hostedError && !allRuns.length)){
        renderFailureTicket(allRuns);
        return;
      }
      if(st.artifact && allRuns.length){
        renderResultTicket(allRuns);
        return;
      }
      stopClock();
      nodes.ticketSection.hidden = true;
    }
    function activeCompletedRun(allRuns){
      if(!st.artifact || !allRuns.length) return null;
      const f = hostedViewFlags();
      if(st.busy === 'submit' || f.activeJob || f.unconfirmedPending) return null;
      if(st.lastTerminalState === 'failed' || st.lastTerminalState === 'cancelled') return null;
      const idx = st.filterRunId !== 'all' ? allRuns.findIndex(r => r.id === st.filterRunId) : -1;
      return idx >= 0 ? allRuns[idx] : allRuns[allRuns.length - 1];
    }
    function renderEditResults(run){
      if(!nodes.editResults) return;
      const renderCards = root.FalsifyW8Grading?.renderCards;
      if(!run || typeof renderCards !== 'function'){
        clearNode(nodes.editResults);
        nodes.editResults.hidden = true;
        return;
      }
      nodes.editResults.hidden = false;
      renderCards(nodes.editResults, run, d.ls);
      if(!(nodes.editResults.children && nodes.editResults.children.length > 0) && !nodes.editResults.firstChild){
        nodes.editResults.hidden = true;
      }
    }
    function launcherState(count) {
      if (!count) return 'empty';
      const flags = hostedViewFlags();
      if (st.busy === 'submit' || flags.activeJob || flags.unconfirmedPending) return 'checking';
      if (['failed', 'cancelled'].includes(st.lastTerminalState)) return 'retry';
      return 'results';
    }
    function syncFoldState(allRuns){
      const hash = st.artifact?.sha256 || null;
      const count = allRuns.length;
      const state = launcherState(count);
      const attention = st.externalError || st.hostedError || (st.duplicateDraft ? 'duplicate' : '');
      const changedPaper = hash !== layout.hash;
      if (changedPaper || !count) {
        nodes.findingsDetails.open = false;
        nodes.runsDetails.open = false;
      }
      nodes.launcherTitle.textContent = count ? '다시 검수 · 내 AI' : 'BLUE 검수';
      if (attention && attention !== layout.attention) nodes.launcherDetails.open = true;
      else if (changedPaper || state !== layout.state || count !== layout.completedRuns) {
        nodes.launcherDetails.open = state !== 'results' || Boolean(attention);
      }
      Object.assign(layout, {hash, state, completedRuns: count, attention});
    }
    function renderResultsContent(allRuns, openRunMetaIds, openFindingKeys){
      const totalFindings = allRuns.reduce((sum, r) => sum + r.findings.length, 0);
      const totalUnmatched = allRuns.reduce((sum, r) => sum + r.findings.filter(f => f.pageIndex === null).length, 0);
      const hostedCount = allRuns.filter(r => r.detector === DETECTOR_HOSTED).length;
      const extCount = allRuns.filter(r => r.detector === DETECTOR_EXTERNAL).length;
      nodes.resultsSummary.textContent = '전체 실행 ' + allRuns.length + '건 (내장 ' + hostedCount + ' · 내 AI ' + extCount + ') · 전체 지적 ' + totalFindings + '건' + (totalUnmatched ? ' · 위치 미지정 ' + totalUnmatched + '건' : '');
      renderFilterButtons(allRuns, totalUnmatched);
      renderComparisonTable(allRuns);
      const visiblePairs = allRuns.map((r, i) => ({ run: r, runNumber: i + 1 })).filter(p => st.filterRunId === 'all' || p.run.id === st.filterRunId);
      for(const { run, runNumber } of visiblePairs){
        const runCard = buildRunCard(run, runNumber);
        if(openRunMetaIds.has(run.id)){
          const det = runCard.querySelector('details');
          if(det) det.open = true;
        }
        nodes.runsList.append(runCard);
      }
      const visibleFindingCount = renderVisibleFindings(visiblePairs, st.segmentsByHash.get(st.artifact.sha256)?.segments || [], openFindingKeys);
      if(nodes.findingsSummary){
        const label = st.filterUnmatchedOnly
          ? 'AI 전체 지적 보기 (위치 미지정 ' + visibleFindingCount + '건)'
          : 'AI 전체 지적 보기 (' + visibleFindingCount + '건)';
        nodes.findingsSummary.textContent = label;
      }
      if(nodes.runsSummary){
        nodes.runsSummary.textContent = allRuns.length > 1
          ? '실행 상세 · 비교 (' + allRuns.length + '건)'
          : '실행 상세 · 모델·조건 (1건)';
      }
    }
    function renderResults(){
      const openRunMetaIds = collectOpenDetails(nodes.runsList, el => el.getAttribute('data-run-id'));
      const openFindingKeys = collectOpenDetails(nodes.findingsList, el => {
        const rid = el.getAttribute('data-run-id');
        const fid = el.getAttribute('data-finding-id');
        return rid && fid ? rid + '|' + fid : '';
      });
      clearNode(nodes.runFilterBar); clearNode(nodes.runsList); clearNode(nodes.findingsList);
      const allRuns = st.artifact ? currentRunsRaw(st.artifact.sha256) : [];
      nodes.bodyGrid.setAttribute('data-results', allRuns.length ? 'ready' : 'empty');
      if(!st.artifact){
        nodes.resultsSummary.textContent = 'PDF를 열면 이 문서의 BLUE 실행과 지적이 여기에 모입니다.';
        nodes.compareWrap.hidden = true;
        renderTicket([]);
        renderEditResults(null);
        syncFoldState([]);
        return;
      }
      renderTicket(allRuns);
      renderEditResults(activeCompletedRun(allRuns));
      syncFoldState(allRuns);
      if(!allRuns.length){
        nodes.resultsSummary.textContent = '아직 BLUE 실행 기록이 없습니다.';
        nodes.compareWrap.hidden = true;
        return;
      }
      renderResultsContent(allRuns, openRunMetaIds, openFindingKeys);
    }

    function render(){
      if(st.destroyed) return;
      if(nodes.docMeta){
        nodes.docMeta.textContent = st.artifact
          ? st.artifact.name + ' · SHA-256 ' + st.artifact.sha256.slice(0, 12) + ' · 버전 ' + st.artifact.revision
          : '검수할 PDF를 먼저 열어 주세요.';
      }
      renderHostedControls();
      renderExternalControls();
      renderResults();
    }

    /* ---------- refresh & lifecycle ---------- */
    function resetForNewArtifact(nextArt, preserveCopyEpoch){
      st.filterRunId = 'all';
      st.filterUnmatchedOnly = false;
      st.duplicateDraft = null;
      st.externalStatus = '';
      st.externalError = '';
      st.copyStatus = '';
      st.copyingLink = false;
      st.lastTerminalState = '';
      if(!preserveCopyEpoch) st.copyEpoch++;
      if(nodes.copyFallback){ nodes.copyFallback.value = ''; nodes.copyFallback.hidden = true; }
      if(st.activeJob && st.activePending?.fileHash !== nextArt?.sha256){
        stopPoll();
        stopClock();
        st.jobStartedAt = 0;
        st.activeJob = null;
        st.activePending = null;
      }
    }
    async function refresh(){
      if(st.destroyed) return currentProjectedRuns();
      const myEpoch = ++st.artifactEpoch;
      const nextArt = await resolveArtifact();
      if(st.destroyed || myEpoch !== st.artifactEpoch) return currentProjectedRuns();
      const changedHash = nextArt?.sha256 !== st.artifact?.sha256;
      st.artifact = nextArt;
      st.artifactStale = false;
      if(changedHash) resetForNewArtifact(nextArt);
      render();
      notifyRunsChange(changedHash);
      if(nextArt){
        void ensureSegments(nextArt).then(() => { if(!st.destroyed) renderResults(); });
        if(st.hostedGate === 'ready') await restorePendingHosted();
      }
      return currentProjectedRuns();
    }

    function destroy(){
      st.destroyed = true;
      stopPoll();
      stopClock();
      st.jobStartedAt = 0;
      for(const id of [...st.timers]) cancelLater(id);
      for(const [type, fn] of st.docListeners){
        if(d.doc && typeof d.doc.removeEventListener === 'function') d.doc.removeEventListener(type, fn);
      }
      st.docListeners.length = 0;
      mountedByHost.delete(host);
      if(activeInstance === handle) activeInstance = null;
      clearNode(host);
    }

    /* ---------- legacy bridge listeners ---------- */
    onDoc('falsify:hosted-blue-result', event => {
      const detail = event?.detail;
      if(!detail?.job || !HEX_64.test(detail.fileHash || '')) return;
      void persistHostedBlueResult(detail.job, {
        fileHash: detail.fileHash, fileName: detail.fileName || st.artifact?.name || 'hosted.pdf',
        model: detail.job.model || '', effort: detail.job.effort || '', condition: '', promptLabel: '내장 BLUE', privatePrompt: false
      }).then(() => { if(!st.destroyed) renderResults(); }).catch(() => {});
    });
    onDoc('falsify:w8-artifact-change', () => { void refresh(); });
    onDoc('falsify:w8-paper-change', event => {
      if(st.destroyed || !st.artifact) return;
      const detail = event?.detail;
      const hasArtField = isObj(detail) && Object.hasOwn(detail, 'artifact');
      const nextArtSha = cleanStr(detail?.artifact?.sha256, 64).toLowerCase();
      if(!hasArtField || nextArtSha !== st.artifact.sha256){
        st.artifactStale = true;
        st.copyEpoch++;
        st.copyingLink = false;
        st.copyStatus = '';
        if(nodes.copyFallback){ nodes.copyFallback.value = ''; nodes.copyFallback.hidden = true; }
        renderExternalControls();
      }
    });
    onDoc('falsify:w8-pdf-link', event => {
      if(st.destroyed) return;
      const sha = cleanStr(event?.detail?.sha256, 64).toLowerCase();
      if(!sha || sha === st.artifact?.sha256) renderExternalControls();
    });
    onDoc('falsify:blue-state', () => { if(!st.destroyed) renderResults(); });
    onDoc('falsify:w8-grading-change', event => {
      if(st.destroyed) return;
      const hash = cleanStr(event?.detail?.fileHash, 64).toLowerCase();
      if(!hash || hash === st.artifact?.sha256) renderResults();
    });

    /* ---------- bootstrap ---------- */
    buildDom();
    const p0 = presetEntry('p0');
    st.promptText = p0.prompt; st.promptFormat = p0.format; st.promptLabel = p0.label; st.condition = p0.condition;
    renderPromptOptions();
    if(nodes.promptText) nodes.promptText.value = st.promptText;
    if(nodes.conditionInput) nodes.conditionInput.value = st.condition;

    const ready = (async () => {
      await Promise.all([refreshPromptCatalog(), refresh(), probeCapabilities()]);
      if(!st.destroyed && st.artifact && st.hostedGate === 'ready') await restorePendingHosted();
      return currentProjectedRuns();
    })();

    const handle = {
      ready,
      runs: fileHash => currentProjectedRuns(fileHash),
      refresh,
      setMode: mode => { st.mode = mode === 'external' ? 'external' : 'hosted'; render(); },
      state: () => ({
        mode: st.mode,
        fileHash: st.artifact?.sha256 || '',
        revision: st.artifact?.revision || '',
        fileName: st.artifact?.name || '',
        hostedGate: st.hostedGate,
        signed: !!st.session,
        busy: st.busy,
        activeJobId: st.activeJob?.id || st.activePending?.jobId || '',
        runCount: st.artifact ? currentRunsRaw(st.artifact.sha256).length : 0,
        findingCount: st.artifact ? currentRunsRaw(st.artifact.sha256).reduce((s, r) => s + r.findings.length, 0) : 0
      }),
      destroy
    };

    mountedByHost.set(host, handle);
    activeInstance = handle;
    return handle;
  }

  function mount(host, options = {}){
    if(!host || typeof host.append !== 'function') throw new Error('FalsifyW8Blue.mount requires a host element.');
    const existing = mountedByHost.get(host);
    if(existing && typeof existing.destroy === 'function') existing.destroy();
    return createController(host, isObj(options) ? options : {});
  }
  function runs(fileHash){
    if(fileHash && HEX_64.test(fileHash)) return projectRuns(readMergedRuns(getLocalStorage(), fileHash), fileHash);
    return activeInstance ? activeInstance.runs() : [];
  }
  function refresh(){
    return activeInstance ? activeInstance.refresh() : Promise.resolve([]);
  }

  return Object.freeze({
    version: VERSION,
    mount,
    runs,
    refresh,
    projectRun,
    projectRuns,
    extractArtifactInfo,
    RUNS_STORE_KEY,
    PENDING_STORE_KEY
  });
});
