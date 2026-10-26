#!/usr/bin/env bash
# Offline tests for the POSIX falsify:// handler. No model calls, no macOS GUI, no real browser.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/falsify-connection.sh"
fail=0
ok=0
check() {
  ok=$((ok + 1))
  if [ "$2" = 1 ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    fail=$((fail + 1))
  fi
}
nonce_a=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
nonce_b=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
nonce_c=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
pair="falsify://connect?port=7816&challenge=${nonce_a}&state=${nonce_b}&proof=${nonce_c}"
parsed=$(falsify_parse_uri "$pair")
check 'pairing uri parses' "$([ "$parsed" = "7816 1 $nonce_a $nonce_b $nonce_c" ] && echo 1 || echo 0)"
parsed=$(falsify_parse_uri 'falsify://connect/?port=65535')
check 'root slash port only' "$([ "$parsed" = '65535 0' ] && echo 1 || echo 0)"
if falsify_parse_uri 'falsify://connect?port=7816&cmd=calc' >/dev/null 2>&1; then check 'reject command' 0; else check 'reject command' 1; fi
if falsify_parse_uri "falsify://connect?port=7816&token=abc" >/dev/null 2>&1; then check 'reject token' 0; else check 'reject token' 1; fi
if falsify_parse_uri 'falsify://connect?port=1023' >/dev/null 2>&1; then check 'reject low port' 0; else check 'reject low port' 1; fi
check 'approval ask' "$([ "$(falsify_approval_decision "$(falsify_fixed_origin)" '')" = ask ] && echo 1 || echo 0)"
check 'approval cancel' "$([ "$(falsify_approval_decision "$(falsify_fixed_origin)" no)" = cancel ] && echo 1 || echo 0)"
check 'approval yes' "$([ "$(falsify_approval_decision "$(falsify_fixed_origin)" yes)" = approve ] && echo 1 || echo 0)"
check 'approval other origin' "$([ "$(falsify_approval_decision 'https://evil.example' yes)" = refuse ] && echo 1 || echo 0)"

out=$(FALSIFY_CONNECT_DRY_RUN=1 FALSIFY_CONNECT_APPROVAL=no "$root/open-connection.sh" "$pair" || true)
check 'cancel dry-run' "$(printf '%s' "$out" | grep -q 'DRY-RUN pairing cancelled port=7816' && ! printf '%s' "$out" | grep -q "$nonce_a" && echo 1 || echo 0)"
out=$(FALSIFY_CONNECT_DRY_RUN=1 FALSIFY_CONNECT_APPROVAL=yes "$root/open-connection.sh" "$pair")
check 'approve dry-run hides nonces' "$(printf '%s' "$out" | grep -q 'DRY-RUN start-companion port=7816 pairing=1' && ! printf '%s' "$out" | grep -q "$nonce_a" && echo 1 || echo 0)"
out=$(FALSIFY_CONNECT_DRY_RUN=1 "$root/open-connection.sh" 'falsify://connect?port=7817')
check 'port-only dry-run' "$(printf '%s' "$out" | grep -q 'DRY-RUN start-companion port=7817' && echo 1 || echo 0)"
if FALSIFY_CONNECT_DRY_RUN=1 "$root/open-connection.sh" 'falsify://connect?port=7816&password=x' >/dev/null 2>&1; then
  check 'open rejects password' 0
else
  check 'open rejects password' 1
fi

home=$(mktemp -d)
FALSIFY_CONNECT_HOME="$home" FALSIFY_CONNECT_DRY_RUN=1 "$root/install-connection.sh" | grep -q 'DRY-RUN install linux'
FALSIFY_CONNECT_HOME="$home" "$root/install-connection.sh" >/dev/null
mode=$(stat -c '%a' "$home/.local/share/applications")
check 'applications dir is private' "$([ "$mode" = 700 ] && echo 1 || echo 0)"
grep -q "Exec=$root/open-connection.sh %u" "$home/.local/share/applications/falsify-connect.desktop"
# A foreign handler is not removed.
foreign=$home/.local/share/applications/falsify-connect.desktop
printf 'Exec=/other/open-connection.sh %%u\n' > "$foreign"
if FALSIFY_CONNECT_HOME="$home" "$root/uninstall-connection.sh" >/dev/null 2>&1; then
  check 'uninstall refuses foreign handler' 0
else
  check 'uninstall refuses foreign handler' 1
fi
FALSIFY_CONNECT_HOME="$home" "$root/install-connection.sh" >/dev/null
FALSIFY_CONNECT_HOME="$home" "$root/uninstall-connection.sh" >/dev/null
if [ -f "$home/.local/share/applications/falsify-connect.desktop" ]; then
  check 'uninstall removes own handler' 0
else
  check 'uninstall removes own handler' 1
fi
out=$(FALSIFY_CONNECT_OS=Darwin FALSIFY_CONNECT_DRY_RUN=1 FALSIFY_CONNECT_HOME="$home" "$root/install-connection.sh")
check 'darwin dry-run is not certification' "$(printf '%s' "$out" | grep -q 'not a macOS certification' && printf '%s' "$out" | grep -q 'DRY-RUN install darwin' && echo 1 || echo 0)"
rm -rf "$home"

python3 - << PY
import pathlib, sys
sys.path.insert(0, str(pathlib.Path("$root") / "app" / "local"))
import pairing
uri = "$pair"
parsed = pairing.parse_connect_uri(uri)
assert parsed["port"] == 7816 and parsed["pairing"] and parsed["challenge"] == "$nonce_a"
try:
    pairing.parse_connect_uri("falsify://connect?port=7816&cmd=calc")
    raise SystemExit(1)
except pairing.PairingError:
    pass
print("python parser agrees")
PY
check 'python parser agrees' 1

echo "$ok checks, $fail failed"
[ "$fail" -eq 0 ]
