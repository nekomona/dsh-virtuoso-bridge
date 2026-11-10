#!/usr/bin/env python3
"""Deploy the generated Virtuoso daemon bootstrap for one connection.

Runs in the plugin venv.  This prepares/uploads the account bootstrap but does
not start a tunnel, connect a daemon, or load anything into a running CIW.
The returned load line must be loaded explicitly in the intended idle CIW.
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
    parser.add_argument("--instance-port", type=int, default=0)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--env-file", default="")
    args = parser.parse_args()
    ssh = None
    try:
        # Import the plugin helper before ``virtuoso_bridge``: it points the
        # upstream .env loader at this plugin's empty env file so another local
        # installation (~/.virtuoso-bridge/.env) cannot replace the values the
        # plugin derived from the saved connection.
        from vb_plugin_env import isolate_runtime_env, prepare_scratch_root, resolve_scratch_root

        isolate_runtime_env(args.env_file)
        from virtuoso_bridge.transport.tunnel import SSHClient
        from virtuoso_bridge.virtuoso.ops import escape_skill_string

        selected_port = args.instance_port if args.instance_port else None
        ssh = SSHClient.from_env(
            keep_remote_files=True,
            profile=args.profile,
            selected_port=selected_port,
            replace_setup=args.replace,
        )
        scratch = resolve_scratch_root(ssh, args.profile)
        # A deploy writes into the configured scratch root; prepare it exactly
        # like a runtime start so a permissive pre-existing directory (or a
        # symlinked one) does not make the publisher refuse an otherwise
        # writable directory.
        prepared = prepare_scratch_root(ssh, args.profile)
        scratch = prepared.get("root", scratch)
        shared = str(getattr(ssh, "_shared_setup", "") or "")
        if shared:
            payload = {
                "ok": True,
                "shared": True,
                "autoSessions": bool(getattr(ssh, "_discover_instances", False)),
                "setupPath": shared,
                "loadLine": 'load("%s")' % escape_skill_string(shared),
                "remoteScratchRoot": scratch,
                "scratchRoot": scratch,
                "scratchPrepared": bool(prepared.get("prepared")),
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
                # Show the root that was actually used, next to the configured
                # value, so a deployment path can never silently disagree with
                # the connection's remoteScratchRoot.
                "remoteScratchRoot": scratch,
                "scratchRoot": scratch,
                "scratchPrepared": bool(prepared.get("prepared")),
                "scratchWarning": prepared.get("warning"),
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
