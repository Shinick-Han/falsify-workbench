# Falsify Paper Workbench: data and privacy

Updated 2026-11-19. Operator: Shinick Han. Support and deletion requests: [repository issues](https://github.com/Shinick-Han/falsify-workbench/issues). Do not post credentials, private papers, or private records in public issues; request a private follow-up instead.

## Local use

The static web app parses documents in your browser. Locally created experiment text, model responses, Harness definitions, review names and notes are saved in that browser's local storage and explicit JSON backups. Browser sites/origins have separate local records. Clearing site data can erase local records; download a backup first. Existing local records are preserved during this storage transition.

Records fetched from Confluence are opened in a separate temporary memory view, not automatically copied into persistent browser storage. That view and its draft reviews end on reload, disconnect, explicit close or after at most 12 hours. Publish draft reviews explicitly to retain them in Confluence. Normal local backups contain the original local ledger, not that temporary remote view. Explicitly previewing a shared Harness does not register or execute it; registration remains the user's separate action.

## Optional team publication

Confluence is the only remote archive offered by this version. Publication is an explicit action and means sharing the selected case with members who can access the configured Falsify archive location. A case includes its extracted paper text, model responses, required RED/BLUE dependency records, Harness definitions, reviewer identifiers and review notes. Standalone Harness publication includes its configuration. Existing private records and unrelated local cases are not automatically published. The initial JSON archive does not include original or modified PDF file bytes.

Published records are stored as pages and JSON attachments in the Falsify Confluence space, subject to Atlassian's policies and the team's permissions and retention decisions. The relay does not maintain a separate experiment database or object store. Older Workbench account records are preserved separately for migration and are not automatically republished.

## Connection and execution

Atlassian OAuth authorizes the relay to access the configured site, space and archive parent using your permissions. The browser caches an encrypted connection envelope for at most 12 hours; access and refresh tokens are handled by the relay and are not placed in public code, URLs, experiment archives or model input. The relay does not persist Atlassian account profiles, names, email addresses or account identifiers in an application database. It processes archive contents in transit. Operational errors use bounded codes without paper text, credentials or request bodies; hosting providers may retain platform operational metadata under their own policies.

Disconnecting clears this browser's connection and temporary remote view, not your original local experiments, published records or Atlassian-wide authorization. Revoke the integration in your Atlassian account to withdraw its grant. Delete or restrict team archives using Confluence permissions; downloaded copies cannot be recalled.

Connecting or restoring an archive does not execute a model. Explicit RED/BLUE execution uses either your local companion and selected CLI or trusted Harness, or, where the page offers it, hosted AI (below). The configured model provider receives the supplied input according to that provider's policies. Custom Harness programs may access resources allowed on your computer.

## Hosted AI (server execution)

Where hosted AI is offered (for example the event page), the PDF you choose and the job you start (role, prompt or Harness, selected edits, model and effort) are sent to the Falsify API on Cloudflare Workers and from there to the Falsify hosted runtime server. Model jobs send the document content and prompt to the selected provider (Anthropic or OpenAI). "Apply" jobs that only write your own edits into the PDF make no model call. The runtime keeps uploads, job state and produced files (such as the edited PDF) for at most 7 days and then deletes them. The API keeps a job index without the result body or prompt. Guest access on the event page uses an anonymous random session that expires after at most 6 hours; no account, name or email is needed. Rate limits use short-lived counters.

## Event booth submissions (AWS Community Day, 2026-11-22)

At the Pseudo Lab booth, visitors may plant defects in an openly licensed paper and submit the result. A submission stores: the edited PDF (in the event database, then in the operator's study archive), the declared edits (page, original and changed text, defect type, reason), the chosen course, an optional nickname, the paper reference and licence, the consent version, a receipt number and a hashed claim key, and the operator's judgment, notes and prize message. No name, phone number, email address, IP address or user agent is stored with a submission, and nicknames that look like an email or phone number are refused.

Submissions are used by the Pseudo Lab Falsify study for AI verification experiments and as human-created defect data. The operator later runs BLUE on the edited PDF only; the declared edits and reasons are never sent to the model. Study outputs may include the declared defects and BLUE results, without any visitor identity. Results and prize messages are shown only to whoever holds the receipt number and claim key. Withdraw at any time with the receipt and claim key on the event page (or at the booth): the edited PDF, declared edits, nickname, paper reference, outcome and prize message are deleted from the server at once and only a withdrawn marker with the receipt number remains; the operator deletes the archived copy at the next pull. Withdrawn submissions are excluded from every export and analysis. Mission and search papers are CC BY, CC BY-SA or CC0; if edited PDFs are ever shared outside the study, they carry the authors, arXiv id, licence and a note that they were modified.

Mission and search papers come from arXiv and are limited to CC BY, CC BY-SA and CC0 licences; search terms are sent from the server to OpenAlex or arXiv, not from your device.

부스 제출 요약: 수정한 PDF와 결함 설명(쪽·유형·이유)은 가짜연구소 Falsify 스터디의 AI 검증 실험과 사람이 만든 결함 데이터로 쓰입니다. 이름·연락처·이메일·IP는 저장하지 않으며, 결과와 경품 안내는 접수번호와 확인키로만 확인할 수 있습니다. 확인키로 언제든 철회할 수 있고, 철회하면 설명·결과·수정본 PDF가 서버에서 즉시 삭제되며 운영자 보관본도 지웁니다.

## Your choices

Keep work local, export/import a JSON backup, disconnect Confluence, revoke its Atlassian grant, or ask the team administrator to remove a published page and its attachments. Only publish material you are entitled to share. Keep secrets and unnecessary personal information out of Harness JSON, paper text and review notes. Team publication is not internet-public publication, but every authorized recipient may retain a copy.