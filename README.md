# Falsify Paper Workbench

Browser-local RED and BLUE scientific-document experiments, independent human review, and versioned user-defined harnesses. RED and BLUE may be used independently.

This repository contains only the application code. Private project notes, research papers, answer keys, meeting recordings and execution records are not included. The original private research repository remains private.

The hosted frontend is static. Files are parsed in your browser; saved runs and reviews remain in that browser's local storage. Explicit execution sends the supplied paper text through your own local CLI or selected trusted harness to its model provider. GitHub is not an execution backend or shared experiment database.

Use the [hosted platform](https://shinick-han.github.io/falsify-workbench/). Follow [local companion setup](docs/local-companion.md) to connect your own Codex CLI or Claude Code subscription login, or use manual JSON exchange. Windows users can run `start-companion.ps1` from an extracted source download, or once install the optional per-user `falsify://connect` click-to-launch link with `install-connection.ps1` (no administrator rights; `uninstall-connection.ps1` removes it). The pairing token is always pasted from the terminal, never sent in a link. No account credentials or API keys should be entered into a harness JSON or committed to this repository.

[Deployment architecture](docs/deployment.md) · [Harness protocol](docs/harness-contract.md)

## Third-party components

Browser parser license notices are retained in `app/dist/vendor/`. Python dependencies are installed by the user, not bundled. Optional PDF editing uses PyMuPDF, which is AGPL/commercial licensed; users must comply with the applicable license. No open-source license is granted for the original application code by this publication alone.

Model results and human reviews are not scientific gold, domain approval, or verified performance metrics. Custom harness code must be trusted: the companion is not an OS sandbox.
