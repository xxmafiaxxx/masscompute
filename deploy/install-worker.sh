#!/usr/bin/env bash
# MassCompute donor installer (macOS / Linux).
# Installs the worker as a global `masscompute` command — no repo clone, no sudo.
#
# Usage:
#   ./install-worker.sh <masscompute-worker-0.x.y.tgz>      # local tarball
#   ./install-worker.sh https://example.com/masscompute-worker-0.2.0.tgz
#
# After install:
#   masscompute doctor        <- check your GPU + grid reachability
#   masscompute               <- start donating (Ctrl+C to stop)
#   masscompute autostart     <- donate automatically at login (systemd user / LaunchAgent)

set -euo pipefail

PACKAGE="${1:-}"
if [ -z "$PACKAGE" ]; then
  echo "usage: $0 <masscompute-worker-tgz | https://…/masscompute-worker.tgz>" >&2
  exit 1
fi

command -v node >/dev/null 2>&1 || { echo "Node.js 22+ required: https://nodejs.org" >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Node.js 22+ required (found $(node -v))" >&2; exit 1; }

TMP=""
if [[ "$PACKAGE" =~ ^https?:// ]]; then
  TMP="$(mktemp /tmp/mc-worker-XXXXXX.tgz)"
  echo "downloading $PACKAGE"
  curl -fsSL "$PACKAGE" -o "$TMP"
  PACKAGE="$TMP"
fi
[ -f "$PACKAGE" ] || { echo "package not found: $PACKAGE" >&2; exit 1; }

echo "installing globally (npm install -g $PACKAGE)…"
npm install -g "$PACKAGE"
[ -n "$TMP" ] && rm -f "$TMP"

echo
echo "installed. checking your machine…"
masscompute doctor
echo
echo "next steps:"
echo "  masscompute               start donating now"
echo "  masscompute autostart     donate automatically at every login"
echo "  masscompute set name <yours>   appear on the leaderboard by name"
