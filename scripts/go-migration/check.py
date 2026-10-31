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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--go", default="go", help="Go executable")
    parser.add_argument("--race", action="store_true")
    parser.add_argument("--check-php-source", action="store_true", help="Also check unchanged PHP source bytes, without executing PHP")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    verify = [sys.executable, str(ROOT / "scripts/go-migration/verify.py")]
    if args.check_php_source:
        verify += ["--source-root", str(ROOT)]
    provenance = json.loads(run(verify))
    with tempfile.TemporaryDirectory(prefix="dokitool-go-check-") as directory:
        temp = Path(directory)
        outputs = temp / "actual-go-responses.json"
        environment = dict(os.environ, DOKITOOL_GO_BASELINE_OUTPUT=str(outputs))
        command = [args.go, "test", "-json", "-count=1"]
        if args.race:
            command.append("-race")
        command.append("./...")
        events = [json.loads(line) for line in run(command, cwd=ROOT / "backend", env=environment).splitlines() if line]
        failures = [event for event in events if event.get("Action") == "fail"]
        if failures:
            raise RuntimeError("Go reported a failed test/package")
        run([args.go, "vet", "./..."], cwd=ROOT / "backend")
        schema_report = temp / "independent.json"
        run([sys.executable, str(ROOT / "scripts/validate-unified-schema.py"), str(outputs), "--output", str(schema_report)])
        independent = json.loads(schema_report.read_text())
        passed = [event for event in events if event.get("Action") == "pass" and "Test" in event]
        by_package = collections.defaultdict(set)
        for event in passed:
            by_package[event["Package"]].add(event["Test"])
        leaves = sum(sum(not any(other.startswith(name+"/") for other in names) for name in names) for names in by_package.values())
        result = {
            "scope": "Offline frozen PHP inputs through actual Go code; no real platform or browser evidence",
            "passed": True,
            "toolchain": run([args.go, "version"], cwd=ROOT / "backend").strip(),
            "php_baseline": provenance,
            "go": {"leaf_scenarios": leaves, "passed_test_events": len(passed), "race": args.race, "vet": True},
            "independent_responses": {"total": independent["total"], "passed": independent["passed"]},
        }
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2)+"\n")
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1)
