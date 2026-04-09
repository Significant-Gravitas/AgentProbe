from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping, Sequence
from functools import lru_cache
from typing import Any, Protocol, cast

import httpx
from jsonpath_ng.ext import parse as parse_jsonpath
from pydantic import Field

from .data.common import AgentProbeModel
from .data.endpoints import (
    EndpointRequest,
    EndpointResponse,
    Endpoints,
    HealthCheck,
    HttpConnection,
    NamedEndpoint,
    SessionLifecycleRequest,
    WebSocketConnection,
)
from .errors import AgentProbeConfigError, AgentProbeRuntimeError
from .rendering import render_json_template, render_template


class ToolCallRecord(AgentProbeModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    order: int | None = None
    raw: dict[str, Any] | None = None


class AdapterReply(AgentProbeModel):
    assistant_text: str = ""
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    raw_exchange: dict[str, Any] = Field(default_factory=dict)
    latency_ms: float = 0.0
    usage: dict[str, Any] = Field(default_factory=dict)


class EndpointAdapter(Protocol):
    async def health_check(self, render_context: Mapping[str, object]) -> None: ...

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]: ...

    async def send_user_turn(
        self,
        render_context: Mapping[str, object],
    ) -> AdapterReply: ...

    async def close_scenario(self, render_context: Mapping[str, object]) -> None: ...


class _ResolvedRequest(AgentProbeModel):
    method: str
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    json_body: object | None = None
    content: str | bytes | None = None


class _ParsedResponse(AgentProbeModel):
    assistant_text: str = ""
    tool_calls: list[ToolCallRecord] = Field(default_factory=list)
    usage: dict[str, Any] = Field(default_factory=dict)
    body: object | None = None


class HttpEndpointAdapter:
    def __init__(
        self,
        endpoint: Endpoints,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        autogpt_auth_resolver: Callable[[], object] | None = None,
    ) -> None:
        self.endpoint = endpoint
        self._transport = transport
        self._autogpt_auth_resolver = autogpt_auth_resolver
        self._cached_auth_headers: dict[str, str] | None = None

        if endpoint.transport != "http":
            raise AgentProbeConfigError("HTTP adapter requires transport: http.")

        connection = endpoint.connection
        if not isinstance(connection, HttpConnection):
            raise AgentProbeConfigError("HTTP adapter requires an HTTP connection.")
        self._connection = connection

    async def health_check(self, render_context: Mapping[str, object]) -> None:
        health_check = self.endpoint.health_check
        if health_check is None or health_check.enabled is False:
            return

        request = self._resolve_request_definition(health_check, render_context)
        async with self._build_client() as client:
            response = await client.request(
                request.method,
                request.url,
                headers=request.headers,
                json=request.json_body,
                content=request.content,
            )
            response.raise_for_status()

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]:
        session = self.endpoint.session
        if session is None or session.type == "stateless":
            return {}

        if session.type != "managed" or session.create is None:
            raise AgentProbeConfigError(
                "HTTP runner only supports stateless and managed sessions."
            )

        request = self._resolve_request_definition(session.create, render_context)
        async with self._build_client() as client:
            response = await client.request(
                request.method,
                request.url,
                headers=request.headers,
                json=request.json_body,
                content=request.content,
            )
            response.raise_for_status()
            payload = response.json()

        session_state: dict[str, object] = {}
        if session.create.session_id_path:
            session_id = _extract_first_match(payload, session.create.session_id_path)
            if session_id is None:
                raise AgentProbeRuntimeError(
                    "Managed session create response did not contain a session id."
                )
            session_state["session_id"] = _coerce_scalar_text(session_id)

        if session.create.session_token_path:
            token = _extract_first_match(payload, session.create.session_token_path)
            if token is not None:
                session_state["session_token"] = _coerce_scalar_text(token)

        return session_state

    async def send_user_turn(
        self,
        render_context: Mapping[str, object],
    ) -> AdapterReply:
        if self.endpoint.response is None:
            raise AgentProbeConfigError("Endpoint is missing response configuration.")

        request_config = self.endpoint.request
        if request_config is None:
            raise AgentProbeConfigError("Endpoint is missing request configuration.")

        request = self._resolve_request_definition(request_config, render_context)
        response_config = self.endpoint.response

        start = time.perf_counter()
        if response_config.format == "sse":
            parsed, raw_response = await self._send_sse_request(
                request, response_config
            )
        elif response_config.format in {"json", "text"}:
            parsed, raw_response = await self._send_standard_request(
                request, response_config
            )
        else:
            raise AgentProbeConfigError(
                f"Unsupported HTTP response format: {response_config.format}"
            )
        latency_ms = (time.perf_counter() - start) * 1000.0

        return AdapterReply(
            assistant_text=parsed.assistant_text,
            tool_calls=parsed.tool_calls,
            raw_exchange={
                "request": {
                    "method": request.method,
                    "url": request.url,
                    "headers": request.headers,
                    "json_body": request.json_body,
                    "content": request.content,
                },
                "response": raw_response,
            },
            latency_ms=latency_ms,
            usage=parsed.usage,
        )

    async def close_scenario(self, render_context: Mapping[str, object]) -> None:
        session = self.endpoint.session
        if session is None or session.type != "managed" or session.close is None:
            return

        request = self._resolve_request_definition(session.close, render_context)
        async with self._build_client() as client:
            response = await client.request(
                request.method,
                request.url,
                headers=request.headers,
                json=request.json_body,
                content=request.content,
            )

        if response.is_error and session.close.ignore_errors is not True:
            response.raise_for_status()

    async def _send_standard_request(
        self,
        request: _ResolvedRequest,
        response_config: EndpointResponse,
    ) -> tuple[_ParsedResponse, dict[str, Any]]:
        async with self._build_client() as client:
            response = await client.request(
                request.method,
                request.url,
                headers=request.headers,
                json=request.json_body,
                content=request.content,
            )
            response.raise_for_status()

        if response_config.format == "json":
            payload = response.json()
            return (
                _ParsedResponse(
                    assistant_text=_extract_text(payload, response_config.content_path),
                    tool_calls=self._extract_tool_calls(payload),
                    usage=_extract_usage(payload),
                    body=payload,
                ),
                {
                    "status_code": response.status_code,
                    "headers": dict(response.headers),
                    "body": payload,
                },
            )

        return (
            _ParsedResponse(
                assistant_text=response.text.strip(),
                body=response.text,
            ),
            {
                "status_code": response.status_code,
                "headers": dict(response.headers),
                "body": response.text,
            },
        )

    async def _send_sse_request(
        self,
        request: _ResolvedRequest,
        response_config: EndpointResponse,
    ) -> tuple[_ParsedResponse, dict[str, Any]]:
        status_code = 200
        async with self._build_client() as client:
            async with client.stream(
                request.method,
                request.url,
                headers=request.headers,
                json=request.json_body,
                content=request.content,
            ) as response:
                response.raise_for_status()
                status_code = response.status_code
                lines = [line async for line in response.aiter_lines()]

        events = _parse_sse_events(lines)
        assistant_chunks = [
            _extract_text(event, response_config.content_path)
            for event in events
            if isinstance(event, dict)
        ]
        assistant_text = "\n".join(chunk for chunk in assistant_chunks if chunk).strip()
        return (
            _ParsedResponse(
                assistant_text=assistant_text,
                tool_calls=self._extract_tool_calls(events),
                usage=_extract_usage(events[-1])
                if events and isinstance(events[-1], dict)
                else {},
                body=events,
            ),
            {
                "status_code": status_code,
                "body": events,
                "lines": lines,
            },
        )

    def _resolve_request_definition(
        self,
        request_like: EndpointRequest | SessionLifecycleRequest | HealthCheck,
        render_context: Mapping[str, object],
    ) -> _ResolvedRequest:
        request_context = dict(render_context)
        request_context.setdefault("base_url", self._connection.base_url)

        named_endpoint: NamedEndpoint | None = None
        endpoint_name = getattr(request_like, "endpoint", None)
        if endpoint_name:
            named_endpoint = self.endpoint.endpoints.get(endpoint_name)
            if named_endpoint is None:
                raise AgentProbeConfigError(f"Unknown named endpoint: {endpoint_name}")

        method = getattr(request_like, "method", None) or (
            named_endpoint.method if named_endpoint is not None else None
        )
        url_template = getattr(request_like, "url", None) or (
            named_endpoint.url if named_endpoint is not None else None
        )
        body_template = getattr(request_like, "body_template", None) or (
            named_endpoint.body_template if named_endpoint is not None else None
        )
        headers = dict(named_endpoint.headers if named_endpoint is not None else {})

        if method is None or url_template is None:
            raise AgentProbeConfigError(
                "HTTP request definition must include method and url."
            )

        auth_headers = self._resolve_auth_headers()
        headers.update(auth_headers)
        rendered_headers = {
            key: render_template(value, request_context)
            for key, value in headers.items()
        }
        url = render_template(url_template, request_context)
        rendered_body = render_json_template(body_template, request_context)
        if isinstance(rendered_body, str):
            return _ResolvedRequest(
                method=method,
                url=url,
                headers=rendered_headers,
                content=rendered_body,
            )

        return _ResolvedRequest(
            method=method,
            url=url,
            headers=rendered_headers,
            json_body=rendered_body,
        )

    def _resolve_auth_headers(self) -> dict[str, str]:
        auth = self.endpoint.auth
        headers: dict[str, str] = {}
        if auth is None or auth.type == "none":
            headers.update(self._resolve_internal_auth_headers())
            return headers

        if auth.type == "header":
            if not auth.header_name or auth.header_value is None:
                raise AgentProbeConfigError(
                    "Header auth requires header_name and header_value."
                )
            headers[auth.header_name] = auth.header_value
            return headers

        if auth.type == "bearer_token":
            if not auth.token:
                raise AgentProbeConfigError("Bearer token auth requires token.")
            headers["Authorization"] = f"Bearer {auth.token}"
            return headers

        raise AgentProbeConfigError(
            f"Unsupported auth type for HTTP adapter: {auth.type}"
        )

    def _resolve_internal_auth_headers(self) -> dict[str, str]:
        if self._cached_auth_headers is not None:
            return dict(self._cached_auth_headers)

        from .endpoints._common import dispatch_key

        key = dispatch_key(self.endpoint)
        if key not in {"autogpt", "autogpt-endpoint.yaml", "autogpt-endpoint.yml"}:
            self._cached_auth_headers = {}
            return {}

        try:
            if self._autogpt_auth_resolver is None:
                from .endpoints.autogpt import resolve_auth as resolve_autogpt_auth

                self._autogpt_auth_resolver = resolve_autogpt_auth

            resolved = self._autogpt_auth_resolver()
        except Exception as exc:  # pragma: no cover - network/auth failure path
            raise AgentProbeRuntimeError(
                f"AutoGPT auth failed: {exc}. "
                "Verify the backend is running at the configured URL "
                "(AUTOGPT_BACKEND_URL or default http://localhost:8006) "
                "and that AUTOGPT_JWT_SECRET is set correctly."
            ) from exc

        headers = getattr(resolved, "headers", None)
        if not isinstance(headers, dict):
            raise AgentProbeRuntimeError("AutoGPT auth resolver returned no headers.")
        self._cached_auth_headers = dict(headers)
        return dict(self._cached_auth_headers)

    def _build_client(self) -> httpx.AsyncClient:
        verify: bool | str = True
        tls = self._connection.tls
        if tls is not None and tls.ca_file:
            verify = tls.ca_file
        elif tls is not None and tls.verify is not None:
            verify = tls.verify

        return httpx.AsyncClient(
            follow_redirects=True,
            timeout=self._connection.timeout_seconds or 60,
            transport=self._transport,
            verify=verify,
        )

    def _extract_tool_calls(self, payload: object) -> list[ToolCallRecord]:
        tool_extraction = self.endpoint.tool_extraction
        if tool_extraction is None or tool_extraction.format is None:
            return []

        if tool_extraction.format == "openai":
            raw_calls = _extract_openai_tool_calls(payload)
        elif tool_extraction.format == "anthropic":
            raw_calls = _extract_anthropic_tool_calls(payload)
        else:
            raw_calls = []

        calls: list[ToolCallRecord] = []
        for index, raw_call in enumerate(raw_calls, start=1):
            name, args = _normalize_tool_call(raw_call)
            if not name:
                continue
            calls.append(
                ToolCallRecord(
                    name=name,
                    args=args,
                    order=index,
                    raw=cast(
                        dict[str, Any] | None,
                        raw_call if isinstance(raw_call, dict) else None,
                    ),
                )
            )
        return calls


class WebSocketEndpointAdapter:
    def __init__(self, endpoint: Endpoints) -> None:
        if endpoint.transport != "websocket":
            raise AgentProbeConfigError(
                "WebSocket adapter requires transport: websocket."
            )
        if not isinstance(endpoint.connection, WebSocketConnection):
            raise AgentProbeConfigError(
                "WebSocket adapter requires a websocket connection."
            )
        self.endpoint = endpoint

        from .endpoints import build_websocket_adapter

        self._delegate = build_websocket_adapter(endpoint)

    async def health_check(self, render_context: Mapping[str, object]) -> None:
        await self._delegate.health_check(render_context)

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]:
        return await self._delegate.open_scenario(render_context)

    async def send_user_turn(
        self,
        render_context: Mapping[str, object],
    ) -> AdapterReply:
        return await self._delegate.send_user_turn(render_context)

    async def close_scenario(self, render_context: Mapping[str, object]) -> None:
        await self._delegate.close_scenario(render_context)


class CliHarnessEndpointAdapter:
    def __init__(self, endpoint: Endpoints) -> None:
        if endpoint.transport != "cli":
            raise AgentProbeConfigError("CLI adapter requires transport: cli.")
        self.endpoint = endpoint

    async def health_check(self, render_context: Mapping[str, object]) -> None:
        return None

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]:
        return {}

    async def send_user_turn(
        self,
        render_context: Mapping[str, object],
    ) -> AdapterReply:
        raise AgentProbeRuntimeError("CLI harness execution is not implemented yet.")

    async def close_scenario(self, render_context: Mapping[str, object]) -> None:
        return None


def build_endpoint_adapter(
    endpoints: Endpoints,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    autogpt_auth_resolver: Callable[[], object] | None = None,
) -> EndpointAdapter:
    from .endpoints import configure_endpoint
    from .endpoints._common import dispatch_key
    from .endpoints.openclaw import build_adapter as build_openclaw_adapter

    configured = configure_endpoint(endpoints)

    if configured.transport == "http":
        return HttpEndpointAdapter(
            configured,
            transport=transport,
            autogpt_auth_resolver=autogpt_auth_resolver,
        )
    if configured.transport == "websocket":
        if dispatch_key(endpoints) in {
            "openclaw",
            "openclaw-endpoints.yaml",
            "openclaw-endpoints.yml",
        }:
            return build_openclaw_adapter(configured)
        return WebSocketEndpointAdapter(configured)
    if configured.transport == "cli":
        return CliHarnessEndpointAdapter(configured)

    raise AgentProbeConfigError(f"Unsupported transport: {configured.transport}")


def _extract_usage(payload: object) -> dict[str, Any]:
    if isinstance(payload, dict):
        usage = payload.get("usage")
        if isinstance(usage, dict):
            return dict(usage)
    return {}


def _extract_text(payload: object, expr: str) -> str:
    matches = _extract_matches(payload, expr)
    flattened = _flatten_text_chunks(matches)
    return "\n".join(flattened).strip()


def _extract_first_match(payload: object, expr: str) -> object | None:
    matches = _extract_matches(payload, expr)
    if not matches:
        return None
    return matches[0]


def _extract_matches(payload: object, expr: str) -> list[object]:
    try:
        parser = _compiled_jsonpath(expr)
        return [match.value for match in parser.find(payload)]
    except Exception as exc:  # pragma: no cover - parser-specific failures vary
        raise AgentProbeConfigError(f"Invalid JSONPath `{expr}`: {exc}") from exc


@lru_cache(maxsize=128)
def _compiled_jsonpath(expr: str) -> Any:
    return parse_jsonpath(expr)


def _flatten_text_chunks(values: Sequence[object]) -> list[str]:
    chunks: list[str] = []
    for value in values:
        if value is None:
            continue
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                chunks.append(stripped)
            continue
        if isinstance(value, Sequence) and not isinstance(
            value, (str, bytes, bytearray)
        ):
            chunks.extend(_flatten_text_chunks(list(value)))
            continue
        chunks.append(_coerce_scalar_text(value))
    return chunks


def _coerce_scalar_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    return json.dumps(value, sort_keys=True)


def _parse_sse_events(lines: Sequence[str]) -> list[object]:
    events: list[object] = []
    data_lines: list[str] = []

    def flush() -> None:
        if not data_lines:
            return
        payload = "\n".join(data_lines).strip()
        data_lines.clear()
        if not payload or payload == "[DONE]":
            return
        try:
            events.append(json.loads(payload))
        except json.JSONDecodeError:
            events.append({"data": payload})

    for line in lines:
        stripped = line.strip()
        if not stripped:
            flush()
            continue
        if stripped.startswith(":"):
            continue
        field, _, value = stripped.partition(":")
        if field == "data":
            data_lines.append(value.lstrip())

    flush()
    return events


def _extract_openai_tool_calls(payload: object) -> list[object]:
    calls: list[object] = []
    for item in _iterate_payload_objects(payload):
        if not isinstance(item, dict):
            continue
        direct = item.get("tool_calls")
        if isinstance(direct, list):
            calls.extend(direct)

        choices = item.get("choices")
        if not isinstance(choices, list):
            continue
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict) and isinstance(
                message.get("tool_calls"), list
            ):
                calls.extend(cast(list[object], message["tool_calls"]))
            delta = choice.get("delta")
            if isinstance(delta, dict) and isinstance(delta.get("tool_calls"), list):
                calls.extend(cast(list[object], delta["tool_calls"]))
    return calls


def _extract_anthropic_tool_calls(payload: object) -> list[object]:
    calls: list[object] = []
    for item in _iterate_payload_objects(payload):
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                calls.append(block)
    return calls


def _iterate_payload_objects(payload: object) -> Sequence[object]:
    if isinstance(payload, list):
        return payload
    return [payload]


def _normalize_tool_call(raw_call: object) -> tuple[str | None, dict[str, Any]]:
    if not isinstance(raw_call, dict):
        return None, {}

    function = raw_call.get("function")
    if isinstance(function, dict):
        name = function.get("name")
        arguments = function.get("arguments")
    else:
        name = raw_call.get("name")
        arguments = raw_call.get("input") or raw_call.get("args")

    normalized_name = name if isinstance(name, str) and name.strip() else None
    return normalized_name, _parse_tool_args(arguments)


def _parse_tool_args(arguments: object) -> dict[str, Any]:
    if isinstance(arguments, dict):
        return dict(arguments)
    if isinstance(arguments, str) and arguments.strip():
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return {"raw": arguments}
        if isinstance(parsed, dict):
            return dict(parsed)
        return {"value": parsed}
    return {}


__all__ = [
    "AdapterReply",
    "CliHarnessEndpointAdapter",
    "EndpointAdapter",
    "HttpEndpointAdapter",
    "ToolCallRecord",
    "WebSocketEndpointAdapter",
    "build_endpoint_adapter",
]
