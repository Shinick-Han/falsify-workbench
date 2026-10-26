# Confluence 아카이브 형식과 로컬 복원

원격 저장은 Confluence 팀 아카이브뿐이다. 이 문서는 그 아카이브의 데이터 형식과 브라우저 원장 복원이다. 개인 계정 저장, D1 기록 백엔드, `falsify.private-review-bundle.v1`은 이 인터페이스가 아니다. 로컬 JSON 백업·병합은 그대로다.

구현은 `app/dist/review-bundle.mjs`다. DOM, 저장소, 네트워크, 자격 증명을 쓰지 않는다. harness·RED·BLUE·검수 검증기는 `{harness, red, blue, review}`로 넘긴다. 브라우저에서는 기존 전역 객체를 쓸 수 있지만, 모듈이 UMD 스크립트를 ESM으로 import하지는 않는다.

## 실험 아카이브

```json
{"schema":"falsify.confluence-archive.v1","kind":"experiment","id":"선택한 실행 ID","title":"사람이 읽는 제목","data":{"schema":"falsify.review-bundle.v1","selectedRunId":"선택한 실행 ID","ledger":{"schema":"falsify.experiment-ledger.v1","harnesses":[],"runs":[],"reviews":[]}}}
```

`buildExperimentArchive(snapshot, selectedRunId, validators)`는 검증된 `cloudSnapshot`에서 선택 사례의 의존 폐쇄만 복사한다. 원본 스냅샷과 응답 객체는 바꾸지 않는다. 출처도 아카이브 안에서는 그대로다.

폐쇄에 들어가는 것:

- 선택한 실행
- `snapshotOf`와 `sourceRunId` 조상
- 포함된 검수 `comparison.sourceRunId`의 RED와 그 조상
- 선택한 BLUE에 `sourceRunId`가 없으면, 출력 파일 해시가 같은 RED 최종 기록 중 원장 순서의 마지막 기록과 그 부모
- 포함된 실행이 쓰는 harness와, 그 실행의 검수 전체 (`findingAssessments`, `reviewContext`, 대조, 메모)

일치하는 RED가 없는 독립 BLUE는 BLUE만으로 닫을 수 있다. 순환, 없는 참조, 중복 ID, 폐쇄 밖의 실행·harness·검수, 해시 불일치는 거부한다. 자르지 않는다.

제목은 표시용이다. 역할, 응답/최종 스냅샷, 입력 이름 또는 해시 앞 12자, `createdAt`, 실행 ID를 잇는다. 500자를 넘으면 만들지 않는다.

## Harness 아카이브

`kind`는 `harness`다. `id`와 `data.hash`는 검증된 내용 해시와 같다. `data`는 `{config, hash}`뿐이다. 실행 기록이나 검수를 붙이지 않는다.

## 해시와 한도

`archiveHash`는 키를 정렬한 canonical JSON의 SHA-256이다. 배열 순서는 유지한다. 같은 내용이면 키 순서가 달라도 해시가 같다.

아카이브 JSON의 UTF-8 길이와 canonical JSON의 UTF-8 길이 모두 6 MiB 이하다. 실행 100건, harness 100개, 검수 1000건이다. 로컬 원장의 기존 4.5M자 한도는 브라우저 복원에서 따로 적용한다. 6 MiB 이하라도 로컬 원장에 들어가지 않으면 병합하지 않는다.

## 브라우저 복원

`FalsifyLab.restoreArchive(archive)`만 쓴다.

- 실험을 복원하면 `{kind:'experiment', runId}`를 반환하고 기존 검수 경로로 그 실행을 연다. 화면 이동은 호출자가 한다
- 새 기록의 출처는 `imported-unverified`다. 이미 있는 같은 ID의 내용이 같으면 쓰지 않고, 로컬 실행 출처를 유지한다
- 로컬에 검증된 RED 루트만 있고 최종 스냅샷은 없을 때, 그 루트와 파일·Harness·모델·리비전·예산·요청 ID·원응답이 같은 `imported-unverified` 스냅샷을 더할 수 있다. 루트 출처와 로컬 broker 실행 수는 올리지 않는다. 다시 읽기와 재내보내기는 원장과 코덱이 같은 규칙으로 통과한다
- `imported-unverified`가 아닌 스냅샷은 부모와 출처가 같아야 한다. 부모 식별이 다른 링크, 내용이 다른 같은 ID, 다시 읽기 검증 실패, 용량·수량 초과, 저장소 오류는 한 건도 쓰지 않는다
- Harness 아카이브는 `{kind:'harness', hash}`를 반환하고 `previewSharedHarness`로 편집기에만 올린다. 등록·선택·실행하지 않는다
- 실험에 포함된 harness 정의는 백업 병합과 같이 라이브러리에만 더한다. 실행 선택이나 CLI 동의로 바꾸지 않는다

모델 `bind`는 요청 최상위에서 아카이브·묶음·Confluence 인증 재료를 제거한다. 키는 `archive`, `bundle`, `reviewBundle`, `restoreBundle`, `confluence`, `confluenceSession`, `oauth`, `accessToken`, `refreshToken`, `authorization`, `bearer`, `clientSecret`, `archiveSha256`, `archiveHash`, `teamShare`, `nonce`, `session`이다. 복원과 해시 계산은 모델 호출이 아니다.

## 시험

통합 러너에 넣기 전에 이 파일만 실행한다.

```text
node --test app/tests/review-bundle.spec.mjs
node app/tests/cloud-ledger-hooks.spec.cjs
```

합성 기록만 쓴다. 통과해도 Confluence OAuth나 실제 저장이 확인된 것은 아니다.
