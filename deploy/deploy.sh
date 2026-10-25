#!/usr/bin/env bash
# Deploy the MassCompute coordinator to Fly.io (https://fly.io — free allowance).
# Prereqs: `brew install flyctl` (or winget install FlyCtl.FlyCtl), then `fly auth login`.
set -euo pipefail
cd "$(dirname "$0")"

APP=${MASSCOMPUTE_FLY_APP:-masscompute}

echo "==> Creating app (idempotent) + 1GB volume"
fly launch --name "$APP" --copy-config --nowrite-config --no-deploy 2>/dev/null || true
fly volumes create masscompute_data --size 1 --region iad 2>/dev/null || echo "    volume exists"

echo "==> Deploying"
fly deploy

echo "==> Live at: https://$APP.fly.dev"
echo "    Workers point at: wss://$APP.fly.dev"
