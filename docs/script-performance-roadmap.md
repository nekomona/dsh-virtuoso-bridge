# Script call performance roadmap

The reused-tunnel fix landed in `4fcee39`: a script call no longer re-runs the
bridge's full remote warm-up. This plan covers what is left. Current numbers and
the fast-path design are in [script-call-performance.md](script-call-performance.md).

## Where the remaining ~0.9 s goes

Projected per call after the plugin reload picks up the cached `probeVenv`
(measured pieces from the test-bed connection; the first three rows are still a
fresh process per call):

| item | cost | addressed by |
|---|---|---|
| interpreter start | 0.36 s | Phase 1 |
| `import virtuoso_bridge` | 0.29 s | Phase 1 |
| client construction + handshake | 0.20 s (direct) – 0.73 s (jump host) | Phase 1 |
| JS pre: `probeVenv`, SSH config write, credential read, job files | ~0.04 s | Phase 2 |
| post: result/events read, dashboard emits | ~0.14 s | Phase 1/2 |
| script body | workload | Phase 3 |

Target: **≤ 0.15 s fixed cost per call**, from ~1.7 s measured today.

Anything below that only matters through *fewer and larger* calls, because model
time dominates a long session (steps averaged ~32 s).

## Phase 0 — instrument and gate (½ day)

Without this the rest cannot be proven.

* Extend `sessionSetup` with a `phase` map (`jsPre`, `interpreter`, `import`,
  `connect`, `body`, `settle`). The runner already reports `connectSeconds`; add
  the rest so a regression is attributable without reading job-directory
  timestamps.
* `scripts/bench-script-call.mjs`: run N trivial and N realistic scripts against
  an idle connection, print a median/percentile table, exit non-zero above a
  threshold. Opt-in (`npm run bench:script`), never in CI — it needs a live CIW.
* Acceptance: two consecutive bench runs agree within ±10 %, and the numbers
  match the table above within 20 %.

## Phase 1 — persistent script worker (2–3 days) — biggest win

One long-lived worker process per runtime: import once, connect once, then `exec`
each job in a fresh namespace. Removes the first three cost rows, i.e. ~0.85 s of
0.9 s.

**Decision: a separate worker process, not a thread in `vb_sidecar.py`.** The
sidecar is the plugin's control plane for `virtuoso_bridge_api`, dialogs and
health; a script that spins, `os._exit`s or segfaults must not take it down. A
separate process also keeps `sys.modules` pollution away from API calls.

**Design**

* `runtime/vb_script_worker.py` wraps the existing `vb_script.py` semantics
  (`status.json`, `result.json`, `error.json`, `events.jsonl`, `emit`,
  `SystemExit` handling) and adds a request loop.
* Reuse the line protocol already implemented by `lib/sidecar.js`
  (`{id, method, params}` → `{id, ok, result}`). Methods: `run`, `cancel`,
  `status`, `shutdown`. The worker is a second `Sidecar` instance owned by
  `Runtime`, so the spawn/ready/exit plumbing is not new code.
* Job isolation per `run`: fresh `namespace` dict, `os.chdir(workdir)` with
  restore, stdout/stderr captured per job, and `sys.modules` snapshotted so a
  script's local `import gen, emit, main` does not leak stale modules into the
  next job (reload-on-demand, matching what long sessions already do by hand).
* `connect()` inside a script returns the worker's warm client; a script that
  asks for a different `profile` gets a one-off client and the worker keeps its
  own.
* Failure modes, each with a defined outcome: worker exits or crashes → job
  marked `failed` with the stderr tail, worker restarted lazily on next run;
  per-job timeout → watchdog inside the worker, hard kill as backstop; cancel →
  same path as today; idle worker → stopped with the runtime.
* Rollback: additive behind `settings.scriptWorker` (default on) plus
  `VB_SCRIPT_DISABLE_WORKER=1`; the current process-per-script path stays as the
  fallback, so a regression is one setting away from reverting.

**Acceptance**

* median trivial call ≤ 0.15 s, median realistic body-limited call ≤ body + 0.1 s.
* Result parity on a corpus of ~20 scripts covering: local module import,
  `upload_file`/`download_file`, `run_shell_command`, `execute_skill`, `emit`,
  `result` serialization (dataclass/Path/bytes), raised exception, `SystemExit`,
  large stdout.
* 1000 sequential jobs: RSS growth < 50 MB, no file-descriptor growth; second run
  in the same worker is not slower than the first.
* Crash test: worker killed mid-job → job `failed` within 2 s, next job succeeds.
* Two agents on the same runtime never see each other's namespace or cwd.

## Phase 2 — trim the JS side (½ day)

Small but free once Phase 1 lands.

* Cache `#ensureSshConfig` keyed by connection/profile/sshPort/identityFile/pins;
  invalidate on `saveConnection`, `trustHost`, `deleteConnection`. Today it
  writes and removes files on every call.
* Cache `readSecret` per connection in memory; invalidate on `writeSecret`.
* Write `script.py`/`context.json` with one `Promise.all`, and skip the
  `probeVenv` call entirely when a worker is already running (its existence is
  the readiness proof).
* Acceptance: `jsPre` phase ≤ 0.02 s in the bench; a test that changes a
  connection and sees the config regenerated.

## Phase 3 — fewer, larger calls (1–2 days) — biggest session win

* Optional `steps: [code, code, …]` on `virtuoso_bridge_script run`: one tool
  call, one worker session, sequential exec, one combined result. A session that
  probes, generates, checks and re-generates pays one round trip instead of four.
* Prompt section and [script-call-performance.md](script-call-performance.md):
  one script per logical step; batch probes into a single body.
* Acceptance: a 10-step batch costs one call and ≤ 0.2 s over the sum of bodies;
  the slow-session pattern (115 calls) collapses to < 20.

## Phase 4 — concurrency and `waitMs` (½ day, measure first)

* Lower the `waitMs` default from 10 s to 2–3 s: a job that settles in 0.1 s no
  longer needs a long race, and a long job returns its id sooner.
* Only if Phase 3 shows independent work: an opt-in parallel lane (2 workers).
  Not before — with serialised calls and a cheap worker, concurrency mostly moves
  queueing around. Measure, then decide.

## Phase 5 — validate and document (½ day)

* `tests/script-worker.test.mjs`: drive the worker with a stub bridge module — no
  live CIW needed. Cover protocol, namespace isolation, timeout, crash restart,
  `SystemExit`, result serialization.
* Put the post-Phase-1 numbers into the performance doc and delete the "Remaining
  opportunities" list there in favour of this roadmap.

## Not doing

* Pre-forked interpreter pool, embedded interpreter, or venv tricks: the worker
  removes the start/import cost once and for all.
* Shrinking the import graph: 0.29 s matters once per process, not per call.
* Caching or reusing job directories: below the noise floor.
