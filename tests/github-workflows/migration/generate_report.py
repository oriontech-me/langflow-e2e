"""Generate a markdown migration test report from the collected state."""

import json
import os
from datetime import datetime, timezone

STATE_FILE = os.environ.get("STATE_FILE", "/tmp/migration-test-state.json")
REPORT_FILE = os.environ.get("REPORT_FILE", "/tmp/migration-report.md")

STATUS_ICON = {
    "pass": "PASS",
    "fail": "FAIL",
    "warn": "WARN",
    "skip": "SKIP",
}


def load_state() -> dict:
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {"phases": {}}


def load_digest(path: str) -> str:
    try:
        with open(path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return "unknown"


def format_step(name: str, step: dict) -> str:
    icon = STATUS_ICON.get(step.get("status", ""), "?")
    line = f"| {icon} | {name} |"
    detail = step.get("detail", "")
    if not detail:
        # Build detail from other fields
        extras = {k: v for k, v in step.items() if k != "status"}
        if extras:
            detail = ", ".join(f"{k}={v}" for k, v in extras.items() if v is not None)
    line += f" {detail[:120]} |"
    return line


def generate_report(state: dict) -> str:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    latest_digest = load_digest("/tmp/latest-digest.txt")
    nightly_digest = load_digest("/tmp/nightly-digest.txt")

    lines = [
        f"# Langflow Migration Test Report",
        f"**Date:** {now}",
        f"**Flow:** {state.get('flow_name', 'N/A')} (`{state.get('flow_id', 'N/A')}`)",
        f"**Latest digest:** `{latest_digest[-20:]}`",
        f"**Nightly digest:** `{nightly_digest[-20:]}`",
        "",
    ]

    # Overall result
    all_statuses = []
    for phase_data in state.get("phases", {}).values():
        for step in phase_data.get("steps", {}).values():
            all_statuses.append(step.get("status", ""))

    has_fail = "fail" in all_statuses
    has_warn = "warn" in all_statuses
    if has_fail:
        lines.append("## Result: FAILED")
    elif has_warn:
        lines.append("## Result: PASSED (with warnings)")
    else:
        lines.append("## Result: PASSED")
    lines.append("")

    # Phase details — only show failures and warnings in detail
    for phase_name, phase_data in state.get("phases", {}).items():
        duration = phase_data.get("duration_s", "?")
        lines.append(f"### Phase: {phase_name} ({duration}s)")
        lines.append("")
        lines.append("| Status | Step | Detail |")
        lines.append("|--------|------|--------|")

        for step_name, step_data in phase_data.get("steps", {}).items():
            lines.append(format_step(step_name, step_data))

        lines.append("")

    # Failures summary
    failures = []
    warnings = []
    for phase_name, phase_data in state.get("phases", {}).items():
        for step_name, step_data in phase_data.get("steps", {}).items():
            if step_data.get("status") == "fail":
                failures.append(f"- **{phase_name}/{step_name}**: {step_data.get('detail', 'no detail')[:200]}")
            elif step_data.get("status") == "warn":
                warnings.append(f"- **{phase_name}/{step_name}**: {step_data.get('detail', 'no detail')[:200]}")

    if failures:
        lines.append("## Failures")
        lines.extend(failures)
        lines.append("")

    if warnings:
        lines.append("## Warnings")
        lines.extend(warnings)
        lines.append("")

    return "\n".join(lines)


def main():
    state = load_state()
    report = generate_report(state)

    with open(REPORT_FILE, "w") as f:
        f.write(report)

    print(report)


if __name__ == "__main__":
    main()
