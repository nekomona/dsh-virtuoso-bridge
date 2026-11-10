#!/usr/bin/env python3
"""Plugin-owned runtime environment and remote scratch-root preparation.

Two problems this module solves for every helper that imports
``virtuoso_bridge``:

* The upstream client calls ``load_vb_env(override=True)``, which walks upward
  from the current directory and falls back to ``~/.virtuoso-bridge/.env``.
  A second virtuoso-bridge installation keeps its settings there, so the
  plugin's already-derived ``VB_*`` values were silently replaced and a deploy
  went to the other installation's scratch root. ``isolate_runtime_env`` points
  that loader at the plugin's empty env file so the load is a no-op.

* ``~/.virtuoso-bridge`` is also a common *remote* scratch root, and a deploy
  requires it to be a private, user-owned directory. When it already exists
  with a permissive mode (or as a symlink) the upstream publisher refuses to
  write even though a plain ``echo`` into the same directory succeeds. The
  plugin therefore resolves the configured root to its real absolute path and
  prepares it as a private directory before deploying.

Only the Python standard library is imported at module load: ``virtuoso_bridge``
is imported lazily after :func:`isolate_runtime_env` has run.
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path

_THIS = Path(__file__).resolve()
_PLUGIN_DIR = _THIS.parent.parent
EMPTY_ENV_TEXT = "# intentionally empty: the DSH plugin owns VB_* values\n"


def plugin_data_dir() -> Path:
    raw = os.environ.get("VB_PLUGIN_DATA_DIR", "").strip()
    return Path(raw) if raw else _PLUGIN_DIR


def empty_env_file() -> Path:
    data_dir = plugin_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    empty = data_dir / "empty.env"
    # Rewrite every time: upstream may persist a deconflicted remote port into
    # whichever runtime env file is active. Keeping this file empty guarantees
    # the next run still ignores the user's ~/.virtuoso-bridge/.env.
    empty.write_text(EMPTY_ENV_TEXT, encoding="utf-8")
    return empty


def isolate_runtime_env(env_file: str | Path | None = None) -> Path:
    """Make the upstream ``.env`` discovery load nothing.

    An explicit ``env_file`` from the caller wins, but an empty value means
    "use the plugin's empty env file": passing no file would let the user's
    ``~/.virtuoso-bridge/.env`` override this connection again.
    """
    from virtuoso_bridge.env import set_runtime_env_file

    requested = str(env_file or "").strip()
    path = Path(requested) if requested else empty_env_file()
    set_runtime_env_file(path)
    return path


def _runner(ssh) -> object | None:
    """The runner that owns bridge files (deployment side when split)."""
    for name in ("deployment_runner", "ssh_runner"):
        runner = getattr(ssh, name, None)
        if runner is not None:
            return runner
    return None


def _profile_suffix(profile: str | None) -> str:
    return f"_{profile}" if profile else ""


def _set_scratch_root(value: str, profile: str | None) -> None:
    os.environ["VB_REMOTE_SCRATCH_ROOT"] = value
    os.environ[f"VB_REMOTE_SCRATCH_ROOT{_profile_suffix(profile)}"] = value


def _home_local() -> str:
    return str(Path.home())


def _home_remote(runner) -> str:
    result = runner.run_command(
        'getent passwd "$(id -u)" | cut -d: -f6 2>/dev/null || printf %s "$HOME"'
    )
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    home = lines[-1] if lines else ""
    if getattr(result, "returncode", 1) or not home.startswith("/"):
        raise RuntimeError(f"Cannot resolve the remote account home: {home or 'no output'}")
    return home.rstrip("/")


def _canonical_local(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def _canonical_remote(runner, path: str) -> str:
    quoted = shlex.quote(path)
    result = runner.run_command(
        f"readlink -f -- {quoted} 2>/dev/null || realpath -- {quoted} 2>/dev/null || printf '%s\\n' {quoted}"
    )
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return lines[-1] if lines else path


def resolve_scratch_root(ssh=None, profile: str | None = None) -> str:
    """Expand and canonicalise ``VB_REMOTE_SCRATCH_ROOT`` for this runtime.

    Returns the root that deployment will actually use (empty when unset, which
    means the upstream default ``/tmp``). The environment is rewritten so every
    later helper sees the same absolute path.
    """
    value = os.environ.get("VB_REMOTE_SCRATCH_ROOT", "").strip()
    if not value:
        return ""
    runner = _runner(ssh) if ssh is not None else None
    home = _home_remote(runner) if runner is not None else _home_local()
    if value == "~" or value.startswith("~/"):
        value = home.rstrip("/") + value[1:]
    if runner is None:
        # Local mode: the root lives on this machine, so use local path rules.
        if not os.path.isabs(value) and not value.startswith("\\"):
            # Remote POSIX paths are still accepted: local deployments ignore
            # the scratch root and never convert it to a filesystem path.
            if not value.startswith("/"):
                raise RuntimeError(
                    "The remote scratch root must be an absolute path or start with ~/: "
                    f"{value!r}"
                )
            resolved = value.rstrip("/") or "/"
        else:
            resolved = _canonical_local(value)
    else:
        if not value.startswith("/"):
            raise RuntimeError(
                "The remote scratch root must be an absolute path or start with ~/: "
                f"{value!r}"
            )
        resolved = _canonical_remote(runner, value)
        if not resolved.startswith("/"):
            raise RuntimeError(f"Cannot resolve the remote scratch root {value!r}")
    _set_scratch_root(resolved, profile)
    return resolved


def _ensure_private_remote_dir(runner, path: str) -> None:
    from virtuoso_bridge.transport.remote_paths import private_dir_shell_prelude

    script = private_dir_shell_prelude("scratch") + f"vb_ensure_dir {shlex.quote(path)}\n"
    result = runner.run_command(script)
    if getattr(result, "returncode", 0) != 0:
        detail = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "").strip()
        raise RuntimeError(
            f"Cannot prepare the remote scratch root {path!r} for deployment: "
            f"{detail or f'exit status {result.returncode}'}. The directory must be yours and "
            "private (mode 700), or set remoteScratchRoot to a dedicated directory you own."
        )


def prepare_scratch_root(ssh, profile: str | None = None) -> dict:
    """Resolve the scratch root and prepare it for an automatic deployment.

    Only the automatic-instance publisher requires the root itself to be a
    private directory; fixed mode creates each directory below the root. When
    the root is the upstream default ``/tmp`` or the account home, it is not
    owned by the bridge and is deliberately left untouched.
    """
    from virtuoso_bridge.transport.remote_paths import instance_scratch_root

    root = resolve_scratch_root(ssh, profile)
    runner = _runner(ssh)
    discover = bool(getattr(ssh, "_discover_instances", False))
    info = {"root": root, "automatic": discover, "prepared": False}
    if runner is None or not discover:
        # Local mode deploys into the plugin state directory; fixed mode creates
        # each directory below the root with vb_ensure_dir.
        return info
    publish_root = instance_scratch_root(runner)
    home = _home_remote(runner)
    info["publishRoot"] = publish_root
    if publish_root in ("/tmp", "/", home):
        # Never tighten /tmp, /, or the account home: upstream must keep those
        # shared. A configured root of home is a configuration mistake the
        # publisher reports; do not chmod it silently.
        if publish_root == home:
            info["warning"] = (
                "remoteScratchRoot points at the account home; use a dedicated directory "
                "such as ~/.virtuoso-bridge"
            )
        return info
    _ensure_private_remote_dir(runner, publish_root)
    resolved = _canonical_remote(runner, publish_root)
    info.update(publishRoot=resolved, prepared=True)
    if root != "/tmp":
        # Keep the upstream default `/tmp` in the environment: upstream derives
        # `/tmp/virtuoso_bridge_<user>` itself for every helper. Rewriting it to
        # that derived path would make other helpers append the user segment a
        # second time.
        _set_scratch_root(resolved, profile)
        info["root"] = resolved
    info["workDir"] = resolved + "/daemon"
    return info


__all__ = [
    "EMPTY_ENV_TEXT",
    "empty_env_file",
    "isolate_runtime_env",
    "plugin_data_dir",
    "prepare_scratch_root",
    "resolve_scratch_root",
]
