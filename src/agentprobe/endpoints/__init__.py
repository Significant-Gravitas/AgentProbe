from __future__ import annotations

from agentprobe.data.endpoints import Endpoints
from agentprobe.errors import AgentProbeConfigError

from ._common import clone_with_resolved_env, dispatch_key
from .autogpt import configure as configure_autogpt
from .opencode import configure as configure_opencode
from .openclaw import build_adapter as build_openclaw_adapter
from .openclaw import configure as configure_openclaw

_CONFIGURERS = {
    "autogpt": configure_autogpt,
    "autogpt-endpoint.yaml": configure_autogpt,
    "autogpt-endpoint.yml": configure_autogpt,
    "opencode": configure_opencode,
    "opencode-endpoints.yaml": configure_opencode,
    "opencode-endpoints.yml": configure_opencode,
    "openclaw": configure_openclaw,
    "openclaw-endpoints.yaml": configure_openclaw,
    "openclaw-endpoints.yml": configure_openclaw,
}

_WEBSOCKET_ADAPTERS = {
    "openclaw": build_openclaw_adapter,
    "openclaw-endpoints.yaml": build_openclaw_adapter,
    "openclaw-endpoints.yml": build_openclaw_adapter,
}


def configure_endpoint(endpoint: Endpoints) -> Endpoints:
    key = dispatch_key(endpoint)
    if key is None:
        return clone_with_resolved_env(endpoint)

    configurator = _CONFIGURERS.get(key)
    if configurator is None:
        return clone_with_resolved_env(endpoint)

    return configurator(endpoint)


def build_websocket_adapter(endpoint: Endpoints):
    key = dispatch_key(endpoint)
    factory = _WEBSOCKET_ADAPTERS.get(key) if key is not None else None
    if factory is None:
        raise AgentProbeConfigError(
            f"No websocket adapter is registered for endpoint `{key or 'unknown'}`."
        )
    return factory(endpoint)


__all__ = ["build_websocket_adapter", "configure_endpoint"]
