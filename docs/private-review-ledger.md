# 비공개 검수 묶음의 로컬 복원

같은 계정의 다른 브라우저가 서버에 저장된 비공개 실행 기록을 열 때, 로컬 원장은 `FalsifyLab.restorePrivateBundle(bundle)` 한 번으로 그 묶음만 병합한다. 이 함수는 모델 호출, CLI 선택, 결과 재계산, gold 인증, 코드 설치가 아니다. broker 응답을 다시 넣는 것도 새 실행으로 세지 않는다.

## 묶음

```json
{"schema":"falsify.private-review-bundle.v1","selectedRunId":"RUN_ID","ledger":{"schema":"falsify.experiment-ledger.v1","harnesses":[],"runs":[],"reviews":[]}}
```

최상위 키는 `schema`, `selectedRunId`, `ledger`뿐이다. `ledger` 키는 `schema`, `harnesses`, `runs`, `reviews`뿐이다. 묶음은 검증된 원장에서 복사한 의존 폐쇄이며 새 실험 결과가 아니다. 실행 객체는 저장돼 있던 그대로 둔다.

`selectedRunId`가 가리키는 실행과 함께 다음을 포함한다.

- 그 실행의 `snapshotOf` 부모와 `sourceRunId` 조상
- 포함된 검수의 `comparison.sourceRunId`가 가리키는 RED. 실행 조상이나 파일 해시가 같은 최신 RED만으로는 대신할 수 없다
- 선택한 BLUE에 `sourceRunId`가 없으면, 출력 파일 해시가 같은 RED 최종 기록 중 원장 순서의 마지막 기록과 그 부모
- 포함된 실행이 쓰는 harness
- 포함된 실행의 검수 전체. `findingAssessments`, `reviewContext`, 대조 판정, 메모를 유지한다

개수와 용량 한도를 넘기면 잘라내지 않고 거부한다. 실행 100건, harness 100개, 검수 1000건, JSON 문자열 길이와 UTF-8 바이트 모두 4.5MB다. 이 한도는 기존 로컬 원장·백업 한도이며 서버 요청 본문 한도를 늘리지 않는다.

## 병합

`ready`를 기다린다. 저장소를 읽지 못하는 상태에서는 `cloudSnapshot`과 같이 거부하고 그 저장본을 덮어쓰지 않는다.

묶음 형식과 선택 ID를 확인한 뒤 `validateDatabase(imported=true)`로 harness 해시, 논문 해시, 스냅샷 부모, `sourceRunId`, 검수 대조를 검사한다. 통과한 뒤에만 백업 병합과 같은 충돌 규칙으로 메모리에서 합치고, 합친 원장이 다시 읽혀도 통과할 때만 `localStorage`에 한 번 쓴다.

- 같은 ID·같은 내용이면 다시 쓰지 않는다. 기존 실행의 출처는 유지한다
- 같은 ID의 내용이 다르면 아무 것도 쓰지 않는다
- 새로 들어온 broker 주장은 `imported-unverified`다. 로컬 broker 실행 횟수나 CLI 동의로 올리지 않는다
- 스냅샷을 기존 로컬 뿌리와 합쳤을 때 출처가 달라 다시 읽기 검증에 실패하면 스냅샷만 남기지 않고 전부 취소한다
- 용량·수량·`setItem` 실패도 기존 저장본과 메모리 원장을 그대로 둔다

성공하면 기존 드롭다운과 검수 이력을 갱기고, `review`와 같은 경로로 `selectedRunId`를 연다. 반환값은 그 ID 문자열이다. 최종 RED 스냅샷 ID를 골랐으면 그 스냅샷을 열며 뿌리 실행으로 바꾸지 않는다.

묶음이 없거나 위 형식이 아니면 필드를 만들어 채우지 않는다. 예전 실행·harness·검수 기록은 이 경로 없이 그대로 읽힌다.
