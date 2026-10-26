#!/usr/bin/env bash
# Installs a per-user falsify:// handler for Linux (desktop entry) or macOS (handler files).
# It does not request administrator rights, create a login item, or suppress the browser prompt.
# Set FALSIFY_CONNECT_DRY_RUN=1 to print the plan. FALSIFY_CONNECT_HOME overrides the home directory.
# macOS Launch Services registration is not run here and is not a macOS certification.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
home=${FALSIFY_CONNECT_HOME:-$HOME}
os=${FALSIFY_CONNECT_OS:-$(uname -s)}
dry=${FALSIFY_CONNECT_DRY_RUN:-}
handler=$root/open-connection.sh

if [ "$os" = Darwin ]; then
  dest=$home/Library/Application\ Support/falsify-workbench
  echo "macOS handler directory: $dest"
  echo 'The visible approval dialog uses osascript when that command exists. This installer does not register the handler with Launch Services and is not a macOS certification.'
  if [ "$dry" = 1 ]; then
    echo "DRY-RUN install darwin handler=$handler"
    exit 0
  fi
  mkdir -p "$dest"
  chmod 700 "$dest"
  cp "$handler" "$dest/open-connection.sh"
  cp "$root/falsify-connection.sh" "$dest/falsify-connection.sh"
  chmod 700 "$dest/open-connection.sh" "$dest/falsify-connection.sh"
  cat > "$dest/handler.txt" << EOF
Handler: $dest/open-connection.sh
Fixed origin: https://shinick-han.github.io
Launch Services was not modified by this script.
EOF
  chmod 600 "$dest/handler.txt"
  echo 'Wrote the macOS handler files. Register falsify:// in Launch Services yourself if you want clicks to reach it. The browser still cannot tell whether that registration exists.'
  exit 0
fi

desktop_dir=$home/.local/share/applications
desktop=$desktop_dir/falsify-connect.desktop
echo "Linux handler: $desktop"
if [ "$dry" = 1 ]; then
  echo "DRY-RUN install linux desktop=$desktop exec=$handler"
  exit 0
fi
mkdir -p "$desktop_dir"
chmod 700 "$desktop_dir"
cat > "$desktop" << EOF
[Desktop Entry]
Type=Application
Name=Falsify Connect
Exec=$handler %u
NoDisplay=true
Terminal=false
MimeType=x-scheme-handler/falsify;
EOF
chmod 644 "$desktop"
mime=$desktop_dir/mimeapps.list
line='x-scheme-handler/falsify=falsify-connect.desktop'
if [ -f "$mime" ] && grep -Fqx "$line" "$mime"; then
  :
else
  touch "$mime"
  chmod 644 "$mime"
  if ! grep -q '^\[Default Applications\]' "$mime"; then
    printf '\n[Default Applications]\n' >> "$mime"
  fi
  printf '%s\n' "$line" >> "$mime"
fi
echo 'Installed the per-user falsify:// handler. The browser cannot detect it and will still ask before opening it. Manual start remains available.'
