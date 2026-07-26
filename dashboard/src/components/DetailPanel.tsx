import { useState } from "react";
import { scorePct } from "../helpers.ts";
import type { ScenarioDetail } from "../types.ts";
import { ConversationView } from "./ConversationView.tsx";
import { RubricView } from "./RubricView.tsx";

interface Props {
  detail: ScenarioDetail;
  onClose: () => void;
}

export function DetailPanel({ detail, onClose }: Props) {
  const [tab, setTab] = useState<"conversation" | "rubric">("conversation");

  const isRunning = detail.status === "running";
  const scoreLabel =
    detail.overall_score != null
      ? detail.overall_score.toFixed(2)
      : isRunning
        ? "..."
        : "n/a";
  const thresholdLabel =
    detail.pass_threshold != null ? detail.pass_threshold.toFixed(2) : "n/a";
  const statusLabel = isRunning ? "RUNNING" : detail.passed ? "PASS" : "FAIL";
  const headerClass = isRunning
    ? "detail-running"
    : detail.passed
      ? "detail-pass"
      : "detail-fail";
  const failureMode =
    typeof detail.judge?.output === "object" && detail.judge?.output != null
      ? (detail.judge.output as Record<string, unknown>).failure_mode_detected
      : null;

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop overlay uses presentation role */}
      <div
        className="detail-backdrop open"
        role="presentation"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      />
      <div className="detail-overlay open">
        <div className="detail-panel">
          <div className="detail-top">
            <button type="button" className="detail-close" onClick={onClose}>
              &times;
            </button>
            <div className={`detail-score-header ${headerClass}`}>
              <div className="detail-title-block">
                <div className="detail-name">
                  {detail.scenario_name}
                  {isRunning && (
                    <span
                      className="live-badge"
                      style={{ marginLeft: 12, verticalAlign: "middle" }}
                    >
                      <span className="live-dot" /> LIVE
                    </span>
                  )}
                </div>
                <div className="detail-sid">
                  {detail.scenario_id}
                  {detail.user_id ? ` / ${detail.user_id}` : ""}
                </div>
              </div>
              <div className="detail-score-block">
                <div className="detail-score-group">
                  <div className="detail-score-label">Score</div>
                  <div className="detail-score-value">{scoreLabel}</div>
                </div>
                <div className="detail-score-group">
                  <div className="detail-score-label">Threshold</div>
                  <div className="detail-score-value">{thresholdLabel}</div>
                </div>
                <div className="detail-score-group">
                  <div className="detail-score-label">Status</div>
                  <div className="detail-score-value">{statusLabel}</div>
                </div>
                {typeof failureMode === "string" && failureMode && (
                  <div className="detail-score-group">
                    <div className="detail-score-label">Failure</div>
                    <div className="detail-score-value">{failureMode}</div>
                  </div>
                )}
              </div>
              <div className="detail-bar">
                <div
                  className="detail-bar-fill"
                  style={{ width: `${scorePct(detail.overall_score)}%` }}
                />
              </div>
            </div>
            <div className="detail-tabs">
              <button
                type="button"
                className={`tab-btn${tab === "conversation" ? " tab-active" : ""}`}
                onClick={() => setTab("conversation")}
              >
                Conversation
              </button>
              <button
                type="button"
                className={`tab-btn${tab === "rubric" ? " tab-active" : ""}`}
                onClick={() => setTab("rubric")}
              >
                Rubric
              </button>
            </div>
          </div>
          <div className="detail-body">
            {tab === "conversation" ? (
              <ConversationView detail={detail} />
            ) : (
              <RubricView detail={detail} />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
