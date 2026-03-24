from __future__ import annotations

import base64
import os

from agentprobe.data.endpoints import EndpointAuth, Endpoints, HttpConnection

from ._common import clone_with_resolved_env, require_named_endpoints


def configure(endpoint: Endpoints) -> Endpoints:
    normalized = clone_with_resolved_env(endpoint)

    if normalized.transport != "http":
        raise ValueError("OpenCode endpoints require transport: http.")

    connection = normalized.connection
    if not isinstance(connection, HttpConnection) or not connection.base_url:
        raise ValueError("OpenCode endpoints require connection.base_url.")

    require_named_endpoints(
        normalized,
        "health",
        "create_session",
        "send_message",
        "delete_session",
    )

    session = normalized.session
    if session is None or session.type != "managed":
        raise ValueError("OpenCode endpoints require session.type: managed.")

    create_request = session.create
    if create_request is None or create_request.endpoint != "create_session":
        raise ValueError(
            "OpenCode endpoints require session.create.endpoint = create_session."
        )
    if create_request.session_id_path != "$.id":
        raise ValueError(
            "OpenCode endpoints require session.create.session_id_path = $.id."
        )

    close_request = session.close
    if close_request is None or close_request.endpoint != "delete_session":
        raise ValueError(
            "OpenCode endpoints require session.close.endpoint = delete_session."
        )

    request = normalized.request
    if request is None or request.endpoint != "send_message":
        raise ValueError("OpenCode endpoints require request.endpoint = send_message.")

    response = normalized.response
    if response is None or response.format != "json":
        raise ValueError("OpenCode endpoints require response.format = json.")

    health_check = normalized.health_check
    if health_check is None or health_check.endpoint != "health":
        raise ValueError("OpenCode endpoints require health_check.endpoint = health.")

    password = os.getenv("OPENCODE_SERVER_PASSWORD")
    if password not in (None, ""):
        username = os.getenv("OPENCODE_SERVER_USERNAME") or "opencode"
        basic_token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode(
            "ascii"
        )
        normalized.auth = EndpointAuth(
            type="header",
            header_name="Authorization",
            header_value=f"Basic {basic_token}",
        )

    return normalized


__all__ = ["configure"]
