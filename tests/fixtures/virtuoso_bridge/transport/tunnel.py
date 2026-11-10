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
    """Minimal tunnel object; every network path is a deterministic no-op."""

    def __init__(self, *, port: int = 65432, remote_host: str = "fixture.invalid") -> None:
        self.port = int(port)
        self.remote_host = remote_host
        self.setup_path = os.environ.get("VB_STUB_SETUP_PATH") or "/fixture/work/virtuoso_setup.il"
        self.remote_work_dir = "/fixture/work"
        self.warmed = False
        self._shared_setup = ""
        self._discover_instances = os.environ.get("VB_STUB_DISCOVER") == "1"
        self._ssh_runner = None  # fixture deployments are local
        self.instance_record = None
        self.expected_work_dir = ""
        self.instances: list[dict] = []

    @classmethod
    def from_env(
        cls,
        *,
        keep_remote_files: bool = False,
        profile: str | None = None,
        selected_port: int | None = None,
        replace_setup: bool = False,
    ) -> "SSHClient":
        # The real client calls this while parsing VB_* values; the fixture
        # reproduces it so tests can observe whether the plugin neutralised the
        # user's ~/.virtuoso-bridge/.env before the client is constructed.
        from virtuoso_bridge.env import load_vb_env

        load_vb_env()
        _log(
            "ssh_from_env",
            profile=profile,
            selected_port=selected_port,
            scratch=os.environ.get("VB_REMOTE_SCRATCH_ROOT", ""),
        )
        port = selected_port or int(os.environ.get("VB_STUB_PORT", "65432"))
        return cls(port=port)

    def warm(self, timeout: int = 15) -> None:
        _log("ssh_warm", timeout=timeout)
        self.warmed = True

    def ensure_local_setup(self) -> None:
        _log("ensure_local_setup")

    def ensure_remote_setup(self) -> None:
        _log("ensure_remote_setup")

    def list_instances(self, *, timeout: float | None = None) -> list[dict]:
        _log("list_instances", timeout=timeout)
        return list(self.instances)

    def run_command(self, command: str, timeout: float | None = None) -> object:
        _log("run_command", length=len(command))
        return type("CommandResult", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def close(self) -> None:
        _log("ssh_close")
