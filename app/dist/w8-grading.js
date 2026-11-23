/* RED answers stay in the participant's browser. Join them only after a BLUE run. */
(function (root) {
  'use strict';
  const key = hash => 'falsify.w8.grading.' + hash;
  const labels = [['pending', '미채점'], ['detected', '적발'], ['partial', '부분 적발'], ['missed', '미검출']];
  const badges = {
    pending: { text: '미채점', kind: 'excluded' },
    detected: { text: 'AI가 찾음', kind: 'caught' },
    partial: { text: '근처를 짚음', kind: 'partial' },
    missed: { text: 'AI가 놓침', kind: 'missed' }
  };
  function load(hash) {
    const raw = localStorage.getItem(key(hash));
    return raw ? JSON.parse(raw) : {edits: [], decisions: {}};
  }
  function capture(hash, edits) {
    if (!edits.length) return;
    const entry = load(hash);
    if (entry.edits.length) return;
    entry.edits = edits.map(({id, pageIndex, originalText, newText}) => ({id, pageIndex, originalText, newText}));
    localStorage.setItem(key(hash), JSON.stringify(entry));
  }
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function emitGradingChange(fileHash, runId) {
    if (typeof document.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
    try { document.dispatchEvent(new CustomEvent('falsify:w8-grading-change', { detail: { fileHash, runId } })); } catch {}
  }
  function buildDiff(before, after) {
    const p = element('p', undefined, 'booth-diff');
    const diffFn = root.FalsifyBooth?.diffParts;
    if (typeof diffFn === 'function') {
      const parts = diffFn(before || '', after || '');
      if (parts.lead) p.append(element('span', parts.lead.replace(/\s+/g, ' '), 'ctx'));
      if (parts.removed) p.append(element('del', parts.removed.replace(/\s+/g, ' '), 'del'));
      p.append(parts.added
        ? element('ins', parts.added.replace(/\s+/g, ' '), 'ins')
        : element('ins', '(지움)', 'ins gone'));
      if (parts.tail) p.append(element('span', parts.tail.replace(/\s+/g, ' '), 'ctx'));
      return p;
    }
    p.append(element('del', before || ''), ' ', element('ins', after || '(지움)'));
    return p;
  }
  function applyBadge(node, verdict) {
    const info = badges[verdict] || badges.pending;
    node.className = 'booth-edit-verdict ' + info.kind;
    node.textContent = info.text;
  }
  function selector(label, choices, value, change) {
    const row = element('label', label, 'w8-grading-select-row');
    const select = element('select');
    for (const [id, text] of choices) select.add(new Option(text, id));
    select.value = value;
    select.addEventListener('change', () => change(select.value));
    row.append(select);
    return row;
  }
  function renderRun(run, entry, status) {
    const card = element('section', undefined, 'w8-grading-run');
    card.append(element('h4', [run.detector, run.model, '실행 ' + run.runNumber].filter(Boolean).join(' · '), 'booth-klab w8-grading-run-head'));
    const total = entry.edits.length;
    entry.edits.forEach((edit, index) => {
      const row = element('section', undefined, 'booth-declared-item w8-grading-item');
      const pageText = (edit.pageIndex + 1) + '쪽';
      const labelText = total > 1 ? '결함 ' + (index + 1) + ' · ' + pageText : pageText;
      const head = element('div', undefined, 'booth-declared-head');
      const badge = element('span', '', 'booth-edit-verdict excluded');
      head.append(element('strong', labelText, 'booth-klab'), badge);
      row.append(head, buildDiff(edit.originalText, edit.newText));
      const read = () => load(run.fileHash).decisions[JSON.stringify([run.id,edit.id])] || {};
      function save(field, value) {
        try {
          const current = load(run.fileHash);
          const id = JSON.stringify([run.id,edit.id]);
          current.decisions[id] = {...current.decisions[id], [field]: value};
          localStorage.setItem(key(run.fileHash), JSON.stringify(current));
          status.textContent = '이 기기에 채점을 저장했습니다.';
          emitGradingChange(run.fileHash, run.id);
        } catch { status.textContent = '이 기기에 채점을 저장하지 못했습니다.'; }
      }
      const saved = read();
      const initialVerdict = saved.verdict || 'pending';
      applyBadge(badge, initialVerdict);
      row.append(selector('판정', labels, initialVerdict, v => {
        applyBadge(badge, v);
        save('verdict', v);
      }));
      if (run.findings.length) {
        const options = element('details', undefined, 'w8-grading-links');
        options.append(element('summary', '관련 BLUE 지적'));
        for (const finding of run.findings) {
          const label = element('label', undefined, 'w8-grading-link-opt');
          const box = element('input');
          box.type = 'checkbox';
          box.checked = (saved.links || []).includes(finding.id);
          box.addEventListener('change', () => {
            const links = new Set(read().links || []);
            if (box.checked) links.add(finding.id);
            else links.delete(finding.id);
            save('links', [...links]);
          });
          label.append(box, ' ', String(finding.id), ' · ', finding.quote || finding.rationale || '');
          options.append(label);
        }
        row.append(options);
      }
      card.append(row);
    });
    return card;
  }
  function mount(host, runs) {
    const details = element('details', undefined, 'booth-panel w8-grading-panel');
    details.append(element('summary', '내가 심은 결함과 비교', 'w8-grading-summary'));
    const body = element('div', undefined, 'w8-grading-body');
    const status = element('p', undefined, 'booth-feedback w8-grading-status');
    status.setAttribute('role', 'status');
    details.append(body, status);
    host.append(details);
    function render() {
      try {
        const eligible = runs().map(run => ({run, entry: load(run.fileHash)})).filter(({entry}) => entry.edits.length);
        host.hidden = !eligible.length;
        body.replaceChildren();
        status.textContent = '';
        if (details.open) for (const {run, entry} of eligible) body.append(renderRun(run, entry, status));
      } catch { host.hidden = true; }
    }
    details.addEventListener('toggle', render);
    document.addEventListener('falsify:w8-runs-change', render);
    render();
  }
  root.FalsifyW8Grading = {capture, mount};
})(window);
