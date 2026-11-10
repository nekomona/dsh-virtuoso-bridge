"""``virtuoso_bridge.virtuoso.ops`` fixture: only the string escaping used here."""

from __future__ import annotations


def escape_skill_string(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"')
