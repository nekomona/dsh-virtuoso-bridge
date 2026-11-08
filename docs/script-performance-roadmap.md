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

## Phase 3 — done as guidance, not as an API change

A warm call is 12 ms, so round-trip count is now everything. **Decision: do not
add a `steps: [...]` parameter.** The scripting API stays as it is; instead the
tool description and the system prompt tell the agent to fold its probes, edits
and checks into one script body and print everything it measured. The agent, not
the plugin, decides how to merge requests into a large script call — which also
keeps `virtuoso_bridge_script` matching the documented contract.

## Phase 4 — done: `waitMs` = 5000 ms, concurrency left alone

* `waitMs` default lowered from 10 000 to 5000 ms. Measured on the worst path in
  the profile (Paramiko + jump host): worst realistic inline call 2892 ms (58 % of
  the budget), body ceilings ≈4.98 s warm / ≈3.6 s fallback, and jobs above the
  ceiling bounce to a job id and still finish. 3000 ms would bounce the
  fresh-worker realistic case; 10 000 ms only holds long jobs longer.
* Concurrency: no parallel lane was added. Measured that one to six concurrent
  workers keep warm calls flat at 11–16 ms, that daemon-only workers cost no SSH
  connection and transfer-bearing workers cost exactly one each, and that a full
  worker budget degrades a newcomer to a ~2.1 s process-per-script call with a
  warning instead of evicting busy or recently warm workers. The budget is
  serialised per runtime so two sessions cannot overshoot `scriptWorkerMax`.

## Phase 5 — done

`tests/script-worker.test.mjs` covers the protocol, isolation, crash handling,
cancel/timeout and connect-once hermetically; `tests/store-settings.test.mjs`
covers the worker settings defaults, clamping and `configure`. Both performance
docs carry the measured numbers. Keep the tables updated with each release and
mention the worker in the release notes when it ships enabled.

## Not doing

* A batched `steps: [...]` scripting API: the agent merges work into one script
  body from the tool prompt instead (Phase 3).
* Pre-forked interpreter pools or an embedded interpreter: the worker already
  removes start/import cost.
* Shrinking the import graph: 0.21 s matters once per worker, not per call.
* Extra worker processes per session: one worker per (runtime, session) is the
  isolation boundary; more only adds connections.
