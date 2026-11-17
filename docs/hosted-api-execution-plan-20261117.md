# 운영자 API로 웹에서 RED/BLUE 실행

2026-11-17. 검토 기준 `5e7f0bd71761b8567846c2f93ac1807a3d319fac`, VERSION `0.2.0-alpha.73`. 구현 전 조사와 실행 계약 초안이다.

## 확정한 사용자 흐름

운영자 API 키와 비용으로 실행한다. 사용자는 로그인 → PDF와 부속 파일 업로드 → RED/BLUE 요청 입력 → 실행 → 결과 확인으로 끝낸다. 사용자의 CLI 설치·구독 로그인·개인 API 키·로컬 companion 연결을 웹 실행의 선행 조건으로 요구하지 않는다. 기존 로컬 실행과 외부 AI 결과 가져오기는 선택 기능으로 유지한다.

첫 API 제공자는 Anthropic으로 확정했다. 운영자 키는 로컬 비밀 저장소에 있으며, 애플리케이션은 서버 환경변수 ANTHROPIC_API_KEY로만 읽는다. 실제 API 모델 ID, 지원 추론 강도와 도구 계약은 해당 제공자 문서로 확인한다. CLI 기본 모델 이름을 API 모델로 간주하지 않는다. 키 값은 채팅이나 저장소에 기록하지 않는다.

## 최신 소스에서 확인한 사항

- 공개 원격 브랜치 main은 alpha.73(`20cb57f`)이며, 현재 체크아웃은 그 다음 PDF 텍스트 연산자 교체 수정(`5e7f0bd`)이다. 현재 수정은 덮어쓰지 않는다.
- BLUE의 표 검산·환자 흐름·메타분석·원자료 재계산·그림 검사, RED의 PDF·표·그림·xlsx·notebook 변조와 아레나 평가가 확장됐다. 웹의 기존 red_service/blue_service와 최신 portable runner는 기능 차이가 있다.
- Cloud API는 현재 Confluence 인증·기록 중계용이다. AI 실행 경로는 로컬 Python·CLI에 남아 있다.
- Confluence-only 모드가 기존 비밀번호 로그인 경로도 막는다. 현재 OAuth 세션의 cloudId는 사이트 식별자이므로 사용자별 실행 소유자로 사용할 수 없다.
- 기존 HTTPS 어댑터는 자체 JSON 계약이며 공급자 Authorization 처리가 없다. 공급자 API를 곧바로 연결할 수 있는 구현이 아니다.
- 최신 PDF 텍스트 변경 관련 집중 테스트: text_span_mutator 15개, coordinated_stealth 10개 통과. 전체 회귀·배포·웹 E2E는 이번 조사에서 수행하지 않았다.

## 재사용과 실행 구조

기존 Cloudflare Worker를 인증·작업 API의 입구로 확장하고, Python 엔진은 서버 컨테이너에서 실행하는 방향을 우선한다. 기존 분석·편집 도구를 서버에서도 호출하고, 모델 백엔드만 공급자 API로 바꾼다. 프롬프트를 중계하는 것만으로 완료하지 않는다.

`infer`/`infer_visual`, BLUE runner의 backend_factory, RED runner의 planner_fn 주입 지점을 재사용한다. 에이전트의 도구 호출은 현재 문서 작업에 연결된 기존 Python/MCP 기능으로 처리한다. 동결된 과거 harness 번들은 변경하지 않는다.

로그인과 AI 실행은 기록 보관 대상인 Confluence와 분리한다. 기존 OAuth를 이용할 경우 검증된 사용자 식별자를 연결하고, Confluence 기록 연결을 하지 않아도 실행할 수 있게 한다. 로그인 방식 자체는 현재 배포 환경을 확인해 선택한다.

작업 상태와 입력·출력은 요청 처리 프로세스 밖에 보관한다. 새로고침, 연결 끊김, 서버 재시작 뒤 같은 작업을 이어 확인할 수 있어야 한다. 기존 로컬 JOBS 메모리와 loopback broker를 그대로 공개 서버로 노출하지 않는다.

## 웹 실행 계약 초안

| 경로 | 역할 |
|---|---|
| POST /v1/ai/uploads | 입력 파일 등록, artifactId·해시 반환 |
| POST /v1/ai/jobs | 작업 접수, 202와 jobId 반환 |
| GET /v1/ai/jobs/:id | 소유자의 진행 상태·결과·모델·사용량 조회 |
| POST /v1/ai/jobs/:id/cancel | 작업 취소 |
| GET /v1/ai/jobs/:id/artifacts/:artifactId | 해당 작업의 출력 다운로드 |

접수에는 role, 입력 artifact ID, 프롬프트, harness 버전, 허용된 모델 선택, idempotency key를 사용한다. 브라우저는 운영자 키나 로컬 실행 파일 경로를 보내지 않는다. 접수 응답을 놓쳤을 때 같은 키로 기존 작업을 조회하며, 유료 모델 호출을 무조건 다시 실행하지 않는다.

서버 기록에는 실제 제공자·모델·추론 설정·harness/tool 버전·입출력 해시·사용량·완료 이유를 남긴다. 공급자가 주지 않은 값은 추정해 기록하지 않는다. 공급자 오류는 사용자에게 필요한 코드·요청 ID·재시도 가능 여부로 설명한다.

## 제거하거나 바꿀 제약

| 현재 경로 | 수정 방향 |
|---|---|
| red_service/blue_service 결과 12개 상한 | 결과 수를 인위적으로 자르지 않고 배치 수집·이어보기 지원 |
| harness 및 요청의 maxCalls 1–32 | 공급자 용량과 운영자 사용 예산에 맞춰 실행 계획 수립; 기본 UI에서 호출 수 계산 제거 |
| 고정 문자 수·최종 문맥 창 | 토큰 기반 분할과 문서 도구 조회 사용, 누락 범위 기록 |
| blue_visual 이미지 최대 6장 | 한 요청의 한도와 전체 검토 범위를 분리해 배치 처리 |
| 어댑터 공통 180초 | 단계별 시간 제한과 비동기 작업·진행·취소·복구로 교체 |
| 일반 실행의 반복 동의·CLI 연결 요구 | 로그인 후 실행 버튼 한 번으로 진행 |
| BLUE 인용의 정확히 한 번 일치 강제 | 최신 위치 복원 재사용, 모호한 항목은 위치 확인 대상으로 분리 |
| 한 항목 검증 오류로 전체 결과 실패 | 유효 항목 보존, 미해결 항목과 실행 미완료 상태 구분 |
| 필수 uncertainty 설명 | 실제 불확실성이 있을 때만 작성 |
| CLI 전용 도구 금지·모델/추론 선택 제한 | 호스팅 API에 별도 적용하지 않고 실제 지원 기능 연결 |

운영자 키·사용자별 작업 소유권·사용 예산·RED/BLUE 입력 분리·원본과 편집본의 연결 검사는 유지한다. Confluence 보관 크기 제한을 AI 입력 한도로 가져오지 않는다. 애매하게 찾은 원문에 RED 변경을 몰래 적용하지 않는다. 실험용 도구·웹 검색 허용 여부는 harness 설정으로 다룬다.

## 구현 순서와 완료 조건

1. 공급자 API 백엔드: 텍스트·이미지·구조화 응답·도구 호출·사용량·오류·취소를 기존 엔진에 연결한다. 가짜 API 응답으로 먼저 검증한다.
2. Python 작업 실행: 파일 업로드, 작업별 도구/파일 연결, 상태 보존, 결과 다운로드를 서버에 연결한다. 표·그림 분석과 PDF 편집을 포함한다.
3. 로그인과 운영: 인증된 사용자 식별자, 작업 소유권, 서버 secret, 운영자가 바꿀 수 있는 예산을 적용한다.
4. 웹 동선: 기본을 웹 실행으로 바꾸고 로컬 CLI는 접힌 선택 기능으로 둔다. 새로고침 후 복구·진행·취소·부분 결과를 연결한다.
5. 제약 정리: 위 표의 프런트·서버 계약을 함께 바꾸고 최신 runner와 웹 경로의 차이를 줄인다.
6. 검증·배포: companion과 CLI가 없는 환경에서 로그인부터 PDF/부속 파일 분석·RED 생성·BLUE 전달까지 확인한다. 중복 접수·취소·재연결·사용자 간 파일 격리도 검사한다. 검증 후 공개 웹·GitHub 릴리스·설치본을 같은 릴리스로 반영한다.

## 조사 근거

프로젝트 CodeGraph와 현재 소스, 테스트를 먼저 확인했다. 기존 Cloudflare 구성과 Python 엔진을 조합하는 방향이며 새 범용 에이전트 프레임워크는 선택하지 않았다. 실제 계정 자원·요금·제공자 모델 연동은 아직 검증하지 않았다.

- [Cloudflare secrets](https://developers.cloudflare.com/workers/configuration/secrets/): 운영자 키를 서버 secret으로 저장.
- [Containers 환경 변수와 secret](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/): 빌드 이미지 대신 런타임에 키 전달.
- [Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/): 현재 컨테이너 실행 API 확인 대상.
- [Workflows](https://developers.cloudflare.com/workflows/): 다단계 작업 상태·복구 구현 후보. 실제 작업 큐 구성에 필요할 때 채택.
