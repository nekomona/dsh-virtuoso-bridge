# Virtuoso Bridge agent workflows

These recipes use APIs already shipped in virtuoso-bridge-lite. Do not add a
plugin-side Maestro runner, job store, dialog manager, history manager, point
counter or scheduler. The plugin exposes the bridge; the bridge owns the logic.

## Long Maestro run: submit once, observe durably

Use `MaestroJobManager` instead of a blocking `run_and_wait` when the run may
outlive a tool call or the daemon may restart.

```python
from virtuoso_bridge.virtuoso.maestro.jobs import MaestroJobManager

mgr = MaestroJobManager.from_client(client)
job = mgr.submit(session="mySession", run_id="run-001", timeout=180)

status = mgr.status(job)          # poll this; it is persisted locally/remotely
print(status)
print(mgr.log(job, lines=80))
```

- `submit` preflights the dialog guard and records an unknown outcome instead
  of submitting twice.
- After a reconnect or daemon restart, `mgr.list()` / `mgr.load(run_id)` and
  `mgr.reconcile(job)` re-establish observation before any retry.
- There is no job-cancel method in this API; do not invent one.
- Save dirty setup before submitting:
  `client.maestro.save_setup(lib, cell, session=session)`.

Read the exact signatures from the installed package; do not guess them.

## Dialog inspection and answer

Inspection and guard are existing APIs:

```python
report = client.dialogs.inspect(pid=client.remote_virtuoso_pid)
report = client.dialogs.enable_guard(pid=client.remote_virtuoso_pid,
                                     protect_inflight=True)
ticket = client.dialogs.prepare_close(
    report.dialogs[0].window_id,
    expected_title=report.dialogs[0].title,
)
```

`client.dialogs.close()` sends the window-manager close action. It is **not** a
way to press Yes/No on a question dialog.

For an explicitly authorized Yes/No/OK action, use the existing X11 helper:

```python
from virtuoso_bridge.virtuoso import x11

results = x11.dismiss_window(
    client.ssh_runner,
    "<remote-user>",
    window_id,
    action="alt-y",          # alt-y, alt-n, alt-o, enter, escape
    display=":0",
    pid=client.remote_virtuoso_pid,
)
print(results)               # closure_confirmed / still_mapped
```

Rules:

1. Inspect read-only first.
2. Show the preview and ask the user before an ambiguous dialog.
3. Never answer a simulation-start/save dialog without authorization.
4. Verify closure; do not repeat input when the result is uncertain.

The plugin predeploys and verifies the X11 helper when a remote runtime starts.
If it is missing later, call the existing `x11.dismiss_window` API; its helper
upload is part of virtuoso-bridge, not a new plugin function.

## History and setup conflicts

- `EXPLORER-2406` means the requested history name already exists. Do not
  resubmit blindly. Inspect the existing history, then use the existing
  `get_history` / `lock_history` / `unlock_history` / `set_history_lock` APIs,
  or an explicit SKILL rename, before starting a new run.
- `MaestroMonteCarloError: unsaved or unknown setup changes`: call the existing
  `client.maestro.save_setup(...)`, then retry the configuration.
- A locked history may cause the next ADE Explorer run to reuse its name.
  Unlock or rename only after confirming the old results are safe.

## Large runs and job policy

- A `warnWhenSimsExceed` question is Cadence policy, not a bridge failure.
  Inspect the dialog and ask the user before answering.
- For parallel execution, use the existing Maestro job-policy APIs
  (`maeGetJobPolicy` / `maeSetJobPolicy`) or `client.maestro.set_job_policy`;
  do not add a plugin scheduler.
- Confirm the actual point count and host capacity before a large run.

## Failure rules

- A socket error / daemon drop means the outcome is **unknown**, not failed.
  Use `MaestroJobManager` status/reconcile and host-side history inspection;
  never resubmit automatically.
- A modal dialog can block SKILL while the simulation itself is still running.
  Inspect dialogs out of band with X11; do not restart the daemon or resubmit
  just because a SKILL poll timed out.
- Prefer existing structured APIs over package-source introspection or raw
  shell guesses.
