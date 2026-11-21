import { BoothError, scrub } from './errors.mjs';

function errorCode(parsed, status) {
  const code = parsed?.error?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)) return code;
  return `http_${status}`;
}

export function createClient({ apiBase, token, fetchImpl = globalThis.fetch }) {
  let origin;
  try {
    origin = new URL(apiBase);
  } catch {
    throw new BoothError('booth_config', 'apiBase is not a URL');
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new BoothError('booth_config', 'apiBase must be http or https');
  }

  async function request(pathname, { method = 'GET', headers = {}, body = undefined, expect = 'json' } = {}) {
    const url = new URL(pathname, origin);
    const sent = { Accept: expect === 'json' ? 'application/json' : '*/*', ...headers };
    if (token) sent.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(url, { method, headers: sent, body });
    } catch (error) {
      const message = scrub(error.message, token);
      throw new BoothError('booth_network', message, {
        exitCode: 2,
        retryable: true,
        failure: { code: 'booth_network', retryable: true, message },
      });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (expect === 'file' && response.ok) return { bytes: buffer, headers: response.headers };
    if (expect === 'bytes' && response.ok) return buffer;
    const text = buffer.toString('utf8');
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (!response.ok) {
      const code = errorCode(parsed, response.status);
      const retryAfter = Number(response.headers.get('Retry-After'));
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
      const retryable = typeof parsed?.error?.retryable === 'boolean'
        ? parsed.error.retryable
        : (response.status === 408 || response.status === 429 || response.status >= 500);
      const detail = typeof parsed?.error?.message === 'string' && parsed.error.message ? parsed.error.message : '';
      const message = `${method} ${url.pathname} -> ${response.status} ${code}`;
      const failure = {
        code,
        retryable,
        message: detail || message,
        status: response.status,
      };
      if (typeof parsed?.error?.requestId === 'string' && parsed.error.requestId) {
        failure.requestId = parsed.error.requestId;
      }
      if (seconds > 0) failure.retryAfter = seconds;
      throw new BoothError(code, message, {
        exitCode: 2,
        status: response.status,
        retryAfter: seconds,
        retryable,
        failure,
      });
    }
    if (expect === 'bytes') return buffer;
    if (!parsed || typeof parsed !== 'object') {
      throw new BoothError('booth_api', `${method} ${url.pathname} returned a non-JSON body`, {
        exitCode: 2,
        retryable: false,
      });
    }
    return parsed;
  }

  return {
    apiBase: origin.toString().replace(/\/$/, ''),
    json: (pathname, options) => request(pathname, { ...options, expect: 'json' }),
    bytes: (pathname, options) => request(pathname, { ...options, expect: 'bytes' }),
    file: (pathname, options) => request(pathname, { ...options, expect: 'file' }),
  };
}
