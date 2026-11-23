// Isolated public paper API entry for the GitHub Pages W8 deployment (falsify-w8-papers).
// Allows only /v1/ai/guest, /v1/papers/search, /v1/papers/pdf, and /v1/w8/paper-links/:id,
// delegating matched requests to cloud/api/src/index.js (preserving its auth, rate, CORS,
// license-verification, and SHA-256 hash checks). Every other path fails closed with 404.
import apiWorker from './index.js';

const ALLOWED_EXACT = new Set([
  '/v1/ai/guest',
  '/v1/papers/search',
  '/v1/papers/pdf',
]);
const W8_PAPER_LINK_SINGLE = /^\/v1\/w8\/paper-links\/[^/]+$/;

export function isW8PapersPublicPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return ALLOWED_EXACT.has(pathname) || W8_PAPER_LINK_SINGLE.test(pathname);
}

function notFoundResponse() {
  return new Response(
    JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Origin',
      },
    },
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!isW8PapersPublicPath(url.pathname)) {
      console.log(JSON.stringify({ event: 'request', method: request.method, route: 'blocked', status: 404 }));
      return notFoundResponse();
    }
    return apiWorker.fetch(request, env, ctx);
  },
};
