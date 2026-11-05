#!/usr/bin/env python3
"""Deploy the generated Virtuoso daemon bootstrap for one connection.

Runs in the plugin venv.  This prepares/uploads the account bootstrap but does
not start a tunnel, connect a daemon, or load anything into a running CIW.
The returned load line must be loaded explicitly in the intended idle CIW.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="default")
    parser.add_argument("--instance-port", type=int, default=0)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--env-file", default="")
    args = parser.parse_args()
    ssh = None
    try:
        from virtuoso_bridge.env import set_runtime_env_file

        set_runtime_env_file(Path(args.env_file) if args.env_file else None)
        from virtuoso_bridge.transport.tunnel import SSHClient
        from virtuoso_bridge.virtuoso.ops import escape_skill_string

        selected_port = args.instance_port if args.instance_port else None
        ssh = SSHClient.from_env(
            keep_remote_files=True,
            profile=args.profile,
            selected_port=selected_port,
            replace_setup=args.replace,
        )
        scratch = os.environ.get("VB_REMOTE_SCRATCH_ROOT", "")
        if scratch.startswith("~/"):
            runner = getattr(ssh, "ssh_runner", None)
            if runner is not None:
                result = runner.run_command('getent passwd "$(id -u)" | cut -d: -f6')
                home = (result.stdout or "").strip()
                if result.returncode or not home.startswith("/"):
                    raise RuntimeError(f"Cannot resolve the remote home for scratch root {scratch!r}")
            else:
                home = str(Path.home())
            resolved = home.rstrip("/") + scratch[1:]
            os.environ["VB_REMOTE_SCRATCH_ROOT"] = resolved
            os.environ[f"VB_REMOTE_SCRATCH_ROOT_{args.profile}"] = resolved
        shared = str(getattr(ssh, "_shared_setup", "") or "")
        if shared:
            payload = {
                "ok": True,
                "shared": True,
                "autoSessions": bool(getattr(ssh, "_discover_instances", False)),
                "setupPath": shared,
                "loadLine": 'load("%s")' % escape_skill_string(shared),
                "message": "Shared daemon setup is managed by install-daemon and is never overwritten by a client.",
            }
        else:
            local = getattr(ssh, "_ssh_runner", None) is None
            if local:
                ssh.ensure_local_setup()
            else:
                ssh.ensure_remote_setup()
            setup_path = getattr(ssh, "setup_path", None)
            payload = {
                "ok": bool(setup_path),
                "shared": False,
                "autoSessions": bool(getattr(ssh, "_discover_instances", False)),
                "setupPath": setup_path,
                "loadLine": 'load("%s")' % escape_skill_string(setup_path) if setup_path else None,
                "remoteWorkDir": getattr(ssh, "remote_work_dir", None),
                "replaced": bool(args.replace),
            }
            if not setup_path:
                payload["error"] = "the bridge prepared no setup path"
        print(json.dumps(payload))
        return 0
    except Exception as error:  # noqa: BLE001 - report deployment failures as data
        print(json.dumps({"ok": False, "error": f"{type(error).__name__}: {error}"}))
        return 0
    finally:
        if ssh is not None:
            try:
                ssh.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
