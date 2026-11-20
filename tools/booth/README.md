# 부스 운영 CLI

AWS Community Day(2026-11-22) 부스 접수를 운영하는 도구입니다. Node.js 20 이상, 추가 패키지 없음.

```bash
export FALSIFY_BOOTH_TOKEN='fso_…'   # 플래그가 아닙니다. 로그에 남지 않습니다.
cp tools/booth/booth.config.example.json booth.local.json
# booth.local.json 의 apiBase 만 행사 오리진으로 바꿉니다.
node tools/booth/booth.mjs --config booth.local.json status
```

로컬 보관 디렉터리는 설정의 `dataDir` 이고, 비우면 `$HOME/falsify-booth-data` 입니다. 저장소 밖을 쓰세요. 여기에는 제출 PDF와 운영 메모가 쌓입니다.

## 설정

`blue.profiles[]` 가 BLUE 한 번을 결정합니다. `model`, `effort`, `maxCalls`, `useEvidence`, `prompt` 또는 `promptFile`, `harness` 또는 `harnessFile` 은 모두 운영자가 고칩니다. CLI는 모양만 보고, 허용 목록과 상한은 서버가 적용합니다.

실행마다 플래그가 그 값을 덮어씁니다.

```bash
node tools/booth/booth.mjs --config booth.local.json blue \
  --profile quick-blind --model claude-sonnet-5-5 --effort high \
  --max-calls 8 --use-evidence true --prompt-file prompts/blue-example.txt \
  --concurrency 2 --repeat 1 --status received,reviewing --only F-0001,F-0002
```

`promptFile` 과 `harnessFile` 은 설정 파일 위치 기준입니다. `--prompt-file` 과 `--harness-file` 은 현재 디렉터리 기준입니다.

같은 접수·프로파일·반복·설정·`pdfSha256` 은 항상 같은 idempotency 키(sha256)를 씁니다. 키에 넣는 해시는 운영자 목록의 `pdfSha256` 이고, 로컬 파일이 그 값과 다르면 올리지 않습니다. 끝난 작업은 로컬 기록을 다시 읽고, 기록이 없으면 서버가 같은 키를 재생합니다. 실패한 작업은 다시 과금하지 않습니다. 같은 PDF로 다시 돌리려면 프롬프트나 모델처럼 설정을 바꾸세요.

`--concurrency` 는 이 프로세스 안의 동시 BLUE 작업 수입니다. 서버의 `BOOTH_OPERATOR_ACTIVE_JOBS` 이하로 두세요.

### 라이브 판정 (`live` 절)

부스에서는 RED(AI 심기 도움)를 끕니다. 방문자가 제출하면 `watch` 가 곧바로 BLUE를 돌려 1~3분 안에 결과를 게시하고, 마감 뒤 `final` 이 놓친 접수를 더 센 모델로 다시 봅니다. 프로파일은 `blue.profiles[]` 에 `live` (Claude Sonnet 5.5, effort high)와 `final` (Claude Opus 5.5, effort high)로 둡니다. 둘 다 `prompts/blue-live.txt` 를 씁니다. 이 프롬프트는 `blue-example.txt` 규칙에 더해 rationale을 한국어 두 문장 이내로, quote를 PDF 원문 그대로 쓰게 합니다. `--profile` 없는 `blue` 는 `live`·`final` 프로파일을 건너뜁니다.

| 키 | 기본값 | 뜻 |
|---|---|---|
| `liveProfile` / `finalProfile` | `live` / `final` | `watch` 와 `final` 이 쓸 프로파일 이름 |
| `concurrency` | `12` | 동시 BLUE 작업 수. `--concurrency` 가 덮어씁니다 |
| `intervalSec` | `10` | 목록을 다시 읽는 간격(초). `--interval` 이 덮어씁니다 |
| `retries` | `2` | BLUE·폴링 실패 때 추가 시도 횟수. 대기는 `retryBackoffMs` 에서 두 배씩 늘어납니다 |
| `retryBackoffMs` | `5000` | 첫 재시도 전 대기(ms) |
| `prizeMessage` | 없음 | 라이브에서 `missed` 인 접수에만 붙는 경품 안내(500자 이하) |
| `finalPrizeMessage` | `prizeMessage` | `final --apply` 뒤에도 `missed` 인 접수의 안내 |
| `finalCaughtMessage` | "빠른 AI는 이겼어요! 정밀 AI는 찾아냈지만, 받은 즉석 선물은 그대로 유효해요." | 라이브에서 놓쳤지만 `final` 에서 `caught`·`partial` 이 된 접수의 안내. 이미 받은 즉석 선물은 유효합니다 |
| `publicNote.caught` / `partial` / `missed` / `missedNone` | 아래 | 방문자에게 보이는 결과 문장(1000자 이하) |

`publicNote` 틀에는 `{page}` (AI finding 의 1부터 세는 쪽), `{quote}` (AI가 짚은 문장, 약 200자에서 자름), `{rationale}` (AI 설명, 약 300자에서 자름)만 들어갑니다. 방문자가 적은 이유·유형·수정 문장은 넣지 않습니다. `caught`·`partial` 은 가장 잘 맞은 finding, `missed` 는 AI가 처음 짚은 finding 의 쪽을 씁니다. 이 쪽은 AI가 짚은 곳의 쪽이라 심어 둔 쪽과 다를 수 있습니다(예: 수정은 3쪽, AI 인용은 4쪽). 그래서 틀은 "AI가 짚은 곳: {page}쪽" 처럼 AI 쪽으로 적습니다. finding 이 없으면 `missedNone` 입니다. 전체는 1000자에서 자릅니다.

방문자에게 보이는 outcome 뜻: `caught` AI가 찾음, `partial` 거의 찾음(찾은 것으로 보고 경품 없음), `missed` AI가 놓침(스태프 확인 뒤 부스에서 작은 선물, 마감 뒤 Opus 재검증 대상), `invalid` 결함으로 받지 않음.

## 명령

| 명령 | 하는 일 |
|---|---|
| `status` | 공개 설정, 운영 설정, 상태별 건수 |
| `list` | 운영자 목록. `--status`, `--after`, `--limit`. 행마다 `assist` (`manual`·`my-ai`·`agent`, 필드가 없는 예전 행은 `manual`)와 `recipeCode` (agent 만)를 보여 줍니다 |
| `pull` | 접수마다 `submission.json` 과 `edited.pdf`. 목록의 `pdfSha256`, `pdfBytes`, `sourceSha256` 을 저장하고, 받은 PDF의 sha256·길이·`X-Falsify-Pdf-Sha256` 이 `pdfSha256`/`pdfBytes` 와 같아야 저장합니다. 같으면 PDF를 다시 받지 않습니다. 철회분은 로컬 파일과 BLUE 기록을 지우고 `withdrawn.log` 에 시각·접수번호·seq만 남깁니다 |
| `blue` | 수정본 PDF를 올리고 `role: blue` 작업을 만들어 폴링한 뒤 결과를 저장합니다. 접수가 열려 있으면 `--allow-open` 없이 시작하지 않습니다. BLUE는 방문자 경로가 아니라 프로덕션 런타임을 같이 씁니다. `%PDF-` 로 시작하지 않거나 `--max-bytes`(기본 16777216)를 넘는 파일은 올리지 않습니다 |
| `score` | 선언한 수정과 BLUE 인용을 맞춰 `score.json` 에 제안만 씁니다. 게시하지 않습니다 |
| `judge` | 제안을 `status: judged` 와 `outcome` 으로 PATCH. `published` 는 건드리지 않습니다 |
| `publish` / `unpublish` | 게시 플래그. 기본 대상은 `judged` |
| `draw` | `crypto.randomInt` 로 당첨을 고릅니다. 기본 outcome 은 `missed` 라서 경품은 AI가 놓친 결함에 갑니다. `--prize` 가 있으면 그 문장을 PATCH |
| `export` | `common`, `score`, `key`, `jsonl`, `submissions`. `submissions` 는 접수당 한 줄(`receipt`, `seq`, `status`, `outcome`, `course`, `assist`, `recipe_code`, `paper_id`, `declared` 개수)이고, `jsonl` 행에도 `assist`·`recipe_code` 가 붙습니다. `common`·`score`·`key` 는 스터디 열 그대로입니다. 철회한 접수는 빠집니다. CSV 칸이 `=`, `+`, `-`, `@`, 탭, CR로 시작하면 `'` 를 붙입니다 |
| `missions get\|set\|warm` | 미션 목록. 행사 파일은 `tools/booth/missions.aws-community-day-2026.json` 입니다. `warm` 은 설정된 미션마다 `GET /v1/papers/pdf` 로 라이선스와 캐시를 확인하고 크기와 실패를 보고합니다. `warm --write` 는 받은 PDF의 `sourceSha256` 을 미션에 저장하고 `pageHint` 는 그대로 둡니다 |
| `open` / `close` | 접수 개방. `close --dry-run` 은 요청을 보내지 않습니다 |
| `announce` | `--text`, `--file`, `--clear` |
| `watch` | 접수가 열린 동안 계속 돕니다. `--interval` 초마다 `received` 를 읽고 `--concurrency` 개까지 동시에: `status: reviewing` PATCH → PDF 받기(`pull` 과 같은 sha256·길이 검사) → `live` 프로파일 BLUE(`blue --allow-open` 과 같고 idempotency 키도 같음) → 채점 → `{status: judged, outcome, publicNote, aiSummary, published: true}` (`missed` 면 `prizeMessage` 도)를 PATCH 한 번으로 보냅니다. 철회(409)나 PDF 없음은 건너뛰고 로그에 남깁니다. 재시도까지 실패하면 `reviewing` 으로 두고 `operatorNote: live: failed <code>` 를 남깁니다. Ctrl-C 로 멈추면 하던 작업은 다음 시작 때 같은 작업으로 이어 갑니다(새 과금 없음). 이어 가기 표시는 `dataDir/live/<접수번호>.json` 이라서 `watch` 는 운영 서버 한 대에서만 돌립니다. 다른 호스트나 다른 `dataDir` 에서 켜면 이어 가지 못합니다. `--cycles <n>` 은 n번 돌고 남은 작업을 마친 뒤 끝냅니다 |
| `final` | 마감 뒤. 라이브 outcome 이 `missed` 인 `judged` 접수(`--only` 로 좁힘)를 `final` 프로파일로 다시 돌리고 채점해 `final/candidates.json` (`--out`)에 접수번호·`assist`·`recipeCode`·라이브 판정·최종 판정·대표 인용·쪽을 씁니다. AI가 심은 결함(`my-ai`·`agent`)도 경품 자격은 같습니다. 기본은 게시하지 않습니다. 사람이 본 뒤 `--apply` 가 최종 outcome·publicNote·aiSummary 를 PATCH 합니다. 이미 끝난 작업은 다시 과금하지 않습니다. 여전히 `missed` 면 `finalPrizeMessage`, `caught`·`partial` 이 되면 `finalCaughtMessage` 를 `prizeMessage` 로 씁니다. outcome 과 publicNote 는 final 결과를 따릅니다. 접수가 열려 있으면 `--allow-open` 없이 시작하지 않습니다 |

`blue`, `judge`, `publish`, `draw`, `close` 는 `--dry-run` 으로 요청 없이 예정 동작만 보여 줍니다. `draw --dry-run` 은 목록을 읽은 뒤 당첨만 출력하고 파일과 PATCH는 만들지 않습니다.

진행 문장은 stderr, 결과는 stdout JSON 입니다. `watch` 는 주기마다 JSON 한 줄(`type`, `queued`, `inFlight`, `done`, `failed`, `failedReceipts`, `skipped`, 접수→게시 `p50Sec`/`p95Sec`)을 씁니다. 마지막 줄은 `end`, Ctrl-C 면 `stopped` (종료 코드 130)입니다.

## 부스 당일

1. 문을 열기 전에 `missions set tools/booth/missions.aws-community-day-2026.json`, `missions warm --write`, `open`, 필요하면 `announce`.
2. 문을 연 뒤 운영 노트북에서 `watch` 를 띄워 둡니다. stdout 의 `failed` 가 늘면 그 접수를 확인하세요. 끊겼다면 다시 `watch` 를 켜면 이어 갑니다.
3. 30분마다 `pull` (상태 필터 없이). 수정본 PDF는 접수와 함께 서버에 있습니다. `pull` 은 `pdfSha256` 과 `pdfBytes` 가 맞는 것만 보관합니다. 받은 PDF는 브라우저에 내장된 PDF 보기에서만 여세요. 데스크톱 PDF 프로그램으로 열지 마세요. 철회되면 서버 PDF가 지워지고, 다음 `pull` 이 로컬 보관본도 지웁니다.
4. 마감하면 `close`. `watch` 가 남은 작업을 마치면 Ctrl-C.
5. `final` 로 놓친 접수를 Opus로 다시 보고 `final/candidates.json` 을 사람이 확인한 뒤 `final --apply`. 최종 경품 명단은 사람이 정합니다.
6. 라이브 판정을 쓰지 않을 때만 `blue`. 먼저 `--dry-run`. 접수가 아직 열려 있으면 거절합니다. BLUE는 방문자 제출 경로가 아니라 프로덕션 런타임을 같이 씁니다. 그래도 돌리려면 `--allow-open`.
7. `score` 로 제안 확인. 사람이 본 뒤에만 `judge`.
8. `publish --prize '부스에서 이 화면을 보여 주세요'`.
9. 경품이 추첨이면 `draw --count 3 --prize '…'`. 기본은 AI가 놓친(`missed`) 접수입니다.
10. `export --format common` 과 `--format score`, `--format key`.

## 채점

`score` 는 각 선언 수정에 대해, 같은 페이지의 BLUE `quote` / `sourceQuote` / `evidence[].quote` 와 선언한 after 문장이 겹치거나, before 와 after 사이에서 바뀐 숫자가 인용·근거 인용·`rationale` 에 있으면 잡았다고 봅니다. 호스티드 BLUE finding 에는 `pageIndex` 가 없으므로 페이지는 `segmentId` 의 `p<N>-` (1부터 시작하는 물리 페이지)에서 읽고, finding 자신의 `segmentId` 나 `evidence[].segmentId` 가 가리키는 모든 페이지를 같은 페이지로 칩니다. 내보내기의 물리 페이지는 finding 자신의 `segmentId` 페이지입니다. 문장이 그대로 들어가면 `caught`, 겹침이 약하거나 숫자만 맞으면 `partial`, 아니면 `missed` 입니다. 접수의 제안 outcome 은 전부 caught 이면 `caught`, 전부 missed 이면 `missed`, 그 밖에는 `partial` 입니다.

## 판정 단어

호스티드 BLUE 의 `verdictLabel` 은 `아님`(결함 확정), `확인필요`, `맞음`(본문으로 해소) 입니다. `export --format common` 의 `판정(아님/확인필요)` 열은 이 단어를 유지합니다.

`export --format score` 는 `tools/score.py` 열 12개입니다. 그 스크립트는 `맞음` 을 결함 플래그(yes), `아님` 을 플래그가 아님(no)으로 셉니다. 그래서 CSV의 `label` 만 반대로 옮깁니다. `아님` → `맞음`, `맞음` → `아님`, `확인필요` 는 그대로입니다. 모르는 단어는 `확인필요` 로 두어 그 CSV가 로드되게 합니다.

`export --format key` 는 선언 수정으로 만든 정답 행입니다. 위치는 `p` + 물리 페이지(1부터)라서 score CSV의 `location` 과 페이지 문자열이 같습니다. 부스 당일의 수정 단위 판정은 `score` 명령이 맡고, 이 CSV는 이후 `tools/score.py` 용입니다.

## BLUE에 나가지 않는 것

작업 JSON은 편집된 PDF(업로드)와 운영자 프로파일(프롬프트, 모델, effort, maxCalls, useEvidence, harness)과 idempotency 키뿐입니다. 선언 수정, 이유, 유형, 별명, 논문 메타데이터는 요청 빌더의 인자가 아닙니다.

## 개인정보와 보관

접수 화면은 이름, 전화, 이메일을 받지 않습니다. 별명에 메일 모양이나 긴 숫자가 있으면 서버가 거절합니다. 이 CLI는 토큰을 출력하지 않습니다. 결과와 경품 안내는 접수번호와 확인 키로만 확인합니다. 방문자는 확인 키로 제출을 철회할 수 있고, 철회분은 `score` 와 `export` 에서 빠집니다.

부스 PDF는 브라우저에 내장된 PDF 보기에서만 엽니다. 데스크톱 뷰어로 열지 않습니다.

확인:

```bash
node tools/booth/booth.mjs --help
node --test tools/booth/test/
```

## 종료 코드

`0` 완료, `1` 설정·사용법, `2` API·네트워크, `3` BLUE 일부 실패. 일부만 실패해도 끝난 작업은 저장되어 다시 실행하면 이어서 갑니다.
