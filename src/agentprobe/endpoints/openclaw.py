from __future__ import annotations

import asyncio
import base64
import contextlib
import copy
import hashlib
import json
import os
import ssl
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from pydantic import Field
from websockets.asyncio.client import ClientConnection, connect as ws_connect
from websockets.exceptions import ConnectionClosed

from agentprobe.adapters import AdapterReply, EndpointAdapter
from agentprobe.data.common import AgentProbeModel
from agentprobe.data.endpoints import (
    Endpoints,
    TlsConfig,
    WebSocketConnect,
    WebSocketConnection,
    WebSocketTransport,
    parse_endpoints_yaml,
)
from agentprobe.errors import AgentProbeRuntimeError

from ._common import clone_with_resolved_env

DEFAULT_CONNECTION_TIMEOUT_SECONDS = 30
DEFAULT_CONNECT_CHALLENGE_TIMEOUT_SECONDS = 2.0
DEFAULT_REPLY_TIMEOUT_MS = 30_000
DEFAULT_HISTORY_LIMIT = 200
DEFAULT_PROTOCOL_VERSION = 3
DEFAULT_CLIENT_ID = "openclaw-probe"
DEFAULT_CLIENT_MODE = "probe"
STATE_DIR_ENV = "AGENTPROBE_STATE_DIR"
DEVICE_IDENTITY_FILE = "device.json"
DEVICE_AUTH_FILE = "device-auth.json"


class OpenClawGatewayError(AgentProbeRuntimeError):
    pass


class OpenClawGatewayTimeout(OpenClawGatewayError):
    pass


class OpenClawGatewayRequestError(OpenClawGatewayError):
    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        details: object | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details


@dataclass(slots=True)
class _DeviceIdentity:
    device_id: str
    public_key_pem: str
    private_key_pem: str


@dataclass(slots=True)
class _DeviceAuthEntry:
    token: str
    role: str
    scopes: list[str]
    updated_at_ms: int


@dataclass(slots=True)
class _SelectedConnectAuth:
    auth: dict[str, str]
    signature_token: str | None


class OpenClawSession(AgentProbeModel):
    key: str
    session_id: str | None = None
    entry: dict[str, Any] = Field(default_factory=dict)


class OpenClawHistory(AgentProbeModel):
    session_key: str
    session_id: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    thinking_level: str | None = None
    fast_mode: bool | None = None
    verbose_level: str | None = None


class OpenClawChatResult(AgentProbeModel):
    session_key: str
    session_id: str | None = None
    run_id: str
    status: Literal["started", "ok", "error", "timeout", "aborted", "in_flight"]
    reply: str | None = None
    error: str | None = None
    message: dict[str, Any] | None = None


class OpenClawEndpointAdapter:
    def __init__(self, endpoint: Endpoints) -> None:
        self.endpoint = configure(endpoint)
        self._client: OpenClawGatewayClient | None = None
        self._session: OpenClawSession | None = None

    async def health_check(self, render_context: Mapping[str, object]) -> None:
        if (
            self.endpoint.health_check is None
            or self.endpoint.health_check.enabled is False
        ):
            return

        client = await self._ensure_client()
        await client.health()

    async def open_scenario(
        self,
        render_context: Mapping[str, object],
    ) -> dict[str, object]:
        client = await self._ensure_client()
        session_key = _trim_to_none(render_context.get("session_key")) or _trim_to_none(
            render_context.get("sessionKey")
        )
        label = _scenario_label(render_context)

        self._session = await client.create_session(key=session_key, label=label)
        return {
            "session_key": self._session.key,
            "session_id": self._session.session_id or "",
        }

    async def send_user_turn(
        self,
        render_context: Mapping[str, object],
    ) -> AdapterReply:
        client = await self._ensure_client()
        session_key = self._resolve_session_key(render_context)
        message = _context_message(render_context)
        if not message:
            raise OpenClawGatewayError("OpenClaw adapter requires a user message.")

        start = time.perf_counter()
        result = await client.send_message(session_key, message)
        latency_ms = (time.perf_counter() - start) * 1000.0

        return AdapterReply(
            assistant_text=result.reply or "",
            raw_exchange={
                "request": {
                    "session_key": session_key,
                    "message": message,
                },
                "response": result.model_dump(exclude_none=True),
            },
            latency_ms=latency_ms,
        )

    async def close_scenario(self, render_context: Mapping[str, object]) -> None:
        if self._client is None:
            return
        try:
            await self._client.close()
        finally:
            self._client = None
            self._session = None

    async def _ensure_client(self) -> OpenClawGatewayClient:
        if self._client is None:
            self._client = OpenClawGatewayClient(self.endpoint)
            await self._client.connect()
        return self._client

    def _resolve_session_key(self, render_context: Mapping[str, object]) -> str:
        if self._session is not None:
            return self._session.key

        session_key = _trim_to_none(render_context.get("session_key")) or _trim_to_none(
            render_context.get("sessionKey")
        )
        if session_key is None:
            raise OpenClawGatewayError("OpenClaw adapter has no active session key.")
        return session_key


class OpenClawGatewayClient:
    def __init__(self, endpoint: Endpoints) -> None:
        if endpoint.transport != "websocket":
            raise ValueError("OpenClaw runtime requires a websocket endpoint.")
        if not isinstance(endpoint.connection, WebSocketConnection):
            raise ValueError("OpenClaw runtime requires connection.url.")
        if endpoint.websocket is None or endpoint.websocket.connect is None:
            raise ValueError("OpenClaw runtime requires websocket.connect.")

        self.endpoint = endpoint
        self.connection = endpoint.connection
        self.connect_config: WebSocketConnect = endpoint.websocket.connect
        self._ws: ClientConnection | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._chat_waiters: dict[
            tuple[str, str], list[asyncio.Queue[dict[str, Any]]]
        ] = {}
        self._connect_lock = asyncio.Lock()
        self._connected = False
        self._challenge_nonce: asyncio.Future[str] | None = None
        self.hello: dict[str, Any] | None = None

        self._state_dir = _resolve_state_dir() / "openclaw"
        self._identity_path = self._state_dir / DEVICE_IDENTITY_FILE
        self._auth_store_path = self._state_dir / DEVICE_AUTH_FILE
        self._device_identity: _DeviceIdentity | None = None

    async def __aenter__(self) -> OpenClawGatewayClient:
        await self.connect()
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.close()

    async def connect(self) -> None:
        if self._connected and self._ws is not None:
            return

        async with self._connect_lock:
            if self._connected and self._ws is not None:
                return

            attempts = 1 + max(self.connection.max_retries or 0, 0)
            last_error: Exception | None = None
            use_stored_device_token_retry = False
            consumed_device_token_retry = False

            for attempt in range(1, attempts + 1):
                while True:
                    try:
                        self._challenge_nonce = (
                            asyncio.get_running_loop().create_future()
                        )
                        self._ws = await ws_connect(
                            self.connection.url,
                            open_timeout=self._timeout_seconds(),
                            close_timeout=self._timeout_seconds(),
                            ssl=_build_ssl_context(
                                self.connection.tls, self.connection.url
                            ),
                        )
                        self._reader_task = asyncio.create_task(self._reader_loop())

                        nonce = await asyncio.wait_for(
                            self._challenge_nonce,
                            timeout=min(
                                self._timeout_seconds(),
                                DEFAULT_CONNECT_CHALLENGE_TIMEOUT_SECONDS,
                            ),
                        )

                        self.hello = await self._call_raw(
                            self.connect_config.method or "connect",
                            self._build_connect_params(
                                nonce,
                                use_stored_device_token_retry=use_stored_device_token_retry,
                            ),
                        )
                        self._connected = True
                        self._persist_issued_device_token()

                        if (
                            self.endpoint.health_check
                            and self.endpoint.health_check.enabled
                        ):
                            await self.health()
                        return
                    except OpenClawGatewayRequestError as exc:
                        last_error = exc
                        if (
                            not consumed_device_token_retry
                            and self._should_retry_with_stored_device_token(exc)
                        ):
                            consumed_device_token_retry = True
                            use_stored_device_token_retry = True
                            await self._shutdown_connection()
                            continue
                        await self._shutdown_connection()
                        break
                    except Exception as exc:  # pragma: no cover - retry guard
                        last_error = exc
                        await self._shutdown_connection()
                        break

                if attempt >= attempts:
                    break

                use_stored_device_token_retry = False
                await asyncio.sleep(min(0.5 * attempt, 2.0))

            assert last_error is not None
            raise OpenClawGatewayError(
                f"Failed to connect to OpenClaw gateway: {last_error}"
            ) from last_error

    async def close(self) -> None:
        await self._shutdown_connection()

    async def health(self) -> dict[str, Any]:
        method = (
            self.endpoint.health_check.endpoint
            if self.endpoint.health_check and self.endpoint.health_check.endpoint
            else "health"
        )
        payload = await self.call(method)
        return payload if isinstance(payload, dict) else {"payload": payload}

    async def create_session(
        self,
        *,
        key: str | None = None,
        label: str | None = None,
        agent_id: str | None = None,
        model: str | None = None,
    ) -> OpenClawSession:
        params: dict[str, Any] = {}
        if key:
            params["key"] = key
        if label:
            params["label"] = label
        if agent_id:
            params["agentId"] = agent_id
        if model:
            params["model"] = model

        payload = await self.call("sessions.create", params)
        if not isinstance(payload, dict):
            raise OpenClawGatewayError("sessions.create returned an invalid payload.")

        session_key = payload.get("key")
        if not isinstance(session_key, str) or not session_key.strip():
            raise OpenClawGatewayError("sessions.create did not return a session key.")

        session_id = payload.get("sessionId")
        entry = payload.get("entry")
        return OpenClawSession(
            key=session_key,
            session_id=session_id if isinstance(session_id, str) else None,
            entry=entry if isinstance(entry, dict) else {},
        )

    async def history(
        self,
        session_key: str,
        *,
        limit: int = DEFAULT_HISTORY_LIMIT,
    ) -> OpenClawHistory:
        payload = await self.call(
            "chat.history",
            {
                "sessionKey": session_key,
                "limit": max(1, min(limit, 1000)),
            },
        )
        if not isinstance(payload, dict):
            raise OpenClawGatewayError("chat.history returned an invalid payload.")

        raw_messages = payload.get("messages")
        messages = (
            [item for item in raw_messages if isinstance(item, dict)]
            if isinstance(raw_messages, list)
            else []
        )
        session_id = payload.get("sessionId")
        thinking_level = payload.get("thinkingLevel")
        verbose_level = payload.get("verboseLevel")
        fast_mode = payload.get("fastMode")

        return OpenClawHistory(
            session_key=session_key,
            session_id=session_id if isinstance(session_id, str) else None,
            messages=messages,
            thinking_level=thinking_level if isinstance(thinking_level, str) else None,
            fast_mode=fast_mode if isinstance(fast_mode, bool) else None,
            verbose_level=verbose_level if isinstance(verbose_level, str) else None,
        )

    async def send_message(
        self,
        session_key: str,
        message: str,
        *,
        thinking: str | None = None,
        wait_for_reply: bool = True,
        timeout_ms: int = DEFAULT_REPLY_TIMEOUT_MS,
        idempotency_key: str | None = None,
    ) -> OpenClawChatResult:
        requested_run_id = (idempotency_key or uuid.uuid4().hex).strip()
        waiter_run_id = requested_run_id
        queue = self._register_chat_waiter(waiter_run_id, session_key)

        params: dict[str, Any] = {
            "sessionKey": session_key,
            "message": message,
            "timeoutMs": max(0, timeout_ms),
            "idempotencyKey": requested_run_id,
        }
        if thinking:
            params["thinking"] = thinking

        try:
            payload = await self.call("chat.send", params)
            if not isinstance(payload, dict):
                raise OpenClawGatewayError("chat.send returned an invalid payload.")

            resolved_run_id = payload.get("runId")
            run_id = (
                resolved_run_id.strip()
                if isinstance(resolved_run_id, str) and resolved_run_id.strip()
                else requested_run_id
            )
            if run_id != requested_run_id:
                self._unregister_chat_waiter(waiter_run_id, session_key, queue)
                waiter_run_id = run_id
                queue = self._register_chat_waiter(waiter_run_id, session_key)

            status = _coerce_chat_status(payload.get("status"))
            result = OpenClawChatResult(
                session_key=session_key,
                run_id=run_id,
                status=status,
            )

            if status == "ok":
                history = await self.history(session_key)
                result.session_id = history.session_id
                result.reply = _latest_assistant_reply(history.messages)
                return result

            if status == "error":
                summary = payload.get("summary")
                result.error = (
                    summary if isinstance(summary, str) else "Gateway run failed."
                )
                return result

            if status == "aborted":
                result.error = "Run was aborted by the gateway."
                return result

            if not wait_for_reply or timeout_ms == 0:
                return result

            event = await self._wait_for_chat_terminal_event(
                queue, timeout_ms=timeout_ms
            )
            if event is None:
                history = await self.history(session_key)
                return OpenClawChatResult(
                    session_key=session_key,
                    session_id=history.session_id,
                    run_id=run_id,
                    status="timeout",
                    reply=_latest_assistant_reply(history.messages),
                    error=f"Timed out waiting for reply after {timeout_ms}ms.",
                )

            state = event.get("state")
            if state == "final":
                event_message = event.get("message")
                message_payload = (
                    event_message if isinstance(event_message, dict) else None
                )
                reply = _message_text(message_payload)
                session_id = None
                if reply is None:
                    history = await self.history(session_key)
                    reply = _latest_assistant_reply(history.messages)
                    session_id = history.session_id

                return OpenClawChatResult(
                    session_key=session_key,
                    session_id=session_id,
                    run_id=run_id,
                    status="ok",
                    reply=reply,
                    message=message_payload,
                )

            if state == "aborted":
                return OpenClawChatResult(
                    session_key=session_key,
                    run_id=run_id,
                    status="aborted",
                    error="Run was aborted by the gateway.",
                )

            error_message = event.get("errorMessage")
            return OpenClawChatResult(
                session_key=session_key,
                run_id=run_id,
                status="error",
                error=error_message
                if isinstance(error_message, str)
                else "Gateway run failed.",
            )
        finally:
            self._unregister_chat_waiter(waiter_run_id, session_key, queue)

    async def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        await self.connect()
        return await self._call_raw(method, params)

    async def _call_raw(self, method: str, params: dict[str, Any] | None = None) -> Any:
        if self._ws is None:
            raise OpenClawGatewayError("WebSocket connection is not open.")

        request_id = uuid.uuid4().hex
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future

        frame: dict[str, Any] = {
            "type": "req",
            "id": request_id,
            "method": method,
        }
        if params is not None:
            frame["params"] = params

        try:
            await self._ws.send(json.dumps(frame))
            response = await asyncio.wait_for(future, timeout=self._timeout_seconds())
        except asyncio.TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise OpenClawGatewayTimeout(f"{method} timed out.") from exc

        if response.get("ok") is not True:
            error = response.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                code = error.get("code")
                details = error.get("details")
                raise OpenClawGatewayRequestError(
                    message
                    if isinstance(message, str) and message.strip()
                    else f"{method} failed.",
                    code=code if isinstance(code, str) and code.strip() else None,
                    details=details,
                )
            raise OpenClawGatewayRequestError(f"{method} failed.")

        return response.get("payload")

    async def _reader_loop(self) -> None:
        assert self._ws is not None
        try:
            async for raw_frame in self._ws:
                frame = _parse_frame(raw_frame)
                frame_type = frame.get("type")

                if frame_type == "res":
                    request_id = frame.get("id")
                    if not isinstance(request_id, str):
                        continue
                    future = self._pending.pop(request_id, None)
                    if future is not None and not future.done():
                        future.set_result(frame)
                    continue

                if frame_type != "event":
                    continue

                event_name = frame.get("event")
                payload = frame.get("payload")

                if event_name == self._challenge_event_name():
                    nonce = payload.get("nonce") if isinstance(payload, dict) else None
                    if (
                        isinstance(nonce, str)
                        and nonce.strip()
                        and self._challenge_nonce is not None
                        and not self._challenge_nonce.done()
                    ):
                        self._challenge_nonce.set_result(nonce.strip())
                    elif (
                        self._challenge_nonce is not None
                        and not self._challenge_nonce.done()
                    ):
                        self._challenge_nonce.set_exception(
                            OpenClawGatewayError(
                                "Gateway connect challenge missing nonce."
                            )
                        )
                    continue

                if event_name != "chat":
                    continue

                if not isinstance(payload, dict):
                    continue

                run_id = payload.get("runId")
                session_key = payload.get("sessionKey")
                if not isinstance(run_id, str) or not isinstance(session_key, str):
                    continue

                for queue in list(self._chat_waiters.get((run_id, session_key), [])):
                    await queue.put(payload)
        except ConnectionClosed as exc:
            self._fail_pending(
                OpenClawGatewayError(f"Gateway connection closed: {exc}")
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - unexpected reader failures
            self._fail_pending(OpenClawGatewayError(f"Gateway reader failed: {exc}"))
        finally:
            self._connected = False
            self._ws = None

    async def _shutdown_connection(self) -> None:
        reader_task = self._reader_task
        self._reader_task = None
        ws = self._ws
        self._ws = None
        self._connected = False

        if reader_task is not None:
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader_task

        if ws is not None:
            with contextlib.suppress(Exception):
                await ws.close()

        self._fail_pending(OpenClawGatewayError("Gateway connection closed."))

    def _fail_pending(self, exc: Exception) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_exception(exc)
        self._pending.clear()

        if self._challenge_nonce is not None and not self._challenge_nonce.done():
            self._challenge_nonce.set_exception(exc)
        self._challenge_nonce = None

        for queues in self._chat_waiters.values():
            for queue in queues:
                queue.put_nowait({"state": "error", "errorMessage": str(exc)})

    def _build_connect_params(
        self,
        nonce: str,
        *,
        use_stored_device_token_retry: bool,
    ) -> dict[str, Any]:
        params = copy.deepcopy(self.connect_config.params)

        client = params.get("client")
        client_payload = client if isinstance(client, dict) else {}
        client_id = _trim_to_none(client_payload.get("id")) or DEFAULT_CLIENT_ID
        client_mode = _trim_to_none(client_payload.get("mode")) or DEFAULT_CLIENT_MODE
        client_version = _trim_to_none(client_payload.get("version")) or "0.1.0"
        platform = _trim_to_none(client_payload.get("platform")) or "python"
        device_family = _trim_to_none(client_payload.get("deviceFamily"))

        role = _trim_to_none(params.get("role")) or "operator"
        scopes = _coerce_str_list(params.get("scopes")) or [
            "operator.read",
            "operator.write",
        ]

        auth_payload = params.get("auth")
        auth_config = auth_payload if isinstance(auth_payload, dict) else {}
        auth = self._select_connect_auth(
            role,
            auth_config,
            use_stored_device_token_retry=use_stored_device_token_retry,
        )

        identity = self._load_device_identity()
        signed_at_ms = _now_ms()
        signature_payload = _build_device_auth_payload_v3(
            device_id=identity.device_id,
            client_id=client_id,
            client_mode=client_mode,
            role=role,
            scopes=scopes,
            signed_at_ms=signed_at_ms,
            token=auth.signature_token,
            nonce=nonce,
            platform=platform,
            device_family=device_family,
        )

        params["minProtocol"] = _coerce_int(
            params.get("minProtocol"), DEFAULT_PROTOCOL_VERSION
        )
        params["maxProtocol"] = _coerce_int(
            params.get("maxProtocol"), DEFAULT_PROTOCOL_VERSION
        )
        params["client"] = {
            **client_payload,
            "id": client_id,
            "version": client_version,
            "platform": platform,
            "mode": client_mode,
        }
        params["role"] = role
        params["scopes"] = scopes
        params["device"] = {
            "id": identity.device_id,
            "publicKey": _public_key_raw_base64url_from_pem(identity.public_key_pem),
            "signature": _sign_device_payload(
                identity.private_key_pem, signature_payload
            ),
            "signedAt": signed_at_ms,
            "nonce": nonce,
        }
        if auth.auth:
            params["auth"] = auth.auth
        else:
            params.pop("auth", None)

        return params

    def _select_connect_auth(
        self,
        role: str,
        auth_config: dict[str, Any],
        *,
        use_stored_device_token_retry: bool,
    ) -> _SelectedConnectAuth:
        explicit_token = _trim_to_none(auth_config.get("token"))
        explicit_bootstrap_token = _trim_to_none(auth_config.get("bootstrapToken"))
        explicit_password = _trim_to_none(auth_config.get("password"))
        explicit_device_token = _trim_to_none(auth_config.get("deviceToken"))

        stored_entry = _load_device_auth_token(
            self._auth_store_path,
            device_id=self._load_device_identity().device_id,
            role=role,
        )
        stored_token = stored_entry.token if stored_entry is not None else None

        resolved_device_token = explicit_device_token
        if resolved_device_token is None:
            if use_stored_device_token_retry and stored_token:
                resolved_device_token = stored_token
            elif not explicit_token and not explicit_password:
                if not explicit_bootstrap_token or stored_token:
                    resolved_device_token = stored_token

        auth: dict[str, str] = {}
        if explicit_token:
            auth["token"] = explicit_token
        elif resolved_device_token:
            auth["token"] = resolved_device_token

        if (
            not explicit_token
            and not resolved_device_token
            and explicit_bootstrap_token
        ):
            auth["bootstrapToken"] = explicit_bootstrap_token
        if explicit_password:
            auth["password"] = explicit_password
        if use_stored_device_token_retry and stored_token:
            auth["deviceToken"] = stored_token

        signature_token = (
            auth.get("token") or auth.get("bootstrapToken") or auth.get("deviceToken")
        )
        return _SelectedConnectAuth(auth=auth, signature_token=signature_token)

    def _persist_issued_device_token(self) -> None:
        auth = self.hello.get("auth") if isinstance(self.hello, dict) else None
        if not isinstance(auth, dict):
            return

        token = auth.get("deviceToken")
        role = auth.get("role")
        scopes = auth.get("scopes")
        if not isinstance(token, str) or not token.strip():
            return

        _store_device_auth_token(
            self._auth_store_path,
            device_id=self._load_device_identity().device_id,
            role=role
            if isinstance(role, str) and role.strip()
            else self._configured_role(),
            token=token.strip(),
            scopes=_coerce_str_list(scopes),
        )

    def _should_retry_with_stored_device_token(
        self,
        exc: OpenClawGatewayRequestError,
    ) -> bool:
        if not self._is_trusted_device_retry_endpoint():
            return False

        stored_entry = _load_device_auth_token(
            self._auth_store_path,
            device_id=self._load_device_identity().device_id,
            role=self._configured_role(),
        )
        if stored_entry is None:
            return False

        details = exc.details if isinstance(exc.details, dict) else {}
        retry_advised = details.get("recommendedNextStep") == "retry_with_device_token"
        retry_allowed = details.get("canRetryWithDeviceToken") is True
        return retry_allowed or retry_advised or exc.code == "AUTH_TOKEN_MISMATCH"

    def _is_trusted_device_retry_endpoint(self) -> bool:
        parsed = urlparse(self.connection.url)
        return parsed.scheme == "wss" or parsed.hostname in {
            "127.0.0.1",
            "::1",
            "localhost",
        }

    def _configured_role(self) -> str:
        return _trim_to_none(self.connect_config.params.get("role")) or "operator"

    def _challenge_event_name(self) -> str:
        return self.connect_config.challenge_event or "connect.challenge"

    def _load_device_identity(self) -> _DeviceIdentity:
        if self._device_identity is None:
            self._device_identity = _load_or_create_device_identity(self._identity_path)
        return self._device_identity

    def _register_chat_waiter(
        self,
        run_id: str,
        session_key: str,
    ) -> asyncio.Queue[dict[str, Any]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._chat_waiters.setdefault((run_id, session_key), []).append(queue)
        return queue

    def _unregister_chat_waiter(
        self,
        run_id: str,
        session_key: str,
        queue: asyncio.Queue[dict[str, Any]],
    ) -> None:
        key = (run_id, session_key)
        queues = self._chat_waiters.get(key)
        if queues is None:
            return
        remaining = [item for item in queues if item is not queue]
        if remaining:
            self._chat_waiters[key] = remaining
            return
        self._chat_waiters.pop(key, None)

    async def _wait_for_chat_terminal_event(
        self,
        queue: asyncio.Queue[dict[str, Any]],
        *,
        timeout_ms: int,
    ) -> dict[str, Any] | None:
        deadline = asyncio.get_running_loop().time() + (timeout_ms / 1000)

        while True:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                return None

            try:
                event = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                return None

            if event.get("state") in {"final", "error", "aborted"}:
                return event

    def _timeout_seconds(self) -> float:
        return float(
            self.connection.timeout_seconds or DEFAULT_CONNECTION_TIMEOUT_SECONDS
        )


def configure(endpoint: Endpoints) -> Endpoints:
    normalized = clone_with_resolved_env(endpoint)

    if normalized.transport != "websocket":
        raise ValueError("OpenClaw endpoints require transport: websocket.")

    connection = normalized.connection
    if not isinstance(connection, WebSocketConnection) or not connection.url:
        raise ValueError("OpenClaw endpoints require connection.url.")
    if not connection.url.startswith(("ws://", "wss://")):
        raise ValueError("OpenClaw connection.url must use ws:// or wss://.")

    websocket = normalized.websocket
    if websocket is None:
        websocket = WebSocketTransport()
        normalized.websocket = websocket

    connect = websocket.connect
    if connect is None:
        connect = WebSocketConnect()
        websocket.connect = connect

    if connect.challenge_event is None:
        connect.challenge_event = "connect.challenge"
    if connect.challenge_event != "connect.challenge":
        raise ValueError(
            "OpenClaw websocket.connect.challenge_event must be connect.challenge."
        )

    if connect.method is None:
        connect.method = "connect"
    if connect.method != "connect":
        raise ValueError("OpenClaw websocket.connect.method must be connect.")

    params = connect.params
    client = params.get("client")
    if client is None:
        client = {}
        params["client"] = client
    if not isinstance(client, dict):
        raise ValueError("OpenClaw websocket.connect.params.client must be an object.")
    client.setdefault("id", DEFAULT_CLIENT_ID)
    client.setdefault("version", "0.1.0")
    client.setdefault("platform", "python")
    client.setdefault("mode", DEFAULT_CLIENT_MODE)

    params.setdefault("minProtocol", DEFAULT_PROTOCOL_VERSION)
    params.setdefault("maxProtocol", DEFAULT_PROTOCOL_VERSION)
    params.setdefault("role", "operator")
    params.setdefault("scopes", ["operator.read", "operator.write"])
    params.setdefault("caps", [])
    params.setdefault("commands", [])
    params.setdefault("permissions", {})

    auth = params.get("auth")
    if auth is None:
        auth = {}
        params["auth"] = auth
    if not isinstance(auth, dict):
        raise ValueError("OpenClaw websocket.connect.params.auth must be an object.")
    auth.setdefault("token", "")

    return normalized


def build_adapter(endpoint: Endpoints) -> EndpointAdapter:
    return OpenClawEndpointAdapter(endpoint)


async def openclaw_chat(
    endpoint: Endpoints,
    *,
    message: str,
    session_key: str | None = None,
    label: str | None = None,
    thinking: str | None = None,
    wait_for_reply: bool = True,
    timeout_ms: int = DEFAULT_REPLY_TIMEOUT_MS,
) -> OpenClawChatResult:
    async with OpenClawGatewayClient(configure(endpoint)) as client:
        session = await client.create_session(key=session_key, label=label)
        result = await client.send_message(
            session.key,
            message,
            thinking=thinking,
            wait_for_reply=wait_for_reply,
            timeout_ms=timeout_ms,
        )
        if result.session_id is None:
            result.session_id = session.session_id
        return result


async def openclaw_history(
    endpoint: Endpoints,
    *,
    session_key: str,
    limit: int = DEFAULT_HISTORY_LIMIT,
) -> OpenClawHistory:
    async with OpenClawGatewayClient(configure(endpoint)) as client:
        return await client.history(session_key, limit=limit)


def load_configured_endpoint(path: str | Path) -> Endpoints:
    return configure(parse_endpoints_yaml(path))


def _scenario_label(render_context: Mapping[str, object]) -> str | None:
    label = _trim_to_none(render_context.get("label"))
    if label:
        return label

    scenario = render_context.get("scenario")
    scenario_name = getattr(scenario, "name", None)
    if isinstance(scenario_name, str) and scenario_name.strip():
        return scenario_name.strip()
    return None


def _context_message(render_context: Mapping[str, object]) -> str | None:
    last_message = render_context.get("last_message")
    content = getattr(last_message, "content", None)
    if isinstance(content, str) and content.strip():
        return content

    message = render_context.get("message")
    if isinstance(message, str) and message.strip():
        return message

    return None


def _build_ssl_context(tls: TlsConfig | None, url: str) -> ssl.SSLContext | None:
    if not url.startswith("wss://"):
        return None

    context = ssl.create_default_context()
    if tls is None:
        return context

    if tls.verify is False:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    if tls.ca_file:
        context.load_verify_locations(cafile=tls.ca_file)
    if tls.cert_file:
        context.load_cert_chain(certfile=tls.cert_file, keyfile=tls.key_file)

    return context


def _parse_frame(raw_frame: str | bytes) -> dict[str, Any]:
    try:
        text = raw_frame.decode("utf-8") if isinstance(raw_frame, bytes) else raw_frame
        payload = json.loads(text)
    except Exception as exc:  # pragma: no cover
        raise OpenClawGatewayError(f"Invalid gateway frame: {exc}") from exc

    if not isinstance(payload, dict):
        raise OpenClawGatewayError("Gateway frame must be a JSON object.")
    return payload


def _coerce_chat_status(
    raw_status: object,
) -> Literal["started", "ok", "error", "timeout", "aborted", "in_flight"]:
    if raw_status == "ok":
        return "ok"
    if raw_status == "error":
        return "error"
    if raw_status == "timeout":
        return "timeout"
    if raw_status == "aborted":
        return "aborted"
    if raw_status == "in_flight":
        return "in_flight"
    return "started"


def _message_text(message: dict[str, Any] | None) -> str | None:
    if not message:
        return None

    text = message.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()

    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content.strip()

    if isinstance(content, list):
        chunks: list[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            chunk = item.get("text")
            if isinstance(chunk, str) and chunk.strip():
                chunks.append(chunk.strip())
        if chunks:
            return "\n".join(chunks)

    return None


def _latest_assistant_reply(messages: list[dict[str, Any]]) -> str | None:
    for message in reversed(messages):
        if message.get("role") != "assistant":
            continue
        reply = _message_text(message)
        if reply:
            return reply
    return None


def _resolve_state_dir() -> Path:
    configured = os.getenv(STATE_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve()

    xdg_state_home = os.getenv("XDG_STATE_HOME")
    if xdg_state_home:
        return Path(xdg_state_home).expanduser().resolve() / "agentprobe"

    return (Path.home() / ".local" / "state" / "agentprobe").resolve()


def _load_or_create_device_identity(path: Path) -> _DeviceIdentity:
    try:
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
            if (
                payload.get("version") == 1
                and isinstance(payload.get("deviceId"), str)
                and isinstance(payload.get("publicKeyPem"), str)
                and isinstance(payload.get("privateKeyPem"), str)
            ):
                public_key_pem = payload["publicKeyPem"]
                private_key_pem = payload["privateKeyPem"]
                device_id = _derive_device_id_from_public_pem(public_key_pem)
                if device_id != payload["deviceId"]:
                    _write_json(path, {**payload, "deviceId": device_id})
                return _DeviceIdentity(
                    device_id=device_id,
                    public_key_pem=public_key_pem,
                    private_key_pem=private_key_pem,
                )
    except Exception:
        pass

    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key()
    public_key_pem = public_key.public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    private_key_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    device_id = _derive_device_id_from_public_pem(public_key_pem)

    _write_json(
        path,
        {
            "version": 1,
            "deviceId": device_id,
            "publicKeyPem": public_key_pem,
            "privateKeyPem": private_key_pem,
            "createdAtMs": _now_ms(),
        },
    )
    return _DeviceIdentity(
        device_id=device_id,
        public_key_pem=public_key_pem,
        private_key_pem=private_key_pem,
    )


def _load_device_auth_token(
    path: Path,
    *,
    device_id: str,
    role: str,
) -> _DeviceAuthEntry | None:
    store = _read_json(path)
    if not isinstance(store, dict):
        return None
    if store.get("version") != 1 or store.get("deviceId") != device_id:
        return None

    tokens = store.get("tokens")
    if not isinstance(tokens, dict):
        return None

    entry = tokens.get(role.strip())
    if not isinstance(entry, dict):
        return None

    token = entry.get("token")
    scopes = entry.get("scopes")
    updated_at_ms = entry.get("updatedAtMs")
    if not isinstance(token, str) or not token.strip():
        return None

    return _DeviceAuthEntry(
        token=token.strip(),
        role=role.strip(),
        scopes=_coerce_str_list(scopes),
        updated_at_ms=updated_at_ms if isinstance(updated_at_ms, int) else 0,
    )


def _store_device_auth_token(
    path: Path,
    *,
    device_id: str,
    role: str,
    token: str,
    scopes: list[str],
) -> None:
    normalized_role = role.strip()
    existing = _read_json(path)
    existing_tokens: dict[str, Any] = {}
    if (
        isinstance(existing, dict)
        and existing.get("version") == 1
        and existing.get("deviceId") == device_id
        and isinstance(existing.get("tokens"), dict)
    ):
        existing_tokens = dict(existing["tokens"])

    existing_tokens[normalized_role] = {
        "token": token,
        "role": normalized_role,
        "scopes": _normalize_device_auth_scopes(scopes),
        "updatedAtMs": _now_ms(),
    }
    _write_json(
        path,
        {
            "version": 1,
            "deviceId": device_id,
            "tokens": existing_tokens,
        },
    )


def _derive_device_id_from_public_pem(public_key_pem: str) -> str:
    public_key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return hashlib.sha256(raw).hexdigest()


def _public_key_raw_base64url_from_pem(public_key_pem: str) -> str:
    public_key = serialization.load_pem_public_key(public_key_pem.encode("utf-8"))
    raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return _base64url_encode(raw)


def _sign_device_payload(private_key_pem: str, payload: str) -> str:
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode("utf-8"),
        password=None,
    )
    if not isinstance(private_key, Ed25519PrivateKey):
        raise ValueError("Expected an Ed25519 private key.")
    signature = private_key.sign(payload.encode("utf-8"))
    return _base64url_encode(signature)


def _build_device_auth_payload_v3(
    *,
    device_id: str,
    client_id: str,
    client_mode: str,
    role: str,
    scopes: list[str],
    signed_at_ms: int,
    token: str | None,
    nonce: str,
    platform: str | None,
    device_family: str | None,
) -> str:
    return "|".join(
        [
            "v3",
            device_id,
            client_id,
            client_mode,
            role,
            ",".join(scopes),
            str(signed_at_ms),
            token or "",
            nonce,
            _normalize_device_metadata_for_auth(platform),
            _normalize_device_metadata_for_auth(device_family),
        ]
    )


def _normalize_device_metadata_for_auth(value: str | None) -> str:
    if value is None:
        return ""
    trimmed = value.strip()
    return trimmed.lower() if trimmed else ""


def _normalize_device_auth_scopes(scopes: list[str]) -> list[str]:
    out = {scope.strip() for scope in scopes if scope.strip()}
    if "operator.admin" in out:
        out.update({"operator.read", "operator.write"})
    elif "operator.write" in out:
        out.add("operator.read")
    return sorted(out)


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")
    with contextlib.suppress(OSError):
        path.chmod(0o600)


def _read_json(path: Path) -> object | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _coerce_int(value: object, default: int) -> int:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        with contextlib.suppress(ValueError):
            return int(value)
    return default


def _coerce_str_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, str):
            trimmed = item.strip()
            if trimmed:
                result.append(trimmed)
    return result


def _trim_to_none(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def _now_ms() -> int:
    return time.time_ns() // 1_000_000


__all__ = [
    "OpenClawChatResult",
    "OpenClawEndpointAdapter",
    "OpenClawGatewayClient",
    "OpenClawGatewayError",
    "OpenClawGatewayRequestError",
    "OpenClawGatewayTimeout",
    "OpenClawHistory",
    "OpenClawSession",
    "build_adapter",
    "configure",
    "load_configured_endpoint",
    "openclaw_chat",
    "openclaw_history",
]
