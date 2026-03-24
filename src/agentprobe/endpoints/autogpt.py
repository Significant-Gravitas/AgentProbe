from __future__ import annotations

from agentprobe.data.endpoints import EndpointAuth, Endpoints, HttpConnection

from ._common import clone_with_resolved_env, require_named_endpoints
from .autogpt_auth import AutogptAuthResult, resolve_auth


def configure(endpoint: Endpoints) -> Endpoints:
    normalized = clone_with_resolved_env(endpoint)

    if normalized.transport != "http":
        raise ValueError("AutoGPT endpoints require transport: http.")

    connection = normalized.connection
    if not isinstance(connection, HttpConnection) or not connection.base_url:
        raise ValueError("AutoGPT endpoints require connection.base_url.")

    require_named_endpoints(
        normalized, "register_user", "create_session", "send_message"
    )

    if normalized.auth is None:
        normalized.auth = EndpointAuth(type="none")
    if normalized.auth.type != "none":
        raise ValueError(
            "AutoGPT endpoints are authenticated internally by the main CLI and should use auth.type: none."
        )

    session = normalized.session
    if session is None or session.type != "managed":
        raise ValueError("AutoGPT endpoints require session.type: managed.")

    create_request = session.create
    if create_request is None or create_request.endpoint != "create_session":
        raise ValueError(
            "AutoGPT endpoints require session.create.endpoint = create_session."
        )
    if create_request.session_id_path != "$.id":
        raise ValueError(
            "AutoGPT endpoints require session.create.session_id_path = $.id."
        )

    request = normalized.request
    if request is None or request.endpoint != "send_message":
        raise ValueError("AutoGPT endpoints require request.endpoint = send_message.")

    response = normalized.response
    if response is None or response.format != "sse":
        raise ValueError("AutoGPT endpoints require response.format = sse.")
    if response.content_path != "$.delta":
        raise ValueError("AutoGPT endpoints require response.content_path = $.delta.")

    return normalized


__all__ = ["AutogptAuthResult", "configure", "resolve_auth"]
