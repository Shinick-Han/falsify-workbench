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
      throw new BoothError('booth_network', scrub(error.message, token), { exitCode: 2 });
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (expect === 'bytes' && response.ok) return buffer;
    const text = buffer.toString('utf8');
    let parsed = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = null; }
    }
    if (!response.ok) {
      const code = errorCode(parsed, response.status);
      throw new BoothError(code, `${method} ${url.pathname} -> ${response.status} ${code}`, {
        exitCode: 2,
        status: response.status,
      });
    }
    if (expect === 'bytes') return buffer;
    if (!parsed || typeof parsed !== 'object') {
      throw new BoothError('booth_api', `${method} ${url.pathname} returned a non-JSON body`, { exitCode: 2 });
    }
    return parsed;
  }

  return {
    apiBase: origin.toString().replace(/\/$/, ''),
    json: (pathname, options) => request(pathname, { ...options, expect: 'json' }),
    bytes: (pathname, options) => request(pathname, { ...options, expect: 'bytes' }),
  };
}
