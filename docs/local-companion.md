# Connect your own CLI

The website is https://shinick-han.github.io/falsify-workbench/. It does not run a CLI on GitHub or use the author's account. Each participant starts their own companion, using their own CLI login and model subscription.

## Windows

1. Install Python 3.10+ and your preferred CLI. The built-in adapter requires a separately installed and logged-in Codex CLI with access to the configured `gpt-6.1-sol` model. The platform never asks for an API key.
2. Download this repository's source ZIP, extract it, and open PowerShell in the extracted folder. Read the launcher before executing it.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\start-companion.ps1`. This applies the execution policy only to this process; it does not modify your global policy. The launcher creates `.venv` in this project and installs the pinned Python dependencies from PyPI. It does not install a CLI or sign into an account.
4. Open the hosted website. In its CLI connection panel, enter the pairing token printed by the companion and connect. If the browser asks for local-network access, allow it only for this trusted site. Tokens live only for this broker process; keep them private.
5. In RED or BLUE, supply a paper and choose the desired harness. Pairing does not execute a model. Each execution still requires its own consent.

If port 7816 is occupied, launch with `-Port 7817` and set the website's port field to 7817. Never stop another user's program to free a port. For subsequent runs `-NoInstall` skips pip. `-NoPdf` skips installation of the optional PDF editor in a new environment; it does not uninstall an existing one. PDF import remains browser-local, but PDF modified-file export requires PyMuPDF. TXT export does not require it.

## macOS / Linux or manual Windows setup

From the extracted repository root:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r app/local/requirements.txt
.venv/bin/python app/local/server.py --web-origin https://shinick-han.github.io
```

Windows equivalent after creating a venv: `.venv\Scripts\python.exe ...`. Add `--port 7817` if needed. To use the entirely local website instead, omit `--web-origin` and open the printed `http://127.0.0.1:<port>/` address. Local-only mode has no remote origin permission.

## Other CLIs and custom harnesses

The built-in adapter invokes Codex. Other CLIs, including Claude Code, are not automatically discovered or a built-in one-click option in this release. They can be connected through a trusted wrapper that follows the JSON stdin/stdout protocol in [the harness contract](harness-contract.md). Import that wrapper's `stdio` harness JSON in Harness, then select it in RED or BLUE. It is **not** sufficient to put a chat CLI path in the executable field: the wrapper must translate input, invoke the CLI using your own subscription login, validate and return only the requested JSON object, without mixing logs into stdout.

No account keys belong in the website, harness JSON, GitHub or the execution ledger. A wrapper may use its CLI's local authentication stores. The minimal stdio environment does not automatically pass all home/config variables; wrappers must resolve their own CLI configuration explicitly. Trusted custom code can access your files/network and incur costs; it is not OS-isolated or guaranteed to enforce internal call budgets. The included `app/examples/stdio_harness.py` intentionally abstains and is a protocol example, not a model implementation.

## Trust and privacy boundaries

- Only `127.0.0.1` is bound, never LAN addresses. Hosted pairing requires an explicit HTTPS origin and a process-local bearer token. Cross-origin token bootstrap, wildcard CORS, arbitrary shell endpoints and browser-stored tokens are not offered.
- Browser trust is **origin-wide**: `https://shinick-han.github.io`, not only the `/falsify-workbench/` path. Only opt in if you trust the origin. Stop the broker to revoke its token; do not post token screenshots or use an untrusted copied website.
- Paper extraction and records stay in your browser until you explicitly execute or export. Execution sends extracted text through your selected harness to its model provider. PDF export sends original bytes to your local companion. The public repo does not receive paper files, answer keys or experiment records.
- Records are origin-local localStorage, not a shared database. Local and hosted sites have separate records. Move records only using explicit JSON backup/import; backups contain paper text and should stay private.
- RED and BLUE are independent. BLUE receives its paper, not RED's answer key; custom harnesses may violate blindness if they share state. This app does not guarantee OS-level input-only isolation.
- The site is publicly accessible. Human review is not domain approval or scientific ground truth.

## Connection problems

Check that the companion is running with the exact hosted origin, port matches, the current token is used, and local-network permission is allowed. Reloading the web page intentionally forgets the token; reconnect manually. Browser policy may reject secure-web to HTTP-loopback connections. If direct pairing is unavailable, use the local workbench or manual JSON exchange; do not disable browser security or bind the broker to the LAN.

Built-in CLI model access, another participant's OS/browser, and scientific performance require validation in that participant's environment. The existing private site and research records are not migrated automatically.
