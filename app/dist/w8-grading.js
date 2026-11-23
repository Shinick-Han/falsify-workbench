/* Compare the finished blind review with the answer key saved on this device. */
(function (root) {
  'use strict';
  const key = hash => 'falsify.w8.grading.' + hash;
  const badges = {
    pending: ['판정 보류', 'excluded'],
    detected: ['AI가 찾음', 'caught'],
    partial: ['근처를 짚음', 'partial'],
    missed: ['AI가 놓침', 'missed']
  };

  function load(hash, storage) {
    const value = JSON.parse(storage.getItem(key(hash)) || '{}');
    return { edits: value.edits || [], decisions: value.decisions || {} };
  }
  function capture(hash, edits) {
    if (!edits.length) return;
    const entry = load(hash, root.localStorage);
    if (entry.edits.length) return;
    entry.edits = edits.map(({id, pageIndex, originalText, newText}) => ({id, pageIndex, originalText, newText}));
    root.localStorage.setItem(key(hash), JSON.stringify(entry));
  }

  function canScore(run) {
    if (!Array.isArray(run.findings) || run.partial || (run.status && run.status !== 'ok')) return false;
    const coverage = run.coverage;
    if (coverage?.complete === false || coverage?.batchStatuses?.some(s => s !== 'ok')) return false;
    return !coverage?.resultCoverage?.rejectedItems?.some(item => ['model_abstain', 'model_refusal'].includes(item.code));
  }
  function unlocated(finding) {
    if (['rejected', 'unresolved'].includes(finding.status)) return false;
    return !Number.isInteger(finding.pageIndex) && !finding.evidence?.some(e => Number.isInteger(e.pageIndex));
  }
  function compare(run, edit, saved, scoreable) {
    let match = { verdict: 'pending', links: [] };
    if (scoreable) {
      match = root.FalsifyW8Matcher.match(edit, run.findings);
      if (match.verdict === 'missed' && run.findings.some(unlocated)) match.verdict = 'pending';
    }
    const verdict = Object.hasOwn(badges, saved.verdict) ? saved.verdict : match.verdict;
    const links = Array.isArray(saved.links) ? saved.links : match.links;
    return { edit, verdict, links, match, saved };
  }
  function results(run, storage) {
    if (!run?.fileHash || !storage) return [];
    let data;
    try { data = load(run.fileHash, storage); } catch { return []; }
    const scoreable = Boolean(root.FalsifyW8Matcher) && canScore(run);
    return data.edits.map(edit => {
      const saved = data.decisions[JSON.stringify([run.id, edit.id])] || {};
      return compare(run, edit, saved, scoreable);
    });
  }
  function summary(run, storage) {
    const rows = results(run, storage);
    if (!rows.length) return null;
    const counts = { total: rows.length, pending: 0, detected: 0, partial: 0, missed: 0 };
    for (const row of rows) counts[row.verdict]++;
    return counts;
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function diff(edit) {
    const line = element('p', undefined, 'booth-diff');
    line.append(element('del', edit.originalText), ' → ', element('ins', edit.newText || '(지움)'));
    return line;
  }
  function addEvidence(card, row, run) {
    for (const id of row.links) {
      const finding = run.findings.find(f => f.id === id);
      if (!finding) continue;
      const match = row.match.links.includes(id) ? row.match : {};
      const box = element('div', undefined, 'booth-edit-evidence');
      box.append(element('strong', 'BLUE 근거 · ' + id, 'booth-klab'));
      if (match.quote || finding.quote) box.append(element('blockquote', match.quote || finding.quote, 'booth-quote'));
      if (match.rationale || finding.rationale) box.append(element('p', match.rationale || finding.rationale, 'booth-small'));
      card.append(box);
    }
  }
  function save(run, edit, field, value, storage) {
    const data = load(run.fileHash, storage);
    const id = JSON.stringify([run.id, edit.id]);
    const decision = { ...data.decisions[id] };
    if (value === null) delete decision[field];
    else decision[field] = value;
    data.decisions[id] = decision;
    storage.setItem(key(run.fileHash), JSON.stringify(data));
    document.dispatchEvent(new CustomEvent('falsify:w8-grading-change', { detail: { fileHash: run.fileHash, runId: run.id } }));
  }
  function correction(row, run, storage) {
    const details = element('details', undefined, 'w8-grading-links');
    details.append(element('summary', '판정 보완'));
    const status = element('span', '', 'booth-feedback');
    status.setAttribute('role', 'status');
    function update(field, value) {
      try { save(run, row.edit, field, value, storage); }
      catch { status.textContent = '이 기기에 판정을 저장하지 못했어요.'; }
    }
    const label = element('label', '판정 ', 'w8-grading-select-row');
    const select = element('select');
    select.add(new Option('자동 판정', 'auto'));
    for (const [value, [text]] of Object.entries(badges)) select.add(new Option(text, value));
    select.value = row.saved.verdict || 'auto';
    select.addEventListener('change', () => update('verdict', select.value === 'auto' ? null : select.value));
    label.append(select);
    details.append(label, status);
    const active = new Set(row.links);
    for (const finding of run.findings) {
      const option = element('label', undefined, 'w8-grading-link-opt');
      const box = element('input');
      box.type = 'checkbox';
      box.checked = active.has(finding.id);
      box.addEventListener('change', () => {
        if (box.checked) active.add(finding.id);
        else active.delete(finding.id);
        update('links', [...active]);
      });
      option.append(box, ' ' + finding.id + ' · ' + (finding.quote || finding.rationale || '').slice(0, 100));
      details.append(option);
    }
    return details;
  }
  function renderCards(host, run, storage) {
    const rows = results(run, storage);
    const previous = [...host.children];
    host.replaceChildren();
    host.hidden = !rows.length;
    if (!rows.length) return;
    host.append(element('h3', '내가 심은 결함', 'booth-klab'));
    rows.forEach((row, index) => {
      const card = element('section', undefined, 'booth-declared-item w8-grading-item');
      const head = element('div', undefined, 'booth-declared-head');
      const [badge, kind] = badges[row.verdict];
      head.append(element('strong', '결함 ' + (index + 1) + ' · ' + (row.edit.pageIndex + 1) + '쪽', 'booth-klab'),
        element('span', badge, 'booth-edit-verdict ' + kind));
      card.append(head, diff(row.edit));
      addEvidence(card, row, run);
      const details = correction(row, run, storage);
      const previousCard = previous[index + 1];
      if (previousCard?.dataset.run === run.id && previousCard.querySelector('details')?.open) details.open = true;
      card.dataset.run = run.id;
      card.append(details);
      host.append(card);
    });
  }
  root.FalsifyW8Grading = { capture, summary, renderCards };
})(window);
