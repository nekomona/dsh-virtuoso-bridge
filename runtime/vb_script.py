#!/usr/bin/env python3
"""Run a user script inside the plugin's isolated virtuoso-bridge venv.

The DSH plugin starts this file with the venv interpreter and a job
directory.  The directory contains ``context.json`` and ``script.py``.  The
runner writes:

* ``status.json``   - ``running`` / ``succeeded`` / ``failed`` / ``timeout``
* ``result.json``   - the script's ``result`` variable, JSON encoded
* ``error.json``    - exception type, message, traceback
* ``events.jsonl``  - structured ``emit()`` values

stdout and stderr are redirected by the Host to ``stdout.log`` and
``stderr.log``; this process does not touch the protocol.

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
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

_THIS = Path(__file__).resolve()
_VENDOR_SRC = _THIS.parent.parent / "virtuoso-bridge-lite" / "src"
if os.environ.get("VB_FORCE_VENDOR_SRC") == "1" and _VENDOR_SRC.is_dir() and str(_VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(_VENDOR_SRC))

JOB_DIR = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
CONTEXT_PATH = JOB_DIR / "context.json"
STATUS_PATH = JOB_DIR / "status.json"
RESULT_PATH = JOB_DIR / "result.json"
ERROR_PATH = JOB_DIR / "error.json"
EVENTS_PATH = JOB_DIR / "events.jsonl"

_context: dict[str, Any] = {}
_event_lock = threading.Lock()


def _jsonable(value: Any, depth: int = 0) -> Any:
    if depth > 10:
        return {"$type": "truncated", "reason": "depth"}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, enum.Enum):
        return _jsonable(value.value, depth + 1)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (bytes, bytearray)):
        return {"$type": "bytes", "size": len(value)}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            "$type": type(value).__name__,
            **{
                field.name: _jsonable(getattr(value, field.name), depth + 1)
                for field in dataclasses.fields(value)
            },
        }
    if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
        return _jsonable(value.model_dump(), depth + 1)
    if isinstance(value, dict):
        return {str(key): _jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(item, depth + 1) for item in value]
    return {"$type": "repr", "class": type(value).__name__, "value": repr(value)[:4000]}


def _write_json(path: Path, payload: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def _status(state: str, **extra: Any) -> None:
    payload = {
        "state": state,
        "pid": os.getpid(),
        "updatedAt": time.time(),
        "jobDir": str(JOB_DIR),
        **extra,
    }
    try:
        _write_json(STATUS_PATH, payload)
    except OSError:
        pass


def emit(value: Any, **fields: Any) -> None:
    """Append one structured event for the dashboard and polling tool."""
    event = {"time": time.time(), **fields, "value": _jsonable(value)}
    with _event_lock:
        with EVENTS_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def connect(*, timeout: int | None = None, log_to_ciw: bool | None = None):
    """Connect to the configured Virtuoso server, reusing a running tunnel."""
    from virtuoso_bridge import VirtuosoClient
    from virtuoso_bridge.env import set_runtime_env_file

    data_dir = Path(_context.get("dataDir") or JOB_DIR)
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        empty = data_dir / "empty.env"
        if not empty.exists():
            empty.write_text("# intentionally empty: the DSH plugin owns VB_* values\n", encoding="utf-8")
        set_runtime_env_file(empty)
    except Exception:
        pass

    profile = _context.get("profile") or None
    local = bool(_context.get("local"))
    effective_timeout = int(timeout or _context.get("timeoutSec") or 30)
    with_log = bool(_context.get("logToCiw")) if log_to_ciw is None else bool(log_to_ciw)

    if local:
        from virtuoso_bridge.transport.tunnel import SSHClient

        ssh = SSHClient.from_env(keep_remote_files=True, profile=profile)
        ssh.warm(timeout=effective_timeout)
        client = VirtuosoClient.local(host="127.0.0.1", port=ssh.port, timeout=effective_timeout)
    else:
        client = VirtuosoClient.from_env(timeout=effective_timeout, profile=profile)
        warm = getattr(client, "warm_remote_session", None)
        if warm is not None:
            warm(timeout=effective_timeout)
    client.log_to_ciw = with_log
    token = _context.get("daemonToken") or os.environ.get("VB_SCRIPT_DAEMON_TOKEN")
    if token:
        client.daemon_token = token
    _context["connectedClient"] = client
    return client


def _preload_client():
    if not _context.get("autoConnect"):
        return None
    try:
        return connect()
    except Exception as exc:
        emit({"warning": "autoConnectFailed", "error": f"{type(exc).__name__}: {exc}"})
        return None


def _watchdog(seconds: float) -> None:
    if seconds <= 0:
        return

    def fire() -> None:
        time.sleep(seconds)
        _status("timeout", timeoutSec=seconds)
        emit({"error": "timeout", "timeoutSec": seconds})
        os._exit(124)

    thread = threading.Thread(target=fire, name="vb-script-watchdog", daemon=True)
    thread.start()


def main() -> int:
    global _context
    _context = json.loads(CONTEXT_PATH.read_text(encoding="utf-8"))
    script_path = JOB_DIR / "script.py"
    code = script_path.read_text(encoding="utf-8")

    workdir = Path(_context.get("workdir") or JOB_DIR).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    os.chdir(workdir)

    _status("running", startedAt=time.time())
    _watchdog(float(_context.get("timeoutSec") or 0))
    import virtuoso_bridge as vb

    namespace: dict[str, Any] = {
        "__name__": "__vb_script__",
        "__file__": str(script_path),
        "__builtins__": __builtins__,
        "vb": vb,
        "virtuoso_bridge": vb,
        "connect": connect,
        "emit": emit,
        "context": _context,
        "connection": _context.get("connection") or {},
        "job_dir": JOB_DIR,
        "work_dir": workdir,
        "data_dir": Path(_context.get("dataDir") or JOB_DIR.parent.parent),
        "bridge_source_dir": _VENDOR_SRC.parent if _VENDOR_SRC.is_dir() else None,
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
    client = _preload_client()
    if client is not None:
        namespace["client"] = client

    started = time.monotonic()
    started_epoch = time.time()
    try:
        with contextlib.redirect_stdout(sys.stdout), contextlib.redirect_stderr(sys.stderr):
            exec(compile(code, str(script_path), "exec"), namespace, namespace)
        result = namespace.get("result")
        elapsed = time.monotonic() - started
        if result is not None:
            try:
                _write_json(RESULT_PATH, _jsonable(result))
            except Exception as exc:
                emit({"warning": "resultNotSerializable", "error": str(exc)})
        _status("succeeded", startedAt=started_epoch, elapsedSeconds=round(elapsed, 3))
        emit({"done": True, "state": "succeeded", "elapsedSeconds": round(elapsed, 3)})
        return 0
    except SystemExit as exc:
        code_value = exc.code if isinstance(exc.code, int) else 0
        _status("succeeded" if code_value == 0 else "failed", startedAt=started_epoch, exitCode=code_value)
        return int(code_value or 0)
    except BaseException as exc:  # noqa: BLE001 - report everything to the job
        elapsed = time.monotonic() - started
        _write_json(
            ERROR_PATH,
            {
                "type": type(exc).__name__,
                "message": str(exc),
                "traceback": traceback.format_exc()[-16000:],
            },
        )
        _status("failed", startedAt=started_epoch, elapsedSeconds=round(elapsed, 3), exitCode=1)
        emit({"error": type(exc).__name__, "message": str(exc)})
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
