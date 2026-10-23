#!/usr/bin/env python3
"""Read SSH host keys through Paramiko.

Used for Paramiko-backed connections so no OpenSSH console process is
launched.  This is a read-only probe: it never writes known_hosts.

Outputs a JSON object with an ``entries`` list (target first, then the jump
host when one is configured).  Each entry carries the host spec, key type,
base64 blob, and SHA-256 fingerprint.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys


def _entry(host: str, port: int, key) -> dict:
    blob = base64.b64encode(key.asbytes()).decode("ascii")
    digest = hashlib.sha256(key.asbytes()).digest()
    fingerprint = "SHA256:" + base64.b64encode(digest).decode("ascii").rstrip("=")
    hostspec = host if port == 22 else f"[{host}]:{port}"
    return {
        "host": host,
        "hostSpec": hostspec,
        "port": port,
        "type": key.get_name(),
        "key": blob,
        "fingerprint": fingerprint,
    }


def _probe_direct(host: str, port: int, timeout: float) -> list[dict]:
    import paramiko

    transport = paramiko.Transport((host, port))
    transport.banner_timeout = timeout
    try:
        transport.start_client(timeout=timeout)
        return [_entry(host, port, transport.get_remote_server_key())]
    finally:
        transport.close()


def _probe_jump(
    host: str,
    port: int,
    jump_host: str,
    jump_port: int,
    jump_user: str | None,
    timeout: float,
) -> list[dict]:
    import paramiko

    jump = paramiko.SSHClient()
    jump.load_system_host_keys()
    # The jump key is reported as an explicit entry; accepting it in memory
    # lets us reach the target without writing it to the real known_hosts.
    jump.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    target_transport = None
    try:
        jump.connect(
            hostname=jump_host,
            port=jump_port,
            username=jump_user,
            timeout=timeout,
            banner_timeout=timeout,
            auth_timeout=timeout,
            allow_agent=True,
            look_for_keys=True,
        )
        jump_transport = jump.get_transport()
        if jump_transport is None:
            raise RuntimeError("jump transport is not available")
        jump_key = jump_transport.get_remote_server_key()
        channel = jump_transport.open_channel(
            "direct-tcpip",
            (host, port),
            ("127.0.0.1", 0),
            timeout=timeout,
        )
        target_transport = paramiko.Transport(channel)
        target_transport.banner_timeout = timeout
        target_transport.start_client(timeout=timeout)
        target_key = target_transport.get_remote_server_key()
        return [_entry(host, port, target_key), _entry(jump_host, jump_port, jump_key)]
    finally:
        try:
            target_transport.close()
        except Exception:
            pass
        jump.close()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--jump-host", default="")
    parser.add_argument("--jump-port", type=int, default=22)
    parser.add_argument("--jump-user", default="")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    try:
        if args.jump_host:
            entries = _probe_jump(
                args.host,
                args.port,
                args.jump_host,
                args.jump_port,
                args.jump_user or None,
                args.timeout,
            )
        else:
            entries = _probe_direct(args.host, args.port, args.timeout)
        print(json.dumps({"ok": True, "entries": entries}), flush=True)
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
