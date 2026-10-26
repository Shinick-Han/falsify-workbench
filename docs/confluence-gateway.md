# Confluence 게이트웨이

이 문서는 `cloud/api`의 상태 없는 Confluence OAuth/아카이브 릴레이를 설명한다. 공유 계약은 `docs/confluence-storage-contract.md`다. 이 후보 브랜치는 배포되지 않았다. `cloud/api/test/confluence-gateway.test.mjs`는 네트워크 없이 주입한 `fetch`로만 동작하므로, 테스트 성공은 실제 Atlassian 인가나 Confluence 저장의 증거가 아니다. 앱 등록, 시크릿, 부모 페이지 ID, 배포 확인은 코디네이터가 맡는다.

## 맡은 경로

접두사는 `/v1/confluence`다.

| 메서드와 경로 | 동작 |
| --- | --- |
| `GET /capabilities` | `{provider:'confluence',configured,siteUrl,spaceKey,spaceId,maxArchiveBytes}` |
| `POST /auth/start` | 본문 `{nonce,returnOrigin}` → `{authorizeUrl}` |
| `GET /auth/callback` | opener에게만 `postMessage` |
| `POST /auth/refresh` | 봉인된 세션을 회전 |
| `GET /archives?cursor=` | 준비된 자식 페이지만 `{items,nextCursor}` |
| `GET /archives/{pageId}` | 검증된 `{pageId,webUrl,archive,archiveSha256}` |
| `POST /archives` | 본문 `{archive,teamShare:true}` |

아카이브 검증은 데이터 소유 모듈 `app/dist/review-bundle.mjs`의 `validateArchive`와 `archiveHash`를 쓴다. 게이트웨이는 `{harness, red, blue, review}` 검증기를 직접 넘긴다. 모듈이 없으면 `503 archive_validator_unavailable`이며, 저장된 아카이브가 있는 것처럼 응답하지 않는다. 통합 전에는 테스트 주입만 허용된다.

`GET /capabilities`의 `maxArchiveBytes`는 `6291456`(UTF-8 6 MiB)이다. 응답에 시크릿, 세션, 부모 페이지 ID는 없다.

## 세션

중앙 Atlassian OAuth 2.0 (3LO) 앱 하나다. 사용자 API 토큰이나 사용자별 개발자 앱은 받지 않는다. 비밀번호 세션 `fss_`와 초대 코드 `fsi_`는 Confluence 요청을 인가하지 못한다.

`CONFLUENCE_SESSION_KEY`는 32바이트 키의 base64다. 생성 예:

```sh
openssl rand -base64 32
```

상태는 `falsify.confluence.oauth-state.v1`, 세션은 `falsify.confluence.session.v1` 목적의 AES-256-GCM 봉투다. 목적은 AAD로 묶여 상태 토큰을 세션으로 쓸 수 없다. 상태 TTL은 10분이고 호출자의 `nonce`와 허용된 `returnOrigin`을 담는다. 세션 봉투의 절대 만료는 12시간이며 갱신해도 늘어나지 않는다. 액세스 토큰은 만료 60초 전후부터 갱신하고, 회전은 16회에서 멈춘다. 그 이후와 봉투 만료는 `401 session_expired`다.

갱신이 일어나면 응답 헤더 `X-Falsify-Confluence-Session`에 새 봉투가 실리고 `Access-Control-Expose-Headers`에 그 이름만 공개된다. 오류 응답에도 같은 헤더가 붙을 수 있다. 브라우저는 이 값을 로컬 연결 상태로만 보관한다. 연결 해제는 그 로컬 값을 지울 뿐 Atlassian 쪽 전역 동의 철회가 아니다.

콜백은 `Cache-Control: no-store`, `Referrer-Policy: no-referrer` HTML이다. `window.opener`가 있을 때만 봉인된 세션을 `{type:'falsify.confluence.session.v1',nonce,session,expiresAt}`로 보내고 `targetOrigin`은 상태에 묶인 출처와 같다. 설정이 없거나 상태가 틀리거나 사이트가 허용 사이트가 아니면 세션 없이 다시 연결하라는 문구만 보여 준다. 인가 코드, 액세스 토큰, 클라이언트 시크릿은 URL, HTML, 로그에 넣지 않는다.

워커 로그는 경로 템플릿, 메서드, 상태 코드, 소요 시간만 남긴다. CORS는 허용된 출처만 `Access-Control-Allow-Origin`에 그대로 넣으며 `*`를 쓰지 않는다. 콜백은 Atlassian의 최상위 이동이라 프론트 출처 검사가 면제되고, 그 경우에도 반사된 허용 출처 헤더는 없다.

## 발행

원격 저장은 Confluence 팀 공간뿐이다. `teamShare`가 `true`가 아니면 `400 team_share_required`다. 비공개 모드, 공개 인터넷 링크, 임의 업스트림 프록시는 없다.

모든 쓰기 전에 다음을 확인한다.

1. `https://api.atlassian.com/oauth/token/accessible-resources`에서 출처가 정확히 `https://falsify.atlassian.net`인 항목이 하나일 것.
2. 그 cloud ID의 공간 `65737` 키가 `Falsify`일 것.
3. 설정된 부모 페이지가 그 공간 안에 있을 것.

사이트, 공간, 부모가 어긋나면 페이지를 만들지 않는다. `CONFLUENCE_SITE_URL`, `CONFLUENCE_SPACE_KEY`, `CONFLUENCE_SPACE_ID`가 위 고정값과 다르면 `configured`는 `false`다. 빠진 시크릿이나 부모 ID도 연결된 것처럼 응답하지 않는다.

페이지 본문은 이스케이프된 짧은 요약이다. 첫 흐름은 JSON만 저장한다고 본문에 적혀 있으며 PDF를 저장하지 않는다. 원문은 SHA-256 파일명의 첨부 `{archiveSha256}.json`이다. 속성 `falsify-archive`에는 `kind`, `id`, `archiveSha256`, `ready:true`만 넣는다. 라벨 `falsify-archive-ready`는 첨부 검증과 속성 다음에 마지막으로 붙인다. 라벨이 없는 페이지는 목록과 단건 조회에서 성공으로 나오지 않고 단건은 `404`다.

같은 제목의 현재 페이지가 다른 부모에 있거나, 준비 라벨의 해시나 ID가 다르면 `409 archive_conflict`이며 덮어쓰지 않는다. ID, 종류, 해시가 같은 준비된 페이지는 `alreadyExisted:true`로 다시 쓰지 않는다. 기존 첨부와 이전 리비전은 삭제하지 않는다. 다운로드는 `redirect: 'manual'`이라 다른 호스트로 자격 증명을 넘기지 않는다.

쓰기가 시작된 뒤의 단절은 `409 write_unknown` 또는 `409 write_partial`과 `readBack:true`다. 페이지 ID를 알게 된 뒤에는 `pageId`를 함께 준다. 클라이언트는 목록이나 단건을 다시 읽기 전에 같은 발행을 자동 반복하지 않는다. 아직 아카이브 쓰기가 시작되기 전의 `429`는 `rate_limited`이고, `Retry-After`가 1자리에서 6자리 숫자일 때만 그 헤더를 전달한다. 쓰기가 시작된 뒤의 `429`는 `write_partial`이다.

게이트웨이 경로에는 D1, KV, R2 바인딩이 없어도 된다. 이 경로는 `env.DB`를 읽지 않는다.

## 레거시 쓰기

`CONFLUENCE_ONLY=true` 또는 `'true'`일 때만 다음 쓰기가 `410 storage_moved`다.

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/password`
- `POST /v1/auth/sessions/revoke`
- `POST /v1/logout`
- `POST /v1/records`
- `PATCH /v1/records/:id`
- `DELETE /v1/records/:id`

메시지 본문은 `Remote records moved to the Falsify Confluence archive. This account or record write is no longer accepted.`다. `wrangler.jsonc`의 기본값은 `"false"`라서 기존 계정/기록 테스트는 은퇴 전 경로를 유지한다. 읽기와 내보내기(`GET /v1/health`, `GET /v1/me`, `GET /v1/records`, `GET /v1/records/:id`)는 플래그와 관계없이 남아 있다. 예전 D1 바인딩이 없으면 그 읽기는 `503 not_configured`이며 `410`이 아니다. D1 스키마는 지우거나 바꾸지 않는다. 로컬 브라우저 기록과 이미 있는 Confluence 페이지도 이 릴레이가 삭제하지 않는다.

## 운영자 체크리스트

코디네이터가 등록과 시크릿을 넣기 전에는 `configured:false`가 정상이다. 부모 페이지 ID나 시크릿이 비어 있는 것은 구현 누락이 아니다.

1. Atlassian 개발자 콘솔에 3LO 앱을 하나 만든다. 배포 권한이나 사이트 관리자 변경은 이 저장소 변경에 포함되지 않는다.
2. 콜백 URL을 `https://<worker-host>/v1/confluence/auth/callback`로 등록한다. 경로는 정확히 `/v1/confluence/auth/callback`이고, 쿼리, 해시, 사용자 정보는 없다. 같은 문자열을 시크릿 `ATLASSIAN_CALLBACK_URL`에 넣는다. `http`는 `localhost` 또는 `127.0.0.1`에서만 받는다.
3. 동의 화면에 아래 스코프를 모두 넣는다. 인가 URL도 이 목록을 한 칸으로 이어 보낸다.
   - `offline_access`
   - `read:space:confluence`
   - `read:page:confluence`
   - `write:page:confluence`
   - `read:attachment:confluence`
   - `write:attachment:confluence`
   - `read:label:confluence`
   - `write:label:confluence`
   - `readonly:content.attachment:confluence` (첨부 다운로드에 쓰는 기존 content API)
4. 배포 환경의 시크릿으로만 `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `CONFLUENCE_SESSION_KEY`, `CONFLUENCE_PARENT_PAGE_ID`를 설정한다. `wrangler.jsonc`의 `vars`에는 넣지 않는다. 부모 ID는 Falsify 공간 `65737` 안에 이미 있는 아카이브 부모 페이지의 숫자 ID다.
5. 고정 공개값은 사이트 `https://falsify.atlassian.net`, 공간 키 `Falsify`, 공간 ID `65737`이다. `REMOTE_PROVIDER`는 `confluence`만 쓴다.
6. 프론트 출처는 `ALLOWED_ORIGINS`에 정확한 origin만 둔다. 예: `https://shinick-han.github.io`.
7. 기존 계정 읽기가 더 이상 필요 없을 때의 컷오버에서만 `CONFLUENCE_ONLY=true`를 준다. 그 전에 기존 D1 읽기 내보내기를 마친다. 데이터베이스 삭제나 자동 재업로드는 하지 않는다.
8. 통합 후 코디네이터가 두 브라우저에서 발행, 목록, 읽기, 잘못된 출처/공간/부모, 갱신, 부분 쓰기를 확인한다. 그 확인 전에는 배포되었다고 하지 않는다.

워커 이름 `falsify-cloud-api`, `compatibility_date` `2026-10-19`, `nodejs_compat`, `cpu_ms` 1000, 기존 D1 데이터베이스 이름은 유지한다. 새 유료 저장소나 패키지는 추가하지 않았다.
