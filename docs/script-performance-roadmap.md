# Script call performance roadmap

What is left after the worker: per-job work rather than setup, so the leverage is
"make fewer, larger calls" instead of "make a call cheap". Measurements and the
current design are in [script-call-performance.md](script-call-performance.md).

## Where things stand

| path | trivial | realistic (SKILL + shell + transfer) |
|---|---|---|
| worker, warm | **12 ms** | 646 ms (body 645 ms) |
| worker, first job | 810 ms | 1673 ms |
| runner (fallback, one process per script) | 1262 ms | 2140 ms |

A warm call is the job directory, one RPC round trip, the job run and the artifact
read: ~12 ms of fixed cost. Interpreter start, package import, client construction
and plugin bookkeeping are paid once per worker process.

## Remaining work

1. **Trim the fallback path** (optional, ½ day, lower priority). The process-per-
   script path still pays probe, spawn, import, client construction and settle per
   call — about 1.26 s. It only runs for scripts without a runtime, a disabled
   worker, a worker that fails to start, a busy worker above the budget, or
   `VB_SCRIPT_DISABLE_WORKER=1`. Caching `#ensureSshConfig` and the per-connection
   credential read, and writing the job files in one batch, would take ~0.2 s off
   it. Worth doing only if a real workflow depends on that path.
2. **Keep the numbers honest.** Re-run `npm run bench:script` on an idle connection
   when the runner, the worker protocol or the settings change, and update the
   tables in [script-call-performance.md](script-call-performance.md).
3. **Watch the budget in real use.** `scriptWorkerMax` (4) and
   `scriptWorkerEvictIdleMs` (60 s) are deliberate; revisit them only with measured
   evidence from a session mix that differs from the one measured (4 warm workers
   plus fallback sessions, ~2.1 s for the excess session).

## Not doing

* A batched `steps: [...]` scripting API: the tool description and the system
  prompt ask the agent to fold work into one script body instead.
* Pre-forked interpreter pools or an embedded interpreter: the worker already
  removes start/import cost.
* Lowering `waitMs` below 5 s: the worst realistic inline call on the slowest path
  measured 2892 ms (58 % of the budget), and a fresh worker plus a realistic body
  would start bouncing on that path.
