#!/usr/bin/env python3
"""Run the Go migration's offline gates without a PHP runtime or platform access."""
from __future__ import annotations

import argparse
import collections
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def run(command, *, cwd=ROOT, env=None):
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        # Inputs in this gate are committed synthetic fixtures only.
        raise RuntimeError(f"{' '.join(map(str, command))} failed\n{result.stdout[-20000:]}\n{result.stderr[-8000:]}")
    return result.stdout


def reported_check(command, report):
    """Retain a validator's failed evidence and continue other independent gates."""
    process = subprocess.run(command, cwd=ROOT, text=True, capture_output=True)
    if process.returncode not in (0, 1) or not report.is_file():
        raise RuntimeError(f"Validation did not produce its report\n{process.stdout[-8000:]}\n{process.stderr[-8000:]}")
    return json.loads(report.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", default="go", help="Go executable")
    parser.add_argument("--race", action="store_true")
    parser.add_argument("--check-php-source", action="store_true", help="Also check unchanged PHP source bytes, without executing PHP")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--frontend", action="store_true", help="Check actual Go outputs and the four existing frontend renewal tests (requires frontend npm dependencies)")
    parser.add_argument("--node", default="node", help="Node executable for --frontend")
    args = parser.parse_args()
    verify = [sys.executable, str(ROOT / "scripts/go-migration/verify.py")]
    if args.check_php_source:
        verify += ["--source-root", str(ROOT)]
    provenance = json.loads(run(verify))
    douyin_provenance = json.loads(run(verify + ["--douyin"]))
    integer_provenance = json.loads(run(verify + ["--integers"]))
    with tempfile.TemporaryDirectory(prefix="dokitool-go-check-") as directory:
        temp = Path(directory)
        outputs = temp / "actual-go-responses.json"
        douyin_outputs = temp / "actual-go-douyin.json"
        integer_outputs = temp / "actual-go-integers.json"
        environment = dict(os.environ, DOKITOOL_GO_BASELINE_OUTPUT=str(outputs), DOKITOOL_GO_DOUYIN_OUTPUT=str(douyin_outputs),
                           DOKITOOL_GO_INTEGER_OUTPUT=str(integer_outputs))
        command = [args.go, "test", "-json", "-count=1"]
        if args.race:
            command.append("-race")
        command.append("./...")
        events = [json.loads(line) for line in run(command, cwd=ROOT / "backend", env=environment).splitlines() if line]
        failures = [event for event in events if event.get("Action") == "fail"]
        if failures:
            raise RuntimeError("Go reported a failed test/package")
        run([args.go, "vet", "./..."], cwd=ROOT / "backend")
        actual = json.loads(outputs.read_text())
        labels = [f"shared/{index}" for index in range(len(actual))]
        douyin = json.loads(douyin_outputs.read_text())
        if len(douyin["cases"]) != douyin_provenance["parse_cases"]:
            raise RuntimeError("Actual Go Douyin export inventory mismatch")
        integers = json.loads(integer_outputs.read_text())
        if len(integers["cases"]) != integer_provenance["parse_cases"]:
            raise RuntimeError("Actual Go integer export inventory mismatch")
        douyin["cases"].extend(integers["cases"])
        douyin_outputs.write_text(json.dumps(douyin, ensure_ascii=False) + "\n")
        for case in douyin["cases"]:
            actual.extend([case["normal"], case["debug"]])
            labels.extend([case["id"] + "/normal", case["id"] + "/debug"])
        outputs.write_text(json.dumps(actual, ensure_ascii=False) + "\n")
        schema_report = temp / "independent.json"
        independent = reported_check([sys.executable, str(ROOT / "scripts/validate-unified-schema.py"),
                                      str(outputs), "--output", str(schema_report)], schema_report)
        passed = [event for event in events if event.get("Action") == "pass" and "Test" in event]
        by_package = collections.defaultdict(set)
        for event in passed:
            by_package[event["Package"]].add(event["Test"])
        leaves = sum(sum(not any(other.startswith(name+"/") for other in names) for name in names) for names in by_package.values())
        result = {
            "scope": "Offline frozen PHP inputs through actual Go code; no real platform or browser evidence",
            "passed": independent["total"] == independent["passed"],
            "toolchain": run([args.go, "version"], cwd=ROOT / "backend").strip(),
            "php_baseline": provenance,
            "php_douyin_baseline": douyin_provenance,
            "php_integer_baseline": integer_provenance,
            "go": {"leaf_scenarios": leaves, "passed_test_events": len(passed), "race": args.race, "vet": True},
            "independent_responses": {"total": independent["total"], "passed": independent["passed"],
                                      "failures": [{"id": labels[entry["index"]], "reason": entry["reason"]}
                                                   for entry in independent["checks"] if not entry["passed"]]},
        }
        if args.frontend:
            frontend_report = temp / "frontend.json"
            frontend = reported_check([args.node, str(ROOT / "frontend/scripts/test-go-media-integration.mjs"),
                                       str(douyin_outputs), str(frontend_report)], frontend_report)
            result["frontend_go_integration"] = frontend
            result["passed"] = result["passed"] and frontend["passed"]
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
