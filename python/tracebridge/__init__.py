"""tracebridge: the few things trace does in Python because Node has no maintained equivalent (see pyproject.toml).
Run as `python -m tracebridge`; spoken to by src/core/bridge.ts."""
from __future__ import annotations

from typing import Any, Callable

METHODS: dict[str, Callable[..., Any]] = {}


class BridgeError(Exception):
    """A failure the caller should read."""


def method(name: str):
    def wrap(fn):
        if name in METHODS:
            raise RuntimeError(f"bridge method {name} registered twice")
        METHODS[name] = fn
        return fn
    return wrap
