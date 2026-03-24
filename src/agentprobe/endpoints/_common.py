from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from agentprobe.data.endpoints import Endpoints

_ENV_PATTERN = re.compile(r"\$\{([^}:]+)(?:(:-|:\?)([^}]*))?\}")


def clone_with_resolved_env(endpoint: Endpoints) -> Endpoints:
    payload = endpoint.model_copy(deep=True).model_dump(mode="python", round_trip=True)
    resolved = _resolve_value(payload)
    return Endpoints.model_validate(resolved)


def dispatch_key(endpoint: Endpoints) -> str | None:
    if endpoint.preset:
        return endpoint.preset.casefold()

    source_path = endpoint.metadata.source_path
    if source_path is None:
        return None

    return source_path.name.casefold()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def require_named_endpoints(endpoint: Endpoints, *names: str) -> None:
    missing = [name for name in names if name not in endpoint.endpoints]
    require(not missing, f"Missing named endpoints: {', '.join(missing)}")


def _resolve_value(value: Any) -> Any:
    if isinstance(value, str):
        return _resolve_string(value)
    if isinstance(value, list):
        return [_resolve_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_resolve_value(item) for item in value)
    if isinstance(value, dict):
        return {key: _resolve_value(item) for key, item in value.items()}
    if isinstance(value, Path):
        return value
    return value


def _resolve_string(value: str) -> str:
    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        operator = match.group(2)
        operand = match.group(3) or ""
        env_value = os.getenv(name)

        if env_value is not None and env_value != "":
            return env_value

        if operator == ":-":
            return operand
        if operator == ":?":
            message = operand or f"Environment variable {name} is required."
            raise ValueError(message)

        raise ValueError(f"Environment variable {name} is required.")

    return _ENV_PATTERN.sub(replace, value)
