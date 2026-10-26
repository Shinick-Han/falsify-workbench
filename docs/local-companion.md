# Connect your own CLI

The website is https://shinick-han.github.io/falsify-workbench/. It does not run a CLI on GitHub or use the author's account. Each participant starts their own companion, using their own CLI login and model subscription.

## Windows

1. Install Python 3.10+ and at least one built-in CLI yourself: Codex CLI or Claude Code. Sign in with your own subscription (`codex login`, or run `claude` and use `/login`). The platform never installs a CLI, signs you in or asks for an API key.
2. Download this repository's source ZIP, extract it to a folder you will keep, and open PowerShell in that folder. Read the scripts before executing them.
3. Start the companion, either manually each time or with the optional click-to-launch link below. On the first launch it creates `.venv` in this project and installs the pinned Python dependencies from PyPI, printing each setup step; later launches skip pip until the requirements change. Before the broker starts it lists which of `codex` / `claude` were found on PATH (nothing is run) and how to sign in.
4. Connect without copying the process token, or use the manual paste fallback. Click-to-launch shows a visible Yes/No approval for the fixed origin `https://shinick-han.github.io` (the default button is No). After you approve, the companion runs in the background on Windows PowerShell 5.1 and PowerShell 7. The process token is not printed and is not sent to the website. The page receives a separate short-lived reconnect credential (15 minutes), bound to that origin, the one-time proof, the port and an expiry. Reloading the page checks connection status only. It does not post a model job or record consent. If the browser asks for local-network access, allow it only for this trusted site. That permission is the browser's own prompt; this page cannot detect or bypass it.
5. In RED or BLUE, supply a paper and choose CLI, model and effort for that role. These are per-role choices, not a global setting of the companion or the link. Pairing does not execute a model. Each execution still requires its own consent.

### Manual start

Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\start-companion.ps1`. This applies the execution policy only to this process; it does not modify your global policy.

### Optional: click-to-launch `falsify://connect`

Install once, yourself, from the folder you will keep:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-connection.ps1 -WhatIf   # preview, changes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-connection.ps1
```

This registers a per-user URL protocol under `HKCU\Software\Classes\falsify` (see Microsoft's [application registration](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration) and [URI scheme registration](https://learn.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa767914(v=vs.85)) documentation). It needs no administrator rights and creates no startup entry, scheduled task or service. The registered command is fixed: the PowerShell executable you installed with runs `open-connection.ps1` from this checkout with `-NoExit`, and the clicked link is passed as one quoted argument. The installer refuses if `falsify:` is already registered by another application, per-user or machine-wide, and never overwrites it. **Do not move or rename the folder afterwards**; if you do, run `uninstall-connection.ps1` and install again from the new location.

The website connect button opens one of two links. A manual/port-only link is `falsify://connect?port=7816`. A click-pairing link is the same port plus `challenge`, `state` and `proof`, each 43 unpadded base64url characters, in that order. Windows normalizes either link to `falsify://connect/?...` (one empty root slash) before passing it to PowerShell, so that single equivalent form is accepted too. Nothing else is: no other path, double slash, user info, fragment, extra or repeated query keys, percent-encoding, whitespace, case changes, leading zeros, bearer token, password, command, model or website origin. Anything else is rejected before any network, Python, model or child process. The companion always approves the fixed origin `https://shinick-han.github.io`; the link cannot name a different origin.

The browser asks whether to open Windows PowerShell; this prompt is the browser's own approval and is not suppressed. For a pairing link the script then shows its own Yes/No dialog. No leaves nothing registered and issues no credential. Yes starts the companion in the background (`pythonw` when the virtual environment has it, otherwise a hidden `python` process) and registers the one-time triple on the loopback launcher channel. The page redeems it once. A second redeem is a replay. The wrong proof, wrong origin, an expired challenge, a revoked credential, a port mismatch, or a user cancel does not issue a usable credential. Error lines, when startup fails, go to `%LOCALAPPDATA%\falsify-workbench\logs\companion-errors.log` and do not include the process token, the reconnect credential or the nonces. Successful background startup does not write that log.

The reconnect signing key is `%LOCALAPPDATA%\falsify-workbench\pairing\reconnect.key` (mode restricted to the current user; on POSIX the same role is `0600` for the file and `0700` for the directory). It is outside this repository and outside `app/dist`. Revocations are stored beside it. The in-memory server process token is a different secret. `/api/session` still returns that process token only to a same-origin loopback client. The new `/api/pair/register` route accepts only the native launcher header plus that process token. `/api/pair/redeem`, `/api/pair/status` and `/api/pair/revoke` are the only pairing routes a browser from the fixed origin can call, and none of them returns the process token or starts a model.

Remove the protocol with `powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-connection.ps1` (`-WhatIf` previews). It removes only this launcher's own exact registration, key by key, and refuses to touch anything else. The project folder, `.venv` and the private pairing key remain.

Browser limits of custom protocols: the web page cannot tell whether the protocol is installed (if not, clicking does nothing or shows a browser message), cannot see the terminal or read its output, and receives no process token from it. Browsers may require a user click and show a confirmation each time unless you choose to remember it for this site. Entering the link in Win+R also works but has no browser prompt. If click-pairing is unavailable, paste the process token from a foreground `start-companion.ps1` window. That manual token is still never placed in a link.

Clicking Connect again does not require manually finding and killing the old server. The launcher checks the Windows listener and its exact Python script path before contacting it. An idle companion from this same checkout is gracefully restarted after startup prerequisites pass. A reconnect credential signed by the persistent key survives that restart until it expires or is revoked. A challenge that was not yet redeemed does not. Restart does not clear browser-local papers, harnesses or records.

If RED/BLUE or PDF export is running, or the companion still retains recent job results, it is reused rather than stopped. Older same-checkout companions without the restart protocol are also reused; they need a manual stop once to adopt the new restart behavior. The launcher never force-kills a process. A foreign, ambiguous or differently configured listener is left untouched with an explanatory message. In that case use a genuinely free port, e.g. `-Port 7817` or `falsify://connect?port=7817`, and set the website's port field to the same number. Simultaneous clicks are serialized during startup; a second terminal does not start a competing broker.

`-NoInstall` skips pip entirely; deleting `.venv` forces a fresh setup. `-NoPdf` skips installation of the optional PDF editor in a new environment; it does not uninstall an existing one. PDF import remains browser-local, but PDF modified-file export requires PyMuPDF. TXT export does not require it.

The launcher tests in `scripts/test-connection.ps1` are dry-run only: they never write the registry, start the companion, open a window or call a model.

`scripts/test-companion-lifecycle.ps1` additionally checks lifecycle identity, HTTP behavior, startup failure protection, restart/reuse and mutex recovery using synthetic companions on temporary loopback ports. Run it under both Windows PowerShell and PowerShell 7. It does not call an AI model or touch an existing companion.

### Longer PDF edits (opt-in reflow engine)

The unconfigured companion retains legacy single-line PDF editing. For longer After text,
configure the separate verified `falsify-pdf-editor` module and its patched candidate
manifest as described in [PDF editor setup](pdf-editor.md). The Windows launcher reads
the ignored `.pdf-editor.local.json` or explicit `-PdfEditorRoot`/`-PdfEditorManifest`.
Once configured, the same connect button and selected-only download action use that
engine; no manual Node command is needed for each export. Missing Node 24+, source or
verified runtime is reported without silently returning to the old editor. The public
source release does not bundle a prebuilt patched WASM.

## macOS / Linux

From the extracted repository root, the manual fallback is unchanged:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r app/local/requirements.txt
.venv/bin/python app/local/server.py --web-origin https://shinick-han.github.io
```

Windows equivalent after creating a venv: `.venv\Scripts\python.exe ...`. Add `--port 7817` if needed. This foreground process prints the process token for paste. To use the entirely local website instead, omit `--web-origin` and open the printed `http://127.0.0.1:<port>/` address. Local-only mode has no remote origin permission.

Optional click-to-launch on Linux writes a per-user desktop entry and does not use sudo:

```sh
sh ./install-connection.sh    # or: FALSIFY_CONNECT_DRY_RUN=1 sh ./install-connection.sh
```

`open-connection.sh` accepts the same port-only and challenge/state/proof links as Windows. Approval is a visible dialog only when a native prompt exists (`osascript` on macOS). Otherwise the script stops and tells you to use the manual token. It does not treat a missing dialog as approval. After approval it starts the companion in the background with `--token-display hidden` and registers the one-time triple. The signing key is `$XDG_DATA_HOME/falsify-workbench/pairing` or `~/.local/share/falsify-workbench/pairing` (macOS: `~/Library/Application Support/falsify-workbench/pairing`), directory mode `0700`, key mode `0600`.

macOS handler files can be copied by `FALSIFY_CONNECT_OS=Darwin ./install-connection.sh`. That copy does not call Launch Services (`lsregister`) and does not click through an `osascript` dialog. The Linux cloud agent that produced this change cannot execute the macOS UI, so nothing here is a macOS certification. A participant on macOS still has to allow the browser protocol prompt, the approval dialog, and local-network access themselves.

Remove a handler this checkout installed with `./uninstall-connection.sh`. A desktop entry that points somewhere else is left in place. The pairing key is not deleted.

## Optional PDF preflight (0.2.0-alpha.1+)

After connecting, RED's **PDF 사전분석** button sends the currently supplied PDF and only selected Before/After candidates to
your own local companion. Upload alone does not send this request. It calls no model, runs the bounded probes in an isolated
child, and displays only inspected-page/object counts and advisory text-layout statuses. This is not a visual/scientific verdict
or editing permission and does not affect the existing export quality gate. Detailed geometry, RED plans and gold are not sent
to BLUE. Docling ML conversion is not configured or downloaded. Object writing remains a separate experiment.

Old companions show an update hint; manual exchange and supported RED/BLUE/export flows remain usable. The connection panel
reports the authenticated companion version. Analysis has a fixed deadline and is serialized with other local operations.
See [adapter evidence](pdf-adapter-experiments.md) and [source release updates](releases.md).

## Other CLIs and custom harnesses

Codex CLI and Claude Code are both built-in adapters using your own subscription login; choose either per role in RED or BLUE. Any other CLI can be connected through a trusted wrapper that follows the JSON stdin/stdout protocol in [the harness contract](harness-contract.md). Import that wrapper's `stdio` harness JSON in Harness, then select it in RED or BLUE. It is **not** sufficient to put a chat CLI path in the executable field: the wrapper must translate input, invoke the CLI using your own subscription login, validate and return only the requested JSON object, without mixing logs into stdout.

No account keys belong in the website, harness JSON, GitHub or the execution ledger. A wrapper may use its CLI's local authentication stores. The minimal stdio environment does not automatically pass all home/config variables; wrappers must resolve their own CLI configuration explicitly. Trusted custom code can access your files/network and incur costs; it is not OS-isolated or guaranteed to enforce internal call budgets. The included `app/examples/stdio_harness.py` intentionally abstains and is a protocol example, not a model implementation.

## Trust and privacy boundaries

- Only `127.0.0.1` is bound, never LAN addresses. Hosted pairing requires the fixed HTTPS origin. The process token stays on the loopback launcher and same-origin `/api/session` channel. The website's reconnect credential is a different, expiring, revocable value and is not accepted for launcher restart or session bootstrap. Cross-origin token bootstrap, wildcard CORS and arbitrary shell endpoints are not offered. The reconnect credential may be kept in the hosted page's `sessionStorage` for that tab so a refresh can call `GET /api/pair/status` only. It is not the process token and it is not written under `app/dist`.
- Browser trust is **origin-wide**: `https://shinick-han.github.io`, not only the `/falsify-workbench/` path. Only approve that origin if you trust every page on it. Disconnect revokes the reconnect credential. Stop the broker to end the process token. Do not post token screenshots or use an untrusted copied website.
- Paper extraction and records stay in your browser until you explicitly execute or export. Execution sends extracted text through your selected harness to its model provider. PDF export sends original bytes to your local companion. The public repo does not receive paper files, answer keys or experiment records.
- Local records remain origin-local localStorage. Local and hosted sites have separate local records. Full-ledger transfer uses explicit JSON backup/import; backups contain paper text and should stay private. The optional [invite-only team API](team-access.md) stores only selected uploads, not an automatic replacement or full sync of the local ledger.
- RED and BLUE are independent. BLUE receives its paper, not RED's answer key; custom harnesses may violate blindness if they share state. This app does not guarantee OS-level input-only isolation.
- The site is publicly accessible. Human review is not domain approval or scientific ground truth.

## Connection problems

Check that the companion is running with the exact hosted origin, the port matches, and local-network permission is allowed. A refresh rechecks status with the short-lived credential; it does not post a model job. If that credential is expired, revoked, or for another port, connect again. The manual process token is still forgotten on reload when you pasted it yourself. Browser policy may reject secure-web to HTTP-loopback connections. If click-pairing is unavailable, use the foreground companion and paste its token, the local workbench, or manual JSON exchange. Do not disable browser security or bind the broker to the LAN.

The pairing routes do not skip RED/BLUE consent, export admission, the busy/frozen lifecycle, or the rule that a foreign listener is left untouched. `scripts/test-posix-connection.sh` and `app/tests/test_pairing.py` cover replay, wrong origin, wrong proof, expiry, revocation, refresh, server restart, reconnect, port mismatch and user cancel without calling a model. `scripts/test-connection.ps1` remains a Windows dry-run (registry, protocol grammar, cancel and approval). It was not executed on the Linux cloud agent that added the POSIX handler.

Built-in CLI model access, another participant's OS/browser, and scientific performance require validation in that participant's environment. The existing private site and research records are not migrated automatically.
