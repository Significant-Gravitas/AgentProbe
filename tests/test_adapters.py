from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from agentprobe.adapters import (
    HttpEndpointAdapter,
    build_endpoint_adapter,
)
from agentprobe.endpoints.autogpt import AutogptAuthResult
from agentprobe.endpoints.openclaw import OpenClawEndpointAdapter
from agentprobe.data import parse_endpoints_yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"


def parse_builtin(name: str):
    return parse_endpoints_yaml(DATA_DIR / name)


@pytest.mark.anyio
async def test_http_adapter_handles_opencode_managed_session(monkeypatch):
    monkeypatch.setenv("OPENCODE_BASE_URL", "http://opencode.test:9999")
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "GET" and request.url.path == "/global/health":
            return httpx.Response(200, json={"ok": True})
        if request.method == "POST" and request.url.path == "/session":
            assert json.loads(request.content.decode("utf-8")) == {
                "title": "AgentProbe: demo / shopper"
            }
            return httpx.Response(200, json={"id": "session-123"})
        if (
            request.method == "POST"
            and request.url.path == "/session/session-123/message"
        ):
            assert json.loads(request.content.decode("utf-8")) == {
                "parts": [{"type": "text", "text": "Hello adapter"}]
            }
            return httpx.Response(
                200,
                json={"parts": [{"type": "text", "text": "Hello from OpenCode"}]},
            )
        if request.method == "DELETE" and request.url.path == "/session/session-123":
            return httpx.Response(204)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    adapter = build_endpoint_adapter(
        parse_builtin("opencode-endpoints.yaml"),
        transport=httpx.MockTransport(handler),
    )

    assert isinstance(adapter, HttpEndpointAdapter)

    base_context = {
        "scenario": {"id": "demo"},
        "persona": {"id": "shopper"},
        "last_message": {"content": "Hello adapter"},
    }

    await adapter.health_check(base_context)
    session = await adapter.open_scenario(base_context)
    reply = await adapter.send_user_turn({**base_context, **session})
    await adapter.close_scenario({**base_context, **session})

    assert session == {"session_id": "session-123"}
    assert reply.assistant_text == "Hello from OpenCode"
    assert [request.url.path for request in requests] == [
        "/global/health",
        "/session",
        "/session/session-123/message",
        "/session/session-123",
    ]


@pytest.mark.anyio
async def test_http_adapter_handles_autogpt_auth_and_sse(monkeypatch):
    monkeypatch.setenv("AUTOGPT_BACKEND_URL", "http://backend.test:8006")
    requests: list[httpx.Request] = []
    auth_calls = 0

    def fake_auth() -> AutogptAuthResult:
        nonlocal auth_calls
        auth_calls += 1
        return AutogptAuthResult(
            token="fake-token",
            headers={"Authorization": "Bearer fake-token"},
        )

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer fake-token"

        if request.method == "POST" and request.url.path == "/api/chat/sessions":
            assert json.loads(request.content.decode("utf-8")) == {"dry_run": True}
            return httpx.Response(200, json={"id": "chat-123"})
        if (
            request.method == "POST"
            and request.url.path == "/api/chat/sessions/chat-123/stream"
        ):
            assert json.loads(request.content.decode("utf-8")) == {
                "message": "Hello AutoGPT",
                "is_user_message": True,
            }
            return httpx.Response(
                200,
                text='data: {"delta":"First chunk"}\n\ndata: {"delta":"Second chunk"}\n\n',
                headers={"content-type": "text/event-stream"},
            )

        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    adapter = build_endpoint_adapter(
        parse_builtin("autogpt-endpoint.yaml"),
        transport=httpx.MockTransport(handler),
        autogpt_auth_resolver=fake_auth,
    )

    base_context = {
        "scenario": {"id": "demo"},
        "persona": {"id": "shopper"},
        "last_message": {"content": "Hello AutoGPT"},
    }

    session = await adapter.open_scenario(base_context)
    reply = await adapter.send_user_turn({**base_context, **session})

    assert session == {"session_id": "chat-123"}
    assert reply.assistant_text == "First chunk\nSecond chunk"
    assert auth_calls == 1
    assert [request.url.path for request in requests] == [
        "/api/chat/sessions",
        "/api/chat/sessions/chat-123/stream",
    ]


def test_build_endpoint_adapter_dispatches_by_transport():
    http_adapter = build_endpoint_adapter(parse_builtin("opencode-endpoints.yaml"))
    websocket_adapter = build_endpoint_adapter(parse_builtin("openclaw-endpoints.yaml"))

    assert isinstance(http_adapter, HttpEndpointAdapter)
    assert isinstance(websocket_adapter, OpenClawEndpointAdapter)
