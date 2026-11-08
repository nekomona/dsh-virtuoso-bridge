#!/usr/bin/env python3
"""Detect which Cadence environment shell exposes Virtuoso.

The bridge sources ``VB_CADENCE_CSHRC`` through either csh or a POSIX sh
(``VB_CADENCE_ENV_SHELL``).  Sites usually document only one variant; this
probe sources the configured script under both shells and reports which one
ends with ``virtuoso`` on PATH (or with a Virtuoso-related environment
variable).  It never changes the script and never prints its contents.

Invoked by the DSH Host with the plugin venv python; JSON goes to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
_VENDOR_SRC = _THIS.parent.parent / "virtuoso-bridge-lite" / "src"
if os.environ.get("VB_FORCE_VENDOR_SRC") == "1" and _VENDOR_SRC.is_dir() and str(_VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(_VENDOR_SRC))

PROBE = (
    'if command -v virtuoso >/dev/null 2>&1; then echo VB_VIRTUOSO_FOUND; '
    'elif env | grep -qi virtuoso; then echo VB_VIRTUOSO_ENV; '
    'else echo VB_VIRTUOSO_MISSING; fi'
)


def _isolate_env() -> None:
    try:
        from virtuoso_bridge.env import set_runtime_env_file

        data_dir = Path(os.environ.get("VB_PLUGIN_DATA_DIR") or _THIS.parent.parent)
        data_dir.mkdir(parents=True, exist_ok=True)
        empty = data_dir / "empty.env"
        if not empty.exists():
            empty.write_text("# intentionally empty: the DSH plugin owns VB_* values\n", encoding="utf-8")
        set_runtime_env_file(empty)
    except Exception:
        pass


def run_one(script: str, shell: str, profile: str | None, timeout: int) -> dict:
    from virtuoso_bridge.cadence_env import CadenceEnvironment

    try:
        wrapped = CadenceEnvironment(script, shell).wrap(PROBE)
    except Exception as exc:  # noqa: BLE001 - report to the Host
        return {"shell": shell, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    from virtuoso_bridge.transport.tunnel import SSHClient, _is_localhost

    try:
        ssh = SSHClient.from_env(keep_remote_files=True, profile=profile)
    except Exception as exc:  # noqa: BLE001
        return {"shell": shell, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    try:
        if _is_localhost(getattr(ssh, "remote_host", "") or ""):
            try:
                proc = subprocess.run(
                    ["sh", "-c", wrapped],
                    capture_output=True,
                    text=True,
                    timeout=timeout,
                )
                rc, out, err = proc.returncode, proc.stdout, proc.stderr
            except subprocess.TimeoutExpired:
                return {"shell": shell, "ok": False, "error": f"probe timed out after {timeout}s"}
        else:
            result = ssh.run_command(wrapped, timeout=timeout)
            rc, out, err = result.returncode, result.stdout, result.stderr
        marker = "VB_VIRTUOSO_FOUND" if "VB_VIRTUOSO_FOUND" in out else (
            "VB_VIRTUOSO_ENV" if "VB_VIRTUOSO_ENV" in out else (
                "VB_VIRTUOSO_MISSING" if "VB_VIRTUOSO_MISSING" in out else ""
            )
        )
        return {
            "shell": shell,
            "ok": rc == 0 and bool(marker) and marker != "VB_VIRTUOSO_MISSING",
            "found": marker in ("VB_VIRTUOSO_FOUND", "VB_VIRTUOSO_ENV"),
            "returncode": rc,
            "marker": marker or None,
            "stdout": out.strip()[-4000:],
            "stderr": err.strip()[-4000:],
        }
    except Exception as exc:  # noqa: BLE001
        return {"shell": shell, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        try:
            ssh.close()
        except Exception:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=os.environ.get("VB_RUNTIME_PROFILE") or None)
    parser.add_argument("--script", default=os.environ.get("VB_CADENCE_CSHRC") or "")
    parser.add_argument("--timeout", type=int, default=35)
    parser.add_argument("--shells", default="csh,sh")
    args = parser.parse_args()
    _isolate_env()
    script = str(args.script or "").strip()
    if not script:
        print(
            json.dumps(
                {
                    "ok": False,
                    "reason": "no Cadence environment script is configured (set the connection's environment script)",
                    "results": {},
                    "recommended": None,
                }
            ),
            flush=True,
        )
        return 0
    shells = [item.strip() for item in args.shells.split(",") if item.strip() in ("csh", "sh")]
    results = {shell: run_one(script, shell, args.profile, args.timeout) for shell in shells}
    found = [shell for shell, result in results.items() if result.get("found")]
    recommended = "csh" if "csh" in found else (found[0] if found else None)
    output = {
        "ok": bool(found),
        "script": script,
        "results": results,
        "found": found,
        "recommended": recommended,
        "ambiguous": len(found) > 1,
    }
    print(json.dumps(output), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
