# playbooks Index

## Purpose

Operational playbooks for recurring tasks, incident response, and
maintenance procedures. Each playbook is a self-contained runbook that an agent
or human can execute without external tribal knowledge.

## File conventions

- Markdown files with sections: Trigger, Steps, Validation,
  Rollback/Escalation.
- Name by operation: `<operation-name>.md` (e.g., `release-cut.md`,
  `incident-triage.md`).
- Keep playbooks actionable — commands should be copy-pasteable.
- Do not add design docs or architecture discussions here.

## Files

- [agent-probe-server.md](agent-probe-server.md) - Local, token-protected, and
  Docker bring-up for the SQLite-backed AgentProbe server.

## Subdirectories

- No tracked subdirectories.

<!-- AUTO-GENERATED FILE LINKS START -->
- [agent-probe-server.md](agent-probe-server.md)
<!-- AUTO-GENERATED FILE LINKS END -->

<!-- AUTO-GENERATED SUBDIR LINKS START -->
- No tracked subdirectories.
<!-- AUTO-GENERATED SUBDIR LINKS END -->
