/* W8 BLUE CSV export and user export UI. Works offline without OAuth. AGPL-3.0-only. */
(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.FalsifyW8Csv = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const BOM = '\uFEFF';
  const CRLF = '\r\n';
  const STORAGE_KEY = 'falsify.w8-csv.profile.v1';
  const RUNS_CHANGE_EVENT = 'falsify:w8-runs-change';
  const DEFAULT_CONDITION = 'A';
  const DEFAULT_FILENAME_NAME = '참가자';

  const COLUMNS = Object.freeze([
    '참가자',
    '조건',
    '탐지기',
    '모델',
    '실행번호',
    'ID',
    '물리 페이지',
    '위치(절·그림·표)',
    '유형',
    '판정(아님/확인필요)',
    '심각도',
    '정확한 원문 인용',
    '대응 근거·이유·검산',
    '확신',
    '추가로 필요한 정보',
  ]);

  const HEADER_LINE = COLUMNS.join(',');

  // Spreadsheet formula injection guard (matches tools/booth and paper-enrichment-ui).
  const FORMULA_PREFIX = /^[=+\-@\t\r]/;
  const INVALID_FILENAME_CHARS = /[\/\\:*?"<>|\u0000-\u001f\u007f]+/g;
  const ORIGIN_DETECTORS = Object.freeze({
    hosted: '내장 BLUE',
    external: '외부 AI',
    'manual-unverified': '외부 AI',
    'imported-unverified': '외부 AI',
    'local-codex': '로컬 BLUE',
  });

  const mountedHosts = typeof WeakMap === 'function' ? new WeakMap() : null;

  function cleanString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function rawString(value) {
    return typeof value === 'string' ? value : '';
  }

  function firstNonEmpty(values) {
    for (let i = 0; i < values.length; i++) {
      const text = cleanString(values[i]);
      if (text) return text;
    }
    return '';
  }

  function isNonNegInt(value) {
    return Number.isInteger(value) && value >= 0 && value <= 99999;
  }

  function parsePositiveInt(value) {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 1 && value <= 100000 ? value : null;
    }
    if (typeof value === 'string' && /^\s*\d{1,6}\s*$/.test(value)) {
      const parsed = Number(value.trim());
      return parsed >= 1 && parsed <= 100000 ? parsed : null;
    }
    return null;
  }

  function csvCell(value) {
    let text = value == null ? '' : String(value);
    if (FORMULA_PREFIX.test(text)) text = "'" + text;
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  function sanitizeFilenamePart(value) {
    const cleaned = cleanString(value)
      .replace(INVALID_FILENAME_CHARS, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 64);
    return cleaned || DEFAULT_FILENAME_NAME;
  }

  function extractStudyConditionCode(condition) {
    const text = cleanString(condition);
    if (!text) return '';
    const direct = /^(?:W8[-_\s]*)?([ABC])(?:\b|[\s(·:-]|$)/i.exec(text);
    return direct ? direct[1].toUpperCase() : '';
  }

  function buildFilename(participant, condition) {
    const condCode = extractStudyConditionCode(condition) || DEFAULT_CONDITION;
    return 'Blue_W8_' + sanitizeFilenamePart(participant) + '_' + condCode + '.csv';
  }

  function pageFromSegmentId(segmentId) {
    const match = typeof segmentId === 'string' ? /^p(\d{1,5})(?:[-_]|$)/i.exec(segmentId.trim()) : null;
    return match ? parsePositiveInt(match[1]) : null;
  }

  function findSegment(run, segmentId) {
    if (!segmentId || !Array.isArray(run?.segments)) return null;
    return run.segments.find(seg => seg && seg.id === segmentId) || null;
  }

  function segmentPage(seg) {
    if (!seg) return null;
    if (isNonNegInt(seg.pageIndex)) return seg.pageIndex + 1;
    return pageFromSegmentId(seg.id);
  }

  function resolvePhysicalPage(finding, run) {
    if (!finding || typeof finding !== 'object') return '';
    if (isNonNegInt(finding.pageIndex)) return String(finding.pageIndex + 1);
    const page =
      parsePositiveInt(finding.page) ??
      segmentPage(findSegment(run, finding.segmentId)) ??
      pageFromSegmentId(finding.segmentId);
    return page != null ? String(page) : '';
  }

  function resolveLocation(finding, run) {
    if (!finding || typeof finding !== 'object') return '';
    return firstNonEmpty([finding.locationLabel, finding.location, finding.label, findSegment(run, finding.segmentId)?.label]);
  }

  function harnessDetector(harness) {
    const name = cleanString(harness?.name);
    if (!name) return '';
    const version = cleanString(harness?.version);
    return version ? name + ' v' + version : name;
  }

  function originDetector(run) {
    const key = firstNonEmpty([run.source, run.provenance]).toLowerCase();
    return ORIGIN_DETECTORS[key] || '';
  }

  function resolveDetector(run) {
    if (!run || typeof run !== 'object') return '';
    return firstNonEmpty([run.detector, run.profile, harnessDetector(run.harness), originDetector(run)]);
  }

  function resolveModel(run) {
    if (!run || typeof run !== 'object') return '';
    const candidates = [run.model, run.response?.model, run.result?.model, run.harness?.adapter?.model];
    for (let i = 0; i < candidates.length; i++) {
      const value = cleanString(candidates[i]);
      if (value && value !== 'manual-model-unverified') return value;
    }
    return '';
  }

  function resolveRunNumber(run, fallbackIndex) {
    const explicit = parsePositiveInt(run?.runNumber);
    if (explicit != null) return explicit;
    if (isNonNegInt(run?.repeat)) return run.repeat + 1;
    return fallbackIndex + 1;
  }

  function extractFindings(run) {
    const lists = [run?.findings, run?.response?.findings, run?.result?.findings, run?.items];
    const list = lists.find(Array.isArray) || [];
    return list.filter(item => item && typeof item === 'object' && !Array.isArray(item));
  }

  function runKey(run, index) {
    return cleanString(run?.id) || '__w8-run-' + index;
  }

  function dedupeRuns(runs) {
    if (!Array.isArray(runs)) return [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!run || typeof run !== 'object' || Array.isArray(run)) continue;
      const id = cleanString(run.id);
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      out.push(run);
    }
    return out;
  }

  function normalizeRun(run, fallbackIndex) {
    const idx = isNonNegInt(fallbackIndex) ? fallbackIndex : 0;
    return {
      key: runKey(run, idx),
      id: cleanString(run?.id),
      fileHash: cleanString(run?.fileHash),
      detector: resolveDetector(run),
      model: resolveModel(run),
      condition: cleanString(run?.condition),
      runNumber: resolveRunNumber(run, idx),
      findings: extractFindings(run),
      raw: run,
    };
  }

  function formatEvidenceEntry(entry, index, total) {
    const prefix = total > 1 ? '[근거 ' + (index + 1) + ']' : '[근거]';
    if (typeof entry === 'string') {
      const text = entry.trim();
      return text ? prefix + ' ' + text : '';
    }
    if (!entry || typeof entry !== 'object') return '';
    const relation = cleanString(entry.relation);
    const quote = rawString(entry.quote);
    if (relation && quote.trim()) return prefix + ' ' + relation + ' | 인용: ' + quote;
    if (relation) return prefix + ' ' + relation;
    if (quote.trim()) return prefix + ' 인용: ' + quote;
    return '';
  }

  function collectEvidenceLines(rawEvidence) {
    if (!Array.isArray(rawEvidence) || !rawEvidence.length) return [];
    const lines = [];
    for (let i = 0; i < rawEvidence.length; i++) {
      const line = formatEvidenceEntry(rawEvidence[i], lines.length, rawEvidence.length);
      if (line) lines.push(line);
    }
    if (lines.length === 1 && rawEvidence.length > 1) {
      lines[0] = lines[0].replace(/^\[근거 \d+\]/, '[근거]');
    }
    return lines;
  }

  function formatReferenceEntry(entry) {
    if (typeof entry === 'string') return entry.trim();
    if (!entry || typeof entry !== 'object') return '';
    return [entry.label, entry.title, entry.doi, entry.url, entry.description]
      .map(cleanString)
      .filter(Boolean)
      .join(' · ');
  }

  function collectReferenceLines(rawRefs, existingLines) {
    const list = Array.isArray(rawRefs) ? rawRefs : typeof rawRefs === 'string' && rawRefs.trim() ? [rawRefs] : [];
    const seen = new Set(existingLines.map(line => line.trim()));
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const text = formatReferenceEntry(list[i]);
      if (!text) continue;
      const line = '[참고] ' + text;
      if (seen.has(text) || seen.has(line)) continue;
      seen.add(line);
      out.push(line);
    }
    return out;
  }

  function formatEvidenceCell(finding) {
    if (!finding || typeof finding !== 'object') return '';
    const rationale = rawString(finding.rationale);
    const lines = collectEvidenceLines(finding.evidence);
    if (rationale.trim()) lines.unshift(rationale);
    const refs = collectReferenceLines(finding.references, lines);
    return lines.concat(refs).join('\n');
  }

  function resolveConfidence(finding) {
    if (typeof finding?.confidence === 'string') return finding.confidence.trim();
    if (typeof finding?.confidence === 'number' && Number.isFinite(finding.confidence)) {
      return String(finding.confidence);
    }
    return '';
  }

  function resolveFindingType(finding) {
    const direct = firstNonEmpty([finding?.findingType, finding?.defectFamily, finding?.defect_type, finding?.type]);
    if (direct) return direct;
    if (Array.isArray(finding?.attackTypes)) {
      return finding.attackTypes.map(cleanString).filter(Boolean).join(', ');
    }
    return '';
  }

  function resolveVerdict(finding) {
    const raw = firstNonEmpty([finding?.verdictLabel, finding?.verdict]);
    if (raw) return raw;
    return finding?.zeroDropRecovered === true ? '확인필요' : '';
  }

  function resolveFindingId(finding, index) {
    const direct = firstNonEmpty([finding?.id, finding?.reportNumber]);
    return direct || 'F-' + (index + 1);
  }

  function resolveQuote(finding) {
    if (typeof finding?.quote === 'string') return finding.quote;
    if (typeof finding?.sourceQuote === 'string') return finding.sourceQuote;
    return '';
  }

  function findingToRow(normRun, finding, findingIndex, options) {
    const opts = options || {};
    const studyCondition = cleanString(opts.condition);
    return {
      참가자: cleanString(opts.participant),
      조건: studyCondition || normRun.condition,
      탐지기: normRun.detector,
      모델: normRun.model,
      실행번호: String(normRun.runNumber),
      ID: resolveFindingId(finding, findingIndex),
      '물리 페이지': resolvePhysicalPage(finding, normRun.raw),
      '위치(절·그림·표)': resolveLocation(finding, normRun.raw),
      유형: resolveFindingType(finding),
      '판정(아님/확인필요)': resolveVerdict(finding),
      심각도: cleanString(finding?.severity),
      '정확한 원문 인용': resolveQuote(finding),
      '대응 근거·이유·검산': formatEvidenceCell(finding),
      확신: resolveConfidence(finding),
      '추가로 필요한 정보': rawString(finding?.uncertainty),
    };
  }

  function buildRows(runs, options) {
    const uniqueRuns = dedupeRuns(runs);
    const rows = [];
    for (let i = 0; i < uniqueRuns.length; i++) {
      const norm = normalizeRun(uniqueRuns[i], i);
      for (let j = 0; j < norm.findings.length; j++) {
        rows.push(findingToRow(norm, norm.findings[j], j, options));
      }
    }
    return rows;
  }

  function serializeRows(rows) {
    const lines = [HEADER_LINE];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      lines.push(COLUMNS.map(col => csvCell(row[col])).join(','));
    }
    return BOM + lines.join(CRLF) + CRLF;
  }

  function toCsv(runs, options) {
    return serializeRows(buildRows(runs, options));
  }

  function resolveExportCondition(condition, selectedRuns) {
    if (condition) return condition;
    for (let i = 0; i < selectedRuns.length; i++) {
      const code = extractStudyConditionCode(selectedRuns[i]?.condition);
      if (code) return code;
    }
    return '';
  }

  function buildExport(runs, options) {
    const opts = options || {};
    const selectedRuns = dedupeRuns(runs);
    const participant = cleanString(opts.participant);
    const condition = cleanString(opts.condition);
    const rows = buildRows(selectedRuns, { participant, condition });
    return {
      csv: serializeRows(rows),
      filename: buildFilename(participant, resolveExportCondition(condition, selectedRuns)),
      participant,
      condition,
      runs: selectedRuns,
      rows,
      findingCount: rows.length,
    };
  }

  function safeReceiptUrl(value) {
    const text = cleanString(value);
    if (!text) return '';
    try {
      const u = new URL(text);
      if (u.username || u.password) return '';
      const localHttp =
        u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
      return u.protocol === 'https:' || localHttp ? u.href : '';
    } catch {
      return '';
    }
  }

  function loadProfile(storage) {
    if (!storage || typeof storage.getItem !== 'function') return { participant: '', condition: '' };
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      return {
        participant: cleanString(parsed?.participant),
        condition: cleanString(parsed?.condition),
      };
    } catch {
      return { participant: '', condition: '' };
    }
  }

  function saveProfile(storage, profile) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          participant: cleanString(profile?.participant),
          condition: cleanString(profile?.condition),
        })
      );
      return true;
    } catch {
      return false;
    }
  }

  function scheduleRevoke(view, urlApi, url) {
    if (typeof urlApi.revokeObjectURL !== 'function') return;
    const timerApi = view?.setTimeout || root.setTimeout;
    if (typeof timerApi === 'function') {
      const timer = timerApi(() => urlApi.revokeObjectURL(url), 1000);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } else {
      urlApi.revokeObjectURL(url);
    }
  }

  function triggerDownload(doc, csv, filename) {
    const view = doc?.defaultView || root;
    const BlobCtor = view?.Blob || root.Blob;
    const urlApi = view?.URL || root.URL;
    if (typeof BlobCtor !== 'function' || typeof urlApi?.createObjectURL !== 'function') {
      throw new Error('이 환경에서는 파일 다운로드를 시작할 수 없습니다.');
    }
    const blob = new BlobCtor([csv], { type: 'text/csv;charset=utf-8' });
    const url = urlApi.createObjectURL(blob);
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename;
    if (typeof link.click === 'function') link.click();
    scheduleRevoke(view, urlApi, url);
  }

  function makeEl(doc, tag, text) {
    const node = doc.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createTextInput(doc, labelText, field, placeholder, value) {
    const label = makeEl(doc, 'label', labelText);
    const input = makeEl(doc, 'input');
    input.type = 'text';
    input.maxLength = 64;
    input.placeholder = placeholder;
    input.setAttribute('data-w8-field', field);
    input.setAttribute('aria-label', labelText);
    input.value = value;
    label.append(input);
    return { label, input };
  }

  function createTeamControls(doc, actions) {
    const submitBtn = makeEl(doc, 'button', '팀에 제출');
    submitBtn.type = 'button';
    submitBtn.className = 'button secondary';
    submitBtn.setAttribute('data-w8-action', 'submit');
    actions.append(submitBtn);

    const disclosure = makeEl(doc, 'p', '');
    disclosure.className = 'muted';
    disclosure.setAttribute('data-w8-disclosure', 'true');

    const receiptBox = makeEl(doc, 'div');
    receiptBox.setAttribute('data-w8-receipt', 'true');

    return { submitBtn, disclosure, receiptBox };
  }

  function createPanelDom(doc, saved, opts, hasSubmit) {
    const section = makeEl(doc, 'section');
    section.className = 'role-step ledger-section w8-csv';
    section.setAttribute('data-w8-csv', 'true');
    section.hidden = true;

    const fields = makeEl(doc, 'div');
    fields.className = 'red-settings';
    const pField = createTextInput(
      doc,
      '참가자 이름',
      'participant',
      '예: 홍길동',
      saved.participant || cleanString(opts.participant)
    );
    pField.input.autocomplete = 'name';
    const cField = createTextInput(
      doc,
      'W8 조건',
      'condition',
      '예: A, B (비우면 실행별 조건 유지)',
      saved.condition || cleanString(opts.condition) || DEFAULT_CONDITION
    );
    fields.append(pField.label, cField.label);

    const runsFieldset = makeEl(doc, 'fieldset');
    const runsList = makeEl(doc, 'div');
    runsList.setAttribute('data-w8-runs', 'true');
    runsFieldset.append(makeEl(doc, 'legend', '포함할 BLUE 실행'), runsList);

    const summary = makeEl(doc, 'p', '');
    summary.className = 'muted';
    summary.setAttribute('data-w8-summary', 'true');

    const actions = makeEl(doc, 'div');
    actions.className = 'button-row';
    const downloadBtn = makeEl(doc, 'button', 'CSV 다운로드');
    downloadBtn.type = 'button';
    downloadBtn.className = 'button primary';
    downloadBtn.setAttribute('data-w8-action', 'download');
    actions.append(downloadBtn);

    const team = hasSubmit ? createTeamControls(doc, actions) : { submitBtn: null, disclosure: null, receiptBox: null };

    const status = makeEl(doc, 'p', '');
    status.className = 'form-feedback';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('data-w8-status', 'true');

    section.append(makeEl(doc, 'h3', 'W8 CSV 내보내기'), fields, runsFieldset, summary, actions);
    if (team.disclosure) section.append(team.disclosure, team.receiptBox);
    section.append(status);

    return {
      section,
      participantInput: pField.input,
      conditionInput: cField.input,
      runsList,
      summary,
      downloadBtn,
      submitBtn: team.submitBtn,
      disclosure: team.disclosure,
      receiptBox: team.receiptBox,
      status,
    };
  }

  function setStatusMessage(statusEl, message, isError) {
    statusEl.textContent = message || '';
    if (typeof statusEl.classList?.toggle === 'function') {
      statusEl.classList.toggle('error', Boolean(isError));
    } else {
      statusEl.className = isError ? 'form-feedback error' : 'form-feedback';
    }
  }

  function makeReceiptLink(doc, href, label, kind) {
    const a = makeEl(doc, 'a', label);
    a.className = 'text-link';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.setAttribute('data-w8-link', kind);
    return a;
  }

  function renderReceiptLinks(doc, receiptBox, receipt) {
    if (!receiptBox) return false;
    receiptBox.replaceChildren();
    const pageUrl = safeReceiptUrl(receipt?.pageUrl);
    const issueUrl = safeReceiptUrl(receipt?.issueUrl);
    const links = [];
    if (pageUrl) links.push(makeReceiptLink(doc, pageUrl, 'Confluence 기록 열기', 'page'));
    if (issueUrl) links.push(makeReceiptLink(doc, issueUrl, 'Jira 이슈 열기', 'issue'));
    if (links.length === 2) receiptBox.append(links[0], makeEl(doc, 'span', ' · '), links[1]);
    else if (links.length === 1) receiptBox.append(links[0]);
    return links.length > 0;
  }

  function formatRunLabel(norm) {
    const parts = ['실행 ' + norm.runNumber, norm.detector || 'BLUE', norm.model || '모델 미기록'];
    if (norm.condition) parts.push('조건 ' + norm.condition);
    parts.push('지적 ' + norm.findings.length + '건');
    return parts.join(' · ');
  }

  function countSelectionStats(selected) {
    let findingCount = 0;
    let unmatchedCount = 0;
    for (let i = 0; i < selected.length; i++) {
      const list = selected[i].findings;
      findingCount += list.length;
      for (let j = 0; j < list.length; j++) {
        if (!resolvePhysicalPage(list[j], selected[i].raw)) unmatchedCount++;
      }
    }
    return { findingCount, unmatchedCount };
  }

  function formatSummaryText(selectedCount, stats, filename) {
    if (!selectedCount) return '내보낼 실행을 1개 이상 선택하세요.';
    const unmatched = stats.unmatchedCount ? ' (위치 미확정 ' + stats.unmatchedCount + '건 포함)' : '';
    return '선택 실행 ' + selectedCount + '건 · 지적 ' + stats.findingCount + '건' + unmatched + ' · 파일명 ' + filename;
  }

  function formatDisclosureText(selectedCount, findingCount) {
    return (
      '선택한 실행 ' +
      selectedCount +
      '건의 지적 ' +
      findingCount +
      '건(CSV·원문 인용·근거)을 Falsify 팀 공간과 FLS-18에 제출합니다. ' +
      '개인 PDF 원본·RED 정답지·인증 키는 전송하지 않고 이 기기에만 남습니다.'
    );
  }

  function readRunsFromSource(runsOption, eventDetail) {
    if (typeof runsOption === 'function') {
      try {
        const list = runsOption();
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }
    if (Array.isArray(eventDetail?.runs)) return eventDetail.runs;
    return Array.isArray(runsOption) ? runsOption : [];
  }

  function reconcileSelection(nextNorm, knownKeys, selectedKeys) {
    const nextSelected = new Set();
    for (let i = 0; i < nextNorm.length; i++) {
      const key = nextNorm[i].key;
      if (!knownKeys.has(key) || selectedKeys.has(key)) nextSelected.add(key);
    }
    return nextSelected;
  }

  function removeNode(node) {
    if (typeof node.remove === 'function') node.remove();
    else if (typeof node.parentNode?.removeChild === 'function') node.parentNode.removeChild(node);
  }

  function mount(host, options) {
    const opts = options || {};
    const doc = opts.document || host?.ownerDocument || root.document;
    if (!host || !doc) return null;

    if (mountedHosts?.has(host)) mountedHosts.get(host).destroy();

    const storage = opts.storage !== undefined ? opts.storage : root.localStorage;
    const saved = loadProfile(storage);
    const ui = createPanelDom(doc, saved, opts, typeof opts.onSubmit === 'function');
    host.append(ui.section);

    const state = {
      runs: [],
      knownKeys: new Set(),
      selectedKeys: new Set(),
      conditionTouched: Boolean(saved.condition || cleanString(opts.condition)),
      submitting: false,
      destroyed: false,
    };

    const getSelectedNorm = () => state.runs.filter(r => state.selectedKeys.has(r.key));
    const getSelectedRuns = () => getSelectedNorm().map(r => r.raw);
    const persistInputs = () => saveProfile(storage, { participant: ui.participantInput.value, condition: ui.conditionInput.value });

    function getPayload() {
      const built = buildExport(getSelectedRuns(), {
        participant: ui.participantInput.value,
        condition: ui.conditionInput.value,
      });
      return {
        csv: built.csv,
        filename: built.filename,
        participant: built.participant,
        runs: built.runs,
        condition: built.condition,
      };
    }

    function updateView() {
      const hasRuns = state.runs.length > 0;
      ui.section.hidden = !hasRuns;
      const selected = getSelectedNorm();
      const stats = countSelectionStats(selected);
      const fileCond = resolveExportCondition(cleanString(ui.conditionInput.value), selected.map(r => r.raw));
      ui.summary.textContent = hasRuns ? formatSummaryText(selected.length, stats, buildFilename(ui.participantInput.value, fileCond)) : '';
      ui.downloadBtn.disabled = selected.length === 0;
      if (ui.submitBtn) ui.submitBtn.disabled = state.submitting || selected.length === 0;
      if (ui.disclosure) ui.disclosure.textContent = formatDisclosureText(selected.length, stats.findingCount);
    }

    function renderRunCheckboxes() {
      ui.runsList.replaceChildren();
      for (let i = 0; i < state.runs.length; i++) {
        const norm = state.runs[i];
        const row = makeEl(doc, 'label');
        row.className = 'check-row';
        const box = makeEl(doc, 'input');
        box.type = 'checkbox';
        box.checked = state.selectedKeys.has(norm.key);
        box.setAttribute('data-w8-run-id', norm.id || norm.key);
        box.addEventListener('change', () => {
          if (box.checked) state.selectedKeys.add(norm.key);
          else state.selectedKeys.delete(norm.key);
          updateView();
        });
        row.append(box, makeEl(doc, 'span', formatRunLabel(norm)));
        ui.runsList.append(row);
      }
    }

    function refresh(eventDetail) {
      if (state.destroyed) return;
      const nextNorm = dedupeRuns(readRunsFromSource(opts.runs, eventDetail)).map((run, idx) => normalizeRun(run, idx));
      state.selectedKeys = reconcileSelection(nextNorm, state.knownKeys, state.selectedKeys);
      state.knownKeys = new Set(nextNorm.map(r => r.key));
      state.runs = nextNorm;
      if (!state.conditionTouched && nextNorm.length && extractStudyConditionCode(nextNorm[0].condition)) {
        ui.conditionInput.value = nextNorm[0].condition;
        state.conditionTouched = true;
      }
      renderRunCheckboxes();
      updateView();
    }

    function requireParticipant() {
      if (cleanString(ui.participantInput.value)) {
        persistInputs();
        return true;
      }
      setStatusMessage(ui.status, '참가자 이름을 입력하세요.', true);
      if (typeof ui.participantInput.focus === 'function') ui.participantInput.focus();
      return false;
    }

    function onDownload() {
      if (!requireParticipant()) return;
      const payload = getPayload();
      if (!payload.runs.length) {
        setStatusMessage(ui.status, '내보낼 실행을 1개 이상 선택하세요.', true);
        return;
      }
      try {
        if (typeof opts.download === 'function') opts.download(payload);
        else triggerDownload(doc, payload.csv, payload.filename);
        const count = countSelectionStats(getSelectedNorm()).findingCount;
        setStatusMessage(ui.status, payload.filename + ' 저장됨 · 실행 ' + payload.runs.length + '건 · 지적 ' + count + '건', false);
      } catch (err) {
        setStatusMessage(ui.status, 'CSV를 저장하지 못했습니다: ' + (err?.message || String(err)), true);
      }
    }

    async function onTeamSubmit() {
      if (state.submitting || !requireParticipant()) return;
      const payload = getPayload();
      if (!payload.runs.length) return;
      state.submitting = true;
      if (ui.receiptBox) ui.receiptBox.replaceChildren();
      updateView();
      setStatusMessage(ui.status, '팀에 제출하는 중...', false);
      try {
        const result = await opts.onSubmit(payload);
        if (state.destroyed) return;
        const hasLinks = renderReceiptLinks(doc, ui.receiptBox, result);
        const errMsg = cleanString(result?.error);
        if (errMsg) setStatusMessage(ui.status, errMsg + ' 같은 CSV는 위 버튼으로 바로 다운로드할 수 있습니다.', true);
        else setStatusMessage(ui.status, hasLinks ? '팀 제출 완료 · 아래 링크에서 확인할 수 있습니다.' : '팀 제출을 완료했습니다.', false);
      } catch (err) {
        if (state.destroyed) return;
        const msg = cleanString(err?.message) || '팀 제출에 실패했습니다.';
        setStatusMessage(ui.status, msg + ' 같은 CSV는 위 버튼으로 바로 다운로드할 수 있습니다.', true);
      } finally {
        state.submitting = false;
        if (!state.destroyed) updateView();
      }
    }

    const onParticipantInput = () => { persistInputs(); updateView(); };
    const onConditionInput = () => { state.conditionTouched = true; persistInputs(); updateView(); };
    ui.participantInput.addEventListener('input', onParticipantInput);
    ui.participantInput.addEventListener('change', onParticipantInput);
    ui.conditionInput.addEventListener('input', onConditionInput);
    ui.conditionInput.addEventListener('change', onConditionInput);
    ui.downloadBtn.addEventListener('click', onDownload);
    if (ui.submitBtn) ui.submitBtn.addEventListener('click', onTeamSubmit);

    const onRunsChange = event => refresh(event?.detail);
    if (typeof doc.addEventListener === 'function') doc.addEventListener(RUNS_CHANGE_EVENT, onRunsChange);
    refresh();

    const controller = {
      element: ui.section,
      refresh: () => refresh(),
      getSelectedRuns,
      getPayload,
      destroy() {
        if (state.destroyed) return;
        state.destroyed = true;
        if (typeof doc.removeEventListener === 'function') doc.removeEventListener(RUNS_CHANGE_EVENT, onRunsChange);
        removeNode(ui.section);
        if (mountedHosts?.get(host) === controller) mountedHosts.delete(host);
      },
    };

    if (mountedHosts) mountedHosts.set(host, controller);
    return controller;
  }

  return {
    BOM,
    CRLF,
    COLUMNS,
    HEADER_LINE,
    STORAGE_KEY,
    EVENTS: Object.freeze({ RUNS_CHANGE: RUNS_CHANGE_EVENT }),
    csvCell,
    triggerDownload,
    buildFilename,
    dedupeRuns,
    normalizeRun,
    formatEvidenceCell,
    findingToRow,
    buildRows,
    toCsv,
    buildExport,
    mount,
  };
});
