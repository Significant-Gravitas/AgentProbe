import type { ScenarioDetail, Turn, ToolCall, Checkpoint } from "../types.ts";

interface Props {
  detail: ScenarioDetail;
}

function buildTurnRows(detail: ScenarioDetail): Turn[] {
  const toolsByTurn: Record<number, ToolCall[]> = {};
  for (const tc of detail.tool_calls ?? []) {
    const idx = (tc as unknown as Record<string, number>).turn_index ?? -1;
    (toolsByTurn[idx] ??= []).push(tc);
  }
  const cpByTurn: Record<number, Checkpoint[]> = {};
  for (const cp of detail.checkpoints ?? []) {
    const idx = (cp as unknown as Record<string, number>).preceding_turn_index ?? -1;
    (cpByTurn[idx] ??= []).push(cp);
  }
  return (detail.turns ?? []).map((t) => ({
    ...t,
    tool_calls: toolsByTurn[t.turn_index] ?? [],
    checkpoints: cpByTurn[t.turn_index] ?? [],
  }));
}

const SESSION_BOUNDARY_RE =
  /session_id:\s*(\S+)|reset_policy:\s*(\S+)|time_offset:\s*(\S+)|user_id:\s*(\S+)/g;

function parseSessionBoundary(content: string) {
  const fields: Record<string, string> = {};
  for (const m of content.matchAll(SESSION_BOUNDARY_RE)) {
    if (m[1]) fields.session_id = m[1];
    if (m[2]) fields.reset_policy = m[2];
    if (m[3]) fields.time_offset = m[3];
    if (m[4]) fields.user_id = m[4];
  }
  return fields;
}

function isSessionBoundary(turn: Turn): boolean {
  return (
    turn.role === "system" &&
    typeof turn.content === "string" &&
    turn.content.startsWith("--- Session boundary")
  );
}

function SessionBoundaryTurn({ turn }: { turn: Turn }) {
  const fields = parseSessionBoundary(turn.content ?? "");
  return (
    <div className="turn turn-boundary">
      <div className="turn-header">
        <span className="turn-role role-boundary">Session Boundary</span>
        <span className="turn-meta">Turn {turn.turn_index}</span>
      </div>
      <div className="boundary-pills">
        {Object.entries(fields).map(([k, v]) => (
          <span key={k} className="boundary-pill">
            <span className="pill-label">{k}:</span> {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function ToolCallBlock({ tc }: { tc: ToolCall }) {
  return (
    <div className="tool-call">
      <div className="tool-name">{tc.name}</div>
      {tc.args != null && (
        <pre className="tool-args">
          {JSON.stringify(tc.args, null, 2)}
        </pre>
      )}
    </div>
  );
}

function CheckpointBlock({ cp }: { cp: Checkpoint }) {
  const cls = cp.passed ? "cp-pass" : "cp-fail";
  return (
    <div className={`checkpoint ${cls}`}>
      <div className="cp-header">
        <span>Checkpoint {cp.checkpoint_index}</span>
        <span className="cp-status">{cp.passed ? "PASS" : "FAIL"}</span>
      </div>
      {(cp.failures ?? []).map((f, i) => (
        <div key={i} className="cp-failure">
          {f}
        </div>
      ))}
    </div>
  );
}

function MessageTurn({ turn }: { turn: Turn }) {
  const roleClass: Record<string, string> = {
    user: "role-user",
    assistant: "role-assistant",
  };
  const turnClass: Record<string, string> = {
    user: "turn-user",
    assistant: "turn-assistant",
  };
  const roleLabel: Record<string, string> = {
    user: "User",
    assistant: "Assistant",
    system: "System",
    inject: "Inject",
    checkpoint: "Checkpoint",
  };

  return (
    <div className={`turn ${turnClass[turn.role] ?? "turn-system"}`}>
      <div className="turn-header">
        <span className={`turn-role ${roleClass[turn.role] ?? "role-system"}`}>
          {roleLabel[turn.role] ?? turn.role}
        </span>
        {turn.source && <span className="turn-source">{turn.source}</span>}
        <span className="turn-meta">Turn {turn.turn_index}</span>
      </div>
      {turn.content && <div className="turn-content">{turn.content}</div>}
      {(turn.tool_calls ?? []).length > 0 && (
        <div className="tool-calls">
          <div className="section-label">Tool Calls</div>
          {turn.tool_calls!.map((tc, i) => (
            <ToolCallBlock key={i} tc={tc} />
          ))}
        </div>
      )}
      {(turn.checkpoints ?? []).length > 0 && (
        <div className="checkpoints">
          {turn.checkpoints!.map((cp, i) => (
            <CheckpointBlock key={i} cp={cp} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ConversationView({ detail }: Props) {
  const rows = buildTurnRows(detail);
  return (
    <div>
      {rows.map((turn, i) =>
        isSessionBoundary(turn) ? (
          <SessionBoundaryTurn key={i} turn={turn} />
        ) : (
          <MessageTurn key={i} turn={turn} />
        ),
      )}
    </div>
  );
}
