from __future__ import annotations


class AgentProbeConfigError(ValueError):
    """Raised when AgentProbe configuration is invalid or incomplete."""


class AgentProbeRuntimeError(RuntimeError):
    """Raised when a target endpoint, adapter, or judge fails at runtime."""
