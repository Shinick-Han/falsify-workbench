# Falsify 부스: AI agent로 참여하기 / Join with an AI agent

> 사람에게: 이 페이지 주소를 당신의 AI agent에게 주세요. agent가 결함 레시피를 만들어 링크를 돌려주면, 그 링크를 부스 페이지에서 열어 직접 확인하고 동의한 뒤 제출합니다.
>
> To the human: give this page to your AI agent. It builds a defect recipe and hands you a link. You open the link on the booth page, review it, consent and submit yourself.

- 부스 페이지 / Booth page: https://shinick-han.github.io/falsify-workbench/event.html
- API base: `https://falsify-cloud-api-event.ai-gongbu.workers.dev`
- MCP endpoint: `https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp`
- 이 문서 / This guide: agent.md (Markdown), agent.html (styled)

---

## 한국어

### 부스 소개

Falsify 부스(AWS Community Day 2026)는 공개 논문에 그럴듯한 결함을 몰래 심고, AI 검토자(BLUE)가 그 결함을 찾아내는지 보는 게임입니다. 결함은 수치, 그림·표, 인용, 논리, 실험 방법 중 하나를 살짝 비트는 작은 수정입니다. 사람이 직접 고쳐도 되고, 당신(AI agent)이 레시피를 만들어도 됩니다. BLUE가 놓친 AI 결함은 특히 값진 데이터입니다.

agent가 만드는 것은 **레시피**(어디를 무엇으로 바꿀지 적은 JSON)뿐입니다. 제출은 언제나 사람이 부스 페이지에서 합니다.

### 다섯 단계

1. **논문 고르기.** `GET /v1/booth/config`의 `missions` 중 하나를 고르세요. 또는 CC BY 라이선스의 arXiv 논문이면 무엇이든 됩니다.
2. **본문 읽기.** 미션 논문은 `GET /v1/booth/missions/:paperId/text`로 쪽별 본문을 받습니다. 다른 논문은 arXiv에서 읽으세요.
3. **결함 1–3개 만들기.** 그럴듯하고, 본문의 다른 부분과 대조하면 확인할 수 있는 결함이어야 합니다. 없는 인용을 지어내지 마세요.
4. **레시피 보내기.** `POST /v1/booth/recipes`. 응답으로 코드와 URL을 받습니다.
5. **사람에게 넘기기.** 받은 `url`(또는 `code`)을 당신의 사람에게 그대로 전하세요. 사람이 부스 페이지에서 열고, 수정 전후를 확인하고, 동의하고, 제출합니다.

### API

모든 요청은 `https://falsify-cloud-api-event.ai-gongbu.workers.dev`로 보냅니다. 인증은 없습니다. 아래 경로는 CORS `*`를 허용합니다.

**1. 미션 목록**: `GET /v1/booth/config`

```json
{
  "enabled": true,
  "submissionsOpen": true,
  "defectTypes": [{"id": "number", "label": "수치·통계"}, {"id": "figure", "label": "그림·표"}, {"id": "citation", "label": "인용·출처"}, {"id": "logic", "label": "논리·결론"}, {"id": "method", "label": "방법·실험 설계"}, {"id": "other", "label": "기타"}],
  "missions": [
    {"id": "ragas", "title": "Ragas: Automated Evaluation of Retrieval Augmented Generation", "source": "arxiv", "paperId": "2309.15217", "license": "cc-by-4.0", "course": "quick", "pageHint": 5, "hint": "5쪽 Table 1의 숫자 하나를 바꿔 결론과 어긋나게 해 보세요."}
  ]
}
```

(그 밖의 필드는 사람용 화면 설정입니다. 무시해도 됩니다.)

**2. 미션 본문**: `GET /v1/booth/missions/:paperId/text`

```json
{"paperId": "2309.15217", "title": "Ragas: ...", "license": "cc-by-4.0",
 "pages": [{"page": 1, "text": "Ragas: Automated Evaluation of ..."}, {"page": 5, "text": "Faith. Ans. Rel. Cont. Rel.\n\nRagas 0.95 0.78 0.70\n..."}]}
```

미션 논문만 됩니다. 그 밖의 id는 `404`입니다. 본문은 PDF에서 뽑은 텍스트라 줄 끝 하이픈(`hu-\nmans`)이 그대로 있습니다. 찾을 때 공백과 줄 끝 하이픈은 정규화되므로 그대로 복사해도 됩니다.

**3. 레시피 보내기**: `POST /v1/booth/recipes` (`Content-Type: application/json`, 최대 8 KB)

```json
{
  "schema": "falsify.booth.recipe.v1",
  "paperId": "2309.15217",
  "edits": [
    {"page": 5, "find": "Ragas 0.95", "replace": "Ragas 0.50", "context": "Ragas 0.95 0.78 0.70"}
  ],
  "defectType": "number",
  "reason": "Ragas 충실도를 0.50으로 낮췄지만 본문은 여전히 Ragas가 사람과 가장 잘 일치한다고 말한다.",
  "agent": {"name": "Claude Code", "model": "claude-opus-5-5"}
}
```

| 필드 | 규칙 |
|---|---|
| `paperId` | arXiv id (`2309.15217`, `hep-th/9901001`). 미션 논문이거나 CC BY arXiv 논문. |
| `edits` | 1–5개 (권장 1–3개). |
| `edits[].page` | 선택. 1부터 세는 쪽 번호. 넣는 것을 권장합니다. |
| `edits[].find` | 1–300자. 그 쪽 본문에 그대로 있어야 합니다. 여러 번 나오면 `context`로 고릅니다. |
| `edits[].replace` | 0–300자. `find`와 달라야 합니다. 빈 문자열은 삭제입니다. |
| `edits[].context` | 선택. 600자 이하의 주변 글. 여러 일치 중 하나를 고를 때만 씁니다. |
| `defectType` | 선택. `number`, `figure`, `citation`, `logic`, `method`, `other` 중 하나. |
| `reason` | 선택. 500자 이하. 사람의 사유 칸을 미리 채웁니다. 사람이 고칠 수 있고, BLUE에게는 보내지 않습니다. |
| `agent` | 선택. `name`, `model` 각 60자 이하. |

`source`는 서버가 `"agent"`로 정합니다. 알 수 없는 최상위 키와 제어 문자는 거부됩니다.

응답:

- `201`: `{"code": "R-7K3QXM", "url": "https://shinick-han.github.io/falsify-workbench/event.html#recipe=R-7K3QXM", "expiresAt": "2026-11-22T12:00:00.000Z"}`
- `400`: `{"error": {"code": "invalid_request", "field": "edits[0].find"}}` (field가 없을 수도 있습니다)
- `413`: 8 KB 초과
- `429`: 요청이 너무 많습니다. `Retry-After` 초 뒤에 다시 시도하세요.

**4. 레시피 확인**(선택): `GET /v1/booth/recipes/:code`는 저장된 레시피와 `code`, `createdAt`, `expiresAt`을 돌려줍니다. 만료되었거나 없는 코드는 `404`입니다.

### curl 예시

```sh
curl -sS -X POST https://falsify-cloud-api-event.ai-gongbu.workers.dev/v1/booth/recipes \
  -H 'Content-Type: application/json' \
  -d '{
    "schema": "falsify.booth.recipe.v1",
    "paperId": "2309.15217",
    "edits": [
      {"page": 5, "find": "Ragas 0.95", "replace": "Ragas 0.50",
       "context": "Ragas 0.95 0.78 0.70"}
    ],
    "defectType": "number",
    "reason": "Table 1 lowers Ragas faithfulness to 0.50 while the text still says Ragas agrees best with humans.",
    "agent": {"name": "Claude Code", "model": "claude-opus-5-5"}
  }'
```

### MCP로 연결하기

MCP 서버(Streamable HTTP, 인증 없음): `https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp`

도구: `list_missions`, `get_mission_text {paperId, page?}`, `create_recipe {paperId, edits, defectType?, reason?, agent?}`

**Claude Code**

```sh
claude mcp add --transport http falsify-booth https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp
```

**Claude.ai (사용자 지정 커넥터)**

1. 설정 → 커넥터 → "사용자 지정 커넥터 추가"(Add custom connector)를 누릅니다.
2. 이름은 `Falsify booth`, URL은 `https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp`를 넣고 추가합니다. OAuth 항목은 비워 둡니다.
3. 새 대화의 도구 메뉴에서 Falsify booth를 켜고 "Falsify 부스 미션 하나에 결함 레시피를 만들어 줘"라고 부탁합니다.
4. Claude가 돌려준 링크를 휴대폰이나 부스 화면에서 엽니다.

(Team·Enterprise 플랜에서는 조직 소유자가 커넥터를 먼저 추가해야 할 수 있습니다.)

### 규칙

- **개인정보 금지.** 레시피에 이름, 이메일, 연락처 같은 개인정보를 넣지 마세요.
- **레시피는 6시간 뒤 삭제됩니다.** 제출 전 초안일 뿐이고, 그 뒤에는 코드가 동작하지 않습니다.
- **agent는 제출하지 않습니다.** 제출 API를 호출하지 마세요. 사람이 부스 페이지에서 수정 전후를 확인하고 동의한 뒤 직접 제출합니다.
- 결함은 그럴듯하고 확인 가능해야 합니다. 없는 인용이나 없는 논문을 지어내지 마세요.
- CC BY 라이선스 논문만 씁니다. 모든 미션 논문은 CC BY 4.0입니다.

### 상품

AI가 심은 결함(내 AI, agent)도 직접 고친 결함과 **똑같이** 상품 대상입니다. 운영자는 참여 방식(`assist`)을 볼 수 있지만, 심사와 상품 자격은 같습니다.

---

## English

### What the booth is

The Falsify booth (AWS Community Day 2026) is a game: plant a plausible defect in an open-access paper and see whether an AI reviewer (BLUE) finds it. A defect is a small change to a number, a figure or table, a citation, a conclusion or the method. A person can make it by hand, or you, an AI agent, can build a recipe for them. AI-planted defects that BLUE misses are especially valuable data.

You only build a **recipe**: JSON that says what to replace with what. A human always submits on the booth page.

### Five steps

1. **Pick a paper.** One of the `missions` from `GET /v1/booth/config`, or any CC BY arXiv paper.
2. **Read the text.** For a mission paper, `GET /v1/booth/missions/:paperId/text` returns the text page by page. For other papers, read arXiv.
3. **Craft 1–3 plausible defects** that a careful reader could catch by checking the paper against itself. Never invent citations.
4. **POST the recipe** to `/v1/booth/recipes`. You get a code and a URL.
5. **Hand it to your human.** Give them the `url` (or the `code`). They open it on the booth page, review the before/after, consent and submit.

### API

Base: `https://falsify-cloud-api-event.ai-gongbu.workers.dev`. No authentication. These routes allow CORS `*`.

- `GET /v1/booth/config`: `missions[]` with `paperId`, `title`, `license`, `course`, `pageHint` and `hint` (hints are in Korean), plus `defectTypes[]`. Ignore the other fields.
- `GET /v1/booth/missions/:paperId/text`: `{paperId, title, license, pages: [{page, text}]}`. Mission papers only; other ids are `404`. Text is extracted from the PDF and keeps line-end hyphenation; matching normalises whitespace and line-end hyphens, so copy `find` verbatim.
- `POST /v1/booth/recipes` with `Content-Type: application/json`, at most 8 KB. Body as in the Korean section above and the curl example below. Rules:
  - `paperId`: an arXiv id; a mission paper or a CC BY arXiv paper.
  - `edits`: 1–5 items (1–3 recommended), each `{page?, find, replace, context?}`. `find` is 1–300 chars and must occur in the page text; `replace` is 0–300 chars and must differ (empty deletes); `context` (≤600 chars) only picks among several matches.
  - `defectType` (optional): `number | figure | citation | logic | method | other`.
  - `reason` (optional, ≤500 chars): pre-fills the human's reason box; never sent to BLUE.
  - `agent` (optional): `{name, model}`, each ≤60 chars.
  - The server sets `source` to `"agent"`. Unknown top-level keys and control characters are rejected.
- Responses: `201 {"code":"R-7K3QXM","url":"https://shinick-han.github.io/falsify-workbench/event.html#recipe=R-7K3QXM","expiresAt":"..."}`; `400 {"error":{"code":"invalid_request","field":"..."}}`; `413` (over 8 KB); `429` (wait `Retry-After` seconds).
- `GET /v1/booth/recipes/:code` (optional): the stored recipe plus `code`, `createdAt`, `expiresAt`; `404` when expired or unknown.

### curl example

```sh
curl -sS -X POST https://falsify-cloud-api-event.ai-gongbu.workers.dev/v1/booth/recipes \
  -H 'Content-Type: application/json' \
  -d '{
    "schema": "falsify.booth.recipe.v1",
    "paperId": "2309.15217",
    "edits": [
      {"page": 5, "find": "Ragas 0.95", "replace": "Ragas 0.50",
       "context": "Ragas 0.95 0.78 0.70"}
    ],
    "defectType": "number",
    "reason": "Table 1 lowers Ragas faithfulness to 0.50 while the text still says Ragas agrees best with humans.",
    "agent": {"name": "Claude Code", "model": "claude-opus-5-5"}
  }'
```

### Connect over MCP

MCP server (Streamable HTTP, no auth): `https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp`. Tools: `list_missions`, `get_mission_text`, `create_recipe`.

**Claude Code**

```sh
claude mcp add --transport http falsify-booth https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp
```

**Claude.ai custom connector**

1. Open Settings → Connectors → Add custom connector.
2. Name it `Falsify booth`, paste `https://falsify-cloud-api-event.ai-gongbu.workers.dev/mcp` as the URL, leave the OAuth fields empty, and add it.
3. In a new chat, turn Falsify booth on in the tools menu and ask: "Make a defect recipe for one Falsify booth mission."
4. Open the link Claude returns on your phone or at the booth.

(On Team and Enterprise plans an organisation owner may need to add the connector first.)

### Rules

- **No personal data** in recipes: no names, emails or contact details.
- **Recipes expire after 6 hours.** They are pre-submission drafts and are deleted after that.
- **Agents never submit.** Do not call the submission API. The human reviews the before/after on the booth page, consents and submits.
- Defects must be plausible and checkable. Do not invent citations or papers.
- CC BY papers only. Every mission paper is CC BY 4.0.

### Prizes

AI-planted entries (my-ai or agent) are eligible for **the same prizes** as manual ones. Operators can see how an entry was made (`assist`); judging and eligibility are the same.
