# Script call performance

How long a `virtuoso_bridge_script` call takes, which code produces that cost, and
how to check for regressions.

Two execution paths exist:

* **worker** — one process per (runtime, agent session) that keeps its client
  warm across jobs. Default whenever a runtime is running.
* **runner** — one process per script. The fallback for scripts without a runtime,
  and the reference point the worker is measured against.

## Current cost

Measured on the test-bed connection (Paramiko, remote daemon already up), 5 jobs,
console-style output (see [measurement caveats](#measurement-caveats)):

| path | body | per call | connect | body |
|---|---|---|---|---|
| runner | trivial | 1262 ms | 558 ms | 0 |
| runner | realistic (SKILL + shell + upload + download) | 2140 ms | 540 ms | 876 ms |
| worker, first job | trivial | 810 ms | 517 ms | 0 |
| **worker, warm** | **trivial** | **12 ms** | 0.0 ms | 0 |
| worker, first job | realistic | 1673 ms | 503 ms | 893 ms |
| **worker, warm** | **realistic** | **646 ms** | 0.0 ms | 645 ms |

The runner's ~1.26 s fixed cost is interpreter start (0.36 s), package import
(0.21 s), client construction (0.54 s) and ~0.34 s of plugin-side bookkeeping. The
worker pays those once per process, so a warm call is the job directory, one RPC
round trip and the body — **12 ms** for a trivial script.

A realistic body is dominated by its own work: four bridge round trips plus a
file transfer (~645 ms).

Measured end to end through the plugin manager and worker on the slowest path in
the profile (Paramiko plus a jump host): first call of a session 1417 ms
(spawn → ready → import → connect ≈ 1.25 s of it), warm call 18 ms, warm realistic
call 1613 ms.

## Where it lives

| file | role |
|---|---|
| `runtime/vb_script_exec.py` | `JobRunner`: the single job core — `run()`, `connect()`, `preload_client()`, `session_setup()`, `finalize_interrupted()`, plus `interrupt_thread()`, `snapshot_import_state()` and `prune_job_modules()`. |
| `runtime/vb_script_worker.py` | `Worker`: the long-lived process — `run_job()`, `status()`, `cancel_job()`, and the request loop implementing the JSON protocol. |
| `runtime/vb_script.py` | Thin CLI over `JobRunner` for the per-script path. |
| `lib/manager.js` | Worker registry and routing: `#workerKey`, `workerLimit`, `workerEvictIdleMs`, `#acquireWorker`, `#startWorker`, `#withRuntimeLock`, `workerDisabledReason`, `#runJobInWorker` / `#runJobInProcess`, `#settleJobFromArtifacts`, `#disposeWorker`, `#armWorkerIdle`, `stopRuntimeWorkers`. |
| `lib/sidecar.js` | The newline-delimited JSON transport the worker is spawned with (unchanged class, reused). |
| `lib/store.js` | Settings: `scriptWorker`, `scriptWorkerIdleMs`, `scriptWorkerMax`, `scriptWorkerEvictIdleMs`. |
| `lib/tools.js` | Tool descriptions, the "fewer, larger calls" prompt hint, and the `waitMs` default. |
| `scripts/bench-script-call.mjs` | `npm run bench:script` — measures both paths and prints phases. |
| `tests/script-worker.test.mjs`, `tests/store-settings.test.mjs`, `tests/fixtures/virtuoso_bridge/` | Hermetic coverage of the protocol, isolation, crash handling and the settings. |

## The reused-tunnel fast path

`JobRunner.connect()` implements it:

1. `VirtuosoClient.from_env()` adopts the profile's running tunnel.
2. `_forwarded_port()` / `_tunnel_forwards()` check that the forward answers.
3. One cheap handshake (`verify_tunnel()`, a `1+1` eval, ~60 ms) is the evidence
   that the daemon behind it is the one we want; only then is the full warm-up
   skipped.
4. Otherwise the original path runs unchanged: `warm_remote_session()` for remote
   connections, `ssh.warm()` for local ones.

`SSHClient.warm()` still exists and is still correct — instance discovery, daemon
token, persistent shells, remote setup, endpoint probe, instance verification. It
is simply redundant once the sidecar tunnel is up.

Transfers and shells still work: `upload_file`, `download_file` and
`run_shell_command` bring up their SFTP/shell transport lazily on first use, and a
worker keeps that transport for later jobs.

`VB_SCRIPT_FULL_WARM=1` restores the always-warm behaviour for debugging.

## The script worker

`runtime/vb_script_worker.py` runs jobs in-process behind a newline-delimited JSON
protocol (`lib/sidecar.js` speaks the same shape):

* **One process per (runtime, agent session).** Different sessions never share a
  worker, so one agent's namespace, cwd or client can never leak into another's.
* **Budget `scriptWorkerMax` = 4 workers per runtime.** See
  [more sessions than the worker budget](#more-sessions-than-the-worker-budget).
* **Lazy single connect.** The first job connects and the client is retained.
  Later jobs report `connectSeconds: 0.0`, `tunnelReused: true`,
  `clientReused: true`, and their `connect()` returns the same client.
* **Same artifacts as the runner.** `status.json`, `result.json`, `error.json`,
  `events.jsonl`, `emit()`, `SystemExit` handling and the script namespace all
  come from the shared core `runtime/vb_script_exec.py`.
* **Per-job isolation.** Fresh namespace, `os.chdir` to the job workdir with the
  previous cwd restored, stdout/stderr captured per job, and modules imported from
  the job workdir are pruned afterwards so a stale `import gen, emit, main` cannot
  leak into the next job.
* **Protocol.** `ping` / `status` / `run` / `cancel` / `shutdown`; jobs run one at
  a time, a second `run` while busy is refused with `kind: "busy"`, and the loop
  stays responsive so `cancel` and `status` are answered during a job.
* **Fallback.** No runtime, `settings.scriptWorker` false,
  `VB_SCRIPT_DISABLE_WORKER=1`, or a worker that fails to spawn — the plugin logs a
  warning and runs the job through the process-per-script path. A worker problem
  never surfaces as a tool failure.
* **Lifecycle.** Idle workers stop after `scriptWorkerIdleMs` (10 min) and all
  workers stop with the runtime.

Known limitation: cancel and timeout are cooperative while user code yields, but a
job blocked inside a C call is not interruptible; the plugin kills the worker as
the backstop and the next job gets a fresh one. A worker killed mid-job leaves
`status.json` at `running`; the plugin writes the terminal failure.

## What the current code guarantees

* **Artifact parity.** A worker job produces the same `status.json`,
  `result.json`, `error.json`, `events.jsonl` and script namespace as the runner
  (`tests/script-worker.test.mjs` compares them case by case).
* **One connect per worker.** Three autoConnect jobs produce exactly one
  `from_env` call; later jobs report `clientReused`.
* **Isolation.** A fresh namespace and restored cwd per job, workdir modules
  pruned between jobs, and separate processes (therefore separate state) per
  session.
* **A failing connect does not fail the job.** `autoConnect` errors are reported
  as an event and the script runs without `client`.
* **Cancellation and timeout** answer the request and commit
  `cancelled`/`timeout` artifacts within a 0.6 s grace, then the job becomes
  interruptible at the next bytecode boundary.
* **Two consecutive runner-path invocations** agree within ±10 %; the harness
  discards one warm-up job per body because the first job after idle pays one-off
  bridge setup.
* **Tests.** `npm test` covers the worker protocol, isolation, crash handling,
  connect-once and the worker settings, hermetically.

## Shared-resource census

Test-bed connection, sampling established TCP sessions to `:22` while each stage
was held (local, controlled measurement — one sample per stage).

A worker that only talks to the daemon costs **no SSH connection at all**: six
concurrent workers stayed at the baseline two sessions, and every job (12/12)
succeeded with warm calls flat at 11–16 ms from one worker to six.

| stage | established `:22` | local listeners on the daemon port |
|---|---|---|
| before | 2 | 2 |
| 1–6 workers, daemon-only work | 2 | 2 |
| 4 workers, transfer-bearing (`upload`/`download`/shell) | 6 | 2 |
| 5 workers, transfer-bearing | 7 | 2 |
| 6 workers, transfer-bearing | 8 | 2 |
| after teardown | 2 | 2 |

A worker opens **one** SSH connection the first time a job needs shell or SFTP,
and that connection is reused for the rest of its life. No worker opens its own
local listener — they reuse the sidecar's forward, so the daemon port count never
moves. Zero leftover worker processes and zero leftover job directories after
every stage.

Remote-side corroboration (`ss -tn`, `ss -tln` through the plugin API) showed
exactly 1 daemon listener with six workers. Absolute remote session counts include
other logins on the shared server and drain asynchronously, so they are reported
but not attributed; the local per-stage samples are the controlled evidence.

`/etc/ssh/sshd_config` is not readable by this account (`Permission denied`), so
`MaxSessions` / `MaxStartups` are unverified. Assumption: sshd defaults
(`MaxSessions 10`, `MaxStartups 10:30:100`). Worst case per runtime is one sidecar
tunnel plus the four-worker budget plus up to `maxScripts` (4) fallback
processes — 9 sessions, still under the default burst of 10 simultaneous
handshakes. In practice the measured maximum was 8.

## More sessions than the worker budget

`scriptWorkerMax` (default 4) bounds live workers per runtime. Above it:

* a session whose worker exists keeps working normally — workers are keyed
  `(runtime, session)` and are never shared or evicted while busy;
* a newcomer takes the slot of a worker that has been **idle for at least
  `scriptWorkerEvictIdleMs` (default 60 s)**, then starts its own worker;
* if every worker is busy, or none has been idle that long, the newcomer runs a
  **process per script** for that call, logs a warning, and tries the worker again
  on its next call.

The idle threshold stops thrash: reclaiming a worker that was used seconds ago
would make two sessions take turns evicting each other's warm client, and every
eviction costs a full client construction. Measured with four warm workers held
plus two fallback sessions running concurrently: all jobs succeeded, no daemon
contention (warm calls stayed at 12–27 ms), connections bounded at baseline + 2.
The only cost to the excess session is that single slow call — about 2.1 s instead
of 12 ms.

Acquisition is serialised per runtime (`#withRuntimeLock`), so two sessions
arriving together cannot both judge the budget full, both evict the same idle
worker and both start a replacement — which would exceed `scriptWorkerMax`.

## `waitMs`

The script tool returns as soon as the job settles, or after `waitMs` with a job
id it can poll — the budget decides *when the answer arrives*, never whether the
job runs. The default is **5000 ms**.

Measured on the worst path in the profile (Paramiko plus a jump host):

| case | wall |
|---|---|
| warm worker, trivial body | 11 ms |
| warm worker, realistic body (SKILL + shell + upload + download) | 1137 ms |
| fresh worker + realistic body, end to end | **2892 ms** |
| of which worker acquisition (spawn → ready → import → connect) | ~1.25 s |

The worst realistic inline call uses 58 % of the budget. Body ceilings: ≈4.98 s on
a warm worker, ≈3.6 s for a fallback process run (which pays ~1.4 s fixed cost
first). Jobs above the ceiling are not lost: at the 5 s mark their `status.json`
is `running`, the tool returns the job id, and they finish normally. Measured on
the merged path: a 4.5 s body returned inline at 4519 ms, and a 5.5 s body
returned its job id at 5017 ms and then reached `succeeded`.

## Fewer, larger calls

The tool description and the system prompt say it directly: fold the probes, edits
and checks you need into one script body and print what you measured, instead of
issuing many small calls. With a warm worker a call costs ~12 ms of setup, so the
remaining price of a small call is the model round trip, not the bridge.

## Measurement caveats

* **Stdout destination changes the measured wall time.** An identical runner on an
  identical connection measured ~1210 ms per call with output going to a console or
  PowerShell pipe, and ~735 ms when redirected to a file. Within one style results
  are reproducible (≤10 %); the level is not. Console/pipe numbers agree with the
  plugin's own path (ready 1.08–1.12 s measured through the plugin), so quote those
  and never mix styles in one comparison.
* **Phases.** `envMs` is the gap between the plugin starting a job and the runner
  receiving it; `importMs` is the package import. In worker mode both are one-shot
  costs of the worker process, not per-job costs — that is why a warm job shows an
  `importMs` from the worker's first job and still takes 12 ms.
* `settleMs` is computed by the plugin, not reported to the runner's `status.json`,
  so the benchmark prints `-` for it.

## Remaining bottlenecks

What is left is per-job work, not setup: ~12 ms of fixed cost plus whatever the
script does. The largest remaining lever is therefore the number of tool calls a
session makes, which the agent controls by folding work into one script body (see
[fewer, larger calls](#fewer-larger-calls)); there is no plugin-side batching API
by design. The roadmap is [script-performance-roadmap.md](script-performance-roadmap.md).

## Re-measuring

```bash
# runner path, 5 runs per body, discarding one warm-up run per body
npm run bench:script -- --connection NAME --runs 5

# worker path: 3 jobs in one worker (job#1 connects, job#2+ reuse the client)
npm run bench:script -- --connection NAME --mode worker --runs 3

# worker path, 4 workers on distinct sessions, hold them for a census window
npm run bench:script -- --connection NAME --mode worker --workers 4 --runs 1 --hold-ms 30000

# fail when the warm trivial median exceeds 300 ms
npm run bench:script -- --connection NAME --mode worker --threshold 300
```

Use an idle connection that no agent is using. `--json` gives the per-run rows and
medians; the harness prints the runner/worker file plus its sha256 so a number can
be traced to the bytes that produced it.
