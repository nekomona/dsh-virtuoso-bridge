#!/usr/bin/env python3
"""Plugin-owned runtime environment, remote scratch roots, tunnel adoption and
health checks.

Four problems this module solves for every helper that imports
``virtuoso_bridge``:

* The upstream client calls ``load_vb_env(override=True)``, which walks upward
  from the current directory and falls back to ``~/.virtuoso-bridge/.env``.
  A second virtuoso-bridge installation keeps its settings there, so the
  plugin's already-derived ``VB_*`` values were silently replaced and a deploy
  went to the other installation's scratch root. ``isolate_runtime_env`` points
  that loader at the plugin's empty env file so the load is a no-op.

* A configured remote scratch root is a precondition for deployment. The
  upstream code assumes the root already exists (it only creates directories
  *below* it), so a missing root produced a misleading "set a writable
  directory" refusal. ``prepare_scratch_root`` resolves the real path, creates
  a missing root that lives under the account home (mode 0700), tightens a
  permissive user-owned root, and reports distinct causes for a symlink, wrong
  owner, non-directory or a path outside the home.

* A deployment failure must name its cause. ``classify_deployment_failure``
  turns the flattened upstream message into a code, the offending path and an
  actionable hint so the dashboard, tools and logs can say "the root does not
  exist, create it with ..." instead of "set a directory only you can write".

* The DSH plugin (the JS host) owns the long-lived OpenSSH port forward for a
  remote runtime.  Every Python helper must adopt that process instead of
  asking ``SSHClient`` to spawn a second ``ssh.exe``: ``install_plugin_tunnel``
  monkey-patches the upstream client once, and each ``SSHClient.from_env`` then
  adopts the plugin's PID/local port.  Tunnel liveness is answered from that
  PID, never by TCP-probing the forwarding port.

Only the Python standard library is imported at module load: ``virtuoso_bridge``
is imported lazily after :func:`isolate_runtime_env` has run.
"""

from __future__ import annotations

import os
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

_THIS = Path(__file__).resolve()
_PLUGIN_DIR = _THIS.parent.parent
EMPTY_ENV_TEXT = "# intentionally empty: the DSH plugin owns VB_* values\n"


class ScratchRootError(RuntimeError):
    """A scratch-root problem with a stable code and an operator hint."""

    def __init__(self, code: str, message: str, *, path: str = "", hint: str = "", details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.path = path
        self.hint = hint
        self.details = details or {}


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
    # The plugin-owned tunnel switches itself on through the environment, so the
    # adoption hook is installed here: every helper calls this function before
    # it constructs an SSHClient, and the patch is a no-op without the switch.
    install_plugin_tunnel()
    return path


# --------------------------------------------------------------------------
# Plugin-owned SSH tunnel (the DSH host starts the forward, Python adopts it)
# --------------------------------------------------------------------------
#
# The Host sets these variables for every helper process of a remote runtime:
#
#   VB_PLUGIN_TUNNEL_OWNER       "plugin": the switch (with a positive PID)
#   VB_PLUGIN_TUNNEL_PID         PID of the plugin's long-lived ssh process
#   VB_PLUGIN_TUNNEL_LOCAL_PORT  local port that forward listens on
#   VB_PLUGIN_TUNNEL_REMOTE_PORT remote daemon port the forward targets
#   VB_LOCAL_PORT_<profile>      the same local port (upstream SSHClient reads it)
#   VB_REMOTE_PORT_<profile>     the same remote port
#
# With the switch on, upstream SSHClient must never start or stop an ssh
# process for the tunnel: it adopts the PID, reports liveness from that PID and
# raises instead of starting a replacement.  The Host kills its own process.

PLUGIN_TUNNEL_OWNER_ENV = "VB_PLUGIN_TUNNEL_OWNER"
PLUGIN_TUNNEL_PID_ENV = "VB_PLUGIN_TUNNEL_PID"
PLUGIN_TUNNEL_LOCAL_PORT_ENV = "VB_PLUGIN_TUNNEL_LOCAL_PORT"
PLUGIN_TUNNEL_REMOTE_PORT_ENV = "VB_PLUGIN_TUNNEL_REMOTE_PORT"
PLUGIN_TUNNEL_OWNER_VALUE = "plugin"
PLUGIN_TUNNEL_PATCH_MARKER = "plugin-tunnel-shim-v1"
PLUGIN_TUNNEL_DEAD_MESSAGE = (
    "the DSH plugin tunnel (pid {pid}) is no longer running; restart the runtime"
)


@dataclass(frozen=True)
class PluginTunnel:
    """The plugin-owned OpenSSH forward a Python helper must adopt.

    ``local_port``/``remote_port`` may be ``None`` when the Host omitted them;
    upstream ``SSHClient`` then keeps its own ``VB_LOCAL_PORT``/``VB_REMOTE_PORT``
    values, which the Host sets to the same ports.
    """

    pid: int
    local_port: int | None = None
    remote_port: int | None = None

    def as_dict(self) -> dict:
        return {
            "owner": PLUGIN_TUNNEL_OWNER_VALUE,
            "pid": self.pid,
            "localPort": self.local_port,
            "remotePort": self.remote_port,
        }


def _positive_port(value) -> int | None:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def plugin_tunnel_config() -> PluginTunnel | None:
    """The plugin-owned tunnel this process must adopt, or ``None``.

    The switch is exactly ``VB_PLUGIN_TUNNEL_OWNER=plugin`` plus a positive
    integer ``VB_PLUGIN_TUNNEL_PID``; a missing or malformed PID means "not
    plugin-owned" so a helper can never mistake an empty value for a tunnel.
    """
    owner = os.environ.get(PLUGIN_TUNNEL_OWNER_ENV, "").strip().lower()
    if owner != PLUGIN_TUNNEL_OWNER_VALUE:
        return None
    try:
        pid = int(os.environ.get(PLUGIN_TUNNEL_PID_ENV, "").strip())
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    return PluginTunnel(
        pid=pid,
        local_port=_positive_port(os.environ.get(PLUGIN_TUNNEL_LOCAL_PORT_ENV, "").strip()),
        remote_port=_positive_port(os.environ.get(PLUGIN_TUNNEL_REMOTE_PORT_ENV, "").strip()),
    )


def plugin_tunnel_pid() -> int | None:
    """PID of the plugin-owned ssh process, or ``None`` when it is not in use."""
    config = plugin_tunnel_config()
    return config.pid if config is not None else None


def _pid_is_alive(pid: int) -> bool:
    """Process liveness only: never a TCP probe and never a console event.

    Upstream's own probe is used when it is importable (it already handles the
    Windows ``os.kill(pid, 0)`` trap); the stdlib fallback exists only so the
    switch keeps working if the package layout changes.
    """
    try:
        from virtuoso_bridge.transport.ssh import _pid_is_alive as upstream_pid_is_alive

        return bool(upstream_pid_is_alive(pid))
    except ImportError:
        pass
    try:
        parsed = int(pid)
        if parsed <= 0:
            return False
        if os.name != "nt":
            os.kill(parsed, 0)
            return True
        if parsed > 0xFFFFFFFF:
            return False
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(0x00100000, False, parsed)  # SYNCHRONIZE
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied: do not assume dead.
        try:
            return kernel32.WaitForSingleObject(handle, 0) == 0x00000102  # WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    except PermissionError:
        return True
    except (TypeError, ValueError, OverflowError, OSError):
        return False


def plugin_tunnel_alive(config: PluginTunnel | None = None) -> bool:
    """Whether the plugin-owned ssh process still runs (PID liveness only)."""
    config = config if config is not None else plugin_tunnel_config()
    if config is None:
        return False
    return _pid_is_alive(config.pid)


def plugin_tunnel_report() -> dict | None:
    """Status payload for the runtime panel: the switch, its ports and liveness."""
    config = plugin_tunnel_config()
    if config is None:
        return None
    return {**config.as_dict(), "alive": plugin_tunnel_alive(config)}


def _tunnel_runner(ssh) -> object | None:
    """The runner that owns the daemon/tunnel endpoint.

    Deliberately not :func:`_runner`, which prefers the *deployment* runner:
    tunnel adoption must only touch the daemon-facing runner.
    """
    try:
        runner = getattr(ssh, "ssh_runner", None)
    except Exception:  # noqa: BLE001 - adoption must never fail a client
        runner = None
    if runner is not None:
        return runner
    return getattr(ssh, "_ssh_runner", None)


def _detach_plugin_forward(ssh) -> None:
    """Forget the adopted forward without terminating the plugin's process."""
    runner = _tunnel_runner(ssh)
    if runner is not None and hasattr(runner, "detach_port_forward"):
        runner.detach_port_forward()
    try:
        ssh._tunnel_endpoint = None
    except Exception:  # noqa: BLE001 - fake/partial clients in tests
        pass


def adopt_plugin_tunnel(ssh, config: PluginTunnel | None = None) -> dict | None:
    """Point one ``SSHClient`` at the plugin's forward; never spawn or probe.

    The client's local port becomes the plugin's port (authoritative over
    ``VB_LOCAL_PORT``), the daemon runner records the plugin PID as an
    *external* tunnel, and ``_tunnel_endpoint`` matches it so upstream
    ``is_tunnel_alive`` answers from ``_pid_is_alive`` alone.  No TCP connection
    is attempted and no state file is read.

    Returns the adoption record (also stored on the client as
    ``ssh._vb_plugin_tunnel``), or ``None`` when the switch is absent.
    """
    config = config if config is not None else plugin_tunnel_config()
    if config is None:
        return None
    runner = _tunnel_runner(ssh)
    info: dict = {
        **config.as_dict(),
        "adopted": False,
        "alive": plugin_tunnel_alive(config),
    }
    if runner is None:
        # Local mode has no SSH tunnel; leave the client exactly as upstream built it.
        info["reason"] = "local connection: the runtime has no SSH tunnel"
        try:
            ssh._vb_plugin_tunnel = info
        except Exception:  # noqa: BLE001
            pass
        return info
    local_port = config.local_port
    if local_port is None:
        local_port = _positive_port(getattr(ssh, "_local_port", None))
    if local_port is not None:
        ssh._local_port = int(local_port)
    remote_port = _positive_port(getattr(ssh, "remote_port", None))
    if remote_port is None:
        remote_port = _positive_port(getattr(ssh, "_port", None))
    _detach_plugin_forward(ssh)
    # The setter marks the forward external, so upstream never treats it as a
    # child process it may terminate.
    runner.tunnel_pid = config.pid
    if local_port is not None and remote_port is not None:
        ssh._tunnel_endpoint = (int(local_port), int(remote_port), config.pid)
    info.update(
        adopted=True,
        localPort=local_port,
        remotePort=remote_port,
        declaredRemotePort=config.remote_port,
        remotePortMismatch=(
            config.remote_port is not None
            and remote_port is not None
            and config.remote_port != remote_port
        ),
    )
    try:
        ssh._vb_plugin_tunnel = info
    except Exception:  # noqa: BLE001
        pass
    return info


def _unbound(value):
    """The plain function behind a classmethod/staticmethod descriptor."""
    if isinstance(value, (classmethod, staticmethod)):
        return value.__func__
    return value


def install_plugin_tunnel() -> dict | None:
    """Monkey-patch upstream so every helper adopts the plugin-owned tunnel.

    Idempotent and lazy: ``virtuoso_bridge`` is imported here, never at module
    import time, so a helper can isolate the ``.env`` loader first.  Patching
    the class objects (not a subclass) also covers an editable/vendored source
    checkout.  Returns ``None`` when the environment switch is absent, which is
    the whole contract for local environments and non-tunnel helpers.

    Patches installed (all keyed on the live environment switch, so a process
    that never sees ``VB_PLUGIN_TUNNEL_OWNER=plugin`` keeps upstream behaviour):

    * ``SSHClient.from_env``         adopt PID/local port/endpoint on creation
    * ``SSHClient.ensure_tunnel``    return if the PID is alive, raise if dead
    * ``SSHClient._state_is_live``   answer a matching saved PID without a port poke
    * ``SSHClient.stop``             clear state/close runners, never signal the PID
    * ``SSHRunner.stop_port_forward`` never signal the plugin PID (defence in depth)
    * ``SSHRunner.start_port_forward`` refuse to start a second ssh forward
    """
    config = plugin_tunnel_config()
    if config is None:
        return None
    from virtuoso_bridge.transport.tunnel import SSHClient

    if getattr(SSHClient, "_vb_plugin_tunnel_marker", None) == PLUGIN_TUNNEL_PATCH_MARKER:
        return {**config.as_dict(), "patched": [], "alreadyInstalled": True}

    required = ("from_env", "ensure_tunnel", "_state_is_live", "stop")
    missing = [name for name in required if not hasattr(SSHClient, name)]
    if missing:
        raise RuntimeError(
            "the DSH plugin tunnel shim cannot be installed: "
            f"virtuoso_bridge.SSHClient has no {', '.join(missing)}"
        )
    from virtuoso_bridge.transport.ssh import SSHRunner

    runner_required = ("stop_port_forward", "start_port_forward")
    runner_missing = [name for name in runner_required if not hasattr(SSHRunner, name)]
    if runner_missing:
        raise RuntimeError(
            "the DSH plugin tunnel shim cannot be installed: "
            f"virtuoso_bridge.SSHRunner has no {', '.join(runner_missing)}"
        )

    SSHClient._vb_plugin_original_from_env = _unbound(SSHClient.__dict__["from_env"])
    SSHClient._vb_plugin_original_ensure_tunnel = _unbound(SSHClient.__dict__["ensure_tunnel"])
    SSHClient._vb_plugin_original_state_is_live = _unbound(SSHClient.__dict__["_state_is_live"])
    SSHClient._vb_plugin_original_stop = _unbound(SSHClient.__dict__["stop"])
    SSHRunner._vb_plugin_original_stop_port_forward = _unbound(
        SSHRunner.__dict__["stop_port_forward"]
    )
    SSHRunner._vb_plugin_original_start_port_forward = _unbound(
        SSHRunner.__dict__["start_port_forward"]
    )

    def _plugin_from_env(
        cls,
        *,
        keep_remote_files: bool = False,
        profile: str | None = None,
        selected_port: int | None = None,
        read_selection: bool = True,
        replace_setup: bool = False,
    ):
        client = SSHClient._vb_plugin_original_from_env(
            cls,
            keep_remote_files=keep_remote_files,
            profile=profile,
            selected_port=selected_port,
            read_selection=read_selection,
            replace_setup=replace_setup,
        )
        adopt_plugin_tunnel(client)
        return client

    def _plugin_ensure_tunnel(self) -> None:
        config_now = plugin_tunnel_config()
        if config_now is None or _tunnel_runner(self) is None:
            return SSHClient._vb_plugin_original_ensure_tunnel(self)
        if not plugin_tunnel_alive(config_now):
            raise RuntimeError(PLUGIN_TUNNEL_DEAD_MESSAGE.format(pid=config_now.pid))
        # Refresh the adoption (the daemon port may have changed for automatic
        # sessions) and return: never spawn ssh, never probe the local port.
        adopt_plugin_tunnel(self, config_now)
        return None

    def _plugin_state_is_live(state) -> bool:
        config_now = plugin_tunnel_config()
        if config_now is not None and isinstance(state, dict):
            pid = state.get("tunnel_pid")
            if type(pid) is int and pid == config_now.pid:
                return _plugin_endpoint_state_is_live(state, config_now)
        return SSHClient._vb_plugin_original_state_is_live(state)

    def _plugin_stop(self) -> None:
        config_now = plugin_tunnel_config()
        if config_now is None or _tunnel_runner(self) is None:
            return SSHClient._vb_plugin_original_stop(self)
        # The DSH host owns the ssh process: forget it first so upstream stop()
        # cannot adopt the saved PID again, and the runner guard below ensures
        # nothing signals it.  State and runners are still cleared as usual.
        _detach_plugin_forward(self)
        return SSHClient._vb_plugin_original_stop(self)

    def _plugin_stop_port_forward(self) -> None:
        config_now = plugin_tunnel_config()
        if config_now is not None and getattr(self, "tunnel_pid", None) == config_now.pid:
            self.detach_port_forward()
            return None
        return SSHRunner._vb_plugin_original_stop_port_forward(self)

    def _plugin_start_port_forward(self, port, settle: float = 1.5, *, remote_port=None):
        config_now = plugin_tunnel_config()
        if config_now is not None:
            raise RuntimeError(
                "refusing to start a second SSH tunnel: the DSH plugin owns the "
                f"tunnel (pid {config_now.pid}); restart the runtime"
            )
        return SSHRunner._vb_plugin_original_start_port_forward(
            self, port, settle=settle, remote_port=remote_port
        )

    SSHClient.from_env = classmethod(_plugin_from_env)
    SSHClient.ensure_tunnel = _plugin_ensure_tunnel
    SSHClient._state_is_live = staticmethod(_plugin_state_is_live)
    SSHClient.stop = _plugin_stop
    SSHRunner.stop_port_forward = _plugin_stop_port_forward
    SSHRunner.start_port_forward = _plugin_start_port_forward
    SSHClient._vb_plugin_tunnel_marker = PLUGIN_TUNNEL_PATCH_MARKER
    return {
        **config.as_dict(),
        "patched": [
            "SSHClient.from_env",
            "SSHClient.ensure_tunnel",
            "SSHClient._state_is_live",
            "SSHClient.stop",
            "SSHRunner.stop_port_forward",
            "SSHRunner.start_port_forward",
        ],
        "alreadyInstalled": False,
    }


def _plugin_endpoint_state_is_live(state: dict, config: PluginTunnel) -> bool:
    """Upstream ``_state_is_live`` for the plugin PID, minus the port probe.

    Upstream validates the saved endpoints and the PID liveness *before* it
    calls ``SSHRunner.can_reach_port``; only the port poke is skipped, so a
    dead plugin PID still reports the tunnel as not live.
    """
    if state.get("mode") != "remote":
        return False
    port = state.get("port")
    remote_port = state.get("remote_port")
    pid = state.get("tunnel_pid")
    if any(type(value) is not int for value in (port, remote_port, pid)) or pid <= 0:
        return False
    if not 1 <= port <= 65535 or not 1 <= remote_port <= 65535:
        return False
    if state.get("target"):
        from virtuoso_bridge.transport.tunnel import _state_target_matches

        if not _state_target_matches(state, state["target"]):
            return False
    return plugin_tunnel_alive(config)


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
        detail = (getattr(result, "stderr", "") or "").strip()
        raise RuntimeError(
            "Cannot resolve the remote account home: "
            f"{home or detail or 'no output'} (host key verification, login or a broken remote HOME)"
        )
    return home.rstrip("/")


def remote_home(ssh_or_runner) -> str:
    """The remote account home for an SSH client or one of its runners."""
    runner = ssh_or_runner if hasattr(ssh_or_runner, "run_command") else _runner(ssh_or_runner)
    if runner is None:
        return _home_local()
    return _home_remote(runner)


def _remote_uid(runner) -> str:
    result = runner.run_command("id -u 2>/dev/null || true")
    return next((line.strip() for line in (result.stdout or "").splitlines() if line.strip()), "")


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
                raise ScratchRootError(
                    "scratch-root-invalid",
                    f"The remote scratch root must be an absolute path or start with ~/: {value!r}",
                    path=value,
                    hint="Use an absolute remote path or a ~/ path.",
                )
            resolved = value.rstrip("/") or "/"
        else:
            resolved = _canonical_local(value)
    else:
        if not value.startswith("/"):
            raise ScratchRootError(
                "scratch-root-invalid",
                f"The remote scratch root must be an absolute path or start with ~/: {value!r}",
                path=value,
                hint="Use an absolute remote path or a ~/ path.",
            )
        resolved = _canonical_remote(runner, value)
        if not resolved.startswith("/"):
            raise ScratchRootError(
                "scratch-root-unresolved",
                f"Cannot resolve the remote scratch root {value!r}",
                path=value,
                hint="Use a real absolute path; check for a typo in the configured root.",
            )
    _set_scratch_root(resolved, profile)
    return resolved


def _parse_path_report(stdout: str) -> dict:
    values: dict[str, str] = {}
    for line in (stdout or "").splitlines():
        key, _, value = line.partition(" ")
        if key and key.isupper():
            values[key] = value.strip()
    return {
        "kind": values.get("KIND", "UNKNOWN"),
        "owner": values.get("OWNER", ""),
        "mode": values.get("MODE", ""),
        "parent": values.get("PARENT", ""),
        "parentKind": values.get("PARENTKIND", ""),
        "writable": values.get("WRITABLE") == "yes",
        "parentWritable": values.get("PARENTWRITABLE") == "yes",
    }


def inspect_path(runner, path: str) -> dict:
    """Read-only state of a remote path and its parent (never creates anything)."""
    quoted = shlex.quote(path)
    script = f"""p={quoted}
if [ -L "$p" ]; then kind=SYMLINK
elif [ -d "$p" ]; then kind=DIR
elif [ -e "$p" ]; then kind=NOTDIR
else kind=MISSING
fi
owner= mode=
if [ "$kind" = DIR ] || [ "$kind" = NOTDIR ]; then
  if stat -c '%u %a' "$p" >/dev/null 2>&1; then set -- $(stat -c '%u %a' "$p"); owner=$1; mode=$2
  elif stat -f '%u %Lp' "$p" >/dev/null 2>&1; then set -- $(stat -f '%u %Lp' "$p"); owner=$1; mode=$2
  fi
fi
parent=${{p%/*}}; [ "$parent" = "$p" ] && parent=/
if [ -L "$parent" ]; then parentkind=SYMLINK
elif [ -d "$parent" ]; then parentkind=DIR
elif [ -e "$parent" ]; then parentkind=NOTDIR
else parentkind=MISSING
fi
writable=no; [ -w "$p" ] && writable=yes
parentwritable=no; [ -w "$parent" ] && parentwritable=yes
printf 'KIND %s\\nOWNER %s\\nMODE %s\\nPARENT %s\\nPARENTKIND %s\\nWRITABLE %s\\nPARENTWRITABLE %s\\n' \\
  "$kind" "$owner" "$mode" "$parent" "$parentkind" "$writable" "$parentwritable"
"""
    result = runner.run_command(script)
    report = _parse_path_report(result.stdout or "")
    report["path"] = path
    report["returncode"] = getattr(result, "returncode", 0)
    report["stderr"] = (getattr(result, "stderr", "") or "").strip()
    return report


def _sibling_suggestion(runner, path: str, home: str) -> str:
    parent = path.rsplit("/", 1)[0] or "/"
    base = path.rsplit("/", 1)[-1]
    if parent != home or not base:
        return ""
    candidates = []
    if "_" in base:
        candidates.append(base.replace("_", "-"))
    if "-" in base:
        candidates.append(base.replace("-", "_"))
    for candidate in candidates:
        if candidate == base:
            continue
        target = parent.rstrip("/") + "/" + candidate
        result = runner.run_command(f"[ -e {shlex.quote(target)} ] && printf '%s' {shlex.quote(target)}")
        value = (result.stdout or "").strip()
        if value:
            return value
    return ""


def _under_home(path: str, home: str) -> bool:
    prefix = home.rstrip("/") + "/"
    return path != home and path.startswith(prefix)


def _prepare_one(runner, path: str, home: str, *, uid: str, label: str, allow_outside_home: bool = False) -> dict:
    info = inspect_path(runner, path)
    kind = info.get("kind")
    if kind == "SYMLINK":
        raise ScratchRootError(
            "scratch-root-symlink",
            f"The {label} root is a symlink: {path}",
            path=path,
            hint="Point remoteScratchRoot at the real directory (the plugin resolves symlinks before deployment).",
        )
    if kind == "NOTDIR":
        raise ScratchRootError(
            "scratch-root-not-directory",
            f"The {label} root is not a directory: {path}",
            path=path,
            hint="Move the existing file away or choose another remoteScratchRoot.",
        )
    if kind not in ("DIR", "MISSING", "SYMLINK", "NOTDIR"):
        detail = info.get("stderr") or "unexpected path inspection output"
        raise ScratchRootError(
            "scratch-root-inspect",
            f"Cannot inspect the {label} root {path}: {detail}",
            path=path,
            hint="Check that the remote shell can run `stat` on the path and that HOME is resolvable.",
        )
    if kind == "MISSING":
        if not _under_home(path, home) and not allow_outside_home:
            raise ScratchRootError(
                "scratch-root-missing",
                f"The {label} root does not exist: {path}",
                path=path,
                hint=f"Create it first with `mkdir -p -m 700 {path}`, or set remoteScratchRoot to an existing directory.",
            )
        quoted = shlex.quote(path)
        create = runner.run_command(f"umask 077; mkdir -p -m 700 {quoted}")
        if getattr(create, "returncode", 0) != 0:
            detail = (getattr(create, "stderr", "") or getattr(create, "stdout", "") or "").strip()
            raise ScratchRootError(
                "scratch-root-create-failed",
                f"Cannot create the {label} root {path}: {detail or 'mkdir failed'}",
                path=path,
                hint=f"Create it manually with `mkdir -p -m 700 {path}`, or choose a different remoteScratchRoot.",
            )
        info = inspect_path(runner, path)
        kind = info.get("kind")
        if kind != "DIR":
            raise ScratchRootError(
                "scratch-root-create-failed",
                f"The {label} root was not created as a directory: {path}",
                path=path,
                hint="Inspect the path and its parent; a file or symlink may be blocking it.",
            )
        info["created"] = True
    owner = str(info.get("owner") or "")
    mode = str(info.get("mode") or "")
    if owner and uid and owner != uid:
        raise ScratchRootError(
            "scratch-root-owner",
            f"The {label} root is owned by uid {owner}, not you (uid {uid}): {path}",
            path=path,
            hint="Use a directory owned by your account, or ask the owner to change it; the bridge never chowns a path.",
        )
    if mode:
        try:
            numeric = int(mode, 8)
        except ValueError:
            numeric = 0
        if numeric and numeric != 0o700:
            quoted = shlex.quote(path)
            chmod = runner.run_command(f"chmod 700 {quoted}")
            if getattr(chmod, "returncode", 0) != 0:
                detail = (getattr(chmod, "stderr", "") or getattr(chmod, "stdout", "") or "").strip()
                raise ScratchRootError(
                    "scratch-root-mode",
                    f"The {label} root is mode {mode}, not 0700: {path}",
                    path=path,
                    hint=f"Run `chmod 700 {path}` on the remote host.",
                )
            info["tightened"] = True
            info["mode"] = "700"
    if not info.get("writable"):
        raise ScratchRootError(
            "scratch-root-not-writable",
            f"The {label} root is not writable: {path}",
            path=path,
            hint=f"Check ownership and `chmod 700 {path}` on the remote host.",
        )
    return info


def ensure_scratch_root(ssh, profile: str | None = None) -> dict:
    """Resolve and prepare the remote scratch root used by a deployment.

    Fixed legacy deployments use the root directly (the upstream code creates
    only directories *below* it), so the root itself must be created too.
    Automatic sessions publish into ``instance_scratch_root(root)``.
    """
    from virtuoso_bridge.transport.remote_paths import instance_scratch_root

    configured = os.environ.get("VB_REMOTE_SCRATCH_ROOT", "").strip()
    root = resolve_scratch_root(ssh, profile)
    runner = _runner(ssh)
    discover = bool(getattr(ssh, "_discover_instances", False))
    info = {
        "configured": configured,
        "root": root,
        "effectiveRoot": root or "/tmp",
        "automatic": discover,
        "prepared": False,
        "created": False,
        "tightened": False,
        "warning": None,
        "suggestion": None,
    }
    if runner is None:
        # Local mode deploys into the plugin state directory.
        return info
    home = _home_remote(runner)
    uid = _remote_uid(runner)
    prepare_root = instance_scratch_root(runner) if discover else (root or "/tmp")
    info["home"] = home
    info["uid"] = uid
    info["prepareRoot"] = prepare_root
    if prepare_root in ("/", home):
        if prepare_root == home:
            info["warning"] = (
                "remoteScratchRoot points at the account home; use a dedicated directory "
                "such as ~/.virtuoso-bridge"
            )
        return info
    if prepare_root == "/tmp":
        # The shared upstream default; upstream creates /tmp/virtuoso_bridge_<user>.
        return info
    try:
        allow_outside_home = discover and root in ("", "/tmp") and prepare_root.startswith("/tmp/")
        prepared = _prepare_one(
            runner,
            prepare_root,
            home,
            uid=uid,
            label="scratch" if not discover else "publish",
            allow_outside_home=allow_outside_home,
        )
    except ScratchRootError as error:
        error.details.update(info)
        error.details["resolve"] = info
        raise
    info.update(
        prepared=bool(prepared),
        created=bool(prepared.get("created")),
        tightened=bool(prepared.get("tightened")),
        prepareRoot=prepare_root,
        mode=prepared.get("mode"),
        owner=prepared.get("owner"),
    )
    if prepared.get("created"):
        sibling = _sibling_suggestion(runner, prepare_root, home)
        if sibling:
            info["suggestion"] = sibling
            info["warning"] = (
                f"The configured scratch root did not exist and was created. Found a similar path "
                f"{sibling!r}; check for a '_' vs '-' typo if that was the intended directory."
            )
        else:
            info["warning"] = "The configured scratch root did not exist and was created with mode 0700."
    resolved = _canonical_remote(runner, prepare_root) if discover else prepare_root
    if discover:
        info["publishRoot"] = resolved
        if root and root != "/tmp":
            # Automatic publish uses the configured root itself; keep the
            # canonical name in the environment.
            _set_scratch_root(resolved, profile)
            info["root"] = resolved
            info["effectiveRoot"] = resolved
        info["workDir"] = resolved + "/daemon"
    else:
        info["root"] = resolved
        info["effectiveRoot"] = resolved
        _set_scratch_root(resolved, profile)
        info["workDir"] = resolved
    return info


def prepare_scratch_root(ssh, profile: str | None = None) -> dict:
    """Backward-compatible wrapper around :func:`ensure_scratch_root`."""
    return ensure_scratch_root(ssh, profile)


def classify_deployment_failure(error: Exception, info: dict | None = None) -> dict:
    """Structured cause and hint for a deployment failure."""
    info = info or {}
    if isinstance(error, ScratchRootError):
        return {
            "code": error.code,
            "message": str(error),
            "path": error.path,
            "hint": error.hint,
            "details": error.details,
        }
    text = str(error)
    lower = text.lower()
    root = str(info.get("prepareRoot") or info.get("root") or info.get("effectiveRoot") or "")
    home = str(info.get("home") or "")
    result = {
        "code": "deployment-failed",
        "message": text,
        "path": root,
        "hint": "",
        "details": info,
    }
    if "no such file or directory" in lower or "enoent" in lower:
        result.update(
            code="scratch-root-missing",
            hint=(
                f"The scratch root or one of its parents is missing. Create it with "
                f"`mkdir -p -m 700 {root or '~/.virtuoso-bridge'}`, or check for a '_' vs '-' typo "
                "in remoteScratchRoot."
            ),
        )
        if root and home and root.startswith(home.rstrip("/") + "/"):
            result["hint"] += " A similar path may exist with '_' or '-' swapped."
    elif "is a symlink" in lower or "symlink" in lower:
        result.update(code="scratch-root-symlink", hint="Configure the real directory instead of the symlink.")
    elif "wrong owner" in lower or "owned by" in lower:
        result.update(code="scratch-root-owner", hint="Use a directory owned by your remote account.")
    elif "not private" in lower or "mode" in lower and "0700" in lower:
        result.update(code="scratch-root-mode", hint=f"Run `chmod 700 {root or '<root>'}` on the remote host.")
    elif "unsafe directory ancestor" in lower:
        result.update(
            code="scratch-root-ancestor",
            hint="An ancestor of the scratch root is group/world-writable or owned by another user; choose a private parent.",
        )
    elif "not readable on the" in lower:
        result.update(
            code="deployment-split-host-visibility",
            hint="Set VB_REMOTE_SCRATCH_ROOT to a path visible to the deployment, GUI and daemon hosts.",
        )
    elif "differs at" in lower or "replace-setup" in lower or "already exists" in lower:
        result.update(code="bundle-conflict", hint="Review the remote bundle version, then use replace=true only after confirming.")
    elif "failed to upload" in lower:
        result.update(code="upload-failed", hint="Check the remote scratch path permissions and available space.")
    elif "cannot resolve the remote scratch root" in lower:
        result.update(code="scratch-root-unresolved", hint="Use an absolute remote path or a ~/ path.")
    elif re.search(r"python3?: eval|syntax error near unexpected token", lower):
        result.update(
            code="publisher-python",
            hint=(
                "The remote python used by the account publisher is not a normal interpreter. "
                "Put a real python3 first on the remote PATH, or use a shared install-daemon setup."
            ),
        )
    else:
        result["hint"] = "Inspect the runtime panel log for the remote command output."
    return result


__all__ = [
    "EMPTY_ENV_TEXT",
    "PLUGIN_TUNNEL_DEAD_MESSAGE",
    "PLUGIN_TUNNEL_LOCAL_PORT_ENV",
    "PLUGIN_TUNNEL_OWNER_ENV",
    "PLUGIN_TUNNEL_OWNER_VALUE",
    "PLUGIN_TUNNEL_PID_ENV",
    "PLUGIN_TUNNEL_REMOTE_PORT_ENV",
    "PluginTunnel",
    "ScratchRootError",
    "adopt_plugin_tunnel",
    "classify_deployment_failure",
    "empty_env_file",
    "ensure_scratch_root",
    "inspect_path",
    "install_plugin_tunnel",
    "isolate_runtime_env",
    "plugin_data_dir",
    "plugin_tunnel_alive",
    "plugin_tunnel_config",
    "plugin_tunnel_pid",
    "plugin_tunnel_report",
    "prepare_scratch_root",
    "remote_home",
    "resolve_scratch_root",
]
