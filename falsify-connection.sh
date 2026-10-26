# Shared helpers for the macOS and Linux falsify:// handler.
# Source this file. It does not start a companion, write a key, or show a dialog.
# The macOS approval dialog is optional and is not a certification of macOS behavior.

falsify_fixed_origin() {
  printf '%s\n' 'https://shinick-han.github.io'
}

# Prints approve, cancel, ask, or refuse. An empty choice asks; it does not approve.
falsify_approval_decision() {
  origin=$1
  choice=${2-}
  if [ "$origin" != "$(falsify_fixed_origin)" ]; then
    printf '%s\n' refuse
    return 0
  fi
  case "$choice" in
    yes) printf '%s\n' approve ;;
    no) printf '%s\n' cancel ;;
    *) printf '%s\n' ask ;;
  esac
}

falsify_pairing_dir() {
  if [ -n "${FALSIFY_PAIRING_DIR:-}" ]; then
    printf '%s\n' "$FALSIFY_PAIRING_DIR"
    return 0
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support/falsify-workbench/pairing" ;;
    *) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/falsify-workbench/pairing" ;;
  esac
}

# Visible one-time approval. Fails closed when no native dialog is available.
# macOS uses osascript only when that binary exists. Linux cloud runs do not have it.
falsify_ask_visible() {
  if [ "$(uname -s)" = Darwin ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display dialog \"Allow $(falsify_fixed_origin) to receive a short-lived local reconnect credential? This does not run a model or reveal the server process token.\" buttons {\"No\", \"Yes\"} default button \"No\" with title \"Falsify local companion\"" >/dev/null
    return $?
  fi
  echo 'Visible approval is unavailable on this host. Use the manual token fallback. Nothing was approved.' >&2
  return 1
}

# Prints "port pairing" or "port pairing challenge state proof". pairing is 0 or 1.
falsify_parse_uri() {
  uri=$1
  if [ -z "$uri" ] || [ "${#uri}" -gt 184 ]; then
    return 1
  fi
  case $uri in
    *[[:space:]]*|*'#'*|*'%'|*'|'|*'<'*|*'('*) return 1 ;;
  esac
  local nonce='[A-Za-z0-9_-]{43}'
  if [[ $uri =~ ^falsify://connect/?\?port=([1-9][0-9]{3,4})\&challenge=(${nonce})\&state=(${nonce})\&proof=(${nonce})$ ]]; then
    local port=${BASH_REMATCH[1]}
    if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
      return 1
    fi
    printf '%s %s %s %s %s\n' "$port" 1 "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
    return 0
  fi
  if [[ $uri =~ ^falsify://connect/?\?port=([1-9][0-9]{3,4})$ ]]; then
    local port=${BASH_REMATCH[1]}
    if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
      return 1
    fi
    printf '%s %s\n' "$port" 0
    return 0
  fi
  return 1
}
