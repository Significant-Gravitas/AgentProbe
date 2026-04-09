from __future__ import annotations

import base64
from pathlib import Path

import pytest

from agentprobe.data import parse_endpoints_yaml, process_yaml_files
from agentprobe.data.endpoints import HttpConnection, WebSocketConnection
from agentprobe.endpoints import configure_endpoint

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"


def parse_builtin(name: str):
    return parse_endpoints_yaml(DATA_DIR / name)


def test_configure_endpoint_dispatches_by_preset(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "wss://gateway.test/socket")
    monkeypatch.setenv("OPENCLAW_GATEWAY_TOKEN", "test-token")
    source = (DATA_DIR / "openclaw-endpoints.yaml").read_text(encoding="utf-8")
    path = tmp_path / "custom-openclaw.yaml"
    path.write_text(source, encoding="utf-8")

    endpoint = parse_endpoints_yaml(path)
    configured = configure_endpoint(endpoint)

    assert endpoint.transport == "websocket"
    assert isinstance(endpoint.connection, WebSocketConnection)
    assert endpoint.connection.url == "${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
    assert isinstance(configured.connection, WebSocketConnection)
    assert configured.connection.url == "wss://gateway.test/socket"
    assert configured.websocket is not None
    assert configured.websocket.connect is not None
    client = configured.websocket.connect.params.get("client")
    auth = configured.websocket.connect.params.get("auth")
    assert isinstance(client, dict)
    assert client.get("id") == "openclaw-probe"
    assert client.get("mode") == "probe"
    assert auth == {"token": "test-token"}


def test_configure_endpoint_dispatches_by_source_filename(monkeypatch):
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", "ws://gateway.local:18789")
    endpoint = parse_builtin("openclaw-endpoints.yaml")
    endpoint.preset = None

    configured = configure_endpoint(endpoint)

    assert configured.transport == "websocket"
    assert isinstance(configured.connection, WebSocketConnection)
    assert configured.connection.url == "ws://gateway.local:18789"
    assert configured.websocket is not None
    assert configured.websocket.connect is not None
    assert configured.websocket.connect.challenge_event == "connect.challenge"
    assert configured.websocket.connect.method == "connect"
    client = configured.websocket.connect.params.get("client")
    assert isinstance(client, dict)
    assert client.get("id") == "openclaw-probe"
    assert client.get("mode") == "probe"
    assert configured.websocket.connect.params["role"] == "operator"
    assert configured.websocket.connect.params["scopes"] == [
        "operator.read",
        "operator.write",
    ]


def test_openclaw_rejects_non_websocket_urls():
    endpoint = parse_builtin("openclaw-endpoints.yaml")
    assert isinstance(endpoint.connection, WebSocketConnection)
    endpoint.connection.url = "http://gateway.test"

    with pytest.raises(ValueError, match="ws:// or wss://"):
        configure_endpoint(endpoint)


def test_opencode_base_url_is_interpolated(monkeypatch):
    monkeypatch.setenv("OPENCODE_BASE_URL", "http://opencode.test:9999")

    configured = configure_endpoint(parse_builtin("opencode-endpoints.yaml"))

    assert isinstance(configured.connection, HttpConnection)
    assert configured.connection.base_url == "http://opencode.test:9999"


def test_autogpt_auth_and_base_url_are_interpolated(monkeypatch):
    monkeypatch.setenv("AUTOGPT_BACKEND_URL", "http://backend.test:8006")

    configured = configure_endpoint(parse_builtin("autogpt-endpoint.yaml"))

    assert isinstance(configured.connection, HttpConnection)
    assert configured.connection.base_url == "http://backend.test:8006"
    assert configured.auth is not None
    assert configured.auth.type == "none"


def test_opencode_synthesizes_basic_auth_with_default_username(monkeypatch):
    monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "secret-pass")
    monkeypatch.delenv("OPENCODE_SERVER_USERNAME", raising=False)

    configured = configure_endpoint(parse_builtin("opencode-endpoints.yaml"))

    expected = base64.b64encode(b"opencode:secret-pass").decode("ascii")
    assert configured.auth is not None
    assert configured.auth.type == "header"
    assert configured.auth.header_name == "Authorization"
    assert configured.auth.header_value == f"Basic {expected}"


def test_opencode_synthesizes_basic_auth_with_overridden_username(monkeypatch):
    monkeypatch.setenv("OPENCODE_SERVER_PASSWORD", "secret-pass")
    monkeypatch.setenv("OPENCODE_SERVER_USERNAME", "alice")

    configured = configure_endpoint(parse_builtin("opencode-endpoints.yaml"))

    expected = base64.b64encode(b"alice:secret-pass").decode("ascii")
    assert configured.auth is not None
    assert configured.auth.header_value == f"Basic {expected}"


def test_autogpt_configuration_shape():
    configured = configure_endpoint(parse_builtin("autogpt-endpoint.yaml"))

    assert configured.auth is not None
    assert configured.auth.type == "none"
    assert configured.session is not None
    assert configured.session.type == "managed"
    assert configured.session.create is not None
    assert configured.session.create.endpoint == "create_session"
    assert configured.endpoints["create_session"].body_template is not None
    assert '"dry_run": true' in configured.endpoints["create_session"].body_template
    assert configured.request is not None
    assert configured.request.endpoint == "send_message"
    assert configured.response is not None
    assert configured.response.format == "sse"
    assert configured.response.content_path == "$.delta"
    assert {"register_user", "create_session", "send_message"} <= set(
        configured.endpoints
    )


def test_process_yaml_files_loads_builtin_endpoint_configs():
    processed = process_yaml_files(DATA_DIR)
    schemas = {item.path.name: item.schema for item in processed}

    assert schemas["autogpt-endpoint.yaml"] == "endpoints"
    assert schemas["opencode-endpoints.yaml"] == "endpoints"
    assert schemas["openclaw-endpoints.yaml"] == "endpoints"
