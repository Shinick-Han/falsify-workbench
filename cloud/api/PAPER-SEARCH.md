# Paper search

Booth paper search and PDF proxy. Contract: `docs/booth-contract-20261120.md` section 6. This module does not mount itself. The orchestrator wires it in `cloud/api/src/index.js`.

Fake examples only. No new dependency. The worker does not send an email, an owner id, or a bearer to OpenAlex or arXiv.

## Mount

Call `matchPaperSearch(pathname)` before the Confluence router and the legacy records router. Any non-null match is handled here, including unknown `/v1/papers/*` paths, so those paths do not fall through.

```js
import { handlePaperSearchRequest, matchPaperSearch } from './paper-search.mjs';

// matchRequest, before matchConfluence:
const papers = matchPaperSearch(pathname);
if (papers) return { papers, ai: null, confluence: null, matched: null };

// dispatchRequest, with the same deps object handleAiRequest uses:
if (matched.papers) {
  return handlePaperSearchRequest({
    request,
    env,
    url,
    match: matched.papers,
    fetchImpl: budgetedFetch(globalThis.fetch.bind(globalThis), 15000),
    deps: aiDependencies(request, env),
  });
}
```

`ctx.fetchImpl` must be able to reach the public hosts below. `aiFetch(env)` is the wrong function when `env.AI_RUNTIME.fetch` exists, because that binding talks to the container runtime and not to OpenAlex or arXiv. `ctx.cache` is optional. When it is omitted the handler uses `globalThis.caches.default`, and when that is missing it does not cache.

`deps` is `{ getDb, rateLimit, releaseSlot, authenticatePassword, clientIp }`. `clientIp()` is called with no arguments, the same way guest minting calls it. `handlePaperSearchRequest` answers its own `OPTIONS` preflight (`GET, OPTIONS`; headers `authorization, content-type`).

## Routes

`PAPER_SEARCH_ENABLED` must be the string `true` (a boolean `true` is also accepted). Any other value, including unset, is `404 not_found` for every method on a matched path, before auth, rate limits, and upstream calls.

Auth is `resolveAiOwner` from `ai-identity.mjs`. A missing or invalid bearer is `401 unauthorized`. Guests need open access, the same as `/v1/ai/*`. This module does not grow a second session parser.

JSON errors use the `/v1/ai/*` envelope and the `no-store` / `nosniff` headers:

```json
{ "error": { "code": "not_found", "message": "Not found.", "requestId": "req_example", "retryable": false } }
```

`rate_limited`, `upstream_unavailable` and `internal_error` are `retryable: true`. A rate limit also sets `Retry-After`.

### `GET /v1/papers/search?q=<1..200>&page=<1..5>`

`q` is required. It is Unicode-normalized to NFC, trimmed, and has internal whitespace collapsed to a single space. Length is counted in Unicode code points after that. `page` defaults to `1`. Only `1` through `5` are accepted. Any other query key, a repeated key, or an out-of-range value is `400 invalid_request`. `POST` is `405` after auth.

`200`, cacheable for one hour:

```json
{
  "source": "arxiv",
  "page": 1,
  "hasMore": true,
  "results": [{
    "source": "arxiv",
    "id": "2503.10497",
    "title": "Example title",
    "authors": ["Ada Example"],
    "year": 2024,
    "abstract": "Synthetic example.",
    "license": { "id": "cc-by", "url": "https://creativecommons.org/licenses/by/4.0/" },
    "licenseVerified": true,
    "landingUrl": "https://arxiv.org/abs/2503.10497"
  }]
}
```

Ten results per page. `authors` is at most six names. `abstract` is at most 700 code points. `hasMore` is true only when another page in `1..5` exists upstream. Page 5 is the last page this route will serve, so `hasMore` is false there even if the upstream has more rows. `year` is `null` when the upstream year is missing or outside 1900..2100.

The success body is `Cache-Control: public, max-age=3600`. Errors stay `no-store`. The cache key is the normalized query plus the page. It does not include the owner, the IP, or the API key. A successful arXiv fallback is cached the same way, so OpenAlex is not retried until that hour is over. A `503` is not cached.

### `GET /v1/papers/pdf?id=<arXiv id>`

The only query key is `id`. It must match the whole value, never a URL:

- `^\d{4}\.\d{4,5}(v\d{1,3})?$`
- `^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d{1,3})?$`

Anything else, including a version with more than three digits, is `400 invalid_request` before a rate-limit slot or an upstream call.

The license check is arXiv OAI-PMH `GetRecord` with `metadataPrefix=arXiv` and identifier `oai:arXiv.org:<id without version>`. Allowed licenses are CC BY (any version), CC BY-SA, and CC0 / public domain. CC BY-NC, CC BY-ND, the arXiv non-exclusive licence, and a record with no `<license>` are `403 license_not_allowed`. `idDoesNotExist` is `404 not_found`. The verdict is cached for 24 hours under the versionless id, so `2503.10497` and `2503.10497v2` share it. Upstream failures are not cached. A denied or missing id never stores PDF bytes.

On an allow, the handler fetches `https://arxiv.org/pdf/<id>` using the caller's id, version included. The response requires HTTP 200, a PDF content type (`application/pdf` or `application/octet-stream`, or a missing type), and a body that starts with `%PDF-`. The size cap is the caller's effective upload cap from `aiSettings`: `guestMaxUploadBytes` when `ownerId` starts with `gst:`, otherwise `maxUploadBytes`.

`200` PDF:

```http
Content-Type: application/pdf
Content-Disposition: attachment; filename="arxiv-2503.10497.pdf"
X-Falsify-Paper-License: cc-by-4.0
Cache-Control: no-store
X-Content-Type-Options: nosniff
```

`X-Falsify-Paper-License` is the licence id (`cc-by-4.0`, `cc-by-sa-4.0`, `cc0`, or the version that was in the OAI URL). The header is listed in `Access-Control-Expose-Headers`. An old-style id keeps its slash on the upstream path (`/pdf/hep-th/9901001`) but the filename replaces `/` with `-` (`arxiv-hep-th-9901001.pdf`) so the header stays one file name.

The visitor response stays `Cache-Control: no-store`. After a successful allow, the PDF bytes are also stored in the worker cache for 24 hours. The key is the validated id, version included, so `2503.10497` and `2503.10497v2` do not share a file. A later request for that id returns those bytes and does not call OAI-PMH or `arxiv.org`. The caller's upload cap is applied to the cached bytes: a guest whose cap is smaller than the stored file gets `413 payload_too_large` and the cache entry is left in place for a caller with a higher cap.

Size cap:

- `Content-Length` above the cap: `413 payload_too_large`. The body is cancelled and not stored.
- Otherwise the body is counted up to the cap, whether or not `Content-Length` was present. Crossing the cap, including a header that understated the size, is a JSON `413`. The partial body is discarded and not cached.
- An accepted PDF is held so it can be written to the 24 hour cache, then returned with `no-store`.

A non-PDF upstream, including a `200` that is HTML or that does not start with `%PDF-`, is `502 upstream_invalid`.

## Limits

Slots use `deps.rateLimit`. Owner and IP buckets are a prefix plus a truncated SHA-256, the same construction as the AI gateway. The raw IP and the owner id are not stored in the bucket. A later slot that fails releases the slots already taken for that request.

| Name | Default | Bucket |
|---|---|---|
| `PAPER_SEARCH_PER_OWNER_HOUR` | 60 | one owner, search |
| `PAPER_SEARCH_PER_IP_HOUR` | 300 | one IP, search |
| `PAPER_PDF_PER_OWNER_HOUR` | 20 | one owner, PDF |
| `PAPER_PDF_PER_IP_HOUR` | 120 | one IP, PDF |
| `PAPER_SEARCH_PER_HOUR` | 3000 | shared global bucket `paper-search:all` for search and PDF |

Validation (`400`) runs before these slots. A cache hit still spends a slot.

Other env vars:

| Name | Kind | Effect |
|---|---|---|
| `PAPER_SEARCH_ENABLED` | var | `true` turns the routes on. Unset is `404` before auth |
| `OPENALEX_API_KEY` | secret | optional. Sent only as `Authorization: Bearer` on the first `api.openalex.org` request. Never placed in the URL, logged, or sent to arXiv. A redirect drops it. A value outside `[A-Za-z0-9._~-]{1,200}` is ignored |
| `AI_MAX_UPLOAD_BYTES` | var | PDF cap for non-guest owners. Existing default 32 MiB, hard max 64 MiB |
| `AI_GUEST_MAX_UPLOAD_BYTES` | var | PDF cap for `gst:` owners. Existing default 20 MiB, never above the deployment cap |
| `AI_OPEN_ACCESS` | var | required for an `fsg_` bearer, unchanged |

Unset paper-search limits use the defaults above. Unset `PAPER_SEARCH_ENABLED` leaves every existing route unchanged because this module is not on the request path until it is mounted, and a mount that sees the flag off returns `404` only for `/v1/papers/*`.

## Upstream policy

Hosts that may be requested directly:

- `https://api.openalex.org` for works search
- `https://export.arxiv.org` for the Atom API
- `https://oaipmh.arxiv.org` for `GetRecord`
- `https://arxiv.org` for the PDF

The OpenAlex filter is `best_oa_location.source.id:S4306400194` (arXiv) and `best_oa_location.license:cc-by|cc-by-sa|public-domain`. Those three licence tokens are returned with `licenseVerified: true`. A work that does not yield an arXiv id, or whose licence token is not one of those three, is dropped. OpenAlex abstracts are rebuilt from `abstract_inverted_index`.

If OpenAlex cannot be used (non-200, invalid JSON, network error, or a redirect this module will not follow), the handler falls back to `export.arxiv.org/api/query` with `search_query=all:<normalized q>`. Fallback rows have `license: null` and `licenseVerified: false`. The Atom API does not carry a licence. If that fallback also fails, the response is `503 upstream_unavailable`. An empty OpenAlex result set is a successful empty page, not a fallback.

Every upstream request sets:

```http
User-Agent: falsify-workbench-booth/1.0 (+https://github.com/Shinick-Han/falsify-workbench)
```

There is no `mailto` parameter and no email address. `OPENALEX_API_KEY` is `Authorization: Bearer <key>` on that one OpenAlex request and is not a query parameter. Fetch uses `redirect: 'manual'`. A redirect is followed only for `https://arxiv.org/` and `https://export.arxiv.org/`, at most three hops, with no userinfo and no port other than 443. Any other hop, including `http://` and a look-alike host, is `502 redirect_refused` and is not requested. An OpenAlex redirect that fails this rule is treated as an OpenAlex failure and falls back to arXiv instead of following it. A PDF redirect that fails it fails the request.

## Licence rule

Booth intake allows CC BY (any version), CC BY-SA, and CC0 / public domain. The PDF route decides from the OAI `<license>` URL. Search rows from OpenAlex use the upstream token (`cc-by`, `cc-by-sa`, `public-domain`) and are already restricted to that set. Search rows from the Atom fallback are not a licence decision; the PDF route checks again before any byte is returned to the browser.
