#!/bin/bash
# Records the README demos from real runs inside a throwaway container, so paths
# are neutral and every number on screen is measured. Run through docker:
#
#   docker run --rm -v "$PWD:/app:ro" -v "$PWD/.demo:/out" -w /app node:22 bash scripts/demo/record.sh
#   python scripts/demo/render_gif.py .demo docs
set -euo pipefail

apt-get update -qq >/dev/null
apt-get install -y -qq chromium fonts-liberation >/dev/null 2>&1
mkdir -p /tmp/rec && (cd /tmp/rec && npm init -y >/dev/null && npm i puppeteer-core@23 --no-audit --no-fund --silent)
printf '#!/bin/sh\nexec node /app/bin/nm-manager.js "$@"\n' > /usr/local/bin/nm-manager
chmod +x /usr/local/bin/nm-manager

export HOME=/home/dev
P=$HOME/projects
install_project() {
  local dir=$P/$1; shift
  mkdir -p "$dir"
  (cd "$dir" && npm init -y >/dev/null && npm i "$@" --no-audit --no-fund --silent --ignore-scripts)
}
install_project web/shop next@15 react@18 react-dom@18
install_project web/blog next@15 react@18 react-dom@18
install_project web/admin vite@6 react@18 react-dom@18 typescript@5
install_project web/landing vite@6 react@18 react-dom@18 typescript@5
install_project video/intro remotion@4.0.300 @remotion/cli@4.0.300 react@18 react-dom@18
install_project video/promo remotion@4.0.300 @remotion/cli@4.0.300 react@18 react-dom@18
install_project tools/legacy vite@6 react@18 react-dom@18
mkdir -p "$P/tools/legacy/patches" && echo 'demo' > "$P/tools/legacy/patches/vite.patch"

export NM_MANAGER_CONFIG=$HOME/.config/nm-manager/config.json
FORCE_COLOR=1 node /app/scripts/demo/capture-terminal.mjs /out/terminal.json

# Back to the untouched state for the interface recording.
nm-manager undo "$P" --yes >/dev/null
nm-manager gc >/dev/null
rm -rf "$HOME/.nm-store" "$HOME/.config/nm-manager"

cp /app/scripts/demo/capture-ui.mjs /tmp/rec/
node /tmp/rec/capture-ui.mjs /out/ui
chmod -R a+rwX /out
