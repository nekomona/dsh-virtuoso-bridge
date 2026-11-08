#!/usr/bin/env python3
"""Stop one virtuoso-bridge tunnel/profile that is not owned by a live sidecar.

Used by the DSH plugin's runtime manager to clean up an orphaned SSH tunnel
left behind by an earlier session or a crashed sidecar.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

# Use the package installed in the plugin venv; the setup manager owns source
# selection.  VB_FORCE_VENDOR_SRC is an explicit diagnostic escape hatch.
if os.environ.get("VB_FORCE_VENDOR_SRC") == "1":
    _VENDOR_SRC = Path(__file__).resolve().parent.parent / "virtuoso-bridge-lite" / "src"
    if _VENDOR_SRC.is_dir() and str(_VENDOR_SRC) not in sys.path:
        sys.path.insert(0, str(_VENDOR_SRC))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    args = parser.parse_args()
    result = {"profile": args.profile, "stopped": False}
    try:
        from virtuoso_bridge.transport.tunnel import SSHClient

        running = SSHClient.is_running(args.profile)
        result["wasRunning"] = running
        ssh = SSHClient.from_env(keep_remote_files=True, profile=args.profile)
        ssh.stop()
        result["stopped"] = True
    except Exception as exc:  # noqa: BLE001 - report to the Host
        result["error"] = f"{type(exc).__name__}: {exc}"
        result["traceback"] = traceback.format_exc()[-4000:]
        print(json.dumps(result), flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
