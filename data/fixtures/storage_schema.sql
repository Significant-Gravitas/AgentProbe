-- AgentOps Tracing Component Schema
-- Database: Postgres

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: agents
-- Metadata for registered agents in the platform
CREATE TABLE agents (
    agent_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(255) NOT NULL,
    version VARCHAR(50) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, version)
);

-- Table: runs
-- Top-level execution trace for a single agent invocation
CREATE TABLE runs (
    run_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_id UUID REFERENCES agents(agent_id) ON DELETE CASCADE,
    external_id VARCHAR(255), -- ID from the calling system
    status VARCHAR(50) CHECK (status IN ('running', 'completed', 'failed')),
    start_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP WITH TIME ZONE,
    metadata JSONB DEFAULT '{}',
    success BOOLEAN DEFAULT FALSE
);

-- Table: steps
-- Individual steps (LLM calls, tool usage, reasoning) within a run
CREATE TABLE steps (
    step_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID REFERENCES runs(run_id) ON DELETE CASCADE,
    step_name VARCHAR(255) NOT NULL,
    step_type VARCHAR(50) NOT NULL, -- e.g., 'llm', 'tool', 'logic'
    input_data JSONB,
    output_data JSONB,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    error_message TEXT
);

-- Table: costs
-- Granular cost tracking for each step (tokens, API credits, etc.)
CREATE TABLE costs (
    cost_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id UUID REFERENCES runs(run_id) ON DELETE CASCADE,
    step_id UUID REFERENCES steps(step_id) ON DELETE CASCADE,
    provider VARCHAR(100), -- e.g., 'openai', 'anthropic', 'internal'
    model_name VARCHAR(100),
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    usd_amount DECIMAL(12, 6) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for Query Performance
CREATE INDEX idx_runs_agent_id ON runs(agent_id);
CREATE INDEX idx_runs_start_time ON runs(start_time);
CREATE INDEX idx_steps_run_id ON steps(run_id);
CREATE INDEX idx_costs_run_id ON costs(run_id);
CREATE INDEX idx_costs_step_id ON costs(step_id);

-- View for Dashboard Aggregates
CREATE OR REPLACE VIEW agent_performance_metrics AS
SELECT 
    a.agent_id,
    a.name as agent_name,
    COUNT(r.run_id) as total_runs,
    SUM(CASE WHEN r.success THEN 1 ELSE 0 END)::FLOAT / COUNT(r.run_id) as success_rate,
    SUM(c.usd_amount) as total_cost,
    AVG(c.usd_amount) as avg_cost_per_run
FROM agents a
JOIN runs r ON a.agent_id = r.agent_id
LEFT JOIN costs c ON r.run_id = c.run_id
GROUP BY a.agent_id, a.name;

-- Seed initial agents
INSERT INTO agents (name, version) VALUES ('research-assistant', 'v1.0.0');
INSERT INTO agents (name, version) VALUES ('code-generator', 'v2.1.0');
INSERT INTO agents (name, version) VALUES ('customer-support-bot', 'v1.4.2');
