# MassCompute

**A crowdsourced GPU grid for LLM inference.** Volunteers donate idle GPU time
from their PCs; the grid serves one free, public, OpenAI-compatible chat API.

```
[public user] ──HTTPS/SSE──> [coordinator on Fly.io]
                                │ routes by model · load · reputation
        ........ WSS (donor-initiated; no inbound ports) ........
          │                        │
   [worker: tray app]        [worker: tray app] ...
     spawns llama.cpp llama-server (127.0.0.1, pinned GGUF, sha256-verified)
     gates: idle timer · GPU busy · battery · schedule · manual pause
```

## Layout

| Path | What it is |
| --- | --- |
| `packages/protocol` | Wire protocol (v1) + pinned model catalog (HF revision + sha256 per shard) |
| `apps/coordinator` | Fastify hub: OpenAI-compatible API, SSE relay, node registry, scheduler, reputation + probe verification, keys/quotas, leaderboard, serves the web dashboard |
| `apps/worker` | Electron tray app (donor): hardware probe, model manager, llama.cpp supervisor, WS client, idle gates. `node dist/core.mjs --dev` runs headless |
| `apps/web` | The public site/dashboard (static; served by the coordinator) |
| `deploy/` | Dockerfile + fly.toml + deploy script |

## Deploy the coordinator (public address)

```bash
# once: install flyctl + log in
fly auth login
cd deploy
./deploy.sh          # → https://masscompute.fly.dev
```

Workers then point at `wss://masscompute.fly.dev` (default already).

## Run a donor worker (dev)

```bash
cd apps/worker
npm run build:core
MASSCOMPUTE_COORDINATOR=ws://localhost:8091 MASSCOMPUTE_MODEL=smollm2-135m-q8 \
  node dist/core.mjs --dev
```

## Install a donor (spare GPU → grid)

The donor module is one npm package with a single command. No clone, no
build, no admin rights; Node 22+ is the only requirement.

```bash
# from a released tarball (see deploy/install-worker.ps1 / .sh for one-liners)
npm install -g masscompute-worker-0.2.0.tgz

masscompute doctor        # checks your GPUs, engine, and grid reachability
masscompute               # start donating (Ctrl+C stops)
masscompute autostart     # donate automatically at every login (HKCU Run /
                          #   systemd --user / LaunchAgent — no admin needed)
masscompute status        # what a running donor is doing
masscompute set name raul-desktop    # appear on the leaderboard by name
masscompute set schedule 22:00-07:00 # donate only in that window
masscompute set slots 4   # concurrent jobs offered to the grid
```

Build the tarball from source: `cd apps/worker && npm run pack`.
The tray app (Electron, same engine underneath): `cd apps/worker && npm run app`.

Donor behavior is gated so it never fights you for the machine: manual
pause, idle threshold, GPU-busy detection, battery, and a time window —
see `masscompute set --help` values above; models are sha256-pinned before
anything executes.

Config persists in `%APPDATA%/masscompute/` (win) /
`~/.config/masscompute/` (linux) / `~/Library/Application Support/masscompute`
(mac). `MASSCOMPUTE_MODEL` pins a tier; `auto` picks the biggest that fits
your VRAM.

## Use the API

```bash
curl https://YOUR_HOST/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-3b-q4km","messages":[{"role":"user","content":"hi"}]}'
```

- `POST /keys` — free API key (250k completion tokens/day)
- `POST /keys/revoke` — kill a key you hold: `{"key":"mc_…"}`
- keyless — 4k tokens/day per IP
- `GET /v1/models` · `GET /stats` · `GET /leaderboard` — live grid state

## Trust model (v1)

- Donors only run pinned open-weight GGUFs through official llama.cpp
  binaries; worker verifies sha256 after download. No arbitrary code.
- The coordinator silently re-runs a sample of completions as temp-0
  probes against trusted reference nodes (majority comparison, ≥2 refs).
  Mismatches crater a node's reputation; below 0.35 the node is
  quarantined and routed no traffic. New nodes start at 0.65 (probe-hard).
- Leaderboard counts tokens from reputable nodes only.

## Honest constraints

- Prompt content transits donor machines — the API is for non-sensitive use.
- A node serves only models that fit its VRAM (cross-node sharding is v2).
- Verification with <2 trusted references is honestly "unverifiable";
  sybil-resistant proofs are v2.
- Capacity is whatever volunteers donate. Quotas keep it fair, not fast.

## Verify (what we ran)

- `apps/coordinator`: 34/34 tests — unit (reputation, scheduler, verify,
  rate-limit, catalog pins) + integration (real server, fake workers over
  real WebSockets: routing, SSE, quotas, retry, cancel, quarantine).
- Live E2E on Windows/AMD: worker (Vulkan llama.cpp b11057 + SmolLM2-135M
  Q8, hash-verified) → local coordinator → streamed completions, SSE shape,
  leaderboard persistence, auto-reconnect.
