## 0.2.0-alpha.88 — 2026-11-20

- 행사 페이지에서 논문 쪽의 단어나 숫자를 눌러 그 자리에서 고칩니다(마우스는 작은 창, 터치는 키보드 위 편집 막대). 바꾼 글자는 원래 글꼴로 그 자리에 그립니다.
- 폰에서도 규칙과 최종 추첨이 보이고, 탭 복귀 즉시 결과 확인, 대기 중 화면 켜 두기, 오프라인 안내와 자동 재시도, 「이어서 할까요?」를 더했습니다.
- 키오스크 모드(`event.html?kiosk=1`): 탭 안에만 기록을 두고, 「다음 분께 넘기기」와 3분 무조작 초기화를 지원합니다.
- AI 레시피로 고친 곳과 AI가 채운 이유에 출처를 표시하고, 내 AI에게의 복사, 붙여 넣기, 공유를 다듬었습니다.
- 방문객 문구 52곳을 해요체로 다듬고 동의 문구 v3(내용은 v2와 같음)를 더했습니다. 설정을 받기 전에는 동의 문구를 비워 둡니다.
- 강제 다크 모드를 끄고 회색 글씨와 입력칸 테두리의 대비를 높였습니다.

## 0.2.0-alpha.87 — 2026-11-20

- 행사 페이지에 데스크탑(1024px 이상) 화면을 더하고 논문 쪽 그림을 화면 픽셀 밀도로 선명하게 그립니다. 폰 편집은 찾아 바꾸기와 원본·수정본 쪽 비교로 바꿨습니다. 「내 AI에게」 복사·붙여넣기와 agent 결함 레시피 API(`/v1/booth/recipes`, `/mcp`, 미션 본문), agent 안내(`agent.html`)를 더했고, 제출에 출처(`assist`)를 기록합니다. [release notes](docs/releases/0.2.0-alpha.87.md)

## 0.2.0-alpha.86 — 2026-11-20

- 행사 페이지(event.html)를 「도전 티켓」 디자인으로 바꿨습니다. `event-theme.css`는 작업대 화면을 CSS로만 숨기고 논문 편집 화면을 폰에 맞게 정리합니다. `booth.js`는 pick·edit·send·ticket 네 단계를 `html[data-booth-step]`로 알립니다. edit 단계에는 「고친 곳 N개 · 다음」 고정 막대가 있고, 「다음」을 누르면 수정본 PDF를 자동으로 만듭니다. send 단계는 동의문을 3줄 요약으로 보여 주고 전문은 펼쳐서 볼 수 있으며, 코스는 quick으로 고정합니다. ticket 단계는 검증 티켓과 통과·적발·무효 도장, 교환권, `publicNote` 쪽·인용·AI 의견 분리를 보여 줍니다. 서버 API와 index.html은 바뀌지 않았습니다.

## 0.2.0-alpha.85 — 2026-11-19

- 운영자 CLI에 라이브 판정을 추가했습니다. `watch`는 접수가 열린 동안 `received` 접수를 읽어 `reviewing`으로 바꾸고, PDF를 `pdfSha256`·`pdfBytes`로 검증한 뒤 `live` 프로파일(Claude Sonnet 5.5) BLUE를 돌려 채점하고, `judged`·outcome·`publicNote`·`aiSummary`·`published: true`(놓쳤으면 `prizeMessage`도)를 PATCH 한 번으로 게시합니다. 철회(409)와 PDF 없음은 건너뛰고, 재시도까지 실패하면 `reviewing`에 `operatorNote: live: failed <code>`를 남깁니다. 다시 켜면 같은 작업으로 이어 가며 새로 과금하지 않습니다. `final`은 마감 뒤 라이브에서 놓친 접수를 `final` 프로파일(Claude Opus 5.5)로 다시 보고 `final/candidates.json`을 쓰며, 사람이 확인한 뒤 `--apply`로만 게시합니다. final에서 찾아내도 이미 받은 즉석 선물은 유효합니다(`finalCaughtMessage`). 방문자에게 보이는 `publicNote`는 AI finding의 쪽·인용·설명만 쓰고, 쪽은 「AI가 짚은 곳」으로 적습니다.
- 호스팅 BLUE finding에 `pageIndex`가 없어 모든 접수가 `missed`로 채점되던 문제를 고쳤습니다. `segmentId`(`p<N>-`)와 `evidence[].segmentId`에서 쪽을 읽고, 수정 문장을 `quote`·`sourceQuote`·`evidence[].quote`와 대조합니다.
- 행사 페이지 부스 패널에 라이브 결과 카드를 넣었습니다. 접수 화면과 `#booth-result`가 같은 카드를 쓰며, 게시 전에는 `POST /v1/booth/claim`을 처음 3분은 15초, 이후 15분까지 30초마다 확인하고 그 뒤 「결과 다시 보기」를 보여 줍니다. `429`는 `Retry-After`만큼(읽을 수 없으면 60초) 기다립니다. caught·partial·missed·invalid·withdrawn 문구와 「다시 도전하기」를 추가했고, 이 브라우저의 최근 접수 5건을 보여 줍니다. 동의문은 버전별 맵(`CONSENT_COPY`, v1·v2)으로 바꿔 설정의 `consentVersion`에 맞는 문구를 보여 주며, 문구가 없는 버전은 제출하지 않습니다.
- API Worker의 부스·`/v1/ai/*`·`/v1/papers/*` 응답은 이제 항상 `Access-Control-Expose-Headers: X-Falsify-Confluence-Session, Retry-After`를 보냅니다. 세션이 없는 확인 경로의 `429`에서도 브라우저가 대기 시간을 읽을 수 있습니다.
- 행사 Worker(`env.event`)의 `BOOTH_CONSENT_VERSION`을 `2026-11-22.v2`로, `BOOTH_CLAIMS_PER_IP_HOUR`를 8000, `BOOTH_CLAIMS_PER_HOUR`를 15000으로 올렸습니다. 방문자가 행사장 NAT 하나 뒤에서 결과를 폴링하기 때문입니다. 코드 기본값, `AI_RUNTIME_URL`, `BOOTH_OPERATOR_ACTIVE_JOBS`와 운영·스테이징 설정은 바뀌지 않았습니다.
- `docs/privacy.md`는 제출 직후 BLUE를 돌리고 모델 제공자는 Anthropic뿐이라고 적습니다. `docs/booth-contract-20261120.md` §13 「Live BLUE」와 `cloud/api/BOOTH.md`를 갱신했습니다.

## 0.2.0-alpha.84 — 2026-11-19

- 행사 부스 제출 경로 `/v1/booth/*`와 D1 마이그레이션 `0006_booth.sql`을 추가했습니다. `POST /v1/booth/submissions`는 `multipart/form-data`의 `meta`(JSON)와 `pdf`(`application/pdf` 파일) 두 필드만 받고, `Content-Length`가 없으면 `411 length_required`, `BOOTH_MAX_PDF_BYTES`+65536을 넘으면 본문을 읽기 전에 `413 payload_too_large`입니다. `editedSha256`과 필수 `paper.sourceSha256`을 서버 해시와 대조하며(`pdf_mismatch`, `pdf_unchanged`), PDF는 512 KiB 청크로 `booth_files`에 저장합니다. 접수 행·청크·순번·소유자 한도(`BOOTH_SUBMISSIONS_PER_OWNER`)·저장 용량 한도(`BOOTH_STORED_PDF_BYTES`, 초과 시 `503 storage_full`)는 한 번의 `db.batch`에서 함께 처리합니다. 접수번호는 `F-0001` 형식, 확인키는 Crockford base32 8자이며 해시만 저장합니다. `/v1/booth/claim`·`/v1/booth/withdraw`는 접수번호와 확인키로 결과 조회·철회를 하고, 철회는 설명·결과·운영자 메모를 비우고 청크를 같은 batch에서 지웁니다. `/v1/booth/admin/*`는 `BOOTH_OPERATOR_TOKEN`과 대조한 `fso_` 베어러(`opr:booth`)만 받습니다. `GET /v1/booth/config`는 미션(`pageHint`, `sourceSha256` 포함)과 `limits`를 줍니다.
- 논문 검색 `GET /v1/papers/search`와 `GET /v1/papers/pdf?id=`를 추가했습니다. OpenAlex(키는 `Authorization: Bearer`로만)와 arXiv Atom 대체 검색을 쓰고, OAI-PMH로 라이선스를 확인해 CC BY·CC BY-SA·CC0만 돌려주며, 허용된 PDF는 24시간 캐시합니다. `PAPER_SEARCH_ENABLED`가 `true`일 때만 열립니다.
- 호스팅 AI 게이트웨이에 `AI_GUEST_BLUE`, `AI_GUEST_MODEL_JOBS`, `AI_MODEL_JOBS_OPERATOR_ONLY`, `AI_GUEST_APPLY_JOBS_PER_HOUR`, `BOOTH_OPERATOR_*`(`BOOTH_OPERATOR_TOKEN_BUDGET` 포함) 설정을 더했습니다. `GET /v1/ai/capabilities`는 `blueJobs`·`modelJobs`를 줍니다. 행사 Worker(`env.event`)는 게스트 BLUE·모델 작업을 막고(`model_jobs_operator_only`), `AI_PAPER_TOOLS_ENABLED`를 `false`로, `limits.cpu_ms`를 5000으로 둡니다. 운영·스테이징 설정은 바뀌지 않았습니다.
- 행사 페이지(`event.html`)에 부스 패널(`app/dist/booth.js`, `booth.css`)을 넣었습니다. 미션 카드와 「N쪽으로 가기」, 문단 목록 기본 열기, 「제출할 수정본 만들기」(논문 작업대의 `falsify:paper-generated` 이벤트 사용), 결함 설명 최대 `limits.maxDeclared`건, 동의문(`2026-11-22.v1`), 접수번호·확인키 저장과 `#booth-result` 결과·철회 화면을 제공합니다. `blueJobs`가 false이면 BLUE 인계와 안내판 BLUE 액션을 「부스에 제출하기」로 바꾸고, 휴대폰에서 터치 영역을 44px 이상으로 맞췄습니다. `index.html` 동작은 바뀌지 않았습니다.
- 운영자 CLI `tools/booth/booth.mjs`(pull, close, blue, score, judge, publish, draw, missions get·set·warm)를 추가했습니다. pull은 `pdfSha256`·`pdfBytes`로 PDF를 검증하고 철회된 접수의 로컬 파일을 지우며, blue는 접수 중에는 `--allow-open` 없이 거부하고 `--max-bytes`·`%PDF-`를 확인합니다. CSV 내보내기는 수식 주입을 막습니다. 결함 설명은 BLUE 요청에 넣지 않습니다.
- `docs/privacy.md`에 호스팅 AI와 부스 제출 항목을 추가했습니다.

## 0.2.0-alpha.83 — 2026-11-18

- BLUE 화면에 브라우저 로컬 PDF 대조 뷰어(`app/dist/blue-paper-reader.js`, `#blue-paper-viewer`)를 추가했습니다. 네트워크 호출 없이 `FalsifyPreview`(PDF.js)와 `FalsifyChangeMarks` 정규화를 재사용해 데스크톱 2단 고정 대조(`원문과 나란히 보기` ↔ `1단 위아래 보기`)를 지원하며, 웹 BLUE·로컬 BLUE·외부 응답·Layer 0 센서 카드의 `원문에서 보기` 클릭 시 해당 쪽을 찾아 인용 구간을 강조(`.blue-quote-highlight`)합니다.
- RED 표·그래프·그림 통합(`app/dist/paper-visual-integration.js`)에서 미생성 본문 편집이 있을 때 `editor.getSource() === null` 계보 계약은 유지하면서 `본문 수정 반영하고 표·그래프 열기`(`#red-visual-chain-apply`) 배너를 노출해, 원클릭으로 생성본 PDF를 만들고 그 위에서 시각 편집기를 이어 열 수 있게 했습니다.
- 사람 검수 작업대(`app/dist/review-workbench.js`) 상단에 4분할 실시간 집계 타일(`#review-scoreboard`: 주입 결함 탐지 / 타당 지적 / 순수 오탐 / 기존·경계·오류)과 `미판정만 보기`(`#review-filter-pending`)·`다음 미판정으로`(`#review-next-pending`) 진행 도구를 추가했습니다.
- RED 캔버스 보조 설정 요약 문구를 `글꼴 · 변경 표시 · 확대`로 유지해 LaTeX 소스 프로젝트 브라우저 회귀 계약과 일치시켰습니다.

## 0.2.0-alpha.82 — 2026-11-18

- RED(`#paper-file`)·BLUE(`#doc-blue-file`) 논문 입력과 웹 실행(`#hosted-ai`) 사이에 로컬 파일 공유 버스를 연결했습니다. PDF를 한 번 고르면 로컬 SHA-256만 계산해 웹 실행 입력 상태를 채우며, 실행 버튼을 누르기 전에는 업로드나 게스트 세션 발급을 호출하지 않습니다. RED 수정본을 BLUE로 넘기면 BLUE 화면으로 이동하며 맹검 입력만 전달합니다.
- 웹 실행 활성화 시 `#hosted-ai`를 RED·BLUE 모두 Step 1(논문 입력) 바로 아래에 두고, 외부 AI 수동 복붙 패널은 접힌 보조 경로로 두었습니다(오프라인 구성에서는 기존 즉시 노출 유지). 상단 노란 안내판(`#wayfinding`)과 BLUE 인계 액션이 웹 실행 상태를 반영합니다.
- 웹 실행 지시 입력란 위에 역할별 원클릭 프리셋 버튼(`추천 지시 채우기`, BLUE `교차 검증 지시 채우기`)을 추가했고, 완료된 웹 BLUE 작업의 수용 지적 카드를 화면에 표시하며 `FalsifyLab.record` 로컬 원장 기록과 검수(H1) 이동 버튼을 연결했습니다.
- RED 논문 비교 영역에 데스크톱 `1단 크게 보기` / `2단 나란히 보기` 전환 버튼(`#paper-layout-toggle`)을 추가하고, 상단 확대·축소 버튼과 하단 비교 바의 `실행 취소`·`다시 실행`을 복원했습니다.
- 검수(H1)의 BLUE 항목 판정 버튼에서 누락되었던 `pre-existing`, `spin-boundary`, `gold-error` 3종을 복원해 8종 판정을 모두 선택할 수 있게 했고, 판정 라벨 극성과 비안내판 영역의 색상·서체를 `DESIGN.md` 기준에 맞췄습니다.

## 0.2.0-alpha.81 — 2026-11-18

- 호스팅 런타임은 `HOSTED_PAPER_TOOLS=1`일 때 `POST /internal/v1/paper`에서 companion과 같은 함수로 evidence prepare·query, visual export, chart prepare, 분석 작업 제출·조회·취소를 실행합니다. 그 밖은 `404 paper_path_unsupported`입니다. 소유자마다 논문은 2개, 유휴 7200초이고, 소유자는 32명까지 두며 넘치면 분석 중이 아닌 가장 오래된 소유자를 지웁니다. CPU 호출은 동시에 2개까지이며 가득 차면 기다리지 않고 `429 paper_busy`입니다. 분석 작업은 소유자당 1개, 전체 1개이고 넘치면 같은 코드입니다. 이 호출은 RED/BLUE 작업 실행기를 쓰지 않습니다. 이 경로의 JSON 한도는 29360128바이트입니다. `/internal/v1/health`는 켜져 있을 때만 `paperTools`를 넣습니다.
- Worker `POST /v1/ai/paper`가 그 요청을 런타임으로 보냅니다. `AI_PAPER_TOOLS_ENABLED`가 `true`일 때만 열리고, 운영과 `event`의 `wrangler.jsonc`가 그 값입니다. wrangler가 덮어쓰지 않은 기본 상한은 본문 29360128바이트, 준비 시간당 30회(게스트 10회), 호출 시간당 600회(게스트 240회), 전체 호출 3000회입니다. `/api/paper/evidence/prepare`만 준비 한도에 들고, 나머지 논문 호출은 호출 한도에만 듭니다. 게스트 준비 PDF의 디코드 크기는 운영·행사 `AI_GUEST_MAX_UPLOAD_BYTES` 20971520바이트, 그 밖은 `AI_MAX_UPLOAD_BYTES` 33554432바이트를 넘지 않습니다. `GET /v1/ai/capabilities`는 켜져 있을 때만 `paperTools` `{"enabled": true}`를 줍니다.
- 「표·그래프·그림 고치기」와 표·그림·분석 패널은 PC companion이 연결되어 있으면 그 세션을 쓰고, 아니면 `paperTools`가 켜진 호스팅 세션을 씁니다. 호스팅일 때 연결 실패 문구는 「웹 실행 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요.」이고 버튼은 「웹 실행 다시 시도」입니다.
- 「글 편집」은 포인터 위치에서 선택 끝점을 정합니다. 여러 영역에 걸치면 「선택이 여러 영역에 걸쳐 있습니다. 한 영역 안에서 다시 선택하세요.」이고, 회전된 글자는 「회전된 글자는 글 편집으로 넣을 수 없습니다. 표·그래프·그림 고치기를 쓰세요.」입니다.
- 그림 안 글자를 만들 때 편집이 폼 스트림에 있으면 리소스 이름을 먼저 끌어올립니다. 만든 PDF가 그림을 깨뜨리면 그 파일 대신 「그림 안 글자를 고치면 그림이 깨져서 만들지 않았습니다. 표·그래프·그림 고치기를 쓰세요.」를 돌려줍니다.

## 0.2.0-alpha.80 — 2026-11-18

- 호스팅 런타임에 OpenAI Responses 백엔드(`app/local/openai_backend.py`)를 더했습니다. 키는 서버의 `OPENAI_API_KEY`만 읽습니다. 구조화 출력은 `text.format`의 `json_schema`이고 `strict`는 true입니다. 노력도 `low`·`medium`·`high`·`xhigh`·`max`는 모델별 `reasoning.effort`로 대응합니다. `max`는 그 모델이 지원하는 가장 높은 값이고, `xhigh`는 지원하면 `xhigh`, 아니면 `high`입니다. 이 모듈은 유료 호출을 스스로 재시도하지 않습니다.
- `claude-*`는 `anthropic`, `gpt-*`와 `o` 다음에 숫자가 오는 이름은 `openai`, 그 밖은 허용하지 않습니다. Python `provider_for_model`과 Worker `providerForModel`이 같은 규칙입니다. 작업의 `provider`는 그 작업 모델에서 정합니다.
- `GET /v1/ai/capabilities`는 나열된 모델마다 `modelProviders`를 줍니다. 화면의 모델 목록은 `Claude`와 `OpenAI` 그룹으로 나뉩니다.
- 기본 페이지는 로그인 없이 열리고, 게스트 세션은 접속 키 없이 발급됩니다. 페이지를 열 때는 발급하지 않고, 실행이나 적용이 API를 필요로 할 때만 `POST /v1/ai/guest`를 호출합니다. PC companion은 페이지를 열거나 호스팅 실행을 시작하는 조건이 아닙니다. 운영 Worker와 `event` Worker는 `AI_OPEN_ACCESS`가 `true`이고 모델은 `claude-opus-5-5`·`claude-sonnet-5-5`·`claude-haiku-5-5`·`gpt-6.2-astra`·`gpt-5.5`·`gpt-5.4-mini`입니다. 운영 게스트 상한은 세션 21600초, IP당 시간당 발급 20회, 전체 발급 300회, 업로드 10회·전체 120회, 본문 20971520바이트, 작업 6회·전체 40회, 동시 작업 1개, 작업당 호출 8회, 토큰 예산 3000000(86400초)입니다. 행사 Worker는 IP당 발급 60회와 토큰 예산 4000000이고 나머지 게스트 상한은 같습니다.

## 0.2.0-alpha.79 — 2026-11-18

- `POST /v1/ai/guest`는 호스팅이 켜져 있고 `AI_OPEN_ACCESS`가 `true`일 때만 게스트를 발급합니다. 토큰은 `fsg_`와 base64url 43자이고, 소유자는 세션마다 `gst:<uuid v4>`입니다. 이 베어러는 `/v1/ai/*`에서만 받고, 기록·Confluence·비밀번호·로그아웃은 알 수 없는 토큰과 같이 거절합니다. 오픈 액세스가 꺼져 있으면 발급과 이후 `fsg_` 사용은 `403 open_access_disabled`이고, 호스팅이 꺼져 있으면 그 경로는 `404`입니다.
- 기본 상한은 IP당 시간당 발급 10회, 전체 발급 600회, 게스트당 업로드 10회·작업 6회·동시 작업 1개·작업당 호출 8회, 업로드 본문 20971520바이트입니다. 전체 작업 150회와 전체 런타임 업로드 300회가 더 셉니다. 기본값에서 유료 호출은 시간당 1200회, 새 런타임 업로드는 300회(6291456000바이트)를 넘지 않습니다. 비밀번호 세션과 Confluence 소유자의 기존 상한은 그대로이고, 토큰 예산 기본값 0은 이 1200을 줄이지 않습니다.
- 행사 링크의 `#k=`는 한 번 읽어 `sessionStorage`에만 두고 `history.replaceState`로 프래그먼트를 지운 뒤, 게스트 요청 본문에만 보냅니다. `event.html`과 `cloud-config.event.js`는 기본 `index.html`과 `cloud-config.js`를 바꾸지 않고 옆에 두며, 릴리스 ZIP은 이 두 파일을 제외합니다.
- 열린 모드에서는 로그인 폼과 PC 연결 UI를 숨깁니다. 페이지를 열 때는 게스트를 발급하지 않고, 실행이나 적용이 API를 필요로 할 때만 `POST /v1/ai/guest`를 호출합니다.

## 0.2.0-alpha.78 — 2026-11-18

- `pdf_twin.py make`와 `pair_corpus.py build`는 출력 디렉터리가 비어 있지 않으면 `out_dir_not_empty`로 끝납니다(종료 코드 3). `pair_corpus`의 `output_not_empty`와 종료 코드 2는 더 이상 쓰지 않습니다.
- `render.py`는 LaTeX를 조립한 뒤 벤더 `table_lint`를 실행하고, 그림을 그린 뒤 `pdflatex` 전에 `figure_lint`를 실행합니다. ERROR는 `table_lint` 또는 `figure_lint`로 종료 코드 3입니다. WARN은 `{lint, code, count}` 목록인 `lintWarnings`로 나갑니다. 쌍둥이 표준출력과 `twin.json`은 정상본 개수를 담고, 결함본 개수가 다르면 `sealed/defect-lint-warnings.json`(`falsify.defect-lint-warnings.v1`)에 둡니다. 현재 픽스처 다섯 개와 변형 집합 46개에서 나오는 경고는 `no-label`, `no-metric-direction`, `no-pipeline-figure`뿐이며 거절하지 않습니다. 이 경고가 탐지에 미치는 영향은 측정하지 않았습니다.
- `blue scan-workspace --argument-outline`과 MCP `triage_workspace`의 `includeArgumentOutline`(기본값 false)은 순위가 매겨진 논문마다 짧은 조언용 `argumentOutline`을 더합니다. 신호, 점수, 순위, 플래그가 꺼진 캐시 키는 바뀌지 않습니다. `--manuscript-date`는 `blue scan --oracle`에만 있습니다. 재현율과 거짓 양성은 측정하지 않았습니다.
- 합성 소스 사례를 쓰는 지침을 `.agents/skills/falsify-corpus-author/SKILL.md`에 넣었습니다. 저장소는 그 사례를 만들 때 모델을 호출하지 않으며, `app/tests/test_corpus_author_skill.py`가 문서의 명령을 도구 argparse와 맞춥니다. 새 사례의 판정 성능은 측정하지 않았습니다.
- 호스팅 증거 검사는 고정 15초 대신, 작업의 저장된 종료 상태를 네이티브 워커 제한 시간에서 뽑은 예산 동안 기다립니다. CPU를 가득 채운 상태에서 50회 돌렸을 때 실패는 0회였고 가장 긴 대기는 약 12초였습니다. 원래 실패는 재현하지 못했습니다.

## 0.2.0-alpha.77 — 2026-11-17

- 논증 개요의 D3/S1 힌트를 BLUE 스캔에 선택으로 붙였습니다. 이 힌트는 조언이며, 재현율과 거짓 양성에 미치는 영향은 아직 측정하지 않았습니다.
- BLUE Evidence v0.4.2 묶음을 검사에 포함했습니다.
- 참고문헌 대조는 Crossref, Europe PMC, OpenAlex 세 색인을 봅니다. 새 외부 호스트는 `api.openalex.org`이고, Crossref와 Europe PMC가 일치하지 않을 때만 조회하며, 식별 정보는 보내지 않습니다.
- 원고 날짜가 있으면 인용 시점이 원고보다 늦은 참고문헌을 조언 힌트로 알립니다.
- 소스 사례 도구(`tools/corpus`)를 넣었습니다. 한 원본에서 정상본과 결함본 PDF를 같은 조판 경로로 만들고, 같은 입력이면 바이트가 같은 PDF가 나옵니다. 로컬에 pdfLaTeX와 matplotlib이 있어야 하며, 없으면 조판 검사는 건너뜁니다. 생성기와 판정 관문은 같은 디렉터리에 있습니다.
- PaperOrchestra 원본 16개 파일을 수정 없이 보관하고 출처와 해시를 고지에 적었습니다.
- `falsify schemas`에 `falsify.argument-outline.v1`을 등록했고, `--manuscript-date`는 `--oracle`과 함께만 받습니다.
- 소스 변형기는 선언된 변형 집합으로 결함 쌍을 만들고, 정답 키는 `sealed/` 아래에만 씁니다. 연산자는 `set_text`, `shift_number`, `scale_number`, `transpose_digits`, `swap_values`, `set_phrase`, `apply_template`, `swap_citation` 여덟 가지입니다.
- 쌍 판정 관문은 열 가지 검사를 하고, 모두 통과할 때만 벤치마크 묶음을 씁니다. `claims` 검사는 건너뛰지 않고 인쇄된 숫자를 소스 사례와 비교합니다.
- 손으로 쓴 사례는 무작위 배정 시험, 진단 정확도, 메타분석, 코호트, 생존 분석 다섯 가지이고, 변형 집합은 46개입니다.
- 순서 바꾼 사전 판정 도구(`tools/evaluation/adjudication_swap.py`)는 범주와 항목 순서를 뒤바꾼 두 판정 패킷을 만들고 두 응답을 맞춥니다. 모델 호출은 하지 않으며, 불일치와 주장이 없는 항목은 사람 검토로 가고, 최종 결정은 사람이 합니다.
- 소스 변형기에 `swap_citation`을 더했습니다. 금 원장의 `kind`는 `source-value`, `source-phrase`, `source-citation`이고, `producer`는 소스 변형 `source-native`와 PDF 편집 대응본 `pdf-mutation`입니다.
- 쌍 판정 관문의 `claims` 검사는 인쇄된 숫자를 소스 사례와 비교합니다. 구문 결함, 인용 결함, 모든 문맥이 그림 이미지인 값 결함은 `notApplicable`이며 이유는 `phrase`, `citation`, `figure_image_only`입니다.
- `falsify corpus list`, `build`, `mutate`, `verify`를 넣었습니다.
- PDF 편집 대응본(`falsify.source-pdf-pair.v1`)과 짝 코퍼스(`pair_corpus.py`의 `build`와 `measure`, `falsify.leak-dependence.v1`)를 넣었습니다. 기본 `build`는 `p*-pair-*` 집합 16개만 고릅니다.
- 손으로 쓴 사례에 코호트와 생존 분석을 더했습니다. `corpus list`는 사례 5개, 변형 집합 46개를 보고합니다.
- 아레나 채점은 소스 원본 원장을 받습니다. 순서 바꾼 사전 판정은 `from-evaluation`과 `sourceDiffers`를 보고합니다.
- 벤치마크 코퍼스 v5는 v4 32사례를 유지한 채 소스 원본 사례를 더합니다. `falsify arena benchmark`와 캠페인 승격 관문의 기본은 v4이고, v5는 `--corpus-version v5`로 요청합니다.
- v5 센서 모드를 한 번 실행했습니다. 벽시계 298.6초, 소스 사례 built 46, refused 0, skipped 0입니다. 소스 원본 골드 결함 46개 중 detected는 4이고, 난이도 L1과 L2만 모은 layer0Recall은 1/16입니다. 같은 32개 v4 사례의 사례별 점수는 `--corpus-version v4`와 같았습니다. 짝 코퍼스에 모델 기반 탐지기를 실행한 측정은 없습니다.
- 아직 남은 일: 짝 코퍼스에 모델 기반 탐지기를 실행한 측정은 없고, 도구가 직접 만드는 탐지 보고서는 결정적 Layer 0 센서뿐입니다. PDF 편집으로 재현하도록 둔 집합만 기본 `build`가 고르며, 그 파일은 `p*-pair-*` 16개입니다. 이 픽스처 트리에서 기록된 기본 실행은 집합 16개, paired 14, sourceOnly 2, refused 0이고, sourceOnly 이유는 `figure_image`와 `unit_failed`가 각 하나입니다. 손으로 쓴 `m*` 집합 대부분은 이 편집으로 재현되지 않습니다. `falsify arena benchmark`와 캠페인 승격 관문의 기본은 v4이고, `falsify corpus`에는 짝 코퍼스 명령이 없습니다.

## 0.2.0-alpha.76 — 2026-11-17

- PDF 모듈의 정식 import를 사용해 MCP JSON-RPC 출력에 호환 모듈 경고가 섞이는 결함을 고쳤습니다.
- 운영자 Anthropic 웹 실행과 평가 메타데이터 계약 정리를 포함합니다.

## 0.2.0-alpha.75 — 2026-11-17

- 운영자 Anthropic 웹 실행과 평가 도구의 제공자·사용량 메타데이터 계약을 동기화합니다.
- 호스팅이 켜진 배포와 별도로 기존 브라우저 회귀 검사는 오프라인 설정을 사용합니다.

# Changelog

## 0.2.0-alpha.74

- Add operator-funded Anthropic RED/BLUE execution in the web app, with login, upload, durable jobs, progress, cancellation, downloads and session recovery. The model key stays in the hosted Python runtime.
- Connect structured table/figure evidence, selected text/table edits and edited-PDF handoff to BLUE. Preserve the existing local CLI and external-response routes.
- Batch hosted reviews and keep valid partial results; show remaining coverage and unresolved quote locations. Configure execution budgets on the server.
- Preserve original PDF text operators when supported, and maintain the production CCN ceiling of 15.

## 0.2.0-alpha.73

- Fix `falsify red apply` text-span mutation on PDFs with embedded subset fonts (`app/local/paper_text_span_mutator.py`): the replacement font is re-registered after redaction (previously `need font file or buffer`), replacement words are placed one by one so fonts without a space glyph no longer leave ` ` in the text layer, original word x positions are kept when the word count is unchanged, and same-span right neighbours now bound the replacement width.
- Fix line-wrapped DOI false positives in the BLUE sensor (`app/local/paper_blue_sensor.py`): link rectangles sharing a `/URI` and bibliography entry are judged once on their joined visible text, visible text is taken from words centred inside the link rectangle, and `malformed_doi` is reported only when the token is malformed in both the spaced and the de-wrapped reading.
- Fix `hidden_pdf_text_layer` false positives on pure-blue hyperlink text (`app/local/paper_pdf_security_forensics.py`: integer span colours are always decoded as `0xRRGGBB`) and `axis_scale_distortion` false positives from numbers inside prose lines (`app/local/paper_figure_forensics.py`).
- Add a reading-order fallback to BLUE quote validation (`app/local/blue_report_validate.py`): when exact and folded lookup fail, quotes are searched in word-geometry order (`matchMode: "visual_order"`, `status: "normalized"`, with a word-union `bbox`), and ` ` is folded to a space.
- Extend arena scoring (`tools/evaluation/arena_runner.py`) with changed-token evidence matching that also reads the finding `rationale` (same page or supplement), cross-page contradiction matching, coupled gold items settled by one finding (`coupledWith`), and `splitOfMatchedCount` / `splitOfMatchedFindingIds` for findings that restate part of an already matched gold item. Existing match branches and output keys are unchanged.

## 0.2.0-alpha.72

- Add PRISMA participant/record flow, forest-plot study weight sum, Cochran's `Q`/`I²` heterogeneity, inverse-variance pooled effect, and cross-table `N` auditor (`app/local/paper_meta_and_table_audit.py`, `falsify.meta-and-table-audit.v1`), wired into `paper_blue_sensor.py`, `paper_mcp.py` (`audit_meta_and_tables`, `run_blue_sensor`), and `falsify_cli.py blue scan --meta-tables`.
- Add offline PDF hidden-text (`Tr=3`, near-white/zero-opacity, micro-font, off-page, with scanned-OCR overlay exemption) and prompt-injection auditor (`app/local/paper_pdf_security_forensics.py`, `falsify.pdf-security-forensics.v1`, exempting visible quotes in AI-security manuscripts), expand `paper_figure_forensics.py` with intra-image `composite_subpanel_duplicate` and `axis_scale_distortion` checks, and add portable `BLUE Evidence v0.4.1` (`app/examples/evidence_blue_v041`) without modifying frozen `v031`–`v040` bundles.
- Add surgical structure-preserving `.xlsx` (`xlsx-cell` with optional `afterFormula` + untouched-workbook byte identity) and `.ipynb` (`ipynb-cell` source/output/execution_count) RED mutator (`app/local/paper_supplement_mutator.py`, `paper_red_mcp.py`, `paper_red_detectability.py`, `falsify red apply --out-supplement-dir`), wire `redBrief` onto `paper_red_mcp.py:plan_coordinated_mutation`, add `L4` semantic `D3`/`S1`/`D5` templates, and add portable autonomous `RED Injector v0.4` (`app/examples/adversarial_red_v04`) without modifying `adversarial_red_v01`–`v03`.
- Add content-addressed, answer-key-free, path-free LRU `EvidenceCache` (`app/local/paper_evidence_cache.py`, `falsify.evidence-cache.v1`, `--cache-dir`), expand `paper_mcp_workspace.py` (`triage_workspace`) with `.xlsx`/`.ipynb` pairing plus `flow_triage` and `internal_consistency` ranking, and add `SARIF 2.1.0` export + 13-schema machine-readable catalog (`app/local/paper_sarif_export.py`, `--sarif`, `falsify schemas`).
- Add multi-contender `N × M` RED-vs-BLUE round-robin tournament with Laplace-smoothed Bradley-Terry MM + batch Elo + Pareto frontier (`tools/evaluation/arena_tournament.py`, `falsify.arena-tournament.v1`, `falsify arena tournament`), heterogeneous multi-BLUE consensus & minority-defect `확인필요` preservation (`tools/evaluation/blue_ensemble.py`, `falsify.blue-ensemble.v1`, `falsify blue ensemble`), `--checkpoint-dir`/`--resume`/`--max-total-seconds` on `arena_campaign.py` (`falsify arena evolve`), and synchronize all 3 Agent Skills.
- Expand `tools/evaluation/benchmark_suite.py` (`falsify arena benchmark`, `falsify.benchmark-report.v1`, `corpusVersion = "v4"`) from 24 to 32 synthetic cases (18 Gold including PRISMA flow, Cochran's `Q`/`I²`, hidden white-text prompt injection, and composite subpanel clone + 14 Benign-Trap Holdout including balanced PRISMA, scanned OCR overlay, AI-security visible discussion, and broken-axis chart).

## 0.2.0-alpha.71

- Add stdlib-only Excel workbook (`.xlsx` multi-sheet OpenXML + `<f>` formula vs cached `<v>` check, XXE/ZIP-bomb hardened) and Jupyter/Quarto notebook (`.ipynb`, `.Rmd`, `.qmd`) loader (`app/local/paper_tabular_notebook_loader.py`), expanding `paper_mcp_bundle.py`, `paper_raw_dataset_audit.py` (`xlsx_formula_value_mismatch`), `paper_code_audit.py` (`notebook_out_of_order_execution`, `notebook_output_prose_mismatch`, never executing cells/macros), `paper_supplement_audit.py`, and `falsify_cli.py`.
- Add IMRaD cross-section sample-size, metric, and protocol consistency auditor (`app/local/paper_internal_consistency.py`, `falsify.internal-consistency.v1`: deterministic `signals` separated from advisory `triageHints`), wired into `paper_blue_sensor.py`, `paper_mcp.py` (`audit_internal_consistency`, `run_blue_sensor`), `falsify_cli.py blue scan --internal-consistency`, and portable `BLUE Evidence v0.4.0` (`app/examples/evidence_blue_v040`) without modifying frozen `v031`–`v039` bundles.
- Expand RED coordinated mutation planner (`app/local/paper_red_planner.py`, `paper_red_detectability.py`) with vector `chart-shape` (`bar`/`scatter`/`curve`) + prose + table/supplement 3-surface `L3`/`L4` bundle synthesis, closed-loop `redBrief` family/surface prioritization (`falsify red plan --red-brief`), and portable autonomous `RED Injector v0.3` (`app/examples/adversarial_red_v03`) without modifying `adversarial_red_v01`–`v02`.
- Upgrade `blue_report_validate.py` with `.xlsx` `(Sheet, Cell)` / `.ipynb` cell / `.Rmd` / `.qmd` quote verification and one-shot `finalize_blue_report` (`falsify.blue-report-finalize.v1`, `falsify blue finalize`: quote repair application + Zero-Drop restoration + unverified quote auto-downgrade to `확인필요`), and synchronize repo-native Agent Skills (`falsify-blue-auditor`, `falsify-red-injector`, plus new `.agents/skills/falsify-arena-operator/SKILL.md`).
- Upgrade `arena_round.py`, `arena_duel.py`, and `arena_campaign.py` (`falsify arena duel`, `falsify arena apply-patch --compact-rules`, `falsify arena evolve --role blue|red|both`) with alternating RED+BLUE co-evolution (`finalBlueHarness` + `finalRedHarness`), Pareto non-regression promotion (`recall` + `holdoutPureFp == 0` + `stealthYield`), and rule deduplication/compaction (`compact_harness_rules`).
- Expand `tools/evaluation/benchmark_suite.py` (`falsify arena benchmark`, `falsify.benchmark-report.v1`, `corpusVersion = "v3"`) from 18 to 24 synthetic cases (14 Gold including `.xlsx` formula mismatch, `.ipynb` out-of-order/leakage, and IMRaD drift + 10 Benign-Trap Holdout including clean multi-sheet `.xlsx`, ordered `Pipeline` `.ipynb`, and explicit per-protocol subsample `n =`).

## 0.2.0-alpha.70

- Add deterministic CONSORT participant-flow arithmetic auditor (`consort_flow_mismatch`, `arm_allocation_sum_mismatch`, `subgroup_denominator_mismatch`, `category_sum_mismatch`) and strictly separated `D3`/`S1` semantic spin-triage hints (`app/local/paper_flow_and_spin_triage.py`, `falsify.flow-spin-triage.v1`), wired into `paper_blue_sensor.py`, `paper_mcp.py` (`audit_flow_and_spin`, `run_blue_sensor`), and `falsify_cli.py blue scan --flow-triage`.
- Add static-only AST/regex code supplement auditor for `.py`/`.R`/`.Rmd`/`.sql` (`app/local/paper_code_audit.py`, `falsify.code-audit.v1`: `code_tailness_mismatch`, `code_preprocessing_leakage`, `code_hardcoded_threshold_mismatch`, `code_undisclosed_row_filter`, never executing scripts), wired into `paper_mcp.py` (`audit_code_supplements`), `falsify_cli.py blue scan --audit-code`, and portable `BLUE Evidence v0.3.9` (`app/examples/evidence_blue_v039`) without modifying frozen `v031`–`v038` bundles.
- Add multi-surface `L3`/`L4` coordinated RED mutation planner (`app/local/paper_red_planner.py`, `falsify.red-plan.v1`), `falsify_cli.py red plan` & `red apply --out-supplement-dir` + `mcp-config --role red|both --supplement`, and portable autonomous `RED Injector v0.2` (`app/examples/adversarial_red_v02`) synthesizing stealth-verified PDF + supplement blind bundles alongside sealed `falsify.red-gold-ledger.v1` ledgers without modifying `adversarial_red_v01`.
- Upgrade `blue_report_validate.py` and `falsify_cli.py blue validate` with PDF ligature (`ﬁ`/`ﬂ`/`ﬀ`/`ﬃ`/`ﬄ`), soft/line-wrap hyphen, minus (`−`), smart-quote, and `µ`/`μ` typographic folding (`status == 'normalized'`) plus `--emit-repair-pack PATH` (`falsify.quote-repair-pack.v1`, answer-key scrubbed).
- Expand `paper_mcp_workspace.py` and `falsify_cli.py blue scan-workspace` with multi-paper automatic supplement pairing (`<stem>_supp*`, `supplements/<stem>/*`, answer-key masked) and ranked batch Layer 0 `triage_workspace` (`falsify.workspace-triage.v1`).
- Add multi-generation unattended co-evolution campaign runner (`tools/evaluation/arena_campaign.py`, `falsify.arena-campaign.v1`, `falsify arena evolve`, `generations <= 3` cap, Holdout FP guard, raw/code supplement signal scoring in `arena_runner.py`) and expand `tools/evaluation/benchmark_suite.py` (`falsify arena benchmark`, `falsify.benchmark-report.v2`) to 18 synthetic cases (11 Gold across `W1–W5`, raw CSV, `.py` leakage, CONSORT flow + 7 Benign-Trap Holdout cases including ligatures, pipeline-scoped CV scaling, and missingness footnotes).

## 0.2.0-alpha.69

- Add row-level raw dataset statistical recomputation auditor (`app/local/paper_raw_dataset_audit.py`, `falsify.raw-dataset-audit.v1`) recomputing `N`, non-missing `n`, group-by `mean ± SD`, `median [IQR]`, `k/n (%)`, Welch/Student `t`-test and 2×2 Fisher/chi-square `p` from `.csv/.tsv/.json` supplements (exempting adjusted `aOR`/`aRR`/`aHR` and multiplicity-corrected `FDR`/`Bonferroni` `p_adj`), wired into `paper_mcp.py` (`recompute_raw_supplement`) and `falsify_cli.py blue scan --recompute-raw`.
- Expose `paper_figure_forensics.audit_figure_forensics` on `paper_mcp.py` (`audit_figures` + `run_blue_sensor(..., includeFigureForensics=...)`) and `falsify_cli.py blue scan --figure-forensics`, and add portable `BLUE Evidence v0.3.8` (`app/examples/evidence_blue_v038`) combining raw-dataset triage with post-model Zero-Drop restoration and a 1-turn quote-repair / ungrounded-quote downgrade gate without modifying frozen `v031`–`v037` bundles.
- Expose `paper_red_detectability.py` on `falsify_cli.py` (`red simulate`, `red trace`), enforce `--min-difficulty L1|L2|L3|L4` pre-export gating on `red apply` (exiting `3` with `difficulty_below_minimum` without writing `--out-pdf`), and add portable autonomous `RED Injector v0.1` (`app/examples/adversarial_red_v01`) emitting a stealth-verified blind bundle plus a sealed `falsify.red-gold-ledger.v1` ledger.
- Upgrade `blue_report_validate.py` and `falsify_cli.py blue validate` with repeatable `--supplement PATH` quote verification across `.csv/.tsv/.json/.md/.txt/.log/.py/.r/.sql/.pdf/.docx` (with supplement `nearestCandidates` and exit `3` on forbidden RED keys), and upgrade `falsify_cli.py mcp-config` with standalone `--workspace DIR` and `--role blue|red|both`.
- Add unattended RED-vs-BLUE duel orchestrator and generation-capped (`max_generations <= 3`) harness patch applier with Holdout Rollback Guard (`tools/evaluation/arena_duel.py`, `falsify arena duel`, `falsify arena apply-patch`), plus a 10-case deterministic synthetic regression benchmark suite (`tools/evaluation/benchmark_suite.py`, `falsify arena benchmark`: 6 Gold `W1–W5` cases + 4 Benign-Trap Holdout cases).

## 0.2.0-alpha.68

- Add BLUE supplement-table arithmetic audit (`supplement_table_sum_mismatch`, `supplement_table_percentage_mismatch`) and a figure/panel forensic sensor (`app/local/paper_figure_forensics.py`, `falsify.figure-forensics.v1`) that detects dHash/aHash duplicate, horizontally mirrored, 180-degree rotated and centred-crop panel pairs plus chart printed-value vs prose mismatch candidates with bboxes; `paper_blue_sensor.run_blue_sensor` exposes it behind the opt-in `include_figure_forensics` flag.
- Add RED detectability simulation and claim propagation (`app/local/paper_red_detectability.py`): `simulate_red_detectability` diffs Layer 0 signals between the source and the in-memory edited copy and classifies L1-L4 cross-inference distance and exposure risk (D3/S1 remain L4 because Layer 0 has no detector for them), and `trace_claim_propagation` locates one claim across prose, tables, figures, citations and supplements. Every mutation failure now returns `{error, actualValue, nearestCandidates, bbox, recoveryHint}` without path leakage (`app/local/paper_red_errors.py`).
- Add `falsify blue validate` (`app/local/blue_report_validate.py`): verbatim quote gate with normalized and nearest-candidate fallback, Zero-Drop restoration ported from the web app, 12-column arena CSV normalization, exit code `3` while a missing quote survives; add `falsify mcp-config` stdio client configuration output for Claude, Codex and Gemini.
- Add read-only multi-document MCP mode (`app/local/paper_mcp_workspace.py`, `python app/local/paper_mcp.py --workspace DIR`): bounded 32-paper scan, answer-key filename masking, `list_papers`/`select_paper` selection, path-escape refusal and no absolute-path payloads; the single `--pdf` mode is unchanged.
- Add an unattended arena round runner and answer-key-free distiller (`tools/evaluation/arena_round.py`, `falsify.arena-round.v1` / `falsify.harness-patch.v1`): leak-gated cleanroom containing only the blind bundle, arbitrary stdio agent commands through `harness_adapter`, multi-run scoring via `evaluate_arena_match`, and failure-to-rule distillation with a fail-closed scrubber; exposed as `falsify arena run-round` and `falsify arena distill`.

## 0.2.0-alpha.67

- Upgrade Read-Only BLUE MCP (`app/local/paper_mcp.py`, `app/local/paper_mcp_bundle.py`) with offline `run_blue_sensor` (`digestOnly` token-budget mode), repeatable `--supplement PATH` bundle tools (`list_supplements`, paginated `read_supplement`, `audit_supplements`), and explicit opt-in `--oracle` `P2` tools (`verify_references`, `verify_registries`).
- Add autonomous `BLUE Evidence v0.3.7` runner (`app/examples/evidence_blue_v037`) prepending a zero-model-cost deterministic Layer 0 Triage Digest (`SPRITE`/`2×2`/`KM` stats, `supp-*` cross-file audit, offline registry checks) and extended `P2` retraction & `OSF`/`PROSPERO`/`GEO`/`PDB` grounding (`<= 18,000` chars) without modifying frozen `v031`–`v036` bundles.
- Expand Coordinated RED MCP (`app/local/paper_text_span_mutator.py`, `app/local/paper_red_mcp.py`) to full-modal stealth authoring with native PDF prose `text-span` inspection/mutation (`list_text_spans`, glyph-only redaction, baseline-aligned font fitting, self-healing `SpanMutationError` `nearestCandidates` & `recoveryHint`), `supplement-edit` (`--supplement`, `list_red_supplements`), `baselineOverlaps` (`Baseline Guard`), and sealed `goldLedger` (`falsify.red-gold-ledger.v1`).
- Add unified headless Agent JSON CLI (`app/local/falsify_cli.py`: `blue scan`, `red targets`, `red apply`, `blind verify`, `arena score` with `--digest-only` `< 12 KB` budget and deterministic exit codes `0`/`2`/`3`/`124`) and repo-native Agent Skills (`.agents/skills/falsify-blue-auditor/SKILL.md`, `.agents/skills/falsify-red-injector/SKILL.md`).
- Add headless Co-Evolution Arena evaluator and blind-bundle verifier (`tools/evaluation/arena_runner.py`: `verify_blind_bundle` across DocInfo/XMP/annotations/AcroForm/supplements with source-inherited exemption, plus `evaluate_arena_match` 1-to-1 bipartite matching, `Baseline Guard` `preExistingExempted`, `W1–W5`/`D1–D7`/`L1–L4` stratified recall, `stealthYield`, `Krippendorff's α`, `AURC`, and `feedbackDigest`).

## 0.2.0-alpha.66

- Convert `app/tests/test_paper_supplement_audit.py` from `pytest` to standard-library `unittest.TestCase` so GitHub Actions Ubuntu `python -m unittest discover -s app/tests -p 'test_*.py'` runs cleanly without external test runners and deploys GitHub Pages.

## 0.2.0-alpha.65

- Fix companion HTTP `supplement_audit` page-text extraction in `paper_evidence_http.py` (`_require_bound_pdf` + `_open_pdf` instead of unsupported `kind='page'` on `EvidenceStore.list_items`) and add end-to-end HTTP adapter regression test in `test_paper_supplement_audit.py`.

## 0.2.0-alpha.64

- Add BLUE multi-file supplement/code/log bundle cross-verification (`blue-supplement-bundle.js`, `paper_supplement_audit.py`, `paper_evidence_http.py`, `document-blue.js`) detecting orphan cited `Table S*`/`Fig. S*` items (`D4-1`), cross-file `N=` sample-size mismatches (`D1`), and main-vs-supplement metric contradictions (`D1`) while seamlessly attaching `supp-*` segments to local and external BLUE runs.
- Expand Layer 0 deterministic statistical & clinical forensics (`paper_stat_math.py`, `paper_stat_audit.py`, `blue-defect-sensor-core.js`) with bounded `SPRITE` mean/SD/N/min/max feasibility, 2×2 contingency table (`a/N1 vs c/N2`) exact Fisher `p` / Pearson & Yates `χ²` / crude `OR`·`RR` verification (exempting adjusted `aOR`/`aRR`), and Kaplan-Meier `Number at risk` monotonicity checks across Python and offline browser `P0`.
- Add `P2` retracted/expression-of-concern citation detection (Crossref `update-to`/`relation` + Europe PMC `Retracted Publication`) and `OSF` (`osf.io/...`), `PROSPERO` (`CRD420...`), `GEO` (`GSE...`), and `PDB` structural `P0` + fixed-host TLS `P2` registry verification (`paper_external_grounding.py`, `paper_registry_identifiers.py`, `paper_blue_sensor.py`).
- Add RED pre-injection `Baseline Guard` source flaw & candidate-overlap scanner plus pixel-preserving lossless PDF `/URI` hyperlink mutator (`W5 D2-1`·`D2-3`) across browser (`red-baseline-uri.js`) and Coordinated RED MCP (`paper_uri_mutator.py`, `paper_red_mcp.py` `scan_source_baseline`, `list_pdf_links`, and `uri-link` operations) with strict blindness leak rejection.
- Upgrade Co-Evolution Arena (`coevolution-arena.js`) and `tools/evaluation/agreement_selective.py` with exact nominal & ordinal `Krippendorff's α` multi-rater / multi-run agreement and `확인필요` selective prediction (`Abstention Rate`, `Selective Accuracy`, `Abstention Gain`, `Risk-Coverage Curve`, `AURC`).

## 0.2.0-alpha.63

- Fix `#blue-defect-sensor` panel class in `blue-defect-sensor-ui.js` so `visual-workflow.js` `:scope > .role-step` keeps `[intake, execute, result]` indices intact, keeping `#blue-defect-sensor` visible directly below BLUE intake and keeping `#doc-blue-request` visible after `BLUE로 보내기` in `latex-source.browser.cjs` CI & GitHub Pages deployment.

## 0.2.0-alpha.62

- Implement Confluence-grounded Cops-and-Robbers (`BLUE` blind defect verifier vs `RED` defect-injection stress tester) v2 co-evolution architecture across RED, BLUE, Human Audit (`H1`), and Co-Evolution Arena (`A1`).
- Separate RED oracle-based defect families (`D1` numeric/table/chart mismatch, `D2` citation/bibliography/URI distortion, `D3` claim-exceeding-evidence/spin, `D4-1` outcome status mislabeling, `S1` domain polarity/mechanism inversion) from `L1`–`L4` stealth difficulty, and enforce a pre-export Blindness Leak Gate (`adversarial-taxonomy.js`, `document-red-core.js`, `red_service.py`, `paper_stealth_audit.py`).
- Add Layer 0 deterministic BLUE forensic sensor (`paper_blue_sensor.py`, `blue-defect-sensor-core.js`, `blue-defect-sensor-ui.js`) covering `P0` offline stat/citation checks, PDF `/URI` vs printed DOI/URL mismatches, `AcroForm` widget inspection, multiple-testing adjusted `p`-value guard (`paper_stat_audit.py`), and opt-in `P2` external oracle comparison (Crossref/Europe PMC/DataCite/`ClinicalTrials.gov`).
- Introduce External BLUE Two-Stage Zero-Drop protocol (`prompt-instructions.js`, `external-exchange.js`, `external-proposals.js`, `external-blue-ui.js`) separating `검증됨_이상없음` audit rows from active defects and auto-recovering silently dropped Stage 1 suspicions as `확인필요`.
- Upgrade `H1` review with 4-way non-gold precision audit (`pre-existing`, `spin-boundary`, `gold-error`, `unsupported`) and add `A1` Co-Evolution Arena (`coevolution-arena.js`) with `P0`/`P2`/`Holdout` Strict+Inclusive dual scoreboards, same-family model bias warnings, repeat-run flip tracking, `tools/evaluation/score.py` 12-column CSV + Red JSON export, and answer-key-free `C1` Harness briefs.

## 0.2.0-alpha.61

- Add deterministic BLUE statistical & arithmetic pre-audit (`paper_stat_math.py`, `paper_stat_audit.py`, read-only MCP `audit_statistics`) checking exact `z`/`t(df)`/`χ²(df)`/`F(df1,df2)`-to-`p` consistency, `n/N (%)` ratios, GRIM integer granularity, `CI` containment/log-symmetry, and 3-way prose-table-figure value reconciliation.
- Enable multi-chunk BLUE on-demand reread of omitted structured tables/figures (`evitem:<itemId>`), raise verified `visualEvidence` PNG cap to 6 across Codex, Claude Code (`stream-json`), and opt-in `stdio`/`wrapper` harnesses, and add Two-Stage Auto-Crop Visual Reread (`autoVisualReread`).
- Upgrade built-in RED with span-occurrence (`occurrence`) targeting for repeated literals, `paperEvidence`-bound multi-modal `table-cell`/`chart-point` candidates, PDF forensic/stealth self-audit (`paper_stealth_audit.py`), and Coordinated RED MCP (`paper_red_mcp.py`) while keeping exported PDFs strictly blind.
- Add full-bibliography Crossref/Europe PMC ghost/Chimera DOI verification + citing-sentence abstract grounding (`paper_external_grounding.py`), `ClinicalTrials.gov` v2 registry primary-outcome/enrollment comparison (`paper_clinical_trials.py`), and portable BLUE `v0.3.6` (`app/examples/evidence_blue_v036`) without altering frozen `v031`–`v035` bundles.

## 0.2.0-alpha.60

- Fix cross-platform Linux CI provenance verification test execution (`[process.execPath, fakeEmcc]`) for the `0.2.0-alpha.59` Wave 1 + Wave 2 release so `Publish workbench` completes and deploys GitHub Pages cleanly.

## 0.2.0-alpha.59

- Expand BLUE evidence context to 24,000 characters ranked by scientific relevance, classify repeated header/footer logos and icons as decorative, and bind multi-grid/multi-page continued tables with units, footnotes and superscripts.
- Add read-only BLUE MCP tools (`read_page_text`, `search_text`, `list_references`), chart printed-value reconciliation, isolated CI error-bar endpoint bounds, and uncalibrated zero-series guards.
- Support nested Form XObject bar/scatter mark isolation, dark-neutral raster curve separation from axes/ticks/text, and structured `table-cell` and `chart-point` external RED edits while keeping blind PDF handoff intact.
- Improve PDF-to-LaTeX numeric figure ordering, bibliography entry separation, verified `\multicolumn`/`\multirow` and two-column long/wide tables, and opt-in line-fit font width guards (`T-0157`).
- Add original LaTeX `.bbl`/multi-bib/`natbib`/`biblatex`/custom-macro analysis and two-column right, full-width and multi-page footnote collision checks (`T-0158`), plus paragraph-vendor `8f3bef6` sync and provenance verification (`sourceBuildVerified: false`).

## 0.2.0-alpha.49

- Edit curve peaks, wells, width and position while retaining source axes, labels and page layout.
- Drag native bar endpoints and scatter markers; keep precise coordinates in collapsed controls.
- Share the pinned Gaussian geometry core between browser editing and RED MCP prepare/preview/export tools.
- Preserve selected native path operands, shared Form occurrences, RGB profiles and image soft masks; patch only changed pixels in opaque raster figures.
- Download directly from the editor, restore byte-identical originals after undo, and hand only the same PDF to BLUE.

## 0.2.0-alpha.48

- Read original PDF line and cubic paths with PyMuPDF and retain source commands, style and page coordinates.
- Route raster curves through pinned WebPlotDigitizer Step/XStep and PlotTracer findLines without refitting user values.
- Preserve short branches, asymmetric error bars, requested/effective ink colors and measured/interpolated provenance.
- Read visible replacements using PDF paint order and share the point/series budget across vector and raster results.
- Verify original path provenance in BLUE and cover the new engine paths in Windows/macOS CI.

## 0.2.0-alpha.47

- Mount RED chart reading after its deferred preview and analysis dependencies load.
- Check the real entry-page script order as well as isolated controller behavior.

## 0.2.0-alpha.46

- Edit extracted table cells and replace selected figure regions in a source-bound PDF copy.
- Redraw line, scatter and bar charts from editable numeric series using pinned Chart.js and optional explicit error bars.
- Add page-region selection, PNG/JPEG replacement, image cropping and labels with before/after previews.
- Record human changes, coordinates and source/output hashes automatically; export a separate JSON record.
- Send only the generated PDF to BLUE and retain the last output when a later edit fails.

## 0.2.0-alpha.45

- Use pinned PlotTracer code for curve extraction and source-bound axis conversion.
- Add four-tick and curve-color correction in the chart preview, with the same options available through MCP.
- Keep missing calibration as a partial result instead of substituting a generated numeric table.
- Run the same JavaScript core in embedded V8 on Windows, macOS and Linux; make the legacy DePlot setup optional.
- Retain full pixel coordinates for MCP/export and compact curve summaries for BLUE's text context.

## 0.2.0-alpha.44

- Separate same-color chart curves and preserve peaks between axis ticks.
- Keep series IDs in tables/CSV and retain complete chart points in BLUE context.
- Preserve source pixels, gaps, sampling error and ambiguous crossings.

## 0.2.0-alpha.43

- 논문 표·그림 구조와 읽기 전용 MCP, 스캔 PDF OCR·그래프 읽기 도구 추가.
- 한국어 띄어쓰기와 Windows OCR 응답 인코딩 수정.
- 원본 눈금 기반 선형·로그·이중 축 곡선 측정과 출처 좌표 제공.
- JSON·CSV 다운로드, 구형 companion 업데이트 안내와 설치 가이드 추가.

## 0.2.0-alpha.42

- AI 배치 도구의 잘못된 명령 복구, 취소와 미접수 처리 수정.
- 저장 순서와 실행 영수증 보존, 이전 PDF를 유지한 실패 요청 복구 수정.
- 긴 원문·기하·자산 조회의 응답 크기와 이어 읽기 계약 수정.

## 0.2.0-alpha.41

- AI 배치 다듬기 진입 시 실행 패널을 펼치고 화면·키보드 포커스를 이동.
- 기준본 전달 준비, AI 검토 대기와 연결 오류를 실행 위치에서 표시.
- 시작 버튼 용어 통일 및 중복 시작·연결 끊김 회귀 검사 추가.

## 0.2.0-alpha.40

- 가로선 논문 표를 원본 영역으로 보존하고 셀 문자열을 원문 문자 범위에 연결.
- 그림–캡션 묶음, 같은 기준선 문장 조각과 하단 쪽번호 분류 수정.
- 생성 PDF의 원본 영역·캡션 연결·표 셀 검사와 화면 요약 추가.
- 실제 7쪽 샘플에서 영역 14개, 캡션 9쌍, 셀 112개 확인. 그림 번호순 배치와 참고문헌 줄 구분은 후속.

## 0.2.0-alpha.39

- PDF 재구성에서 제목·저자·소속·초록·절 제목·각주 위계와 관측한 크기·행간을 조판에 연결.
- 굵기·기울임·첨자 및 숫자 포함 문단의 줄 경계 공백 복원, 수학 기호용 공개 글꼴 보충.
- 기준본의 「AI로 배치 다듬기」로 기존 AI 도구에 원본·기준본 계보를 전달.
- 표 구조·일부 캡션/읽기 순서·전용 아이콘과 내용 충실도 대조는 후속.

## 0.2.0-alpha.38

- AI 레이아웃 편집 도구 23개 연결: 원본 대조, 블록·글꼴·표·그림 조정, 내용 비교와 체크포인트.
- 후보 PDF 보존과 12시간 임시 저장·복구, 소스별 기록 분리 및 단계별 요청 영수증·조회.
- 결과 품질·문제 영역 표시, 원본/후보 비교 캐시와 대응 페이지 찾기, PDF 다운로드·BLUE 전달 개선.
- 단일 단 LaTeX 긴 표의 반복 머리글과 소유권을 확인한 다중 텍스트 셀 지원.
- PDF에서 추정한 병합 셀, 재구성·2단 긴 표와 전체 논문 복원 충실도는 후속 작업.

## 0.2.0-alpha.37

- 저자명 한 단어 편집에서 문단 전체 재배치 대신 원래 글꼴·기준선과 별도 윗첨자를 보존.
- 원문 추출 순서가 다른 문단의 전체 페이지 문자 대조와 이동한 링크 영역 검증 수정.
- [변경 내용](docs/releases/0.2.0-alpha.37.md)

## 0.2.0-alpha.36

- 혼합 서식 숫자 추가 편집과 원문·전체 페이지 텍스트 검증 수정.
- 숫자를 늘렸을 때 기존 링크가 새 숫자 전체를 포함하도록 보존.
- LaTeX ZIP의 시작 파일 기준 경로와 중간 입력 파일의 그림 경로 분석 수정.
- PDF 재구성의 단 분류·세로 간격·꼬리말 예약 영역과 악센트 문자 추출 수정.
- [변경 내용](docs/releases/0.2.0-alpha.36.md)

## 0.2.0-alpha.35

- 본문·윗첨자·링크 색상이 섞인 구간에서 실제 바뀐 문자만 찾아 원래 서식을 유지하도록 수정.
- 저자 줄의 소속 번호와 인용 번호 편집에서 주변 줄을 다시 조판하지 않고 원래 PDF 객체를 유지.
- [변경 내용](docs/releases/0.2.0-alpha.35.md)

## 0.2.0-alpha.34

- LaTeX 프로젝트 입력·소스 구조 편집·브라우저 컴파일과 PDF/BLUE 전달 추가.
- 작업 저장·복구, 변경 표시, 파일 전환 중 오래된 작업의 덮어쓰기 수정.
- PDF→LaTeX 재구성은 고급 옵션의 실험 기능으로 제공.
- [변경 내용](docs/releases/0.2.0-alpha.34.md) / [지원 범위](docs/latex-source-editing-status.ko.html)

## 0.2.0-alpha.33

- 긴 수정문과 마지막 줄 삭제에서 원본 글꼴, 줄 배치와 가림 도형 순서 보존.
- 표와 본문 동시 편집, 표 재조판, 링크와 회전·CropBox 좌표 검사 수정.
- Tab 이동 후 자동 미리보기와 파일 교체 후 상태 초기화 수정.
- [변경 내용](docs/releases/0.2.0-alpha.33.md) / [검증 기록](docs/pdf-editor-repair-20261030.html)

## 0.2.0-alpha.27

- 원문 직접 편집창이 타이핑 직후 닫히는 이벤트 처리 오류 수정.
- 입력창 내부 커서 이동·선택과 한글 조합 중 편집 상태 보존.
- [변경 내용](docs/releases/0.2.0-alpha.27.md)

## 0.2.0-alpha.26

- 원본·수정본의 변경 부분 강조, 삭제 위치 표시, 편집 목록에서 비교 위치로 이동.
- 새 RED 요청의 한국어 근거 기본값과 영어 선택. 인용문은 원래 언어 유지.
- [변경 내용](docs/releases/0.2.0-alpha.26.md)

## 0.2.0-alpha.22

- PDF direct editing, whole-paper recomposition, transparent figure replacement.
- Explicit failure recovery, stable local harness binding and Confluence attempt records.
- [Release notes](docs/release-alpha22.md)

## 0.2.0-alpha.18

- RED 선택 후보를 버튼 한 번으로 PDF에 적용하고 바로 다운로드합니다.
- 알려진 학습용 표시를 편집 전에 제거하고 PDF와 별도 변경 기록을 분리합니다.
- [변경 내용](docs/release-alpha18.md)

## 0.2.0-alpha.17

- 원문·변경 항목에서 바로 편집하고 키보드로 문단을 선택합니다.
- 편집창 배치, 문단 준비, 실패 복구와 보조 도구 노출을 정리했습니다.
- [변경 내용](docs/release-alpha17.md) · [UX 판단 근거](docs/ux-editor-refinement.md)

## 0.2.0-alpha.16

- Add PDF page and region selection for optional visual BLUE input through built-in Codex, with separate observations and bound image references.
- Compare recorded Harness observations only when file, text, visual input, model, budget, rubric and provenance match. Unknown attempts and costs remain unknown.
- Add bounded original-format DOCX, HTML and ODT exports; ODT visual rendering remains unverified.
- Serialize pending admission and updates across tabs with Web Locks; preserve request-bound, GET-only recovery.
- Fix table painted-bounds warnings and transport source-proven FitR destinations through supported document flow.
- Clarify Korean guidance and align Confluence, connection and recovery documentation.

## 0.2.0-alpha.10

- Version the changed role, navigation and Confluence entry assets so browsers load the matching visual workflow implementation after an upgrade. Release packaging rejects stale asset version suffixes.
- The alpha.9 visual workflow, OSS components, storage semantics and regression coverage remain unchanged.

## 0.2.0-alpha.9

- Airport-style visual file intake: drop, paste or pick a paper; actual first-page PDF thumbnail; empty future stages collapse.
- Selected Harness shelf, large play control, compact PC connection, library-first tools and per-item team save without changing either execution selection.
- Team drawer starts user-delegated connection when needed. Explicit destination/consent gates publication; technical details are disclosed on demand.
- Symbolic human verdicts delegate to existing validated records. A real-browser regression covers overall label activation, independent RED/BLUE input, multi-file refusal and responsive layouts.
- Reused GoogleChromeLabs file-drop 1.0.1 and pinned Lucide SVG sources with license/provenance receipts. No new frontend framework. See docs/release-alpha9.md.

## 0.2.0-alpha.8

- Confluence is the only remote archive: explicit team publication of selected experiments, Harnesses and detailed reviews.
- Fetched records open in temporary native review without merging into original local storage; publish draft reviews explicitly to retain them.
- Central user-delegated Atlassian OAuth, stateless bounded relay, immutable hash-checked attachments and legacy write retirement. Existing local and historical database records remain preserved.
- Synthetic real-OAuth and independent-browser-origin roundtrips verified; original/edited PDF bytes are not included in JSON archives. See docs/release-alpha8.md.

## 0.2.0-alpha.7

- Native human review pairs RED before/after and recorded attack intent with all BLUE findings. Changed expressions are marked and quote overlaps displayed first without automatic scoring.
- Per-finding and per-attack judgments/reasons persist with the existing append-only review history and JSON backup; old records remain supported.
- RED-assisted review records its exposure and carries that disclosure into a shared review's overall note. Detailed per-finding/RED comparison remains local, not automatically shared.
- Review requires no companion connection. The connection panel is hidden in this destination; desktop columns stack on small screens. RED-only/BLUE-only use stays independent.

## 0.2.0-alpha.6

- Host-bound evidence references make repeated BLUE selection quotes unambiguous without weakening final grounding.
- Matched BLUE failures remain visible across reload, with explicit request/diagnostic export and discard guidance.
- Experimental BLUE Evidence v0.3.4 uses a self-contained source bundle and preserves immutable inherited audit records.
- Offline controlled-comparison preparation distinguishes machine configuration, strategy, failures and unreviewed findings.
- Source ZIP preservation checks work without Git history. Human gold, full comparison UI and another-PC validation remain pending.

See docs/release-alpha6.md for verification and limitations.

## 0.2.0-alpha.5

- Password change/revoke-all sessions; exact-request RED/BLUE reload recovery and same-page double-click admission.
- Portable BLUE Evidence v0.3.3 sources and per-PC profile generation with explicit external-literature opt-in.
- Quick-first hosted HTML guide, account/recovery documentation, and PDF Editor alpha.6 compatibility.
- Source-only distribution excludes private records, machine profiles and patched editor WASM.

See docs/release-alpha5.md for verification and limitations.

## 0.2.0-alpha.4

- Optional team records in Results: invite-only username/password accounts, private-by-default uploads, explicit team sharing,
  immutable payload versions, owner-only revision-checked changes, and subjective reviews grouped by matching conditions.
- Team harness preview remains separate from registration and local CLI execution. Local papers and records are not
  automatically uploaded or replaced. Server records are client-reported, not execution attestations or scientific scores.
- Worker/D1 source, bounded request and account quotas, salted scrypt password hashes and expiring hashed sessions.
- Shared run summaries exclude private evidence and local IDs on the server, including when listing an owner's records.
- Shared API reads require an active invited-member session. Operator-only invitation issuance/admission/revocation;
  no public admin endpoint. Static GitHub Pages and source remain public, not private hosting.
- Flexible wrapper profiles adapt existing stdio/HTTPS programs: prompt/JSON/template/extracted-text files as input,
  JSON or a single fenced JSON block as output, deterministic pointer/field/array/stage mappings and preview-only builder.
  Original binary PDFs, arbitrary prose interpretation and automatic README-to-wrapper generation are not included.
  Wrapper execution requires a companion advertising support; registration never executes code. See docs/harness-wrapper.md.

Requires a configured shared API. No email/GitHub identity verification, email password recovery, automatic complete
cross-device ledger sync, model execution certification, or causal harness ranking. PDF editor remains 0.1.0-alpha.5.

## 0.2.0-alpha.3

Source-only prerelease. See docs/release-alpha3.md. The separately configured PDF editor is 0.1.0-alpha.5.

- Experiment records separate local-broker runs, manual responses and imported records; a harness-hash mismatch or
  missing hash is shown as an unconfirmed harness and excluded from averages. Model-call correctness stays unknown.
- PDF import warns about glyphs without a Unicode mapping instead of silently using their text.
- PDF export refusals carry fixed refusal codes; regional, typography and reading-order QA gained a bounded
  rigid-run tolerance (0.02 pt, warning only) and a block-order proof for reordered-but-complete text.
- Legacy editor/export fixes in the local companion, with focused regressions.

Not claimed: complete DOCX/ODT/HTML layout output, figure-aware BLUE, a shared database, full-model benchmarks or
AMAS documents being fixed. No arbitrary-PDF, invisibility or scientific performance claims.

## 0.2.0-alpha.2

- Optional manual raster-image placement selection in RED, separate from text candidates and BLUE.
- Source-bound painting IDs and single-occurrence resource isolation, including shared page resources.
- PNG Before/After and experimental-copy consent; PDF and separate rendering-check report downloads.
- Authenticated isolated image service with bounded input, fixed errors and temporary cleanup.

Requires optional image dependencies on Python3.11+. Forms/inline images, complex clipping/masks, vector figures and tables
are outside the initial supported boundary. BLUE remains text-only, and rendering checks are not scientific approval.
See docs/pdf-image-editing.md. Six synthetic shared/inherited placements were each replaced separately: MuPDF and the
configured PDFium runtime found zero changed pixels outside the selected region. This is not arbitrary-paper fidelity or
domain approval. The separate PDF editor remains0.1.0-alpha.4; image writing is an optional companion operation.

## 0.2.0-alpha.1

Source-only prerelease of the Workbench and local companion. The separate PDF editor remains 0.1.0-alpha.4.

- Source-derived text edit plans and independent edited-page/region quality checks.
- Exact downloaded-PDF preview using the verified output bytes, with cancellation and bounded page rendering.
- Optional structure, fixed-area layout and object-occurrence analysis modules, with synthetic regression coverage.
- Explicit authenticated PDF preflight from RED: source inventory, shared-image counts and advisory selected-text layout.
  Does not run a model, authorize a scientific attack, block text export or pass RED information into BLUE.
- Companion version and feature reporting, while retaining old-companion/manual operation compatibility.

Docling ML conversion is not enabled; structure schema compatibility was tested separately. The layout planner is metrics-only,
not a new PDF writer. Object replacement is still a synthetic-only unique-XObject prototype at this release boundary; shared
per-occurrence writing is the next implementation. BLUE remains text-only.

The source archive excludes local environments, private papers/harnesses/records, model artifacts and the locally patched WASM.
Longer PDF export requires the separately configured editor described in docs/pdf-editor.md. Existing user installations must
restart idle companions through the supported launcher; pairing tokens change on restart and browser-local records are retained.
