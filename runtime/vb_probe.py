#!/usr/bin/env python3
"""Report the chosen interpreter's virtualenv and virtuoso-bridge status as JSON."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# The plugin venv owns the package selected by the setup manager (bundled,
# local or git).  Do not prepend the bundled source here: doing so would mask
# a local/git installation and defeat the source-selection contract.
if os.environ.get("VB_FORCE_VENDOR_SRC") == "1":
    _VENDOR_SRC = Path(__file__).resolve().parent.parent / "vendor" / "src"
    if _VENDOR_SRC.is_dir() and str(_VENDOR_SRC) not in sys.path:
        sys.path.insert(0, str(_VENDOR_SRC))

report = {
    "python": sys.version.split()[0],
    "executable": sys.executable,
    "prefix": sys.prefix,
    "basePrefix": getattr(sys, "base_prefix", sys.prefix),
    "isVenv": sys.prefix != getattr(sys, "base_prefix", sys.prefix),
    "cwd": os.getcwd(),
    "package": None,
    "error": None,
}
try:
    import virtuoso_bridge as vb

    report["package"] = {
        "version": getattr(vb, "__version__", "unknown"),
        "file": getattr(vb, "__file__", ""),
        "client": hasattr(vb, "VirtuosoClient"),
        "spectre": hasattr(vb, "SpectreSimulator"),
    }
except Exception as exc:  # noqa: BLE001 - the Host reports this verbatim
    report["error"] = f"{type(exc).__name__}: {exc}"

for module_name, label in (("paramiko", "paramiko"), ("socks", "PySocks")):
    try:
        module = __import__(module_name)
        report[label] = {
            "ok": True,
            "version": getattr(module, "__version__", "unknown"),
        }
    except Exception as exc:  # noqa: BLE001
        report[label] = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
print(json.dumps(report), flush=True)
raise SystemExit(0 if report["error"] is None else 2)
