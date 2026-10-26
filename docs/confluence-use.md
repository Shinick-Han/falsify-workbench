# Falsify Confluence 팀 보관

원격 보관은 Falsify Confluence 팀 공간 하나다. 작업대 사용자 이름·비밀번호 가입, 비공개/공유 전환, 다른 기록 서버는 새 화면에 없다. 로컬 실행·검수·Harness와 JSON 백업/병합은 결과 화면의 기록판에 그대로 있다. 로그인하거나 복원해도 그 기록을 지우지 않는다.

이 문서는 화면 동작이다. 운영자의 OAuth 앱 등록, 비밀 값, 배포는 포함하지 않는다. 목 시험이 통과해도 실제 Atlassian 로그인이나 팀 공간 저장이 증명된 것은 아니다.

## 연결

검수, 결과, Harness 화면에 **Confluence에 연결**, **Confluence에 팀 공유**, **팀 기록 불러오기**가 있다.

연결은 게이트웨이 `POST /v1/confluence/auth/start`가 돌려준 Atlassian 주소만 팝업으로 연다. 브라우저는 콜백 메시지의 출처가 게이트웨이 origin인지, `popup.source`가 그 창인지, nonce가 이번 연결의 값인지 확인한 뒤에만 세션을 받는다. 세션은 `falsify.confluence-session.v1`에 AES-GCM으로 감싼 불투명 값으로만 둔다. 실험 원장 키와 섞지 않고, API 키나 클라이언트 비밀을 입력받지 않는다.

**이 브라우저 연결 끊기**는 이 브라우저의 세션 캐시만 지운다. Atlassian 권한 전체가 취소되었다고 표시하지 않는다.

게이트웨이가 Confluence로 설정되지 않았거나 사이트·공간이 `https://falsify.atlassian.net` / `Falsify` / `65737`이 아니면 팝업을 열지 않는다. 운영자 설정이 필요하다.

## 팀 공유

동의 체크 뒤에만 지금 고른 실행과 사람 검수, 또는 선택한 등록 Harness 하나를 올린다. 로그인만으로 원장 전체가 올라가지 않고 모델을 실행하지 않는다. 요청은 `{archive, teamShare:true}` 한 번이다. 첫 흐름은 JSON이다. 추출문과 원응답이 들어 있을 수 있지만, 그것만으로 원본 PDF를 저장한 것은 아니다.

쓰기 전에 세션을 한 번 갱신한다. 갱신이 끝나기 전에는 보관을 보내지 않는다. 응답이 없거나 해시가 다르거나 미완성이면 성공으로 보지 않고 같은 POST를 자동으로 다시 보내지 않는다. **팀 기록 불러오기**로 읽어서 확인한다. 충돌이면 덮어쓰지 않는다.

크기 한도는 보관 JSON 450만 자와 UTF-8 6MiB다. 게이트웨이가 더 작은 `maxArchiveBytes`를 알리면 그 바이트 한도를 쓴다. 넘는 보관은 잘라서 보내지 않는다.

갱신된 봉인 세션이 응답 헤더 `x-falsify-confluence-session`에 있으면 캐시를 바꾼다. 만료 시각은 `x-falsify-confluence-session-expires`다. 헤더 값은 화면에 보이지 않는다.

## 불러오기

목록은 제목과 페이지 식별자만 보여 준다. **이 보관 열기**가 본문 하나를 받는다. 해시가 맞을 때만 실험을 `FalsifyLab.restoreArchive`로 넣고 검수 선택으로 연다. Harness는 검토 화면만 채우며, 등록 버튼을 누르기 전에는 등록되거나 실행되지 않는다. 복원이 거절되면 자동으로 다시 넣지 않는다. 다음 목록 커서가 짧은 토큰이 아니면 그 주소로 요청하지 않는다.

## 로컬 시험

합성 데이터만 쓴다. 운영 게이트웨이, 실제 논문, 모델, OAuth 앱 등록은 호출하지 않는다.

```text
node app/tests/confluence-store.spec.cjs
```

`review-bundle.mjs`가 아직 없어도 이 시험은 가짜 codec으로 동작한다. 통합 전에는 화면이 그 모듈의 `buildExperimentArchive`, `buildHarnessArchive`, `validateArchive`, `archiveHash`를 호출한다.
