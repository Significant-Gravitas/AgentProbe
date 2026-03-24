from __future__ import annotations

import base64
import hashlib
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    func,
    select,
)
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship

from .adapters import AdapterReply
from .data.endpoints import Endpoints
from .data.personas import Persona
from .data.rubrics import Rubric
from .data.scenarios import CheckpointAssertion, Scenario
from .errors import AgentProbeRuntimeError
from .judge import RubricScore
from .runner import CheckpointResult, RunResult, ScenarioRunResult
from .simulator import ConversationTurn

DEFAULT_DB_DIRNAME = ".agentprobe"
DEFAULT_DB_FILENAME = "runs.sqlite3"
SCHEMA_VERSION = 1
REDACTED_VALUE = "[REDACTED]"
_SENSITIVE_EXACT_KEYS = {
    "access_token",
    "api_key",
    "api-key",
    "authorization",
    "client_secret",
    "cookie",
    "header_value",
    "id_token",
    "password",
    "refresh_token",
    "secret",
    "session_token",
    "set-cookie",
    "token",
    "x-api-key",
}
_SENSITIVE_SUFFIXES = (
    "_token",
    "_secret",
    "_password",
    "_cookie",
    "_apikey",
    "_api_key",
)
_AUTH_CONTEXT_KEYS = {"auth", "authorization"}


class Base(DeclarativeBase):
    pass


class MetaRow(Base):
    __tablename__ = "meta"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    schema_version: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )


class RunRow(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    transport: Mapped[str | None] = mapped_column(String(32), nullable=True)
    preset: Mapped[str | None] = mapped_column(String(255), nullable=True)
    filters_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    selected_scenario_ids_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    suite_fingerprint: Mapped[str | None] = mapped_column(
        String(64), nullable=True, index=True
    )
    source_paths_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    endpoint_config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    scenarios_config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    personas_config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    rubric_config_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    endpoint_snapshot_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    scenario_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    scenario_passed_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    scenario_failed_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    scenario_errored_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    final_error_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    scenario_runs: Mapped[list["ScenarioRunRow"]] = relationship(
        back_populates="run",
        cascade="all, delete-orphan",
        order_by="ScenarioRunRow.ordinal",
    )


class ScenarioRunRow(Base):
    __tablename__ = "scenario_runs"
    __table_args__ = (
        UniqueConstraint("run_id", "ordinal", name="uq_scenario_runs_run_ordinal"),
        Index("ix_scenario_runs_run_id_ordinal", "run_id", "ordinal"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), nullable=False
    )
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    scenario_id: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    scenario_name: Mapped[str] = mapped_column(String(255), nullable=False)
    persona_id: Mapped[str] = mapped_column(String(255), nullable=False)
    rubric_id: Mapped[str] = mapped_column(String(255), nullable=False)
    tags_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    priority: Mapped[str | None] = mapped_column(String(32), nullable=True)
    expectations_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    scenario_snapshot_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    persona_snapshot_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    rubric_snapshot_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    passed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    overall_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    pass_threshold: Mapped[float | None] = mapped_column(Float, nullable=True)
    judge_provider: Mapped[str | None] = mapped_column(String(64), nullable=True)
    judge_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    judge_temperature: Mapped[float | None] = mapped_column(Float, nullable=True)
    judge_max_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    overall_notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    judge_output_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    turn_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    assistant_turn_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0
    )
    tool_call_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    checkpoint_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    run: Mapped[RunRow] = relationship(back_populates="scenario_runs")
    turns: Mapped[list["TurnRow"]] = relationship(
        back_populates="scenario_run",
        cascade="all, delete-orphan",
        order_by="TurnRow.turn_index",
    )
    target_events: Mapped[list["TargetEventRow"]] = relationship(
        back_populates="scenario_run",
        cascade="all, delete-orphan",
        order_by="TargetEventRow.exchange_index",
    )
    tool_calls: Mapped[list["ToolCallRow"]] = relationship(
        back_populates="scenario_run",
        cascade="all, delete-orphan",
        order_by="ToolCallRow.call_order",
    )
    checkpoints: Mapped[list["CheckpointRow"]] = relationship(
        back_populates="scenario_run",
        cascade="all, delete-orphan",
        order_by="CheckpointRow.checkpoint_index",
    )
    judge_dimension_scores: Mapped[list["JudgeDimensionScoreRow"]] = relationship(
        back_populates="scenario_run",
        cascade="all, delete-orphan",
        order_by="JudgeDimensionScoreRow.dimension_id",
    )


class TurnRow(Base):
    __tablename__ = "turns"
    __table_args__ = (
        UniqueConstraint(
            "scenario_run_id", "turn_index", name="uq_turns_scenario_turn"
        ),
        Index("ix_turns_scenario_run_turn_index", "scenario_run_id", "turn_index"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_run_id: Mapped[int] = mapped_column(
        ForeignKey("scenario_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    role: Mapped[str] = mapped_column(String(32), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    generator_model: Mapped[str | None] = mapped_column(String(255), nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    usage_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    scenario_run: Mapped[ScenarioRunRow] = relationship(back_populates="turns")


class TargetEventRow(Base):
    __tablename__ = "target_events"
    __table_args__ = (
        UniqueConstraint(
            "scenario_run_id",
            "turn_index",
            "exchange_index",
            name="uq_target_events_scenario_turn_exchange",
        ),
        Index(
            "ix_target_events_scenario_run_turn_index_exchange_index",
            "scenario_run_id",
            "turn_index",
            "exchange_index",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_run_id: Mapped[int] = mapped_column(
        ForeignKey("scenario_runs.id", ondelete="CASCADE"),
        nullable=False,
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    exchange_index: Mapped[int] = mapped_column(Integer, nullable=False)
    raw_exchange_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    usage_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    scenario_run: Mapped[ScenarioRunRow] = relationship(back_populates="target_events")


class ToolCallRow(Base):
    __tablename__ = "tool_calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_run_id: Mapped[int] = mapped_column(
        ForeignKey("scenario_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    turn_index: Mapped[int] = mapped_column(Integer, nullable=False)
    call_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    args_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    raw_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    scenario_run: Mapped[ScenarioRunRow] = relationship(back_populates="tool_calls")


class CheckpointRow(Base):
    __tablename__ = "checkpoints"
    __table_args__ = (
        UniqueConstraint(
            "scenario_run_id",
            "checkpoint_index",
            name="uq_checkpoints_scenario_checkpoint",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_run_id: Mapped[int] = mapped_column(
        ForeignKey("scenario_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    checkpoint_index: Mapped[int] = mapped_column(Integer, nullable=False)
    preceding_turn_index: Mapped[int | None] = mapped_column(Integer, nullable=True)
    passed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    failures_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    assertions_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    scenario_run: Mapped[ScenarioRunRow] = relationship(back_populates="checkpoints")


class JudgeDimensionScoreRow(Base):
    __tablename__ = "judge_dimension_scores"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    scenario_run_id: Mapped[int] = mapped_column(
        ForeignKey("scenario_runs.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    dimension_id: Mapped[str] = mapped_column(String(255), nullable=False)
    dimension_name: Mapped[str] = mapped_column(String(255), nullable=False)
    weight: Mapped[float] = mapped_column(Float, nullable=False)
    scale_type: Mapped[str] = mapped_column(String(64), nullable=False)
    scale_points: Mapped[int | None] = mapped_column(Integer, nullable=True)
    raw_score: Mapped[float] = mapped_column(Float, nullable=False)
    normalized_score: Mapped[float] = mapped_column(Float, nullable=False)
    reasoning: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_json: Mapped[Any | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )

    scenario_run: Mapped[ScenarioRunRow] = relationship(
        back_populates="judge_dimension_scores"
    )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _default_db_path() -> Path:
    return Path.cwd() / DEFAULT_DB_DIRNAME / DEFAULT_DB_FILENAME


def _resolve_db_url(db_url: str | None = None) -> str:
    if not db_url:
        path = _default_db_path().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{path}"

    url = make_url(db_url)
    if url.get_backend_name() != "sqlite":
        raise AgentProbeRuntimeError(
            "Only SQLite databases are supported for run history."
        )

    database = url.database
    if database is None:
        raise AgentProbeRuntimeError("SQLite database URL is missing a database path.")
    if database != ":memory:":
        resolved_path = Path(database).expanduser()
        if not resolved_path.is_absolute():
            resolved_path = (Path.cwd() / resolved_path).resolve()
        resolved_path.parent.mkdir(parents=True, exist_ok=True)
        url = url.set(database=str(resolved_path))
    return url.render_as_string(hide_password=False)


def _build_engine(db_url: str) -> Engine:
    connect_args: dict[str, object] = {}
    if make_url(db_url).get_backend_name() == "sqlite":
        connect_args["check_same_thread"] = False

    engine = create_engine(db_url, future=True, connect_args=connect_args)

    @event.listens_for(engine, "connect")
    def _configure_sqlite(dbapi_connection: Any, _connection_record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
        except Exception:
            pass
        cursor.close()

    return engine


_ENGINE_CACHE: dict[str, Engine] = {}


def _get_engine(db_url: str) -> Engine:
    engine = _ENGINE_CACHE.get(db_url)
    if engine is None:
        engine = _build_engine(db_url)
        _ENGINE_CACHE[db_url] = engine
    return engine


def _normalize_value(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return _normalize_value(value.model_dump(mode="json", by_alias=True))
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return {"base64": base64.b64encode(value).decode("ascii")}
    if isinstance(value, dict):
        return {str(key): _normalize_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_normalize_value(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def _is_sensitive_key(key: str, path: tuple[str, ...]) -> bool:
    normalized = key.strip().lower().replace("-", "_")
    if normalized in _SENSITIVE_EXACT_KEYS:
        return True
    if normalized.endswith(_SENSITIVE_SUFFIXES):
        return True
    if normalized in {"stdout", "stderr", "output"} and any(
        segment in _AUTH_CONTEXT_KEYS for segment in path
    ):
        return True
    return False


def _redact_value(value: Any, path: tuple[str, ...] = ()) -> Any:
    normalized = _normalize_value(value)
    if isinstance(normalized, dict):
        redacted: dict[str, Any] = {}
        for key, item in normalized.items():
            key_str = str(key)
            if _is_sensitive_key(key_str, path):
                redacted[key_str] = REDACTED_VALUE
                continue
            redacted[key_str] = _redact_value(
                item, (*path, key_str.strip().lower().replace("-", "_"))
            )
        return redacted
    if isinstance(normalized, list):
        return [_redact_value(item, path) for item in normalized]
    return normalized


def _stable_json_dumps(value: Any) -> str:
    return json.dumps(
        _normalize_value(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )


def _hash_value(value: Any) -> str:
    return hashlib.sha256(_stable_json_dumps(value).encode("utf-8")).hexdigest()


def _error_payload(exc: Exception) -> dict[str, str]:
    return {
        "type": exc.__class__.__name__,
        "message": str(exc),
    }


def _filters_payload(
    *,
    scenario_filter: str | None,
    tags: str | None,
) -> dict[str, Any]:
    return {
        "scenario_id": scenario_filter,
        "tags": [tag.strip() for tag in tags.split(",") if tag.strip()] if tags else [],
    }


def _source_paths_payload(
    *,
    endpoint: str | Path,
    scenarios: str | Path,
    personas: str | Path,
    rubric: str | Path,
) -> dict[str, str]:
    return {
        "endpoint": str(Path(endpoint).expanduser().resolve()),
        "scenarios": str(Path(scenarios).expanduser().resolve()),
        "personas": str(Path(personas).expanduser().resolve()),
        "rubric": str(Path(rubric).expanduser().resolve()),
    }


def _serialize_datetime(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat()


def _normalized_dimension_score(
    rubric: Rubric, dimension_id: str, raw_score: float
) -> float:
    dimension = next(item for item in rubric.dimensions if item.id == dimension_id)
    scale_points = dimension.scale.points or 1
    return float(raw_score) / float(scale_points)


def _run_status_for_exit_code(exit_code: int) -> str:
    if exit_code == 2:
        return "config_error"
    if exit_code == 3:
        return "runtime_error"
    return "error"


def init_db(db_url: str | None = None) -> None:
    resolved_db_url = _resolve_db_url(db_url)
    engine = _get_engine(resolved_db_url)
    Base.metadata.create_all(engine)

    with Session(engine) as session:
        meta = session.get(MetaRow, 1)
        if meta is None:
            session.add(
                MetaRow(
                    id=1,
                    schema_version=SCHEMA_VERSION,
                    created_at=_utc_now(),
                )
            )
            session.commit()
            return
        if meta.schema_version != SCHEMA_VERSION:
            raise AgentProbeRuntimeError(
                f"Unsupported run-history schema version {meta.schema_version}; "
                f"expected {SCHEMA_VERSION}."
            )


class SqliteRunRecorder:
    def __init__(self, db_url: str | None = None) -> None:
        self.db_url = _resolve_db_url(db_url)
        init_db(self.db_url)
        self._engine = _get_engine(self.db_url)
        self.run_id: str | None = None

    def _require_run_id(self) -> str:
        if self.run_id is None:
            raise AgentProbeRuntimeError("Run recorder has not been started.")
        return self.run_id

    def _get_run_row(self, session: Session) -> RunRow:
        run_row = session.get(RunRow, self._require_run_id())
        if run_row is None:
            raise AgentProbeRuntimeError(
                "Run row was not found in the history database."
            )
        return run_row

    def _get_scenario_row(
        self, session: Session, scenario_run_id: int
    ) -> ScenarioRunRow:
        scenario_row = session.get(ScenarioRunRow, scenario_run_id)
        if scenario_row is None:
            raise AgentProbeRuntimeError(
                f"Scenario run {scenario_run_id} was not found in the history database."
            )
        return scenario_row

    def _refresh_run_counts(self, session: Session, run_row: RunRow) -> None:
        scenario_rows = session.execute(
            select(ScenarioRunRow.status, ScenarioRunRow.passed).where(
                ScenarioRunRow.run_id == run_row.id
            )
        ).all()

        run_row.scenario_total = len(scenario_rows)
        run_row.scenario_passed_count = sum(
            1
            for status, passed in scenario_rows
            if status == "completed" and passed is True
        )
        run_row.scenario_failed_count = sum(
            1
            for status, passed in scenario_rows
            if status == "completed" and passed is False
        )
        run_row.scenario_errored_count = sum(
            1
            for status, _passed in scenario_rows
            if status in {"runtime_error", "error"}
        )
        run_row.updated_at = _utc_now()

    def _next_scenario_ordinal(self, session: Session) -> int:
        current_max = session.scalar(
            select(func.max(ScenarioRunRow.ordinal)).where(
                ScenarioRunRow.run_id == self._require_run_id()
            )
        )
        return int(current_max or -1) + 1

    def _next_exchange_index(
        self, session: Session, scenario_run_id: int, turn_index: int
    ) -> int:
        current_max = session.scalar(
            select(func.max(TargetEventRow.exchange_index)).where(
                TargetEventRow.scenario_run_id == scenario_run_id,
                TargetEventRow.turn_index == turn_index,
            )
        )
        return int(current_max or -1) + 1

    def record_run_started(
        self,
        *,
        endpoint: str | Path,
        scenarios: str | Path,
        personas: str | Path,
        rubric: str | Path,
        scenario_filter: str | None,
        tags: str | None,
    ) -> str:
        run_id = uuid.uuid4().hex
        now = _utc_now()

        with Session(self._engine) as session:
            session.add(
                RunRow(
                    id=run_id,
                    status="running",
                    passed=None,
                    exit_code=None,
                    filters_json=_filters_payload(
                        scenario_filter=scenario_filter,
                        tags=tags,
                    ),
                    selected_scenario_ids_json=[],
                    source_paths_json=_source_paths_payload(
                        endpoint=endpoint,
                        scenarios=scenarios,
                        personas=personas,
                        rubric=rubric,
                    ),
                    scenario_total=0,
                    scenario_passed_count=0,
                    scenario_failed_count=0,
                    scenario_errored_count=0,
                    started_at=now,
                    updated_at=now,
                )
            )
            session.commit()

        self.run_id = run_id
        return run_id

    def record_run_configuration(
        self,
        *,
        endpoint_config: Endpoints,
        scenario_collection: Any,
        persona_collection: Any,
        rubric_collection: Any,
        selected_scenarios: list[Scenario],
        scenario_filter: str | None,
        tags: str | None,
    ) -> None:
        redacted_endpoint_snapshot = _redact_value(endpoint_config)
        endpoint_hash = _hash_value(redacted_endpoint_snapshot)
        scenarios_hash = _hash_value(_normalize_value(scenario_collection))
        personas_hash = _hash_value(_normalize_value(persona_collection))
        rubric_hash = _hash_value(_normalize_value(rubric_collection))
        selected_scenario_ids = [item.id for item in selected_scenarios]
        suite_fingerprint = _hash_value(
            {
                "endpoint_config_hash": endpoint_hash,
                "scenarios_config_hash": scenarios_hash,
                "personas_config_hash": personas_hash,
                "rubric_config_hash": rubric_hash,
                "filters": _filters_payload(
                    scenario_filter=scenario_filter,
                    tags=tags,
                ),
                "selected_scenario_ids": selected_scenario_ids,
            }
        )

        with Session(self._engine) as session:
            run_row = self._get_run_row(session)
            run_row.transport = endpoint_config.transport
            run_row.preset = endpoint_config.preset
            run_row.selected_scenario_ids_json = selected_scenario_ids
            run_row.suite_fingerprint = suite_fingerprint
            run_row.endpoint_config_hash = endpoint_hash
            run_row.scenarios_config_hash = scenarios_hash
            run_row.personas_config_hash = personas_hash
            run_row.rubric_config_hash = rubric_hash
            run_row.endpoint_snapshot_json = redacted_endpoint_snapshot
            run_row.scenario_total = len(selected_scenarios)
            run_row.updated_at = _utc_now()
            session.commit()

    def record_run_finished(self, result: RunResult) -> None:
        with Session(self._engine) as session:
            run_row = self._get_run_row(session)
            self._refresh_run_counts(session, run_row)
            run_row.status = "completed"
            run_row.passed = result.passed
            run_row.exit_code = result.exit_code
            run_row.completed_at = _utc_now()
            run_row.updated_at = _utc_now()
            session.commit()

    def record_run_error(self, exc: Exception, *, exit_code: int) -> None:
        with Session(self._engine) as session:
            run_row = self._get_run_row(session)
            self._refresh_run_counts(session, run_row)
            run_row.status = _run_status_for_exit_code(exit_code)
            run_row.passed = False
            run_row.exit_code = exit_code
            run_row.final_error_json = _error_payload(exc)
            run_row.completed_at = _utc_now()
            run_row.updated_at = _utc_now()
            session.commit()

    def record_scenario_started(
        self,
        *,
        scenario: Scenario,
        persona: Persona,
        rubric: Rubric,
        ordinal: int | None,
    ) -> int:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_ordinal = (
                ordinal if ordinal is not None else self._next_scenario_ordinal(session)
            )
            scenario_row = ScenarioRunRow(
                run_id=self._require_run_id(),
                ordinal=scenario_ordinal,
                scenario_id=scenario.id,
                scenario_name=scenario.name,
                persona_id=persona.id,
                rubric_id=rubric.id,
                tags_json=_redact_value(scenario.tags),
                priority=scenario.priority,
                expectations_json=_redact_value(scenario.expectations),
                scenario_snapshot_json=_redact_value(scenario),
                persona_snapshot_json=_redact_value(persona),
                rubric_snapshot_json=_redact_value(rubric),
                status="running",
                pass_threshold=rubric.pass_threshold,
                judge_provider=rubric.judge.provider
                if rubric.judge is not None
                else None,
                judge_model=rubric.judge.model if rubric.judge is not None else None,
                judge_temperature=rubric.judge.temperature
                if rubric.judge is not None
                else None,
                judge_max_tokens=rubric.judge.max_tokens
                if rubric.judge is not None
                else None,
                turn_count=0,
                assistant_turn_count=0,
                tool_call_count=0,
                checkpoint_count=0,
                started_at=now,
                updated_at=now,
            )
            session.add(scenario_row)
            run_row = self._get_run_row(session)
            run_row.updated_at = now
            session.flush()
            scenario_run_id = scenario_row.id
            self._refresh_run_counts(session, run_row)
            session.commit()
            return scenario_run_id

    def record_turn(
        self,
        scenario_run_id: int,
        *,
        turn_index: int,
        turn: ConversationTurn,
        source: str,
        generator_model: str | None = None,
    ) -> None:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_row = self._get_scenario_row(session, scenario_run_id)
            session.add(
                TurnRow(
                    scenario_run_id=scenario_run_id,
                    turn_index=turn_index,
                    role=turn.role,
                    source=source,
                    content=turn.content,
                    generator_model=generator_model,
                    created_at=now,
                )
            )
            scenario_row.turn_count += 1
            if source == "assistant":
                scenario_row.assistant_turn_count += 1
            scenario_row.updated_at = now
            scenario_row.run.updated_at = now
            session.commit()

    def record_assistant_reply(
        self,
        scenario_run_id: int,
        *,
        turn_index: int,
        reply: AdapterReply,
    ) -> None:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_row = self._get_scenario_row(session, scenario_run_id)
            turn_row = session.scalar(
                select(TurnRow).where(
                    TurnRow.scenario_run_id == scenario_run_id,
                    TurnRow.turn_index == turn_index,
                )
            )
            if turn_row is None:
                raise AgentProbeRuntimeError(
                    f"Assistant turn {turn_index} was not recorded before the reply details."
                )

            turn_row.latency_ms = reply.latency_ms
            turn_row.usage_json = _redact_value(reply.usage)

            session.add(
                TargetEventRow(
                    scenario_run_id=scenario_run_id,
                    turn_index=turn_index,
                    exchange_index=self._next_exchange_index(
                        session, scenario_run_id, turn_index
                    ),
                    raw_exchange_json=_redact_value(reply.raw_exchange),
                    latency_ms=reply.latency_ms,
                    usage_json=_redact_value(reply.usage),
                    created_at=now,
                )
            )
            for call in reply.tool_calls:
                session.add(
                    ToolCallRow(
                        scenario_run_id=scenario_run_id,
                        turn_index=turn_index,
                        call_order=call.order,
                        name=call.name,
                        args_json=_redact_value(call.args),
                        raw_json=_redact_value(call.raw),
                        created_at=now,
                    )
                )

            scenario_row.tool_call_count += len(reply.tool_calls)
            scenario_row.updated_at = now
            scenario_row.run.updated_at = now
            session.commit()

    def record_checkpoint(
        self,
        scenario_run_id: int,
        *,
        checkpoint_index: int,
        preceding_turn_index: int | None,
        assertions: list[CheckpointAssertion],
        result: CheckpointResult,
    ) -> None:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_row = self._get_scenario_row(session, scenario_run_id)
            session.add(
                CheckpointRow(
                    scenario_run_id=scenario_run_id,
                    checkpoint_index=checkpoint_index,
                    preceding_turn_index=preceding_turn_index,
                    passed=result.passed,
                    failures_json=_redact_value(result.failures),
                    assertions_json=_redact_value(assertions),
                    created_at=now,
                )
            )
            scenario_row.checkpoint_count += 1
            scenario_row.updated_at = now
            scenario_row.run.updated_at = now
            session.commit()

    def record_judge_result(
        self,
        scenario_run_id: int,
        *,
        rubric: Rubric,
        score: RubricScore,
        overall_score: float,
    ) -> None:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_row = self._get_scenario_row(session, scenario_run_id)
            for existing in list(scenario_row.judge_dimension_scores):
                session.delete(existing)

            scenario_row.pass_threshold = rubric.pass_threshold
            scenario_row.overall_score = overall_score
            scenario_row.overall_notes = score.overall_notes
            scenario_row.judge_output_json = _redact_value(
                score.model_dump(mode="json", by_alias=True)
            )
            scenario_row.updated_at = now
            scenario_row.run.updated_at = now

            for dimension in rubric.dimensions:
                dimension_score = score.dimensions[dimension.id]
                session.add(
                    JudgeDimensionScoreRow(
                        scenario_run_id=scenario_run_id,
                        dimension_id=dimension.id,
                        dimension_name=dimension.name,
                        weight=dimension.weight,
                        scale_type=dimension.scale.type,
                        scale_points=dimension.scale.points,
                        raw_score=float(dimension_score.score),
                        normalized_score=_normalized_dimension_score(
                            rubric,
                            dimension.id,
                            float(dimension_score.score),
                        ),
                        reasoning=dimension_score.reasoning,
                        evidence_json=_redact_value(dimension_score.evidence),
                        created_at=now,
                    )
                )

            session.commit()

    def record_scenario_finished(
        self,
        scenario_run_id: int,
        *,
        result: ScenarioRunResult,
    ) -> None:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_row = self._get_scenario_row(session, scenario_run_id)
            scenario_row.status = "completed"
            scenario_row.passed = result.passed
            scenario_row.overall_score = result.overall_score
            scenario_row.error_json = None
            scenario_row.completed_at = now
            scenario_row.updated_at = now
            run_row = scenario_row.run
            self._refresh_run_counts(session, run_row)
            run_row.updated_at = now
            session.commit()

    def record_scenario_error(
        self,
        scenario_run_id: int,
        exc: Exception,
    ) -> None:
        now = _utc_now()
        with Session(self._engine) as session:
            scenario_row = self._get_scenario_row(session, scenario_run_id)
            scenario_row.status = "runtime_error"
            scenario_row.passed = False
            scenario_row.error_json = _error_payload(exc)
            scenario_row.completed_at = now
            scenario_row.updated_at = now
            run_row = scenario_row.run
            self._refresh_run_counts(session, run_row)
            run_row.updated_at = now
            session.commit()


def _serialize_turn(row: TurnRow) -> dict[str, Any]:
    return {
        "turn_index": row.turn_index,
        "role": row.role,
        "source": row.source,
        "content": row.content,
        "generator_model": row.generator_model,
        "latency_ms": row.latency_ms,
        "usage": row.usage_json,
        "created_at": _serialize_datetime(row.created_at),
    }


def _serialize_target_event(row: TargetEventRow) -> dict[str, Any]:
    return {
        "turn_index": row.turn_index,
        "exchange_index": row.exchange_index,
        "raw_exchange": row.raw_exchange_json,
        "latency_ms": row.latency_ms,
        "usage": row.usage_json,
        "created_at": _serialize_datetime(row.created_at),
    }


def _serialize_tool_call(row: ToolCallRow) -> dict[str, Any]:
    return {
        "turn_index": row.turn_index,
        "call_order": row.call_order,
        "name": row.name,
        "args": row.args_json,
        "raw": row.raw_json,
        "created_at": _serialize_datetime(row.created_at),
    }


def _serialize_checkpoint(row: CheckpointRow) -> dict[str, Any]:
    return {
        "checkpoint_index": row.checkpoint_index,
        "preceding_turn_index": row.preceding_turn_index,
        "passed": row.passed,
        "failures": row.failures_json,
        "assertions": row.assertions_json,
        "created_at": _serialize_datetime(row.created_at),
    }


def _serialize_judge_dimension(row: JudgeDimensionScoreRow) -> dict[str, Any]:
    return {
        "dimension_id": row.dimension_id,
        "dimension_name": row.dimension_name,
        "weight": row.weight,
        "scale_type": row.scale_type,
        "scale_points": row.scale_points,
        "raw_score": row.raw_score,
        "normalized_score": row.normalized_score,
        "reasoning": row.reasoning,
        "evidence": row.evidence_json,
        "created_at": _serialize_datetime(row.created_at),
    }


def _serialize_scenario(row: ScenarioRunRow, *, include_trace: bool) -> dict[str, Any]:
    payload = {
        "scenario_run_id": row.id,
        "ordinal": row.ordinal,
        "scenario_id": row.scenario_id,
        "scenario_name": row.scenario_name,
        "persona_id": row.persona_id,
        "rubric_id": row.rubric_id,
        "tags": row.tags_json,
        "priority": row.priority,
        "expectations": row.expectations_json,
        "scenario_snapshot": row.scenario_snapshot_json,
        "persona_snapshot": row.persona_snapshot_json,
        "rubric_snapshot": row.rubric_snapshot_json,
        "status": row.status,
        "passed": row.passed,
        "overall_score": row.overall_score,
        "pass_threshold": row.pass_threshold,
        "judge": {
            "provider": row.judge_provider,
            "model": row.judge_model,
            "temperature": row.judge_temperature,
            "max_tokens": row.judge_max_tokens,
            "overall_notes": row.overall_notes,
            "output": row.judge_output_json,
        },
        "counts": {
            "turn_count": row.turn_count,
            "assistant_turn_count": row.assistant_turn_count,
            "tool_call_count": row.tool_call_count,
            "checkpoint_count": row.checkpoint_count,
        },
        "error": row.error_json,
        "started_at": _serialize_datetime(row.started_at),
        "updated_at": _serialize_datetime(row.updated_at),
        "completed_at": _serialize_datetime(row.completed_at),
    }
    if include_trace:
        payload["turns"] = [_serialize_turn(item) for item in row.turns]
        payload["target_events"] = [
            _serialize_target_event(item) for item in row.target_events
        ]
        payload["tool_calls"] = [_serialize_tool_call(item) for item in row.tool_calls]
        payload["checkpoints"] = [
            _serialize_checkpoint(item) for item in row.checkpoints
        ]
        payload["judge_dimension_scores"] = [
            _serialize_judge_dimension(item) for item in row.judge_dimension_scores
        ]
    return payload


def _serialize_run(row: RunRow, *, include_trace: bool) -> dict[str, Any]:
    return {
        "run_id": row.id,
        "status": row.status,
        "passed": row.passed,
        "exit_code": row.exit_code,
        "transport": row.transport,
        "preset": row.preset,
        "filters": row.filters_json,
        "selected_scenario_ids": row.selected_scenario_ids_json,
        "suite_fingerprint": row.suite_fingerprint,
        "source_paths": row.source_paths_json,
        "config_hashes": {
            "endpoint": row.endpoint_config_hash,
            "scenarios": row.scenarios_config_hash,
            "personas": row.personas_config_hash,
            "rubric": row.rubric_config_hash,
        },
        "endpoint_snapshot": row.endpoint_snapshot_json,
        "aggregate_counts": {
            "scenario_total": row.scenario_total,
            "scenario_passed_count": row.scenario_passed_count,
            "scenario_failed_count": row.scenario_failed_count,
            "scenario_errored_count": row.scenario_errored_count,
        },
        "final_error": row.final_error_json,
        "started_at": _serialize_datetime(row.started_at),
        "updated_at": _serialize_datetime(row.updated_at),
        "completed_at": _serialize_datetime(row.completed_at),
        "scenarios": [
            _serialize_scenario(item, include_trace=include_trace)
            for item in row.scenario_runs
        ],
    }


def list_runs(
    *,
    db_url: str | None = None,
    limit: int = 50,
    status: str | None = None,
    suite_fingerprint: str | None = None,
) -> list[dict[str, Any]]:
    resolved_db_url = _resolve_db_url(db_url)
    init_db(resolved_db_url)

    with Session(_get_engine(resolved_db_url)) as session:
        stmt = select(RunRow).order_by(RunRow.started_at.desc()).limit(limit)
        if status is not None:
            stmt = stmt.where(RunRow.status == status)
        if suite_fingerprint is not None:
            stmt = stmt.where(RunRow.suite_fingerprint == suite_fingerprint)
        runs = session.scalars(stmt).all()
        return [_serialize_run(item, include_trace=False) for item in runs]


def get_run(
    run_id: str,
    *,
    include_trace: bool = True,
    db_url: str | None = None,
) -> dict[str, Any] | None:
    resolved_db_url = _resolve_db_url(db_url)
    init_db(resolved_db_url)

    with Session(_get_engine(resolved_db_url)) as session:
        run_row = session.get(RunRow, run_id)
        if run_row is None:
            return None
        return _serialize_run(run_row, include_trace=include_trace)


def latest_run_for_suite(
    suite_fingerprint: str,
    *,
    before_started_at: datetime | str | None = None,
    db_url: str | None = None,
) -> dict[str, Any] | None:
    resolved_db_url = _resolve_db_url(db_url)
    init_db(resolved_db_url)

    cutoff: datetime | None = None
    if isinstance(before_started_at, str):
        cutoff = datetime.fromisoformat(before_started_at)
    else:
        cutoff = before_started_at

    with Session(_get_engine(resolved_db_url)) as session:
        stmt = (
            select(RunRow)
            .where(RunRow.suite_fingerprint == suite_fingerprint)
            .order_by(RunRow.started_at.desc())
            .limit(1)
        )
        if cutoff is not None:
            stmt = stmt.where(RunRow.started_at < cutoff)
        run_row = session.scalar(stmt)
        if run_row is None:
            return None
        return _serialize_run(run_row, include_trace=False)


__all__ = [
    "DEFAULT_DB_DIRNAME",
    "DEFAULT_DB_FILENAME",
    "SCHEMA_VERSION",
    "SqliteRunRecorder",
    "get_run",
    "init_db",
    "latest_run_for_suite",
    "list_runs",
]
