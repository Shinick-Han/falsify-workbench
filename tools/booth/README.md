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

같은 접수·프로파일·반복·설정은 항상 같은 idempotency 키(sha256)를 씁니다. 끝난 작업은 로컬 기록을 다시 읽고, 기록이 없으면 서버가 같은 키를 재생합니다. 실패한 작업은 다시 과금하지 않습니다. 새로 돌리려면 프롬프트나 모델처럼 설정을 바꾸세요.

`--concurrency` 는 이 프로세스 안의 동시 BLUE 작업 수입니다. 서버의 `BOOTH_OPERATOR_ACTIVE_JOBS` 이하로 두세요.

## 명령

| 명령 | 하는 일 |
|---|---|
| `status` | 공개 설정, 운영 설정, 상태별 건수 |
| `list` | 운영자 목록. `--status`, `--after`, `--limit` |
| `pull` | 접수마다 `submission.json` 과 `edited.pdf`, sha256. 같은 `updatedAt` 이면 PDF를 다시 받지 않습니다 |
| `blue` | 수정본 PDF를 올리고 `role: blue` 작업을 만들어 폴링한 뒤 결과를 저장 |
| `score` | 선언한 수정과 BLUE 인용을 맞춰 `score.json` 에 제안만 씁니다. 게시하지 않습니다 |
| `judge` | 제안을 `status: judged` 와 `outcome` 으로 PATCH. `published` 는 건드리지 않습니다 |
| `publish` / `unpublish` | 게시 플래그. 기본 대상은 `judged` |
| `draw` | `crypto.randomInt` 로 당첨을 골라 `draws/*.json` 에 남깁니다. `--prize` 가 있으면 그 문장을 PATCH |
| `export` | `common`, `score`, `key`, `jsonl`. 철회한 접수는 빠집니다 |
| `missions get\|set` | 미션 목록 |
| `open` / `close` | 접수 개방. `close --dry-run` 은 요청을 보내지 않습니다 |
| `announce` | `--text`, `--file`, `--clear` |

`blue`, `judge`, `publish`, `draw`, `close` 는 `--dry-run` 으로 요청 없이 예정 동작만 보여 줍니다. `draw --dry-run` 은 목록을 읽은 뒤 당첨만 출력하고 파일과 PATCH는 만들지 않습니다.

진행 문장은 stderr, 결과는 stdout JSON 입니다.

## 부스 당일

1. 문을 열기 전에 `open` 과 `missions set`, 필요하면 `announce`.
2. 30분마다 `pull`. 런타임은 수정본 PDF를 7일만 보관하므로 행사 중에 받아 두세요. 만료되면 `artifact_expired` 이고, 이미 받은 파일은 남겨 둡니다.
3. 마감하면 `close`.
4. `blue`. 먼저 `--dry-run`.
5. `score` 로 제안 확인. 사람이 본 뒤에만 `judge`.
6. `publish --prize '부스에서 이 화면을 보여 주세요'`.
7. 경품이 추첨이면 `draw --count 3 --prize '…'`.
8. `export --format common` 과 `--format score`, `--format key`.

## 채점

`score` 는 각 선언 수정에 대해, 같은 페이지의 BLUE `quote` / `sourceQuote` 와 선언한 after 문장이 겹치거나, before 와 after 사이에서 바뀐 숫자가 인용에 있으면 잡았다고 봅니다. 문장이 그대로 들어가면 `caught`, 겹침이 약하거나 숫자만 맞으면 `partial`, 아니면 `missed` 입니다. 접수의 제안 outcome 은 전부 caught 이면 `caught`, 전부 missed 이면 `missed`, 그 밖에는 `partial` 입니다.

## 판정 단어

호스티드 BLUE 의 `verdictLabel` 은 `아님`(결함 확정), `확인필요`, `맞음`(본문으로 해소) 입니다. `export --format common` 의 `판정(아님/확인필요)` 열은 이 단어를 유지합니다.

`export --format score` 는 `tools/score.py` 열 12개입니다. 그 스크립트는 `맞음` 을 결함 플래그(yes), `아님` 을 플래그가 아님(no)으로 셉니다. 그래서 CSV의 `label` 만 반대로 옮깁니다. `아님` → `맞음`, `맞음` → `아님`, `확인필요` 는 그대로입니다. 모르는 단어는 `확인필요` 로 두어 그 CSV가 로드되게 합니다.

`export --format key` 는 선언 수정으로 만든 정답 행입니다. 위치는 `p` + 물리 페이지(1부터)라서 score CSV의 `location` 과 페이지 문자열이 같습니다. 부스 당일의 수정 단위 판정은 `score` 명령이 맡고, 이 CSV는 이후 `tools/score.py` 용입니다.

## BLUE에 나가지 않는 것

작업 JSON은 편집된 PDF(업로드)와 운영자 프로파일(프롬프트, 모델, effort, maxCalls, useEvidence, harness)과 idempotency 키뿐입니다. 선언 수정, 이유, 유형, 별명, 논문 메타데이터는 요청 빌더의 인자가 아닙니다.

## 개인정보와 보관

접수 화면은 이름, 전화, 이메일을 받지 않습니다. 별명에 메일 모양이나 긴 숫자가 있으면 서버가 거절합니다. 이 CLI는 토큰을 출력하지 않습니다. 결과와 경품 안내는 접수번호와 확인 키로만 확인합니다. 방문자는 확인 키로 제출을 철회할 수 있고, 철회분은 `score` 와 `export` 에서 빠집니다.

확인:

```bash
node tools/booth/booth.mjs --help
node --test tools/booth/test/
```

## 종료 코드

`0` 완료, `1` 설정·사용법, `2` API·네트워크, `3` BLUE 일부 실패. 일부만 실패해도 끝난 작업은 저장되어 다시 실행하면 이어서 갑니다.
