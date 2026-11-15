#!/usr/bin/env python3
r"""Read the Virtuoso CIW transcript so an agent can see what the CIW printed.

A SKILL run can print warnings, "*Error*" lines and plain diagnostic text in the
CIW while the corresponding bridge call still reports success.  The bridge
returns the expression's *value*, not the CIW text, so those lines used to be
invisible to the agent until a human pasted them.  This module closes that gap
without a new tool: every capture returns a small JSON payload that the plugin
attaches to the tool result it already produces.

Two facts make the capture possible (measured on IC6.1.8):

* Virtuoso echoes the CIW transcript into the session log file ("CDS.log" or
  "CDS.log.<n>").  Lines carry a formatting prefix: "\w" warning, "\e" error,
  "\o" printed output, "\#" log header.
* warn() output stays buffered in the SKILL warning port and does not reach the
  CIW (or the log) until the port is flushed.  warn("") getWarn() forces that
  flush, which makes pending warnings appear immediately.

So one capture is: force the warn flush, then read only the bytes the log gained
since the previous capture.  Both operations use the existing SKILL lane
(client.execute_skill / client.run_shell_command); the bridge's SSH runner is
deliberately not used because it costs seconds per command on the measured
host.

Everything here is best effort: CiwCapture.capture never raises and returns
None whenever the CIW text cannot be read (no /proc, a busy or poisoned lane, a
missing log file, an unsupported platform, ...).  A capture must never change or
fail the tool call it rides on.
"""

from __future__ import annotations

import re
import shlex
import threading
import time
from typing import Any

# SKILL that flushes text pending in the warning port into the CIW.
FLUSH_SKILL = 'warn("") getWarn()'

# "-> /path" in "ls -l /proc/<pid>/fd" output.
_FD_TARGET = re.compile(r"->\s+(\S.*)$")

# The CIW transcript file of one Virtuoso session.
_LOG_BASENAME = re.compile(r"(?:^|/)(?:CDS\.log|CDS\.log\.\d+)$")

# Text printed with \o that an agent should still see.
_DIAGNOSTIC = re.compile(
    r"(?i)\b(?:"
    r"error|errors|warning|warnings|fatal|exception|traceback|"
    r"cannot|can't|could not|unable to|failed|failure|denied|"
    r"unbound|undefined|not found|missing|invalid|illegal|unknown|"
    r"timeout|timed out|aborted|abort"
    r")\b"
)

# Leading CIW log formatting code: \w, \e, \o, \#.
_FORMAT_PREFIX = re.compile(r"^\\([a-z#])(?: (.*))?$")

# Marker appended when consecutive identical lines were collapsed.
_REPEAT_NOTE = " ... (last line repeated)"


def parse_fd_listing(text: str) -> str | None:
    """Pick the CIW log path out of "ls -l /proc/<pid>/fd" output.

    A writable descriptor ("l-wx"/"lrwx") is preferred: it is the file the
    Virtuoso process is appending to right now.  A read-only duplicate of the
    same file is accepted as a fallback.  Lock files (*.cdslck) are ignored.
    """
    writable: list[str] = []
    readable: list[str] = []
    for line in str(text or "").splitlines():
        match = _FD_TARGET.search(line)
        if not match:
            continue
        target = match.group(1).strip()
        if not target or target.endswith(".cdslck"):
            continue
        if not _LOG_BASENAME.search(target):
            continue
        fields = line.split(None, 2)
        perms = fields[0] if fields else ""
        (writable if "-w" in perms else readable).append(target)
    if writable:
        return writable[-1]
    if readable:
        return readable[-1]
    return None


def parse_read_output(text: str) -> tuple[int | None, str]:
    """Split the reader command's "SZ:<bytes>" header from the log text."""
    body = str(text or "")
    first, separator, rest = body.partition("\n")
    if first.startswith("SZ:"):
        try:
            return int(first[3:].strip()), rest if separator else ""
        except ValueError:
            return None, body
    return None, body


def _clean_body(body: str) -> str:
    return body.rstrip("\r\n").strip()


def classify_ciw_text(text: str, *, max_lines: int = 40, max_chars: int = 6000) -> dict[str, Any]:
    r"""Classify new CIW lines and keep the ones an agent needs.

    "\w" lines are warnings, "\e" lines are errors, and "\o" lines are kept only
    when they read like a diagnostic (CDF callback failures, tool errors, ...).
    Everything else is counted, not printed.  Consecutive identical lines are
    collapsed, the oldest lines are dropped first when a cap is hit, and
    "truncated" reports that something was dropped.
    """
    warnings = 0
    errors = 0
    outputs = 0
    others = 0
    kept: list[dict[str, str]] = []
    for raw in str(text or "").splitlines():
        match = _FORMAT_PREFIX.match(raw)
        if match:
            code = match.group(1)
            body = _clean_body(match.group(2) or "")
            if code == "w":
                level = "warning"
            elif code == "e":
                level = "error"
            elif code == "o":
                level = "output"
            else:
                # "\#" header lines and other formatting codes are noise.
                if body:
                    others += 1
                continue
        else:
            # Continuation lines (e.g. a multi-line CDF message) have no
            # prefix; keep them only when they are clearly diagnostic.
            body = _clean_body(raw)
            level = "output"
        if not body:
            continue
        if level == "warning":
            warnings += 1
        elif level == "error":
            errors += 1
        elif level == "output":
            if not _DIAGNOSTIC.search(body):
                others += 1
                continue
            outputs += 1
        if kept and kept[-1]["level"] == level:
            previous_text = kept[-1]["text"]
            if previous_text == body or previous_text == body + _REPEAT_NOTE:
                if previous_text != body + _REPEAT_NOTE:
                    kept[-1] = {**kept[-1], "text": body + _REPEAT_NOTE}
                continue
        kept.append({"level": level, "text": body})

    truncated = False
    if len(kept) > max_lines:
        truncated = True
        kept = kept[-max_lines:]
    used = 0
    fitted: list[dict[str, str]] = []
    for item in reversed(kept):
        cost = len(item["text"]) + 1
        if used + cost > max_chars:
            truncated = True
            break
        fitted.append(item)
        used += cost
    kept = list(reversed(fitted))

    return {
        "lines": [item["text"] for item in kept],
        "levels": [item["level"] for item in kept],
        "warnings": warnings,
        "errors": errors,
        "output": outputs,
        "otherLines": others,
        "truncated": truncated,
    }


class CiwCapture:
    """One cursor over the CIW transcript of a single Virtuoso session."""

    def __init__(
        self,
        client: Any,
        *,
        max_bytes: int = 65536,
        max_lines: int = 40,
        max_chars: int = 6000,
        timeout: float = 8.0,
        first_window: int = 8192,
        settle: float = 0.0,
    ) -> None:
        self.client = client
        self.max_bytes = max(1024, int(max_bytes))
        self.max_lines = max(1, int(max_lines))
        self.max_chars = max(200, int(max_chars))
        self.timeout = max(1.0, float(timeout))
        self.first_window = max(1024, int(first_window))
        # Virtuoso's transcript writer batches CIW text, so a warning flushed
        # just now can reach the log a few hundred milliseconds later. A settle
        # delay trades latency for same-call delivery where that is affordable
        # (script jobs, failed calls); 0 keeps a call fast and lets the next
        # capture pick the text up instead.
        self.settle = max(0.0, float(settle))
        self.pid: int | None = None
        self.path: str | None = None
        self.cursor: int | None = None
        # The sidecar attaches a capture result after releasing its call lock,
        # so two tool calls can capture concurrently; serialise the cursor.
        self._lock = threading.Lock()

    # -- bridge helpers -----------------------------------------------------

    def _run(self, command: str) -> str:
        runner = getattr(self.client, "run_shell_command", None)
        if not callable(runner):
            return ""
        try:
            result = runner(command, timeout=self.timeout)
        except TypeError:
            result = runner(command)
        except Exception:  # noqa: BLE001 - capture is best effort
            return ""
        return str(getattr(result, "output", "") or "")

    def _flush(self) -> None:
        """Force warn-port text into the CIW before the log is read."""
        execute = getattr(self.client, "execute_skill", None)
        if not callable(execute):
            return
        try:
            execute(FLUSH_SKILL, timeout=min(self.timeout, 5))
        except Exception:  # noqa: BLE001 - a busy lane simply means no capture
            pass

    def _pid(self) -> int | None:
        getter = getattr(self.client, "get_virtuoso_pid", None)
        if not callable(getter):
            return None
        try:
            value = getter()
        except Exception:  # noqa: BLE001
            return None
        try:
            pid = int(value)
        except (TypeError, ValueError):
            return None
        return pid if pid > 0 else None

    # -- discovery and reading ----------------------------------------------

    def _discover(self) -> bool:
        """Resolve pid + log path once; returns False when that is impossible."""
        pid = self._pid()
        if pid is None:
            return False
        listing = self._run("/bin/ls -l /proc/%d/fd" % pid)
        path = parse_fd_listing(listing)
        if not path:
            return False
        if pid != self.pid:
            self.cursor = None
        self.pid = pid
        self.path = path
        return True

    def _read(self) -> tuple[int | None, str]:
        """Read the log tail: the first window, or everything since the cursor."""
        path = shlex.quote(str(self.path))
        if self.cursor is None:
            body = 'sz=$(wc -c < %s); printf "SZ:%%s\\n" "$sz"; tail -c %d %s' % (
                path,
                self.first_window,
                path,
            )
        else:
            start = self.cursor + 1
            body = 'sz=$(wc -c < %s); printf "SZ:%%s\\n" "$sz"; tail -c +%d %s' % (path, start, path)
        return parse_read_output(self._run("/bin/sh -c " + shlex.quote(body)))

    def capture(self, settle: float | None = None) -> dict[str, Any] | None:
        """Return a small payload describing new CIW diagnostics, or None."""
        with self._lock:
            return self._capture_locked(settle)

    def _capture_locked(self, settle: float | None = None) -> dict[str, Any] | None:
        try:
            self._flush()
            delay = self.settle if settle is None else max(0.0, float(settle))
            if delay > 0:
                time.sleep(delay)
            if not self.path and not self._discover():
                return None
            size, text = self._read()
            if size is None:
                # The command failed; the path may have been lost.
                self.path = None
                return None

            previous = self.cursor
            if previous is None:
                scanned = min(size, self.first_window)
                truncated = False
            elif size < previous:
                # The log shrank under the cursor (rotation/truncation); the
                # skipped bytes are unrecoverable, so report the cut.
                scanned = size
                truncated = True
            else:
                offset = max(0, previous)
                available = size - offset
                truncated = available > self.max_bytes
                scanned = min(available, self.max_bytes) if available > 0 else 0
            self.cursor = size

            classified = classify_ciw_text(text, max_lines=self.max_lines, max_chars=self.max_chars)
            if not classified["lines"]:
                return None
            return {
                "logPath": str(self.path or ""),
                "pid": self.pid,
                "warnings": classified["warnings"],
                "errors": classified["errors"],
                "output": classified["output"],
                "otherLines": classified["otherLines"],
                "lines": classified["lines"],
                "levels": classified["levels"],
                "truncated": bool(truncated or classified["truncated"]),
                "scannedBytes": int(max(0, scanned)),
                "capturedAt": round(time.time(), 3),
            }
        except Exception:  # noqa: BLE001 - capture never fails the caller
            self.path = None
            return None
