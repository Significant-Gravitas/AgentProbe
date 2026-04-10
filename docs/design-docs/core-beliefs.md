# Core Beliefs

## Humans steer, agents execute

Human time and attention are the scarce resources. The repository should be
organized so agents can execute reliably with minimal re-explanation.

## The repo is the system of record

If a rule, design decision, or workflow matters repeatedly, encode it in the
repository. Knowledge that only lives in chat or memory is invisible to future
agent runs.

## Progressive disclosure wins

Short routing docs, stable indexes, and targeted references scale better than a
single giant manual. Agents should be taught where to look next, not forced to
carry everything up front.

## Enforce invariants, not style trivia

Use docs, scripts, and structural checks to enforce architecture, logging,
latency budgets, and boundary validation. Leave local implementation freedom
inside those guardrails.

## Continuous cleanup beats periodic panic

Technical debt compounds quickly in agent-generated systems. Small, recurring
cleanup work is better than large “slop cleanup” projects after drift spreads.
