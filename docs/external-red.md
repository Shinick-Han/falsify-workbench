# 외부 RED / BLUE 응답

원문을 먼저 선택한 뒤 외부 AI의 답변을 붙여넣거나 `.json`, `.txt`, `.md` 파일로 가져옵니다. 모델이나 네트워크는 호출하지 않습니다. 프롬프트 작성과 복사는 선택 사항입니다. 기존 수동·로컬 BLUE 실행도 그대로 사용할 수 있습니다.

RED는 Before/After가 있는 변경을 가져옵니다. After가 빈 문자열이면 삭제입니다. 읽지 못한 원문 답변도 배치에 남으며, 화면의 직접 완성 영역에서 Before/After를 추가할 수 있습니다. 위치 선택과 변경 적용은 워크스페이스에서 합니다. BLUE는 인용 없는 일반 글도 지적으로 보관하고 여러 답변을 누적합니다. 지적은 체크해 선택하고 원문에 직접 연결할 수 있습니다. 응답이 주장한 역할이 다르면 가져오지 않으며, 명시한 파일 또는 텍스트 식별이 현재 입력과 다르면 확인 후 가져옵니다.

`FalsifyExternalExchange.parse(raw, {role, segments, fileHash, sourceHash?})`는 원문 응답과 항목별 진단을 유지합니다. 위치 검색은 공백·줄 끝 하이픈을 정규화하지만 앵커는 원래 텍스트 오프셋입니다. 여러 위치는 자동 선택하지 않습니다. 외부 근거와 참고자료는 실행 검증이나 팀 공개를 뜻하지 않습니다.

`FalsifyDocumentBlueExternal`은 현재 BLUE 입력, 응답 추가, 선택·위치 연결과 복원을 제공합니다. 저장 버튼을 누르면 외부 응답 스냅샷을 로컬 기록에 보관하며 전체 기록 백업·복원에 포함됩니다. 실행 harness나 모델 호출은 만들어 기록하지 않습니다. 자동 팀 공개는 없습니다.

통합 순서: `external-red.js`, `external-exchange.js`, `external-proposals.js` 후 `external-red-ui.js`와 `document-blue.js`, 그 다음 `external-blue-ui.js`. `external-blue-ui.css`를 포함합니다. BLUE 호스트는 `#document-blue`입니다.
