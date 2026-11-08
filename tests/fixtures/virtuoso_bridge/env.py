"""``virtuoso_bridge.env`` fixture: the runner points it at an empty env file."""

from __future__ import annotations

import os
from pathlib import Path

_ACTIVE: Path | None = None


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


def set_runtime_env_file(path: object) -> None:
    """Record the file the runner asks the package to read instead of ``.env``."""
    global _ACTIVE
    _ACTIVE = Path(str(path))
    _log("set_runtime_env_file", exists=_ACTIVE.exists())


def active_env_file() -> Path | None:
    return _ACTIVE


def load_vb_env(*_args: object, **_kwargs: object) -> None:
    _log("load_vb_env")
