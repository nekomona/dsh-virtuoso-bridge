#!/usr/bin/env python3
"""Read-only health report for one saved connection.

Reports what each layer really proves instead of only "SSH login succeeded":

  ssh           TCP reachability, host-key verification, authentication
  remotePython  whether the account can find a usable python3/python
  scratchRoot   configured/resolved scratch root, existence, mode, ownership
  daemon        what answers the configured daemon port (signed capabilities)

Nothing here deploys, creates the scratch root, selects an instance or writes
daemon state. The daemon probe uses a temporary forwarded port supplied by the
Host so it never reuses or stops the runtime's own tunnel.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_THIS = Path(__file__).resolve()
_RUNTIME_DIR = _THIS.parent
if str(_RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(_RUNTIME_DIR))

from vb_plugin_env import (  # noqa: E402 - path is set up above
    ScratchRootError,
    inspect_path,
    isolate_runtime_env,
    plugin_tunnel_config,
    remote_home,
    resolve_scratch_root,
)


def _result(value: dict, output: dict) -> dict:
    output.update(value)
    return output


def _remote_python(runner, timeout: float) -> dict:
    script = (
        'for c in python3 python; do '
        'p=$(command -v "$c" 2>/dev/null) || continue; '
        'v=$("$p" -V 2>&1 | head -1); '
        'printf \'%s\\t%s\\t%s\\n\' "$c" "$p" "$v"; '
        'done'
    )
    result = runner.run_command(script, timeout=timeout)
    interpreters = []
    for line in (result.stdout or "").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].strip().startswith("/"):
            interpreters.append(
                {
                    "command": parts[0].strip(),
                    "path": parts[1].strip(),
                    "version": (parts[2].strip() if len(parts) > 2 else ""),
                }
            )
    selected = interpreters[0] if interpreters else None
    return {
        "ok": bool(selected),
        "interpreters": interpreters,
        "selected": selected,
        "detail": (
            f"{selected['command']} {selected['version']} ({selected['path']})"
            if selected
            else "no python3/python on the remote PATH"
        ),
    }


def _scratch_report(ssh, profile: str, timeout: float) -> dict:
    from vb_plugin_env import _runner

    configured = os.environ.get("VB_REMOTE_SCRATCH_ROOT", "").strip()
    try:
        root = resolve_scratch_root(ssh, profile)
    except ScratchRootError as error:
        return {
            "ok": False,
            "configured": configured,
            "resolved": "",
            "exists": False,
            "error": str(error),
            "code": error.code,
            "hint": error.hint,
        }
    except Exception as error:  # noqa: BLE001
        return {
            "ok": False,
            "configured": configured,
            "resolved": "",
            "exists": False,
            "error": f"{type(error).__name__}: {error}",
        }
    effective = root or "/tmp"
    runner = _runner(ssh)
    if runner is None:
        return {"ok": True, "configured": configured, "resolved": effective, "local": True, "exists": True}
    try:
        home = remote_home(ssh)
        report = inspect_path(runner, effective)
    except Exception as error:  # noqa: BLE001
        return {
            "ok": False,
            "configured": configured,
            "resolved": effective,
            "exists": False,
            "error": f"{type(error).__name__}: {error}",
        }
    kind = report.get("kind")
    exists = kind == "DIR"
    info = {
        "ok": exists and bool(report.get("writable")),
        "configured": configured,
        "resolved": effective,
        "exists": exists,
        "isDir": exists,
        "isSymlink": kind == "SYMLINK",
        "owner": report.get("owner"),
        "mode": report.get("mode"),
        "writable": bool(report.get("writable")),
        "parent": report.get("parent"),
        "parentExists": report.get("parentKind") == "DIR",
        "parentWritable": bool(report.get("parentWritable")),
        "home": home,
    }
    if not exists:
        info["error"] = (
            f"the scratch root does not exist: {effective}"
            if kind == "MISSING"
            else f"the scratch root is not a directory ({kind}): {effective}"
        )
        if kind == "MISSING" and home and effective.startswith(home.rstrip("/") + "/"):
            info["hint"] = (
                f"The deploy will create it with mode 0700. To create it yourself: "
                f"`mkdir -p -m 700 {effective}`; check for a '_' vs '-' typo if this was unintended."
            )
        else:
            info["hint"] = f"Create it with `mkdir -p -m 700 {effective}` or choose an existing directory."
    elif not info["writable"]:
        info["hint"] = f"The root exists but is not writable; check ownership and `chmod 700 {effective}`."
    return info


def _daemon_report(ssh, port: int, timeout: float) -> dict:
    """Probe a Host-owned forwarded daemon port; never deploy or select.

    The plugin never asks this helper to create a forward.  Without the
    plugin-tunnel switch there is no Host-owned forward to probe, so the helper
    reports ``no-forward`` instead of falling back to upstream's detached
    ``ssh.exe`` tunnel.
    """
    from vb_daemon_probe import probe_tunnel_daemon

    if not port:
        return {
            "checked": False,
            "state": "no-port",
            "summary": "automatic sessions: no fixed daemon port; use Discover instances",
        }
    if plugin_tunnel_config() is None:
        return {
            "checked": True,
            "state": "no-forward",
            "port": port,
            "remotePort": port,
            "summary": "no Host-owned tunnel is available for this daemon probe",
        }
    token = None
    token_error = None
    try:
        token = ssh.read_daemon_token()
    except Exception as error:  # noqa: BLE001
        token_error = f"{type(error).__name__}: {error}"
    started = time.monotonic()
    try:
        ssh.ensure_tunnel()
    except Exception as error:  # noqa: BLE001
        return {
            "checked": True,
            "state": "unreachable",
            "port": port,
            "error": f"{type(error).__name__}: {error}",
            "elapsedMs": round((time.monotonic() - started) * 1000),
        }
    try:
        probe = probe_tunnel_daemon(getattr(ssh, "port", 0), token, timeout)
        if token_error:
            probe["tokenError"] = token_error
        probe["remotePort"] = port
        probe["checked"] = True
        probe["elapsedMs"] = round((time.monotonic() - started) * 1000)
        return probe
    finally:
        try:
            runner = ssh._require_runner()
            runner.stop_port_forward()
        except Exception:  # noqa: BLE001 - best effort cleanup
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="default")
    parser.add_argument("--env-file", default="")
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--local-port", type=int, default=0)
    parser.add_argument("--instance-port", type=int, default=0)
    args = parser.parse_args()
    payload: dict = {
        "ok": False,
        "profile": args.profile,
        "checks": {},
        "startedAt": time.time(),
    }
    ssh = None
    try:
        isolate_runtime_env(args.env_file)
        profile = args.profile
        suffix = f"_{profile}" if profile else ""
        if args.local_port and plugin_tunnel_config() is None:
            # Standalone use may still choose a local port for the SSH helper;
            # it must never override an adopted Host tunnel.
            os.environ[f"VB_LOCAL_PORT{suffix}"] = str(args.local_port)
            os.environ["VB_LOCAL_PORT"] = str(args.local_port)
        probe_port = args.instance_port or args.port
        if probe_port:
            os.environ[f"VB_REMOTE_PORT{suffix}"] = str(probe_port)
            os.environ["VB_REMOTE_PORT"] = str(probe_port)
        from virtuoso_bridge.transport.tunnel import SSHClient

        ssh = SSHClient.from_env(keep_remote_files=True, profile=profile)
        runner = getattr(ssh, "deployment_runner", None) or getattr(ssh, "ssh_runner", None)
        started = time.monotonic()
        ssh_check: dict = {"ok": False, "backend": None}
        try:
            ssh_check["backend"] = getattr(ssh, "ssh_backend", None)
        except Exception:  # noqa: BLE001
            pass
        try:
            result = ssh.run_command("true", timeout=max(5, min(args.timeout, 20)))
            ssh_check.update(
                ok=getattr(result, "returncode", 1) == 0,
                returncode=getattr(result, "returncode", 1),
                elapsedMs=round((time.monotonic() - started) * 1000),
                detail="SSH login succeeded" if getattr(result, "returncode", 1) == 0 else (getattr(result, "stderr", "") or "").strip()[-1200:],
            )
        except Exception as error:  # noqa: BLE001
            ssh_check.update(
                ok=False,
                elapsedMs=round((time.monotonic() - started) * 1000),
                error=f"{type(error).__name__}: {error}",
                detail="SSH login failed",
            )
        payload["checks"]["ssh"] = ssh_check
        if ssh_check["ok"] and runner is not None:
            try:
                payload["checks"]["remotePython"] = _remote_python(runner, max(5, min(args.timeout, 15)))
            except Exception as error:  # noqa: BLE001
                payload["checks"]["remotePython"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
            try:
                payload["checks"]["scratchRoot"] = _scratch_report(ssh, profile, args.timeout)
            except Exception as error:  # noqa: BLE001
                payload["checks"]["scratchRoot"] = {
                    "ok": False,
                    "configured": os.environ.get("VB_REMOTE_SCRATCH_ROOT", ""),
                    "error": f"{type(error).__name__}: {error}",
                }
        else:
            payload["checks"]["remotePython"] = {"ok": False, "detail": "skipped: SSH login failed"}
            payload["checks"]["scratchRoot"] = {"ok": False, "detail": "skipped: SSH login failed"}
        if ssh_check["ok"] and runner is not None and not args.instance_port and not args.port:
            try:
                rows = ssh.list_instances(timeout=max(5, min(args.timeout, 15)))
                payload["checks"]["instances"] = {
                    "ok": True,
                    "count": len(rows),
                    "rows": rows,
                }
            except Exception as error:  # noqa: BLE001
                payload["checks"]["instances"] = {"ok": False, "error": f"{type(error).__name__}: {error}"}
        if ssh_check["ok"]:
            try:
                payload["checks"]["daemon"] = _daemon_report(ssh, probe_port, args.timeout)
            except Exception as error:  # noqa: BLE001
                payload["checks"]["daemon"] = {
                    "checked": False,
                    "state": "unknown",
                    "error": f"{type(error).__name__}: {error}",
                }
        else:
            payload["checks"]["daemon"] = {
                "checked": False,
                "state": "unreachable",
                "summary": "skipped: SSH login failed",
            }
        checks = payload["checks"]
        daemon = checks.get("daemon") or {}
        from vb_daemon_probe import auth_is_off

        payload["ok"] = bool(checks.get("ssh", {}).get("ok"))
        payload["ready"] = bool(
            payload["ok"]
            and daemon.get("state") == "ready"
            and (daemon.get("signed") is True or auth_is_off(daemon.get("auth")))
        )
        payload["verdict"] = (
            "ready"
            if payload["ready"]
            else "daemon-not-ready"
            if payload["ok"]
            else "unreachable"
        )
        payload["elapsedMs"] = round((time.time() - payload["startedAt"]) * 1000)
        print(json.dumps(payload))
        return 0
    except Exception as error:  # noqa: BLE001 - report the failure as data
        payload.update(
            ok=False,
            error=f"{type(error).__name__}: {error}",
            verdict="failed",
            elapsedMs=round((time.time() - payload["startedAt"]) * 1000),
        )
        print(json.dumps(payload))
        return 0
    finally:
        if ssh is not None:
            try:
                ssh.close()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    raise SystemExit(main())
