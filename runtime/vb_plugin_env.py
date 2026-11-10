#!/usr/bin/env python3
"""Plugin-owned runtime environment, remote scratch roots and health checks.

Three problems this module solves for every helper that imports
``virtuoso_bridge``:

* The upstream client calls ``load_vb_env(override=True)``, which walks upward
  from the current directory and falls back to ``~/.virtuoso-bridge/.env``.
  A second virtuoso-bridge installation keeps its settings there, so the
  plugin's already-derived ``VB_*`` values were silently replaced and a deploy
  went to the other installation's scratch root. ``isolate_runtime_env`` points
  that loader at the plugin's empty env file so the load is a no-op.

* A configured remote scratch root is a precondition for deployment. The
  upstream code assumes the root already exists (it only creates directories
  *below* it), so a missing root produced a misleading "set a writable
  directory" refusal. ``prepare_scratch_root`` resolves the real path, creates
  a missing root that lives under the account home (mode 0700), tightens a
  permissive user-owned root, and reports distinct causes for a symlink, wrong
  owner, non-directory or a path outside the home.

* A deployment failure must name its cause. ``classify_deployment_failure``
  turns the flattened upstream message into a code, the offending path and an
  actionable hint so the dashboard, tools and logs can say "the root does not
  exist, create it with ..." instead of "set a directory only you can write".

Only the Python standard library is imported at module load: ``virtuoso_bridge``
is imported lazily after :func:`isolate_runtime_env` has run.
"""

from __future__ import annotations

import os
import re
import shlex
from pathlib import Path

_THIS = Path(__file__).resolve()
_PLUGIN_DIR = _THIS.parent.parent
EMPTY_ENV_TEXT = "# intentionally empty: the DSH plugin owns VB_* values\n"


class ScratchRootError(RuntimeError):
    """A scratch-root problem with a stable code and an operator hint."""

    def __init__(self, code: str, message: str, *, path: str = "", hint: str = "", details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.path = path
        self.hint = hint
        self.details = details or {}


def plugin_data_dir() -> Path:
    raw = os.environ.get("VB_PLUGIN_DATA_DIR", "").strip()
    return Path(raw) if raw else _PLUGIN_DIR


def empty_env_file() -> Path:
    data_dir = plugin_data_dir()
    data_dir.mkdir(parents=True, exist_ok=True)
    empty = data_dir / "empty.env"
    # Rewrite every time: upstream may persist a deconflicted remote port into
    # whichever runtime env file is active. Keeping this file empty guarantees
    # the next run still ignores the user's ~/.virtuoso-bridge/.env.
    empty.write_text(EMPTY_ENV_TEXT, encoding="utf-8")
    return empty


def isolate_runtime_env(env_file: str | Path | None = None) -> Path:
    """Make the upstream ``.env`` discovery load nothing.

    An explicit ``env_file`` from the caller wins, but an empty value means
    "use the plugin's empty env file": passing no file would let the user's
    ``~/.virtuoso-bridge/.env`` override this connection again.
    """
    from virtuoso_bridge.env import set_runtime_env_file

    requested = str(env_file or "").strip()
    path = Path(requested) if requested else empty_env_file()
    set_runtime_env_file(path)
    return path


def _runner(ssh) -> object | None:
    """The runner that owns bridge files (deployment side when split)."""
    for name in ("deployment_runner", "ssh_runner"):
        runner = getattr(ssh, name, None)
        if runner is not None:
            return runner
    return None


def _profile_suffix(profile: str | None) -> str:
    return f"_{profile}" if profile else ""


def _set_scratch_root(value: str, profile: str | None) -> None:
    os.environ["VB_REMOTE_SCRATCH_ROOT"] = value
    os.environ[f"VB_REMOTE_SCRATCH_ROOT{_profile_suffix(profile)}"] = value


def _home_local() -> str:
    return str(Path.home())


def _home_remote(runner) -> str:
    result = runner.run_command(
        'getent passwd "$(id -u)" | cut -d: -f6 2>/dev/null || printf %s "$HOME"'
    )
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    home = lines[-1] if lines else ""
    if getattr(result, "returncode", 1) or not home.startswith("/"):
        detail = (getattr(result, "stderr", "") or "").strip()
        raise RuntimeError(
            "Cannot resolve the remote account home: "
            f"{home or detail or 'no output'} (host key verification, login or a broken remote HOME)"
        )
    return home.rstrip("/")


def remote_home(ssh_or_runner) -> str:
    """The remote account home for an SSH client or one of its runners."""
    runner = ssh_or_runner if hasattr(ssh_or_runner, "run_command") else _runner(ssh_or_runner)
    if runner is None:
        return _home_local()
    return _home_remote(runner)


def _remote_uid(runner) -> str:
    result = runner.run_command("id -u 2>/dev/null || true")
    return next((line.strip() for line in (result.stdout or "").splitlines() if line.strip()), "")


def _canonical_local(path: str) -> str:
    return str(Path(path).expanduser().resolve())

def _canonical_remote(runner, path: str) -> str:
    quoted = shlex.quote(path)
    result = runner.run_command(
        f"readlink -f -- {quoted} 2>/dev/null || realpath -- {quoted} 2>/dev/null || printf '%s\\n' {quoted}"
    )
    lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
    return lines[-1] if lines else path


def resolve_scratch_root(ssh=None, profile: str | None = None) -> str:
    """Expand and canonicalise ``VB_REMOTE_SCRATCH_ROOT`` for this runtime.

    Returns the root that deployment will actually use (empty when unset, which
    means the upstream default ``/tmp``). The environment is rewritten so every
    later helper sees the same absolute path.
    """
    value = os.environ.get("VB_REMOTE_SCRATCH_ROOT", "").strip()
    if not value:
        return ""
    runner = _runner(ssh) if ssh is not None else None
    home = _home_remote(runner) if runner is not None else _home_local()
    if value == "~" or value.startswith("~/"):
        value = home.rstrip("/") + value[1:]
    if runner is None:
        # Local mode: the root lives on this machine, so use local path rules.
        if not os.path.isabs(value) and not value.startswith("\\"):
            # Remote POSIX paths are still accepted: local deployments ignore
            # the scratch root and never convert it to a filesystem path.
            if not value.startswith("/"):
                raise ScratchRootError(
                    "scratch-root-invalid",
                    f"The remote scratch root must be an absolute path or start with ~/: {value!r}",
                    path=value,
                    hint="Use an absolute remote path or a ~/ path.",
                )
            resolved = value.rstrip("/") or "/"
        else:
            resolved = _canonical_local(value)
    else:
        if not value.startswith("/"):
            raise ScratchRootError(
                "scratch-root-invalid",
                f"The remote scratch root must be an absolute path or start with ~/: {value!r}",
                path=value,
                hint="Use an absolute remote path or a ~/ path.",
            )
        resolved = _canonical_remote(runner, value)
        if not resolved.startswith("/"):
            raise ScratchRootError(
                "scratch-root-unresolved",
                f"Cannot resolve the remote scratch root {value!r}",
                path=value,
                hint="Use a real absolute path; check for a typo in the configured root.",
            )
    _set_scratch_root(resolved, profile)
    return resolved


def _parse_path_report(stdout: str) -> dict:
    values: dict[str, str] = {}
    for line in (stdout or "").splitlines():
        key, _, value = line.partition(" ")
        if key and key.isupper():
            values[key] = value.strip()
    return {
        "kind": values.get("KIND", "UNKNOWN"),
        "owner": values.get("OWNER", ""),
        "mode": values.get("MODE", ""),
        "parent": values.get("PARENT", ""),
        "parentKind": values.get("PARENTKIND", ""),
        "writable": values.get("WRITABLE") == "yes",
        "parentWritable": values.get("PARENTWRITABLE") == "yes",
    }


def inspect_path(runner, path: str) -> dict:
    """Read-only state of a remote path and its parent (never creates anything)."""
    quoted = shlex.quote(path)
    script = f"""p={quoted}
if [ -L "$p" ]; then kind=SYMLINK
elif [ -d "$p" ]; then kind=DIR
elif [ -e "$p" ]; then kind=NOTDIR
else kind=MISSING
fi
owner= mode=
if [ "$kind" = DIR ] || [ "$kind" = NOTDIR ]; then
  if stat -c '%u %a' "$p" >/dev/null 2>&1; then set -- $(stat -c '%u %a' "$p"); owner=$1; mode=$2
  elif stat -f '%u %Lp' "$p" >/dev/null 2>&1; then set -- $(stat -f '%u %Lp' "$p"); owner=$1; mode=$2
  fi
fi
parent=${{p%/*}}; [ "$parent" = "$p" ] && parent=/
if [ -L "$parent" ]; then parentkind=SYMLINK
elif [ -d "$parent" ]; then parentkind=DIR
elif [ -e "$parent" ]; then parentkind=NOTDIR
else parentkind=MISSING
fi
writable=no; [ -w "$p" ] && writable=yes
parentwritable=no; [ -w "$parent" ] && parentwritable=yes
printf 'KIND %s\\nOWNER %s\\nMODE %s\\nPARENT %s\\nPARENTKIND %s\\nWRITABLE %s\\nPARENTWRITABLE %s\\n' \\
  "$kind" "$owner" "$mode" "$parent" "$parentkind" "$writable" "$parentwritable"
"""
    result = runner.run_command(script)
    report = _parse_path_report(result.stdout or "")
    report["path"] = path
    report["returncode"] = getattr(result, "returncode", 0)
    report["stderr"] = (getattr(result, "stderr", "") or "").strip()
    return report


def _sibling_suggestion(runner, path: str, home: str) -> str:
    parent = path.rsplit("/", 1)[0] or "/"
    base = path.rsplit("/", 1)[-1]
    if parent != home or not base:
        return ""
    candidates = []
    if "_" in base:
        candidates.append(base.replace("_", "-"))
    if "-" in base:
        candidates.append(base.replace("-", "_"))
    for candidate in candidates:
        if candidate == base:
            continue
        target = parent.rstrip("/") + "/" + candidate
        result = runner.run_command(f"[ -e {shlex.quote(target)} ] && printf '%s' {shlex.quote(target)}")
        value = (result.stdout or "").strip()
        if value:
            return value
    return ""


def _under_home(path: str, home: str) -> bool:
    prefix = home.rstrip("/") + "/"
    return path != home and path.startswith(prefix)


def _prepare_one(runner, path: str, home: str, *, uid: str, label: str, allow_outside_home: bool = False) -> dict:
    info = inspect_path(runner, path)
    kind = info.get("kind")
    if kind == "SYMLINK":
        raise ScratchRootError(
            "scratch-root-symlink",
            f"The {label} root is a symlink: {path}",
            path=path,
            hint="Point remoteScratchRoot at the real directory (the plugin resolves symlinks before deployment).",
        )
    if kind == "NOTDIR":
        raise ScratchRootError(
            "scratch-root-not-directory",
            f"The {label} root is not a directory: {path}",
            path=path,
            hint="Move the existing file away or choose another remoteScratchRoot.",
        )
    if kind not in ("DIR", "MISSING", "SYMLINK", "NOTDIR"):
        detail = info.get("stderr") or "unexpected path inspection output"
        raise ScratchRootError(
            "scratch-root-inspect",
            f"Cannot inspect the {label} root {path}: {detail}",
            path=path,
            hint="Check that the remote shell can run `stat` on the path and that HOME is resolvable.",
        )
    if kind == "MISSING":
        if not _under_home(path, home) and not allow_outside_home:
            raise ScratchRootError(
                "scratch-root-missing",
                f"The {label} root does not exist: {path}",
                path=path,
                hint=f"Create it first with `mkdir -p -m 700 {path}`, or set remoteScratchRoot to an existing directory.",
            )
        quoted = shlex.quote(path)
        create = runner.run_command(f"umask 077; mkdir -p -m 700 {quoted}")
        if getattr(create, "returncode", 0) != 0:
            detail = (getattr(create, "stderr", "") or getattr(create, "stdout", "") or "").strip()
            raise ScratchRootError(
                "scratch-root-create-failed",
                f"Cannot create the {label} root {path}: {detail or 'mkdir failed'}",
                path=path,
                hint=f"Create it manually with `mkdir -p -m 700 {path}`, or choose a different remoteScratchRoot.",
            )
        info = inspect_path(runner, path)
        kind = info.get("kind")
        if kind != "DIR":
            raise ScratchRootError(
                "scratch-root-create-failed",
                f"The {label} root was not created as a directory: {path}",
                path=path,
                hint="Inspect the path and its parent; a file or symlink may be blocking it.",
            )
        info["created"] = True
    owner = str(info.get("owner") or "")
    mode = str(info.get("mode") or "")
    if owner and uid and owner != uid:
        raise ScratchRootError(
            "scratch-root-owner",
            f"The {label} root is owned by uid {owner}, not you (uid {uid}): {path}",
            path=path,
            hint="Use a directory owned by your account, or ask the owner to change it; the bridge never chowns a path.",
        )
    if mode:
        try:
            numeric = int(mode, 8)
        except ValueError:
            numeric = 0
        if numeric and numeric != 0o700:
            quoted = shlex.quote(path)
            chmod = runner.run_command(f"chmod 700 {quoted}")
            if getattr(chmod, "returncode", 0) != 0:
                detail = (getattr(chmod, "stderr", "") or getattr(chmod, "stdout", "") or "").strip()
                raise ScratchRootError(
                    "scratch-root-mode",
                    f"The {label} root is mode {mode}, not 0700: {path}",
                    path=path,
                    hint=f"Run `chmod 700 {path}` on the remote host.",
                )
            info["tightened"] = True
            info["mode"] = "700"
    if not info.get("writable"):
        raise ScratchRootError(
            "scratch-root-not-writable",
            f"The {label} root is not writable: {path}",
            path=path,
            hint=f"Check ownership and `chmod 700 {path}` on the remote host.",
        )
    return info


def ensure_scratch_root(ssh, profile: str | None = None) -> dict:
    """Resolve and prepare the remote scratch root used by a deployment.

    Fixed legacy deployments use the root directly (the upstream code creates
    only directories *below* it), so the root itself must be created too.
    Automatic sessions publish into ``instance_scratch_root(root)``.
    """
    from virtuoso_bridge.transport.remote_paths import instance_scratch_root

    configured = os.environ.get("VB_REMOTE_SCRATCH_ROOT", "").strip()
    root = resolve_scratch_root(ssh, profile)
    runner = _runner(ssh)
    discover = bool(getattr(ssh, "_discover_instances", False))
    info = {
        "configured": configured,
        "root": root,
        "effectiveRoot": root or "/tmp",
        "automatic": discover,
        "prepared": False,
        "created": False,
        "tightened": False,
        "warning": None,
        "suggestion": None,
    }
    if runner is None:
        # Local mode deploys into the plugin state directory.
        return info
    home = _home_remote(runner)
    uid = _remote_uid(runner)
    prepare_root = instance_scratch_root(runner) if discover else (root or "/tmp")
    info["home"] = home
    info["uid"] = uid
    info["prepareRoot"] = prepare_root
    if prepare_root in ("/", home):
        if prepare_root == home:
            info["warning"] = (
                "remoteScratchRoot points at the account home; use a dedicated directory "
                "such as ~/.virtuoso-bridge"
            )
        return info
    if prepare_root == "/tmp":
        # The shared upstream default; upstream creates /tmp/virtuoso_bridge_<user>.
        return info
    try:
        allow_outside_home = discover and root in ("", "/tmp") and prepare_root.startswith("/tmp/")
        prepared = _prepare_one(
            runner,
            prepare_root,
            home,
            uid=uid,
            label="scratch" if not discover else "publish",
            allow_outside_home=allow_outside_home,
        )
    except ScratchRootError as error:
        error.details.update(info)
        error.details["resolve"] = info
        raise
    info.update(
        prepared=bool(prepared),
        created=bool(prepared.get("created")),
        tightened=bool(prepared.get("tightened")),
        prepareRoot=prepare_root,
        mode=prepared.get("mode"),
        owner=prepared.get("owner"),
    )
    if prepared.get("created"):
        sibling = _sibling_suggestion(runner, prepare_root, home)
        if sibling:
            info["suggestion"] = sibling
            info["warning"] = (
                f"The configured scratch root did not exist and was created. Found a similar path "
                f"{sibling!r}; check for a '_' vs '-' typo if that was the intended directory."
            )
        else:
            info["warning"] = "The configured scratch root did not exist and was created with mode 0700."
    resolved = _canonical_remote(runner, prepare_root) if discover else prepare_root
    if discover:
        info["publishRoot"] = resolved
        if root and root != "/tmp":
            # Automatic publish uses the configured root itself; keep the
            # canonical name in the environment.
            _set_scratch_root(resolved, profile)
            info["root"] = resolved
            info["effectiveRoot"] = resolved
        info["workDir"] = resolved + "/daemon"
    else:
        info["root"] = resolved
        info["effectiveRoot"] = resolved
        _set_scratch_root(resolved, profile)
        info["workDir"] = resolved
    return info


def prepare_scratch_root(ssh, profile: str | None = None) -> dict:
    """Backward-compatible wrapper around :func:`ensure_scratch_root`."""
    return ensure_scratch_root(ssh, profile)


def classify_deployment_failure(error: Exception, info: dict | None = None) -> dict:
    """Structured cause and hint for a deployment failure."""
    info = info or {}
    if isinstance(error, ScratchRootError):
        return {
            "code": error.code,
            "message": str(error),
            "path": error.path,
            "hint": error.hint,
            "details": error.details,
        }
    text = str(error)
    lower = text.lower()
    root = str(info.get("prepareRoot") or info.get("root") or info.get("effectiveRoot") or "")
    home = str(info.get("home") or "")
    result = {
        "code": "deployment-failed",
        "message": text,
        "path": root,
        "hint": "",
        "details": info,
    }
    if "no such file or directory" in lower or "enoent" in lower:
        result.update(
            code="scratch-root-missing",
            hint=(
                f"The scratch root or one of its parents is missing. Create it with "
                f"`mkdir -p -m 700 {root or '~/.virtuoso-bridge'}`, or check for a '_' vs '-' typo "
                "in remoteScratchRoot."
            ),
        )
        if root and home and root.startswith(home.rstrip("/") + "/"):
            result["hint"] += " A similar path may exist with '_' or '-' swapped."
    elif "is a symlink" in lower or "symlink" in lower:
        result.update(code="scratch-root-symlink", hint="Configure the real directory instead of the symlink.")
    elif "wrong owner" in lower or "owned by" in lower:
        result.update(code="scratch-root-owner", hint="Use a directory owned by your remote account.")
    elif "not private" in lower or "mode" in lower and "0700" in lower:
        result.update(code="scratch-root-mode", hint=f"Run `chmod 700 {root or '<root>'}` on the remote host.")
    elif "unsafe directory ancestor" in lower:
        result.update(
            code="scratch-root-ancestor",
            hint="An ancestor of the scratch root is group/world-writable or owned by another user; choose a private parent.",
        )
    elif "not readable on the" in lower:
        result.update(
            code="deployment-split-host-visibility",
            hint="Set VB_REMOTE_SCRATCH_ROOT to a path visible to the deployment, GUI and daemon hosts.",
        )
    elif "differs at" in lower or "replace-setup" in lower or "already exists" in lower:
        result.update(code="bundle-conflict", hint="Review the remote bundle version, then use replace=true only after confirming.")
    elif "failed to upload" in lower:
        result.update(code="upload-failed", hint="Check the remote scratch path permissions and available space.")
    elif "cannot resolve the remote scratch root" in lower:
        result.update(code="scratch-root-unresolved", hint="Use an absolute remote path or a ~/ path.")
    elif re.search(r"python3?: eval|syntax error near unexpected token", lower):
        result.update(
            code="publisher-python",
            hint=(
                "The remote python used by the account publisher is not a normal interpreter. "
                "Put a real python3 first on the remote PATH, or use a shared install-daemon setup."
            ),
        )
    else:
        result["hint"] = "Inspect the runtime panel log for the remote command output."
    return result


__all__ = [
    "EMPTY_ENV_TEXT",
    "ScratchRootError",
    "classify_deployment_failure",
    "empty_env_file",
    "ensure_scratch_root",
    "inspect_path",
    "isolate_runtime_env",
    "plugin_data_dir",
    "prepare_scratch_root",
    "remote_home",
    "resolve_scratch_root",
]
