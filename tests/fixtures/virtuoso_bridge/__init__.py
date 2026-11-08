"""Offline stand-in for the real ``virtuoso_bridge`` package (test fixture).

Only the surface that ``runtime/vb_script.py`` and ``runtime/vb_script_worker.py``
touch is implemented. Nothing here opens a socket, reads a credential, or talks
to a daemon, so tests stay hermetic.

Behaviour knobs (all optional, read at call time):

``VB_STUB_CALL_LOG``       append one JSON line per call to this path
``VB_STUB_FROM_ENV_ERROR`` ``VirtuosoClient.from_env`` raises RuntimeError(text)
``VB_STUB_PORT``           local port reported by ``from_env`` (default 65432)
``VB_STUB_VERIFY_FALSE``   ``verify_tunnel`` reports the daemon as not answering
``VB_STUB_SKILL_SLEEP``    seconds ``execute_skill`` sleeps (default 0)
``VB_STUB_SKILL_ERROR``    ``execute_skill`` raises RuntimeError(text)
"""

from __future__ import annotations

import json
import os
import time

__version__ = "0.0.0-fixture"

#: A worker-process-scoped marker the isolation tests read back.
SESSION_MARKER = None


def _call_log_path() -> str | None:
    value = os.environ.get("VB_STUB_CALL_LOG", "").strip()
    return value or None


def _log(kind: str, **fields: object) -> None:
    path = _call_log_path()
    if not path:
        return
    record = {"kind": kind, "pid": os.getpid(), **fields}
    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, sort_keys=True) + "\n")
    except OSError:
        pass


def _number(name: str, default: float = 0.0) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class VirtuosoResult:
    """The subset of the real result object scripts print and inspect."""

    def __init__(self, status: str = "success", output: str = "", errors: list[str] | None = None):
        self.status = status
        self.output = output
        self.errors = list(errors or [])

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"VirtuosoResult(status={self.status!r})"


class VirtuosoClient:
    """Connected-client stand-in that records how it was constructed."""

    def __init__(
        self,
        *,
        host: str = "127.0.0.1",
        port: int = 65432,
        timeout: int = 30,
        log_to_ciw: bool = True,
        daemon_token: str | None = None,
    ) -> None:
        self._host = host
        self._port = int(port)
        self.timeout = timeout
        self.log_to_ciw = log_to_ciw
        self.daemon_token = daemon_token
        self.skills: list[str] = []
        _log("client", port=self._port)

    # -- factories ---------------------------------------------------------

    @classmethod
    def from_env(cls, *, timeout: int = 30, log_to_ciw: bool = True, profile: str | None = None) -> "VirtuosoClient":
        failure = os.environ.get("VB_STUB_FROM_ENV_ERROR", "").strip()
        if failure:
            raise RuntimeError(failure)
        _log("from_env", profile=profile)
        return cls(
            port=int(_number("VB_STUB_PORT", 65432)),
            timeout=timeout,
            log_to_ciw=log_to_ciw,
        )

    @classmethod
    def local(cls, *, host: str = "127.0.0.1", port: int = 65432, timeout: int = 30) -> "VirtuosoClient":
        _log("local", port=port)
        return cls(host=host, port=port, timeout=timeout)

    @classmethod
    def from_tunnel(cls, tunnel: object, timeout: int = 30, log_to_ciw: bool = True) -> "VirtuosoClient":
        _log("from_tunnel")
        return cls(port=int(getattr(tunnel, "port", 65432)), timeout=timeout, log_to_ciw=log_to_ciw)

    # -- warm-up paths -----------------------------------------------------

    def warm_remote_session(self, timeout: int = 10) -> VirtuosoResult:
        _log("warm_remote_session", timeout=timeout)
        return VirtuosoResult()

    def verify_tunnel(self, timeout: int = 5) -> dict[str, object]:
        responsive = os.environ.get("VB_STUB_VERIFY_FALSE") != "1"
        _log("verify_tunnel", responsive=responsive)
        return {
            "tunnel_process_alive": True,
            "tcp_reachable": responsive,
            "daemon_responsive": responsive,
            "daemon_output": "",
            "summary": "fixture",
        }

    @property
    def is_tunnel_alive(self) -> bool:
        return True

    # -- operations --------------------------------------------------------

    def execute_skill(self, skill_code: str, timeout: float | None = None, **_: object) -> VirtuosoResult:
        delay = _number("VB_STUB_SKILL_SLEEP")
        if delay > 0:
            time.sleep(delay)
        failure = os.environ.get("VB_STUB_SKILL_ERROR", "").strip()
        if failure:
            raise RuntimeError(failure)
        self.skills.append(skill_code)
        _log("execute_skill", length=len(skill_code))
        return VirtuosoResult(output=skill_code)

    def run_shell_command(self, cmd: str, timeout: float | None = None) -> VirtuosoResult:
        _log("run_shell_command", length=len(cmd))
        return VirtuosoResult(output=cmd)

    def upload_file(self, local_path: object, remote_path: object, timeout: float | None = None) -> VirtuosoResult:
        _log("upload_file")
        return VirtuosoResult(output=str(remote_path))

    def download_file(
        self,
        remote_path: object,
        local_path: object,
        timeout: float | None = None,
        recursive: bool = False,
    ) -> VirtuosoResult:
        _log("download_file")
        try:
            from pathlib import Path

            Path(str(local_path)).write_text("fixture\n", encoding="utf-8")
        except OSError:
            pass
        return VirtuosoResult(output=str(remote_path))


class SpectreSimulator:
    def __init__(self, *args: object, **kwargs: object) -> None:
        self.args = args
        self.kwargs = kwargs


class SpectrePool:
    def __init__(self, *args: object, **kwargs: object) -> None:
        self.args = args
        self.kwargs = kwargs


class SanitizingClient:
    def __init__(self, client: object = None, *args: object, **kwargs: object) -> None:
        self.client = client


def connect(*args: object, **kwargs: object) -> VirtuosoClient:
    """Package-level shortcut used by some scripts; never used by the runner."""
    return VirtuosoClient.from_env(**kwargs)


__all__ = [
    "SanitizingClient",
    "SpectrePool",
    "SpectreSimulator",
    "VirtuosoClient",
    "VirtuosoResult",
    "connect",
]
