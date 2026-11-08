#!/usr/bin/env python3
"""Long-lived script worker: one process per (runtime, session).

The plugin spawns this process and speaks PROTOCOL CONTRACT v1 to it over
newline-delimited JSON on stdout. It exists for one reason: a fresh process per
job pays interpreter start, the package import and a client construction every
time. This process pays them once, then runs each job through
:class:`vb_script_exec.JobRunner`, which keeps the artifacts
(``status.json``/``result.json``/``error.json``/``events.jsonl``) and the script
namespace identical to the one-shot runner.

Contract (do not change without telling the Lead):

* argv: ``<venvPython> -u <pluginDir>/runtime/vb_script_worker.py
  --runtime <runtimeId> --session <sessionId>``
* stdout carries only protocol lines; logs and stray prints go to stderr.
* ready: ``{"event":"ready","pid":N,"runtime":..,"session":..,"version":1}``
* request: ``{"id":..,"method":"ping|status|run|cancel|shutdown","params":{..}}``
* response: ``{"id":..,"ok":true,"result":{..}}`` /
  ``{"id":..,"ok":false,"error":{"message":..,"kind":..,"traceback":..}}``
* events: ``{"event":"log","level":..,"message":..}`` and
  ``{"event":"job","state":"running|succeeded|failed","jobId":..}``

Jobs run one at a time; a second ``run`` while busy is refused with
``error.kind="busy"``. The protocol stays responsive during a job, so ``cancel``,
``status`` and ``ping`` are answered while the job runs.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from vb_script_exec import (
    JobCancelled,
    JobRunner,
    JobTimeout,
    interrupt_thread,
    prune_job_modules,
    snapshot_import_state,
)

PROTOCOL_VERSION = 1

_WRITE_LOCK = threading.Lock()
_PROTOCOL_FD: int | None = None

_STDERR_TAIL: list[str] = []


def log(message: str, level: str = "info") -> None:
    line = f"{time.strftime('%H:%M:%S')} [{level}] {message}"
    _STDERR_TAIL.append(line)
    if len(_STDERR_TAIL) > 200:
        del _STDERR_TAIL[:100]
    print(line, file=sys.stderr, flush=True)
    emit({"event": "log", "level": level, "message": message})


def emit(payload: dict[str, Any]) -> None:
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8", "replace")
    with _WRITE_LOCK:
        try:
            if _PROTOCOL_FD is not None:
                os.write(_PROTOCOL_FD, line)
            else:  # pragma: no cover - only if dup failed at startup
                sys.stdout.write(line.decode("utf-8"))
                sys.stdout.flush()
        except Exception:
            pass


def respond(request_id: Any, *, ok: bool, result: Any = None, error: dict | None = None) -> None:
    payload: dict[str, Any] = {"id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error
    emit(payload)


def _error_payload(exc: BaseException, kind: str | None = None) -> dict[str, Any]:
    return {
        "message": f"{type(exc).__name__}: {exc}",
        "kind": kind or type(exc).__name__,
        "traceback": traceback.format_exc()[-8000:],
    }


class Worker:
    """Serial job executor with one reused bridge client."""

    def __init__(self, runtime: str, session: str) -> None:
        self.runtime = runtime
        self.session = session
        self.started_at = time.time()
        self.last_used_at = self.started_at
        self.client: Any = None
        self.jobs = 0
        self.lock = threading.Lock()
        self.busy = False
        self.job_id: str | None = None
        self.runner: JobRunner | None = None
        self.job_thread: threading.Thread | None = None
        self.cancel_event = threading.Event()
        self.pending_id: Any = None

    # -- status -------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        with self.lock:
            busy = self.busy
            job_id = self.job_id
            jobs = self.jobs
            connected = self.client is not None
            runner = self.runner
        result: dict[str, Any] = {
            "pid": os.getpid(),
            "session": self.session,
            "runtime": self.runtime,
            "connected": connected,
            "busy": busy,
            "jobs": jobs,
            "startedAt": self.started_at,
            "idleSeconds": round(max(0.0, time.time() - self.last_used_at), 3),
        }
        if job_id:
            result["jobId"] = job_id
        if runner is not None and "connectSeconds" in runner.context:
            result["connectSeconds"] = runner.context["connectSeconds"]
            result["tunnelReused"] = bool(runner.context.get("tunnelReused"))
        return result

    # -- jobs ---------------------------------------------------------------

    def _interrupt(self, reason: str) -> bool:
        """Unwind the running job in place (used by the watchdog and cancel)."""
        runner = self.runner
        if runner is None:
            return False
        runner.cancel_reason = reason
        runner.cancel_event.set()
        exc_type = JobTimeout if reason == "timeout" else JobCancelled
        return interrupt_thread(self.job_thread, exc_type)

    def _stop_job(self, reason: str) -> bool:
        """Ask the running job to stop and make sure it is reported either way.

        An async exception only lands at a bytecode boundary, so a job blocked in
        a sleep or a socket read cannot be unwound until that call returns. The
        grace thread commits the cancelled/timeout artifacts and answers the
        pending ``run`` request once the grace expires; a job that unwinds sooner
        answers for itself and the grace thread stands down.
        """
        runner = self.runner
        if runner is None:
            return False
        runner.request_cancel(reason)
        threading.Thread(
            target=self._finalize_after_grace,
            args=(runner, reason),
            name=f"vb-cancel-{self.job_id}",
            daemon=True,
        ).start()
        return True

    def _finalize_after_grace(self, runner: JobRunner, reason: str, grace: float = 0.6) -> None:
        time.sleep(grace)
        with self.lock:
            if not self.busy or self.runner is not runner:
                return
            request_id = self.pending_id
            self.pending_id = None
            job_id = self.job_id
        outcome = runner.finalize_interrupted(reason)
        log(f"job {job_id} reported as {outcome.get('state')} while still unwinding", "warn")
        emit({"event": "job", "state": "failed", "jobId": job_id})
        if request_id is not None:
            respond(request_id, ok=True, result=outcome)

    def run_job(self, request_id: Any, params: dict[str, Any]) -> None:
        raw_dir = params.get("jobDir")
        if not raw_dir:
            respond(request_id, ok=False, error={"message": "jobDir is required", "kind": "invalid"})
            return
        job_dir = Path(str(raw_dir)).expanduser().resolve()
        job_id = str(params.get("jobId") or job_dir.name)
        # Phase origin for ``context.t0Ms`` (the plugin's Date.now() value): when
        # this job request arrived, not when the worker process started.
        request_ms = time.time() * 1000.0

        with self.lock:
            if self.busy:
                respond(
                    request_id,
                    ok=False,
                    error={"message": f"worker is busy with {self.job_id}", "kind": "busy"},
                )
                return
            self.busy = True
            self.job_id = job_id
            self.pending_id = request_id
            self.cancel_event = threading.Event()
            self.job_thread = threading.current_thread()
            self.runner = None

        emit({"event": "job", "state": "running", "jobId": job_id})
        outcome: dict[str, Any] | None = None
        error_payload: dict[str, Any] | None = None
        workdir = job_dir
        before = snapshot_import_state()
        try:
            runner = JobRunner(
                job_dir,
                client=self.client,
                spawn_ms=request_ms,
                timeout_sec=params.get("timeoutSec"),
                cancel_event=self.cancel_event,
                capture_files=True,
                on_timeout=self._stop_job,
            )
            self.runner = runner
            outcome = runner.run()
            workdir = runner.workdir
            if self.client is None and runner.connected_client is not None:
                self.client = runner.connected_client
        except BaseException as exc:  # noqa: BLE001 - never let a job kill the loop
            error_payload = _error_payload(exc, "job")
            self._mark_failed(job_dir, exc)
        finally:
            try:
                removed = prune_job_modules(before, workdir)
                if removed:
                    log(f"job {job_id} dropped {len(removed)} module(s) imported from its workdir", "debug")
            except Exception as exc:  # noqa: BLE001 - hygiene must never fail a job
                log(f"job {job_id} module hygiene failed: {exc}", "warn")
            with self.lock:
                still_ours = self.pending_id is request_id
                self.pending_id = None
                self.busy = False
                self.job_id = None
                self.jobs += 1
                self.last_used_at = time.time()

        if error_payload is not None:
            emit({"event": "job", "state": "failed", "jobId": job_id})
            respond(request_id, ok=False, error=error_payload)
            return
        assert outcome is not None
        if not still_ours:
            # The cancel/timeout grace path already answered this request while
            # the body was still blocked; answering twice would confuse the
            # plugin's request map.
            return
        # The contract enumerates running|succeeded|failed for the job event; the
        # response carries the precise state (including timeout/cancelled).
        emit(
            {
                "event": "job",
                "state": "succeeded" if outcome.get("state") == "succeeded" else "failed",
                "jobId": job_id,
            }
        )
        respond(request_id, ok=True, result=outcome)

    def _mark_failed(self, job_dir: Path, exc: BaseException) -> None:
        """Leave coherent artifacts when the runner itself could not start."""
        status_path = job_dir / "status.json"
        try:
            current = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {}
        except Exception:
            current = {}
        if current.get("state") not in (None, "running"):
            return
        from vb_script_exec import write_json

        try:
            write_json(
                job_dir / "error.json",
                {
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc()[-16000:],
                },
            )
            write_json(
                status_path,
                {
                    "state": "failed",
                    "pid": os.getpid(),
                    "updatedAt": time.time(),
                    "jobDir": str(job_dir),
                    "startedAt": current.get("startedAt") or time.time(),
                    "exitCode": 1,
                },
            )
        except OSError:
            pass

    def cancel_job(self, params: dict[str, Any]) -> dict[str, Any]:
        requested = params.get("jobId")
        with self.lock:
            busy = self.busy
            current = self.job_id
        if not busy:
            return {"cancelled": False}
        if requested and str(requested) != current:
            return {"cancelled": False}
        delivered = self._stop_job("cancelled")
        log(f"cancel requested for job {current} (delivered={delivered})", "warn" if not delivered else "info")
        return {"cancelled": True}

    # -- dispatch -----------------------------------------------------------

    def handle(self, request: dict[str, Any]) -> None:
        request_id = request.get("id")
        method = str(request.get("method") or "")
        params = request.get("params") or {}
        if not isinstance(params, dict):
            respond(request_id, ok=False, error={"message": "params must be an object", "kind": "invalid"})
            return
        try:
            if method == "ping":
                respond(request_id, ok=True, result={"pong": True, "pid": os.getpid()})
                return
            if method == "status":
                respond(request_id, ok=True, result=self.status())
                return
            if method == "run":
                self.run_job(request_id, params)
                return
            if method == "cancel":
                respond(request_id, ok=True, result=self.cancel_job(params))
                return
            if method == "shutdown":
                # Only reachable through handle() when the caller bypassed the
                # reader thread; the main loop answers shutdown itself.
                respond(request_id, ok=True, result={"shutdown": True})
                return
            respond(request_id, ok=False, error={"message": f"unknown method {method!r}", "kind": "invalid"})
        except Exception as exc:  # noqa: BLE001 - protocol must stay alive
            respond(request_id, ok=False, error=_error_payload(exc))


def main(argv: list[str] | None = None) -> int:
    global _PROTOCOL_FD
    parser = argparse.ArgumentParser(description="virtuoso-bridge DSH script worker")
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--session", required=True)
    args = parser.parse_args(argv)

    # Protocol must own fd 1. Anything a library prints (the bridge prints CIW
    # hints on connect) then lands on stderr instead of corrupting the stream.
    try:
        _PROTOCOL_FD = os.dup(1)
        os.dup2(2, 1)
    except OSError:  # pragma: no cover - only on exotic stdio setups
        _PROTOCOL_FD = None

    worker = Worker(runtime=args.runtime, session=args.session)
    emit(
        {
            "event": "ready",
            "pid": os.getpid(),
            "runtime": worker.runtime,
            "session": worker.session,
            "version": PROTOCOL_VERSION,
        }
    )
    log(f"script worker ready runtime={worker.runtime} session={worker.session}")

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            respond(None, ok=False, error={"message": f"invalid JSON: {exc}", "kind": "invalid"})
            continue
        if not isinstance(request, dict):
            respond(None, ok=False, error={"message": "request must be an object", "kind": "invalid"})
            continue
        if request.get("method") == "shutdown":
            # Answered here, on the reading thread, so the exit cannot race a job
            # thread that is still unwinding.
            if worker.busy:
                worker._interrupt("cancelled")
                time.sleep(0.2)
            respond(request.get("id"), ok=True, result={"shutdown": True})
            log("worker shutdown")
            return 0
        # One thread per request keeps ping/status/cancel answerable while a job
        # runs. Jobs are serialised by the busy guard, not by this loop.
        thread = threading.Thread(
            target=worker.handle,
            args=(request,),
            name=f"vb-job-{request.get('id')}",
            daemon=True,
        )
        thread.start()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
