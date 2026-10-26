# 수동 편집 출처와 사람 검수

이 모듈은 논문 작업대의 사람 편집, 외부 AI 가져오기, 작업대 AI 제안을 모델 실행 기록과 따로 남긴다. Harness, 실행 증명, gold, 모델 호출을 만들지 않는다. 영구 원격 저장은 기존 Confluence 팀 보관뿐이다.

조정자가 `app/dist/index.html`에 다음을 `confluence-store` 다음에 넣는다. 이 변경 세트는 index, workspace, controller를 고치지 않는다.

```html
<link rel="stylesheet" href="paper-manual-records.css">
<script src="paper-manual-records.js" defer></script>
```

## 작업대 연결

`FalsifyPaperWorkspace`가 있으면 다음을 읽는다.

- `getSource()` — 원문 파일 해시, 이름, 세그먼트
- `getEditSnapshot()` — `falsify.paper-edits.v1`
- `getOutput()` — 마지막 생성 PDF의 `sha256`, `revision`, `verification`. PDF 바이트는 버린다

이벤트는 `falsify:paper-workspace-edits`, `falsify:paper-workspace-output`, `falsify:paper-workspace-source`, `falsify:paper-team-share`다. 편집 이벤트만 메모리 기록을 만든다. 팀 공유 이벤트는 동의 화면만 연다.

기록은 원문, 최종 문장, 쪽, 앵커, 출처(`human`, `external-ai-import`, `ai-proposal`), 사용 여부, 편집 리비전, 그 리비전과 같은 생성 해시만 담는다. 사람이 Before나 위치를 다시 치지 않아도 된다. 원문 해시와 스냅샷 해시가 다르면 기록을 만들지 않는다. 리비전이 다른 생성 해시는 현재 다운로드 해시로 연결하지 않는다.

## 검수

화면은 기존 `#human-evaluation` 검수 경로에 붙는다. 점수 1–5와 이유는 사람이 적는다. 맞춘 BLUE가 없어도 수동 검수와 가져온 보관 검수는 저장된다.

BLUE는 `FalsifyLab.blueFileChoices()`의 로컬 BLUE 파일 해시와 지적만 본다. 생성 PDF SHA-256과 같은 파일을 골랐을 때만 Before/After 옆에 지적을 둔다. 원문만 있거나 해시가 다르면 일치로 표시하지 않는다. 선택 결과에는 RED 실행, Harness, gold가 들어가지 않는다. BLUE로 넘기는 값은 생성 파일 해시뿐이다.

세그먼트 ID가 없거나 Before가 그 세그먼트에 정확히 한 번이 아니면 원문 위치로 확정하지 않는다.

## 팀 보관

아카이브 `kind`는 `paper-edit`다. `data.schema`는 `falsify.paper-edit-record.v1`다. 코덱은 `buildPaperEditArchive`, `normalizePaperEdit`, `validateArchive`, `archiveHash`다. 실험·Harness 보관 검증은 그대로다.

동의 체크 뒤에만 `FalsifyConfluenceStore.publishPaperEdit(record, {teamShare:true})`가 기존 세션으로 한 번 POST한다. 결과가 불명이면 자동 재시도하지 않는다. 원본 PDF 바이너리, gold, Harness 증명은 올리지 않는다. 페이지 요약에도 텍스트와 편집만 올린다고 적는다.

가져온 `paper-edit`는 `FalsifyLab.openArchive`가 `FalsifyPaperManualRecords.openImported`로 넘긴다. 메모리는 최대 12시간이고 닫으면 사라진다. `falsify.experiment-ledger.v1`은 덮어쓰지 않으며 출처를 실행 기록으로 바꾸지 않는다.

## 시험

```text
node --test app/tests/paper-manual-records.spec.cjs
node --test app/tests/review-bundle.spec.mjs
node app/tests/confluence-store.spec.cjs
node --test cloud/api/test/confluence-gateway.test.mjs
node app/tests/cloud-ledger-hooks.spec.cjs
```

합성 기록만 사용한다. 통과는 Confluence 저장이나 배포 인증이 아니다.
