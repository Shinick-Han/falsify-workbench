#!/usr/bin/env bash
# Removes only this checkout's per-user falsify:// handler. A handler that points elsewhere is left alone.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
home=${FALSIFY_CONNECT_HOME:-$HOME}
os=${FALSIFY_CONNECT_OS:-$(uname -s)}
dry=${FALSIFY_CONNECT_DRY_RUN:-}
handler=$root/open-connection.sh

if [ "$os" = Darwin ]; then
  dest=$home/Library/Application\ Support/falsify-workbench
  echo "macOS handler directory: $dest"
  if [ "$dry" = 1 ]; then
    echo "DRY-RUN uninstall darwin dest=$dest"
    exit 0
  fi
  if [ ! -d "$dest" ]; then
    echo 'No macOS handler directory from this installer.'
    exit 0
  fi
  if [ -f "$dest/handler.txt" ] && ! grep -F "$handler" "$dest/handler.txt" >/dev/null 2>&1 && ! grep -F "$dest/open-connection.sh" "$dest/handler.txt" >/dev/null 2>&1; then
    echo 'Refused: the macOS handler directory is not this installer.' >&2
    exit 1
  fi
  rm -f "$dest/open-connection.sh" "$dest/falsify-connection.sh" "$dest/handler.txt"
  rmdir "$dest" 2>/dev/null || true
  echo 'Removed the macOS handler files written by this installer. Launch Services was not modified.'
  exit 0
fi

desktop=$home/.local/share/applications/falsify-connect.desktop
mime=$home/.local/share/applications/mimeapps.list
if [ ! -f "$desktop" ]; then
  echo 'No per-user falsify:// desktop handler from this installer.'
  exit 0
fi
exec_line=$(grep -E '^Exec=' "$desktop" || true)
case $exec_line in
  "Exec=$handler %u") ;;
  *) echo 'Refused: the desktop handler is not this checkout.' >&2; exit 1 ;;
esac
if [ "$dry" = 1 ]; then
  echo "DRY-RUN uninstall linux desktop=$desktop"
  exit 0
fi
rm -f "$desktop"
if [ -f "$mime" ]; then
  grep -Fvx 'x-scheme-handler/falsify=falsify-connect.desktop' "$mime" > "$mime.tmp" || true
  mv "$mime.tmp" "$mime"
  chmod 644 "$mime"
fi
echo 'Removed the per-user falsify:// handler. The project folder and its pairing key were not deleted.'
