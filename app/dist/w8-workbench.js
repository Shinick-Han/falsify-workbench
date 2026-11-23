/* The W8 entry keeps ordinary PDF, BLUE and archive engines on their native mounts. */
(function () {
  'use strict';
  const byId = id => document.getElementById(id);

  function mountArchive(paper) {
    const links = window.FalsifyW8PaperLinks;
    const notice = byId('w8-archive-status');
    let active = null;
    let timer;
    function eligible(doc) { return !!doc && active === doc && doc.enabled; }
    function setAnchor(id, url) {
      const node = byId(id);
      node.hidden = !url;
      if (url) node.href = url;
      else node.removeAttribute('href');
    }
    function paint(doc) {
      if (active !== doc) return;
      const original = links.url(doc.hash);
      const revision = doc.revision && links.url(doc.revision);
      setAnchor('w8-source-link', doc.enabled && original);
      setAnchor('w8-revision-link', doc.enabled && revision);
      byId('w8-archive-action').textContent = doc.needsRevoke ? '링크 해제 다시 시도' : doc.enabled ? '링크 끄기' : '링크 저장';
      byId('w8-archive-retry').hidden = !doc.failed || !doc.enabled;
      notice.textContent = doc.message;
    }
    function remember(doc) {
      try { localStorage.setItem('falsify.w8.share.' + doc.hash, doc.needsRevoke ? 'revoking' : doc.enabled ? 'on' : 'off'); } catch {}
    }
    function savedPreference(hash) {
      try { return localStorage.getItem('falsify.w8.share.' + hash); } catch { return null; }
    }
    function recentLinkHashes(hash) {
      try {
        const saved = JSON.parse(sessionStorage.getItem('falsify.w8.link-hashes.' + hash));
        return new Set([hash, ...saved]);
      } catch { return new Set([hash]); }
    }
    function rememberHashes(doc) {
      try { sessionStorage.setItem('falsify.w8.link-hashes.' + doc.hash, JSON.stringify([...doc.hashes])); } catch {}
    }
    function track(doc, file, hash) {
      const job = links.ensure(file, hash);
      doc.pending.add(job);
      doc.hashes.add(hash);
      rememberHashes(doc);
      return job.finally(() => doc.pending.delete(job));
    }
    async function original(doc) {
      if (!eligible(doc)) return '';
      return track(doc, doc.file, doc.hash);
    }
    function failureMessage(error) {
      const reason = error.status === 507 ? 'Workbench 보관함의 2TB 한도에 도달했어요.'
        : error.status === 413 ? '이 PDF는 링크 저장 한도인 32MiB를 넘어요.'
        : error.status === 429 ? '지금은 공유 링크 요청이 많아요. 잠시 후 다시 시도해 주세요.'
        : 'Drive에 저장하지 못했어요.';
      return reason + ' 이 기기에서 계속 편집하고 PDF를 다운로드할 수 있어요.';
    }
    async function save(doc, includeEdits) {
      if (!eligible(doc)) return;
      const generation = ++doc.generation;
      doc.message = 'Drive에 저장하는 중…';
      paint(doc);
      try {
        await original(doc);
        if (!eligible(doc) || generation !== doc.generation) return;
        if (includeEdits) {
          const art = await paper.artifact();
          if (!eligible(doc) || art.sourceSha256 !== doc.hash || generation !== doc.generation) return;
          await track(doc, art.file, art.sha256);
          if (!eligible(doc) || generation !== doc.generation) return;
          doc.revision = art.sha256;
        }
        doc.failed = false;
        doc.message = includeEdits ? '원문과 수정본을 저장했어요.' : '원문을 저장했어요.';
      } catch (error) {
        if (!eligible(doc) || generation !== doc.generation) return;
        doc.failed = true;
        doc.message = failureMessage(error);
      }
      paint(doc);
    }
    function edited() {
      const doc = active;
      if (!eligible(doc)) return;
      ++doc.generation;
      doc.revision = '';
      clearTimeout(timer);
      paint(doc);
      timer = setTimeout(() => void save(doc, paper.state().hasEdits), 700);
    }
    async function beforeSwitch() {
      const doc = active;
      if (!eligible(doc) || !paper.state().hasEdits) return;
      try {
        const art = await paper.artifact();
        if (eligible(doc) && art.sourceSha256 === doc.hash) void track(doc, art.file, art.sha256).catch(() => {});
      } catch {}
    }
    function show(file, hash, opened, fromHistory) {
      clearTimeout(timer);
      const pref = savedPreference(hash);
      const enabled = !fromHistory && (pref === 'on' || (opened && pref === null));
      active = {file, hash, enabled, generation:0, revision:'', hashes:recentLinkHashes(hash), needsRevoke:pref === 'revoking', pending:new Set(), failed:false, message:''};
      if (enabled) { remember(active); void save(active, paper.state().hasEdits); }
      else { active.message = active.needsRevoke ? '공유 링크 해제를 다시 시도할 수 있어요.' : '이 논문은 이 기기에 저장되어 있어요.'; paint(active); }
    }
    async function change() {
      const doc = active;
      if (!doc) return;
      if (!doc.enabled && !doc.needsRevoke) {
        doc.enabled = true; doc.failed = false; remember(doc);
        await save(doc, paper.state().hasEdits);
        return;
      }
      const button = byId('w8-archive-action');
      button.disabled = true;
      doc.enabled = false; doc.needsRevoke = true; remember(doc); clearTimeout(timer);
      doc.message = '공유 링크를 끄는 중…'; paint(doc);
      try {
        await Promise.allSettled(doc.pending);
        await Promise.all([...doc.hashes].map(hash => links.revoke(hash)));
        doc.needsRevoke = false; remember(doc); doc.hashes.clear(); rememberHashes(doc);
        doc.message = '이 탭에서 만든 공유 링크를 껐어요. Drive 보관본은 유지됩니다.';
      } catch { doc.message = '링크 해제를 마치지 못했어요. 다시 눌러 주세요.'; }
      finally { button.disabled = false; paint(doc); }
    }
    byId('w8-archive-retry').addEventListener('click', () => void save(active, paper.state().hasEdits));
    byId('w8-archive-action').addEventListener('click', () => void change());
    window.addEventListener('online', () => { if (active?.failed) void save(active, paper.state().hasEdits); });
    return {
      show, edited, beforeSwitch,
      enabled: () => !!active?.enabled,
      original: hash => active?.hash === hash ? original(active) : Promise.resolve(''),
      async revision(art) {
        const doc = active;
        if (!eligible(doc)) return '';
        const current = await paper.artifact();
        if (!eligible(doc) || current.sha256 !== art.sha256) return '';
        return track(doc, current.file, current.sha256);
      }
    };
  }

  function start() {
    const paper = window.FalsifyW8Paper;
    const archive = mountArchive(paper);
    window.FalsifyW8Archive = archive;
    const session = byId('w8-session');
    const status = byId('w8-status');
    const fileInput = byId('w8-file');
    const editor = byId('booth-step-edit');
    const review = byId('w8-review');
    const blue = window.FalsifyW8Blue;
    const paperSync = window.FalsifyW8PaperSync?.mount({
      paper,
      blue,
      team: window.FalsifyW8Team
    }) || null;
    if (paperSync) window.FalsifyW8Sync = paperSync;
    let opening = false;
    let activeArxiv = null;
    let reviewHash = '';
    let library = null;
    document.addEventListener('falsify:w8-runs-change', event => {
      reviewHash = event.detail.fileHash;
      review.removeAttribute('aria-busy');
    });

    byId('w8-editor').append(byId('paper-workspace'));
    function viewKey(hash) { return 'falsify.w8.view.' + hash; }
    function lastReview(hash) {
      try { return localStorage.getItem(viewKey(hash)) === 'review'; } catch { return false; }
    }
    function showStep(step) {
      const picking = step === 'pick';
      session.hidden = picking;
      byId('w8-intake').hidden = !picking;
      byId('w8-return').hidden = !paper.state().ready;
      editor.hidden = step !== 'edit';
      review.hidden = step !== 'review';
      document.documentElement.dataset.boothStep = step;
      for (const item of document.querySelectorAll('.booth-desk-steps [data-step]')) {
        const current = item.dataset.step === step;
        item.classList.toggle('on', current);
        if (current) item.setAttribute('aria-current', 'step');
        else item.removeAttribute('aria-current');
      }
    }
    function showReview(active) {
      showStep(active ? 'review' : 'edit');
      byId('w8-review-tab').toggleAttribute('aria-current', active);
      byId('w8-edit-tab').toggleAttribute('aria-current', !active);
      byId(active ? 'w8-review-tab' : 'w8-edit-tab').setAttribute('aria-current', 'page');
      const hash = paper.state().sourceSha256;
      if (hash) {
        history.replaceState({...history.state, w8Paper: hash}, '');
        try { localStorage.setItem(viewKey(hash), active ? 'review' : 'edit'); } catch {}
      }
      if (active) {
        if (!reviewHash || reviewHash !== paper.state().artifact?.sha256) review.setAttribute('aria-busy', 'true');
        void blue.refresh().then(() => review.removeAttribute('aria-busy')).catch(error => {
          status.textContent = error.message;
          review.removeAttribute('aria-busy');
        });
      }
    }
    function busy(value) {
      opening = value;
      for (const id of ['w8-open', 'w8-example', 'w8-download', 'w8-review-tab', 'w8-edit-tab', 'w8-recent-paper', 'w8-choose', 'w8-return']) byId(id).disabled = value;
      library?.setBusy?.(value);
    }
    function renderRecent() {
      const current = paper.state().sourceSha256;
      const saved = paper.recent().filter(item => item.hasSource && item.fileHash !== current);
      const select = byId('w8-recent-paper');
      select.replaceChildren(new Option('논문 선택', ''));
      for (const item of saved) select.add(new Option(item.name, item.fileHash));
      byId('w8-recent').hidden = !saved.length;
    }
    const historyDrafts = new Set();
    function isHistoryDraft(hash, source) {
      const key = 'falsify.w8.history-draft.' + hash;
      if (source === 'history') historyDrafts.add(hash);
      if (source === 'personal') historyDrafts.delete(hash);
      try {
        if (source === 'history') localStorage.setItem(key, '1');
        else if (source === 'personal') localStorage.removeItem(key);
        else if (localStorage.getItem(key) === '1') historyDrafts.add(hash);
      } catch {}
      return historyDrafts.has(hash);
    }

    function displaySource(file, example, entry, opened, titleOverride, source) {
      const sourceSha256 = paper.state().sourceSha256;
      const fromHistory = isHistoryDraft(sourceSha256, source);
      archive.show(file, sourceSha256, opened, fromHistory);
      activeArxiv = paper.arxivForPaper(sourceSha256, entry);
      document.dispatchEvent(new Event('falsify:w8-paper-origin'));
      const credit = activeArxiv && search.sourceLink(activeArxiv);
      const box = byId('w8-paper-credit');
      box.replaceChildren();
      if (credit) box.append(credit);
      box.hidden = !credit;
      const title = titleOverride || activeArxiv?.title || file.name;
      byId('w8-name').textContent = title;
      byId('w8-hint').hidden = !example;
      paperSync?.show(fromHistory ? {} : {file, sourceSha256, title, arxivId: activeArxiv?.id || '', opened});
      showReview(lastReview(sourceSha256));
      renderRecent();
    }
    async function open(load, example, entry, options = {}) {
      if (opening) return;
      busy(true);
      const previousName = byId('w8-name').textContent;
      const previousStep = document.documentElement.dataset.boothStep;
      status.textContent = '논문을 여는 중…';
      try {
        if (paper.state().ready) await paper.flushDraft();
        const file = await load();
        await Promise.all([archive.beforeSwitch(), paperSync?.beforeSwitch()]);
        showStep('edit');
        await paper.open(file, {restoreSaved:true});
        displaySource(file, example, entry, true, options.title, options.fromHistory ? 'history' : 'personal');
        byId('w8-name').focus();
        status.textContent = paper.state().resumable?.hasSource ? '' : '기기에 PDF를 저장할 수 없어요. 수정본은 다운로드할 수 있습니다.';
      } catch (error) {
        showStep(paper.state().ready ? previousStep : 'pick');
        byId('w8-name').textContent = previousName;
        status.textContent = error.message || 'PDF를 열지 못했습니다.';
      } finally { busy(false); }
    }
    async function resumeLocal(fileHash) {
      if (opening) return false;
      const saved = paper.recent().find(item => item.fileHash === fileHash && item.hasSource);
      if (!saved) return false;
      busy(true);
      const previousStep = document.documentElement.dataset.boothStep || 'pick';
      showStep('edit');
      try {
        if (paper.state().ready) {
          await paper.flushDraft();
          await Promise.all([archive.beforeSwitch(), paperSync?.beforeSwitch()]);
        }
        const resumed = await paper.resume({fileHash});
        if (!resumed) { showStep(paper.state().ready ? previousStep : 'pick'); return false; }
        displaySource(window.FalsifyPaperWorkspace.getSource().file, false, null, true);
        byId('w8-name').focus();
        status.textContent = '';
        return true;
      } catch (error) {
        showStep(paper.state().ready ? previousStep : 'pick');
        if (error?.code === 'missing_source') return false;
        throw error;
      } finally { busy(false); }
    }
    function selectCurrent() {
      showReview(false);
      byId('w8-name').focus();
    }
    async function resume(fileHash, opened = true) {
      busy(true);
      const previousStep = document.documentElement.dataset.boothStep || 'pick';
      if (paper.state().resumable?.hasSource || fileHash) showStep('edit');
      try {
        if (fileHash && paper.state().ready) {
          await paper.flushDraft();
          await Promise.all([archive.beforeSwitch(), paperSync?.beforeSwitch()]);
        }
        const resumed = await paper.resume({fileHash});
        if (resumed) displaySource(window.FalsifyPaperWorkspace.getSource().file, false, null, opened);
        else { showStep('pick'); renderRecent(); }
        status.textContent = '';
      } catch (error) {
        showStep(paper.state().ready ? previousStep : 'pick');
        status.textContent = error.message;
      } finally { busy(false); }
    }
    byId('w8-recent-paper').addEventListener('change', event => {
      if (event.target.value) void resume(event.target.value);
    });
    document.addEventListener('falsify:w8-paper-change', event => {
      if (event.detail.reason === 'edit') {
        archive.edited();
        paperSync?.edited();
      }
      byId('w8-download').textContent = paper.state().hasEdits ? '수정본 PDF 다운로드' : 'PDF 다운로드';
    });
    const search = window.FalsifyBooth.mountWorkbenchSearch(byId('w8-search'), (load, item) => {
      if (opening) return;
      if (paper.state().ready && activeArxiv?.id === item.id) {
        showReview(false);
        byId('w8-name').focus();
        return;
      }
      return open(load, false, item);
    });
    library = window.FalsifyW8Library?.mount({
      paper,
      paperSync,
      team: window.FalsifyW8Team,
      paperLinks: window.FalsifyW8PaperLinks,
      loadArxiv: item => search.load(item),
      openFile: (file, opts = {}) => open(() => file, false, opts.arxivEntry || null, {title: opts.title}),
      resumeLocal,
      selectCurrent,
      isBusy: () => opening
    }) || null;
    if (library) window.FalsifyW8LibraryInstance = library;
    window.FalsifyW8History?.mount({
      team: window.FalsifyW8Team,
      paperSync,
      openFile: (file, options = {}) => open(() => file, false, null, { title: options.title, fromHistory: true }),
    });
    const drop = byId('w8-drop');
    drop.addEventListener('dragover', event => { event.preventDefault(); drop.dataset.drag = 'true'; });
    drop.addEventListener('dragleave', () => { delete drop.dataset.drag; });
    drop.addEventListener('drop', event => {
      event.preventDefault();
      delete drop.dataset.drag;
      const file = event.dataTransfer.files[0];
      if (file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) void open(() => file, false);
      else status.textContent = 'PDF 파일을 선택해 주세요.';
    });
    byId('w8-open').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (file) void open(() => file, false);
    });
    byId('w8-example').addEventListener('click', () => open(async () => {
      const reply = await fetch('examples/seedling-growth.pdf');
      if (!reply.ok) throw new Error('예제 PDF를 불러오지 못했습니다.');
      return new File([await reply.blob()], 'Seedling growth.pdf', {type: 'application/pdf'});
    }, true));
    byId('w8-download').addEventListener('click', async event => {
      const button = event.currentTarget;
      button.disabled = true;
      status.textContent = 'PDF를 준비하는 중…';
      try { await paper.download(); status.textContent = ''; }
      catch (error) { status.textContent = error.message; }
      finally { button.disabled = false; }
    });
    byId('w8-edit-tab').addEventListener('click', () => showReview(false));
    byId('w8-review-tab').addEventListener('click', () => showReview(true));
    function choosePaper() {
      history.replaceState({...history.state, w8Paper: null}, '', location.hash === '#red' ? location.pathname + location.search : location.href);
      renderRecent();
      showStep('pick');
    }
    byId('w8-choose').addEventListener('click', () => {
      choosePaper();
      byId('w8-title').focus();
    });
    byId('w8-return').addEventListener('click', () => {
      showReview(lastReview(paper.state().sourceSha256));
      byId('w8-name').focus();
    });
    async function artifact() {
      if (!paper.state().ready) return null;
      const result = await paper.artifact();
      try { window.FalsifyW8Grading.capture(result.sha256, result.edits); }
      catch { status.textContent = '기기 저장 공간을 확인해 주세요. PDF 검수는 계속할 수 있습니다.'; }
      return {file: result.file, sha256: result.sha256, revision: result.revision};
    }
    blue.mount(byId('w8-blue'), {artifact});
    window.FalsifyW8RedKey?.mount(byId('w8-red-key-export'), {
      paper, onError: () => { status.textContent = '정답지 CSV를 다운로드하지 못했어요. 다시 눌러 주세요.'; }
    });
    window.FalsifyW8Csv.mount(byId('w8-csv'), {
      runs: () => blue.runs()
    });
    window.addEventListener('hashchange', () => {
      if (location.hash === '#red') choosePaper();
    });
    const saved = history.state?.w8Paper;
    if (saved && location.hash !== '#red') void resume(saved, false);
    else choosePaper();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
