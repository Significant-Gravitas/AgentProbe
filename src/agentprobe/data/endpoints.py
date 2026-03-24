from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, TypeAlias, cast

from pydantic import Field

from .common import (
    AgentProbeModel,
    YamlPath,
    coerce_path,
    read_yaml,
)

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, Any] | list[Any]
JsonObject: TypeAlias = dict[str, JsonValue]
TransportType: TypeAlias = Literal["http", "cli", "websocket"]
HarnessType: TypeAlias = Literal["codex", "claude-code", "opencode", "custom"]
SessionMode: TypeAlias = Literal["per_invocation", "per_scenario", "persistent"]
AuthType: TypeAlias = Literal[
    "bearer_token",
    "header",
    "jwt",
    "oauth2_client_credentials",
    "token_exchange",
    "script",
    "none",
]
EndpointSessionType: TypeAlias = Literal["stateless", "managed", "agent_initiated"]
HttpMethod: TypeAlias = Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
ResponseFormat: TypeAlias = Literal["json", "sse", "text", "ndjson"]
ToolExtractionFormat: TypeAlias = Literal["openai", "anthropic", "custom"]
ToolHandling: TypeAlias = Literal["mock", "passthrough", "skip"]


class CliHarness(AgentProbeModel):
    type: HarnessType
    command: list[str] = Field(default_factory=list)
    session_mode: SessionMode | None = None


class RateLimitConfig(AgentProbeModel):
    requests_per_second: int | float | None = None
    burst: int | None = None


class TlsConfig(AgentProbeModel):
    verify: bool | None = None
    cert_file: str | None = None
    key_file: str | None = None
    ca_file: str | None = None


class HttpConnection(AgentProbeModel):
    base_url: str
    timeout_seconds: int | None = None
    max_retries: int | None = None
    rate_limit: RateLimitConfig | None = None
    tls: TlsConfig | None = None


class WebSocketConnection(AgentProbeModel):
    url: str
    timeout_seconds: int | None = None
    max_retries: int | None = None
    rate_limit: RateLimitConfig | None = None
    tls: TlsConfig | None = None


class NamedEndpoint(AgentProbeModel):
    method: HttpMethod | None = None
    url: str | None = None
    body_template: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)


class EndpointAuth(AgentProbeModel):
    type: AuthType
    token: str | None = None
    header_name: str | None = None
    header_value: str | None = None
    command: list[str] = Field(default_factory=list)
    cwd: str | None = None
    timeout_seconds: int | None = None
    token_path: str | None = "$.token"
    headers_path: str | None = "$.headers"


class SessionLifecycleRequest(AgentProbeModel):
    endpoint: str | None = None
    url: str | None = None
    method: HttpMethod | None = None
    body_template: str | None = None
    session_id_path: str | None = None
    session_token_path: str | None = None
    ignore_errors: bool | None = None


class EndpointSession(AgentProbeModel):
    type: EndpointSessionType
    create: SessionLifecycleRequest | None = None
    close: SessionLifecycleRequest | None = None


class EndpointRequest(AgentProbeModel):
    endpoint: str | None = None
    url: str | None = None
    method: HttpMethod | None = None
    body_template: str | None = None


class AsyncPollingConfig(AgentProbeModel):
    endpoint: str | None = None
    url: str | None = None
    method: HttpMethod | None = None
    interval_seconds: int | float | None = None
    timeout_seconds: int | None = None
    status_path: str | None = None
    done_value: str | int | float | bool | None = None
    result_path: str | None = None


class EndpointResponse(AgentProbeModel):
    format: ResponseFormat
    content_path: str
    async_polling: AsyncPollingConfig | None = None


class WebSocketConnect(AgentProbeModel):
    challenge_event: str | None = None
    method: str | None = None
    params: JsonObject = Field(default_factory=dict)


class WebSocketTransport(AgentProbeModel):
    connect: WebSocketConnect | None = None


class ToolExtraction(AgentProbeModel):
    format: ToolExtractionFormat | None = None
    tool_handling: ToolHandling | None = None
    mock_tools: dict[str, JsonValue] = Field(default_factory=dict)


class HealthCheck(AgentProbeModel):
    enabled: bool | None = None
    endpoint: str | None = None


class EndpointLogging(AgentProbeModel):
    log_raw_exchanges: bool | None = None


class EndpointsMetadata(AgentProbeModel):
    source_path: Path | None = None


class Endpoints(AgentProbeModel):
    metadata: EndpointsMetadata = Field(default_factory=EndpointsMetadata)
    transport: TransportType | None = None
    preset: str | None = None
    harness: CliHarness | None = None
    connection: HttpConnection | WebSocketConnection | None = None
    websocket: WebSocketTransport | None = None
    endpoints: dict[str, NamedEndpoint] = Field(default_factory=dict)
    auth: EndpointAuth | None = None
    session: EndpointSession | None = None
    request: EndpointRequest | None = None
    response: EndpointResponse | None = None
    tool_extraction: ToolExtraction | None = None
    health_check: HealthCheck | None = None
    logging: EndpointLogging | None = None


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) else None


def parse_endpoints_yaml(path: YamlPath) -> Endpoints:
    raw = read_yaml(path)
    return Endpoints(
        metadata=EndpointsMetadata(
            source_path=coerce_path(path),
        ),
        transport=cast(TransportType | None, raw.get("transport")),
        preset=_optional_str(raw.get("preset")),
        harness=cast(CliHarness | None, raw.get("harness")),
        connection=cast(
            HttpConnection | WebSocketConnection | None,
            raw.get("connection"),
        ),
        websocket=cast(WebSocketTransport | None, raw.get("websocket")),
        endpoints=cast(dict[str, NamedEndpoint], raw.get("endpoints", {})),
        auth=cast(EndpointAuth | None, raw.get("auth")),
        session=cast(EndpointSession | None, raw.get("session")),
        request=cast(EndpointRequest | None, raw.get("request")),
        response=cast(EndpointResponse | None, raw.get("response")),
        tool_extraction=cast(ToolExtraction | None, raw.get("tool_extraction")),
        health_check=cast(HealthCheck | None, raw.get("health_check")),
        logging=cast(EndpointLogging | None, raw.get("logging")),
    )


__all__ = [
    "AsyncPollingConfig",
    "CliHarness",
    "EndpointAuth",
    "EndpointLogging",
    "EndpointRequest",
    "EndpointResponse",
    "EndpointSession",
    "Endpoints",
    "EndpointsMetadata",
    "HealthCheck",
    "HttpConnection",
    "JsonObject",
    "NamedEndpoint",
    "RateLimitConfig",
    "SessionLifecycleRequest",
    "TlsConfig",
    "ToolExtraction",
    "WebSocketConnect",
    "WebSocketConnection",
    "WebSocketTransport",
    "parse_endpoints_yaml",
]
