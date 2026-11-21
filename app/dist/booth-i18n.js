/* Event-page English mode (event.html only; loads before booth-runtime.js).
   Korean is the default. When switched to English, walks the DOM once and keeps a
   MutationObserver running for exact dictionary keys and templated patterns, recording
   each replacement so switching back to Korean restores the original text without reload.
   Subtrees with translate="no" (paper/PDF stages, crop previews, AI quotes, receipt codes,
   claim keys, language toggles) and input/textarea values are never touched.
   Exposes globalThis.FalsifyBoothI18n = {lang(), setLang(lang), t(ko, vars)}. */
(function(root){
  'use strict';
  const LANG_KEY='falsify.booth.lang.v1';
  const KIOSK_KEY='falsify.booth.kiosk.v1';
  const EN_TITLE='Falsify · AI Review Challenge';
  const ATTRS=['aria-label','placeholder','title','alt'];
  const SKIP_TAGS=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','TEXTAREA','INPUT']);

  const DICT=Object.freeze({
    // Header, navigation, and shared controls
    '내 기록':'My tickets',
    '내':'My',
    '기록':'tickets',
    '← 처음으로':'← Start',
    '← 논문 고르기':'← Pick paper',
    '← 고치기':'← Edit',
    '논문 고르기':'Pick a paper',
    '몰래 고치기':'Sneak in a change',
    'AI 검증':'AI check',
    '2 / 3 몰래 고치기':'2 / 3 Sneak in a change',
    '3 / 3 AI에게 제출':'3 / 3 Submit to AI',
    '다음':'Next',
    '이전':'Prev',
    '검색':'Search',
    '찾기':'Search',
    '취소':'Cancel',
    '닫기':'Close',
    '삭제':'Delete',
    '다시 시도':'Try again',
    '결과 보기':'View result',
    '결과 다시 보기':'Check result again',
    '다시 도전하기':'Try again',
    '부스 도전':'Booth challenge',
    '도전 단계':'Challenge steps',
    '도전 순서':'How it works',
    '도전 티켓':'Ticket',
    'AI 검증 티켓':'AI check ticket',
    'AI 검증 결과':'AI check result',

    // Pick step: hero, how-to, missions, search, records
    'AI를':'Can you',
    '속일 수':'fool',
    '있을까요?':'the AI?',
    '공개 논문을 몰래 고쳐 보세요. AI가 보통 1~3분 안에 찾아내는지 겨뤄요. 심은 결함 중 하나라도 AI가 놓치면 부스에서 선물을 드려요.':'Sneak defects into an open paper and see if AI catches them (usually 1–3 min). If the AI misses even one, win a prize at the booth.',
    '심은 결함 중 하나라도 AI가 놓치면 성공이에요.':'If the AI misses even one of your defects, you win.',
    '미션 논문이나 공개 논문 하나':'Pick a mission paper or any open paper',
    '숫자, 문장, 결론 어디든 한 곳 이상':'Change at least one number, sentence, or claim',
    '보통 1~3분, 접수번호로 결과 확인':'Usually 1–3 min; check with your ticket no.',
    '미션 논문':'Mission papers',
    '티켓을 누르면 힌트 쪽이 열려요':'Tap a ticket to open the hint page',
    '미션 논문은 모두 arXiv에 CC BY 4.0으로 공개된 논문이에요. 부스에서 보는 결함은 방문자가 게임을 위해 심은 거예요.':'All mission papers are CC BY 4.0 on arXiv. Defects shown at the booth are planted by visitors for this game.',
    '쪽':'page',
    '도전 →':'Try →',
    '다른 공개 논문 직접 찾기':'Search other open papers',
    '논문 검색 · CC BY, CC BY-SA, CC0만':'Paper search · CC BY, CC BY-SA, CC0 only',
    '제목 또는 주제':'Title or topic',
    '다른 공개 논문 찾기 · 제목 또는 주제':'Search open papers · Title or topic',
    '검색 중…':'Searching…',
    '검색 결과가 없어요. 다른 단어로 찾아볼까요?':'No papers found. Try different keywords.',
    '논문을 불러오는 중…':'Loading paper…',
    '논문을 열지 못했어요. 다시 눌러 주세요.':'Could not open the paper. Please tap again.',
    '논문을 열지 못했어요. 페이지를 새로 고쳐 주세요.':'Could not open the paper. Please refresh the page.',
    '부스 정보를 불러오지 못했어요. 페이지를 새로 고쳐 주세요.':'Could not load booth info. Please refresh the page.',
    '부스 정보를 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.':'Loading booth info. Please try again in a moment.',
    '미션이나 검색에서 논문을 골라 시작해 주세요':'Pick a mission paper or search for one to start.',
    '접수번호와 확인키를 넣으면 도전 티켓을 다시 볼 수 있어요.':'Enter your ticket no. and claim key to view your challenge ticket.',
    '접수번호':'Ticket no.',
    '확인키':'Claim key',
    '이 브라우저의 접수':'Tickets on this browser',
    '이 브라우저의 도전 기록':'Recent tickets on this browser',

    // Edit step: credit, hint, dock, paper workspace controls
    '원문':'Source',
    '· 게임용으로 고친 사본':'· Edited copy for this game',
    '힌트':'Hint',
    '숫자, 결론 문장, 표 값 중 한 곳을 골라 티 나지 않게 바꿔 보세요.':'Pick a number, conclusion, or table cell and change it subtly.',
    '여러 곳을 고쳐도 돼요':'You can edit multiple places',
    '고친 곳 목록':'Edit list',
    '고친 곳 전체':'All edits',
    '수정본을 만드는 중…':'Building edited PDF…',
    '수정본을 만드는 도구를 불러오지 못했어요. 인터넷 연결을 확인하고 「다시 시도」를 눌러 주세요.':'Could not load the PDF editor. Check your connection and tap Try again.',
    '이전 쪽':'Prev page',
    '다음 쪽':'Next page',
    '원본 · 눌러서 편집':'Original · tap to edit',
    '편집 목록':'Edit list',
    '(지움)':'(deleted)',
    '→(지움)':'→(deleted)',

    // Page-edit controls (booth-pageedit.js)
    '전체 쪽':'Full page',
    '축소':'Zoom out',
    '확대':'Zoom in',
    '쪽 위의 숫자나 단어를 누르면 그 자리에서 바로 고칠 수 있어요.':'Click any number or word on the page to edit it in place.',
    '키보드: ← → 쪽 넘기기, + − 확대, Enter 바꾸기, Esc 취소':'Keys: ← → turn page, + − zoom, Enter replace, Esc cancel',
    '고칠 숫자나 단어를 눌러 주세요.':'Tap a number or word to edit.',
    '고칠 곳을 누르면 크게 보여요.':'Tap anywhere on the page to zoom in.',
    '바꾸기':'Replace',
    '문단 전체 고치기':'Edit paragraph',
    '원래대로':'Revert',
    '앞 단어':'Previous word',
    '다음 단어':'Next word',

    // Recipe & Find-and-replace (booth-recipe.js)
    '직접 고치기':'Edit it myself',
    '내 AI에게':'Ask my AI',
    '고치는 방법':'How to edit',
    '찾아 바꾸기':'Find & replace',
    '바꿀 글자':'Find text',
    '새 글자':'Replace with',
    '찾은 곳':'Matches',
    '준비 중':'Loading…',
    '찾는 글자가 이 논문에 없어요.':'Text not found in this paper.',
    '같은 글자가 여러 곳에 있어요. 바꿀 곳을 눌러 주세요.':'Multiple matches found. Tap the one to replace.',
    '논문이 아직 열리지 않았어요. 잠시 뒤 「바꾸기」를 다시 눌러 주세요.':'Paper is still loading. Tap Replace again shortly.',
    '새 글자가 원문과 같아요.':'New text matches the original.',
    '새 글자가 바꿀 글자와 같아요.':'New text is the same as the original.',
    '바꿀 글자를 적어 주세요.':'Enter text to find.',
    '레시피 형식이 맞지 않아요.':'Invalid recipe format.',
    '내 AI 레시피':'My AI recipe',
    '레시피':'Recipe',
    '바뀐 곳은 「다음」에서 원문과 함께 확인해요. 제출은 직접 해요.':'Review your changes on Next. You decide when to submit.',
    '확인 필요 · 바꿀 곳을 골라 주세요':'Needs review · pick where to apply',
    '쪽 그림을 그리지 못했어요. 수정본 PDF는 그대로 제출할 수 있어요.':'Could not draw page preview. You can still submit the edited PDF.',
    '원본':'Original',
    '수정본':'Edited',
    '내가 고침':'Edited by me',
    'AI가 채운 초안 · 내 말로 고쳐도 돼요':'Drafted by AI · feel free to edit',
    'AI 선택':'Picked by AI',

    // Ask my AI (booth-myai.js)
    '부탁 글 복사':'Copy prompt',
    '어떤 AI든 괜찮아요 (ChatGPT, Claude, Gemini…)':'Works with any AI (ChatGPT, Claude, Gemini…)',
    '부탁 글 언어':'Prompt language',
    '한국어':'Korean',
    '원문 PDF 받기':'Get the PDF',
    'AI에 이 PDF를 첨부하고 프롬프트를 붙여 넣으세요. 링크를 읽을 수 있는 AI라면 프롬프트만 붙여 넣어도 돼요.':'Attach this PDF to your AI and paste the prompt. If your AI can open links, the prompt alone is enough.',
    '복사':'Copy',
    '복사됨 ✓':'Copied ✓',
    '다시 복사':'Copy again',
    'AI 앱으로 보내기':'Send to AI app',
    '부탁 글 전체':'Full prompt',
    'AI 답 붙여넣기':'Paste AI reply',
    'AI 답 전체를 붙여 넣으세요. { "edits": … }가 들어 있으면 돼요. 앞뒤 설명은 괜찮아요.':'Paste the full AI reply. As long as it contains { "edits": … }, extra text is fine.',
    'AI 답':'AI reply',
    '적용':'Apply',
    '적용하는 중…':'Applying…',
    'AI가 논문을 열지 못했어요. 원문 PDF를 받아 AI에 첨부한 뒤 다시 물어봐 주세요.':'Your AI could not open the paper. Get the PDF, attach it to your AI and ask again.',
    '복사했어요. AI 채팅에 붙여 넣고, 받은 답을 전부 복사해 오세요.':'Copied. Paste it into your AI chat, then copy its full reply back here.',
    '복사했어요. 안 되면 아래 글을 길게 눌러 복사하세요.':'Copied. If that failed, press and hold the text below to copy.',
    '자동 복사가 막혔어요. 아래 글이 전체 선택되어 있으니 길게 눌러 "복사"를 고르세요.':'Auto-copy is blocked. The text below is selected—press and hold to copy.',
    '보냈어요. AI 답이 오면 길게 눌러 전부 복사해 오세요.':'Sent. Copy the full reply from your AI and paste it here.',
    '공유 창을 열지 못했어요. 「복사」를 눌러 주세요.':'Could not open share sheet. Tap Copy instead.',
    '바뀐 곳이 없어요':'No changes applied',
    '남은 곳은 바로 아래에서 고칠 수 있어요.':'You can fix the remaining ones right below.',
    '바뀐 곳을 확인한 뒤 다음 단계로 가세요.':'Check your changes, then continue to the next step.',
    '논문 도구가 아직 준비되지 않았어요. 잠시 후 다시 눌러 주세요.':'Paper tools are still loading. Try again shortly.',
    '논문에 적용하는 중':'Applying to paper…',
    'AI 답이 비어 있어요. AI가 준 답을 통째로 붙여 넣어 주세요.':'AI reply is empty. Paste the full reply from your AI.',
    '붙여 넣은 글이 너무 길어요. AI 답만 붙여 넣어 주세요.':'Pasted text is too long. Paste only the AI reply.',
    'AI 답을 읽었지만 규칙에 맞지 않아요. 아래를 고쳐 달라고 AI에게 부탁하거나 직접 고쳐 보세요.':'Read the AI reply, but it breaks the format rules. Ask your AI to fix the items below, or edit them yourself.',
    '답이 너무 길거나 JSON이 닫히지 않았어요. AI 답에서 { 로 시작해 } 로 끝나는 부분만 붙여 넣거나, AI에게 "JSON만 다시 보내 줘"라고 말해 보세요.':'Reply is too long or has unclosed JSON. Paste only the { … } block, or ask your AI for JSON only.',
    'JSON 모양이 깨져 있어요. 따옴표나 쉼표, 괄호가 빠졌을 수 있어요. AI에게 "올바른 JSON으로만 다시 보내 줘"라고 부탁해 보세요.':'Broken JSON (missing quote, comma, or bracket). Ask your AI to resend valid JSON only.',
    '답에서 수정 내용(JSON)을 찾지 못했어요. AI 답을 통째로 붙여 넣었는지 확인하거나, AI에게 "JSON만 다시 보내 줘"라고 말해 보세요.':'No JSON edits found. Check that you pasted the full reply, or ask your AI for JSON only.',
    '답이 중간에 잘린 것 같아요. 끝까지 복사했는지 확인해 주세요.':'The reply looks cut off. Check that you copied all the way to the end.',
    '쪽 번호를 읽지 못해 쪽 없이 전체에서 찾을게요.':'Could not read page number; searching the whole paper instead.',
    'JSON 대신 Before/After 형식으로 읽었어요.':'Read as Before/After format instead of JSON.',
    '수정(edits)이 하나도 없어요.':'No edits found in "edits".',
    '수정은 5개까지만 받을 수 있어요.':'At most 5 edits are allowed.',
    'agent 항목이 올바르지 않아요.':'Invalid "agent" field.',
    'reason이 500자를 넘거나 올바르지 않아요.':'Invalid "reason" (must be at most 500 characters).',
    'JSON 객체가 아니에요.':'Expected a JSON object.',
    '답이 8KB를 넘어요. 수정을 줄여 주세요.':'Reply exceeds 8 KB. Reduce the number of edits.',
    'paperId가 arXiv 번호 모양이 아니에요.':'paperId is not a valid arXiv ID.',
    'source 값이 올바르지 않아요.':'Invalid "source" value.',
    '알 수 없는 문제':'Unknown error',

    // Send step
    '숨긴 결함을':'Review your',
    '확인해요':'changes',
    '논문':'Paper',
    '고친 곳':'Edits',
    '남은 기회':'Tries left',
    'AI에게 제출하기':'Submit to AI',
    '제출하는 중…':'Submitting…',
    'AI 제안':'AI suggestion',
    '어떤 결함인가요 (선택)':'Defect type (optional)',
    '왜 결함인가요 (선택)':'Why is it a defect? (optional)',
    '결함 유형':'Defect type',
    '수치·통계':'Numbers & stats',
    '그림·표':'Figures & tables',
    '인용·출처':'Citations',
    '논리·결론':'Logic & claims',
    '방법·실험 설계':'Methods & setup',
    '기타':'Other',

    // Ticket step: waiting, verdicts, stamps, gift, final draw, withdraw
    '검증 시간':'Check time',
    '접수번호와 확인키 복사':'Copy ticket no. & claim key',
    '접수번호와 확인키를 복사했어요.':'Copied ticket no. and claim key.',
    '복사하지 못했어요. 접수번호와 확인키를 직접 적어 두세요.':'Could not copy. Please write down your ticket no. and claim key.',
    'AI가 논문을 읽는 중':'AI is reading the paper',
    'AI 검증 차례를 기다리는 중':'Waiting in the AI check queue',
    '수정본 받음':'Edited PDF received',
    'AI가 앞뒤 문장과 표를 대조하는 중':'AI is cross-checking text and tables',
    '결과':'Result',
    '이 티켓을 캡처해 두세요. 화면을 닫아도 「내 기록」에서 접수번호와 확인키로 다시 볼 수 있어요.':'Take a screenshot of this ticket. You can check back anytime under My tickets with your ticket no. and claim key.',
    'AI가 결함을 찾는 중이에요. 보통 1~3분 걸려요. 이 화면을 닫아도 접수번호와 확인키로 나중에 볼 수 있어요.':'AI is looking for defects (usually 1–3 min). You can close this screen and check later with your ticket no. and claim key.',
    'AI가':'AI',
    '찾아냈어요':'caught it',
    '근처를 짚었어요':'got close',
    '못 찾았어요':'missed it',
    'AI 눈을 피했어요':'slipped past the AI',
    'AI가 찾음':'Found by AI',
    '근처를 짚음':'AI got close',
    'AI가 놓침':'Missed by AI',
    '이번 도전은':'This entry was',
    '무효로 끝났어요':'voided',
    '결과가 나왔어요':'Results are in',
    '제출을':'Submission',
    '철회했어요':'withdrawn',
    '결함 근처까지 짚으면 적발로 봐요.':'Pointing right near your defect counts as caught.',
    '통과':'PASSED',
    '적발':'DETECTED',
    '무효':'VOID',
    '철회':'WITHDRAWN',
    '교환권':'Prize voucher',
    '교환권 · 1인 1회':'Prize voucher · 1 per person',
    '부스에서 이 화면을 보여 주세요.':'Show this screen at the booth.',
    '최종 추첨':'Final raffle',
    '마감 후 더 정밀한 AI가 한 번 더 검증해요. 그때도 못 찾으면 최종 추첨 대상이에요.':'After submissions close, a deeper AI will check again. If it still misses your defect, you enter the final raffle.',
    '숫자 하나만 바꾸면 AI가 앞뒤 문장과 대조해서 찾아내요. 결론 문장이나 실험 설계를 노려 보세요.':'Changing just one number often gets caught by cross-checking. Try tweaking a conclusion or experimental setup.',
    '내가 고친 곳':'My edits',
    '제출 철회':'Withdraw submission',
    '철회하면 서버의 수정본 PDF·설명·결과를 바로 지워요. 이미 AI 검증에 보낸 사본은 모델 제공자에게서 회수할 수 없어요.':'Withdrawing immediately deletes your edited PDF, notes, and result from our server. Copies already sent to the AI model provider cannot be recalled.',
    '이 제출 철회하기':'Withdraw this submission',
    '철회하면 되돌릴 수 없고, 선물과 추첨 기회도 함께 사라져요.':'You cannot undo this, and you will forfeit any prize and raffle entry.',
    '철회하기':'Withdraw',

    // Live note templates (tools/booth/lib/config.mjs DEFAULT_NOTES) and labels
    '내가 심어 둔 결함을 AI가 찾았어요.':'AI found the defect you planted.',
    '내가 심어 둔 결함 근처를 AI가 짚었어요.':'AI pointed near the defect you planted.',
    '심어 둔 결함 중 일부는 AI가 찾았어요.':'AI found some of the defects you planted.',
    'AI는 다른 곳을 짚었어요. 심어 둔 결함은 AI 눈을 피했어요.':'AI flagged somewhere else. Your defect slipped past it.',
    'AI가 이번 수정본에서 결함을 짚지 못했어요. 심어 둔 결함은 AI 눈을 피했어요.':'AI found no defect in this copy. Your defect slipped past it.',
    'AI가 의심한 곳':'Where AI looked',
    '운영진 안내':'Staff note',
    'AI 메모':'AI note',
    'AI 의견':'AI explanation',

    // Prize messages (configured on the live booth)
    'AI가 놓쳤어요! 부스 스태프에게 이 화면을 보여 주면 작은 선물을 드려요.':'AI missed it! Show this screen to booth staff for a small prize.',
    '더 정밀한 AI도 놓쳤어요. 최종 추첨 대상이에요.':'Even the deeper AI missed it. You are entered in the final raffle.',
    '빠른 AI를 이겼어요. 정밀 AI는 찾아냈지만, 받은 선물은 그대로 가져가세요.':'You beat the fast AI. The deeper AI caught it, but the prize you received is yours to keep.',
    '부스에서 스티커를 받아 가세요':'Pick up a sticker at the booth.',

    // Mission hints (tools/booth/missions.aws-community-day-2026.json + test fixture hint)
    '5쪽 Table 1의 숫자 하나를 바꿔 결론과 어긋나게 해 보세요. 예: Ragas 충실도 0.95 → 0.50':'Change one number in Table 1 on p. 5 so it disagrees with the conclusion. e.g. Ragas faithfulness 0.95 → 0.50',
    '3쪽 Table 2의 점수 하나를 바꿔 순위가 뒤집히게 해 보세요. 예: Mistral MTEB 평균 67.56 → 60.00':'Change one score in Table 2 on p. 3 to flip the ranking. e.g. Mistral MTEB average 67.56 → 60.00',
    '9쪽 6.6절 결과 문장의 수치를 바꿔 보세요. 예: 타임아웃 15.6%→2.1% 감소를 15.6%→21%로':'Change a number in the Section 6.6 results on p. 9. e.g. timeout drop 15.6%→2.1% to 15.6%→21%',
    '9쪽 개발자 실험 문장의 숫자 하나를 바꿔 보세요. 예: 탐지 시간 64% → 10%':'Change one number in the developer study sentence on p. 9. e.g. detection time 64% → 10%',
    'Table 1의 점수 하나를 바꿔 보세요':'Try changing one score in Table 1.',

    // Worker error codes (booth.js ERROR_TEXT)
    '지금은 접수 시간이 아니에요. 부스에서 운영 시간을 확인해 주세요.':'Submissions are closed right now. Check booth hours for when we reopen.',
    '부스 설정이 바뀌었어요. 「제출하기」를 다시 눌러 주세요.':'Booth settings updated. Please tap Submit again.',
    '수정본을 아직 만드는 중이에요. 끝나면 다시 제출해 주세요.':'Still building the edited PDF. Submit again once it finishes.',
    '이미 제출한 수정본이에요. 「내 기록」에서 결과를 볼 수 있어요.':'You already submitted this copy. Check My tickets for your result.',
    '지금 요청이 몰려 있어요. 잠시 뒤 다시 시도해 주세요.':'Too many requests right now. Please try again in a moment.',
    '이 논문은 라이선스 때문에 쓸 수 없어요. CC BY, CC BY-SA, CC0 논문을 골라 주세요.':'This paper cannot be used due to its license. Please pick a CC BY, CC BY-SA, or CC0 paper.',
    '논문 파일이 너무 커서 열지 못했어요. 다른 논문을 골라 주세요.':'This paper file is too large to open. Please pick another paper.',
    '파일 크기를 확인하지 못했어요. 「다시 시도」를 눌러 주세요.':'Could not verify file size. Please tap Try again.',
    '오늘 접수 공간이 가득 찼어요. 부스 스태프에게 알려 주세요.':"Today's submission storage is full. Please let booth staff know.",
    '이 화면에서는 AI 검증을 바로 돌리지 않아요. 「AI에게 제출하기」로 보내 주세요.':'Direct AI checks are disabled here. Use Submit to AI instead.',
    '접수번호와 확인키를 다시 확인해 볼까요?':'Please double-check your ticket no. and claim key.',
    '이 논문은 라이선스 때문에 제출할 수 없어요. CC BY, CC BY-SA, CC0 논문을 골라 주세요.':'This paper cannot be submitted due to its license. Please pick a CC BY, CC BY-SA, or CC0 paper.',
    '수정본 PDF를 읽지 못했어요. 「다시 시도」를 눌러 주세요.':'Could not read the edited PDF. Please tap Try again.',
    '수정본이 중간에 바뀌었어요. 「다시 시도」를 눌러 주세요.':'The edited copy changed mid-submit. Please tap Try again.',
    '아직 원본과 같아요. 한 곳 이상 고친 뒤 「다음」을 눌러 주세요.':'No changes detected yet. Edit at least one place before tapping Next.',
    '연결이 잠시 끊겼어요. 「다시 시도」를 누르면 새로 연결해요.':'Connection dropped briefly. Tap Try again to reconnect.',
    '입력 내용을 확인해 주세요.':'Please check your input.',
    '지금 연결로는 이 작업을 할 수 없어요. 「다시 시도」를 누르면 새로 연결해요.':'This action is not allowed on the current session. Tap Try again to reconnect.',
    '서버에 연결하지 못했어요. 네트워크를 확인한 뒤 다시 시도해 주세요.':'Could not reach the server. Check your network and try again.',
    '인터넷 연결이 끊겼어요. 연결되면 다시 눌러 주세요.':'You are offline. Tap again once you reconnect.',
    '처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.':'Something went wrong. Please try again in a moment.',

    // Kiosk & resume (booth-runtime.js)
    '다음 분께 넘기기':'Next visitor',
    '다음 분께 넘길까요?':'Hand off to the next visitor?',
    '이 기기에 남은 접수번호와 고친 곳을 지우고 처음 화면으로 돌아가요.':'This clears tickets and edits on this device and returns to the start screen.',
    '넘기기':'Hand off',
    '계속하기':'Keep going',
    '계속하시겠어요?':'Still there?',
    '20초 뒤에 처음 화면으로 돌아가요.':'Returning to the start screen in 20 seconds.',
    '계속':'Keep going',
    '처음부터':'Start over',
    '보던 논문을 이어서 볼까요?':'Resume the paper you were viewing?',
    '이어서':'Resume',
    '이어서 여는 중…':'Reopening…',
    '이어서 열지 못했어요. 논문을 다시 골라 주세요.':'Could not reopen. Please pick a paper again.',

    // Footer and sx94b strings
    '소스 코드 · AGPL-3.0-only':'Source code · AGPL-3.0-only',
    '가짜연구소 Falsify 프로젝트 · GitHub':'Falsify by Pseudo Lab · GitHub',
    '이 페이지 소스 · AGPL-3.0':'Page source · AGPL-3.0',
    '기다리는 동안 가짜연구소 Falsify 프로젝트를 둘러보세요. 마음에 들면 GitHub에서 ★를 눌러 주세요.':'While you wait, take a look at Falsify by Pseudo Lab. If you like it, give it a ★ on GitHub.',
    'GitHub에서 보기 ★':'View on GitHub ★',
    '휴대폰 카메라로 찍으면 Falsify 프로젝트가 열려요.':'Scan with your phone camera to open the Falsify project.',
    'Falsify 프로젝트':'Falsify project',
    '가짜연구소 Falsify 프로젝트 GitHub QR 코드':'Falsify by Pseudo Lab GitHub QR code',
    '잠시 후 다시 눌러 주세요.':'Please try again in a moment.',
    '논문 실험 RED':'Paper editor',
    '행사 안내':'Event notice'
  });

  function plural(n, one, many){
    return Number(n)===1?n+' '+one:n+' '+many;
  }
  function pageList(raw){
    return (raw.includes(',')?'pp. ':'p. ')+raw;
  }

  const PATTERNS=[
    [/^기회 (\d+)번 남음$/,m=>plural(m[1],'try','tries')+' left'],
    [/^다시 도전하기 · 기회 (\d+)번 남음$/,m=>'Try again · '+plural(m[1],'try','tries')+' left'],
    [/^1인 (\d+)번까지 · 이름·연락처는 받지 않아요$/,m=>'Up to '+plural(m[1],'try','tries')+' per person · No name or contact needed'],
    [/^1인 (\d+)번까지$/,m=>'Up to '+plural(m[1],'try','tries')+' per person'],
    [/^기회 (\d+)번을 모두 썼어요\. 아래 접수 목록에서 결과를 볼 수 있어요\.$/,m=>'You used all '+plural(m[1],'try','tries')+'. Check your results in the list below.'],
    [/^지금 제출이 몰려 있어요\. 잠시 뒤 다시 눌러 주세요\. 기회 (\d+)번을 다 썼다면 「내 기록」에서 결과를 볼 수 있어요\.$/,m=>'Submissions are busy right now. Try again shortly. If you used all '+plural(m[1],'try','tries')+', check My tickets for your results.'],
    [/^(\d+)번$/,m=>plural(m[1],'try','tries')],
    [/^(\d+) \/ (\d+)쪽$/,m=>m[1]+' / '+m[2]],
    [/^(\d+)쪽$/,m=>'p. '+m[1]],
    [/^([\d, ]+)쪽 · (\d+)곳$/,m=>pageList(m[1])+' · '+plural(m[2],'edit','edits')],
    [/^(\d+)곳 · ([\d, ]+)쪽$/,m=>plural(m[1],'edit','edits')+' · '+pageList(m[2])],
    [/^([\d, ]+)쪽$/,m=>pageList(m[1])],
    [/^(\d+)곳$/,m=>plural(m[1],'edit','edits')],
    [/^고친 곳 (\d+)개$/,m=>plural(m[1],'edit','edits')],
    [/^고친 곳 (\d+)개를 이어서 할까요\?$/,m=>'Resume with your '+plural(m[1],'edit','edits')+'?'],
    [/^고친 곳 (\d+)개 더 보기$/,m=>'Show '+m[1]+' more '+(Number(m[1])===1?'edit':'edits')],
    [/^(\d+)쪽 고친 곳 지우기$/,m=>'Remove edit on p. '+m[1]],
    [/^(\d+)쪽 고친 곳으로 이동$/,m=>'Go to edit on p. '+m[1]],
    [/^한 번에 (\d+)곳까지 제출할 수 있어요\. 지금은 (\d+)곳이에요\.$/,m=>'Up to '+plural(m[1],'edit','edits')+' per submission (currently '+m[2]+').'],
    [/^한 번에 (\d+)곳까지 제출할 수 있어요$/,m=>'Up to '+plural(m[1],'edit','edits')+' per submission'],
    [/^(\d+)곳까지 고칠 수 있어요$/,m=>'Up to '+plural(m[1],'edit','edits')+' allowed'],
    [/^오늘의 미션 · (\d+)$/,m=>"Today's missions · "+m[1]],
    [/^내가 숨긴 결함 · (\d+)쪽$/,m=>'My hidden defect · p. '+m[1]],
    [/^AI와 숨긴 결함 · (\d+)쪽$/,m=>'Hidden defect with AI · p. '+m[1]],
    [/^AI가 짚은 곳 · (\d+)쪽$/,m=>'AI flagged · p. '+m[1]],
    [/^(\d+)개를 모두 찾아냈어요$/,m=>'found all '+m[1]],
    [/^AI가 (\d+)개를 모두 찾아냈어요$/,m=>'AI found all '+m[1]],
    [/^(\d+)개 모두 놓쳤어요$/,m=>'missed all '+m[1]],
    [/^AI가 (\d+)개 모두 놓쳤어요$/,m=>'AI missed all '+m[1]],
    [/^(\d+)개 중 (\d+)개가$/,m=>m[2]+' of '+m[1]],
    [/^(\d+)개 중 (\d+)개가 AI 눈을 피했어요$/,m=>m[2]+' of '+m[1]+' slipped past the AI'],
    [/^이미 제출한 수정본이에요\. 접수번호 (F-\d+)로 결과를 볼 수 있어요\.$/,m=>'Already submitted. Check your result with ticket '+m[1]+'.'],
    [/^수정본 PDF는 (\d+)MB까지 제출할 수 있어요\.$/,m=>'Edited PDF must be at most '+m[1]+' MB.'],
    [/^(\d+)분 (\d+)초$/,m=>m[1]+'m '+m[2]+'s'],
    [/^(\d+)분$/,m=>m[1]+'m'],
    [/^(\d+)초$/,m=>m[1]+'s'],
    // Queue & ETA lines
    [/^앞에 (\d+)건 대기 중 · 약 (\d+)분$/,m=>m[1]+' ahead in queue · ~'+m[2]+' min'],
    [/^앞에 (\d+)건 대기 중$/,m=>m[1]+' ahead in queue'],
    [/^앞에 (\d+)명 대기 중$/,m=>m[1]+' ahead in queue'],
    [/^대기 (\d+)건 · 예상 (\d+)분$/,m=>'Queue: '+m[1]+' · est. '+m[2]+' min'],
    [/^예상 대기 시간 약 (\d+)분$/,m=>'Estimated wait: ~'+m[1]+' min'],
    [/^약 (\d+)분 남음$/,m=>'~'+m[1]+' min left'],
    [/^약 (\d+)초 남음$/,m=>'~'+m[1]+'s left'],
    // Page-edit labels
    [/^(\d+)쪽 · 이 글자 고치기$/,m=>'p. '+m[1]+' · Edit text'],
    [/^(\d+)쪽 · 고친 글자 · 원문 (.*)$/,m=>'p. '+m[1]+' · Edited · Original: '+m[2]],
    [/^(\d+)쪽 · 문단 전체 고치기$/,m=>'p. '+m[1]+' · Edit paragraph'],
    // Mission / search aria-labels
    [/^(.+) · (\d+)쪽에서 도전$/,m=>m[1]+' · Try on p. '+m[2]],
    [/^(.+) · 이 논문으로 도전$/,m=>m[1]+' · Try with this paper'],
    [/^(.+) · 도전$/,m=>m[1]+' · Try'],
    // Recipe & Find-and-replace patterns
    [/^(\d+)곳 더 있어요\. 더 길게 적으면 줄어들어요\.$/,m=>m[1]+' more matches. Type more text to narrow it down.'],
    [/^바꿨어요 · (\d+)쪽$/,m=>'Replaced · p. '+m[1]],
    [/^같은 글자가 (\d+)곳에 있어요\. 바꿀 곳을 눌러 주세요\.$/,m=>'Found '+m[1]+' matches. Tap the one to replace.'],
    [/^(\d+)곳 적용 · (\d+)곳은 직접 골라 주세요$/,m=>'Applied '+m[1]+' · pick '+m[2]+' manually'],
    [/^(\d+)곳 적용했어요$/,m=>'Applied '+plural(m[1],'edit','edits')],
    [/^내 AI 레시피 · (.+)$/,m=>'My AI recipe · '+m[1]],
    [/^레시피 · (.+)$/,m=>'Recipe · '+m[1]],
    [/^원본 (\d+)쪽, 고친 곳 주변$/,m=>'Original p. '+m[1]+', around the edit'],
    [/^수정본 (\d+)쪽, 고친 곳 주변$/,m=>'Edited p. '+m[1]+', around the edit'],
    // Ask my AI patterns
    [/^전체 ([\d,]+)자$/,m=>m[1]+' chars total'],
    [/^"(.*)" · 찾는 글자가 이 논문에 없어요$/,m=>'"'+m[1]+'" · Not found in this paper'],
    [/^"(.*)" · 같은 글자가 여러 곳에 있어요$/,m=>'"'+m[1]+'" · Appears in multiple places'],
    [/^"(.*)" · 논문이 아직 열리지 않았어요$/,m=>'"'+m[1]+'" · Paper is not open yet'],
    [/^"(.*)" · 새 글자가 원문과 같아요$/,m=>'"'+m[1]+'" · New text matches the original'],
    [/^"(.*)" · 확인이 필요해요$/,m=>'"'+m[1]+'" · Needs review'],
    [/^AI가 다른 논문 번호\(([^)]+)\)를 적어서 지금 논문\(([^)]+)\)으로 바꿨어요\.$/,m=>'AI wrote another paper ID ('+m[1]+'); switched to the current paper ('+m[2]+').'],
    [/^쓰지 않는 항목\(([^)]+)\)은 빼고 읽었어요\.$/,m=>'Ignored unused fields ('+m[1]+').'],
    [/^결함 종류 "(.*)"는 알 수 없어 비워 뒀어요\.$/,m=>'Unknown defect type "'+m[1]+'"; left blank.'],
    [/^수정이 (\d+)개라 앞의 5개만 썼어요\.$/,m=>'Found '+m[1]+' edits; kept the first 5.'],
    [/^찾는 글자 "(.*)"가 이 논문에 그대로 없어요\. 적용 결과에서 바로 고를 수 있어요\.$/,m=>'Exact text "'+m[1]+'" was not found in this paper. You can pick it below after applying.'],
    [/^알 수 없는 항목 "(.*)"이 있어요\.$/,m=>'Unknown field "'+m[1]+'".'],
    [/^schema는 "(.*)"여야 해요\.$/,m=>'schema must be "'+m[1]+'".'],
    [/^(.+)는 글자여야 해요\.$/,m=>m[1]+' must be a string.'],
    [/^(.+)가 비어 있어요\.$/,m=>m[1]+' is empty.'],
    [/^(.+)가 (\d+)자를 넘어요\. 더 짧게 잘라 주세요\.$/,m=>m[1]+' exceeds '+m[2]+' characters. Please shorten it.'],
    [/^(.+)에 쓸 수 없는 제어 문자가 있어요\.$/,m=>m[1]+' contains disallowed control characters.'],
    [/^(\d+)번째 수정이 올바른 모양이 아니에요\.$/,m=>'Edit #'+m[1]+' has an invalid shape.'],
    [/^(\d+)번째 수정의 쪽 번호가 1~500 사이 숫자가 아니에요\.$/,m=>'Edit #'+m[1]+' page must be an integer between 1 and 500.'],
    [/^(\d+)번째 수정은 바꾸기 전과 후가 같아요\.$/,m=>'Edit #'+m[1]+' has identical find and replace text.'],
    [/^(\d+)번째 수정의 context가 너무 길거나 올바르지 않아요\.$/,m=>'Edit #'+m[1]+' context is too long or invalid.'],
    [/^defectType은 (.+) 중 하나여야 해요\.$/,m=>'defectType must be one of '+m[1]+'.'],
    [/^적용하지 못했어요\. (.+)$/,m=>'Could not apply. '+translateCore(m[1])]
  ];

  function bag(name){
    try{return root[name]||null;}catch{return null;}
  }
  function getItem(store, key){
    try{return store?store.getItem(key):null;}catch{return null;}
  }
  function setItem(store, key, value){
    try{if(store){store.setItem(key,value);return true;}}catch{}
    return false;
  }
  function removeItem(store, key){
    try{if(store) store.removeItem(key);}catch{}
  }
  function isKiosk(){
    const rt=root.FalsifyBoothRuntime;
    if(rt&&typeof rt.kiosk==='function'){
      try{return !!rt.kiosk();}catch{}
    }
    const loc=root.location;
    let param=null;
    try{param=new URLSearchParams(loc&&loc.search||'').get('kiosk');}catch{param=null;}
    if(param==='1') return true;
    if(param==='0') return false;
    return getItem(bag('sessionStorage'),KIOSK_KEY)==='1';
  }
  function langStore(){
    return isKiosk()?bag('sessionStorage'):bag('localStorage');
  }
  function readStoredLang(){
    return getItem(langStore(),LANG_KEY)==='en'?'en':'ko';
  }
  function writeStoredLang(next){
    const store=langStore();
    if(next==='en') setItem(store,LANG_KEY,'en');
    else removeItem(store,LANG_KEY);
  }

  function interpolate(template, vars){
    if(!vars||typeof vars!=='object') return template;
    return String(template).replace(/\{(\w+)\}/g,(all,key)=>Object.prototype.hasOwnProperty.call(vars,key)?String(vars[key]):all);
  }
  function matchPattern(text){
    for(const [re,fn] of PATTERNS){
      const hit=re.exec(text);
      if(hit) return fn(hit);
    }
    return null;
  }
  function translateCore(trimmed){
    if(!trimmed) return trimmed;
    if(Object.prototype.hasOwnProperty.call(DICT,trimmed)) return DICT[trimmed];
    const hit=matchPattern(trimmed);
    if(hit!==null) return hit;
    if(trimmed.startsWith('· ')){
      const inner=trimmed.slice(2);
      const next=translateCore(inner);
      if(next!==inner) return '· '+next;
    }
    return trimmed;
  }
  function translateString(raw){
    if(typeof raw!=='string'||!raw) return raw;
    const trimmed=raw.trim();
    if(!trimmed) return raw;
    const translated=translateCore(trimmed);
    if(translated===trimmed) return raw;
    const lead=/^\s*/.exec(raw)[0];
    const tail=/\s*$/.exec(raw)[0];
    return lead+translated+tail;
  }

  let currentLang='ko';
  let baseTitle='';
  let applying=false;
  let observer=null;
  const origText=new WeakMap();
  const origAttrs=new WeakMap();
  const trackedText=new Set();
  const trackedAttrs=new Set();

  function lang(){
    return currentLang;
  }
  function t(ko, vars){
    const filled=interpolate(String(ko==null?'':ko),vars);
    if(currentLang!=='en') return filled;
    return translateString(filled);
  }

  function hasNoTranslate(node){
    let cur=node&&node.nodeType===1?node:node&&node.parentNode;
    while(cur&&cur.nodeType===1){
      if(typeof cur.getAttribute==='function'&&cur.getAttribute('translate')==='no') return true;
      cur=cur.parentNode;
    }
    return false;
  }
  function skipTextParent(node){
    const parent=node&&node.parentNode;
    if(!parent||parent.nodeType!==1) return true;
    return SKIP_TAGS.has(parent.tagName)||hasNoTranslate(parent);
  }
  function translateTextNode(node){
    if(!node||node.nodeType!==3||skipTextParent(node)) return;
    const cur=node.nodeValue;
    if(!cur) return;
    const rec=origText.get(node);
    if(rec&&cur===rec.en) return;
    const next=translateString(cur);
    if(next===cur) return;
    origText.set(node,{ko:cur,en:next});
    trackedText.add(node);
    node.nodeValue=next;
  }
  function translateAttr(el, attr){
    if(typeof el.getAttribute!=='function') return;
    const cur=el.getAttribute(attr);
    if(!cur) return;
    let map=origAttrs.get(el);
    const rec=map&&map.get(attr);
    if(rec&&cur===rec.en) return;
    const next=translateString(cur);
    if(next===cur) return;
    if(!map){map=new Map();origAttrs.set(el,map);trackedAttrs.add(el);}
    map.set(attr,{ko:cur,en:next});
    el.setAttribute(attr,next);
  }
  function translateElement(el){
    if(!el||el.nodeType!==1||hasNoTranslate(el)) return;
    for(const attr of ATTRS) translateAttr(el,attr);
  }
  function walkTranslate(node){
    if(!node) return;
    if(node.nodeType===3){translateTextNode(node);return;}
    if(node.nodeType!==1||hasNoTranslate(node)) return;
    translateElement(node);
    if(SKIP_TAGS.has(node.tagName)) return;
    for(let kid=node.firstChild;kid;kid=kid.nextSibling) walkTranslate(kid);
  }
  function restoreAll(){
    for(const node of [...trackedText]){
      const rec=origText.get(node);
      if(rec&&node.nodeValue===rec.en) node.nodeValue=rec.ko;
      origText.delete(node);
      trackedText.delete(node);
    }
    for(const el of [...trackedAttrs]){
      const map=origAttrs.get(el);
      if(map){
        for(const [attr,rec] of map.entries()){
          if(typeof el.getAttribute==='function'&&el.getAttribute(attr)===rec.en) el.setAttribute(attr,rec.ko);
        }
      }
      origAttrs.delete(el);
      trackedAttrs.delete(el);
    }
  }
  function withGuard(fn){
    applying=true;
    try{fn();}finally{applying=false;}
  }
  function handleMutations(records){
    if(applying||currentLang!=='en') return;
    withGuard(()=>{
      for(const rec of records){
        if(rec.type==='characterData') translateTextNode(rec.target);
        else if(rec.type==='attributes') translateElement(rec.target);
        else if(rec.type==='childList'){
          for(const node of rec.addedNodes) walkTranslate(node);
        }
      }
    });
  }
  function startObserver(doc){
    if(observer||!doc||!doc.body||typeof root.MutationObserver!=='function') return;
    observer=new root.MutationObserver(handleMutations);
    observer.observe(doc.body,{
      childList:true,characterData:true,subtree:true,
      attributes:true,attributeFilter:ATTRS
    });
  }

  /* ---------- toggle buttons & translate="no" markers ---------- */
  function syncButtons(doc){
    if(!doc||typeof doc.querySelectorAll!=='function') return;
    const isEn=currentLang==='en';
    const label=isEn?'한국어':'EN';
    const aria=isEn?'한국어로 보기':'Switch to English';
    for(const btn of doc.querySelectorAll('.booth-lang')){
      btn.textContent=label;
      btn.setAttribute('aria-label',aria);
    }
  }
  function makeToggle(doc, id, extraClass){
    const btn=doc.createElement('button');
    btn.type='button';
    btn.id=id;
    btn.className=extraClass?'booth-lang '+extraClass:'booth-lang';
    btn.setAttribute('translate','no');
    btn.textContent=currentLang==='en'?'한국어':'EN';
    btn.setAttribute('aria-label',currentLang==='en'?'한국어로 보기':'Switch to English');
    btn.addEventListener('click',()=>{setLang(currentLang==='en'?'ko':'en');});
    return btn;
  }
  function insertAfter(anchor, node){
    if(anchor&&typeof anchor.after==='function') anchor.after(node);
  }
  function placeAfter(doc, anchorId, id){
    const anchor=doc.getElementById(anchorId);
    if(anchor&&!doc.getElementById(id)) insertAfter(anchor,makeToggle(doc,id,''));
  }
  function placeInRow(doc, stepId, id){
    const step=doc.getElementById(stepId);
    const row=step&&typeof step.querySelector==='function'?step.querySelector('.booth-stepbar-row'):null;
    if(row&&!doc.getElementById(id)) row.append(makeToggle(doc,id,'booth-phone'));
  }
  function placeToggles(doc){
    if(!doc||typeof doc.getElementById!=='function') return;
    placeAfter(doc,'booth-desk-records','booth-lang-desk');
    placeAfter(doc,'booth-result-link','booth-lang-pick');
    placeAfter(doc,'booth-chances-top','booth-lang-ticket');
    placeInRow(doc,'booth-step-edit','booth-lang-edit');
    placeInRow(doc,'booth-submit','booth-lang-send');
  }
  function markNoTranslate(doc){
    if(!doc||typeof doc.getElementById!=='function') return;
    for(const id of ['paper-before-stage','paper-after-stage']){
      const node=doc.getElementById(id);
      if(node&&typeof node.setAttribute==='function') node.setAttribute('translate','no');
    }
  }
  function syncDocumentMeta(doc){
    if(!doc) return;
    if(!baseTitle&&typeof doc.title==='string') baseTitle=doc.title;
    if(doc.documentElement) doc.documentElement.lang=currentLang;
    if(typeof doc.title==='string') doc.title=currentLang==='en'?EN_TITLE:(baseTitle||doc.title);
  }
  function dispatchLangChange(doc){
    if(!doc||typeof doc.dispatchEvent!=='function'||typeof root.CustomEvent!=='function') return;
    try{doc.dispatchEvent(new root.CustomEvent('falsify:booth-lang-change',{detail:{lang:currentLang}}));}catch{}
  }
  function applyLang(doc){
    syncDocumentMeta(doc);
    syncButtons(doc);
    if(!doc||!doc.body) return;
    withGuard(()=>{
      if(currentLang==='en') walkTranslate(doc.body);
      else restoreAll();
    });
  }
  function setLang(next){
    const target=next==='en'?'en':'ko';
    const changed=target!==currentLang;
    currentLang=target;
    writeStoredLang(target);
    const doc=root.document;
    if(doc){
      markNoTranslate(doc);
      placeToggles(doc);
      if(target==='en') startObserver(doc);
      applyLang(doc);
      if(changed) dispatchLangChange(doc);
    }
    return currentLang;
  }

  function install(){
    const doc=root.document;
    if(!doc||typeof doc.getElementById!=='function'||!doc.getElementById('booth')) return;
    baseTitle=typeof doc.title==='string'?doc.title:'';
    markNoTranslate(doc);
    placeToggles(doc);
    currentLang=readStoredLang();
    if(currentLang==='en'){
      startObserver(doc);
      applyLang(doc);
      dispatchLangChange(doc);
    }else{
      syncButtons(doc);
    }
  }
  function boot(){
    const doc=root.document;
    if(!doc||typeof doc.addEventListener!=='function') return;
    if(doc.readyState==='complete') install();
    else doc.addEventListener('DOMContentLoaded',install,{once:true});
  }

  currentLang=readStoredLang();
  root.FalsifyBoothI18n=Object.freeze({lang,setLang,t,LANG_KEY});
  boot();
})(typeof window==='object'?window:globalThis);
