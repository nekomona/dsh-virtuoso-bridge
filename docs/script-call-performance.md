# Script call performance

How long a `virtuoso_bridge_script` call takes, what the runner does to keep it
short, and how to check for regressions.

## Current cost

Measured on an isolated, idle connection, wall time around the runner process:

| | cost |
|---|---|
| `virtuoso_bridge_script` run, trivial body | 1.34 s |
| same, realistic body (SKILL + shell + upload + download) | 2.86 s (body 1.56 s) |
| client setup inside the script (`connect()`) | 0.69–0.77 s |
| `probeVenv`, cached | ~0.005 s |
| projected per tool call in a real session | ~1.5 s |

Breakdown of the 1.34 s floor: `probeVenv` (cached, ~0) + interpreter start
0.36 s + `import virtuoso_bridge` 0.29 s + client construction 0.73 s.

## The reused-tunnel fast path

The runtime sidecar (`runtime/vb_sidecar.py`) connects once and keeps an SSH
tunnel with a local forward alive for the connection. A script process needs that
forward, not a second one.

`runtime/vb_script.py` `connect()` therefore:

1. Builds the client with `VirtuosoClient.from_env()`, which adopts the sidecar's
   running tunnel when the profile has one.
2. Finds the local port the client talks to (`_forwarded_port`) and checks that
   something accepts connections there (`_tunnel_forwards`).
3. Confirms the daemon with one cheap handshake (`verify_tunnel()`, a `1+1` eval,
   ~60 ms). Only if that answers is the expensive warm-up skipped.
4. Otherwise runs the original path unchanged: `warm_remote_session()` for remote
   connections, `ssh.warm()` for local ones.

`SSHClient.warm()` is the full startup chain — instance discovery, daemon token
provisioning, persistent shells, remote setup, daemon endpoint probe, instance
verification, state save. It is still correct, just redundant when the sidecar
tunnel is already up; the handshake in step 3 is what decides that safely.

Anything the script does beyond the daemon socket still works: `upload_file`,
`download_file` and `run_shell_command` bring up their SFTP/shell transport
lazily on first use.

Controls:

* `VB_SCRIPT_FULL_WARM=1` in the job environment restores the always-warm
  behaviour exactly, for debugging a suspected tunnel problem.
* `status.json` and `events.jsonl` record `sessionSetup`
  (`connectSeconds`, `tunnelReused`, `reusedTunnelPort`), visible through
  `virtuoso_bridge_script` action `"status"`. `tunnelReused: false` with a large
  `connectSeconds` means something is paying for a full warm-up.

`lib/setup.js` `probeVenv` caches its verdict for `PROBE_CACHE_MS` (5 min)
instead of 5 s, with a live `venvExists` cross-check so a deleted venv is still
noticed on the next call. `install`, `update` and `clear_cache` force a fresh
probe, and `invalidate()` drops the cache.

## Validation

Same runner code, same connection, same scripts; only the runner under test
differed. Wall time is measured around the child process, so it excludes the
plugin's own JS work.

| case | wall |
|---|---|
| trivial body, reused-tunnel fast path (×2) | 1.34 s, 1.32 s |
| trivial body, `VB_SCRIPT_FULL_WARM=1` (fallback control) | 7.56 s |
| realistic body | 2.86 s |
| `upload_file` + `download_file` as the first operations | 2.68 s, 249-byte round trip, `SUCCESS` |
| `run_shell_command` as the first operation | 1.35 s, `SUCCESS` |
| `execute_skill` as the first operation | 1.33 s, `SUCCESS` |

`npm test` (14 tests) and the privacy guards stay green.

## Remaining bottlenecks

The fixed cost is now process start (0.36 s), the package import (0.29 s) and one
client construction (0.2–0.7 s), plus ~0.18 s of plugin-side bookkeeping. The
plan for those — a persistent script worker, trimmed JS-side work, batched calls
and the concurrency question — is
[script-performance-roadmap.md](script-performance-roadmap.md).

## Re-measuring

1. Point a profile at an idle connection that no agent is using.
2. Run a script whose body is `result = 1` and compare tool call duration, or
   read `sessionSetup.connectSeconds` from
   `<cacheDir>/jobs/job_*/status.json`.
3. To separate plugin overhead from runner overhead, use the job directory
   timestamps: `script.py` mtime → `status.json` `startedAt` is the whole
   spawn-import-connect phase.
