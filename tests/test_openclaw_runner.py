from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import threading
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from types import SimpleNamespace

from click.testing import CliRunner
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from websockets.asyncio.server import ServerConnection, serve

from agentprobe.adapters import build_endpoint_adapter
from agentprobe.cli import cli
from agentprobe.data import Endpoints, parse_endpoints_yaml
from agentprobe.endpoints import configure_endpoint
from agentprobe.endpoints.openclaw import (
    OpenClawGatewayClient,
    openclaw_chat,
    openclaw_history,
)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"


class FakeOpenClawGateway:
    def __init__(self, *, shared_token: str = "shared-token") -> None:
        self.shared_token = shared_token
        self.url: str | None = None
        self.auth_attempts: list[dict[str, Any]] = []
        self.sessions: dict[str, dict[str, Any]] = {}
        self._device_tokens: dict[tuple[str, str], str] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stop_event: asyncio.Event | None = None
        self._thread: threading.Thread | None = None
        self._started = threading.Event()
        self._session_counter = 0
        self._session_id_counter = 0

    def __enter__(self) -> FakeOpenClawGateway:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        assert self._started.wait(timeout=5), "fake gateway did not start"
        assert self.url is not None
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        assert self._loop is not None
        assert self._stop_event is not None
        future = asyncio.run_coroutine_threadsafe(self._stop(), self._loop)
        future.result(timeout=5)
        assert self._thread is not None
        self._thread.join(timeout=5)

    def _run(self) -> None:
        asyncio.run(self._serve())

    async def _serve(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stop_event = asyncio.Event()
        async with serve(self._handle_connection, "127.0.0.1", 0) as server:
            sock = server.sockets[0]
            port = sock.getsockname()[1]
            self.url = f"ws://127.0.0.1:{port}"
            self._started.set()
            await self._stop_event.wait()

    async def _stop(self) -> None:
        assert self._stop_event is not None
        self._stop_event.set()

    async def _handle_connection(self, websocket: ServerConnection) -> None:
        nonce = f"nonce-{id(websocket)}"
        await websocket.send(
            json.dumps(
                {
                    "type": "event",
                    "event": "connect.challenge",
                    "payload": {
                        "nonce": nonce,
                        "ts": 1_737_264_000_000,
                    },
                }
            )
        )

        connected = False
        current_device_id: str | None = None
        current_role = "operator"

        async for raw_message in websocket:
            frame = json.loads(raw_message)
            method = frame.get("method")
            request_id = frame.get("id")
            params = (
                frame.get("params") if isinstance(frame.get("params"), dict) else {}
            )

            if method == "connect":
                ok, response = self._handle_connect(params, nonce)
                await websocket.send(
                    json.dumps(
                        {
                            "type": "res",
                            "id": request_id,
                            "ok": ok,
                            **({"payload": response} if ok else {"error": response}),
                        }
                    )
                )
                if ok:
                    connected = True
                    current_device_id = params["device"]["id"]
                    current_role = params.get("role", "operator")
                continue

            if not connected:
                await websocket.send(
                    json.dumps(
                        {
                            "type": "res",
                            "id": request_id,
                            "ok": False,
                            "error": {
                                "code": "INVALID_REQUEST",
                                "message": "connect required",
                            },
                        }
                    )
                )
                continue

            if method == "health":
                await self._send_ok(websocket, request_id, {"status": "ok"})
                continue

            if method == "sessions.create":
                session_key = params.get("key")
                if not isinstance(session_key, str) or not session_key.strip():
                    self._session_counter += 1
                    session_key = f"session-{self._session_counter}"

                if session_key not in self.sessions:
                    self._session_id_counter += 1
                    self.sessions[session_key] = {
                        "sessionId": f"sess-{self._session_id_counter}",
                        "messages": [],
                        "label": params.get("label"),
                    }

                session = self.sessions[session_key]
                await self._send_ok(
                    websocket,
                    request_id,
                    {
                        "ok": True,
                        "key": session_key,
                        "sessionId": session["sessionId"],
                        "entry": {
                            "sessionId": session["sessionId"],
                            "label": session.get("label"),
                        },
                    },
                )
                continue

            if method == "chat.send":
                session_key = params.get("sessionKey")
                message = params.get("message")
                run_id = params.get("idempotencyKey")
                if (
                    not isinstance(session_key, str)
                    or session_key not in self.sessions
                    or not isinstance(message, str)
                    or not isinstance(run_id, str)
                ):
                    await self._send_error(
                        websocket,
                        request_id,
                        code="INVALID_REQUEST",
                        message="invalid chat.send params",
                    )
                    continue

                session = self.sessions[session_key]
                session["messages"].append(
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": message}],
                    }
                )
                reply_text = f"Echo: {message}"
                assistant_message = {
                    "role": "assistant",
                    "content": [{"type": "text", "text": reply_text}],
                }
                session["messages"].append(assistant_message)

                await self._send_ok(
                    websocket,
                    request_id,
                    {
                        "runId": run_id,
                        "status": "started",
                    },
                )
                await websocket.send(
                    json.dumps(
                        {
                            "type": "event",
                            "event": "chat",
                            "payload": {
                                "runId": run_id,
                                "sessionKey": session_key,
                                "seq": 0,
                                "state": "final",
                                "message": assistant_message,
                            },
                        }
                    )
                )
                continue

            if method == "chat.history":
                session_key = params.get("sessionKey")
                if not isinstance(session_key, str) or session_key not in self.sessions:
                    await self._send_error(
                        websocket,
                        request_id,
                        code="INVALID_REQUEST",
                        message="session not found",
                    )
                    continue

                session = self.sessions[session_key]
                await self._send_ok(
                    websocket,
                    request_id,
                    {
                        "sessionKey": session_key,
                        "sessionId": session["sessionId"],
                        "messages": list(session["messages"]),
                        "thinkingLevel": "normal",
                        "fastMode": False,
                        "verboseLevel": "normal",
                    },
                )
                continue

            await self._send_error(
                websocket,
                request_id,
                code="INVALID_REQUEST",
                message=f"unknown method {method}",
            )

    def _handle_connect(
        self,
        params: dict[str, Any],
        nonce: str,
    ) -> tuple[bool, dict[str, Any]]:
        raw_auth = params.get("auth")
        auth: dict[str, Any] = raw_auth if isinstance(raw_auth, dict) else {}
        device = (
            params.get("device") if isinstance(params.get("device"), dict) else None
        )
        raw_client = params.get("client")
        client: dict[str, Any] = raw_client if isinstance(raw_client, dict) else {}
        raw_role = params.get("role")
        role = raw_role if isinstance(raw_role, str) else "operator"

        self.auth_attempts.append({"auth": auth, "role": role})

        if device is None:
            return False, {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device identity required",
                "details": {
                    "code": "DEVICE_IDENTITY_REQUIRED",
                },
            }

        device_error = self._validate_device(params, nonce)
        if device_error is not None:
            return False, device_error

        device_id = device.get("id")
        if not isinstance(device_id, str):
            return False, {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device identity missing",
                "details": {
                    "code": "DEVICE_AUTH_DEVICE_ID_MISMATCH",
                },
            }
        expected_device_token = self._device_tokens.get((device_id, role))
        provided_token = (
            auth.get("token") if isinstance(auth.get("token"), str) else None
        )
        provided_device_token = (
            auth.get("deviceToken")
            if isinstance(auth.get("deviceToken"), str)
            else None
        )

        if provided_token == self.shared_token:
            pass
        elif expected_device_token and (
            provided_token == expected_device_token
            or provided_device_token == expected_device_token
        ):
            pass
        else:
            return False, {
                "code": "AUTH_UNAUTHORIZED",
                "message": "token mismatch",
                "details": {
                    "code": "AUTH_TOKEN_MISMATCH",
                    "canRetryWithDeviceToken": expected_device_token is not None,
                    "recommendedNextStep": (
                        "retry_with_device_token"
                        if expected_device_token is not None
                        else "update_auth_credentials"
                    ),
                },
            }

        issued_device_token = f"device-token-{device_id[:12]}-{role}"
        self._device_tokens[(device_id, role)] = issued_device_token

        return True, {
            "type": "hello-ok",
            "protocol": 3,
            "server": {
                "version": "test",
                "connId": f"conn-{device_id[:8]}",
            },
            "features": {
                "methods": [
                    "connect",
                    "health",
                    "sessions.create",
                    "chat.send",
                    "chat.history",
                ],
                "events": ["chat"],
            },
            "snapshot": {},
            "auth": {
                "deviceToken": issued_device_token,
                "role": role,
                "scopes": list(params.get("scopes", [])),
            },
            "policy": {
                "maxPayload": 1_048_576,
                "maxBufferedBytes": 1_048_576,
                "tickIntervalMs": 15_000,
            },
        }

    def _validate_device(
        self, params: dict[str, Any], nonce: str
    ) -> dict[str, Any] | None:
        raw_client = params.get("client")
        client: dict[str, Any] = raw_client if isinstance(raw_client, dict) else {}
        raw_auth = params.get("auth")
        auth: dict[str, Any] = raw_auth if isinstance(raw_auth, dict) else {}
        device = params.get("device")
        if not isinstance(device, dict):
            return {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device identity required",
                "details": {
                    "code": "DEVICE_IDENTITY_REQUIRED",
                },
            }

        if device.get("nonce") != nonce:
            return {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device nonce mismatch",
                "details": {
                    "code": "DEVICE_AUTH_NONCE_MISMATCH",
                },
            }

        public_key = device.get("publicKey")
        signature = device.get("signature")
        signed_at = device.get("signedAt")
        raw_scopes = params.get("scopes")
        scopes = raw_scopes if isinstance(raw_scopes, list) else []
        if (
            not isinstance(public_key, str)
            or not isinstance(signature, str)
            or not isinstance(signed_at, int)
        ):
            return {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device signature invalid",
                "details": {
                    "code": "DEVICE_AUTH_SIGNATURE_INVALID",
                },
            }

        raw_public_key = _base64url_decode(public_key)
        expected_device_id = hashlib.sha256(raw_public_key).hexdigest()
        if device.get("id") != expected_device_id:
            return {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device identity mismatch",
                "details": {
                    "code": "DEVICE_AUTH_DEVICE_ID_MISMATCH",
                },
            }

        signature_token = next(
            (
                value
                for value in [
                    auth.get("token"),
                    auth.get("bootstrapToken"),
                    auth.get("deviceToken"),
                ]
                if isinstance(value, str)
            ),
            "",
        )
        payload = "|".join(
            [
                "v3",
                expected_device_id,
                client.get("id", ""),
                client.get("mode", ""),
                params.get("role", ""),
                ",".join(scope for scope in scopes if isinstance(scope, str)),
                str(signed_at),
                signature_token,
                nonce,
                _normalize_device_metadata(client.get("platform")),
                _normalize_device_metadata(client.get("deviceFamily")),
            ]
        )

        try:
            Ed25519PublicKey.from_public_bytes(raw_public_key).verify(
                _base64url_decode(signature),
                payload.encode("utf-8"),
            )
        except InvalidSignature:
            return {
                "code": "AUTH_UNAUTHORIZED",
                "message": "device signature invalid",
                "details": {
                    "code": "DEVICE_AUTH_SIGNATURE_INVALID",
                },
            }

        return None

    async def _send_ok(
        self,
        websocket: ServerConnection,
        request_id: Any,
        payload: dict[str, Any],
    ) -> None:
        await websocket.send(
            json.dumps(
                {
                    "type": "res",
                    "id": request_id,
                    "ok": True,
                    "payload": payload,
                }
            )
        )

    async def _send_error(
        self,
        websocket: ServerConnection,
        request_id: Any,
        *,
        code: str,
        message: str,
    ) -> None:
        await websocket.send(
            json.dumps(
                {
                    "type": "res",
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": code,
                        "message": message,
                    },
                }
            )
        )


def _base64url_decode(value: str) -> bytes:
    padded = value + "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _normalize_device_metadata(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().lower()


def _gateway_url(gateway: FakeOpenClawGateway) -> str:
    assert gateway.url is not None
    return gateway.url


def _configured_endpoint(monkeypatch: Any, url: str, token: str) -> Endpoints:
    monkeypatch.setenv("OPENCLAW_GATEWAY_URL", url)
    monkeypatch.setenv("OPENCLAW_GATEWAY_TOKEN", token)
    return configure_endpoint(
        parse_endpoints_yaml(DATA_DIR / "openclaw-endpoints.yaml")
    )


def test_openclaw_chat_round_trip_and_history(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTPROBE_STATE_DIR", str(tmp_path / "state"))

    with FakeOpenClawGateway() as gateway:
        endpoint = _configured_endpoint(
            monkeypatch, _gateway_url(gateway), "shared-token"
        )

        result = asyncio.run(openclaw_chat(endpoint, message="hello openclaw"))

        assert result.status == "ok"
        assert result.reply == "Echo: hello openclaw"
        assert result.session_key in gateway.sessions

        history = asyncio.run(
            openclaw_history(endpoint, session_key=result.session_key)
        )

        assert history.session_id == result.session_id
        assert [message["role"] for message in history.messages] == [
            "user",
            "assistant",
        ]
        assert history.messages[-1]["content"][0]["text"] == "Echo: hello openclaw"


def test_openclaw_can_create_isolated_sessions(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTPROBE_STATE_DIR", str(tmp_path / "state"))

    with FakeOpenClawGateway() as gateway:
        endpoint = _configured_endpoint(
            monkeypatch, _gateway_url(gateway), "shared-token"
        )

        async def scenario() -> tuple[Any, Any, Any, Any, Any, Any]:
            async with OpenClawGatewayClient(endpoint) as client:
                session_a = await client.create_session(label="alpha")
                session_b = await client.create_session(label="beta")
                reply_a = await client.send_message(session_a.key, "alpha only")
                reply_b = await client.send_message(session_b.key, "beta only")
                history_a = await client.history(session_a.key)
                history_b = await client.history(session_b.key)
                return session_a, session_b, reply_a, reply_b, history_a, history_b

        session_a, session_b, reply_a, reply_b, history_a, history_b = asyncio.run(
            scenario()
        )

        assert session_a.key != session_b.key
        assert reply_a.reply == "Echo: alpha only"
        assert reply_b.reply == "Echo: beta only"
        assert history_a.messages[-1]["content"][0]["text"] == "Echo: alpha only"
        assert history_b.messages[-1]["content"][0]["text"] == "Echo: beta only"


def test_openclaw_reuses_cached_device_token(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTPROBE_STATE_DIR", str(tmp_path / "state"))

    with FakeOpenClawGateway() as gateway:
        first_endpoint = _configured_endpoint(
            monkeypatch, _gateway_url(gateway), "shared-token"
        )

        async def first_connect() -> dict[str, Any]:
            async with OpenClawGatewayClient(first_endpoint) as client:
                return await client.health()

        first_health = asyncio.run(first_connect())
        assert first_health == {"status": "ok"}

        second_endpoint = _configured_endpoint(monkeypatch, _gateway_url(gateway), "")

        async def second_connect() -> dict[str, Any]:
            async with OpenClawGatewayClient(second_endpoint) as client:
                return await client.health()

        second_health = asyncio.run(second_connect())

        assert second_health == {"status": "ok"}
        assert gateway.auth_attempts[1]["auth"]["token"].startswith("device-token-")


def test_openclaw_works_via_generic_endpoint_adapter(monkeypatch, tmp_path):
    monkeypatch.setenv("AGENTPROBE_STATE_DIR", str(tmp_path / "state"))

    with FakeOpenClawGateway() as gateway:
        endpoint = _configured_endpoint(
            monkeypatch, _gateway_url(gateway), "shared-token"
        )
        adapter = build_endpoint_adapter(endpoint)

        async def scenario() -> tuple[dict[str, object], Any]:
            await adapter.health_check({})
            session_state = await adapter.open_scenario({"label": "adapter-test"})
            reply = await adapter.send_user_turn(
                {
                    **session_state,
                    "last_message": SimpleNamespace(content="through adapter"),
                }
            )
            await adapter.close_scenario(session_state)
            return session_state, reply

        session_state, reply = asyncio.run(scenario())

        assert isinstance(session_state["session_key"], str)
        assert reply.assistant_text == "Echo: through adapter"


def test_openclaw_cli_chat_command(monkeypatch, tmp_path):
    monkeypatch.chdir(PROJECT_ROOT)
    monkeypatch.setenv("AGENTPROBE_STATE_DIR", str(tmp_path / "state"))

    with FakeOpenClawGateway() as gateway:
        monkeypatch.setenv("OPENCLAW_GATEWAY_URL", _gateway_url(gateway))
        monkeypatch.setenv("OPENCLAW_GATEWAY_TOKEN", "shared-token")

        result = CliRunner().invoke(cli, ["openclaw", "chat", "--message", "from cli"])

        assert result.exit_code == 0
        payload = json.loads(result.output)
        assert payload["status"] == "ok"
        assert payload["reply"] == "Echo: from cli"
