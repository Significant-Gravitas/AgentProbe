# E2E Test Checklist

Derived from `platform.md`. Each scenario should have at least one test.

| Scenario                                    | Test file              | Status       |
|---------------------------------------------|------------------------|--------------|
| YAML validation succeeds for well-formed data | `tests/test_cli.py`   | ✅ covered    |
| Single-scenario evaluation run completes    | `tests/test_runner.py` | 🟡 unit only  |
| HTML report renders from recorded run       | `tests/test_report.py` | 🟡 unit only  |
