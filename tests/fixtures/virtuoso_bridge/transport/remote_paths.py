"""``virtuoso_bridge.transport.remote_paths`` fixture: no network, no chmod."""

from __future__ import annotations

import os

from virtuoso_bridge.env import load_vb_env


def remote_scratch_root() -> str:
    # Upstream calls this on every read so a discovered .env can override the
    # process environment; the fixture reproduces the call for the isolation
    # assertions.
    load_vb_env()
    return os.environ.get("VB_REMOTE_SCRATCH_ROOT", "/tmp").rstrip("/")


def sanitize_username_for_path(username: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(username).strip())
    return cleaned[:64] or "unknown"


def sanitize_client_id_for_path(client_id: str) -> str:
    cleaned = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in str(client_id).strip())
    return cleaned[:64] or "unknown_client"


def resolve_client_id(profile: str | None = None) -> str:
    suffix = f"_{profile}" if profile else ""
    value = os.environ.get(f"VB_CLIENT_ID{suffix}", "").strip() or os.environ.get("VB_CLIENT_ID", "").strip()
    return sanitize_client_id_for_path(value or "fixture-client")


def resolve_remote_username(*, configured_user: str | None, runner: object = None, fallback: str = "unknown") -> str:
    if configured_user and str(configured_user).strip():
        return sanitize_username_for_path(str(configured_user))
    return fallback


def default_virtuoso_bridge_dir(username: str, leaf: str, client_id: str | None = None) -> str:
    root = remote_scratch_root()
    safe = sanitize_username_for_path(username)
    leaf_norm = leaf.strip("/").replace("\\", "/")
    if client_id:
        safe_client = sanitize_client_id_for_path(client_id)
        return f"{root}/virtuoso_bridge_{safe}/{safe_client}/{leaf_norm}"
    return f"{root}/virtuoso_bridge_{safe}/{leaf_norm}"


def instance_scratch_root(runner: object = None) -> str:
    root = remote_scratch_root()
    if root == "/tmp":
        return "/tmp/virtuoso_bridge_fixture"
    return root


def private_dir_shell_prelude(label: str) -> str:
    return f'printf %s "vb_ensure_dir-for-{label}"\n'


def private_dirs_below(root: str, path: str) -> list[str]:
    root = root.rstrip("/") or "/"
    path = path.rstrip("/")
    prefix = root if root.endswith("/") else root + "/"
    if not path.startswith(prefix):
        raise ValueError(f"{path!r} is not below {root!r}")
    parts = [part for part in path[len(prefix):].split("/") if part]
    return [prefix + "/".join(parts[: index + 1]) for index in range(len(parts))]
