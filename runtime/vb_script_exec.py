#!/usr/bin/env python3
"""Job execution core for the plugin's isolated virtuoso-bridge venv.

One source of truth for what a script job means: the artifacts it writes
(``status.json``, ``result.json``, ``error.json``, ``events.jsonl``), the
``emit()``/``connect()`` contract a script sees, the timeout watchdog and the
``SystemExit`` handling.

Two entry points use it:

* ``runtime/vb_script.py`` 鈥?one process per job (the CLI used when no worker is
  available). stdout/stderr are piped to the job's log files by the plugin.
* ``runtime/vb_script_worker.py`` 鈥?a long-lived process that runs many jobs,
  passing ``capture_files=True`` so each job's stdout/stderr land in its own
  ``stdout.log``/``stderr.log`` and never touch the protocol on fd 1.

The script namespace deliberately mirrors the bridge's public package::

    import virtuoso_bridge as vb
    from virtuoso_bridge import VirtuosoClient, SpectreSimulator

    client = connect()              # reuses the running tunnel when present
    result = client.execute_skill("1+1")

    for cell in cells:
        emit({"cell": cell})
"""

from __future__ import annotations

import contextlib
import dataclasses
import enum
import json
import os
import socket
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

# Unix-epoch milliseconds at import. The plugin passes ``context.t0Ms`` from
# ``Date.now()``, so the phase origin must be on the same epoch clock; the
# durations inside a job (import/connect/body) use ``time.monotonic()``.
MODULE_START_EPOCH_MS = time.time() * 1000.0

_THIS = Path(__file__).resolve()
VENDOR_SRC = _THIS.parent.parent / "virtuoso-bridge-lite" / "src"
if os.environ.get("VB_FORCE_VENDOR_SRC") == "1" and VENDOR_SRC.is_dir() and str(VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(VENDOR_SRC))


class JobInterrupted(BaseException):
    """Unwinds a running job on cancel or timeout.

    Derives from :class:`BaseException` so a script's ``except Exception`` does
    not swallow it.
    """

    reason = "cancelled"


class JobCancelled(JobInterrupted):
    reason = "cancelled"


class JobTimeout(JobInterrupted):
    reason = "timeout"


def jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 10:
        return {"$type": "truncated", "reason": "depth"}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, enum.Enum):
        return jsonable(value.value, depth + 1)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return {"$type": "bytes", "size": len(value)}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            "$type": type(value).__name__,
            **{
                field.name: jsonable(getattr(value, field.name), depth + 1)
                for field in dataclasses.fields(value)
            },
        }
    if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
        return jsonable(value.model_dump(), depth + 1)
    if isinstance(value, dict):
        return {str(key): jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [jsonable(item, depth + 1) for item in value]
    return {"$type": "repr", "class": type(value).__name__, "value": repr(value)[:4000]}


def write_json(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _forwarded_port(client: Any) -> int | None:
    """Local port the client talks to, when a tunnel already forwards it."""
    for name in ("_port", "port"):
        value = getattr(client, name, None)
        try:
            port = int(value)
        except (TypeError, ValueError):
            continue
        if 0 < port < 65536:
            return port
    return None


def _tunnel_forwards(port: int | None, timeout: float = 0.5) -> bool:
    """True when something already accepts connections on the forwarded port."""
    if not port:
        return False
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


def interrupt_thread(thread: threading.Thread | None, exc_type: type[BaseException]) -> bool:
    """Raise ``exc_type`` inside another thread at its next bytecode boundary.

    Used by the worker to unwind a job on ``cancel``/timeout. Returns False when
    the thread cannot be targeted (not started, or the injection failed), which
    leaves the job to notice the cancel flag itself.
    """
    if thread is None or thread.ident is None:
        return False
    try:
        import ctypes

        states = ctypes.pythonapi.PyThreadState_SetAsyncExc
        # 3.12+ takes unsigned long, older builds take long; both accept ident.
        pending = states(ctypes.c_ulong(thread.ident), ctypes.py_object(exc_type))
        if pending == 0:
            return False
        if pending > 1:  # pragma: no cover - defensive, would corrupt state
            states(ctypes.c_ulong(thread.ident), None)
            return False
        return True
    except Exception:
        return False


def snapshot_import_state() -> tuple[set[str], list[str]]:
    """Capture ``sys.modules`` names and ``sys.path`` before a job runs."""
    return set(sys.modules), list(sys.path)


def prune_job_modules(
    before: tuple[set[str], list[str]],
    workdir: str | Path,
    *,
    invalidate: bool = True,
) -> list[str]:
    """Drop modules a job imported from its own tree, and restore ``sys.path``.

    A long-lived worker must not let one job's ``import gen`` shadow the next
    job's rewritten ``gen.py``. Anything imported from the job workdir (or from a
    directory the job added to ``sys.path``) is removed, so a later job re-reads
    the source. ``importlib.invalidate_caches()`` makes the loader notice a file
    rewritten within the same second.
    """
    before_modules, before_path = before
    prefixes = [str(Path(workdir).resolve())]
    added = [entry for entry in sys.path if entry not in before_path]
    prefixes.extend(str(Path(entry).resolve()) for entry in added if entry)
    removed: list[str] = []
    for name, module in list(sys.modules.items()):
        if name in before_modules:
            continue
        origin = getattr(module, "__file__", None)
        if not origin:
            continue
        try:
            origin_path = str(Path(origin).resolve())
        except OSError:  # pragma: no cover - exotic loaders
            continue
        if any(origin_path.startswith(prefix) for prefix in prefixes):
            sys.modules.pop(name, None)
            removed.append(name)
    sys.path[:] = before_path
    if invalidate:
        try:
            import importlib

            importlib.invalidate_caches()
        except Exception:  # pragma: no cover - never fatal
            pass
    return removed


class JobRunner:
    """Runs one job directory and reports what happened.

    ``run()`` returns a dict (``state``, ``elapsedSeconds``, optional
    ``connectSeconds``/``sessionSetup``/``error``/``exitCode``) so both entry
    points can consume it; the artifacts on disk stay identical to the historical
    one-process-per-job runner.
    """

    def __init__(
        self,
        job_dir: str | Path,
        *,
        client: Any = None,
        spawn_ms: float | None = None,
        timeout_sec: float | None = None,
        cancel_event: threading.Event | None = None,
        capture_files: bool = False,
        on_timeout: Any = None,
    ) -> None:
        self.job_dir = Path(job_dir).resolve()
        self.context_path = self.job_dir / "context.json"
        self.script_path = self.job_dir / "script.py"
        self.status_path = self.job_dir / "status.json"
        self.result_path = self.job_dir / "result.json"
        self.error_path = self.job_dir / "error.json"
        self.events_path = self.job_dir / "events.jsonl"
        self.context: dict[str, Any] = {}
        self.workdir = self.job_dir
        # A pre-connected client (the worker's reused one). ``connect()`` returns
        # it and reports a zero-cost setup for this job.
        self.client = client
        self.connected_client = client
        self.spawn_ms = spawn_ms
        self.timeout_sec = timeout_sec
        self.cancel_event = cancel_event or threading.Event()
        self.cancel_reason: str | None = None
        self.capture_files = capture_files
        self.on_timeout = on_timeout
        self.event_lock = threading.Lock()
        self.started_epoch = 0.0
        self.started_body_epoch = 0.0
        self.import_ms = 0.0
        self.connect_ms = 0.0
        self._watchdog: threading.Thread | None = None
        self._streams: list[Any] = []
        # Guards the terminal artifacts: the job thread, the worker's cancel path
        # and the timeout path may all race to be the one that commits them.
        self.write_lock = threading.RLock()
        self.final_state: str | None = None

    # -- artifacts ----------------------------------------------------------

    def status(self, state: str, **extra: Any) -> None:
        payload = {
            "state": state,
            "pid": os.getpid(),
            "updatedAt": time.time(),
            "jobDir": str(self.job_dir),
            **extra,
        }
        try:
            write_json(self.status_path, payload)
        except OSError:
            pass

    def emit(self, value: Any, **fields: Any) -> None:
        """Append one structured event for the dashboard and polling tool."""
        event = {"time": time.time(), **fields, "value": jsonable(value)}
        with self.event_lock:
            with self.events_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def session_setup(self, body_ms: float | None = None) -> dict[str, Any]:
        """``sessionSetup`` as the plugin reads it, plus Phase 0 timings."""
        setup: dict[str, Any] = {}
        if "connectSeconds" in self.context:
            setup["connectSeconds"] = self.context["connectSeconds"]
            setup["tunnelReused"] = bool(self.context.get("tunnelReused"))
            if self.context.get("reusedTunnelPort"):
                setup["reusedTunnelPort"] = self.context["reusedTunnelPort"]
            if self.context.get("clientReused"):
                setup["clientReused"] = True
        phase: dict[str, Any] = {}
        t0 = self.context.get("t0Ms")
        if isinstance(t0, (int, float)):
            # ``spawn_ms`` is Unix-epoch milliseconds: the moment the plugin
            # started this job (CLI: process start; worker: run-request receipt).
            origin = self.spawn_ms if self.spawn_ms is not None else MODULE_START_EPOCH_MS
            phase["envMs"] = round(origin - float(t0), 1)
        phase["importMs"] = round(self.import_ms, 1)
        phase["connectMs"] = round(self.connect_ms, 1)
        if body_ms is not None:
            phase["bodyMs"] = round(body_ms, 1)
        setup["phase"] = phase
        return setup

    # -- client -------------------------------------------------------------

    def connect(self, *, timeout: int | None = None, log_to_ciw: bool | None = None):
        """Connect to the configured Virtuoso server, reusing a running tunnel."""
        if self.client is not None:
            # The worker already holds a warm client for this runtime/session.
            self.context["connectSeconds"] = 0.0
            self.context["tunnelReused"] = True
            self.context["clientReused"] = True
            self.context.pop("reusedTunnelPort", None)
            self.connect_ms = 0.0
            return self.client

        from virtuoso_bridge import VirtuosoClient

        try:
            from vb_plugin_env import isolate_runtime_env

            os.environ["VB_PLUGIN_DATA_DIR"] = str(self.context.get("dataDir") or self.job_dir)
            isolate_runtime_env()
        except Exception:
            pass

        profile = self.context.get("profile") or None
        local = bool(self.context.get("local"))
        effective_timeout = int(timeout or self.context.get("timeoutSec") or 30)
        with_log = bool(self.context.get("logToCiw")) if log_to_ciw is None else bool(log_to_ciw)

        started = time.monotonic()
        full_warm = os.environ.get("VB_SCRIPT_FULL_WARM") == "1"
        if local:
            from virtuoso_bridge.transport.tunnel import SSHClient

            ssh = SSHClient.from_env(keep_remote_files=True, profile=profile)
            if not full_warm and _tunnel_forwards(_forwarded_port(ssh)):
                # The runtime sidecar keeps this forward alive; repeating the
                # full warm() would re-run discovery/token/setup probing serially.
                self.context["tunnelReused"] = True
            else:
                ssh.warm(timeout=effective_timeout)
            client = VirtuosoClient.local(host="127.0.0.1", port=ssh.port, timeout=effective_timeout)
        else:
            client = VirtuosoClient.from_env(timeout=effective_timeout, profile=profile)
            # Honour the profile's CIW logging preference before the handshake
            # below evaluates anything.
            client.log_to_ciw = with_log
            warm = getattr(client, "warm_remote_session", None)
            # from_env adopts the plugin runtime's running tunnel when one exists.
            # Its full remote warm-up (instance discovery, daemon token,
            # persistent shells, remote setup, endpoint probe, instance
            # verification) is a long serial chain of SSH round trips, and it
            # re-does work the sidecar tunnel already did. When the forward
            # answers and the daemon behind it replies to a cheap handshake, skip
            # the warm-up; otherwise warm exactly as before.
            reuse = False
            if warm is not None and not full_warm:
                port = _forwarded_port(client)
                if _tunnel_forwards(port):
                    try:
                        reuse = bool(
                            client.verify_tunnel(timeout=min(effective_timeout, 5)).get("daemon_responsive")
                        )
                    except Exception:
                        reuse = False
                self.context["tunnelReused"] = reuse
                if reuse:
                    self.context["reusedTunnelPort"] = port
            if warm is not None and not reuse:
                warm(timeout=effective_timeout)
        client.log_to_ciw = with_log
        token = self.context.get("daemonToken") or os.environ.get("VB_SCRIPT_DAEMON_TOKEN")
        if token:
            client.daemon_token = token
        self.context["connectSeconds"] = round(time.monotonic() - started, 3)
        self.connect_ms = (time.monotonic() - started) * 1000.0
        self.client = client
        self.connected_client = client
        return client

    def preload_client(self):
        if not self.context.get("autoConnect"):
            return None
        try:
            return self.connect()
        except Exception as exc:
            self.emit({"warning": "autoConnectFailed", "error": f"{type(exc).__name__}: {exc}"})
            return None

    # -- streams ------------------------------------------------------------

    def _open_capture(self) -> None:
        if not self.capture_files:
            return
        try:
            self.job_dir.mkdir(parents=True, exist_ok=True)
            self._streams.append(self.job_dir.joinpath("stdout.log").open("a", encoding="utf-8"))
            self._streams.append(self.job_dir.joinpath("stderr.log").open("a", encoding="utf-8"))
        except OSError:
            self._streams.clear()

    def _close_capture(self) -> None:
        for stream in self._streams:
            try:
                stream.close()
            except Exception:
                pass
        self._streams.clear()

    def _redirect(self) -> tuple[Any, Any] | None:
        """Job stdout/stderr targets: the job's log files in worker mode."""
        if self.capture_files and len(self._streams) == 2:
            return self._streams[0], self._streams[1]
        return None

    # -- watchdog -----------------------------------------------------------

    def _start_watchdog(self, seconds: float, thread: threading.Thread) -> None:
        if seconds <= 0:
            return

        def fire() -> None:
            time.sleep(seconds)
            if self.cancel_event.is_set():
                return
            self.cancel_reason = "timeout"
            self.cancel_event.set()
            if self.on_timeout is not None:
                # Long-lived worker: unwind the job in place and keep serving.
                try:
                    self.on_timeout("timeout")
                except Exception:
                    interrupt_thread(thread, JobTimeout)
                return
            self.status("timeout", timeoutSec=seconds)
            self.emit({"error": "timeout", "timeoutSec": seconds})
            os._exit(124)

        self._watchdog = threading.Thread(target=fire, name="vb-script-watchdog", daemon=True)
        self._watchdog.start()

    def request_cancel(self, reason: str = "cancelled") -> bool:
        """Ask the running job to unwind; safe to call from another thread.

        Sets the cooperative flag, then raises inside the job thread so the job
        does not have to poll. Returns whether the interruption was delivered;
        when it was not, the job still stops at its next explicit check of
        ``cancel_event``.
        """
        self.cancel_reason = reason
        self.cancel_event.set()
        exc_type = JobTimeout if reason == "timeout" else JobCancelled
        return interrupt_thread(self._job_thread, exc_type)

    def finalize_interrupted(self, reason: str = "cancelled", *, elapsed: float | None = None) -> dict[str, Any]:
        """Commit the artifacts for a job that is still blocked inside the body.

        A job sitting in a blocking call cannot be unwound by an async exception
        until that call returns, so the worker cancels it for reporting purposes
        while it is still running. Whichever side commits first wins: the job
        thread's own terminal write is skipped when this has already happened.
        """
        elapsed = elapsed if elapsed is not None else max(0.0, time.monotonic() - self.started_epoch)
        state = "timeout" if reason == "timeout" else "cancelled"
        setup = self.session_setup(body_ms=elapsed * 1000.0)
        with self.write_lock:
            if self.final_state is not None:
                return self._outcome(self.final_state, elapsed, setup, error=self._interrupt_error(self.final_state))
            if state == "timeout":
                self.status("timeout", startedAt=self.started_epoch, elapsedSeconds=round(elapsed, 3), sessionSetup=setup)
                self.emit({"error": "timeout", "timeoutSec": self.timeout_sec})
                error = "timeout"
            else:
                message = "cancelled by request"
                write_json(self.error_path, {"type": "Cancelled", "message": message, "traceback": ""})
                self.status("cancelled", startedAt=self.started_epoch, elapsedSeconds=round(elapsed, 3), sessionSetup=setup)
                self.emit({"error": "Cancelled", "message": message})
                error = message
            self.final_state = state
        return self._outcome(state, elapsed, setup, error=error)

    @staticmethod
    def _interrupt_error(state: str) -> str | None:
        if state == "timeout":
            return "timeout"
        if state == "cancelled":
            return "cancelled by request"
        return None

    # -- execution ----------------------------------------------------------

    def _namespace(self, vb: Any) -> dict[str, Any]:
        return {
            "__name__": "__vb_script__",
            "__file__": str(self.script_path),
            "__builtins__": __builtins__,
            "vb": vb,
            "virtuoso_bridge": vb,
            "connect": self.connect,
            "emit": self.emit,
            "context": self.context,
            "connection": self.context.get("connection") or {},
            "job_dir": self.job_dir,
            "work_dir": self.workdir,
            "data_dir": Path(self.context.get("dataDir") or self.job_dir.parent.parent),
            "bridge_source_dir": VENDOR_SRC.parent if VENDOR_SRC.is_dir() else None,
            "Path": Path,
            "json": json,
            "time": time,
            "os": os,
            "sys": sys,
            "VirtuosoClient": vb.VirtuosoClient,
            "SpectreSimulator": vb.SpectreSimulator,
            "SpectrePool": vb.SpectrePool,
            "SanitizingClient": vb.SanitizingClient,
        }

    _job_thread: threading.Thread | None = None

    def run(self) -> dict[str, Any]:
        self.context = json.loads(self.context_path.read_text(encoding="utf-8"))
        code = self.script_path.read_text(encoding="utf-8")

        workdir = Path(self.context.get("workdir") or self.job_dir).resolve()
        workdir.mkdir(parents=True, exist_ok=True)
        self.workdir = workdir
        previous_cwd = os.getcwd()
        os.chdir(workdir)
        self._job_thread = threading.current_thread()
        self._open_capture()

        self.started_epoch = time.time()
        self.status("running", startedAt=self.started_epoch)
        timeout = float(self.timeout_sec if self.timeout_sec is not None else (self.context.get("timeoutSec") or 0))
        self._start_watchdog(timeout, self._job_thread)

        import_started = time.monotonic()
        import virtuoso_bridge as vb

        self.import_ms = (time.monotonic() - import_started) * 1000.0
        namespace = self._namespace(vb)
        client = self.preload_client()
        if client is not None:
            namespace["client"] = client

        started = time.monotonic()
        started_epoch = time.time()
        self.started_body_epoch = started_epoch
        try:
            redirect = self._redirect()
            if redirect is None:
                exec(compile(code, str(self.script_path), "exec"), namespace, namespace)
            else:
                out_stream, err_stream = redirect
                with contextlib.redirect_stdout(out_stream), contextlib.redirect_stderr(err_stream):
                    exec(compile(code, str(self.script_path), "exec"), namespace, namespace)
            if self.cancel_event.is_set():
                raise JobInterrupted(self.cancel_reason or "cancelled")
            result = namespace.get("result")
            elapsed = time.monotonic() - started
            return self._commit(
                "succeeded",
                elapsed,
                result=result,
                event={
                    "done": True,
                    "state": "succeeded",
                    "elapsedSeconds": round(elapsed, 3),
                },
                exit_code=0,
                status_exit_code=False,
            )
        except SystemExit as exc:
            code_value = exc.code if isinstance(exc.code, int) else 0
            elapsed = time.monotonic() - started
            return self._commit(
                "succeeded" if code_value == 0 else "failed",
                elapsed,
                exit_code=int(code_value or 0),
                status_exit_code=True,
            )
        except JobInterrupted as exc:
            elapsed = time.monotonic() - started
            reason = getattr(exc, "reason", None) or self.cancel_reason or "cancelled"
            return self._commit(
                "timeout" if reason == "timeout" else "cancelled",
                elapsed,
                error="timeout" if reason == "timeout" else "cancelled by request",
            )
        except BaseException as exc:  # noqa: BLE001 - report everything to the job
            elapsed = time.monotonic() - started
            return self._commit(
                "failed",
                elapsed,
                failure=exc,
                event={"error": type(exc).__name__, "message": str(exc)},
                exit_code=1,
                status_exit_code=True,
                error=f"{type(exc).__name__}: {exc}",
            )
        finally:
            try:
                os.chdir(previous_cwd)
            except OSError:  # pragma: no cover - cwd removed under us
                pass
            self._close_capture()

    def _commit(
        self,
        state: str,
        elapsed: float,
        *,
        result: Any = None,
        failure: BaseException | None = None,
        event: dict[str, Any] | None = None,
        exit_code: int | None = None,
        status_exit_code: bool = False,
        error: str | None = None,
    ) -> dict[str, Any]:
        """Write the terminal artifacts once, whoever gets there first.

        The worker's cancel/timeout path may commit while the job thread is still
        blocked inside the body; in that case the job thread must not overwrite
        the outcome it already reported.
        """
        setup = self.session_setup(body_ms=elapsed * 1000.0)
        with self.write_lock:
            if self.final_state is not None:
                return self._outcome(
                    self.final_state,
                    elapsed,
                    setup,
                    error=self._interrupt_error(self.final_state),
                )
            if result is not None:
                try:
                    write_json(self.result_path, jsonable(result))
                except Exception as exc:
                    self.emit({"warning": "resultNotSerializable", "error": str(exc)})
            if failure is not None:
                write_json(
                    self.error_path,
                    {
                        "type": type(failure).__name__,
                        "message": str(failure),
                        "traceback": traceback.format_exc()[-16000:],
                    },
                )
            elif state == "cancelled":
                write_json(
                    self.error_path,
                    {"type": "Cancelled", "message": error or "cancelled by request", "traceback": ""},
                )
            extra: dict[str, Any] = {"startedAt": self.started_body_epoch or time.time()}
            if state != "timeout":
                extra["elapsedSeconds"] = round(elapsed, 3)
            if status_exit_code and exit_code is not None:
                extra["exitCode"] = exit_code
            self.status(state, sessionSetup=setup, **extra)
            if event is not None:
                # The done/failed events keep their historical shape: Phase 0
                # timings live in status.json and the worker's run result.
                self.emit({**event, **{k: v for k, v in setup.items() if k != "phase"}})
            elif state == "timeout":
                self.emit({"error": "timeout", "timeoutSec": self.timeout_sec})
            elif error and state == "cancelled":
                self.emit({"error": "Cancelled", "message": error})
            self.final_state = state
        return self._outcome(state, elapsed, setup, exit_code=exit_code, error=error)

    def _outcome(
        self,
        state: str,
        elapsed: float,
        setup: dict[str, Any],
        *,
        exit_code: int | None = None,
        error: str | None = None,
    ) -> dict[str, Any]:
        outcome: dict[str, Any] = {"state": state, "elapsedSeconds": round(elapsed, 3), "sessionSetup": setup}
        if "connectSeconds" in setup:
            outcome["connectSeconds"] = setup["connectSeconds"]
        if exit_code is not None:
            outcome["exitCode"] = exit_code
        if error:
            outcome["error"] = error
        return outcome

