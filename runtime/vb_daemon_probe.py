#!/usr/bin/env python3
"""Classify what answers the bridge capability handshake behind a tunnel.

Shared by the runtime sidecar (attach-before-deploy) and the read-only health
helper (Test Connection), so both report the same daemon states:

  ready        - a current bridge daemon (possibly unsigned/auth off)
  auth         - a bridge daemon that refuses our token
  legacy       - something answers, but not with signed capabilities
  no-listener  - the forwarded remote port refused/reset the connection
  timeout      - the endpoint accepted but never answered (indeterminate)
  unreachable  - no local forwarded port / another socket failure

The probe is side-effect free at protocol level: one ``op=hello`` request with
no ``skill`` field. It never creates a daemon token.
"""

from __future__ import annotations

import json
import secrets
import socket
import time
from typing import Any


def preview_bytes(raw: bytes, limit: int = 240) -> str:
    return raw[:limit].decode("utf-8", errors="replace")


def auth_is_off(value: Any) -> bool:
    """Daemon capability ``auth`` value meaning authentication is disabled."""
    if value is None:
        return False
    if value is False:
        return True
    return str(value).strip().lower() in ("off", "false", "disabled", "no", "0")


def probe_tunnel_daemon(port: int, token: str | None, timeout: float = 10.0) -> dict[str, Any]:
    """Probe a bridge daemon on a local forwarded port."""
    probe: dict[str, Any] = {
        "state": "unknown",
        "port": int(port or 0),
        "checkedAt": time.time(),
    }
    if not probe["port"]:
        probe.update(state="unreachable", message="the tunnel has no local port")
        return probe
    try:
        from virtuoso_bridge import daemon_auth

        proto = daemon_auth.PROTOCOL_VERSION
        nonce = secrets.token_hex(16)
        payload: dict[str, Any] = {"proto": proto, "nonce": nonce, "op": "hello"}
        if token:
            payload["mac"] = daemon_auth.hello_mac(token, nonce=nonce)
    except Exception as exc:  # noqa: BLE001
        probe.update(state="unknown", message=f"cannot build hello: {type(exc).__name__}: {exc}")
        return probe
    budget = max(3.0, min(float(timeout or 10), 15.0))
    deadline = time.monotonic() + budget
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(budget)
            sock.connect(("127.0.0.1", probe["port"]))
            sock.sendall(json.dumps(payload).encode("utf-8"))
            sock.shutdown(socket.SHUT_WR)
            chunks: list[bytes] = []
            received = 0
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise socket.timeout("capability probe deadline expired")
                sock.settimeout(remaining)
                chunk = sock.recv(65536)
                if not chunk:
                    break
                received += len(chunk)
                chunks.append(chunk)
                if received > 1_000_000:
                    break
        raw = b"".join(chunks)
    except (socket.timeout, TimeoutError) as exc:
        probe.update(state="timeout", message=f"{type(exc).__name__}: {exc}")
        return probe
    except OSError as exc:
        code = getattr(exc, "winerror", None) or getattr(exc, "errno", None)
        text = f"{type(exc).__name__}: {exc}"
        # OpenSSH -L accepts the local connection and then aborts it when the
        # remote port has no listener: Windows reports WSAECONNABORTED (10053)
        # or WSAECONNRESET (10054), POSIX ECONNRESET/ECONNREFUSED.
        if code in (10053, 10054, 10061, 104, 111):
            probe.update(state="no-listener", message=text, socketCode=code)
        else:
            probe.update(state="unreachable", message=text, socketCode=code)
        return probe
    if raw[:1] == b"\x02":
        body = raw[1:]
        try:
            from virtuoso_bridge import daemon_auth

            if token and daemon_auth.looks_like_hex_mac(body):
                body = daemon_auth.verify_response_bytes(raw, token, nonce)[1:]
                probe["signed"] = True
            else:
                probe["signed"] = False
        except Exception as exc:  # noqa: BLE001 - auth/handshake mismatch
            probe.update(state="auth", message=f"capability response failed authentication: {type(exc).__name__}: {exc}")
            return probe
        try:
            caps = json.loads(body.decode("utf-8", errors="ignore"))
        except Exception:  # noqa: BLE001 - answered but unparseable
            probe.update(state="legacy", message="the daemon answered the capability handshake with non-JSON data", preview=preview_bytes(raw))
            return probe
        if isinstance(caps, dict):
            probe["build"] = caps.get("build")
            probe["auth"] = caps.get("auth")
            probe["protocol"] = caps.get("proto")
            if caps.get("instance_record"):
                probe["instanceRecord"] = caps.get("instance_record")
        probe.update(state="ready")
        return probe
    if raw[:1] == b"\x15":
        message = raw[1:].decode("utf-8", errors="ignore").strip()[:600]
        probe["message"] = message
        probe.update(state="auth" if message.startswith("AuthError") else "legacy")
        return probe
    if not raw:
        probe.update(state="legacy", message="the daemon closed the capability handshake without answering")
        return probe
    probe.update(state="legacy", message="the daemon did not answer the bridge capability handshake", preview=preview_bytes(raw))
    return probe


__all__ = ["auth_is_off", "preview_bytes", "probe_tunnel_daemon"]
