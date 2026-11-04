#!/usr/bin/env python3
"""virtuoso-bridge sidecar: one long-lived JSON-RPC runtime per connection.

The DSH plugin owns this process.  It keeps the SSH tunnel, the deployed
RamIC daemon handshake and the Python object graph alive between agent tool
calls, so the agent never has to recreate an environment or a tunnel.

Protocol: newline-delimited JSON on stdin/stdout.  One request per line::

    {"id": "1", "method": "connect", "params": {...}}

One response per line::

    {"id": "1", "ok": true, "result": {...}}
    {"id": "1", "ok": false, "error": {"message": "...", "kind": "..."}}

Unsolicited events are emitted as ``{"event": "...", ...}`` and never carry
an ``id``.  stdout is reserved for the protocol; diagnostics go to stderr.

The process is deliberately dependency-free beyond virtuoso-bridge itself:
the plugin installs this directory's sibling ``vendor`` checkout into an
isolated virtual environment and runs this file with that interpreter.
"""

from __future__ import annotations

import argparse
import base64
import dataclasses
import enum
import inspect
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Mapping

_THIS = Path(__file__).resolve()
if os.environ.get("VB_FORCE_VENDOR_SRC") == "1":
    _VENDOR_SRC = _THIS.parent.parent / "vendor" / "src"
    if _VENDOR_SRC.is_dir() and str(_VENDOR_SRC) not in sys.path:
        sys.path.insert(0, str(_VENDOR_SRC))

MAX_INLINE_CHARS = 1_500_000
MAX_DESCRIBE_METHODS = 400
MAX_DESCRIBE_DEPTH = 3

_WRITE_LOCK = threading.Lock()
# The bridge and the daemon client print progress with plain ``print()``.
# Keep a private duplicate of the original stdout for the JSON protocol and
# route fd 1 to stderr so library output can never corrupt a response.
_PROTOCOL_FD: int | None = None


# --------------------------------------------------------------------------
# JSON conversion
# --------------------------------------------------------------------------


def _bytes_payload(value: bytes) -> dict[str, Any]:
    encoded = base64.b64encode(value).decode("ascii")
    if len(encoded) <= 200_000:
        return {"$type": "bytes", "encoding": "base64", "data": encoded, "size": len(value)}
    return {"$type": "bytes", "encoding": "omitted", "size": len(value)}


def jsonable(value: Any, _depth: int = 0, _seen: set[int] | None = None) -> Any:
    """Convert arbitrary bridge results into strict JSON values."""
    if _depth > 12:
        return {"$type": "truncated", "reason": "depth"}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, enum.Enum):
        return jsonable(value.value, _depth + 1)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return _bytes_payload(bytes(value))
    if _seen is None:
        _seen = set()
    marker = id(value)
    if marker in _seen:
        return {"$type": "cycle", "class": type(value).__name__}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        _seen.add(marker)
        try:
            return {
                "$type": type(value).__name__,
                **{
                    field.name: jsonable(getattr(value, field.name), _depth + 1, _seen)
                    for field in dataclasses.fields(value)
                },
            }
        finally:
            _seen.discard(marker)
    if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
        _seen.add(marker)
        try:
            return jsonable(value.model_dump(), _depth + 1, _seen)
        finally:
            _seen.discard(marker)
    if isinstance(value, Mapping):
        _seen.add(marker)
        try:
            return {str(key): jsonable(item, _depth + 1, _seen) for key, item in value.items()}
        finally:
            _seen.discard(marker)
    if isinstance(value, (list, tuple, set, frozenset)):
        _seen.add(marker)
        try:
            return [jsonable(item, _depth + 1, _seen) for item in value]
        finally:
            _seen.discard(marker)
    if inspect.isclass(value) or inspect.ismodule(value) or inspect.isfunction(value):
        return {"$type": "reference", "name": getattr(value, "__qualname__", repr(value))}
    return {"$type": "repr", "class": type(value).__name__, "value": repr(value)[:4000]}


def decode_arg(value: Any) -> Any:
    """Decode explicit markers supplied by the agent for rich Python values."""
    if isinstance(value, list):
        return [decode_arg(item) for item in value]
    if isinstance(value, dict):
        kind = value.get("$type") or value.get("__type__")
        if kind == "bytes":
            data = value.get("data", "")
            return base64.b64decode(data)
        if kind == "path":
            return Path(str(value.get("value", ""))).expanduser()
        if kind == "tuple":
            return tuple(decode_arg(item) for item in value.get("items", []))
        if kind == "set":
            return set(decode_arg(item) for item in value.get("items", []))
        if kind == "none":
            return None
        return {key: decode_arg(item) for key, item in value.items()}
    return value


def _summarize_payload(payload: Any) -> dict[str, Any]:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) <= MAX_INLINE_CHARS:
        return {"payload": payload, "truncated": False}
    target_dir = Path(
        os.environ.get("VB_PLUGIN_CACHE_DIR")
        or os.environ.get("VB_PLUGIN_DATA_DIR", ".")
    ) / "results"
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"result-{int(time.time() * 1000)}-{os.getpid()}.json"
    target.write_text(text, encoding="utf-8")
    preview = text[:120_000]
    return {
        "payload": {
            "$type": "truncated-result",
            "chars": len(text),
            "path": str(target),
            "preview": preview,
            "hint": "Read the full JSON from path with the read tool if needed.",
        },
        "truncated": True,
    }


# --------------------------------------------------------------------------
# Introspection
# --------------------------------------------------------------------------


def _safe_signature(func: Any) -> str:
    try:
        return str(inspect.signature(func))
    except (TypeError, ValueError):
        return "(...)"


def _describe_callable(name: str, func: Any) -> dict[str, Any]:
    doc = inspect.getdoc(func) or ""
    first = doc.strip().splitlines()[0] if doc.strip() else ""
    params = []
    try:
        signature = inspect.signature(func)
        for parameter in signature.parameters.values():
            if parameter.name == "self":
                continue
            default: Any = None
            has_default = parameter.default is not inspect.Parameter.empty
            if has_default and isinstance(parameter.default, (str, int, float, bool, type(None))):
                default = parameter.default
            params.append(
                {
                    "name": parameter.name,
                    "kind": str(parameter.kind).replace("Parameter.", ""),
                    "required": parameter.default is inspect.Parameter.empty,
                    "default": default,
                    "annotation": ""
                    if parameter.annotation is inspect.Parameter.empty
                    else str(parameter.annotation),
                }
            )
    except (TypeError, ValueError):
        pass
    return {
        "name": name,
        "signature": _safe_signature(func),
        "summary": first,
        "doc": doc[:4000],
        "params": params,
    }


def _public_members(obj: Any, *, limit: int = MAX_DESCRIBE_METHODS) -> tuple[list[dict], list[dict]]:
    methods: list[dict] = []
    properties: list[dict] = []
    for name in dir(obj):
        if name.startswith("_"):
            continue
        try:
            value = inspect.getattr_static(obj, name)
        except Exception:
            continue
        if isinstance(value, property):
            doc = inspect.getdoc(value.fget) or ""
            properties.append(
                {
                    "name": name,
                    "type": "property",
                    "summary": doc.strip().splitlines()[0] if doc.strip() else "",
                }
            )
            continue
        try:
            attr = getattr(obj, name)
        except Exception:
            continue
        if callable(attr):
            methods.append(_describe_callable(name, attr))
            if len(methods) >= limit:
                break
    methods.sort(key=lambda item: item["name"])
    properties.sort(key=lambda item: item["name"])
    return methods, properties


def _describe_object(path: str, obj: Any, depth: int, seen: set[int]) -> dict[str, Any]:
    marker = id(obj)
    methods, properties = _public_members(obj)
    doc = (inspect.getdoc(type(obj)) or "").strip().splitlines()
    node: dict[str, Any] = {
        "path": path,
        "class": type(obj).__name__,
        "module": type(obj).__module__,
        "summary": doc[0] if doc else "",
        "methods": methods,
        "properties": properties,
        "children": {},
    }
    if depth <= 1 or marker in seen:
        return node
    seen.add(marker)
    children: dict[str, Any] = {}
    for name in dir(obj):
        if name.startswith("_"):
            continue
        try:
            value = getattr(obj, name)
        except Exception:
            continue
        if value is None or callable(value) or isinstance(value, (str, bytes, int, float, bool)):
            continue
        child_type = type(value).__module__
        if not child_type.startswith("virtuoso_bridge"):
            continue
        children[name] = {"path": f"{path}.{name}", "class": type(value).__name__}
        if depth > 1:
            children[name]["detail"] = _describe_object(f"{path}.{name}", value, depth - 1, seen)
    node["children"] = children
    seen.discard(marker)
    return node


def _describe_class(cls: type) -> dict[str, Any]:
    methods, properties = _public_members(cls)
    constructors = []
    try:
        constructors.append(_describe_callable("__init__", cls.__init__))
    except Exception:
        pass
    doc = (inspect.getdoc(cls) or "").strip().splitlines()
    return {
        "class": cls.__name__,
        "module": cls.__module__,
        "summary": doc[0] if doc else "",
        "constructor": constructors[0] if constructors else None,
        "methods": [item for item in methods if item["name"] not in ("__init__",)],
        "properties": properties,
    }


# --------------------------------------------------------------------------
# Runtime
# --------------------------------------------------------------------------


class RuntimeErrorInfo(Exception):
    pass


class BridgeRuntime:
    def __init__(self, *, profile: str | None, local: bool, timeout: int) -> None:
        self.profile = profile
        self.local = local
        self.timeout = timeout
        self.log_to_ciw = False
        self.client: Any = None
        self.tunnel: Any = None
        self.spectre: Any = None
        self.connect_error: str | None = None
        self.connect_started = 0.0
        self.connect_finished = 0.0
        self.lock = threading.RLock()
        self.started_at = time.time()
        self.last_activity = time.time()
        self.shutting_down = False
        self._imported_at = None
        self._version = None
        self._isolate_env()

    def _isolate_env(self) -> None:
        """Keep the user's ~/.virtuoso-bridge/.env from overriding this connection.

        The Python client calls ``load_vb_env()`` with ``override=True`` while
        constructing transports.  The plugin supplies the selected connection
        through ``VB_*_<profile>`` variables, so the ambient ``.env`` must not
        replace them; an empty runtime env file makes that load a no-op.
        """
        try:
            from virtuoso_bridge.env import set_runtime_env_file

            data_dir = Path(os.environ.get("VB_PLUGIN_DATA_DIR") or _THIS.parent.parent)
            data_dir.mkdir(parents=True, exist_ok=True)
            empty = data_dir / "empty.env"
            if not empty.exists():
                empty.write_text("# intentionally empty: the DSH plugin owns VB_* values\n", encoding="utf-8")
            set_runtime_env_file(empty)
        except Exception:
            # The import itself is reported later by package_info().
            pass

    # -- import / status ----------------------------------------------------

    def package_info(self) -> dict[str, Any]:
        if self._imported_at is None:
            started = time.monotonic()
            import virtuoso_bridge as vb

            self._imported_at = time.monotonic() - started
            self._version = getattr(vb, "__version__", "unknown")
            self._package_file = getattr(vb, "__file__", "")
            self._python = sys.version.split()[0]
        return {
            "version": self._version,
            "python": self._python,
            "packageFile": getattr(self, "_package_file", ""),
            "importSeconds": self._imported_at,
        }

    def _state_file(self) -> Path:
        from virtuoso_bridge.transport.tunnel import state_dir

        suffix = f"_{self.profile}" if self.profile else ""
        candidates = sorted(state_dir().glob(f"state{suffix}*.json"))
        return candidates[-1] if candidates else state_dir() / f"state{suffix}.json"

    def read_state(self) -> dict[str, Any]:
        try:
            path = self._state_file()
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}

    def status(self) -> dict[str, Any]:
        info = self.package_info()
        state = self.read_state()
        result: dict[str, Any] = {
            "pid": os.getpid(),
            "profile": self.profile,
            "local": self.local,
            "startedAt": self.started_at,
            "lastActivity": self.last_activity,
            "connected": self.client is not None,
            "connectError": self.connect_error,
            "connectMs": round((self.connect_finished - self.connect_started) * 1000)
            if self.connect_finished
            else None,
            "package": info,
            "state": {
                key: state.get(key)
                for key in (
                    "mode",
                    "port",
                    "remote_port",
                    "tunnel_pid",
                    "setup_path",
                    "identity_path",
                    "daemon_host",
                    "gui_host",
                    "spectre_host",
                    "remote_user",
                    "started_at",
                    "instance_record",
                    "remote_work_dir",
                    "scratch_root",
                )
            },
            "instances": {
                "autoSessions": bool(getattr(self.tunnel, "_discover_instances", False)) if self.tunnel else None,
                "selected": getattr(self.tunnel, "instance_record", None) if self.tunnel else None,
                "expectedWorkDir": getattr(self.tunnel, "expected_work_dir", "") if self.tunnel else "",
                "setupPath": getattr(self.tunnel, "setup_path", None) if self.tunnel else None,
                "compatibility": getattr(self.tunnel, "daemon_compatibility", None) if self.tunnel else None,
            },
            "stderrTail": _STDERR_TAIL[-40:],
        }
        if self.client is not None:
            result["client"] = {
                "host": getattr(self.client, "host", None),
                "port": getattr(self.client, "port", None),
                "remoteHost": getattr(self.client, "remote_host", None),
                "isRemote": getattr(self.client, "is_remote", None),
                "tunnelAlive": getattr(self.client, "is_tunnel_alive", None),
                "instanceRecord": getattr(self.tunnel, "instance_record", None) if self.tunnel else None,
                "daemonCaps": getattr(self.client, "_daemon_caps", None),
            }
            # A health probe executes SKILL.  Never interleave it with an
            # in-flight API call on the same socket.
            if self.lock.acquire(blocking=False):
                try:
                    result["daemon"] = self.client.verify_tunnel(timeout=5)
                except Exception as exc:  # pragma: no cover - live hardware only
                    result["daemon"] = {"error": str(exc)}
                finally:
                    self.lock.release()
            else:
                result["daemon"] = {"busy": True, "summary": "another bridge call is in progress"}
        return result

    # -- connect ------------------------------------------------------------

    def instances(self, params: dict[str, Any]) -> dict[str, Any]:
        """List daemon instances without selecting, provisioning or connecting."""
        from virtuoso_bridge.transport.tunnel import SSHClient

        selected_port = params.get("instancePort")
        try:
            selected_port = int(selected_port) if selected_port not in (None, "") else None
        except (TypeError, ValueError):
            selected_port = None
        owned = self.tunnel is None
        ssh = self.tunnel or SSHClient.from_env(
            keep_remote_files=True,
            profile=self.profile,
            selected_port=selected_port,
        )
        try:
            rows = ssh.list_instances(timeout=self.timeout)
            return {
                "autoSessions": bool(getattr(ssh, "_discover_instances", False)),
                "instances": rows,
                "selected": getattr(ssh, "instance_record", None),
                "expectedWorkDir": getattr(ssh, "expected_work_dir", ""),
                "setupPath": getattr(ssh, "setup_path", None),
                "compatibility": getattr(ssh, "daemon_compatibility", None),
            }
        finally:
            if owned:
                try:
                    ssh.close()
                except Exception:
                    pass

    def connect(self, params: dict[str, Any]) -> dict[str, Any]:
        if self.client is not None:
            return self.status()
        timeout = int(params.get("timeoutSec") or self.timeout or 120)
        token = params.get("daemonToken") or None
        selected_port = params.get("instancePort")
        try:
            selected_port = int(selected_port) if selected_port not in (None, "") else None
        except (TypeError, ValueError):
            selected_port = None
        if selected_port is not None and not 1 <= selected_port <= 65535:
            selected_port = None
        self.log_to_ciw = bool(params.get("logToCiw", False))
        self.connect_started = time.time()
        self.connect_error = None
        with self.lock:
            try:
                from virtuoso_bridge import VirtuosoClient
                from virtuoso_bridge.transport.tunnel import SSHClient

                ssh = SSHClient.from_env(
                    keep_remote_files=True,
                    profile=self.profile,
                    selected_port=selected_port,
                )
                self.tunnel = ssh
                ssh.warm(timeout=timeout)
                if self.local:
                    client = VirtuosoClient.local(
                        host="127.0.0.1",
                        port=ssh.port,
                        timeout=max(30, timeout),
                    )
                else:
                    client = VirtuosoClient.from_tunnel(ssh, timeout=max(30, timeout))
                client.log_to_ciw = self.log_to_ciw
                if token:
                    client.daemon_token = token
                    try:
                        ssh._daemon_token = token  # type: ignore[attr-defined]
                    except Exception:
                        pass
                self.client = client
                self.connect_finished = time.time()
                self.last_activity = time.time()
                try:
                    self.spectre = None
                except Exception:
                    self.spectre = None
                return self.status()
            except Exception as exc:
                self.connect_finished = time.time()
                self.connect_error = f"{type(exc).__name__}: {exc}"
                raise

    def disconnect(self, params: dict[str, Any]) -> dict[str, Any]:
        stop_tunnel = bool(params.get("stopTunnel", True))
        with self.lock:
            errors: list[str] = []
            if self.client is not None:
                try:
                    self.client.close()
                except Exception as exc:
                    errors.append(f"client.close: {exc}")
                self.client = None
            if stop_tunnel and self.tunnel is not None:
                try:
                    self.tunnel.stop()
                except Exception as exc:
                    errors.append(f"tunnel.stop: {exc}")
            elif self.tunnel is not None:
                try:
                    self.tunnel.close()
                except Exception:
                    pass
            self.tunnel = None
            self.spectre = None
        return {"stoppedAt": time.time(), "errors": errors}

    # -- introspection ------------------------------------------------------

    def targets(self) -> dict[str, Any]:
        targets: dict[str, Any] = {}
        if self.client is not None:
            targets["client"] = self.client
            for name in (
                "layout",
                "library",
                "schematic",
                "symbol",
                "maestro",
                "sos",
                "dialogs",
                "requests",
            ):
                child = getattr(self.client, name, None)
                if child is not None:
                    targets[f"client.{name}"] = child
            try:
                from virtuoso_bridge.spectre.runner import SpectreSimulator

                if self.spectre is None:
                    self.spectre = SpectreSimulator.from_env(profile=self.profile)
                targets["spectre"] = self.spectre
            except Exception as exc:
                targets["spectre"] = {"$error": f"{type(exc).__name__}: {exc}"}
        return targets

    def describe(self, params: dict[str, Any]) -> dict[str, Any]:
        target = params.get("target")
        depth = max(1, min(int(params.get("depth") or 2), MAX_DESCRIBE_DEPTH))
        if target:
            obj = self.resolve(target)
            if inspect.isclass(obj):
                return {"class": _describe_class(obj)}
            return {"object": _describe_object(target, obj, depth, set())}
        targets = {}
        for path, obj in self.targets().items():
            if isinstance(obj, dict) and "$error" in obj:
                targets[path] = obj
            else:
                targets[path] = _describe_object(path, obj, depth, set())
        classes = {}
        try:
            import virtuoso_bridge as vb

            for name in (
                "VirtuosoClient",
                "SSHClient",
                "SpectreSimulator",
                "SpectrePool",
                "SanitizingClient",
            ):
                cls = getattr(vb, name, None)
                if cls is not None:
                    classes[name] = _describe_class(cls)
        except Exception:
            pass
        return {
            "targets": targets,
            "classes": classes,
            "hint": (
                "Call with target='client.schematic' etc. Paths may be dotted; "
                "target='class:VirtuosoClient' describes a class."
            ),
        }

    def resolve(self, target: str) -> Any:
        if target.startswith("class:"):
            import virtuoso_bridge as vb

            name = target.split(":", 1)[1]
            cls = getattr(vb, name, None)
            if cls is None:
                raise RuntimeErrorInfo(f"unknown class {name!r}")
            return cls
        if target == "module":
            import virtuoso_bridge as vb

            return vb
        if target.startswith("module:"):
            import importlib

            module_name = target.split(":", 1)[1]
            return importlib.import_module(module_name)
        parts = target.split(".")
        if parts[0] == "client":
            if self.client is None:
                raise RuntimeErrorInfo("runtime is not connected; start it first")
            obj: Any = self.client
        elif parts[0] == "spectre":
            targets = self.targets()
            obj = targets.get("spectre")
            if not isinstance(obj, object) or obj is None:
                raise RuntimeErrorInfo("spectre simulator is unavailable")
            if isinstance(obj, dict) and "$error" in obj:
                raise RuntimeErrorInfo(obj["$error"])
        else:
            import virtuoso_bridge as vb

            obj = vb
        for part in parts[1:]:
            if not hasattr(obj, part):
                raise RuntimeErrorInfo(f"{target!r} has no member {part!r}")
            obj = getattr(obj, part)
        return obj

    # -- calls --------------------------------------------------------------

    def call(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "client")
        method = params.get("method")
        args = decode_arg(params.get("args") or [])
        kwargs = decode_arg(params.get("kwargs") or {})
        timeout = params.get("timeoutSec")
        if not method:
            expr = target
            obj = self.resolve(expr)
            return {"result": jsonable(obj)}
        if str(method) in ("new", "construct", "__new__") and target.startswith("class:"):
            cls = self.resolve(target)
            started = time.monotonic()
            value = cls(*args, **kwargs)
            elapsed = time.monotonic() - started
            payload = _summarize_payload(jsonable(value))
            return {
                "target": target,
                "method": "new",
                "elapsedSeconds": round(elapsed, 3),
                "truncated": payload["truncated"],
                "result": payload["payload"],
            }
        with self.lock:
            obj = self.resolve(target)
            func = getattr(obj, str(method), None)
            if func is None or not callable(func):
                raise RuntimeErrorInfo(f"{target}.{method} is not callable")
            self.last_activity = time.time()
            if timeout and "timeout" in _safe_parameter_names(func):
                kwargs.setdefault("timeout", int(timeout))
            started = time.monotonic()
            value = func(*args, **kwargs)
            elapsed = time.monotonic() - started
            payload = _summarize_payload(jsonable(value))
            return {
                "target": target,
                "method": method,
                "elapsedSeconds": round(elapsed, 3),
                "truncated": payload["truncated"],
                "result": payload["payload"],
            }


def _safe_parameter_names(func: Any) -> set[str]:
    try:
        return set(inspect.signature(func).parameters)
    except (TypeError, ValueError):
        return set()


# --------------------------------------------------------------------------
# Protocol loop
# --------------------------------------------------------------------------

_STDERR_TAIL: list[str] = []


def log(message: str, level: str = "info") -> None:
    line = f"{time.strftime('%H:%M:%S')} [{level}] {message}"
    _STDERR_TAIL.append(line)
    if len(_STDERR_TAIL) > 200:
        del _STDERR_TAIL[:100]
    print(line, file=sys.stderr, flush=True)
    emit({"event": "log", "level": level, "message": message, "time": time.time()})


def emit(payload: dict[str, Any]) -> None:
    line = (json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8", "replace")
    with _WRITE_LOCK:
        try:
            if _PROTOCOL_FD is not None:
                os.write(_PROTOCOL_FD, line)
            else:
                sys.stdout.write(line.decode("utf-8"))
                sys.stdout.flush()
        except Exception:
            pass


def respond(request_id: Any, *, ok: bool, result: Any = None, error: dict | None = None) -> None:
    payload: dict[str, Any] = {"id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = error
    emit(payload)


def _error_payload(exc: BaseException) -> dict[str, Any]:
    return {
        "message": f"{type(exc).__name__}: {exc}",
        "kind": type(exc).__name__,
        "traceback": traceback.format_exc()[-8000:],
    }


def _dispatch(runtime: BridgeRuntime, method: str, params: dict[str, Any]) -> Any:
    if method == "ping":
        return {"pong": time.time(), "pid": os.getpid()}
    if method == "status":
        return runtime.status()
    if method == "instances":
        return runtime.instances(params)
    if method == "connect":
        return runtime.connect(params)
    if method == "disconnect":
        return runtime.disconnect(params)
    if method == "describe":
        return runtime.describe(params)
    if method == "call":
        return runtime.call(params)
    if method == "targets":
        return {
            "targets": {
                path: {
                    "class": type(obj).__name__,
                    "module": type(obj).__module__,
                }
                for path, obj in runtime.targets().items()
            }
        }
    if method == "reload":
        return {"reloaded": False, "reason": "restart the runtime to reload code"}
    raise RuntimeErrorInfo(f"unknown sidecar method {method!r}")


def _handle(runtime: BridgeRuntime, request: dict[str, Any]) -> None:
    request_id = request.get("id")
    method = str(request.get("method") or "")
    params = request.get("params") or {}
    if not isinstance(params, dict):
        respond(request_id, ok=False, error={"message": "params must be an object"})
        return
    started = time.monotonic()
    try:
        result = _dispatch(runtime, method, params)
        respond(request_id, ok=True, result=result)
        log(f"{method} ok in {time.monotonic() - started:.2f}s")
    except Exception as exc:
        respond(request_id, ok=False, error=_error_payload(exc))
        log(f"{method} failed: {type(exc).__name__}: {exc}", "error")


def main(argv: list[str] | None = None) -> int:
    global _PROTOCOL_FD
    parser = argparse.ArgumentParser(description="virtuoso-bridge DSH sidecar")
    parser.add_argument("--profile", default=os.environ.get("VB_RUNTIME_PROFILE") or None)
    parser.add_argument("--local", action="store_true", default=os.environ.get("VB_RUNTIME_LOCAL") == "1")
    parser.add_argument("--timeout", type=int, default=int(os.environ.get("VB_RUNTIME_TIMEOUT") or 120))
    args = parser.parse_args(argv)

    try:
        _PROTOCOL_FD = os.dup(1)
        os.dup2(2, 1)
    except OSError:
        _PROTOCOL_FD = None

    runtime = BridgeRuntime(profile=args.profile, local=args.local, timeout=args.timeout)
    try:
        runtime.package_info()
    except Exception as exc:
        respond(None, ok=False, error=_error_payload(exc))
        log(f"import failed: {exc}", "error")
        return 3

    emit(
        {
            "event": "ready",
            "pid": os.getpid(),
            "profile": runtime.profile,
            "local": runtime.local,
            "python": sys.version.split()[0],
            "package": runtime.package_info(),
        }
    )
    log(f"sidecar ready profile={runtime.profile} local={runtime.local}")

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            respond(None, ok=False, error={"message": f"invalid JSON: {exc}"})
            continue
        if not isinstance(request, dict):
            respond(None, ok=False, error={"message": "request must be an object"})
            continue
        if request.get("method") == "shutdown":
            runtime.disconnect(request.get("params") or {})
            respond(request.get("id"), ok=True, result={"shutdown": True})
            log("sidecar shutdown")
            return 0
        thread = threading.Thread(
            target=_handle,
            args=(runtime, request),
            name=f"vb-rpc-{request.get('id')}",
            daemon=True,
        )
        thread.start()
    runtime.disconnect({"stopTunnel": False})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
