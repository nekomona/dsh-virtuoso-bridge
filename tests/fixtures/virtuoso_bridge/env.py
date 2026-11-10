"""``virtuoso_bridge.env`` fixture that models the upstream ``.env`` override.

The real loader walks upward and falls back to ``~/.virtuoso-bridge/.env`` with
``override=True``. This stand-in reproduces that behaviour for a temporary HOME
so tests can prove the plugin's empty runtime env file neutralises it.
"""

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
    _log("set_runtime_env_file", path=str(_ACTIVE), exists=_ACTIVE.exists())


def active_env_file() -> Path | None:
    return _ACTIVE


def _ambient_values() -> dict[str, str]:
    env_path = Path(os.environ.get("HOME") or os.environ.get("USERPROFILE") or Path.home()) / ".virtuoso-bridge" / ".env"
    values: dict[str, str] = {}
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            text = line.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, _, value = text.partition("=")
            values[key.strip()] = value.strip()
    except OSError:
        pass
    return values


def load_vb_env(*_args: object, **_kwargs: object) -> None:
    if _ACTIVE is not None:
        _log("load_vb_env", target=str(_ACTIVE), applied=False)
        return
    applied = _ambient_values()
    os.environ.update(applied)
    _log("load_vb_env", target="", applied=True, keys=sorted(applied))
