#!/usr/bin/env python3
"""Read an SSH host key through Paramiko (used when OpenSSH is absent).

Outputs one JSON object with the offered key type, base64 blob, and SHA-256
fingerprint.  This is a read-only probe: it never writes known_hosts.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    try:
        import paramiko
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"paramiko is not installed: {type(exc).__name__}: {exc}"}), flush=True)
        return 0
    transport = None
    try:
        transport = paramiko.Transport((args.host, args.port))
        transport.banner_timeout = args.timeout
        transport.start_client(timeout=args.timeout)
        key = transport.get_remote_server_key()
        blob = base64.b64encode(key.asbytes()).decode("ascii")
        digest = hashlib.sha256(key.asbytes()).digest()
        fingerprint = "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")
        print(
            json.dumps(
                {
                    "ok": True,
                    "host": args.host,
                    "port": args.port,
                    "type": key.get_name(),
                    "key": blob,
                    "fingerprint": fingerprint,
                }
            ),
            flush=True,
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 0
    finally:
        try:
            transport.close()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
