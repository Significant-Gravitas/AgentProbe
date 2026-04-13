export interface ScenarioState {
  scenario_id: string;
  scenario_name: string | null;
  status: "pending" | "running" | "pass" | "fail" | "error";
  score: number | null;
  error: string | null;
  started_at: number | null;
  finished_at: number | null;
}

export interface Turn {
  turn_index: number;
  role: string;
  content: string | null;
  source?: string;
  created_at?: string;
  tool_calls?: ToolCall[];
  checkpoints?: Checkpoint[];
}

export interface ToolCall {
  name: string;
  args?: unknown;
  call_order?: number;
  raw?: unknown;
}

export interface Checkpoint {
  checkpoint_index: number;
  passed: boolean;
  failures?: string[];
  assertions?: unknown;
}

export interface DimensionScore {
  dimension_id: string;
  dimension_name: string;
  raw_score: number | null;
  scale_points: number | null;
  normalized_score: number | null;
  weight: number | null;
  reasoning: string;
  evidence?: string[];
}

export interface ScenarioDetail {
  scenario_id: string;
  scenario_name: string;
  user_id?: string;
  passed: boolean;
  overall_score: number | null;
  pass_threshold: number | null;
  status: string;
  judge?: {
    provider?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    overall_notes?: string;
    output?: Record<string, unknown>;
  };
  turns?: Turn[];
  tool_calls?: ToolCall[];
  checkpoints?: Checkpoint[];
  judge_dimension_scores?: DimensionScore[];
  expectations?: unknown;
  error?: unknown;
  counts?: {
    turn_count: number;
    assistant_turn_count: number;
    tool_call_count: number;
    checkpoint_count: number;
  };
}

export interface DimensionAverage {
  dimension_id: string;
  dimension_name: string;
  avg: number;
  min: number;
  max: number;
  n: number;
}

export interface AverageScore {
  base_id: string;
  scenario_name: string | null;
  avg: number;
  min: number;
  max: number;
  spread: number;
  n: number;
  pass_count: number;
  fail_count: number;
  dimensions: DimensionAverage[];
  failure_modes: Record<string, number>;
  judge_notes: string[];
  ordinals: number[];
}

export interface DashboardData {
  total: number;
  elapsed: number;
  passed: number;
  failed: number;
  errored: number;
  running: number;
  done: number;
  all_done: boolean;
  scenarios: ScenarioState[];
  details: Record<number, ScenarioDetail>;
  averages: AverageScore[];
}
