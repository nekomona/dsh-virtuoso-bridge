# Script call performance roadmap

Phases 0 and 1 have landed and are measured. What remains is per-job work rather
than setup, so the leverage moved from "make a call cheap" to "make fewer, larger
calls". Numbers and the design are in
[script-call-performance.md](script-call-performance.md).

## Where things stand

| path | trivial | realistic (SKILL + shell + transfer) |
|---|---|---|
| worker, warm (Phase 1) | **12 ms** | 646 ms (body 645 ms) |
| worker, first job | 810 ms | 1673 ms |
| runner (fallback, one process per script) | 1262 ms | 2140 ms |

A warm call is now the job directory, one RPC round trip, the job run and the
artifact read: ~12 ms of fixed cost. Nothing in the previous fixed-cost table
(interpreter 0.36 s, import 0.21 s, client construction 0.54 s, plugin
bookkeeping 0.34 s) survives on the worker path.

## Phase 0 — done

`scripts/bench-script-call.mjs` (`npm run bench:script`) reproduces a plugin job
exactly — store-derived environment, job directory, `context.json`, the real
runner or worker — and reports wall medians/p25/p75 plus `envMs`, `importMs`,
`connectMs`, `bodyMs`, `tunnelReused`, `clientReused`, with the runner's sha256
for provenance.

Results:

* Two consecutive runner-path invocations agreed within ±10 % (trivial +5.2 %,
  realistic +7.3 %).
* Discarding warm-up runs is required: the first job after an idle period pays
  one-off bridge setup that later jobs inherit (1323 ms vs 1211 ms median). The
  harness does this by default (`--warmup`).
* A phase-clock bug (epoch seconds vs milliseconds) surfaced as
  `envMs ≈ −1.79e12`; fixed in the runner, and the harness still rejects
  implausible phases instead of printing them.
* `settleMs` is computed by the plugin, not written to `status.json`, so the
  harness prints `-` for it.
* Documented caveat: the stdout destination changes measured wall time by ~0.45 s
  per call on this platform. Compare like-for-like; console/pipe numbers agree
  with the plugin's own path.

## Phase 1 — done

`runtime/vb_script_exec.py` (shared job core) plus `runtime/vb_script_worker.py`
(one process per runtime + agent session, lazy single connect, per-job namespace
/ cwd / `sys.modules` isolation, `scriptWorkerMax` = 4 budget with LRU idle
reclaim, idle shutdown, fallback to a process per script on any worker problem).

Results:

* Trivial call 1262 ms → **12 ms**; realistic 2140 ms → **646 ms**.
* Job 1 connects (`connectSeconds` ≈ 0.5 s, `tunnelReused`); job 2+ report
  `connectSeconds: 0.0`, `clientReused: true`.
* Shell, `upload_file` and `download_file` succeed inside a warm worker — the
  lazy SFTP path survives client reuse.
* Census: exactly **one** SSH connection per worker, **no** per-worker local
  listener (they share the sidecar forward), and the counts return to baseline
  after teardown. Zero orphan processes or job directories.
* Limitation recorded: a job blocked inside a C call cannot be interrupted
  cooperatively; the plugin kills the worker as the backstop.

## Phase 2 — optional: trim the runner fallback (½ day, lower priority)

Adjusted downwards: on the worker path `probeVenv` runs once per worker spawn and
the remaining per-call JS work is already inside the 12 ms. Caching
`#ensureSshConfig` and `readSecret` now only matters for the process-per-script
fallback (no runtime, worker disabled, or budget exhausted). Do it only if the
fallback matters in practice; otherwise drop.

## Phase 3 — fewer, larger calls (1–2 days, the main lever)

A warm call is 12 ms, so round-trip count is now everything. Add an optional
`steps: [code, code, …]` to `virtuoso_bridge_script run`: one tool call, one
worker session, sequential exec, one combined result. A probe → generate → check
→ re-generate loop becomes one call instead of four, and the realistic body
(646 ms) stays inside a single call.

Acceptance: a 10-step batch costs one tool call and ≤ 0.2 s over the sum of its
bodies; the 115-call pattern that motivated this work collapses to under 20.

## Phase 4 — concurrency and `waitMs` (½ day, measure first)

* Resource side is now proven safe: four workers add exactly four SSH sessions
  and connect in parallel (per-worker `connect` ~530 ms, realistic first-job wall
  1733 ms). Concurrency does not risk the connection budget at the current
  budget of 4.
* `waitMs` (default 10 s) only bounds how long the tool waits for a job; with a
  12 ms warm call it no longer matters for short jobs. Lower it to 3 s only if
  long jobs returning their id sooner helps a real workflow.
* Decide on a parallel lane (2 workers) from the workload, not from speculation.

## Phase 5 — tests and docs (partly done)

`tests/script-worker.test.mjs` covers the protocol, isolation and crash handling
hermetically. Remaining: keep the performance doc's numbers updated with each
release, and add the worker to the release notes when it ships enabled.

## Not doing

* Pre-forked interpreter pools or an embedded interpreter: the worker already
  removes start/import cost.
* Shrinking the import graph: 0.21 s matters once per worker, not per call.
* Extra worker processes per session: one worker per (runtime, session) is the
  isolation boundary; more only adds connections.
