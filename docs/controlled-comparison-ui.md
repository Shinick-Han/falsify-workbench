# 통제 비교 뷰 모델

`app/dist/controlled-comparison.js`는 이미 있는 BLUE 실행 기록을 나란히 보기 위한 순수 뷰 모델이다. 화면을 그리지 않고, 저장소에 쓰지 않으며, 네트워크나 모델 호출을 하지 않는다. 이 파일만으로 비교 UI나 원장 자동 동기화가 생기지 않는다. 구현 준비 상태이지, 독립된 수용이나 배포가 아니다.

판정 어휘는 `tools/evaluation/controlled_blue.py`와 `docs/controlled-blue-evaluation.md`를 따른다. 기록 모양은 현재 브라우저 원장(`experiment-ledger.js`의 run/review), 대기 작업(`pending-job.js`), 그리고 `bind`가 붙이는 `harnessCanonical`이다. 패킷 스키마를 옮기거나 기존 원장 형식을 바꾸지 않는다.

## 통합 API

브라우저에서는 `FalsifyControlledComparison`, Node 테스트에서는 `require('../dist/controlled-comparison.js')`이다. `index.html`에는 아직 연결하지 않았다.

```javascript
const view = await FalsifyControlledComparison.compare({
  strategy: {
    id, version, bundleSha256,
    pathMap,                 // 호출자가 주는 전체 문자열 치환. 없으면 {}
    machineSettingKeys,      // 생략 시 ['auditDirectory']만 제거. 다른 키는 거절
    portable                 // 기준 투영. 생략하면 모든 기록이 같을 때만 채택
  },
  fixed: {
    requestedModel, maxCalls, internalMaxCalls,
    goldVersion,             // 없으면 null. 그때 gold 객체를 두면 거절
    protocolVersion,         // 'falsify.document-blue.v1'만
    caseLabel
  },
  arms: {
    ORIGINAL: {sourceHash, fileHash, revision},
    E1: {sourceHash, fileHash, revision},
    H1: {sourceHash, fileHash, revision}
  },
  gold: null | {version, scientificGold: false, items: [{id}]},
  records: [],
  reviews: []
});
```

`compare`는 `Promise`를 반환한다. SHA-256은 `crypto.subtle`로만 계산한다. 입력 객체는 바꾸지 않는다.

반환 스키마는 `falsify.controlled-comparison-view.v1`이다. `ok: false`는 구조 거절(`errors`)이다. 조건이 다른 기록은 `ok: true`인 채로 분모에서 빠지고 `warnings`에 남는다. `comparisonReady`는 세 팔에 포함된 기록이 있고, gold 버전이 있으며, 양립 불가 조건·재생·중복 gold·기준 투영 부재·요청 ID 부재가 없을 때만 참이다. 참이어도 탐지율이나 순위가 아니다. 같은 최종 응답으로 `independence`가 `unknown`인 것은 준비 완료를 막지 않는다.

`detectionCorrectness`는 `not-inferred`, `ranking`은 `not-computed`, `scientificGold`는 `false`, `machineConfigIsStrategyIdentity`는 `false`로 고정이다.

보조 함수: `canonical`, `digestHex`, `sourceTextHash`, `portableProjection`, `unmappedAdapterPaths`, `requestedModel`, `appModelLabel`, `outcomeClass`.

## 넣는 기록

팔(`ORIGINAL` / `E1` / `H1`)은 저장 기록에 없다. 호출자가 `record.arm`으로 지정한다. 모듈은 팔을 추론하지 않는다.

완료 실행은 원장 run이다. 필드 예: `id`, `role: 'blue'`, `revision`, `fileHash`, `sourceHash`, `segments`, `harness`, `harnessHash`, `maxCalls`, `model`, `provenance`, `response`, `requestId`. `response`는 `falsify.document-blue.v1`이며 `status`(`ok` / `refusal` / `abstain`), `findings`, `harness`, `harnessHash`, `model`, `coverage`, `isolation`, 그리고 CLI 선택이면 `cliSelection`을 가질 수 있다.

`harnessCanonical`은 원장 run에 저장되지 않는다. `FalsifyLab.bind`가 요청에 붙인 그 문자열이 있으면 `record.request.harnessCanonical`로 넘긴다. 기계 설정 해시는 그 UTF-8 문자열의 SHA-256이다. 간격을 다시 직렬화하지 않는다. JSON으로 같아도 바이트가 다르면 다른 해시다. 기록된 `harnessHash`와 다르면 `harness_canonical`이며, 객체 digest로 고쳐 쓰지 않는다. 문자열이 없으면 해시는 harness-core와 같은 정렬 JSON digest이고, 여기에는 아직 치환되지 않은 경로가 남는다.

실패와 취소는 원장 run이 아니다. `pending-job` 기록의 `disposition`이 `failed` 또는 `cancelled`일 때 그 객체를 `record.pending`으로 넘긴다. 결과 객체가 아직 붙어 있으면 `discarded_result`로 빼고, 완료된 지적 없음으로 세지 않는다. 결과 없이 끝난 실패·취소만 각각 `failed`, `cancelled`이다.

`requestBytesDigest`도 원장 run에 없다. 대기 기록이나 호출자가 알고 있는 값만 `request.requestBytesDigest` 또는 `record.requestBytesDigest`로 전달된다. 없으면 재생 여부는 요청 ID로만 본다.

## 전략과 기계 설정

전략 정체성은 harness id, version, `settings.bundleSha256`, 그리고 이식 투영이다. 투영에는 지침, 예산, 요청 모델, scope, adapter 종류, `executable`, `args`가 들어간다. 플래그와 값 인자는 지우지 않는다.

`pathMap`은 호출자가 준 전체 문자열만 치환한다. 모듈 안에 로컬 경로 기본값은 없다. `-`로 시작하는 키나 값은 거절하고(`pathMap.flag`), 그 비교 결과는 만들지 않는다. `portableProjection`을 직접 호출해도 그런 항목은 적용하지 않아 플래그가 남는다. 맵에 없는 경로 형태(` / `, `\\`, `X:`)는 `unmapped_adapter_path`이다. 같은 전략으로 조용히 합치지 않는다.

`auditDirectory`만 기계 설정으로 투영에서 뺀다. 다른 settings 키는 남는다. 같은 투영 안에서 기계 해시가 둘 이상이면 `machine_config_not_strategy_identity`이다. 그 경고는 준비 완료를 막지 않는다. 기계 해시는 전략 ID가 아니다.

기준 `strategy.portable`이 없고 투영이 서로 다르면 다수결로 고르지 않는다. `portable_strategy_unfixed`이며 그 기록들은 분모 밖이다.

## 모델

`requestedModel`은 `settings.model`, 없으면 adapter `model`이다. 원장의 `run.model`이나 `custom-stdio-model-unverified` 같은 앱 라벨로 채우지 않는다. stdio 결과의 `response.model`은 `custom-stdio-model-unverified`이어야 하고, 이것은 검증된 모델이 아니다.

`verifiedModel`은 `provenance === 'local-codex'`이고 호출자가 빈 문자열이 아닌 관측값을 `record.verifiedModel`으로 넘긴 경우에만 `{observed, certified: false}`이다. 수동·가져온 기록의 주장, `model-unverified`로 끝나는 라벨, 없는 값은 `unknown`이다. 팔 안의 포함 기록이 하나의 관측을 공유하지 않으면 팔과 묶음도 `unknown`이다. 원장은 이 관측값을 저장하지 않는다.

## 계급과 사람 판정

포함 기록의 계급은 하나다.

| 계급 | 조건 |
| --- | --- |
| `failed` | 실패이고 결과 객체가 없음 |
| `cancelled` | 취소이고 결과 객체가 없음 |
| `refusal` | 완료, `status: refusal` |
| `abstain` | 완료, `status: abstain` |
| `completed-zero-findings` | 완료, `ok`, findings가 빈 배열 |
| `human-unreviewed` | 완료, `ok`, 지적이 있고 조건이 맞는 gold 검수가 없음 |
| `gold-unknown` | 지적이 있고 조건이 맞는 검수가 있으나 gold 버전이 없음 |
| `matched-findings` | gold 검수가 `matched`를 하나 이상 받아들임 |
| `human-reviewed-no-match` | gold 검수가 있으나 받아들인 `matched`가 없음 |

실패·취소는 시도에는 들어가고, 완료 응답과 지적 없음 분모에는 들어가지 않는다. 거절·유보도 지적 없음이 아니다. 빈 findings의 `0`만 실제 빈 목록이다. 실패·제외·호출 수 없음은 `0`으로 채우지 않고 `unknown`이다.

원장 검수(`verdict`: `supported` / `unsupported` / `mixed` / `uncertain`, `comparison.assessments`: `detected` / `missed` / `uncertain` / `pending`)는 주관 판정이다. `judgments` 배열이 없으면 gold 판정이 아니므로 `human-unreviewed`로 남고, 인용 겹침은 일치가 아니다. 평균을 만들지 않는다.

gold 판정은 검수에 `judgments: [{goldId, findingId, judgment}]`가 있고 `caseLabel`과 `protocolVersion`이 고정 조건과 같을 때만 적용한다. 현재 원장 검수에는 `protocolVersion`과 gold judgment가 없다. 프로토콜이 없으면 적용하지 않는다. 조건이 맞는 검수가 둘이면 어느 것도 적용하지 않는다. gold 버전이 없으면 일치 수는 `unknown`이지 `0`이 아니다. gold가 있고 검수가 적용된 뒤의 `0`은 그 검수가 받아들인 일치가 없다는 뜻이지 정확도가 아니다.

호출 수는 로컬 broker(`local-codex`)의 `coverage.calls`가 0 이상 정수일 때만 더한다. 하나라도 없으면 팔의 호출은 `unknown`이다. 비용은 항상 `unknown`이다. 증거 인용은 여기서 다시 검증하지 않는다. `rawResponseSha256`이 없으면 응답 불변은 `unknown`이고, 그것만으로 빼지는 않는다. 값이 있는데 저장된 결과의 정렬 JSON과 다르면 `response_not_immutable`이다.

## 재생과 독립

같은 `requestId`, 같은 `requestId@revision`, 또는 같은 `requestBytesDigest`는 재생이다. 그 기록은 분모 밖이고 `independence`는 `replay`이다. 요청 ID가 없으면 별개의 요청이라고 부르지 않으며 `unknown`이다.

요청 ID와 바이트 digest가 다른데 최종 응답 해시만 같으면 둘 다 분모에 남고 `independence`는 `unknown`이다. 같은 출력은 종속이라는 증거가 아니다.

팔마다 다른 `sourceHash` / `fileHash` / `revision`은 사례 정체성이다. 한 기록이 자기 팔과 다르면 `source_hash`, `file_hash`, `revision`으로 빠진다. 파일 해시는 다시 계산하지 않는다. 세그먼트 텍스트가 있으면 빈 줄 결합의 SHA-256이 팔의 `sourceHash`와 같아야 한다.

## 통합 공백

결과의 `integrationGaps`와 같다.

- UI를 렌더링하지 않는다. 앱 셸, `experiment-ledger.js`, Python, `tools/evaluation`은 이 모듈을 읽지 않는다.
- localStorage, 네트워크, 원장 자동 동기화가 없다. Python 준비기 패킷(`falsify.controlled-blue-prep.v1`)을 주고받지 않는다.
- 팔, 경로 맵, gold, 기준 투영은 호출자가 준다.
- `harnessCanonical`과 `requestBytesDigest`는 원장 run에 없다. 대기 기록이나 요청을 따로 넘기지 않으면 그 항은 비어 있다.
- 실패·취소는 대기 기록이다. 완료 run만 넘기면 그 계급은 나오지 않는다.
- 원장 검수에는 gold judgment와 `protocolVersion`이 없다. 주관 verdict만으로는 `matched-findings`가 되지 않는다.
- 인용 검증, 파일 바이트 재해시, 비용, 검증된 모델 관측은 이 모듈 밖에 있다.
- `comparisonReady`는 화면 표시 전 조건이지 성능 주장이 아니다.

## 검사

저장소 루트에서 합성 기록만 사용한다.

```bash
node app/tests/controlled-comparison.spec.cjs
```

모델 호출, 개인 문서, gold 원문, 비공개 기록은 쓰지 않는다.
