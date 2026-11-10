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

from vb_plugin_env import (  # noqa: E402 - path is set up above
    ScratchRootError,
    classify_deployment_failure,
    isolate_runtime_env,
    prepare_scratch_root,
)


def _failure_payload(error: Exception, prepared: dict | None = None) -> dict:
    prepared = prepared or {}
    info = classify_deployment_failure(error, prepared)
    return {
        "ok": False,
        "error": info.get("message") or f"{type(error).__name__}: {error}",
        "errorCode": info.get("code"),
        "path": info.get("path"),
        "hint": info.get("hint"),
        "scratchRoot": prepared.get("root") or prepared.get("effectiveRoot"),
        "resolvedRoot": prepared.get("prepareRoot"),
        "scratchConfigured": prepared.get("configured"),
        "scratchCreated": bool(prepared.get("created")),
        "scratchTightened": bool(prepared.get("tightened")),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="default")
    parser.add_argument("--instance-port", type=int, default=0)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--env-file", default="")
    args = parser.parse_args()
    ssh = None
    prepared: dict = {}
    try:
        # Import the plugin helper before ``virtuoso_bridge``: it points the
        # upstream .env loader at this plugin's empty env file so another local
        # installation (~/.virtuoso-bridge/.env) cannot replace the values the
        # plugin derived from the saved connection.
        isolate_runtime_env(args.env_file)
        from virtuoso_bridge.transport.remote_paths import resolve_client_id
        from virtuoso_bridge.transport.tunnel import SSHClient
        from virtuoso_bridge.virtuoso.ops import escape_skill_string

        selected_port = args.instance_port if args.instance_port else None
        ssh = SSHClient.from_env(
            keep_remote_files=True,
            profile=args.profile,
            selected_port=selected_port,
            replace_setup=args.replace,
        )
        # A deploy writes into the configured scratch root; prepare it exactly
        # like a runtime start so a missing root is created (or explained), a
        # permissive directory is tightened, and a symlink/wrong owner gets its
        # own actionable error instead of a generic "write a directory" refusal.
        prepared = prepare_scratch_root(ssh, args.profile)
        scratch = prepared.get("root") or prepared.get("effectiveRoot") or ""
        auto_sessions = bool(getattr(ssh, "_discover_instances", False))
        try:
            client_id = resolve_client_id(args.profile)
        except Exception:  # noqa: BLE001 - diagnostics must not fail the payload
            client_id = ""
        common = {
            "autoSessions": auto_sessions,
            "remoteScratchRoot": scratch,
            "scratchRoot": scratch,
            "configuredScratchRoot": prepared.get("configured") or "",
            "scratchPrepared": bool(prepared.get("prepared")),
            "scratchCreated": bool(prepared.get("created")),
            "scratchTightened": bool(prepared.get("tightened")),
            "scratchSuggestion": prepared.get("suggestion"),
            "scratchWarning": prepared.get("warning"),
            "clientId": client_id,
            "recommendedAutoSessions": not auto_sessions,
            "guidance": (
                "This is a fixed legacy deployment and is not discoverable by automatic sessions. "
                "Prefer autoSessions with instance discovery, or a shared install-daemon setup, "
                "for deployments that must be reused after a CIW restart."
            )
            if not auto_sessions
            else "",
        }
        shared = str(getattr(ssh, "_shared_setup", "") or "")
        if shared:
            payload = {
                "ok": True,
                "shared": True,
                **common,
                "setupPath": shared,
                "loadLine": 'load("%s")' % escape_skill_string(shared),
                "message": "Shared daemon setup is managed by install-daemon and is never overwritten by a client.",
            }
        else:
            local = getattr(ssh, "_ssh_runner", None) is None
            try:
                if local:
                    ssh.ensure_local_setup()
                else:
                    ssh.ensure_remote_setup()
            except Exception as error:  # noqa: BLE001 - reported as structured data
                print(json.dumps(_failure_payload(error, prepared)))
                return 0
            setup_path = getattr(ssh, "setup_path", None)
            payload = {
                "ok": bool(setup_path),
                "shared": False,
                **common,
                "setupPath": setup_path,
                "loadLine": 'load("%s")' % escape_skill_string(setup_path) if setup_path else None,
                "remoteWorkDir": getattr(ssh, "remote_work_dir", None),
                "replaced": bool(args.replace),
            }
            if not setup_path:
                payload["error"] = "the bridge prepared no setup path"
                payload["errorCode"] = "deployment-no-setup"
                payload["hint"] = "Inspect the runtime log; the bridge did not generate a setup path."
        print(json.dumps(payload))
        return 0
    except ScratchRootError as error:  # noqa: BLE001 - reported as structured data
        print(json.dumps(_failure_payload(error, prepared)))
        return 0
    except Exception as error:  # noqa: BLE001 - report deployment failures as data
        print(json.dumps(_failure_payload(error, prepared)))
        return 0
    finally:
        if ssh is not None:
            try:
                ssh.close()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
