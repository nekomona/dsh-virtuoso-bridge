"""``virtuoso_bridge.transport.tunnel`` fixture: an SSHClient that never dials."""

from __future__ import annotations

import os


def _log(kind: str, **fields: object) -> None:
    path = os.environ.get("VB_STUB_CALL_LOG", "").strip()
    if not path:
        return
    import json

    try:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"kind": kind, "pid": os.getpid(), **fields}, sort_keys=True) + "\n")
    except OSError:
        pass


class SSHClient:
    """Minimal tunnel object; ``port`` is fixed so tests stay deterministic."""

    def __init__(self, *, port: int = 65432, remote_host: str = "fixture.invalid") -> None:
        self.port = int(port)
        self.remote_host = remote_host
        self.setup_path = None
        self.warmed = False

    @classmethod
    def from_env(
        cls,
        *,
        keep_remote_files: bool = False,
        profile: str | None = None,
        selected_port: int | None = None,
    ) -> "SSHClient":
        _log("ssh_from_env", profile=profile, selected_port=selected_port)
        port = selected_port or int(os.environ.get("VB_STUB_PORT", "65432"))
        return cls(port=port)

    def warm(self, timeout: int = 15) -> None:
        _log("ssh_warm", timeout=timeout)
        self.warmed = True

    def close(self) -> None:
        _log("ssh_close")
