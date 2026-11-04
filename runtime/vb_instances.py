#!/usr/bin/env python3
"""List discoverable Virtuoso daemon instances for a configured profile.

Read-only: does not select, provision, deploy, or start a tunnel.  Used by the
DSH configuration page for automatic-session connections.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="default")
    parser.add_argument("--instance-port", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=20.0)
    parser.add_argument("--env-file", default="")
    args = parser.parse_args()
    try:
        from virtuoso_bridge.env import set_runtime_env_file

        set_runtime_env_file(Path(args.env_file) if args.env_file else None)
        from virtuoso_bridge.transport.tunnel import SSHClient

        selected_port = args.instance_port if args.instance_port else None
        ssh = SSHClient.from_env(
            keep_remote_files=True,
            profile=args.profile,
            selected_port=selected_port,
        )
        try:
            rows = ssh.list_instances(timeout=args.timeout)
            payload = {
                "ok": True,
                "autoSessions": bool(getattr(ssh, "_discover_instances", False)),
                "instances": rows,
                "selected": getattr(ssh, "instance_record", None),
                "expectedWorkDir": getattr(ssh, "expected_work_dir", ""),
                "setupPath": getattr(ssh, "setup_path", None),
            }
        finally:
            ssh.close()
    except Exception as error:  # noqa: BLE001 - report discovery failures as data
        payload = {"ok": False, "error": f"{type(error).__name__}: {error}"}
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
