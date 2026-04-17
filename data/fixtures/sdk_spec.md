# AgentOps SDK Specification v1.0

This document defines the required interface for the `agentops-sdk` Python package. The SDK is responsible for instrumenting agentic workflows, calculating token costs, and emitting structured telemetry to the centralized tracing service.

## Core Interface

### `AgentOpsClient`

The primary entry point for the SDK. It should be initialized with an API key and an optional environment tag.

```python
class AgentOpsClient:
    def __init__(self, api_key: str, endpoint: str = "https://api.agent-ops.internal"): ...
```

#### `start_run(agent_id: str, run_metadata: dict) -> str`
Initializes a new execution trace.
- **Parameters:**
    - `agent_id`: Unique identifier for the agent template/version.
    - `run_metadata`: Arbitrary key-value pairs (e.g., `user_id`, `session_id`).
- **Returns:** `run_id` (UUID string) to be used in subsequent calls.

#### `record_step(run_id: str, step_type: str, input_data: dict, output_data: dict, status: str) -> None`
Records an individual unit of work within a run (e.g., a tool call, a prompt completion).
- **Parameters:**
    - `run_id`: The ID returned by `start_run`.
    - `step_type`: Enum string (`llm_call`, `tool_use`, `reasoning`).
    - `input_data`: The prompt or tool arguments.
    - `output_data`: The raw response.
    - `status`: `success` or `failure`.

#### `record_cost(run_id: str, model_id: str, prompt_tokens: int, completion_tokens: int) -> None`
Explicitly logs token usage for cost tracking.
- **Parameters:**
    - `model_id`: The LLM identifier (e.g., `gpt-4o`, `claude-3-5-sonnet`).
    - The SDK must map these IDs to internal pricing tables to calculate USD value before transmission.

#### `end_run(run_id: str, final_status: str, result: dict = None) -> None`
Finalizes the trace and triggers the flush of any buffered events.
- **Parameters:**
    - `final_status`: `completed`, `failed`, or `cancelled`.

## Event Schema (Wire Format)

All events emitted to the `/ingest` endpoint must follow this structure:

| Field | Type | Description |
| :--- | :--- | :--- |
| `event_id` | UUID | Unique identifier for the event. |
| `run_id` | UUID | Reference to the parent run. |
| `timestamp` | ISO8601 | UTC timestamp of occurrence. |
| `event_type` | String | `run_start`, `step`, `cost`, `run_end`. |
| `payload` | JSON | Data specific to the event type. |

## Implementation Requirements

1. **Async Execution**: The SDK must not block the main thread of the agent. Use a background worker or async queue for HTTP emissions.
2. **Batching**: Events should be batched (max 10 events or 500ms heartbeat) to minimize overhead.
3. **Idempotency**: Every event must include a client-generated `event_id` to prevent duplicates in the storage layer during retries.
4. **Environment Context**: Automatically capture Python version, SDK version, and hostname in `run_metadata`.
