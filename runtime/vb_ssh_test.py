"""Probe one configured virtuoso-bridge SSH login without starting a daemon.

This runs inside the plugin venv and uses the same SSHClient/backend selection
as the bridge itself, so a Paramiko connection never launches ssh.exe.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_THIS = Path(__file__).resolve()
_RUNTIME_DIR = _THIS.parent
if str(_RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(_RUNTIME_DIR))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="default")
    parser.add_argument("--env-file", default="")
    parser.add_argument("--timeout", type=int, default=20)
    args = parser.parse_args()
    try:
        # Isolate the upstream .env loader so another local installation cannot
        # change the host, port or scratch root this test reports on.
        from vb_plugin_env import isolate_runtime_env

        isolate_runtime_env(args.env_file)
        from virtuoso_bridge.transport.tunnel import SSHClient

        ssh = SSHClient.from_env(keep_remote_files=True, profile=args.profile)
        try:
            result = ssh.run_command("true", timeout=max(1, args.timeout))
            payload = {
                "ok": result.returncode == 0,
                "returncode": result.returncode,
                "stdout": result.stdout[-4000:],
                "stderr": result.stderr[-4000:],
                "backend": getattr(getattr(ssh, "config", None), "ssh_backend", None),
            }
        finally:
            ssh.close()
    except Exception as error:  # noqa: BLE001 - report transport failures as data
        payload = {
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "backend": None,
        }
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
