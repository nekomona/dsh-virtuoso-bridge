#!/usr/bin/env python3
"""Run one user script inside the plugin's isolated virtuoso-bridge venv.

The DSH plugin starts this file with the venv interpreter and a job directory.
The directory contains ``context.json`` and ``script.py``; the job semantics and
the artifacts it writes live in :mod:`vb_script_exec` and are shared with the
long-lived worker (``vb_script_worker.py``):

* ``status.json``   - ``running`` / ``succeeded`` / ``failed`` / ``timeout``
* ``result.json``   - the script's ``result`` variable, JSON encoded
* ``error.json``    - exception type, message, traceback
* ``events.jsonl``  - structured ``emit()`` values

stdout and stderr are redirected by the Host to ``stdout.log`` and
``stderr.log``; this process does not touch any protocol.

The script namespace deliberately mirrors the bridge's public package::

    import virtuoso_bridge as vb
    from virtuoso_bridge import VirtuosoClient, SpectreSimulator

    client = connect()              # reuses the running tunnel when present
    result = client.execute_skill("1+1")

    for cell in cells:
        emit({"cell": cell})
"""

from __future__ import annotations

import sys
from pathlib import Path

from vb_script_exec import JobRunner

JOB_DIR = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()


def main() -> int:
    outcome = JobRunner(JOB_DIR).run()
    if "exitCode" in outcome:
        return int(outcome["exitCode"] or 0)
    return 0 if outcome.get("state") == "succeeded" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
