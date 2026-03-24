from __future__ import annotations

import datetime as dt
import os
import uuid
from dataclasses import dataclass
from typing import Any

import httpx
import jwt

DEFAULT_BACKEND_URL = os.environ.get(
    "AUTOGPT_BACKEND_URL",
    os.environ.get("BACKEND_URL", "http://localhost:8006"),
)
DEFAULT_SUPABASE_URL = os.environ.get(
    "AUTOGPT_SUPABASE_URL",
    os.environ.get("SUPABASE_URL", "http://localhost:8000"),
)
DEFAULT_SUPABASE_ANON_KEY = os.environ.get(
    "AUTOGPT_SUPABASE_ANON_KEY",
    os.environ.get(
        "SUPABASE_ANON_KEY",
        (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
            "eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIs"
            "CiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0."
            "dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE"
        ),
    ),
)
DEFAULT_JWT_SECRET = os.environ.get(
    "AUTOGPT_JWT_SECRET",
    os.environ.get(
        "JWT_SECRET",
        "your-super-secret-jwt-token-with-at-least-32-characters-long",
    ),
)
DEFAULT_JWT_ALGORITHM = os.environ.get(
    "AUTOGPT_JWT_ALGORITHM",
    os.environ.get("JWT_ALGORITHM", "HS256"),
)


@dataclass(slots=True)
class AutogptAuthResult:
    token: str
    headers: dict[str, str]


def default_email() -> str:
    return f"agentprobe-{uuid.uuid4().hex[:12]}@example.com"


def default_user_id() -> str:
    return f"agentprobe-{uuid.uuid4().hex[:12]}"


def signup_via_supabase(
    client: httpx.Client,
    supabase_url: str,
    anon_key: str,
    email: str,
    password: str,
) -> dict[str, Any]:
    response = client.post(
        f"{supabase_url.rstrip('/')}/auth/v1/signup",
        json={"email": email, "password": password},
        headers={
            "apikey": anon_key,
            "Content-Type": "application/json",
        },
    )
    response.raise_for_status()
    return response.json()


def extract_access_token(session_data: dict[str, Any]) -> str:
    token = session_data.get("access_token")
    if isinstance(token, str) and token:
        return token

    nested_session = session_data.get("session")
    if isinstance(nested_session, dict):
        nested_token = nested_session.get("access_token")
        if isinstance(nested_token, str) and nested_token:
            return nested_token

    raise RuntimeError("Supabase signup succeeded but did not return an access token.")


def forge_jwt(
    user_id: str,
    email: str,
    jwt_secret: str,
    jwt_algorithm: str,
    issuer: str,
    audience: str,
    role: str,
    name: str,
) -> str:
    now = dt.datetime.now(dt.timezone.utc)
    payload = {
        "sub": user_id,
        "email": email,
        "role": role,
        "aud": audience,
        "iss": issuer,
        "iat": int(now.timestamp()),
        "exp": int((now + dt.timedelta(hours=2)).timestamp()),
        "user_metadata": {"name": name},
    }
    return jwt.encode(payload, jwt_secret, algorithm=jwt_algorithm)


def register_user(client: httpx.Client, backend_url: str, token: str) -> None:
    response = client.post(
        f"{backend_url.rstrip('/')}/api/auth/user",
        headers={"Authorization": f"Bearer {token}"},
    )
    response.raise_for_status()


def resolve_auth(
    *,
    mode: str | None = None,
    backend_url: str | None = None,
    supabase_url: str | None = None,
    anon_key: str | None = None,
    jwt_secret: str | None = None,
    jwt_algorithm: str | None = None,
    issuer: str | None = None,
    audience: str | None = None,
    role: str | None = None,
    email: str | None = None,
    password: str | None = None,
    user_id: str | None = None,
    name: str | None = None,
    timeout: float | None = None,
) -> AutogptAuthResult:
    resolved_mode = mode or os.environ.get("AUTOGPT_AUTH_MODE", "forged")
    resolved_backend_url = backend_url or DEFAULT_BACKEND_URL
    resolved_supabase_url = supabase_url or DEFAULT_SUPABASE_URL
    resolved_anon_key = anon_key or DEFAULT_SUPABASE_ANON_KEY
    resolved_jwt_secret = jwt_secret or DEFAULT_JWT_SECRET
    resolved_jwt_algorithm = jwt_algorithm or DEFAULT_JWT_ALGORITHM
    resolved_issuer = issuer or os.environ.get("AUTOGPT_JWT_ISSUER", "supabase-demo")
    resolved_audience = audience or os.environ.get(
        "AUTOGPT_JWT_AUDIENCE", "authenticated"
    )
    resolved_role = role or os.environ.get("AUTOGPT_JWT_ROLE", "user")
    resolved_email = email or os.environ.get("AUTOGPT_EMAIL") or default_email()
    resolved_password = password or os.environ.get(
        "AUTOGPT_PASSWORD", "securepassword123"
    )
    resolved_user_id = user_id or os.environ.get("AUTOGPT_USER_ID") or default_user_id()
    resolved_name = name or os.environ.get("AUTOGPT_USER_NAME", "AgentProbe User")
    resolved_timeout = timeout or float(
        os.environ.get("AUTOGPT_AUTH_TIMEOUT_SECONDS", "60")
    )

    with httpx.Client(follow_redirects=True, timeout=resolved_timeout) as client:
        if resolved_mode == "supabase":
            session_data = signup_via_supabase(
                client=client,
                supabase_url=resolved_supabase_url,
                anon_key=resolved_anon_key,
                email=resolved_email,
                password=resolved_password,
            )
            token = extract_access_token(session_data)
        else:
            token = forge_jwt(
                user_id=resolved_user_id,
                email=resolved_email,
                jwt_secret=resolved_jwt_secret,
                jwt_algorithm=resolved_jwt_algorithm,
                issuer=resolved_issuer,
                audience=resolved_audience,
                role=resolved_role,
                name=resolved_name,
            )

        register_user(client, resolved_backend_url, token)

    return AutogptAuthResult(
        token=token,
        headers={"Authorization": f"Bearer {token}"},
    )


__all__ = [
    "AutogptAuthResult",
    "extract_access_token",
    "forge_jwt",
    "register_user",
    "resolve_auth",
    "signup_via_supabase",
]
