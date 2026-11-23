/* W8 shareable PDF link client (window.FalsifyW8PaperLinks).
   Uploads raw application/pdf bytes to PUT /v1/w8/paper-links/{sha} using the
   #w8-search API base and FalsifyHostedSession.forBase(base), caches base+sha
   links with expiry in sessionStorage, deduplicates concurrent uploads, and
   emits falsify:w8-pdf-link DOM events on save or revoke. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FalsifyW8PaperLinks = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';

  const VERSION = '1';
  const CACHE_PREFIX = 'falsify.w8-paper-link.v1:';
  const HEX_64 = /^[0-9a-f]{64}$/;
  const TOKEN_32_HEX = /^[0-9a-f]{32}$/;
  const HEADER_TOKEN_RE = /^[\x21-\x7e]{8,4096}$/;
  const CODE_RE = /^[a-z0-9_]{1,64}$/;
  const TIMEOUT_UPLOAD_MS = 60000;
  const TIMEOUT_REVOKE_MS = 20000;

  function isObj(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }
  function normalizeSha(value) {
    if (typeof value !== 'string') return '';
    const s = value.trim().toLowerCase();
    return HEX_64.test(s) ? s : '';
  }
  function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  }
  function parseBase(value, locationHref) {
    if (typeof value !== 'string' || !value) return '';
    try {
      const u = locationHref ? new URL(value, locationHref) : new URL(value);
      const allowed = u.protocol === 'https:' || (isLoopbackHost(u.hostname) && u.protocol === 'http:');
      if (!allowed || u.username || u.password || u.search || u.hash) return '';
      return u.origin + u.pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
  }
  function isArrayBuffer(value) {
    return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
  }
  function hasPdfMagic(bytes) {
    if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 5) return false;
    const limit = Math.min(bytes.byteLength, 1024);
    for (let i = 0; i <= limit - 5; i += 1) {
      if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44
        && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) {
        return true;
      }
    }
    return false;
  }
  async function readBytes(fileLike) {
    if (ArrayBuffer.isView(fileLike)) {
      return new Uint8Array(fileLike.buffer, fileLike.byteOffset, fileLike.byteLength).slice();
    }
    if (isArrayBuffer(fileLike)) return new Uint8Array(fileLike).slice();
    if (fileLike && ArrayBuffer.isView(fileLike.bytes)) {
      return new Uint8Array(fileLike.bytes.buffer, fileLike.bytes.byteOffset, fileLike.bytes.byteLength).slice();
    }
    if (fileLike && typeof fileLike.arrayBuffer === 'function') {
      return new Uint8Array(await fileLike.arrayBuffer());
    }
    return null;
  }
  async function sha256Hex(bytes, cryptoApi) {
    const subtle = cryptoApi?.subtle || root?.crypto?.subtle;
    if (!subtle || typeof subtle.digest !== 'function') {
      throw makeError('crypto_unavailable', 'SHA-256을 계산할 수 없습니다.');
    }
    const digest = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }
  function makeError(code, message, extra) {
    const err = new Error(message || code || 'paper link error');
    err.code = code || 'error';
    if (isObj(extra)) Object.assign(err, extra);
    return err;
  }
  function allowCode(value) {
    return typeof value === 'string' && CODE_RE.test(value) ? value : '';
  }
  function buildLinkUrl(base, token) {
    return base + '/v1/w8/paper-links/' + token + '.pdf';
  }
  function cacheKey(base, sha) {
    return CACHE_PREFIX + base + ':' + sha;
  }
  function driveIdOf(entry) {
    return typeof entry?.driveFileId === 'string' && /^[A-Za-z0-9_-]{10,180}$/.test(entry.driveFileId) ? entry.driveFileId : '';
  }
  function validStoredEntry(entry, base, sha, nowMs) {
    if (!isObj(entry)) return null;
    if (entry.apiBase !== base || entry.sha256 !== sha) return null;
    if (typeof entry.token !== 'string' || !TOKEN_32_HEX.test(entry.token)) return null;
    const expectedUrl = buildLinkUrl(base, entry.token);
    if (entry.url !== expectedUrl) return null;
    if (typeof entry.expiresAt !== 'string') return null;
    const expMs = Date.parse(entry.expiresAt);
    if (!Number.isFinite(expMs) || expMs <= nowMs) return null;
    return {
      apiBase: base,
      sha256: sha,
      token: entry.token,
      url: expectedUrl,
      ...(Object.hasOwn(entry, 'driveFileId') ? {driveFileId: driveIdOf(entry)} : {}),
      expiresAt: entry.expiresAt
    };
  }
  async function readJsonBody(res) {
    try {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
  function httpError(res, data) {
    const detail = isObj(data?.error) ? data.error : null;
    const code = allowCode(detail?.code) || ('http_' + (Number(res?.status) || 0));
    return makeError(code, 'HTTP ' + (Number(res?.status) || 0), {
      status: Number(res?.status) || 0,
      kind: 'http'
    });
  }
  function readSearchApiBase(doc) {
    if (!doc || typeof doc.getElementById !== 'function') return '';
    const el = doc.getElementById('w8-search');
    if (!el) return '';
    if (el.dataset && typeof el.dataset.apiBase === 'string' && el.dataset.apiBase) {
      return el.dataset.apiBase;
    }
    if (typeof el.getAttribute === 'function') {
      return el.getAttribute('data-api-base') || '';
    }
    return '';
  }

  function create(deps = {}) {
    const docOf = () => deps.document || root?.document || null;
    const storageOf = () => {
      if (Object.hasOwn(deps, 'sessionStorage')) return deps.sessionStorage;
      try { return root?.sessionStorage || null; } catch { return null; }
    };
    const fetchOf = () => deps.fetch || (typeof root?.fetch === 'function' ? (u, i) => root.fetch(u, i) : null);
    const cryptoOf = () => deps.crypto || root?.crypto || null;
    const abortOf = () => deps.AbortController || root?.AbortController || null;
    const nowOf = () => (typeof deps.now === 'function' ? deps.now() : Date.now());
    const setT = deps.setTimeout || ((fn, ms) => root.setTimeout(fn, ms));
    const clearT = deps.clearTimeout || (id => root.clearTimeout(id));
    const providerOf = () => {
      if (Object.hasOwn(deps, 'sessionProvider')) {
        return typeof deps.sessionProvider === 'function' ? deps.sessionProvider() : deps.sessionProvider;
      }
      return root?.FalsifyHostedSession || null;
    };

    const memCache = new Map();
    const inflight = new Map();
    const generations = new Map();
    const sessionsByBase = new Map();
    let lastProvider = null;

    function resolveApiBase() {
      const locHref = deps.locationHref || root?.location?.href || '';
      if (Object.hasOwn(deps, 'apiBase')) {
        const raw = typeof deps.apiBase === 'function' ? deps.apiBase() : deps.apiBase;
        return parseBase(raw, locHref);
      }
      return parseBase(readSearchApiBase(docOf()), locHref);
    }

    function sessionForBase(base) {
      const provider = providerOf();
      if (!provider) return null;
      if (provider !== lastProvider) {
        lastProvider = provider;
        sessionsByBase.clear();
      }
      if (sessionsByBase.has(base)) return sessionsByBase.get(base);
      const sess = typeof provider.forBase === 'function' ? provider.forBase(base) : provider;
      if (!sess || typeof sess.token !== 'function') return null;
      sessionsByBase.set(base, sess);
      return sess;
    }

    function dropEntry(key) {
      memCache.delete(key);
      const ss = storageOf();
      if (!ss || typeof ss.removeItem !== 'function') return;
      try { ss.removeItem(key); } catch {}
    }

    function writeEntry(key, entry) {
      memCache.set(key, entry);
      const ss = storageOf();
      if (!ss || typeof ss.setItem !== 'function') return;
      try { ss.setItem(key, JSON.stringify(entry)); } catch {}
    }

    function readEntry(base, sha) {
      const key = cacheKey(base, sha);
      const nowMs = nowOf();
      if (memCache.has(key)) {
        const valid = validStoredEntry(memCache.get(key), base, sha, nowMs);
        if (valid) return valid;
        dropEntry(key);
        return null;
      }
      const ss = storageOf();
      if (!ss || typeof ss.getItem !== 'function') return null;
      let raw = null;
      try { raw = ss.getItem(key); } catch { return null; }
      if (!raw) return null;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { dropEntry(key); return null; }
      const valid = validStoredEntry(parsed, base, sha, nowMs);
      if (!valid) {
        dropEntry(key);
        return null;
      }
      memCache.set(key, valid);
      return valid;
    }

    function emitLinkEvent(detail) {
      const doc = docOf();
      const EventCtor = deps.CustomEvent || root?.CustomEvent || (typeof CustomEvent === 'function' ? CustomEvent : null);
      if (!doc || typeof doc.dispatchEvent !== 'function' || !EventCtor) return;
      try {
        doc.dispatchEvent(new EventCtor('falsify:w8-pdf-link', { detail }));
      } catch {}
    }

    async function fetchBearerToken(session) {
      if (!session || typeof session.token !== 'function') {
        throw makeError('auth_required', 'PDF 링크 인증 세션을 사용할 수 없습니다.');
      }
      let token = '';
      try {
        const value = await session.token();
        token = typeof value === 'string' && HEADER_TOKEN_RE.test(value) ? value : '';
      } catch (err) {
        throw makeError(allowCode(err?.code) || 'auth_required', 'PDF 링크 인증 토큰을 받지 못했습니다.', {
          status: Number(err?.status) || 0,
          kind: 'auth'
        });
      }
      if (!token) {
        throw makeError('auth_required', 'PDF 링크 인증 토큰이 비어 있습니다.', { kind: 'auth' });
      }
      return token;
    }

    // WebKit 17 can leave fetch(DELETE) pending after the server confirms revocation.
    function browserDelete(url, opts) {
      return new Promise((resolve, reject) => {
        const request = new root.XMLHttpRequest();
        request.open('DELETE', url);
        request.timeout = opts.timeout;
        for (const [name, value] of Object.entries(opts.headers)) request.setRequestHeader(name, value);
        request.onload = () => {
          if (request.responseURL && request.responseURL !== url) {
            reject(makeError('unexpected_redirect', '링크 해제 주소가 달라졌습니다.'));
            return;
          }
          resolve({ ok: request.status >= 200 && request.status < 300, status: request.status,
            text: async () => request.responseText });
        };
        request.onerror = () => reject(makeError('network', '링크 해제 서버에 연결하지 못했습니다.'));
        request.ontimeout = () => reject(makeError('timeout', '링크 해제 응답 시간이 초과됐습니다.'));
        request.send();
      });
    }

    async function rawFetch(url, opts) {
      if (opts.method === 'DELETE' && !deps.fetch && typeof root?.XMLHttpRequest === 'function') return browserDelete(url, opts);
      const fetchImpl = fetchOf();
      if (typeof fetchImpl !== 'function') {
        throw makeError('fetch_unavailable', '네트워크 요청을 보낼 수 없습니다.', { kind: 'config' });
      }
      const Abort = abortOf();
      const controller = Abort ? new Abort() : null;
      const timer = controller && opts.timeout
        ? setT(() => { try { controller.abort(); } catch {} }, opts.timeout)
        : null;
      try {
        return await fetchImpl(url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          signal: controller ? controller.signal : undefined,
          credentials: 'omit',
          redirect: 'error',
          cache: 'no-store',
          mode: 'cors'
        });
      } catch (err) {
        throw makeError(
          err?.name === 'AbortError' ? 'timeout' : 'network',
          'PDF 링크 서버 요청에 실패했습니다.',
          { kind: err?.name === 'AbortError' ? 'timeout' : 'network' }
        );
      } finally {
        if (timer !== null) clearT(timer);
      }
    }

    async function authedFetch(base, path, opts) {
      const session = sessionForBase(base);
      const token = await fetchBearerToken(session);
      const makeHeaders = t => Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + t });
      let res = await rawFetch(base + path, Object.assign({}, opts, { headers: makeHeaders(token) }));
      if (res.status === 401 && session && typeof session.invalidate === 'function') {
        try { session.invalidate(); } catch {}
        const refreshed = await fetchBearerToken(session);
        res = await rawFetch(base + path, Object.assign({}, opts, { headers: makeHeaders(refreshed) }));
      }
      return res;
    }

    function parsePutResponse(res, data, base, sha) {
      if (!res.ok) throw httpError(res, data);
      if (!isObj(data)) throw makeError('protocol', 'PDF 링크 응답 형식이 올바르지 않습니다.', { kind: 'protocol' });
      const token = typeof data.token === 'string' ? data.token : '';
      const respSha = normalizeSha(data.sha256);
      const expiresAt = typeof data.expiresAt === 'string' ? data.expiresAt : '';
      const expMs = Date.parse(expiresAt);
      if (!TOKEN_32_HEX.test(token) || respSha !== sha || !Number.isFinite(expMs) || expMs <= nowOf()) {
        throw makeError('protocol', 'PDF 링크 응답 필드가 유효하지 않습니다.', { kind: 'protocol' });
      }
      return {
        apiBase: base,
        sha256: sha,
        token,
        url: buildLinkUrl(base, token),
        driveFileId: driveIdOf(data),
        expiresAt
      };
    }

    async function uploadLink(base, sha, file, preReadBytes, key, gen) {
      const bytes = preReadBytes || await readBytes(file);
      if (!bytes || !bytes.byteLength || !hasPdfMagic(bytes)) {
        throw makeError('invalid_pdf', '유효한 PDF 파일이 아닙니다.', { kind: 'local' });
      }
      const res = await authedFetch(base, '/v1/w8/paper-links/' + sha, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: bytes,
        timeout: TIMEOUT_UPLOAD_MS
      });
      const data = await readJsonBody(res);
      const entry = parsePutResponse(res, data, base, sha);
      if ((generations.get(key) || 0) !== gen) {
        throw makeError('revoked', 'PDF 링크 저장 중 해제되었습니다.', { kind: 'revoked' });
      }
      writeEntry(key, entry);
      emitLinkEvent({ sha256: sha, url: entry.url, expiresAt: entry.expiresAt, action: 'saved' });
      return entry.url;
    }

    function url(sha256) {
      const sha = normalizeSha(sha256);
      if (!sha) return '';
      const base = resolveApiBase();
      if (!base) return '';
      const entry = readEntry(base, sha);
      return entry ? entry.url : '';
    }

    function ensureKnownHash(base, sha, file, bytes) {
      const cached = readEntry(base, sha);
      if (cached && Object.hasOwn(cached, 'driveFileId')) return Promise.resolve(cached.url);
      const key = cacheKey(base, sha);
      if (inflight.has(key)) return inflight.get(key);
      const gen = generations.get(key) || 0;
      const job = uploadLink(base, sha, file, bytes, key, gen).catch(error => {
        // The older cache format still holds a usable link if the metadata refresh is offline.
        if (cached && readEntry(base, sha)?.token === cached.token && (generations.get(key) || 0) === gen) return cached.url;
        throw error;
      }).finally(() => {
        if (inflight.get(key) === job) inflight.delete(key);
      });
      inflight.set(key, job);
      return job;
    }

    function ensure(file, sha256) {
      const base = resolveApiBase();
      if (!base) {
        return Promise.reject(makeError('missing_api_base', 'PDF 링크 서버 주소가 설정되지 않았습니다.', { kind: 'config' }));
      }
      const explicitSha = sha256 === undefined || sha256 === null || sha256 === '' ? '' : normalizeSha(sha256);
      if (sha256 !== undefined && sha256 !== null && sha256 !== '' && !explicitSha) {
        return Promise.reject(makeError('invalid_sha256', '유효한 SHA-256 해시가 아닙니다.', { kind: 'local' }));
      }
      if (explicitSha) return ensureKnownHash(base, explicitSha, file, null);
      return (async () => {
        const bytes = await readBytes(file);
        if (!bytes || !bytes.byteLength || !hasPdfMagic(bytes)) {
          throw makeError('invalid_pdf', '유효한 PDF 파일이 아닙니다.', { kind: 'local' });
        }
        const sha = await sha256Hex(bytes, cryptoOf());
        return ensureKnownHash(base, sha, file, bytes);
      })();
    }

    async function revoke(sha256) {
      const sha = normalizeSha(sha256);
      if (!sha) return;
      const base = resolveApiBase();
      if (!base) return;
      const key = cacheKey(base, sha);
      generations.set(key, (generations.get(key) || 0) + 1);
      const upload = inflight.get(key);
      if (upload) await upload.catch(() => {});
      const entry = readEntry(base, sha);
      const target = entry ? entry.token + '.pdf' : sha;
      const res = await authedFetch(base, '/v1/w8/paper-links/' + target, {
        method: 'DELETE',
        timeout: TIMEOUT_REVOKE_MS
      });
      if (!res.ok && res.status !== 404) {
        const data = await readJsonBody(res);
        throw httpError(res, data);
      }
      dropEntry(key);
      emitLinkEvent({ sha256: sha, url: '', expiresAt: '', action: 'revoked' });
    }

    return Object.freeze({
      version: VERSION,
      ensure,
      driveId: sha => driveIdOf(readEntry(resolveApiBase(), normalizeSha(sha))),
      url,
      revoke
    });
  }

  const defaultClient = create({});

  return Object.freeze({
    version: VERSION,
    ensure: defaultClient.ensure,
    url: defaultClient.url,
    driveId: defaultClient.driveId,
    revoke: defaultClient.revoke,
    create,
    CACHE_PREFIX
  });
});
