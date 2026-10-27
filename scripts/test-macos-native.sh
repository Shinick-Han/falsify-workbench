#!/bin/bash
# Native, synthetic-only smoke test. Run from a clean committed checkout.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
[ "$(uname -s)" = Darwin ] || { echo 'This smoke test requires Darwin.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/falsify-native.XXXXXXXX")
trap 'rm -rf "$work"' EXIT
python3 -m venv "$work/venv"
"$work/venv/bin/python" -m pip install -r app/local/requirements.txt
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_document_red.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_blue_visual.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_macos_runtime.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_cli_selection.py -v
node --test scripts/packaging.spec.mjs scripts/packaging-macos.spec.mjs
node scripts/package-release.mjs --out-dir "$work/release"
"$work/venv/bin/python" - "$work/release" <<'PY'
import hashlib, json, pathlib, stat, subprocess, sys, zipfile
release = pathlib.Path(sys.argv[1])
receipt = json.loads((release / 'release-manifest.json').read_text())
archive = release / receipt['archive']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == receipt['sha256']
assert receipt['commit'] == subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
entries = subprocess.check_output(['git', 'ls-tree', '-r', '-z', 'HEAD']).split(b'\0')
tracked = {}
for entry in filter(None, entries):
    meta, name = entry.split(b'\t', 1)
    mode, kind, _ = meta.split()
    assert kind == b'blob'
    tracked[name.decode()] = int(mode, 8)
prefix = 'falsify-workbench-v' + receipt['version'] + '/'
with zipfile.ZipFile(archive) as z:
    files = {i.filename[len(prefix):]: i for i in z.infolist() if not i.is_dir() and i.filename.startswith(prefix)}
    assert set(files) == set(tracked), (set(tracked) - set(files), set(files) - set(tracked))
    for name, mode in tracked.items():
        assert files[name].create_system == 3, name
        assert stat.S_IMODE(files[name].external_attr >> 16) == stat.S_IMODE(mode), name
    for name in ('install-connection.sh', 'open-connection.sh', 'uninstall-connection.sh'):
        assert files[name].external_attr >> 16 & 0o111, name
print('Archive tracked paths and Unix modes verified; SHA-256 and commit match.')
PY
