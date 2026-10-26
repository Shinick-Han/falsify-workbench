# Falsify Paper Workbench: data and privacy

Updated 2026-10-26. Operator: Shinick Han. Support and deletion requests: [repository issues](https://github.com/Shinick-Han/falsify-workbench/issues). Do not post credentials, private papers, or private records in public issues; request a private follow-up instead.

## Local use

The static web app parses documents in your browser. Experiment text, model responses, Harness definitions, review names and notes are saved in that browser's local storage and explicit JSON backups. Browser sites/origins have separate local records. Clearing site data can erase local records; download a backup first.

## Optional team publication

Confluence is the only remote archive offered by this version. Publication is an explicit action and means sharing the selected case with members who can access the configured Falsify archive location. A case includes its extracted paper text, model responses, required RED/BLUE dependency records, Harness definitions, reviewer identifiers and review notes. Standalone Harness publication includes its configuration. Existing private records and unrelated local cases are not automatically published. The initial JSON archive does not include original or modified PDF file bytes.

Published records are stored as pages and JSON attachments in the Falsify Confluence space, subject to Atlassian's policies and the team's permissions and retention decisions. The relay does not maintain a separate experiment database or object store. Older Workbench account records are preserved separately for migration and are not automatically republished.

## Connection and execution

Atlassian OAuth authorizes the relay to access the configured site, space and archive parent using your permissions. The browser caches an expiring encrypted connection envelope; access and refresh tokens are handled by the relay and are not placed in public code, URLs, experiment archives or model input. The relay processes archive contents in transit. Operational errors use bounded codes without paper text, credentials or request bodies; hosting providers may retain platform operational metadata under their own policies.

Disconnecting clears this browser's connection, not your local experiments, published records or Atlassian-wide authorization. Revoke the integration in your Atlassian account to withdraw its grant. Delete or restrict team archives using Confluence permissions; downloaded copies cannot be recalled.

Connecting or restoring an archive does not execute a model. Explicit RED/BLUE execution uses your local companion and selected CLI or trusted Harness; the configured model provider receives the supplied input according to that provider's policies. Custom Harness programs may access resources allowed on your computer.

## Your choices

Keep work local, export/import a JSON backup, disconnect Confluence, revoke its Atlassian grant, or ask the team administrator to remove a published page and its attachments. Only publish material you are entitled to share. Keep secrets and unnecessary personal information out of Harness JSON, paper text and review notes. Team publication is not internet-public publication, but every authorized recipient may retain a copy.
